import { prisma } from "@/lib/prisma";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";

export type ResolvableCategoryCodes = Record<"RECEIPT" | "PAYMENT", string[]>;

/**
 * Tập mã Khoản mục thu/chi mà báo cáo nguồn tiền coi là ĐÃ phân loại, tách theo nhóm Thu/Chi.
 *
 * Báo cáo tra khoản mục theo mã gốc, mã viết hoa hoặc tên khoản mục, và còn bắt đúng nhóm —
 * mã Chi gắn lên dòng Thu vẫn bị gom về "Chưa phân loại". Các màn danh sách muốn lọc ra đúng
 * những dòng nằm sau con số đó thì phải hiểu y hệt, nên dùng chung một chỗ dựng danh sách mã.
 */
export function categoryCodeTokensByType(
  categories: Array<{ code: string; name: string; group: string | null }>,
): ResolvableCategoryCodes {
  const buckets: Record<"RECEIPT" | "PAYMENT", Set<string>> = { RECEIPT: new Set(), PAYMENT: new Set() };
  for (const row of categories) {
    const type = normalizeCashflowCategoryType(row.group);
    if (type !== "RECEIPT" && type !== "PAYMENT") continue;
    for (const token of [row.code, row.code?.toUpperCase(), row.name, row.name?.toUpperCase()]) {
      if (token?.trim()) buckets[type].add(token.trim());
    }
  }
  return { RECEIPT: [...buckets.RECEIPT], PAYMENT: [...buckets.PAYMENT] };
}

export async function resolvableCategoryCodes(): Promise<ResolvableCategoryCodes> {
  const categories = await prisma.masterDataItem.findMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY" },
    select: { code: true, name: true, group: true },
  });
  return categoryCodeTokensByType(categories);
}
