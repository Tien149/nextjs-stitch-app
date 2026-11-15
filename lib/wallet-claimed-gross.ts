/**
 * Doanh thu ví một dòng sao kê (dòng phân bổ theo ngày) đã "nhận" — để lần quyết toán khác của
 * cùng ví + cùng ngày trừ ra trước khi tính phí.
 *
 * Gross = tiền về + phí nên không bao giờ nhỏ hơn tiền về. Dòng chưa tính gross (trống — Tách dòng
 * tiền về mà phiếu QTVI ghi "chưa có doanh thu ví") hoặc lưu 0 (nút "Vào sổ theo số thực về",
 * UNHO-8D6AM1F7E 24/10) thì ít nhất số tiền về của dòng đó đã là doanh thu ngày đó. Coi như 0 thì
 * phiếu khác cùng ngày ôm cả phần này thành phí (QTVI-2610-NME-00045 37,4tr; QTVI-2610-NME-00056
 * thừa 792.666 đ — khách báo 14–15/11/2026).
 */
export function claimedGrossOf(row: { grossAmount: number | null; creditAmount: number | null }) {
  return Math.max(0, row.grossAmount || 0, row.creditAmount || 0);
}
