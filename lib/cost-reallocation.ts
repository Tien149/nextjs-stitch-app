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

const INTERNAL_PARTNER_PREFIX = "NB-";

/** Đối tác này là một nhà hàng trong nhà (công nợ nội bộ) hay đối tác bên ngoài. */
export function isInternalPartnerCode(partnerCode: string | null | undefined) {
  return (partnerCode || "").trim().toUpperCase().startsWith(INTERNAL_PARTNER_PREFIX);
}

/**
 * Nhà hàng đứng sau một mã đối tác nội bộ; trả null nếu đó là đối tác bên ngoài.
 * Dùng để biết khoản chi hộ đang gánh nợ cho nhà hàng nào.
 *
 * `knownBranchCodes` là danh sách mã cửa hàng có thật trong danh mục. BẮT BUỘC truyền ở mọi
 * chỗ ghi sổ: tiền tố "NB-" không phải bằng chứng — người dùng có thể tự đặt mã kiểu NB-THOA,
 * NB-CHAU cho một cá nhân, và hiểu nhầm nó là nhà hàng thì khoản công nợ đối ứng rơi vào một
 * cửa hàng không tồn tại, không màn hình nào nhìn thấy để sửa. Không truyền thì mặc định coi
 * là đối tác bên ngoài — sai theo hướng an toàn.
 */
export function branchCodeFromInternalPartner(
  partnerCode: string | null | undefined,
  knownBranchCodes?: Iterable<string> | null,
) {
  const code = (partnerCode || "").trim().toUpperCase();
  if (!code.startsWith(INTERNAL_PARTNER_PREFIX)) return null;
  const branchCode = code.slice(INTERNAL_PARTNER_PREFIX.length) || null;
  if (!branchCode) return null;
  const known = new Set([...(knownBranchCodes || [])].map((item) => (item || "").trim().toUpperCase()));
  return known.has(branchCode) ? branchCode : null;
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

const vnd = (value: number) => `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;

/**
 * Phiếu phân bổ chỉ CHIA LẠI chi phí đã có trên sổ của nhà hàng đã trả, trong ĐÚNG kỳ của
 * phiếu. Phân bổ nhiều hơn số đang có nghĩa là một trong ba ô khai sai:
 *  - Ngày chứng từ: chi phí gốc nằm ở kỳ khác (hay gặp nhất — form mặc định ngày hôm nay,
 *    trong khi kế toán đang soát kỳ tháng trước);
 *  - Nhà hàng đã trả: chọn nhầm nhà hàng;
 *  - Hạng mục P&L: chi phí gốc đang đứng ở hạng mục khác.
 * Cả ba đều im lặng nếu cứ cho ghi sổ: kỳ của phiếu ôm một khoản chi phí âm không ai nhìn ra,
 * còn kỳ có chi phí gốc vẫn nguyên si — đúng lỗi "đã phân bổ giảm rồi mà Tổng hợp chi phí vẫn
 * hiện đủ số" (feedback 19/09/2026).
 *
 * Trả null khi phiếu hợp lệ.
 */
/** Nơi tiền của hạng mục đang thực sự nằm — để câu báo lỗi chỉ thẳng chỗ, xem findExpenseForPnlItem. */
export type ReallocationWhereabouts = {
  otherPeriods: Array<{ period: string; amount: number }>;
  otherBranches: Array<{ branchCode: string; amount: number }>;
  notPostedVouchers: Array<{ code: string; amount: number; status: string }>;
  notPostedTotal: number;
};

export function reallocationOverspendMessage(input: {
  period: string;
  fromBranchCode: string;
  pnlItemName: string;
  /** Chi phí của hạng mục đó ở nhà hàng đã trả, trong kỳ của phiếu, đã trừ các phiếu phân bổ trước. */
  postedAmount: number;
  total: number;
  /** Tuỳ chọn: nơi tiền đang nằm, để chỉ thẳng thay vì bắt người dùng tự mò ba ô. */
  whereabouts?: ReallocationWhereabouts | null;
}) {
  if (input.total <= input.postedAmount) return null;
  const head = input.postedAmount > 0
    ? `Kỳ ${input.period} ở ${input.fromBranchCode} chỉ còn ${vnd(input.postedAmount)} chi phí ở hạng mục "${input.pnlItemName}", không đủ để phân bổ ${vnd(input.total)}.`
    : `Kỳ ${input.period} ở ${input.fromBranchCode} chưa có đồng chi phí nào ở hạng mục "${input.pnlItemName}" để phân bổ ${vnd(input.total)}.`;

  /**
   * NÓI THẲNG TIỀN ĐANG Ở ĐÂU.
   *
   * Câu cũ chỉ liệt kê ba ô cần kiểm lại, nên kế toán phải tự mò và hay kết luận là phần mềm
   * chặn nhầm rồi xin bỏ chặn (khách 21/09/2026). Bỏ chặn thì kỳ đó ôm chi phí âm ở MỘT hạng
   * mục, cộng lên nhóm vẫn dương nên không nổi lên dòng tổng — sổ lệch mà không ai thấy.
   * Giữ chặn, nhưng chỉ thẳng chỗ tiền đang nằm để người dùng xử được ngay.
   */
  const hints: string[] = [];
  const where = input.whereabouts;
  if (where?.notPostedVouchers.length) {
    const list = where.notPostedVouchers.slice(0, 5).map((row) => `${row.code} (${vnd(row.amount)})`).join(", ");
    const more = where.notPostedVouchers.length > 5 ? ` và ${where.notPostedVouchers.length - 5} phiếu khác` : "";
    hints.push(
      `Đang có ${vnd(where.notPostedTotal)} ở phiếu chi CHƯA VÀO SỔ của đúng kỳ và đúng hạng mục này: ${list}${more}. `
      + "Vào Sổ cái Kế toán bấm Đồng bộ ghi sổ kỳ này rồi lập lại phiếu phân bổ.",
    );
  }
  if (where?.otherPeriods.length) {
    const list = where.otherPeriods.map((row) => `${row.period} (${vnd(row.amount)})`).join(", ");
    hints.push(`Chi phí của hạng mục này đang nằm ở kỳ khác: ${list}. Sửa Ngày chứng từ về đúng kỳ có chi phí gốc.`);
  }
  if (where?.otherBranches.length) {
    const list = where.otherBranches.map((row) => `${row.branchCode} (${vnd(row.amount)})`).join(", ");
    hints.push(`Trong kỳ này, chi phí của hạng mục đang đứng ở nhà hàng khác: ${list}. Kiểm lại ô Nhà hàng đã trả.`);
  }
  if (hints.length === 0) {
    hints.push("Kiểm tra lại Ngày chứng từ (chi phí gốc nằm ở kỳ nào thì phiếu phân bổ phải nằm ở kỳ đó), nhà hàng đã trả và hạng mục P&L.");
  }
  return `${head} ${hints.join(" ")}`;
}
