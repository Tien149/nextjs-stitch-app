import { prisma, prismaRaw } from "@/lib/prisma";
import { businessError, isPeriodLocked } from "@/lib/phase3";
import { postJournalEntry } from "@/lib/accounting";
import { isAdvanceSettlementDebt } from "@/lib/employee-advance";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { roundVnd } from "@/lib/round-vnd";

/**
 * Chuyển công nợ PHẢI TRẢ giữa hai đối tác, không phát sinh thu chi (khách 23/10/2026: "khi chị
 * chuyển đổi thì nó giảm phải trả đối tượng A, tăng phải trả đối tượng B").
 *
 *  - Khoản phải trả mới của B: DebtRecord mã = mã phiếu `CTCN-YYYYMM-NNNN`, sourceType
 *    DEBT_TRANSFER, KHÔNG ghi chi phí (chi phí đã ghi lúc phát sinh nợ A).
 *  - Nợ của A: gạch các khoản phải trả còn mở (cũ trước) qua DebtSettlement.transferId; phần
 *    vượt số khoản đang mở (nợ đầu kỳ, nợ PO) vẫn giảm số dư A trên sổ công nợ.
 *  - Bút toán Nợ 331 (A) / Có 331 (B): không đụng quỹ, không lên P&L.
 */
export const DEBT_TRANSFER_SOURCE = "DEBT_TRANSFER";
export const DEBT_TRANSFER_PREFIX = "CTCN";

export function isDebtTransferDebt(sourceType: string | null | undefined) {
  return (sourceType || "").toUpperCase() === DEBT_TRANSFER_SOURCE;
}

/** Bút toán của một phiếu chuyển — dùng lúc lập phiếu và lúc Đồng bộ ghi sổ. */
export function debtTransferJournal(transfer: { id: string; code: string; branchCode: string; documentDate: Date; fromPartnerCode: string; fromPartnerName: string; toPartnerCode: string; toPartnerName: string; amount: number; description: string }, actor: string) {
  return {
    entryDate: transfer.documentDate,
    branchCode: transfer.branchCode,
    sourceType: DEBT_TRANSFER_SOURCE,
    sourceId: transfer.id,
    sourceCode: transfer.code,
    description: `Chuyển công nợ phải trả ${transfer.fromPartnerName} → ${transfer.toPartnerName}${transfer.description ? `: ${transfer.description}` : ""}`,
    createdBy: actor,
    lines: [
      { accountCode: "331", debit: transfer.amount, partnerCode: transfer.fromPartnerCode, description: `Giảm phải trả ${transfer.fromPartnerName}` },
      { accountCode: "331", credit: transfer.amount, partnerCode: transfer.toPartnerCode, description: `Tăng phải trả ${transfer.toPartnerName}` },
    ],
  };
}

type CreateInput = {
  branchCode: string;
  documentDate: Date;
  fromPartnerCode: string;
  toPartnerCode: string;
  amount: number;
  description: string;
  dueDate?: Date | null;
};

