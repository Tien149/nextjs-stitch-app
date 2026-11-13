import { prismaRaw } from "@/lib/prisma";
import { buildAuditLogData } from "@/lib/audit-log";
import { closedPeriodMessage, findClosedPeriod } from "@/lib/phase3";
import { effectiveMoneyTransferDate } from "@/lib/money-transfer-date";
import { WALLET_FEE_SOURCE_TYPE, walletFeeSourcePrefix } from "@/lib/wallet-fee-journal";
import type { DemoSession } from "@/lib/auth-demo";

/**
 * XOÁ DÒNG SAO KÊ TRÙNG KÈM PHIẾU QUYẾT TOÁN VÍ (khách 13/11/2026).
 *
 * File sao kê nạp hai lần mà mã giao dịch bị cắt cụt ở lần sau (UNHO-8D6AM1F7E → UNHO-8D6AM1F)
 * thì chống trùng theo mã không bắt được, và MỖI dòng tự sinh một phiếu QTVI riêng — tiền về ngân
 * hàng và tiền rời ví đều bị ghi hai lần. Dòng còn nối chứng từ thì không xoá được, mà phiếu quyết
 * toán ví đã duyệt lại không có nút xoá ở đâu, nên kế toán kẹt hẳn.
 *
 * Ở đây gỡ cả cụm trong một giao dịch: bút toán của phiếu (kể cả vế phí theo ngày), phiếu QTVI,
 * cặp đối soát, dòng sao kê. Chỉ nhận khi MỌI chứng từ đang nối với dòng đều là quyết toán ví và
 * phiếu đó không nối thêm dòng sao kê nào khác (phiếu gộp nhiều dòng thì xoá một dòng là làm hỏng
 * phiếu của các dòng kia). Phiếu thu/chi thì vẫn đi đường cũ: xoá ở Chứng từ ngân hàng trước.
 */
export class BankLineDeleteError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function planBankLineWithSettlementDelete(bankId: string) {
  const bank = await prismaRaw.bankStatementTransaction.findFirst({
    where: { id: bankId, deletedAt: null },
    include: { matches: { where: { deletedAt: null } } },
  });
  if (!bank) throw new BankLineDeleteError("Không tìm thấy giao dịch sao kê", 404);
  const others = bank.matches.filter((match) => match.targetType !== "WALLET_SETTLEMENT");
  if (others.length > 0) {
    const codes = [...new Set(others.map((match) => match.targetCode))].join(", ");
    throw new BankLineDeleteError(`Giao dịch ${bank.transactionCode} còn liên kết với ${codes}. Xoá chứng từ đó trước rồi mới xoá dòng sao kê.`);
  }
  const transferIds = [...new Set(bank.matches.map((match) => match.targetId))];
  const transfers = await prismaRaw.moneyTransfer.findMany({ where: { id: { in: transferIds }, deletedAt: null } });
  for (const transfer of transfers) {
    const sharedWith = await prismaRaw.reconciliationMatch.findMany({
      where: { targetType: "WALLET_SETTLEMENT", targetId: transfer.id, deletedAt: null, bankTransactionId: { not: bank.id }, bankTransaction: { deletedAt: null } },
      include: { bankTransaction: { select: { transactionCode: true } } },
    });
    if (sharedWith.length > 0) {
      throw new BankLineDeleteError(
        `Phiếu ${transfer.code} còn quyết toán cho dòng sao kê ${sharedWith.map((match) => match.bankTransaction.transactionCode).join(", ")}. Không xoá kèm được — xử lý phiếu ở Sổ quỹ trước.`,
      );
    }
    if (transfer.internalReceivableDebtCode || transfer.internalPayableDebtCode) {
      throw new BankLineDeleteError(`Phiếu ${transfer.code} có công nợ nội bộ liên nhà hàng, không xoá kèm dòng sao kê được.`);
    }
  }
  const locked = await findClosedPeriod([
    { date: bank.transactionDate, branchCode: bank.branchCode },
    { date: bank.accountingDate || bank.transactionDate, branchCode: bank.branchCode },
    ...transfers.flatMap((transfer) => [
      { date: transfer.transferDate, branchCode: transfer.branchCode },
      { date: effectiveMoneyTransferDate(transfer), branchCode: transfer.branchCode },
    ]),
  ]);
  if (locked) throw new BankLineDeleteError(closedPeriodMessage(locked, "xoá dòng sao kê"));
  return { bank, transfers };
}

export async function deleteBankLineWithSettlements(input: { bankId: string; session: DemoSession | null; reason: string | null }) {
  const { bank, transfers } = await planBankLineWithSettlementDelete(input.bankId);
  const deletedAt = new Date();
  const deletedBy = input.session?.name || input.session?.email || null;
  const transferIds = transfers.map((transfer) => transfer.id);

  await prismaRaw.$transaction(async (tx) => {
    if (transferIds.length > 0) {
      // Bút toán dựng lại được từ phiếu (Ghi sổ kỳ lại) nên xoá hẳn như rollback import — để lại
      // bản xoá mềm thì khoá (sourceType, sourceId) chặn lần ghi sổ sau nếu phiếu được khôi phục.
      await tx.journalEntry.deleteMany({ where: { sourceType: { in: ["MONEY_TRANSFER", "MONEY_TRANSFER_COUNTERPART"] }, sourceId: { in: transferIds } } });
      await tx.journalEntry.deleteMany({
        where: { sourceType: WALLET_FEE_SOURCE_TYPE, OR: transferIds.map((id) => ({ sourceId: { startsWith: walletFeeSourcePrefix(id) } })) },
      });
      await tx.moneyTransfer.updateMany({ where: { id: { in: transferIds }, deletedAt: null }, data: { deletedAt, deletedBy } });
    }
    await tx.reconciliationMatch.updateMany({ where: { bankTransactionId: bank.id, deletedAt: null }, data: { deletedAt, deletedBy } });
    await tx.bankStatementTransaction.update({ where: { id: bank.id }, data: { deletedAt, deletedBy } });
    await tx.auditLog.create({
      data: buildAuditLogData({
        session: input.session,
        module: "/reconciliations",
        action: "DELETE_BANK_LINE_WITH_SETTLEMENT",
        entityType: "BankStatementTransaction",
        entityId: bank.id,
        entityCode: bank.transactionCode,
        branchCode: bank.branchCode,
        message: input.reason,
        metadata: { transfers: transfers.map((transfer) => ({ code: transfer.code, amount: transfer.amount, fee: transfer.feeAmount })) },
      }),
    });
  });
  return { transactionCode: bank.transactionCode, transferCodes: transfers.map((transfer) => transfer.code) };
}
