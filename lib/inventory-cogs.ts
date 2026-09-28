import { REVENUE_DEPARTMENT_CODES, departmentFromWarehouseGroup } from "@/lib/revenue-department";

/**
 * GIÁ VỐN THEO KHO (chị Bình chốt 27/09/2026). Áp dụng từ kỳ 2026-08 = ngày hệ thống lên chạy
 * (01/08/2026) — ban đầu chốt 2026-09, khách dời về 08 ngày 28/09/2026 để tháng 8 cũng có COGS
 * Bếp/Bar theo kho. Kỳ 08 phải Ghi sổ lại để phiếu chi mua chuyển từ 632 sang 152.
 *
 * Từ kỳ này P&L không lấy giá vốn từ tiền mua nữa mà từ HÀNG RỜI KHỎI KHO:
 *   COGS = xuất bán + xuất hủy + xuất test món + xuất khác + chênh kiểm kê (thiếu − thừa).
 * - KHÔNG cộng xuất chế biến: nguyên liệu chế biến thành bán thành phẩm / món vẫn là hàng trong
 *   kho (Có 152 rồi Nợ 152); giá trị đó ra khỏi kho ở phiếu XUẤT BÁN của món. Cộng cả hai là
 *   tính trùng bán thành phẩm.
 * - Tách COGS Bếp / COGS Bar theo NHÓM KHO bị trừ (luật chung: bộ phận theo kho đã trừ, không
 *   suy theo mã hàng). Kho không thuộc bếp/bar vào dòng COGS kho chung.
 * - Bao bì xuất hủy / chênh kiểm kê / xuất lẻ -> chi phí vật tư tiêu hao CPBD_VTTH (6428), không
 *   vào COGS. Bao bì nằm trong định lượng món thì đã chảy vào giá trị món lúc rã nên theo món.
 *
 * Đi kèm: từ kỳ này phiếu chi / công nợ / điều chỉnh quỹ thuộc nhóm Giá vốn ghi Nợ 152 (mua
 * hàng nhập kho) thay vì Nợ 632 — không thì giá vốn bị tính hai lần (lúc mua + lúc xuất).
 * Phần tính thuần ở đây để test bằng node --test; ghi sổ ở syncAccountingPeriod (lib/accounting.ts).
 */

/** Kỳ đầu tiên áp dụng giá vốn theo kho. Kỳ trước đó giữ nguyên cách cũ (phiếu chi mua -> 632). */
export const INVENTORY_COGS_START_PERIOD = "2026-08";
/** 00:00 ngày 01/08/2026 giờ Việt Nam. */
export const INVENTORY_COGS_START_DATE = new Date("2026-08-01T00:00:00+07:00");

export function inventoryCogsActive(date: Date | string) {
  const value = date instanceof Date ? date : new Date(date);
  return value.getTime() >= INVENTORY_COGS_START_DATE.getTime();
}

/** Tài khoản Nợ của khoản CHI thuộc nhóm Giá vốn: 152 từ kỳ giá vốn theo kho, 632 trước đó. */
export function cogsPurchaseAccount(date: Date | string) {
  return inventoryCogsActive(date) ? "152" : "632";
}

export const INVENTORY_COGS_PNL_ITEMS = {
  KITCHEN: { code: "COGS_BEP", name: "COGS Bếp" },
  BAR: { code: "COGS_BAR", name: "COGS Bar" },
  OTHER: { code: "COGS_KHAC", name: "COGS kho chung (không thuộc bếp/bar)" },
} as const;
export const PACKAGING_EXPENSE_PNL_ITEM = { code: "CPBD_VTTH", name: "Chi phí vật tư tiêu hao" } as const;

/** Phiếu kho làm hàng RỜI hệ thống kho (hoặc quay lại, với kiểm kê thừa). */
export const COGS_OUTBOUND_TYPES = ["XUAT_BAN", "XUAT_HUY", "XUAT_TEST_MON", "XUAT_KHAC", "XUAT_KIEM_KE"] as const;
export const COGS_INBOUND_TYPES = ["NHAP_KIEM_KE"] as const;
export const COGS_STOCK_TYPES = [...COGS_OUTBOUND_TYPES, ...COGS_INBOUND_TYPES] as readonly string[];

export type CogsJournalLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  pnlItemCode?: string | null;
  departmentCode?: string | null;
};

/**
 * Bút toán giá vốn của MỘT phiếu kho: gom dòng theo (tài khoản, hạng mục P&L), vế đối ứng 152.
 * Trả [] khi phiếu không thuộc loại tính giá vốn hoặc tổng giá trị = 0 (xuất âm chưa có giá).
 */