export async function createDebtTransfer(input: CreateInput, actor: string) {
  const amount = roundVnd(input.amount);
  if (!(amount > 0)) businessError("Số tiền chuyển phải lớn hơn 0.");
  if (!input.fromPartnerCode || !input.toPartnerCode) businessError("Chọn đối tác chuyển đi và đối tác nhận.");
  if (input.fromPartnerCode === input.toPartnerCode) businessError("Đối tác nhận phải khác đối tác chuyển đi.");
  if (await isPeriodLocked(input.documentDate, input.branchCode)) businessError("Kỳ kế toán đã khóa, không thể chuyển công nợ vào kỳ này.");
  const partners = await prisma.masterDataItem.findMany({
    where: { type: "PARTNER", code: { in: [input.fromPartnerCode, input.toPartnerCode] }, deletedAt: null },
    select: { code: true, name: true, partnerGroup: true, status: true },
  });
  const from = partners.find((row) => row.code === input.fromPartnerCode);
  const to = partners.find((row) => row.code === input.toPartnerCode);
  if (!from) businessError(`Đối tác [${input.fromPartnerCode}] không có trong danh mục.`);
  if (!to || to.status !== "ACTIVE") businessError(`Đối tác nhận [${input.toPartnerCode}] không tồn tại hoặc đã ngừng hoạt động.`);

  const month = input.documentDate.toISOString().slice(0, 7).replace("-", "");
  const head = `${DEBT_TRANSFER_PREFIX}-${month}-`;

  return prisma.$transaction(async (tx) => {
    const [transferCodes, debtCodes] = await Promise.all([
      tx.debtTransfer.findMany({ where: { code: { startsWith: head } }, select: { code: true } }),
      tx.debtRecord.findMany({ where: { code: { startsWith: head }, deletedAt: undefined }, select: { code: true } }),
    ]);
    const code = `${head}${String(nextSeqFromCodes([...transferCodes, ...debtCodes].map((row) => row.code), head)).padStart(4, "0")}`;
    const transfer = await tx.debtTransfer.create({
      data: {
        code, branchCode: input.branchCode, documentDate: input.documentDate,
        fromPartnerCode: from.code, fromPartnerName: from.name, toPartnerCode: to.code, toPartnerName: to.name,
        amount, description: input.description, createdBy: actor,
      },
    });
    await tx.debtRecord.create({
      data: {
        code, debtType: "PAYABLE", partnerGroup: to.partnerGroup || "EXTERNAL", partnerCode: to.code, partnerName: to.name,
        branchCode: input.branchCode, documentDate: input.documentDate, dueDate: input.dueDate || null,
        originalAmount: amount, outstandingAmount: amount,
        description: `Nhận chuyển công nợ phải trả từ ${from.name} (${from.code})${input.description ? ` · ${input.description}` : ""}`,
        sourceType: DEBT_TRANSFER_SOURCE, sourceId: transfer.id, recognizeExpense: false, status: "OPEN",
      },
    });
    // Gạch nợ A: khoản mở cũ trước. Hoàn ứng không phải nợ chờ trả nên bỏ qua.
    const openDebts = (await tx.debtRecord.findMany({
      where: { debtType: "PAYABLE", partnerCode: from.code, branchCode: input.branchCode, outstandingAmount: { gt: 0 } },
      orderBy: [{ documentDate: "asc" }, { code: "asc" }],
    })).filter((debt) => !isAdvanceSettlementDebt(debt.sourceType) && debt.code !== code);
    let remaining = amount;
    const settled: string[] = [];
    for (const debt of openDebts) {
      if (remaining <= 0) break;
      const part = Math.min(remaining, roundVnd(debt.outstandingAmount));
      if (part <= 0) continue;
      const outstandingAmount = roundVnd(debt.outstandingAmount - part);
      await tx.debtSettlement.create({ data: { debtId: debt.id, transferId: transfer.id, settlementDate: input.documentDate, amount: part, createdBy: actor } });
      await tx.debtRecord.update({ where: { id: debt.id }, data: { outstandingAmount, status: outstandingAmount <= 0 ? "SETTLED" : "PARTIAL" } });
      settled.push(debt.code);
      remaining -= part;
    }
    return { transfer, settled, unmatched: remaining };
  }, { timeout: 30000 }).then(async (result) => {
    await postJournalEntry(debtTransferJournal(result.transfer, actor));
    return result;
  });
}

/** Xoá phiếu chuyển: trả lại nợ A, bỏ khoản của B và bút toán. Chặn khi B đã trả một phần. */
export async function deleteDebtTransfer(transferId: string) {
  const transfer = await prisma.debtTransfer.findUnique({ where: { id: transferId }, include: { settlements: true } });
  if (!transfer) businessError("Không tìm thấy phiếu chuyển công nợ.");
  if (await isPeriodLocked(transfer.documentDate, transfer.branchCode)) businessError("Kỳ kế toán đã khóa, không thể xoá phiếu chuyển công nợ.");
  const target = await prisma.debtRecord.findFirst({ where: { sourceType: DEBT_TRANSFER_SOURCE, sourceId: transfer.id, deletedAt: undefined }, include: { settlements: true } });
  if (target && target.settlements.length > 0) {
    businessError(`Khoản ${transfer.code} của ${transfer.toPartnerName} đã được thanh toán một phần nên không xoá được. Bỏ duyệt phiếu chi đã gạch khoản này trước.`);
  }
  // Xoá CỨNG (prismaRaw): khoản của B / bút toán nằm trong Thùng rác mà khôi phục riêng thì thành nợ mồ côi.
  await prismaRaw.$transaction(async (tx) => {
    for (const settlement of transfer.settlements) {
      const debt = await tx.debtRecord.findUnique({ where: { id: settlement.debtId } });
      if (!debt) continue;
      const outstandingAmount = Math.min(debt.originalAmount, roundVnd(debt.outstandingAmount + settlement.amount));
      await tx.debtRecord.update({ where: { id: debt.id }, data: { outstandingAmount, status: outstandingAmount >= debt.originalAmount ? "OPEN" : "PARTIAL" } });
    }
    if (target) await tx.debtRecord.delete({ where: { id: target.id } });
    await tx.journalEntry.deleteMany({ where: { sourceType: DEBT_TRANSFER_SOURCE, sourceId: transfer.id } });
    // Cascade xoá DebtSettlement.transferId.
    await tx.debtTransfer.delete({ where: { id: transfer.id } });
  });
  return transfer;
}
