/**
 * Định dạng số cho màn hình.
 *
 * LUẬT: tiền và số lượng KHÔNG dùng chung một hàm.
 * - Tiền chỉ đọc tới đồng — khấu hao/phân bổ/giá vốn bình quân chia theo kỳ hoặc theo số
 *   lượng nên hay ra số lẻ, hiện nguyên số lẻ ra bảng thì không ai đối chiếu được.
 * - Số lượng thì ngược lại: mặt hàng nhiều ĐVT luôn có số lẻ (nhập theo thùng — tồn theo
 *   lon, định lượng có hao hụt %), làm tròn số lượng là BÁO SAI TỒN KHO (0,5 kg thành 1 kg).
 */

/** Số tiền — làm tròn tới đồng. */
export function money(value: number) {
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);
}

/**
 * Số lượng / tỷ lệ quy đổi — giữ tới 3 số lẻ, số tròn thì không đẻ ra ",000".
 * Bụi số thực (cộng trừ tồn kho để lại -1e-12) quy về 0, nếu không bảng hiện "-0".
 */
export function quantity(value: number) {
  const amount = value || 0;
  const cleaned = Math.abs(amount) < 0.0005 ? 0 : amount;
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(cleaned);
}

/**
 * Đơn giá — tròn tới đồng, TRỪ đơn giá theo ĐVT nhỏ.
 * Nguyên liệu tồn theo g/ml có giá vốn 0,35 đ/g; tròn đồng là hiện "0 đ" rồi người dùng
 * tưởng mất giá vốn. Dưới 100 đ thì giữ 2 số lẻ để còn đọc được.
 */
export function unitPrice(value: number) {
  const amount = value || 0;
  return Math.abs(amount) > 0 && Math.abs(amount) < 100
    ? new Intl.NumberFormat("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : money(amount);
}
