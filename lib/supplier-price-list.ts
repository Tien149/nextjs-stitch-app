/**
 * Bảng giá NCC (khách yêu cầu 03/10/2026): giá mua theo từng NCC, áp dụng trong một khoảng
 * ngày (thường là một tháng), import được từ Excel. Dùng để:
 * - tự điền đơn giá + thuế suất khi nhập báo giá cho yêu cầu mua;
 * - so sánh giá cùng mặt hàng giữa các NCC trong tháng;
 * - cảnh báo phiếu nhập mua có đơn giá lệch bảng giá đang hiệu lực.
 *
 * Ngày hiệu lực so theo NGÀY giờ Việt Nam (chuỗi YYYY-MM-DD), hai đầu đều tính. Nhiều bảng giá
 * cùng phủ một ngày thì: bảng riêng của cửa hàng thắng bảng chung, rồi bảng bắt đầu muộn hơn,
 * rồi bảng tạo sau — bảng giá mới giữa tháng tự đè bảng cũ mà không phải sửa ngày bảng cũ.
 *
 * Phần thuần (không đụng DB) để script kiểm thử dùng chung.
 */
import { vnDay } from "@/lib/recipe-validity";
import { parseVatRate } from "@/lib/inventory-vat";

export type PriceListLine = {
  itemId: string;
  unitCode: string;
  conversionRate: number;
  unitPrice: number;
  vatRate: number | null;
};

export type PriceListLike = {
  id: string;
  code: string;
  supplierCode: string;
  supplierName: string;
  branchCode: string | null;
  effectiveFrom: Date | string;
  effectiveTo: Date | string | null;
  createdAt?: Date | string;
  lines: PriceListLine[];
};

export type ActivePrice = PriceListLine & {
  priceListId: string;
  priceListCode: string;
  supplierCode: string;
  supplierName: string;
  branchCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Đơn giá trước thuế quy về ĐVT tồn kho. */
  stockUnitPrice: number;
};

/** Ngày (YYYY-MM-DD) → mốc 00:00 giờ Việt Nam để lưu DB. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00+07:00`);
}

export function lastDayOfMonth(month: string): string {
  const [year, monthIndex] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

export function priceListWindow(list: Pick<PriceListLike, "effectiveFrom" | "effectiveTo">): { from: string; to: string | null } {
  return { from: vnDay(list.effectiveFrom), to: list.effectiveTo ? vnDay(list.effectiveTo) : null };
}

export function priceListCovers(list: Pick<PriceListLike, "effectiveFrom" | "effectiveTo">, day: string): boolean {
  const window = priceListWindow(list);
  return window.from <= day && (!window.to || day <= window.to);
}

/** Bảng giá có ngày nào nằm trong tháng (YYYY-MM) không. */
export function priceListInMonth(list: Pick<PriceListLike, "effectiveFrom" | "effectiveTo">, month: string): boolean {
  const window = priceListWindow(list);
  return window.from <= lastDayOfMonth(month) && (!window.to || window.to >= `${month}-01`);
}

export type PriceListStatus = "ACTIVE" | "UPCOMING" | "EXPIRED";
export function priceListStatus(list: Pick<PriceListLike, "effectiveFrom" | "effectiveTo">, today: string): PriceListStatus {
  const window = priceListWindow(list);
  if (window.from > today) return "UPCOMING";
  if (window.to && window.to < today) return "EXPIRED";
  return "ACTIVE";
}

export const stockUnitPriceOf = (line: Pick<PriceListLine, "unitPrice" | "conversionRate">) =>
  line.unitPrice / (line.conversionRate > 0 ? line.conversionRate : 1);

/**
 * Giá đang hiệu lực tại một ngày, khoá `NCC|itemId`. `branchCode` = cửa hàng đang mua: chỉ lấy
 * bảng chung + bảng riêng của cửa hàng đó; bỏ trống / "ALL" thì xét mọi bảng.
 */
