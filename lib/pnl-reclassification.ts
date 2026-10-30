/**
 * Phiếu điều chỉnh hạng mục P&L TRONG một nhà hàng (khách 30/10/2026: "chuyển hạng mục P&L A qua
 * hạng mục B trong cùng 1 nhà hàng"). Khác Chia sẻ chi phí nội bộ (lib/cost-reallocation.ts — cùng
 * hạng mục, khác nhà hàng): ở đây cùng nhà hàng, khác hạng mục, nên không có công nợ nội bộ.
 *
 * Một bút toán: Có tài khoản chi phí hạng mục A (P&L cộng debit − credit nên A giảm) / Nợ tài khoản
 * chi phí hạng mục B. Không đụng quỹ, công nợ; tổng chi phí nhà hàng không đổi (trừ khi A, B khác
 * nhóm Giá vốn / chi phí — số chỉ đổi chỗ giữa hai dòng P&L).
 */
import { expenseAccountForPnlGroup, type PlannedJournal } from "@/lib/cost-reallocation";

export type PnlReclassInput = {
  branchCode: string;
  fromPnlItemCode: string;
  toPnlItemCode: string;
  amount: number;
};

export function validatePnlReclass(input: PnlReclassInput) {
  const errors: string[] = [];
  if (!input.branchCode.trim()) errors.push("Chọn nhà hàng");
  if (!input.fromPnlItemCode.trim()) errors.push("Chọn hạng mục P&L chuyển đi (A)");
  if (!input.toPnlItemCode.trim()) errors.push("Chọn hạng mục P&L nhận (B)");
  if (input.fromPnlItemCode.trim() && input.fromPnlItemCode.trim().toUpperCase() === input.toPnlItemCode.trim().toUpperCase()) {
    errors.push("Hạng mục chuyển đi và hạng mục nhận phải khác nhau");
  }
  if (!(input.amount > 0)) errors.push("Số tiền phải lớn hơn 0");
  return errors;
}

/** Bút toán của phiếu: Nợ chi phí hạng mục B / Có chi phí hạng mục A, cùng nhà hàng. */
export function planPnlReclassJournal(
  input: PnlReclassInput,
  groups: { from: string | null; to: string | null },
): PlannedJournal {
  return {
    branchCode: input.branchCode.trim().toUpperCase(),
    description: `Chuyển chi phí từ hạng mục ${input.fromPnlItemCode} sang ${input.toPnlItemCode}`,
    lines: [
      { accountCode: expenseAccountForPnlGroup(groups.to), debit: input.amount, credit: 0, pnlItemCode: input.toPnlItemCode },
      { accountCode: expenseAccountForPnlGroup(groups.from), debit: 0, credit: input.amount, pnlItemCode: input.fromPnlItemCode },
    ],
  };
}

/**
 * Số chi phí của hạng mục A còn dời được khi SỬA phiếu: bút toán cũ của chính phiếu đã kéo A xuống
 * đúng số tiền cũ, nên cộng trả lại nếu phiếu cũ cùng kỳ, cùng nhà hàng, cùng hạng mục A.
 */
export function availableForPnlReclassEdit(input: {
  postedAmount: number;
  next: { period: string; branchCode: string; fromPnlItemCode: string };
  current: { period: string; branchCode: string; fromPnlItemCode: string; amount: number } | null;
}) {
  const { postedAmount, next, current } = input;
  if (current && current.period === next.period && current.branchCode === next.branchCode && current.fromPnlItemCode === next.fromPnlItemCode) {
    return postedAmount + current.amount;
  }
  return postedAmount;
}
