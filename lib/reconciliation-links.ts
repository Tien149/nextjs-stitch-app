import type { RawTxClient } from "@/lib/prisma";

export async function completePendingReconciliation(
  tx: RawTxClient,
  targetType: string,
  targetId: string,
) {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType, targetId, status: "PENDING_REVIEW", deletedAt: null },
  });
  if (!match) return null;
  await tx.reconciliationMatch.update({ where: { id: match.id }, data: { status: "MATCHED" } });
  await tx.bankStatementTransaction.update({
    where: { id: match.bankTransactionId },
    data: { reconcileStatus: "MATCHED", autoProcessNote: `Đã duyệt và đối soát với ${match.targetCode}` },
  });
  return match;
}

export async function reopenReconciliationForReview(
  tx: RawTxClient,
  targetType: string,
  targetId: string,
) {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType, targetId, status: "MATCHED", deletedAt: null },
  });
  if (!match) return null;
  await tx.reconciliationMatch.update({ where: { id: match.id }, data: { status: "PENDING_REVIEW" } });
  await tx.bankStatementTransaction.update({
    where: { id: match.bankTransactionId },
    data: { reconcileStatus: "PENDING_REVIEW", autoProcessNote: `Phiếu ${match.targetCode} đã bỏ duyệt` },
  });
  return match;
}

export async function releasePendingReconciliation(
  tx: RawTxClient,
  targetType: string,
  targetId: string,
  note: string,
) {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType, targetId, status: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null },
  });
  if (!match) return null;
  await tx.bankStatementTransaction.update({
    where: { id: match.bankTransactionId },
    data: { reconcileStatus: "UNMATCHED", autoProcessType: "MANUAL_REQUIRED", autoProcessNote: note },
  });
  // Liên kết máy sinh chưa còn hiệu lực phải được xóa cứng để rollback/import lại không bị khóa.
  await tx.reconciliationMatch.delete({ where: { id: match.id } });
  return match;
}

export class ReconciliationSyncError extends Error {}

type SyncedField<T> = { previous: T; next: T };

export type BankStatementSyncResult = {
  transactionCode: string;
  amount?: SyncedField<number>;
  categoryCode?: SyncedField<string | null>;
  pnlItemCode?: SyncedField<string | null>;
};

type VoucherForBankSync = {
  id: string;
  code: string;
  voucherType: string;
  amount: number;
  categoryCode: string | null;
  pnlItemCode: string | null;
};

type AllocationFields = { categoryCode: string | null; pnlItemCode: string | null };

const cleanCode = (value: string | null | undefined) => (value || "").trim();
const moneyText = (value: number) => `${Math.round(value).toLocaleString("vi-VN")} đ`;

/**
 * Các dòng phân bổ của một mã giao dịch có thể mang khoản mục/P&L khác nhau (mỗi dòng một
 * loại thu chi). Lúc đó chứng từ không đại diện được cho dòng nào, đẩy giá trị của phiếu
 * xuống là xoá mất phân loại thật của từng dòng.
 */
function assertUniformAllocations(
  allocations: AllocationFields[],
  field: keyof AllocationFields,
  label: string,
  transactionCode: string,
) {
  const distinct = [...new Set(allocations.map((row) => cleanCode(row[field])).filter(Boolean))];
  if (distinct.length > 1) {
    throw new ReconciliationSyncError(
      `Giao dịch sao kê ${transactionCode} có ${distinct.length} ${label} khác nhau trên các dòng phân bổ nên không đồng bộ được từ chứng từ. Hãy sửa file sao kê rồi import lại giao dịch này.`,
    );
  }
}

/**
 * Sửa chứng từ ngân hàng phải kéo theo dòng sổ sao kê đã đối soát với nó.
 *
 * Ràng buộc "số sao kê = số chứng từ" vốn đã được ép lúc match tay (POST
 * /api/reconciliations trả lỗi "Số tiền sao kê và chứng từ không khớp"), nhưng đường sửa
 * phiếu lại không đụng tới BankStatementTransaction: màn Sổ sao kê ngân hàng và các báo
 * cáo đọc theo sao kê (vế chuyển khoản/ví của bảng thu chi theo danh mục, doanh thu
 * chuyển khoản trong ngày — xem lib/reports.ts và app/api/reports/route.ts) vẫn giữ số
 * cũ, khoản mục cũ, trong khi Sổ quỹ đọc thẳng phiếu đã đổi -> hai nơi lệch nhau âm thầm.
 *
 * Chỉ đẩy xuống những giá trị mà chứng từ thật sự mang: phiếu bỏ trống khoản mục/P&L thì
 * giữ nguyên giá trị đã khai trên sao kê, vì khoảng trống của phiếu không phải là dữ liệu.
 */
