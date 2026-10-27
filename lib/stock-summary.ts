/**
 * Bảng Nhập - Xuất - Tồn theo kỳ (tab Tồn kho) — dựng từ số dư hiện tại + tổng phát sinh theo kho.
 *
 * SỐ LƯỢNG: tồn đầu kỳ / cuối kỳ lùi từ tồn HIỆN TẠI bằng phát sinh sau mốc tương ứng.
 *
 * TRỊ GIÁ: cộng ĐI TỚI theo chứng từ (khách 27/10/2026): trị giá đầu kỳ = số dư đầu kỳ đã khai +
 * trị giá các phiếu trước ngày bắt đầu kỳ. Trước đây trị giá cũng lùi từ SL × giá bình quân hiện tại;
 * kho tồn âm thì phiếu xuất ghi theo giá lúc xuất còn giá bình quân đã khác, phần chênh dồn hết về
 * đầu kỳ sớm nhất — ASA tháng 7 chưa có phát sinh mà đầu kỳ ra −1 triệu ở Bếp. Đi tới thì tháng chưa
 * có phát sinh luôn ra 0, vẫn khớp đầu kỳ + nhập − xuất = cuối kỳ, cuối kỳ khớp giá vốn đã ghi sổ;
 * đổi lại mã đang tồn âm có cuối kỳ lệch chút ít với SL × giá bình quân ở tab Tồn real time.
 *
 * Phần số lượng không có phiếu lẫn đầu kỳ nào giải thích được (dữ liệu cũ) coi như có từ trước mọi
 * kỳ, định giá theo giá bình quân hiện tại — cùng luật với phần số lượng lùi.
 *
 * `movementByType` tách theo loại phiếu; điều chuyển tách hai vế NHAP_DIEU_CHUYEN (kho nhận) /
 * XUAT_DIEU_CHUYEN (kho đi) cho các cột "Nhập/Xuất điều chuyển" của bảng theo từng kho.
 */

export type MovementTotalRow = {
  itemId: string; warehouseCode: string; transactionType: string; side: string;
  /** Phát sinh TRONG kỳ. */
  quantity: number; value: number;
  /** Phát sinh từ đầu kỳ trở đi (để lùi tồn hiện tại về tồn đầu kỳ). */
  afterFromQuantity: number; afterFromValue: number;
  /** Phát sinh sau cuối kỳ (để lùi tồn hiện tại về tồn cuối kỳ). */
  afterToQuantity: number; afterToValue: number;
  /** Toàn bộ phát sinh, không lọc ngày (trị giá đi tới = toàn bộ − từ mốc trở đi). */
  totalQuantity: number; totalValue: number;
};

/** Số dư đầu kỳ tồn kho đã khai (OpeningBalance INVENTORY đã xác nhận) cộng theo mặt hàng × kho. */
export type OpeningInventoryTotal = { itemId: string; warehouseCode: string; quantity: number; value: number };

export function buildStockSummary<TBalance extends { itemId: string; warehouseCode: string; quantity: number; averageCost: number }>(
  balances: TBalance[],
  movementTotals: MovementTotalRow[],
  openings: OpeningInventoryTotal[] = [],
) {
  type TypeBucket = { inbound: number; outbound: number; inboundValue: number; outboundValue: number };
  type Bucket = {
    inbound: number; outbound: number; inboundValue: number; outboundValue: number;
    netAfterFrom: number; netAfterTo: number; valueAfterFrom: number; valueAfterTo: number;
    netTotal: number; valueTotal: number;
    byType: Record<string, TypeBucket>;
  };
  const empty = (): Bucket => ({ inbound: 0, outbound: 0, inboundValue: 0, outboundValue: 0, netAfterFrom: 0, netAfterTo: 0, valueAfterFrom: 0, valueAfterTo: 0, netTotal: 0, valueTotal: 0, byType: {} });
  const movements = new Map<string, Bucket>();
  for (const row of movementTotals) {
    const key = `${row.itemId}|${row.warehouseCode}`;
    const bucket = movements.get(key) || empty();
    const sign = row.side === "FROM" && !row.transactionType.startsWith("NHAP_") ? -1 : 1;
    if (sign > 0) { bucket.inbound += row.quantity; bucket.inboundValue += row.value; }
    else { bucket.outbound += row.quantity; bucket.outboundValue += row.value; }
    bucket.netAfterFrom += sign * row.afterFromQuantity;
    bucket.netAfterTo += sign * row.afterToQuantity;
    bucket.valueAfterFrom += sign * row.afterFromValue;
    bucket.valueAfterTo += sign * row.afterToValue;
    bucket.netTotal += sign * (row.totalQuantity || 0);
    bucket.valueTotal += sign * (row.totalValue || 0);
    if (row.quantity || row.value) {
      const type = row.transactionType === "DIEU_CHUYEN" ? (sign > 0 ? "NHAP_DIEU_CHUYEN" : "XUAT_DIEU_CHUYEN") : row.transactionType;
      const typeBucket = bucket.byType[type] ||= { inbound: 0, outbound: 0, inboundValue: 0, outboundValue: 0 };
      if (sign > 0) { typeBucket.inbound += row.quantity; typeBucket.inboundValue += row.value; }
      else { typeBucket.outbound += row.quantity; typeBucket.outboundValue += row.value; }
    }
    movements.set(key, bucket);
  }
  const openingByKey = new Map<string, { quantity: number; value: number }>();
  for (const row of openings) {
    const key = `${row.itemId}|${row.warehouseCode}`;
    const current = openingByKey.get(key) || { quantity: 0, value: 0 };
    openingByKey.set(key, { quantity: current.quantity + row.quantity, value: current.value + row.value });
  }
  return balances.map((balance) => {
    const key = `${balance.itemId}|${balance.warehouseCode}`;
    const movement = movements.get(key) || empty();
    const declared = openingByKey.get(key) || { quantity: 0, value: 0 };
    const openingQuantity = balance.quantity - movement.netAfterFrom;
    const closingQuantity = balance.quantity - movement.netAfterTo;
    // Gốc trước mọi phiếu = đầu kỳ đã khai + phần số lượng không phiếu nào giải thích (theo giá BQ).
    const unexplained = balance.quantity - movement.netTotal - declared.quantity;
    const baseValue = declared.value + (Math.abs(unexplained) > 0.0005 ? unexplained * balance.averageCost : 0);
    // Hết hàng mà còn lẻ dưới 10 đ (làm tròn trị giá từng phiếu) thì coi là 0. Lệch lớn hơn là phiếu
    // xuất định giá khác giá bình quân (điều chuyển theo giá mua gần nhất...) — giữ nguyên để hàng
    // vẫn khớp Đầu kỳ + Nhập − Xuất = Cuối kỳ.
    const valueAt = (quantity: number, value: number) => (Math.abs(quantity) < 0.0005 && Math.abs(value) < 10 ? 0 : value);
    return {
      item: (balance as unknown as { item: unknown }).item,
      warehouseCode: balance.warehouseCode,
      openingQuantity,
      openingValue: valueAt(openingQuantity, baseValue + movement.valueTotal - movement.valueAfterFrom),
      inboundQuantity: movement.inbound,
      inboundValue: movement.inboundValue,
      outboundQuantity: movement.outbound,
      outboundValue: movement.outboundValue,
      closingQuantity,
      closingValue: valueAt(closingQuantity, baseValue + movement.valueTotal - movement.valueAfterTo),
      averageCost: balance.averageCost,
      movementByType: movement.byType,
    };
  });
}
