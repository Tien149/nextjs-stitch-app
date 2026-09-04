/**
 * Chuẩn hoá "Nhóm doanh thu" của các dòng doanh thu ĐÃ import theo danh mục hiện hành.
 *
 * Dùng chung cho nút "Chuẩn hoá nhóm doanh thu đã import" trên màn hình Cài đặt và cho lệnh
 * npm run backfill:revenue-source. Người dùng sửa từ khoá / nhóm doanh thu trên danh mục xong
 * bấm nút là dữ liệu cũ chạy lại đúng luật, không phải nhờ ai vào sửa mã nguồn hay gõ lệnh.
 *
 * Luật y hệt lúc import (lib/revenue-source.ts): chữ trong file quy về mã danh mục Thu -> chưa
 * quy được thì lấy nhóm khai trên danh mục mặt hàng theo mã hàng -> vẫn không có thì GIỮ NGUYÊN.
 * Có nhóm rồi thì suy luôn bộ phận Bếp/Bar cho dòng chưa gắn, và sửa categoryCode/departmentCode
 * của dòng Có 511 trên bút toán REVENUE_POS đã ghi sổ — chỉ đổi nhãn phân loại, KHÔNG đụng số
 * tiền, nên sổ không lệch và kỳ đã khoá vẫn chạy được.
 *
 * Tiện thể thả luôn khỏi hàng chờ "Rã nguyên liệu" những dòng thuộc nhóm doanh thu vừa được
 * khai "không theo dõi tồn kho" (phụ thu, dịch vụ): dữ liệu import trước khi khai cờ không
 * phải xoá đi làm lại.
 */

import type { Prisma } from "@prisma/custom-client";
import { buildRevenueDepartmentResolver } from "@/lib/revenue-department";
import { REVENUE_COMPONENT_CATEGORIES } from "@/lib/revenue-pos-journal";
import { buildRevenueSourceResolver, loadNonInventoryRevenueGroups, loadRevenueCategoryIndex, pickRevenueSource, tracksInventory } from "@/lib/revenue-source";

export type NormalizeClient = Pick<
  Prisma.TransactionClient,
  "revenueImportRow" | "inventoryItem" | "masterDataItem" | "journalEntry" | "journalLine"
>;

export type RevenueSourceNormalizeGroup = {
  revenueSource: string;
  departmentCode: string | null;
  rows: number;
};

export type RevenueSourceNormalizeResult = {
  applied: boolean;
  total: number;
  unchanged: number;
  unresolved: number;
  changedRows: number;
  journalLines: number;
  /** Dòng của nhóm doanh thu không theo dõi tồn kho được thả khỏi hàng chờ rã nguyên liệu. */
  releasedRows: number;
  groups: RevenueSourceNormalizeGroup[];
};

