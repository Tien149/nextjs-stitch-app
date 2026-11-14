/**
 * Doanh thu ví một dòng sao kê (dòng phân bổ theo ngày) đã "nhận" — để lần quyết toán khác của
 * cùng ví + cùng ngày trừ ra trước khi tính phí.
 *
 * Có gross thì lấy gross. Chưa có (dòng Tách dòng tiền về mà phiếu QTVI ghi "chưa có doanh thu
 * ví", phí 0) thì ít nhất số tiền về của dòng đó đã là doanh thu ngày đó: coi như 0 thì phiếu về
 * lẻ cùng ngày ôm cả phần này thành phí (QTVI-2610-NME-00045, 37,4tr — khách báo 14/11/2026).
 */
export function claimedGrossOf(row: { grossAmount: number | null; creditAmount: number | null }) {
  if (row.grossAmount !== null && row.grossAmount !== undefined) return Math.max(0, row.grossAmount);
  return Math.max(0, row.creditAmount || 0);
}