export function planInventoryCogsJournal(input: {
  transactionType: string;
  warehouseGroup: string | null | undefined;
  lines: Array<{ totalCost: number; itemType: string | null | undefined }>;
}): CogsJournalLine[] {
  const type = input.transactionType.toUpperCase();
  const inbound = (COGS_INBOUND_TYPES as readonly string[]).includes(type);
  if (!inbound && !(COGS_OUTBOUND_TYPES as readonly string[]).includes(type)) return [];

  const department = departmentFromWarehouseGroup(input.warehouseGroup);
  const cogsItem = department === REVENUE_DEPARTMENT_CODES.KITCHEN
    ? INVENTORY_COGS_PNL_ITEMS.KITCHEN
    : department === REVENUE_DEPARTMENT_CODES.BAR ? INVENTORY_COGS_PNL_ITEMS.BAR : INVENTORY_COGS_PNL_ITEMS.OTHER;
  const departmentCode = department === REVENUE_DEPARTMENT_CODES.KITCHEN || department === REVENUE_DEPARTMENT_CODES.BAR ? department : null;

  const buckets = new Map<string, { accountCode: string; pnlItemCode: string; amount: number }>();
  for (const line of input.lines) {
    const amount = Number(line.totalCost) || 0;
    if (amount === 0) continue;
    const packaging = String(line.itemType || "").toUpperCase() === "PACKAGING";
    const accountCode = packaging ? "6428" : "632";
    const pnlItemCode = packaging ? PACKAGING_EXPENSE_PNL_ITEM.code : cogsItem.code;
    const key = `${accountCode}|${pnlItemCode}`;
    const bucket = buckets.get(key) || { accountCode, pnlItemCode, amount: 0 };
    bucket.amount += amount;
    buckets.set(key, bucket);
  }
  const rows = [...buckets.values()].filter((bucket) => Math.abs(bucket.amount) > 0.000001);
  const total = rows.reduce((sum, bucket) => sum + bucket.amount, 0);
  if (!(total > 0)) return [];
  const expenseSide = inbound ? "credit" : "debit";
  const stockSide = inbound ? "debit" : "credit";
  return [
    ...rows.map((bucket) => ({ accountCode: bucket.accountCode, [expenseSide]: bucket.amount, pnlItemCode: bucket.pnlItemCode, departmentCode })),
    { accountCode: "152", [stockSide]: total },
  ];
}

/**
 * Nguồn bút toán mua hàng nhóm Giá vốn: từ kỳ giá vốn theo kho chúng ghi Nợ 152. Kỳ nào còn
 * dòng Nợ 632 từ các nguồn này nghĩa là kỳ đó chưa bấm Ghi sổ lại từ khi đổi luật — tự ghi giá
 * vốn theo kho lúc này sẽ cộng trùng với tiền mua (xem repostInventoryCogs, lib/accounting.ts).
 */
export const COGS_PURCHASE_SOURCE_TYPES = ["VOUCHER", "DEBT_PAYABLE", "CASHBOOK_ADJUSTMENT"] as const;

/**
 * Kết quả tự ghi sổ lại giá vốn sau khi rã / rã lại / hoàn tác rã (khách chốt 28/09/2026):
 *  - POSTED: đã ghi lại, P&L kỳ đó đã theo phiếu kho mới.
 *  - NEEDS_SYNC: kỳ chưa Ghi sổ lại lần nào từ khi đổi sang giá vốn theo kho — phải bấm tay một lần.
 *  - LOCKED: kỳ đã khoá sổ, không đụng.
 *  - ERROR: phiếu kho đã lưu nhưng ghi sổ lỗi — bấm Ghi sổ kỳ để thử lại.
 */
export type CogsRepostStatus = "POSTED" | "NEEDS_SYNC" | "LOCKED" | "ERROR";
export type CogsRepostResult = { period: string; branchCode: string; status: CogsRepostStatus; changed: number; error?: string };

/** Một câu cho màn hình Kho, gom theo trạng thái. Rỗng khi không có kỳ nào từ mốc giá vốn theo kho. */
export function cogsRepostMessage(results: CogsRepostResult[] | null | undefined) {
  if (!results || results.length === 0) return "";
  const label = (row: CogsRepostResult) => `T${Number(row.period.slice(5))}/${row.period.slice(0, 4)} (${row.branchCode})`;
  const list = (status: CogsRepostStatus) => results.filter((row) => row.status === status).map(label).join(", ");
  const parts: string[] = [];
  if (list("POSTED")) parts.push(`Đã tự ghi sổ lại giá vốn kỳ ${list("POSTED")} — P&L đã cập nhật.`);
  if (list("NEEDS_SYNC")) parts.push(`Kỳ ${list("NEEDS_SYNC")} chưa Ghi sổ lại từ khi đổi sang giá vốn theo kho: bấm Ghi sổ kỳ ở màn Kế toán một lần, các lần rã sau sẽ tự cập nhật.`);
  if (list("LOCKED")) parts.push(`Kỳ ${list("LOCKED")} đã khoá sổ nên giá vốn trên P&L giữ nguyên.`);
  const failed = results.filter((row) => row.status === "ERROR");
  if (failed.length > 0) parts.push(`Chưa tự ghi sổ được giá vốn kỳ ${failed.map(label).join(", ")} (${failed[0].error || "lỗi máy chủ"}) — bấm Ghi sổ kỳ ở màn Kế toán.`);
  return parts.join(" ");
}
