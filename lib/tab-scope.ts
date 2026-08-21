import { allowedMenuTabs, type DemoSession } from "@/lib/auth-demo";

/**
 * Ẩn tab ở giao diện là chưa đủ: gõ thẳng URL vẫn gọi được API. Các module dưới đây trả
 * toàn bộ dữ liệu trong một lần GET, nên phải bỏ đi những nhánh dữ liệu ngoài quyền
 * trước khi trả về.
 *
 * Mỗi tab khai báo những khoá dữ liệu mà nó cần; khoá không thuộc tab nào (danh mục dùng
 * chung như items, warehouses, departments) luôn được giữ để màn hình còn đổ được dropdown.
 */
const tabDataKeys: Record<string, Record<string, string[]>> = {
  "/finance-operations": {
    cashbook: ["openingAmount", "closingBalance", "cashbook", "moneyTransfers"],
    accruals: ["accruals"],
    closing: ["accountingPeriod", "checklist"],
  },
  "/procurement": {
    requests: ["requests"],
    quotes: ["requests"],
    orders: ["orders"],
  },
  "/inventory": {
    stock: ["balances", "stockSummary"],
    inbound: ["transactions", "stockMovements"],
    outbound: ["transactions", "stockMovements"],
    transfer: ["transactions"],
    items: ["items"],
    recipes: ["recipes", "costSummary"],
    production: ["recipes", "transactions", "pendingSales"],
    stocktake: ["stocktakes"],
    waste: ["transactions", "wasteReport"],
  },
  "/assets/operations": {
    depreciation: ["depreciations"],
    maintenance: ["maintenances"],
    damage: ["damageReports"],
    disposal: ["damageReports"],
  },
};

/** Giá trị rỗng cùng kiểu, để giao diện không vỡ khi một nhánh bị lược bỏ. */
function emptyLike(value: unknown) {
  if (Array.isArray(value)) return [];
  if (typeof value === "number") return 0;
  if (value && typeof value === "object") return {};
  return value;
}

export function scopePayloadByTab<T extends Record<string, unknown>>(
  session: DemoSession,
  menuHref: string,
  payload: T,
): T {
  const permitted = allowedMenuTabs(session, menuHref);
  if (!permitted) return payload;

  const map = tabDataKeys[menuHref];
  if (!map) return payload;

  const allowedKeys = new Set(permitted.flatMap((tab) => map[tab] || []));
  const scopedKeys = new Set(Object.values(map).flat());

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // Khoá dùng chung cho mọi tab thì giữ nguyên.
    result[key] = !scopedKeys.has(key) || allowedKeys.has(key) ? value : emptyLike(value);
  }
  return result as T;
}
