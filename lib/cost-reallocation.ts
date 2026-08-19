/**
 * Phân bổ chi phí liên nhà hàng.
 *
 * Bối cảnh: một nhà hàng đứng ra trả 100% cho nhà cung cấp, nhưng chi phí đó có phần thuộc
 * nhà hàng khác. Nghiệp vụ này làm hai việc cùng lúc và phải luôn đi cùng nhau:
 *  - P&L: GIẢM chi phí ở nhà hàng đã trả, TĂNG chi phí ở nhà hàng thụ hưởng, cùng một hạng
 *    mục P&L nên tổng toàn công ty không đổi, chỉ đổi chỗ giữa hai nhà hàng.
 *  - Công nợ nội bộ: nhà hàng thụ hưởng nợ lại nhà hàng đã trả đúng số tiền đó.
 *
 * Không có dòng tiền nào chạy tại thời điểm phân bổ. Tiền chỉ chạy khi nhà hàng kia hoàn lại,
 * lúc đó dùng phiếu thu/chi gạch vào chính mã công nợ nội bộ sinh ra ở đây.
 */

/** Tài khoản chi phí theo nhóm hạng mục P&L — cùng quy tắc với định khoản phiếu chi. */
export function expenseAccountForPnlGroup(pnlItemGroup: string | null | undefined) {
  return (pnlItemGroup || "").trim().toUpperCase() === "COGS" ? "632" : "6428";
}

export const INTERNAL_RECEIVABLE_ACCOUNT = "1368";
export const INTERNAL_PAYABLE_ACCOUNT = "3368";

/** Mã đối tác nội bộ đại diện cho một nhà hàng, dùng làm đối tượng của công nợ nội bộ. */
export function internalPartnerCode(branchCode: string) {
  return `NB-${branchCode.trim().toUpperCase()}`;
}

export type CostReallocationLineInput = {
  toBranchCode: string;
  amount: number;
  note?: string | null;
};

export type CostReallocationInput = {
  fromBranchCode: string;
  pnlItemCode: string;
  lines: CostReallocationLineInput[];
};

/**
 * Kiểm tra nghiệp vụ trước khi ghi sổ. Trả về danh sách lỗi rỗng nghĩa là hợp lệ.
 *
 * Tổng tiền của phiếu LUÔN suy từ các dòng chứ không nhận từ ngoài, nên không thể có
 * chuyện tổng phiếu khác tổng phân bổ.
 */
export function validateCostReallocation(input: CostReallocationInput) {
  const errors: string[] = [];
  const fromBranch = input.fromBranchCode.trim().toUpperCase();

  if (!fromBranch) errors.push("Thiếu nhà hàng đã trả chi phí");
  if (!input.pnlItemCode.trim()) errors.push("Bắt buộc chọn Hạng mục P&L của khoản chi phí");
  if (input.lines.length === 0) errors.push("Phải có ít nhất một nhà hàng nhận chi phí");

  const seenBranches = new Set<string>();
  for (const line of input.lines) {
    const toBranch = line.toBranchCode.trim().toUpperCase();
    if (!toBranch) {
      errors.push("Mỗi dòng phải chọn nhà hàng nhận chi phí");
      continue;
    }
    if (toBranch === fromBranch) {
      errors.push(`Nhà hàng nhận (${toBranch}) phải khác nhà hàng đã trả`);
    }
    if (seenBranches.has(toBranch)) {
      errors.push(`Nhà hàng ${toBranch} bị khai trùng trên hai dòng — gộp lại thành một dòng`);
    }
    seenBranches.add(toBranch);
    if (!(line.amount > 0)) errors.push(`Số tiền phân bổ cho ${toBranch} phải lớn hơn 0`);
  }

  return errors;
}

export function costReallocationTotal(lines: CostReallocationLineInput[]) {
  return lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
}

export type PlannedJournal = {
  /** Nhà hàng ghi sổ bút toán này. */
  branchCode: string;
  description: string;
  lines: Array<{ accountCode: string; debit: number; credit: number; pnlItemCode?: string | null; partnerCode?: string | null }>;
};

/**
 * Dựng các bút toán của phiếu. Một bút toán ở nhà hàng đã trả (giảm chi phí, ghi phải thu
 * nội bộ) và mỗi nhà hàng nhận một bút toán (tăng chi phí, ghi phải trả nội bộ).
 *
 * Ghi Có tài khoản chi phí chính là cách "giảm chi phí" trên P&L: báo cáo cộng
 * (debit - credit) nên dòng ghi Có kéo chi phí của nhà hàng đó xuống.
 */
export function planCostReallocationJournals(input: CostReallocationInput, pnlItemGroup: string | null): PlannedJournal[] {
  const expenseAccount = expenseAccountForPnlGroup(pnlItemGroup);
  const fromBranch = input.fromBranchCode.trim().toUpperCase();
  const total = costReallocationTotal(input.lines);

  const journals: PlannedJournal[] = [{
    branchCode: fromBranch,
    description: `Giảm chi phí do phân bổ cho ${input.lines.length} nhà hàng khác`,
    lines: [
      { accountCode: INTERNAL_RECEIVABLE_ACCOUNT, debit: total, credit: 0 },
      { accountCode: expenseAccount, debit: 0, credit: total, pnlItemCode: input.pnlItemCode },
    ],
  }];

  for (const line of input.lines) {
    const toBranch = line.toBranchCode.trim().toUpperCase();
    journals.push({
      branchCode: toBranch,
      description: `Nhận chi phí phân bổ từ ${fromBranch}`,
      lines: [
        { accountCode: expenseAccount, debit: line.amount, credit: 0, pnlItemCode: input.pnlItemCode },
        { accountCode: INTERNAL_PAYABLE_ACCOUNT, debit: 0, credit: line.amount, partnerCode: internalPartnerCode(fromBranch) },
      ],
    });
  }

  return journals;
}

/** Mỗi bút toán phải cân; dùng để tự kiểm trước khi ghi sổ. */
export function journalIsBalanced(journal: PlannedJournal) {
  const debit = journal.lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = journal.lines.reduce((sum, line) => sum + line.credit, 0);
  return Math.abs(debit - credit) < 0.5;
}
