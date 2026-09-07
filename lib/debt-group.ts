/**
 * Phiếu công nợ nhiều dòng (trích trước cuối tháng: một NCC, nhiều hạng mục P&L).
 *
 * Mỗi dòng là một DebtRecord riêng để gạch nợ và báo cáo P&L tách đúng hạng mục, các dòng
 * dùng chung mã phiếu cha: dòng mang mã `CNPT-202609-0007/1`, `/2`... — phần trước "/" là mã
 * phiếu. Không thêm cột trong DB: nhóm được suy ra từ chính mã, nên dữ liệu cũ (mã phẳng) không
 * đổi gì.
 */

/** Mã phiếu cha của một dòng công nợ, hoặc null nếu là khoản đơn (mã phẳng). */
export function debtGroupCode(code: string): string | null {
  const slash = code.indexOf("/");
  return slash > 0 ? code.slice(0, slash) : null;
}

/** Số thứ tự dòng trong phiếu (1-based), hoặc null nếu là khoản đơn. */
export function debtLineNumber(code: string): number | null {
  const slash = code.indexOf("/");
  if (slash < 0) return null;
  const seq = Number(code.slice(slash + 1));
  return Number.isInteger(seq) && seq > 0 ? seq : null;
}

/**
 * Bỏ hậu tố "/n" để cấp số thứ tự phiếu kế tiếp: `nextSeqFromCodes` đọc `Number("0007/2")`
 * ra NaN và bỏ qua, nếu không lược hậu tố thì phiếu nhiều dòng không được tính vào MAX.
 */
export function stripDebtLineSuffix(code: string): string {
  const slash = code.indexOf("/");
  return slash > 0 ? code.slice(0, slash) : code;
}
