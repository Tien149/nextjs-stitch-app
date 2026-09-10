import { parseImportDate } from "@/lib/import-date";

/**
 * Tách một giao dịch sao kê đã ghi nhận thành nhiều dòng Ngày doanh thu.
 *
 * File sao kê của khách hay gộp 3-4 ngày doanh thu vào cùng một lần ví/ngân hàng trả tiền.
 * Import xong mới phát hiện thì trước đây phải rollback lô rồi import lại; bảng "Tiền về đủ
 * chưa" (lib/reports.ts:getRevenueSettlementReport) đọc theo BankStatementAllocation.revenueDate
 * nên toàn bộ tiền dồn vào một ngày, ngày còn lại báo thiếu tiền.
 *
 * Chỉ chia lại phần phân bổ: tổng Nợ/Có, gross ví và hai khoản phí được giữ nguyên đến từng
 * đồng, nên dòng tiền và chi phí trên sổ không đổi — chỉ đổi chỗ đứng theo Ngày doanh thu.
 */

export type RevenueSplitLineInput = {
  id?: unknown;
  revenueDate?: unknown;
  amount?: unknown;
};

export type RevenueSplitTransaction = {
  debitAmount: number;
  creditAmount: number;
  grossAmount: number | null;
  grabExpenseAmount: number;
  cardFeeAmount: number;
};

export type RevenueSplitAllocation = {
  id: string;
  sheetName: string;
  sourceRowNumber: number;
  grossAmount: number | null;
  grabExpenseAmount: number;
  cardFeeAmount: number;
};

export type RevenueSplitLine = {
  id: string | null;
  sheetName: string;
  sourceRowNumber: number;
  revenueDate: Date;
  debitAmount: number;
  creditAmount: number;
  grossAmount: number | null;
  grabExpenseAmount: number;
  cardFeeAmount: number;
};

export type RevenueSplitPlan = {
  direction: "CREDIT" | "DEBIT";
  totalAmount: number;
  lines: RevenueSplitLine[];
  removedIds: string[];
  /** Giao dịch chỉ mang Ngày doanh thu khi mọi dòng cùng một ngày, đúng như lúc import. */
  transactionRevenueDate: Date | null;
};

export const DEFAULT_SPLIT_SHEET_NAME = "Sửa tay";

export class RevenueSplitError extends Error {}

function moneyText(value: number) {
  return `${Math.round(value).toLocaleString("vi-VN")} đ`;
}

/** Chia một số nguyên theo tỷ trọng, giữ đúng tổng: phần dư về các dòng có phần lẻ lớn nhất. */
function allocateInteger(total: number, weights: number[]) {
  const roundedTotal = Math.max(0, Math.round(total));
  const normalized = weights.map((value) => Math.max(0, Math.round(value)));
  const weightTotal = normalized.reduce((sum, value) => sum + value, 0);
  if (roundedTotal === 0 || weightTotal === 0) return normalized.map(() => 0);

  const exact = normalized.map((value) => (roundedTotal * value) / weightTotal);
  const result = exact.map(Math.floor);
  let remainder = roundedTotal - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let cursor = 0; remainder > 0; cursor += 1, remainder -= 1) {
    result[order[cursor % order.length].index] += 1;
  }
  return result;
}

/** Tổng đã khai trên các dòng phân bổ mới là số thật; giao dịch chỉ là chỗ dựa cho dữ liệu cũ. */
function totalGross(existing: RevenueSplitAllocation[], transaction: RevenueSplitTransaction) {
  if (existing.length === 0) return transaction.grossAmount === null ? null : Math.round(transaction.grossAmount);
  if (existing.every((row) => row.grossAmount === null || row.grossAmount === 0)) {
    // Dòng phân bổ chưa khai gross nhưng giao dịch có thì vẫn phải giữ lại con số đó.
    return transaction.grossAmount ? Math.round(transaction.grossAmount) : null;
  }
  return existing.reduce((sum, row) => sum + Math.round(row.grossAmount || 0), 0);
}

function totalFee(existing: RevenueSplitAllocation[], fallback: number, field: "grabExpenseAmount" | "cardFeeAmount") {
  if (existing.length === 0) return Math.round(fallback);
  const fromAllocations = existing.reduce((sum, row) => sum + Math.round(row[field] || 0), 0);
  return fromAllocations || Math.round(fallback);
}

