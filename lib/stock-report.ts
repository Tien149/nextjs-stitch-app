/**
 * Báo cáo tab Tồn kho (khách yêu cầu 03/10/2026, theo note "Update 17/06/26"):
 * - Nhập - Xuất - Tồn có cả SL lẫn TRỊ GIÁ, xem theo cửa hàng (gộp mọi kho) hoặc theo từng kho
 *   (tách nhập / xuất theo loại giao dịch).
 * - Báo cáo tổng hợp / chi tiết nhập, tổng hợp / chi tiết xuất dựng từ nhật ký từng dòng phiếu.
 *
 * Hàm thuần — màn hình và script kiểm thử dùng chung.
 */

export type QtyValue = { quantity: number; value: number };

export type TypeTotals = { inbound: number; outbound: number; inboundValue: number; outboundValue: number };

export type StockSummaryInput = {
  item: { id: string; code: string; name: string; unit: string; itemType?: string; goodsGroup?: string | null };
  warehouseCode: string;
  openingQuantity: number; openingValue?: number;
  inboundQuantity: number; inboundValue?: number;
  outboundQuantity: number; outboundValue?: number;
  closingQuantity: number; closingValue: number;
  averageCost: number;
  movementByType?: Record<string, Partial<TypeTotals>>;
};

export type MovementInput = {
  transactionId: string; code: string; transactionType: string; subType?: string | null; transactionDate: string;
  branchCode?: string; warehouseCode: string; counterpartWarehouseCode?: string | null;
  itemCode: string; itemName: string; unit: string; itemType?: string; goodsGroup?: string | null;
  inboundQuantity: number; outboundQuantity: number; unitCost?: number; value: number;
  referenceCode: string | null; partnerCode?: string | null; partnerName?: string | null; note?: string | null;
};

export type Direction = "IN" | "OUT";

/** Cột nhập / xuất theo loại của bảng "theo từng kho" — thứ tự cột như form khách. */
export const IN_CATEGORIES = [
  { key: "purchase", label: "Nhập mua", types: ["NHAP_MUA"] },
  { key: "transfer", label: "Nhập điều chuyển", types: ["NHAP_DIEU_CHUYEN"] },
  { key: "production", label: "Nhập chế biến", types: ["NHAP_CHE_BIEN"] },
  { key: "stocktake", label: "Nhập kiểm kê", types: ["NHAP_KIEM_KE"] },
  { key: "other", label: "Nhập khác", types: [] as string[] },
] as const;

export const OUT_CATEGORIES = [
  { key: "sale", label: "Xuất bán", types: ["XUAT_BAN"] },
  { key: "transfer", label: "Xuất điều chuyển", types: ["XUAT_DIEU_CHUYEN"] },
  { key: "production", label: "Xuất chế biến", types: ["XUAT_CHE_BIEN"] },
  { key: "waste", label: "Xuất hủy", types: ["XUAT_HUY"] },
  { key: "stocktake", label: "Xuất kiểm kê", types: ["XUAT_KIEM_KE"] },
  { key: "other", label: "Xuất khác", types: [] as string[] },
] as const;

/** Loại để lọc báo cáo nhập / xuất — điều chuyển đã tách hai vế. */
export const IN_TYPES = ["NHAP_MUA", "NHAP_DIEU_CHUYEN", "NHAP_CHE_BIEN", "NHAP_KIEM_KE", "NHAP_KHAC"];
export const OUT_TYPES = ["XUAT_BAN", "XUAT_DIEU_CHUYEN", "XUAT_CHE_BIEN", "XUAT_HUY", "XUAT_TEST_MON", "XUAT_KHAC", "XUAT_KIEM_KE"];

export function categoryKey(direction: Direction, type: string): string {
  const list = direction === "IN" ? IN_CATEGORIES : OUT_CATEGORIES;
  return (list.find((category) => (category.types as readonly string[]).includes(type)) || list[list.length - 1]).key;
}

/** Chiều + loại của một dòng nhật ký; điều chuyển quy về NHAP_/XUAT_DIEU_CHUYEN theo vế. */
export function movementDirection(row: Pick<MovementInput, "transactionType" | "inboundQuantity" | "outboundQuantity">): { direction: Direction; type: string } {
  const direction: Direction = row.transactionType.startsWith("NHAP_") || (row.transactionType === "DIEU_CHUYEN" && row.inboundQuantity > 0) ? "IN" : "OUT";
  const type = row.transactionType === "DIEU_CHUYEN" ? (direction === "IN" ? "NHAP_DIEU_CHUYEN" : "XUAT_DIEU_CHUYEN") : row.transactionType;
  return { direction, type };
}

export type NxtRow = {
  key: string;
  branchCode: string;
  /** "" ở bảng theo cửa hàng (đã gộp mọi kho). */
  warehouseCode: string;
  item: StockSummaryInput["item"];
  opening: QtyValue;
  inbound: QtyValue;
  outbound: QtyValue;
  closing: QtyValue;
  /** "IN:purchase", "OUT:sale"... */
  byCategory: Record<string, QtyValue>;
};

const zero = (): QtyValue => ({ quantity: 0, value: 0 });
const add = (target: QtyValue, quantity: number, value: number) => { target.quantity += quantity || 0; target.value += value || 0; };

