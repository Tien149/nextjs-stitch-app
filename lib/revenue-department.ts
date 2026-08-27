/**
 * Gắn doanh thu về bộ phận (DEPARTMENT: KIT/BAR/FOH...) — nền cho báo cáo ngân sách
 * nhân sự theo tỷ trọng từng bộ phận (feedback chị Bình 26/08/2026, report_Feedback.pdf).
 *
 * Thứ tự suy luận, dừng ở bước đầu tiên ra kết quả:
 *  1. Mã hàng -> InventoryItem.category (mã nhóm mặt hàng) -> MasterDataItem
 *     INVENTORY_ITEM_GROUP.subGroup (nhóm kho: "KHO BẾP"/"KHO BAR"/"KHO FOH") -> bộ phận.
 *  2. Nguồn doanh thu: REV_FOOD/bếp -> KIT, REV_DRINK/bar -> BAR (file tổng hợp
 *     không có mã hàng — toàn bộ dữ liệu đang chạy thuộc dạng này).
 * Không suy được thì để null, báo cáo dồn vào "Chưa gán bộ phận" thay vì đoán bừa.
 */

import type { Prisma } from "@prisma/custom-client";

/** Mã DEPARTMENT trong danh mục hiện hành (Team Bếp = KIT, không phải BEP). */
export const REVENUE_DEPARTMENT_CODES = { KITCHEN: "KIT", BAR: "BAR", FOH: "FOH" } as const;

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D");
}

/** "KHO BẾP" / "Kho bep" / "BEP" -> KIT; "KHO BAR" -> BAR; "KHO FOH"/"FOH" -> FOH. */
export function departmentFromWarehouseGroup(group: unknown): string | null {
  const normalized = stripDiacritics(String(group || "")).toUpperCase();
  if (!normalized) return null;
  if (normalized.includes("BEP") || normalized.includes("KITCHEN")) return REVENUE_DEPARTMENT_CODES.KITCHEN;
  if (normalized.includes("BAR")) return REVENUE_DEPARTMENT_CODES.BAR;
  if (normalized.includes("FOH")) return REVENUE_DEPARTMENT_CODES.FOH;
  return null;
}

/** REV_FOOD / "Doanh thu bếp" -> KIT; REV_DRINK / "Doanh thu bar" -> BAR. */
export function departmentFromRevenueSource(revenueSource: unknown): string | null {
  const normalized = stripDiacritics(String(revenueSource || "")).toUpperCase();
  if (!normalized) return null;
  if (normalized.includes("FOOD") || normalized.includes("BEP") || normalized.includes("KITCHEN")) return REVENUE_DEPARTMENT_CODES.KITCHEN;
  if (normalized.includes("DRINK") || normalized.includes("BAR")) return REVENUE_DEPARTMENT_CODES.BAR;
  return null;
}

export type RevenueDepartmentResolver = (input: { productCode?: string | null; revenueSource?: string | null }) => string | null;

type ItemLookupClient = Pick<Prisma.TransactionClient, "inventoryItem" | "masterDataItem">;

/**
 * Nạp sẵn map mã hàng -> bộ phận cho một danh sách mã hàng rồi trả về resolver đồng bộ,
 * dùng được cả trong transaction import lẫn script backfill.
 */
export async function buildRevenueDepartmentResolver(client: ItemLookupClient, productCodes: string[]): Promise<RevenueDepartmentResolver> {
  const codes = [...new Set(productCodes.map((code) => (code || "").toUpperCase()).filter(Boolean))];
  // deletedAt lọc tường minh vì script backfill chạy PrismaClient thô, không qua extension xoá mềm.
  const [items, groups] = await Promise.all([
    codes.length > 0
      ? client.inventoryItem.findMany({ where: { code: { in: codes }, deletedAt: null }, select: { code: true, category: true } })
      : Promise.resolve([]),
    client.masterDataItem.findMany({ where: { type: "INVENTORY_ITEM_GROUP", deletedAt: null }, select: { code: true, subGroup: true } }),
  ]);
  const groupDepartment = new Map(groups.map((group) => [group.code, departmentFromWarehouseGroup(group.subGroup)]));
  const productDepartment = new Map<string, string | null>();
  for (const item of items) {
    productDepartment.set(item.code, item.category ? groupDepartment.get(item.category.toUpperCase()) ?? departmentFromWarehouseGroup(item.category) : null);
  }
  return ({ productCode, revenueSource }) => {
    const byProduct = productCode ? productDepartment.get(productCode.toUpperCase()) : null;
    return byProduct || departmentFromRevenueSource(revenueSource) || null;
  };
}