export async function syncReconciledBankStatement(
  tx: RawTxClient,
  voucher: VoucherForBankSync,
  actor: string,
): Promise<BankStatementSyncResult | null> {
  const match = await tx.reconciliationMatch.findFirst({
    where: { targetType: "VOUCHER", targetId: voucher.id, status: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null },
  });
  if (!match) return null;
  const bank = await tx.bankStatementTransaction.findFirst({
    where: { id: match.bankTransactionId, deletedAt: null },
  });
  if (!bank) return null;
  const allocations = await tx.bankStatementAllocation.findMany({
    where: { bankTransactionId: bank.id },
    orderBy: { sourceRowNumber: "asc" },
  });

  const result: BankStatementSyncResult = { transactionCode: bank.transactionCode };
  const changes: string[] = [];
  const bankData: Record<string, unknown> = {};
  const allocationData: Record<string, unknown> = {};

  const amount = Math.round(voucher.amount);
  const previousAmount = bank.creditAmount || bank.debitAmount;
  if (Math.abs(previousAmount - amount) >= 1) {
    // Một mã giao dịch trải trên nhiều dòng phân bổ (nhiều ngày doanh thu / nhiều đối tác):
    // không có cách nào chia lại phần chênh cho từng dòng mà không đoán mò.
    if (allocations.length > 1) {
      throw new ReconciliationSyncError(
        `Giao dịch sao kê ${bank.transactionCode} có ${allocations.length} dòng phân bổ nên không tự chia lại số tiền được. Hãy sửa file sao kê rồi import lại giao dịch này.`,
      );
    }
    const isReceipt = voucher.voucherType === "RECEIPT";
    if ((isReceipt && bank.debitAmount > 0) || (!isReceipt && bank.creditAmount > 0)) {
      throw new ReconciliationSyncError(
        `Chứng từ ${voucher.code} ngược chiều với giao dịch sao kê ${bank.transactionCode}. Hãy xoá phiếu và lập lại đúng loại thu/chi.`,
      );
    }
    const amounts = isReceipt
      ? { creditAmount: amount, debitAmount: 0 }
      : { creditAmount: 0, debitAmount: amount };
    Object.assign(bankData, amounts);
    Object.assign(allocationData, amounts);
    result.amount = { previous: previousAmount, next: amount };
    changes.push(`số tiền ${moneyText(previousAmount)} → ${moneyText(amount)}`);
  }

  const categoryCode = cleanCode(voucher.categoryCode);
  if (categoryCode && categoryCode !== cleanCode(bank.categoryCode)) {
    assertUniformAllocations(allocations, "categoryCode", "khoản mục thu/chi", bank.transactionCode);
    bankData.categoryCode = categoryCode;
    allocationData.categoryCode = categoryCode;
    result.categoryCode = { previous: bank.categoryCode, next: categoryCode };
    changes.push(`khoản mục ${bank.categoryCode || "—"} → ${categoryCode}`);
  }

  // Chỉ phiếu chi mới được mang hạng mục P&L (validateVoucherPnlItem chặn phiếu thu), nên
  // ô trống của phiếu thu không được phép xoá P&L đã khai trên sao kê.
  const pnlItemCode = voucher.voucherType === "PAYMENT" ? cleanCode(voucher.pnlItemCode) : "";
  if (pnlItemCode && pnlItemCode !== cleanCode(bank.pnlItemCode)) {
    assertUniformAllocations(allocations, "pnlItemCode", "hạng mục P&L", bank.transactionCode);
    bankData.pnlItemCode = pnlItemCode;
    allocationData.pnlItemCode = pnlItemCode;
    result.pnlItemCode = { previous: bank.pnlItemCode, next: pnlItemCode };
    changes.push(`hạng mục P&L ${bank.pnlItemCode || "—"} → ${pnlItemCode}`);
  }

  if (changes.length === 0) {
    // Không có gì đổi nhưng liên kết vẫn phải mang đúng số hiện tại của phiếu.
    if (Math.abs(match.targetAmount - amount) >= 1 || Math.abs(match.matchedAmount - amount) >= 1) {
      await tx.reconciliationMatch.update({
        where: { id: match.id },
        data: { targetAmount: amount, matchedAmount: amount },
      });
    }
    return null;
  }

  await tx.bankStatementTransaction.update({
    where: { id: bank.id },
    data: {
      ...bankData,
      autoProcessNote: `Đồng bộ theo chứng từ ${voucher.code}: ${changes.join("; ")} (${actor})`,
    },
  });
  // Số tiền chỉ đổi khi giao dịch có tối đa một dòng phân bổ, còn khoản mục/P&L chỉ đổi khi
  // các dòng đang cùng một giá trị, nên ghi đè cả nhóm là an toàn.
  if (allocations.length > 0) {
    await tx.bankStatementAllocation.updateMany({ where: { bankTransactionId: bank.id }, data: allocationData });
  }
  await tx.reconciliationMatch.update({
    where: { id: match.id },
    data: { targetAmount: amount, matchedAmount: amount },
  });

  return result;
}