export function planRevenueDateSplit(input: {
  transaction: RevenueSplitTransaction;
  existing: RevenueSplitAllocation[];
  lines: RevenueSplitLineInput[];
}): RevenueSplitPlan {
  const creditTotal = Math.round(input.transaction.creditAmount || 0);
  const debitTotal = Math.round(input.transaction.debitAmount || 0);
  if (creditTotal > 0 && debitTotal > 0) {
    throw new RevenueSplitError("Giao dịch có cả Nợ và Có nên không tách theo Ngày doanh thu được.");
  }
  const totalAmount = creditTotal || debitTotal;
  if (totalAmount <= 0) throw new RevenueSplitError("Giao dịch không có số tiền để tách.");
  const direction: "CREDIT" | "DEBIT" = creditTotal > 0 ? "CREDIT" : "DEBIT";

  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (rawLines.length === 0) throw new RevenueSplitError("Phải giữ lại ít nhất một dòng Ngày doanh thu.");

  const existingById = new Map(input.existing.map((row) => [row.id, row]));
  const usedIds = new Set<string>();
  const seenDates = new Set<string>();
  const parsed = rawLines.map((line, index) => {
    const id = typeof line.id === "string" && line.id.trim() ? line.id.trim() : null;
    if (id) {
      if (!existingById.has(id)) throw new RevenueSplitError(`Dòng ${index + 1} không thuộc giao dịch này — hãy tải lại trang.`);
      if (usedIds.has(id)) throw new RevenueSplitError(`Dòng ${index + 1} bị khai trùng — hãy tải lại trang.`);
      usedIds.add(id);
    }
    const revenueDate = parseImportDate(line.revenueDate);
    if (!revenueDate) throw new RevenueSplitError(`Dòng ${index + 1} thiếu Ngày doanh thu hợp lệ.`);
    const dateKey = revenueDate.toISOString().slice(0, 10);
    if (seenDates.has(dateKey)) {
      throw new RevenueSplitError(`Ngày doanh thu ${revenueDate.toLocaleDateString("vi-VN", { timeZone: "UTC" })} bị khai hai lần — gộp lại thành một dòng.`);
    }
    seenDates.add(dateKey);
    const amount = Math.round(Number(line.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new RevenueSplitError(`Dòng ${index + 1} phải có số tiền lớn hơn 0.`);
    return { id, revenueDate, amount, existing: id ? existingById.get(id)! : null };
  });

  const declaredTotal = parsed.reduce((sum, line) => sum + line.amount, 0);
  if (declaredTotal !== totalAmount) {
    const gap = totalAmount - declaredTotal;
    throw new RevenueSplitError(
      `Tổng các dòng đang là ${moneyText(declaredTotal)}, phải đúng bằng số tiền giao dịch ${moneyText(totalAmount)} (còn ${gap > 0 ? "thiếu" : "dư"} ${moneyText(Math.abs(gap))}).`,
    );
  }

  const grossTotal = totalGross(input.existing, input.transaction);
  const grabTotal = totalFee(input.existing, input.transaction.grabExpenseAmount, "grabExpenseAmount");
  const cardTotal = totalFee(input.existing, input.transaction.cardFeeAmount, "cardFeeAmount");
  const amounts = parsed.map((line) => line.amount);
  // Chia phần phí (gross − thực nhận) thay vì chia thẳng gross: dòng nào cũng chắc chắn có
  // gross ≥ số tiền thực về, không sinh ra phí âm vì làm tròn.
  const feeTotal = grossTotal !== null && grossTotal >= totalAmount ? grossTotal - totalAmount : 0;
  const feeSplit = allocateInteger(feeTotal, amounts);
  const grabSplit = allocateInteger(grabTotal, feeTotal > 0 ? feeSplit : amounts);
  const cardSplit = grabTotal + cardTotal === feeTotal
    ? feeSplit.map((value, index) => value - grabSplit[index])
    : allocateInteger(cardTotal, feeTotal > 0 ? feeSplit : amounts);
  const grossSplit = grossTotal === null
    ? amounts.map(() => null)
    : feeTotal > 0 || grossTotal === totalAmount
      ? amounts.map((amount, index) => amount + feeSplit[index])
      : allocateInteger(grossTotal, amounts);

  const sheetName = input.existing[0]?.sheetName || DEFAULT_SPLIT_SHEET_NAME;
  let nextRowNumber = input.existing.reduce((max, row) => Math.max(max, row.sourceRowNumber), 0) + 1;

  const lines: RevenueSplitLine[] = parsed.map((line, index) => ({
    id: line.id,
    sheetName: line.existing?.sheetName || sheetName,
    sourceRowNumber: line.existing ? line.existing.sourceRowNumber : nextRowNumber++,
    revenueDate: line.revenueDate,
    debitAmount: direction === "DEBIT" ? line.amount : 0,
    creditAmount: direction === "CREDIT" ? line.amount : 0,
    grossAmount: grossSplit[index],
    grabExpenseAmount: grabSplit[index],
    cardFeeAmount: cardSplit[index],
  }));

  const dateKeys = new Set(lines.map((line) => line.revenueDate.toISOString()));

  return {
    direction,
    totalAmount,
    lines,
    removedIds: input.existing.filter((row) => !usedIds.has(row.id)).map((row) => row.id),
    transactionRevenueDate: dateKeys.size === 1 ? lines[0].revenueDate : null,
  };
}
