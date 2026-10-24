import type { DemoSession } from "@/lib/auth-demo";

/**
 * Phạm vi KHO của người dùng (khách yêu cầu 28/09/2026): nhân viên kho / bếp / bar chỉ thấy và
 * chỉ kiểm kê, nhập, xuất trên kho được giao.
 *
 * Cùng kiểu với phạm vi phòng ban (lib/department-scope.ts): tuỳ chọn, xếp CHỒNG lên phạm vi
 * cửa hàng. User không gán kho nào (mọi tài khoản đang có) thì thấy mọi kho của cửa hàng mình như
 * trước. Admin luôn thấy hết.
 */
export function allowedWarehousesOf(session: DemoSession | null | undefined): string[] | null {
  if (!session || session.role === "Admin") return null;
  const list = Array.isArray(session.allowedWarehouses) ? session.allowedWarehouses.filter(Boolean) : [];
  return list.length > 0 ? list.map((code) => code.toUpperCase()) : null;
}

export function warehouseAllowed(session: DemoSession | null | undefined, warehouseCode: string | null | undefined) {
  const allowed = allowedWarehousesOf(session);
  if (!allowed) return true;
  return Boolean(warehouseCode) && allowed.includes((warehouseCode as string).toUpperCase());
}

/** Lọc danh sách kho theo phạm vi; giữ nguyên thứ tự. */
export function scopeWarehouses<T extends { code: string }>(session: DemoSession | null | undefined, warehouses: T[]): T[] {
  const allowed = allowedWarehousesOf(session);
  if (!allowed) return warehouses;
  return warehouses.filter((warehouse) => allowed.includes(warehouse.code.toUpperCase()));
}

export function assertWarehouseAccess(session: DemoSession, warehouseCode: string | null | undefined, label = "Kho") {
  if (!warehouseCode || warehouseAllowed(session, warehouseCode)) return;
  const allowed = allowedWarehousesOf(session) || [];
  throw new Error(`BUSINESS:${label} ${warehouseCode} nằm ngoài các kho được phân công (${allowed.join(", ")}).`);
}

/**
 * Kho nhận điều chuyển cho người bị giới hạn kho (khách 24/10/2026: team Bếp điều chuyển thì kho
 * nhận chỉ hiện kho Bếp): chỉ các kho CÙNG LOẠI (ô Nhóm của danh mục kho: KHO BẾP / KHO BAR /
 * KHO FOH...) với kho được giao, ở mọi nhà hàng. Người không bị giới hạn kho thấy mọi kho.
 */
export function transferDestinationsFor<T extends { code: string; group?: string | null }>(session: DemoSession | null | undefined, warehouses: T[]): T[] {
  const allowed = allowedWarehousesOf(session);
  if (!allowed) return warehouses;
  const groupOf = (warehouse: T) => (warehouse.group || "").trim().toUpperCase();
  const groups = new Set(warehouses.filter((warehouse) => allowed.includes(warehouse.code.toUpperCase())).map(groupOf).filter(Boolean));
  return warehouses.filter((warehouse) => allowed.includes(warehouse.code.toUpperCase()) || (groupOf(warehouse) && groups.has(groupOf(warehouse))));
}
