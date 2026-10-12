import type { RawTxClient, TxClient } from "@/lib/prisma";

/**
 * DANH MỤC MÃ TÀI SẢN / CCDC (master list, khách xin 12/10/2026) — giống tab Mặt hàng bên Kho:
 * tên sai hay cần mã mới thì vào danh mục sửa / tạo, hồ sơ (từng đợt mua) lấy tên + nhóm theo mã.
 *
 * - Một mã dùng cho mọi đợt, mọi nhà hàng (AssetRecord.code). Đổi tên ở danh mục = đổi tên mọi
 *   đợt đang dùng mã; đổi tên ở hồ sơ cũng đi ngược về danh mục và các đợt khác (renameAssetCode).
 * - Mã sinh từ các đường khác (import số dư đầu kỳ, nhận hàng theo PO...) chưa có dòng danh mục
 *   thì tự thêm khi mở danh mục (syncAssetCatalog) — không phải sửa từng đường tạo hồ sơ.
 * - Nhóm của mã quyết định tài khoản (CCDC 242 / TSCĐ 211): mã đã có hồ sơ thì không đổi nhóm.
 */

type CatalogClient = TxClient | RawTxClient;

/** Thêm vào danh mục những mã đang có hồ sơ mà chưa có dòng danh mục (tên theo đợt mới nhất). */
export async function syncAssetCatalog(tx: CatalogClient, actor = "system") {
  const client = tx as RawTxClient;
  return client.$executeRaw`
    INSERT INTO "AssetCatalogItem" ("id", "code", "name", "assetGroup", "departmentCode", "createdBy", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, latest."code", latest."name", latest."assetGroup", latest."departmentCode", ${actor}, NOW(), NOW()
    FROM (
      SELECT DISTINCT ON ("code") "code", "name", "assetGroup", "departmentCode"
      FROM "AssetRecord"
      WHERE "deletedAt" IS NULL
      ORDER BY "code", "lotNo" DESC
    ) latest
    WHERE NOT EXISTS (SELECT 1 FROM "AssetCatalogItem" c WHERE c."code" = latest."code")
  `;
}

/** Ghi / cập nhật dòng danh mục khi tạo hồ sơ với mã mới. Mã đã có thì giữ nguyên danh mục. */
export async function ensureCatalogItem(tx: CatalogClient, input: { code: string; name: string; assetGroup: string; departmentCode?: string | null; actor?: string }) {
  const client = tx as RawTxClient;
  const existing = await client.assetCatalogItem.findUnique({ where: { code: input.code } });
  if (existing) {
    // Mã nằm trong Thùng rác của danh mục mà lại có hồ sơ mới: đưa về hoạt động.
    if (existing.deletedAt) await client.assetCatalogItem.update({ where: { id: existing.id }, data: { deletedAt: null, deletedBy: null, status: "ACTIVE" } });
    return existing;
  }
  return client.assetCatalogItem.create({
    data: { code: input.code, name: input.name, assetGroup: input.assetGroup, departmentCode: input.departmentCode || null, createdBy: input.actor || null },
  });
}

/** Đổi tên một mã: dòng danh mục + mọi đợt hồ sơ đang dùng mã. Trả số hồ sơ đã đổi tên. */
export async function renameAssetCode(tx: CatalogClient, code: string, name: string) {
  const client = tx as RawTxClient;
  await client.assetCatalogItem.updateMany({ where: { code }, data: { name } });
  const result = await client.assetRecord.updateMany({ where: { code, deletedAt: null, NOT: { name } }, data: { name } });
  return result.count;
}

export type CatalogUsage = { lotCount: number; branchCodes: string[]; quantity: number; originalCost: number; inUse: number };

/** Hồ sơ đang dùng từng mã (đợt còn sống): số đợt, nhà hàng, tổng SL, tổng nguyên giá. */
export async function loadCatalogUsage(tx: CatalogClient) {
  const client = tx as RawTxClient;
  const rows = await client.$queryRaw<Array<{ code: string; lotCount: number; branchCodes: string[]; quantity: number; originalCost: number; inUse: number }>>`
    SELECT "code",
           COUNT(*)::int AS "lotCount",
           ARRAY_AGG(DISTINCT UPPER("branchCode")) AS "branchCodes",
           COALESCE(SUM("quantity"), 0)::float8 AS "quantity",
           COALESCE(SUM("originalCost"), 0)::float8 AS "originalCost",
           COUNT(*) FILTER (WHERE "disposalDate" IS NULL)::int AS "inUse"
    FROM "AssetRecord"
    WHERE "deletedAt" IS NULL
    GROUP BY "code"
  `;
  return new Map<string, CatalogUsage>(rows.map((row) => [row.code, row]));
}
