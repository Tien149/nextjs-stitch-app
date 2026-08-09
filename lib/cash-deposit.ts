/** Mệnh giá nhỏ nhất dùng khi lập bảng kê nộp tiền. */
export const cashDepositUnit = 1000;

/**
 * Làm tròn số thực nộp tới nghìn gần nhất: phần lẻ dưới 500 đ làm tròn xuống,
 * từ 500 đ trở lên làm tròn lên.
 */
export function roundCashDepositAmount(grossAmount: number) {
  if (!Number.isFinite(grossAmount) || grossAmount <= 0) return 0;
  return Math.round(grossAmount / cashDepositUnit) * cashDepositUnit;
}

/**
 * Chênh lệch ghi vào chi phí làm tròn.
 * - Dương: làm tròn xuống, ghi tăng chi phí.
 * - Âm: làm tròn lên, ghi giảm chi phí.
 */
export function cashDepositRoundingExpense(grossAmount: number) {
  return grossAmount - roundCashDepositAmount(grossAmount);
}
