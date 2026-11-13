import { prisma } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";
import { CASH_MOVING_ADJUSTMENT_FILTER } from "@/lib/revenue-settlement-writeoff";
import { effectiveMoneyTransferDate, effectiveMoneyTransferDateFilter } from "@/lib/money-transfer-date";
import { transferLegsForBranch } from "@/lib/internal-transfer";
import { cashOpeningBalance } from "@/lib/cash-opening-balance";

/**
 * Dòng phát sinh của SỔ QUỸ (màn Sổ quỹ & Cuối kỳ): phiếu thu/chi đã duyệt, phiếu điều chỉnh quỹ
 * chạm tiền thật, và vế đi/vế đến của phiếu điều tiền đã duyệt. Tách ra đây để màn sổ quỹ và báo
 * cáo đối chiếu Sổ quỹ – Nguồn tiền (khách 13/11/2026) dùng ĐÚNG một luật, không phải hai bản sao.
 */
type VoucherRow = { id: string; voucherDate: Date; createdAt: Date; code: string; voucherType: string; branchCode: string; moneySourceCode: string; description: string; amount: number };
type AdjustmentRow = { id: string; entryDate: Date; createdAt: Date; code: string; entryType: string; branchCode: string; moneySourceCode: string; description: string; pnlItemCode: string | null; amount: number };
type TransferRow = {
  id: string; status: string; transferDate: Date; actualTransferDate: Date | null; createdAt: Date; code: string; branchCode: string;
  fromBranchCode: string | null; toBranchCode: string | null; fromMoneySourceCode: string; toMoneySourceCode: string;
  description: string; amount: number; feeAmount: number; transferPurpose: string | null;
};

export function buildCashbookEntries(input: { vouchers: VoucherRow[]; adjustments: AdjustmentRow[]; transfers: TransferRow[]; branchCode: string }) {
  const { branchCode } = input;
  return [
    ...input.vouchers.map((row) => ({ id: row.id, date: row.voucherDate, createdAt: row.createdAt, code: row.code, type: row.voucherType, branchCode: row.branchCode, moneySourceCode: row.moneySourceCode, description: row.description, receipt: row.voucherType === "RECEIPT" ? row.amount : 0, payment: row.voucherType === "PAYMENT" ? row.amount : 0 })),
    // pnlItemCode đi kèm để hộp thoại Sửa phiếu điều chỉnh hiện đúng hạng mục P&L đang khai.
    ...input.adjustments.map((row) => ({ id: row.id, date: row.entryDate, createdAt: row.createdAt, code: row.code, type: "ADJUSTMENT", branchCode: row.branchCode, moneySourceCode: row.moneySourceCode, description: row.description, pnlItemCode: row.pnlItemCode, receipt: row.entryType === "RECEIPT" ? row.amount : 0, payment: row.entryType === "PAYMENT" ? row.amount : 0 })),
    // Quyết toán ví: tiền rời ví = số về ngân hàng + phí, nên số dư ví mới về đúng 0.
    // Phiếu liên nhà hàng chỉ góp một vế cho mỗi cửa hàng: bên chuyển thấy tiền ra, bên
    // nhận thấy tiền vào. Lấy cả hai vế sẽ cộng nhầm nguồn tiền của cửa hàng kia vào sổ.
    ...input.transfers.filter((row) => row.status === "APPROVED").flatMap((row) => {
      const legs = transferLegsForBranch(row, branchCode);
      return [
        ...(legs.out ? [{ id: `${row.id}-out`, date: effectiveMoneyTransferDate(row), createdAt: row.createdAt, code: row.code, type: "TRANSFER_OUT", branchCode: row.branchCode, moneySourceCode: row.fromMoneySourceCode, description: row.description, receipt: 0, payment: row.amount + row.feeAmount }] : []),
        ...(legs.in ? [{ id: `${row.id}-in`, date: effectiveMoneyTransferDate(row), createdAt: row.createdAt, code: row.code, type: "TRANSFER_IN", branchCode: row.branchCode, moneySourceCode: row.toMoneySourceCode, description: row.description, receipt: row.amount, payment: 0 }] : []),
      ];
    }),
  ];
}

export type CashbookSourceTotals = { opening: number; receipt: number; payment: number; closing: number };

/** Đầu kỳ / Thu / Chi / Cuối kỳ của sổ quỹ theo TỪNG mã nguồn tiền trong một kỳ. */
export async function cashbookTotalsBySource(period: string, branchCode: string): Promise<Map<string, CashbookSourceTotals>> {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(`${addPeriod(period, 1)}-01T00:00:00`);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [opening, vouchers, adjustments, transfers] = await Promise.all([
    cashOpeningBalance({ period, branchCode }),
    prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherDate: { gte: start, lt: end }, status: "APPROVED" } }),
    prisma.cashbookAdjustment.findMany({ where: { ...branchFilter, entryDate: { gte: start, lt: end }, ...CASH_MOVING_ADJUSTMENT_FILTER } }),
    prisma.moneyTransfer.findMany({
      where: {
        ...(branchCode === "ALL" ? {} : { AND: [{ OR: [{ branchCode }, { fromBranchCode: branchCode }, { toBranchCode: branchCode }] }] }),
        status: "APPROVED",
        ...effectiveMoneyTransferDateFilter(start, end),
      },
    }),
  ]);
  const totals = new Map<string, CashbookSourceTotals>();
  const touch = (code: string) => {
    const existing = totals.get(code);
    if (existing) return existing;
    const created = { opening: 0, receipt: 0, payment: 0, closing: 0 };
    totals.set(code, created);
    return created;
  };
  for (const [code, amount] of opening.bySource) touch(code).opening += amount;
  for (const entry of buildCashbookEntries({ vouchers, adjustments, transfers, branchCode })) {
    const row = touch(entry.moneySourceCode || "");
    row.receipt += entry.receipt;
    row.payment += entry.payment;
  }
  for (const row of totals.values()) row.closing = row.opening + row.receipt - row.payment;
  return totals;
}
