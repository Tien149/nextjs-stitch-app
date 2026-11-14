/**
 * Chia lợi nhuận cho BOD / thành viên góp vốn (khách 14/11/2026): "khi chia lãi cho BOD thì giảm
 * lợi nhuận 421, tăng phải trả BOD", lập ngay ở màn Công nợ Đối tác.
 *
 * - Popup Thêm công nợ, loại "Chia lợi nhuận": mỗi dòng một khoản công nợ PHẢI TRẢ sourceType
 *   PROFIT_DISTRIBUTION, mã CLN-<yyyymm>-<số>. Không hạng mục P&L, không phân bổ, không chi phí
 *   (recognizeExpense = false) — chia lãi là phân phối vốn chủ, không phải chi phí.
 * - Ghi sổ (syncAccountingPeriod): Nợ 421 / Có 331 theo đối tác. Có 331 (không 3388) vì phiếu
 *   chi "Thanh toán công nợ" gạch nợ luôn ghi Nợ 331 — treo tài khoản khác thì trả xong 331 âm.
 * - Bảng cân đối: dòng 421 tách riêng "Chia lợi nhuận" khỏi số dư đầu kỳ khai.
 *
 * Phần thuần để client dùng chung (không kéo prisma).
 */
export const PROFIT_DISTRIBUTION_SOURCE = "PROFIT_DISTRIBUTION";

/** Giá trị ô "Loại công nợ" trên popup Thêm công nợ (API quy về PAYABLE + sourceType trên). */
export const PROFIT_DISTRIBUTION_DEBT_TYPE = "PROFIT_DISTRIBUTION";

/** Tiền tố mã phiếu chia lợi nhuận: CLN-<yyyymm>-<số>. */
export const PROFIT_DISTRIBUTION_CODE_PREFIX = "CLN";

export function isProfitDistributionDebt(sourceType: string | null | undefined) {
  return (sourceType || "").trim().toUpperCase() === PROFIT_DISTRIBUTION_SOURCE;
}
