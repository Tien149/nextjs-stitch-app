export type MoneyTransferDateRow = {
  transferDate: Date;
  actualTransferDate?: Date | null;
  transferPurpose?: string | null;
};

/**
 * NGÀY GHI SỔ của phiếu điều tiền: luôn là NGÀY CHỨNG TỪ của phiếu.
 *
 * Trước 21/09/2026 riêng phiếu NỘP TIỀN MẶT ghi theo `actualTransferDate` — ngày kế toán khai
 * lúc duyệt. Thực tế lúc duyệt kế toán nhập MỘT ngày cho cả lô phiếu đang tick, nên phiếu của
 * ca ngày 2/8 duyệt ngày 8/8 bị đẩy hẳn sang 8/8: sổ quỹ thu ngân ngày 2/8 không trừ dù ca đó
 * đã nộp tiền, và ngày 8/8 lại gánh tiền của nhiều ngày khác nhau (khách báo 21/09/2026).
 *
 * Chị Bình chốt: cuối ca là tiền coi như đã rời quỹ thu ngân, sổ quỹ trừ ngay ngày chứng từ.
 * `actualTransferDate` giữ lại để đối chiếu "tiền thật sự tới tay ai, ngày nào", không còn
 * quyết định ngày ghi sổ nữa.
 */
export function effectiveMoneyTransferDate(row: MoneyTransferDateRow) {
  return row.transferDate;
}

export function effectiveMoneyTransferDateFilter(start: Date, end: Date) {
  return { transferDate: { gte: start, lt: end } };
}
