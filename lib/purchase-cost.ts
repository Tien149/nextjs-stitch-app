/**
 * CHI PHÍ MUA HÀNG trên phiếu nhập mua (khách chốt 13/10/2026): vận chuyển, bốc xếp... tính vào
 * giá nhập kho, nhập một số cho cả phiếu rồi PHÂN BỔ theo trị giá (tiền hàng trước thuế) từng dòng.
 * Phiếu toàn hàng tặng 0 đ thì chia theo số lượng. Phần phân bổ làm tròn tới đồng, dòng có phần lẻ
 * lớn nhất nhận đồng dư để tổng đúng bằng số nhập. Chi phí cộng luôn vào công nợ NCC của phiếu.
 */

/** Phiếu nào nhận chi phí mua hàng. */
export const PURCHASE_COST_TYPES = new Set(["NHAP_MUA"]);

export function allocatePurchaseCost(cost: number, lines: Array<{ amount: number; quantity: number }>): number[] {
  const total = Math.round(Math.max(0, Number(cost) || 0));
  if (total <= 0 || lines.length === 0) return lines.map(() => 0);
  const byAmount = lines.map((line) => Math.max(0, Number(line.amount) || 0));
  const byQuantity = lines.map((line) => Math.max(0, Number(line.quantity) || 0));
  const weights = byAmount.some((value) => value > 0) ? byAmount : byQuantity.some((value) => value > 0) ? byQuantity : lines.map(() => 1);
  const sum = weights.reduce((acc, value) => acc + value, 0);
  const raw = weights.map((weight) => (total * weight) / sum);
  const shares = raw.map((value) => Math.floor(value));
  let remainder = total - shares.reduce((acc, value) => acc + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of order) {
    if (remainder <= 0) break;
    shares[index] += 1;
    remainder -= 1;
  }
  return shares;
}
