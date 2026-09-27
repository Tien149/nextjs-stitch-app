/**
 * Giá vốn bình quân TOÀN HỆ THỐNG của từng mặt hàng — gộp từ số dư của mọi kho, dùng cho cost
 * định lượng (Sheet tổng hợp giá vốn & giá thành) và nút "Tính giá vốn & giá thành".
 *
 * Chỉ bình quân gia quyền trên các kho đang tồn DƯƠNG. Kho tồn âm (xuất âm khi rã BOM, khách
 * chốt 22/09/2026) không được cộng vào: trị giá âm gần bằng trị giá dương thì tổng tồn còn rất
 * nhỏ, chia ra đơn giá vọt gấp chục lần — 1.000 gr x 100 đ cộng -990 gr x 90 đ ra 1.090 đ/gr,
 * món cánh gà lên cost 344% giá bán (khách báo 27/09/2026).
 *
 * Mọi kho đều âm / bằng 0 thì bình quân theo độ lớn tồn của các kho có giá (trước đây lấy giá của
 * kho duyệt tới cuối, tuỳ thứ tự dữ liệu). Không kho nào có giá thì 0.
 */
export type BalanceForAverage = { itemId: string; quantity: number; averageCost: number };

const EPSILON = 0.000001;

export function averageCostByItem(balances: BalanceForAverage[]): Map<string, number> {
  const buckets = new Map<string, { positiveQuantity: number; positiveValue: number; weight: number; weightedCost: number }>();
  for (const balance of balances) {
    const bucket = buckets.get(balance.itemId) || { positiveQuantity: 0, positiveValue: 0, weight: 0, weightedCost: 0 };
    if (balance.quantity > EPSILON) {
      bucket.positiveQuantity += balance.quantity;
      bucket.positiveValue += balance.quantity * balance.averageCost;
    }
    if (balance.averageCost > 0) {
      // Kho tồn 0 mà còn giá vẫn góp (trọng số nhỏ) để mặt hàng vừa xuất hết không rơi về 0.
      const weight = Math.max(Math.abs(balance.quantity), EPSILON);
      bucket.weight += weight;
      bucket.weightedCost += weight * balance.averageCost;
    }
    buckets.set(balance.itemId, bucket);
  }
  const result = new Map<string, number>();
  for (const [itemId, bucket] of buckets) {
    const cost = bucket.positiveQuantity > EPSILON && bucket.positiveValue > 0
      ? bucket.positiveValue / bucket.positiveQuantity
      : bucket.weight > 0 ? bucket.weightedCost / bucket.weight : 0;
    result.set(itemId, cost);
  }
  return result;
}