export function toNxtRow(row: StockSummaryInput, branchCode: string): NxtRow {
  const byCategory: Record<string, QtyValue> = {};
  for (const [type, totals] of Object.entries(row.movementByType || {})) {
    // Bản cũ của API gộp hai vế điều chuyển vào "DIEU_CHUYEN" — tách lại theo vế.
    const inType = type === "DIEU_CHUYEN" ? "NHAP_DIEU_CHUYEN" : type;
    const outType = type === "DIEU_CHUYEN" ? "XUAT_DIEU_CHUYEN" : type;
    if (totals.inbound || totals.inboundValue) add(byCategory[`IN:${categoryKey("IN", inType)}`] ||= zero(), totals.inbound || 0, totals.inboundValue || 0);
    if (totals.outbound || totals.outboundValue) add(byCategory[`OUT:${categoryKey("OUT", outType)}`] ||= zero(), totals.outbound || 0, totals.outboundValue || 0);
  }
  const closingValue = row.closingValue;
  const inboundValue = row.inboundValue ?? 0;
  const outboundValue = row.outboundValue ?? 0;
  return {
    key: `${row.warehouseCode}|${row.item.id}`,
    branchCode,
    warehouseCode: row.warehouseCode,
    item: row.item,
    opening: { quantity: row.openingQuantity, value: row.openingValue ?? closingValue - inboundValue + outboundValue },
    inbound: { quantity: row.inboundQuantity, value: inboundValue },
    outbound: { quantity: row.outboundQuantity, value: outboundValue },
    closing: { quantity: row.closingQuantity, value: closingValue },
    byCategory,
  };
}

/** Gộp các kho của cùng cửa hàng thành một dòng mỗi mặt hàng. */
export function aggregateNxtByStore(rows: NxtRow[]): NxtRow[] {
  const grouped = new Map<string, NxtRow>();
  for (const row of rows) {
    const key = `${row.branchCode}|${row.item.id}`;
    const target = grouped.get(key) || { key, branchCode: row.branchCode, warehouseCode: "", item: row.item, opening: zero(), inbound: zero(), outbound: zero(), closing: zero(), byCategory: {} };
    for (const field of ["opening", "inbound", "outbound", "closing"] as const) add(target[field], row[field].quantity, row[field].value);
    for (const [category, totals] of Object.entries(row.byCategory)) add(target.byCategory[category] ||= zero(), totals.quantity, totals.value);
    grouped.set(key, target);
  }
  return [...grouped.values()];
}

const DUST = 0.0005;
/** Không tồn, không phát sinh cả SL lẫn trị giá (còn lẻ < 1 đ do làm tròn thì cũng coi là trống). */
export function isEmptyNxtRow(row: NxtRow): boolean {
  return [row.opening, row.inbound, row.outbound, row.closing].every((part) => Math.abs(part.quantity) < DUST && Math.abs(part.value) < 1);
}

/** Theo nhóm hàng hóa (chưa gán nhóm xuống cuối), rồi mã hàng, rồi cửa hàng / kho. */
export function sortNxtRows(rows: NxtRow[]): NxtRow[] {
  return [...rows].sort((a, b) =>
    Number(!a.item.goodsGroup) - Number(!b.item.goodsGroup)
    || (a.item.goodsGroup || "").localeCompare(b.item.goodsGroup || "", "vi")
    || a.item.code.localeCompare(b.item.code)
    || a.branchCode.localeCompare(b.branchCode)
    || a.warehouseCode.localeCompare(b.warehouseCode));
}

export type MovementSummaryBy = "item" | "type" | "warehouse" | "partner";

export type MovementSummaryRow = {
  key: string;
  label: string;
  /** Cột phụ: tên hàng / tên NCC / tên kho... */
  detail: string;
  goodsGroup: string;
  unit: string;
  quantity: number;
  value: number;
  documentCount: number;
  lineCount: number;
};

/**
 * Tổng hợp nhập / xuất. Gom theo mặt hàng thì có SL + đơn giá bình quân; gom theo loại / kho /
 * NCC thì SL các mặt hàng khác ĐVT không cộng được nên chỉ có trị giá, số phiếu, số dòng.
 */
export function summarizeMovements(
  rows: MovementInput[],
  by: MovementSummaryBy,
  labels: { type: (type: string) => string; warehouse: (code: string) => string },
): MovementSummaryRow[] {
  const grouped = new Map<string, MovementSummaryRow & { documents: Set<string> }>();
  for (const row of rows) {
    const { type } = movementDirection(row);
    const quantity = row.inboundQuantity || row.outboundQuantity;
    let key: string; let label: string; let detail = ""; let goodsGroup = ""; let unit = "";
    if (by === "item") { key = row.itemCode.toUpperCase(); label = row.itemCode; detail = row.itemName; goodsGroup = row.goodsGroup || ""; unit = row.unit; }
    else if (by === "type") { key = type; label = labels.type(type); }
    else if (by === "warehouse") { key = row.warehouseCode; label = row.warehouseCode; detail = labels.warehouse(row.warehouseCode); }
    else { key = (row.partnerCode || "").toUpperCase(); label = row.partnerCode || "(Không có NCC)"; detail = row.partnerName || ""; }
    const target = grouped.get(key) || { key, label, detail, goodsGroup, unit, quantity: 0, value: 0, documentCount: 0, lineCount: 0, documents: new Set<string>() };
    target.quantity += quantity;
    target.value += row.value || 0;
    target.lineCount += 1;
    target.documents.add(row.transactionId);
    grouped.set(key, target);
  }
  return [...grouped.values()]
    .map(({ documents, ...row }) => ({ ...row, documentCount: documents.size }))
    .sort((a, b) => by === "item"
      ? Number(!a.goodsGroup) - Number(!b.goodsGroup) || a.goodsGroup.localeCompare(b.goodsGroup, "vi") || a.label.localeCompare(b.label)
      : b.value - a.value || a.label.localeCompare(b.label));
}

/** Bỏ dấu + chữ thường để ô tìm gõ "tra dao" vẫn ra "Trà Đào". */
export function foldSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}