/** Chạy thử (apply = false) chỉ đếm và trả về những gì SẼ đổi, không ghi gì vào database. */
export async function normalizeRevenueSources(
  client: NormalizeClient,
  { apply = false }: { apply?: boolean } = {},
): Promise<RevenueSourceNormalizeResult> {
  const rows = await client.revenueImportRow.findMany({
    where: { deletedAt: null },
    select: { id: true, productCode: true, revenueSource: true, departmentCode: true, inventoryStatus: true },
  });
  const empty: RevenueSourceNormalizeResult = {
    applied: false, total: rows.length, unchanged: 0, unresolved: 0, changedRows: 0, journalLines: 0, releasedRows: 0, groups: [],
  };
  if (rows.length === 0) return empty;

  const productCodes = rows.map((row) => row.productCode || "");
  const [resolveRevenueSource, resolveRevenueDepartment, revenueCategoryIndex, nonInventoryGroups] = await Promise.all([
    buildRevenueSourceResolver(client, productCodes),
    buildRevenueDepartmentResolver(client, productCodes),
    loadRevenueCategoryIndex(client),
    loadNonInventoryRevenueGroups(client),
  ]);

  // Gom theo cặp (nhóm doanh thu, bộ phận) để updateMany theo lô thay vì từng dòng.
  const batches = new Map<string, RevenueSourceNormalizeGroup & { ids: string[] }>();
  // Dòng thuộc nhóm khai "không theo dõi tồn kho" mà còn nằm chờ rã nguyên liệu thì thả ra:
  // khai cờ trên danh mục xong bấm nút này là hàng chờ sạch, không phải xoá import làm lại.
  const releaseIds: string[] = [];
  let unchanged = 0;
  let unresolved = 0;
  for (const row of rows) {
    const revenueSource = pickRevenueSource(row.revenueSource, resolveRevenueSource(row.productCode), revenueCategoryIndex);
    if (row.inventoryStatus === "PENDING" && !tracksInventory(revenueSource || row.revenueSource, nonInventoryGroups)) {
      releaseIds.push(row.id);
    }
    if (!revenueSource) {
      unresolved += 1;
      continue;
    }
    // Dòng đã đúng thì không đụng vào, chạy lại bao nhiêu lần cũng cho cùng kết quả.
    if (revenueSource === row.revenueSource) {
      unchanged += 1;
      continue;
    }
    const departmentCode = row.departmentCode || resolveRevenueDepartment({ productCode: row.productCode, revenueSource }) || null;
    const key = `${revenueSource}|${departmentCode || ""}`;
    const batch = batches.get(key) || { revenueSource, departmentCode, rows: 0, ids: [] };
    batch.ids.push(row.id);
    batch.rows = batch.ids.length;
    batches.set(key, batch);
  }

  const groups = [...batches.values()].map(({ revenueSource, departmentCode, rows: count }) => ({ revenueSource, departmentCode, rows: count }));
  const changedRows = groups.reduce((sum, group) => sum + group.rows, 0);
  const preview = { applied: false, total: rows.length, unchanged, unresolved, changedRows, journalLines: 0, releasedRows: releaseIds.length, groups };
  if (!apply || (batches.size === 0 && releaseIds.length === 0)) return preview;

  if (releaseIds.length > 0) {
    await client.revenueImportRow.updateMany({ where: { id: { in: releaseIds } }, data: { inventoryStatus: "NOT_REQUIRED" } });
  }

  let journalLines = 0;
  for (const batch of batches.values()) {
    await client.revenueImportRow.updateMany({
      where: { id: { in: batch.ids } },
      data: { revenueSource: batch.revenueSource, ...(batch.departmentCode ? { departmentCode: batch.departmentCode } : {}) },
    });

    // Bút toán 511 tương ứng: chỉ dòng Có của entry REVENUE_POS mới mang doanh thu. Từ 04/09/2026
    // mỗi entry có thể có thêm dòng Có riêng cho SVC / thuế GTGT / điều chỉnh — chúng không
    // thuộc nhóm doanh thu của món nên chỉ đổi bộ phận, không đổi nhóm.
    const entries = await client.journalEntry.findMany({
      where: { sourceType: "REVENUE_POS", sourceId: { in: batch.ids }, deletedAt: null },
      select: { id: true },
    });
    const entryIds = entries.map((entry) => entry.id);
    if (entryIds.length === 0) continue;
    const componentCodes = REVENUE_COMPONENT_CATEGORIES.map((category) => category.code);
    const result = await client.journalLine.updateMany({
      where: { entryId: { in: entryIds }, debit: 0, OR: [{ categoryCode: null }, { categoryCode: { notIn: componentCodes } }] },
      data: { categoryCode: batch.revenueSource, ...(batch.departmentCode ? { departmentCode: batch.departmentCode } : {}) },
    });
    if (batch.departmentCode) {
      await client.journalLine.updateMany({
        where: { entryId: { in: entryIds }, debit: 0, categoryCode: { in: componentCodes } },
        data: { departmentCode: batch.departmentCode },
      });
    }
    journalLines += result.count;
  }

  return { ...preview, applied: true, journalLines };
}
