/**
 * Kiểm kê theo VỊ TRÍ + duyệt GỘP (khách chốt 28/09/2026) — phần tính thuần, không đụng DB, để
 * test bằng node --test. Phần đọc/ghi DB ở lib/stocktake-batch.ts.
 *
 * - Một kho có nhiều vị trí (tủ đông, tủ mát, kệ khô...), cùng một mã có thể nằm ở nhiều vị trí.
 *   Mỗi phiếu đếm chỉ ghi SỐ ĐẾM của một vị trí, không tự so sổ sách.
 * - Kế toán chọn nhiều phiếu của cùng kho rồi duyệt một lần: số đếm của mỗi mã = TỔNG các vị
 *   trí; so với sổ sách TẠI GIỜ CHỐT. Mã có sổ sách mà không nằm trên phiếu nào = đếm 0.
 * - Nguyên liệu, bao bì, hàng hóa, đồng phục (CCDC / tài sản kiểm ở phân hệ Tài sản).
 */

const EPSILON = 0.000001;

/** Nhóm mặt hàng đếm theo vị trí và được duyệt gộp. */
export const LOCATION_STOCKTAKE_ITEM_TYPES = ["RAW_MATERIAL", "PACKAGING", "GOODS", "UNIFORM"] as const;

export function isLocationStocktakeItemType(itemType: unknown) {
  const normalized = String(itemType || "").trim().toUpperCase();
  return (LOCATION_STOCKTAKE_ITEM_TYPES as readonly string[]).includes(normalized);
}

export type UnitOption = { unitCode: string; conversionRate: number };
export type UnitInput = { unitCode: string; quantity: number; conversionRate: number };

/**
 * Số đếm nhiều ĐVT cùng lúc (2 thùng + 3 chai + 250 gr) -> quy về ĐVT tồn. Hệ số lấy từ danh mục
 * quy đổi của mặt hàng (`options`), KHÔNG tin hệ số gửi lên. ĐVT lạ hoặc số âm thì báo lỗi.
 */
export function resolveUnitInputs(
  baseUnit: string,
  options: UnitOption[],
  inputs: Array<{ unitCode?: unknown; quantity?: unknown }>,
): { inputs: UnitInput[]; baseQuantity: number; error?: string } {
  const rateOf = new Map<string, number>([[baseUnit.trim().toUpperCase(), 1]]);
  for (const option of options) {
    const code = option.unitCode.trim().toUpperCase();
    if (!code || rateOf.has(code)) continue;
    if (option.conversionRate > 0) rateOf.set(code, option.conversionRate);
  }
  const merged = new Map<string, UnitInput>();
  for (const raw of inputs) {
    const unitCode = String(raw.unitCode ?? "").trim().toUpperCase() || baseUnit.trim().toUpperCase();
    const text = String(raw.quantity ?? "").trim();
    if (text === "") continue;
    const quantity = Number(text.replace(",", "."));
    if (!Number.isFinite(quantity)) return { inputs: [], baseQuantity: 0, error: `Số đếm [${text}] không phải là số` };
    if (quantity < 0) return { inputs: [], baseQuantity: 0, error: "Số đếm không được âm" };
    const conversionRate = rateOf.get(unitCode);
    if (!conversionRate) return { inputs: [], baseQuantity: 0, error: `ĐVT [${unitCode}] chưa khai quy đổi` };
    const current = merged.get(unitCode) || { unitCode, quantity: 0, conversionRate };
    current.quantity += quantity;
    merged.set(unitCode, current);
  }
  const list = [...merged.values()];
  const baseQuantity = list.reduce((sum, input) => sum + input.quantity * input.conversionRate, 0);
  return { inputs: list, baseQuantity: Math.round(baseQuantity * 1e6) / 1e6 };
}

export type SheetLine = { itemId: string; actualQuantity: number; unitCost?: number | null };
export type Sheet = { code: string; locationCode: string; lines: SheetLine[] };
export type BookRow = { itemId: string; quantity: number; averageCost: number };

export type ConsolidatedRow = {
  itemId: string;
  /** Số đếm theo từng vị trí (ĐVT tồn). Hai phiếu cùng vị trí thì cộng dồn. */
  breakdown: Record<string, number>;
  countedQuantity: number;
  bookQuantity: number;
  varianceQuantity: number;
  averageCost: number;
  /** Đơn giá nhà hàng khai trên phiếu (lớn nhất) — dùng cho phần thừa của hàng chưa có giá. */
  declaredUnitCost: number;
  /** Có sổ sách nhưng không nằm trên phiếu đếm nào -> đếm 0. */
  notCounted: boolean;
};

/**
 * Gộp các phiếu đếm của MỘT kho với sổ sách tại giờ chốt. `book` chỉ cần chứa mã thuộc phạm vi
 * kiểm (nguyên liệu, bao bì) — người gọi lọc trước. Mã sổ sách = 0 mà không ai đếm thì bỏ.
 */
export function consolidateStocktake(sheets: Sheet[], book: BookRow[]): ConsolidatedRow[] {
  const rows = new Map<string, ConsolidatedRow>();
  const rowOf = (itemId: string) => {
    let row = rows.get(itemId);
    if (!row) {
      row = { itemId, breakdown: {}, countedQuantity: 0, bookQuantity: 0, varianceQuantity: 0, averageCost: 0, declaredUnitCost: 0, notCounted: true };
      rows.set(itemId, row);
    }
    return row;
  };
  for (const sheet of sheets) {
    for (const line of sheet.lines) {
      const row = rowOf(line.itemId);
      row.notCounted = false;
      row.breakdown[sheet.locationCode] = (row.breakdown[sheet.locationCode] || 0) + line.actualQuantity;
      row.countedQuantity += line.actualQuantity;
      if ((line.unitCost || 0) > row.declaredUnitCost) row.declaredUnitCost = line.unitCost || 0;
    }
  }
  for (const entry of book) {
    if (!rows.has(entry.itemId) && Math.abs(entry.quantity) <= EPSILON) continue;
    const row = rowOf(entry.itemId);
    row.bookQuantity += entry.quantity;
    row.averageCost = entry.averageCost;
  }
  for (const row of rows.values()) {
    row.countedQuantity = Math.round(row.countedQuantity * 1e6) / 1e6;
    row.bookQuantity = Math.round(row.bookQuantity * 1e6) / 1e6;
    row.varianceQuantity = Math.round((row.countedQuantity - row.bookQuantity) * 1e6) / 1e6;
  }
  return [...rows.values()];
}

export function hasVariance(row: { varianceQuantity: number }) {
  return Math.abs(row.varianceQuantity) > EPSILON;
}

/**
 * Sổ sách tại giờ chốt = tồn HIỆN TẠI − phát sinh ròng có ngày chứng từ SAU giờ chốt (cùng cách
 * bảng Nhập - Xuất - Tồn lùi tồn cuối kỳ). `laterNet` là Σ(nhập − xuất) sau giờ chốt theo mã.
 */
export function bookAtCutoff(current: BookRow[], laterNet: Map<string, number>): BookRow[] {
  const result = new Map<string, BookRow>();
  for (const row of current) result.set(row.itemId, { ...row, quantity: row.quantity - (laterNet.get(row.itemId) || 0) });
  for (const [itemId, net] of laterNet) {
    if (!result.has(itemId)) result.set(itemId, { itemId, quantity: -net, averageCost: 0 });
  }
  return [...result.values()];
}