export function activePrices(
  lists: PriceListLike[],
  options: { day: string; branchCode?: string | null; supplierCode?: string | null },
): Map<string, ActivePrice> {
  const branch = options.branchCode && options.branchCode !== "ALL" ? options.branchCode.toUpperCase() : null;
  const supplier = options.supplierCode ? options.supplierCode.toUpperCase() : null;
  const candidates = lists
    .filter((list) => priceListCovers(list, options.day))
    .filter((list) => !supplier || list.supplierCode.toUpperCase() === supplier)
    .filter((list) => !branch || !list.branchCode || list.branchCode.toUpperCase() === branch)
    // Ưu tiên thấp → cao; bảng sau ghi đè bảng trước.
    .sort((a, b) =>
      Number(Boolean(a.branchCode)) - Number(Boolean(b.branchCode))
      || priceListWindow(a).from.localeCompare(priceListWindow(b).from)
      || new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
  const result = new Map<string, ActivePrice>();
  for (const list of candidates) {
    const window = priceListWindow(list);
    for (const line of list.lines) {
      result.set(`${list.supplierCode.toUpperCase()}|${line.itemId}`, {
        ...line,
        priceListId: list.id,
        priceListCode: list.code,
        supplierCode: list.supplierCode,
        supplierName: list.supplierName,
        branchCode: list.branchCode,
        effectiveFrom: window.from,
        effectiveTo: window.to,
        stockUnitPrice: stockUnitPriceOf(line),
      });
    }
  }
  return result;
}

/**
 * Lệch giá của một dòng nhập mua so với bảng giá (đều theo ĐVT tồn, trước thuế). Dưới 1 đ / ĐVT
 * hoặc dưới 0,5 % coi là khớp — đơn giá quy đổi ĐVT hay ra số lẻ.
 */
export function priceDeviation(actualStockUnitPrice: number, listStockUnitPrice: number) {
  const diff = actualStockUnitPrice - listStockUnitPrice;
  const ratio = listStockUnitPrice > 0 ? diff / listStockUnitPrice : null;
  const matched = Math.abs(diff) < 1 || (ratio !== null && Math.abs(ratio) < 0.005);
  return { diff, ratio, matched };
}

// ---------------------------------------------------------------------------------------------
// Import Excel
// ---------------------------------------------------------------------------------------------

/** Cột của file mẫu — một file có thể chứa nhiều NCC / nhiều tháng. */
export const PRICE_IMPORT_HEADERS = [
  "Mã NCC",
  "Tên NCC",
  "Tháng áp dụng",
  "Từ ngày",
  "Đến ngày",
  "Cửa hàng",
  "Mã hàng",
  "Tên hàng",
  "ĐVT",
  "Đơn giá trước thuế",
  "Thuế suất",
  "Ghi chú",
] as const;

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADER_KEYS: Record<string, string> = Object.fromEntries(PRICE_IMPORT_HEADERS.map((header) => [fold(header), header]));

/** Đổi khoá cột của một dòng Excel về đúng tên cột mẫu (bỏ dấu, hoa thường, khoảng trắng). */
export function normalizeImportRow(raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const header = HEADER_KEYS[fold(key)];
    if (header) row[header] = value;
  }
  return row;
}

/** Ngày từ ô Excel: số serial, Date, "dd/mm/yyyy", "yyyy-mm-dd". */
export function parseDay(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return vnDay(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    // Serial Excel: 1 = 1900-01-01 (có lỗi năm nhuận 1900 nên mốc là 1899-12-30).
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  match = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return null;
}

/** Tháng từ ô "Tháng áp dụng": "10/2026", "2026-10", "T10/2026", ngày bất kỳ trong tháng. */
export function parseMonth(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim().replace(/^t(h[aá]ng)?\s*/i, "");
  let match = text.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 12) return `${match[2]}-${match[1].padStart(2, "0")}`;
  match = text.match(/^(\d{4})-(\d{1,2})$/);
  if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return `${match[1]}-${match[2].padStart(2, "0")}`;
  const day = parseDay(value);
  return day ? day.slice(0, 7) : null;
}

export function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(/\s|đ|vnd/gi, "");
  if (!text) return null;
  // "1.234.567" / "1.234,5" kiểu Việt; "1234.5" kiểu máy.
  const normalized = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text) ? text.replace(/\./g, "").replace(",", ".") : text.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export type PriceImportItem = { id: string; code: string; name: string; unit: string; unitConversions?: Array<{ unitCode: string; conversionRate: number }> };

export type PriceImportGroup = {
  supplierCode: string;
  supplierName: string;
  branchCode: string | null;
  from: string;
  to: string | null;
  lines: Array<PriceListLine & { itemCode: string; itemName: string; note: string | null; row: number }>;
};

/**
 * Kiểm tra + gom các dòng file import thành từng bảng giá (NCC × cửa hàng × khoảng ngày).
 * Trả lỗi theo số dòng Excel (dòng tiêu đề là 1) để người dùng sửa đúng chỗ.
 */
export function buildPriceImport(
  rawRows: Array<Record<string, unknown>>,
  lookup: {
    suppliers: Map<string, string>;
    items: Map<string, PriceImportItem>;
    branches: Set<string>;
  },
): { groups: PriceImportGroup[]; errors: Array<{ row: number; message: string }> } {
  const errors: Array<{ row: number; message: string }> = [];
  const groups = new Map<string, PriceImportGroup>();
  rawRows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const row = normalizeImportRow(raw);
    const text = (header: string) => String(row[header] ?? "").trim();
    if (PRICE_IMPORT_HEADERS.every((header) => !text(header))) return;
    const fail = (message: string) => errors.push({ row: rowNumber, message });

    const supplierCode = text("Mã NCC").toUpperCase();
    const supplierName = lookup.suppliers.get(supplierCode);
    if (!supplierCode) return fail("Thiếu Mã NCC");
    if (!supplierName) return fail(`Mã NCC ${supplierCode} chưa có trong danh mục Đối tác`);

    const month = parseMonth(row["Tháng áp dụng"]);
    if (text("Tháng áp dụng") && !month) return fail(`Tháng áp dụng "${text("Tháng áp dụng")}" không đọc được (ghi dạng 10/2026)`);
    const from = parseDay(row["Từ ngày"]) || (month ? `${month}-01` : null);
    if (text("Từ ngày") && !parseDay(row["Từ ngày"])) return fail(`Từ ngày "${text("Từ ngày")}" không đọc được (ghi dạng dd/mm/yyyy)`);
    if (!from) return fail("Thiếu Tháng áp dụng hoặc Từ ngày");
    const to = parseDay(row["Đến ngày"]) || (month ? lastDayOfMonth(month) : null);
    if (text("Đến ngày") && !parseDay(row["Đến ngày"])) return fail(`Đến ngày "${text("Đến ngày")}" không đọc được (ghi dạng dd/mm/yyyy)`);
    if (to && to < from) return fail(`Đến ngày ${to} trước Từ ngày ${from}`);

    const branchCode = text("Cửa hàng").toUpperCase() || null;
    if (branchCode && !lookup.branches.has(branchCode)) return fail(`Cửa hàng ${branchCode} không có trong danh mục`);

    const itemCode = text("Mã hàng").toUpperCase();
    const item = lookup.items.get(itemCode);
    if (!itemCode) return fail("Thiếu Mã hàng");
    if (!item) return fail(`Mã hàng ${itemCode} không có trong danh mục Mặt hàng`);

    const unitText = text("ĐVT").toUpperCase();
    let unitCode = item.unit.toUpperCase();
    let conversionRate = 1;
    if (unitText && unitText !== unitCode) {
      const conversion = (item.unitConversions || []).find((candidate) => candidate.unitCode.toUpperCase() === unitText);
      if (!conversion) return fail(`ĐVT ${unitText} chưa khai quy đổi cho ${itemCode} (ĐVT tồn: ${item.unit})`);
      unitCode = conversion.unitCode.toUpperCase();
      conversionRate = conversion.conversionRate || 1;
    }

    const unitPrice = parseMoney(row["Đơn giá trước thuế"]);
    if (unitPrice === null || unitPrice < 0) return fail(`Đơn giá trước thuế "${text("Đơn giá trước thuế")}" không hợp lệ`);
    const vat = parseVatRate(row["Thuế suất"]);
    if (!vat.ok) return fail(`Thuế suất "${text("Thuế suất")}" không hợp lệ (KKKNT, 0%, 5%, 8%, 10%)`);

    const key = `${supplierCode}|${branchCode || ""}|${from}|${to || ""}`;
    const group = groups.get(key) || { supplierCode, supplierName, branchCode, from, to, lines: [] };
    if (group.lines.some((line) => line.itemId === item.id && line.unitCode === unitCode)) {
      return fail(`${itemCode} (${unitCode}) bị lặp trong cùng bảng giá ${supplierCode} ${from}`);
    }
    group.lines.push({ itemId: item.id, itemCode: item.code, itemName: item.name, unitCode, conversionRate, unitPrice, vatRate: vat.rate, note: text("Ghi chú") || null, row: rowNumber });
    groups.set(key, group);
  });
  return { groups: [...groups.values()], errors };
}
