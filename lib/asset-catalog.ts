import type { RawTxClient, TxClient } from "@/lib/prisma";
import { assetAcquisitionJournalCode, assetPayableCode } from "@/lib/asset-lot";

/**
 * DANH MỤC MÃ TÀI SẢN / CCDC (master list, khách xin 12/10/2026) — giống tab Mặt hàng bên Kho:
 * tên sai hay cần mã mới thì vào danh mục sửa / tạo, hồ sơ (từng đợt mua) lấy tên + nhóm theo mã.
 *
 * - Một mã dùng cho mọi đợt, mọi nhà hàng (AssetRecord.code). Đổi tên ở danh mục = đổi tên mọi
 *   đợt đang dùng mã; đổi tên ở hồ sơ cũng đi ngược về danh mục và các đợt khác (renameAssetCode).
 * - Mã sinh từ các đường khác (import số dư đầu kỳ, nhận hàng theo PO...) chưa có dòng danh mục
 *   thì tự thêm khi mở danh mục (syncAssetCatalog) — không phải sửa từng đường tạo hồ sơ.
 * - Nhóm của mã quyết định tài khoản (CCDC 242 / TSCĐ 211): mã đã có hồ sơ thì không đổi nhóm.
 * - Một mã theo dõi được ở nhiều team / kho: mỗi team là một đợt riêng mang phòng ban + kho riêng.
 *   Hai mã trùng tên tạo lỡ thì Gộp mã (mergeAssetCodes) — hồ sơ mã bỏ thành đợt của mã giữ lại.
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

export type CatalogUsage = { lotCount: number; branchCodes: string[]; departmentCodes: string[]; quantity: number; originalCost: number; inUse: number };

/** Hồ sơ đang dùng từng mã (đợt còn sống): số đợt, nhà hàng, tổng SL, tổng nguyên giá. */
export async function loadCatalogUsage(tx: CatalogClient) {
  const client = tx as RawTxClient;
  const rows = await client.$queryRaw<Array<CatalogUsage & { code: string }>>`
    SELECT "code",
           COUNT(*)::int AS "lotCount",
           ARRAY_AGG(DISTINCT UPPER("branchCode")) AS "branchCodes",
           COALESCE(ARRAY_AGG(DISTINCT "departmentCode") FILTER (WHERE "departmentCode" IS NOT NULL AND "departmentCode" <> ''), '{}') AS "departmentCodes",
           COALESCE(SUM("quantity"), 0)::float8 AS "quantity",
           COALESCE(SUM("originalCost"), 0)::float8 AS "originalCost",
           COUNT(*) FILTER (WHERE "disposalDate" IS NULL)::int AS "inUse"
    FROM "AssetRecord"
    WHERE "deletedAt" IS NULL
    GROUP BY "code"
  `;
  return new Map<string, CatalogUsage>(rows.map((row) => [row.code, row]));
}

export class AssetMergeError extends Error {}

export type AssetMergeResult = { movedRecords: Array<{ id: string; fromLot: number; toLot: number }>; renamedDebts: number; renamedJournals: number };

/**
 * GỘP MÃ (khách xin 12/10/2026): hai mã tạo trùng cho cùng một thứ (vd. Miếng Lau Nhà của Team FOH
 * và của Team Bếp) → mọi hồ sơ của mã bỏ (source) thành đợt tiếp theo của mã giữ lại (target),
 * dòng danh mục của mã bỏ vào Thùng rác.
 *
 * Không đổi số liệu nào: mỗi đợt giữ nguyên cửa hàng, phòng ban, kho, ngày mua, nguyên giá, lịch
 * phân bổ; khấu hao / kiểm kê / bảo trì / báo hỏng / công nợ / bút toán nối theo id hồ sơ nên đi
 * theo luôn. Chỉ đổi nhãn: tên theo mã giữ lại, mã công nợ CN-… và bút toán JE-ASSET-… theo mã +
 * đợt mới (khi chúng còn đúng dạng tự sinh), sourceCode bút toán ghi tăng / khấu hao, mã chứng từ
 * phiếu thu thanh lý và mã liên kết công việc. Cùng nhóm mới gộp được (nhóm quyết định 242/211).
 * Hồ sơ đã xoá mềm của mã bỏ cũng chuyển theo để khôi phục ở Thùng rác vẫn rơi đúng mã.
 */
export async function mergeAssetCodes(tx: CatalogClient, input: { sourceCode: string; targetCode: string }): Promise<AssetMergeResult> {
  const client = tx as RawTxClient;
  const sourceCode = input.sourceCode.trim().toUpperCase();
  const targetCode = input.targetCode.trim().toUpperCase();
  if (!sourceCode || !targetCode) throw new AssetMergeError("Chọn mã cần gộp và mã giữ lại");
  if (sourceCode === targetCode) throw new AssetMergeError("Mã giữ lại phải khác mã cần gộp");

  const [source, target] = await Promise.all([
    client.assetCatalogItem.findUnique({ where: { code: sourceCode } }),
    client.assetCatalogItem.findUnique({ where: { code: targetCode } }),
  ]);
  if (!source || source.deletedAt) throw new AssetMergeError(`Không tìm thấy mã ${sourceCode} trong danh mục`);
  if (!target || target.deletedAt) throw new AssetMergeError(`Không tìm thấy mã ${targetCode} trong danh mục`);
  if (target.status !== "ACTIVE") throw new AssetMergeError(`Mã giữ lại ${targetCode} đang Ngưng — bật lại trước khi gộp`);
  if (source.assetGroup !== target.assetGroup) {
    throw new AssetMergeError(`Hai mã khác nhóm (${source.assetGroup} / ${target.assetGroup}) nên không gộp được — nhóm quyết định tài khoản 242/211.`);
  }

  const records = await client.assetRecord.findMany({
    where: { code: sourceCode },
    orderBy: [{ lotNo: "asc" }, { createdAt: "asc" }],
    select: { id: true, lotNo: true, name: true },
  });
  const last = await client.assetRecord.aggregate({ where: { code: targetCode }, _max: { lotNo: true } });
  let nextLot = last._max.lotNo || 0;

  const movedRecords: AssetMergeResult["movedRecords"] = [];
  let renamedDebts = 0;
  let renamedJournals = 0;
  for (const record of records) {
    nextLot += 1;
    const before = { code: sourceCode, lotNo: record.lotNo };
    const after = { code: targetCode, lotNo: nextLot };
    await client.assetRecord.update({ where: { id: record.id }, data: { code: targetCode, lotNo: nextLot, name: target.name } });
    movedRecords.push({ id: record.id, fromLot: record.lotNo, toLot: nextLot });

    const debt = await client.debtRecord.findFirst({ where: { sourceType: "ASSET", sourceId: record.id } });
    if (debt) {
      const newCode = assetPayableCode(after);
      const free = debt.code !== assetPayableCode(before) ? false : !(await client.debtRecord.findUnique({ where: { code: newCode }, select: { id: true } }));
      await client.debtRecord.update({
        where: { id: debt.id },
        data: {
          ...(free ? { code: newCode } : {}),
          description: debt.description.startsWith("Công nợ mua tài sản/CCDC ")
            ? `Công nợ mua tài sản/CCDC ${targetCode}${nextLot > 1 ? ` (đợt ${nextLot})` : ""} - ${target.name}`
            : debt.description,
        },
      });
      if (free) renamedDebts += 1;
    }

    const journal = await client.journalEntry.findFirst({ where: { sourceType: "ASSET_ACQUISITION", sourceId: record.id } });
    if (journal) {
      const newCode = assetAcquisitionJournalCode(after);
      const free = journal.code !== assetAcquisitionJournalCode(before) ? false : !(await client.journalEntry.findUnique({ where: { code: newCode }, select: { id: true } }));
      await client.journalEntry.update({ where: { id: journal.id }, data: { sourceCode: targetCode, ...(free ? { code: newCode } : {}) } });
      if (free) renamedJournals += 1;
    }
  }

  const recordIds = records.map((record) => record.id);
  if (recordIds.length > 0) {
    const depreciations = await client.assetDepreciation.findMany({ where: { assetId: { in: recordIds } }, select: { id: true } });
    if (depreciations.length > 0) {
      await client.journalEntry.updateMany({
        where: { sourceType: "DEPRECIATION", sourceId: { in: depreciations.map((row) => row.id) } },
        data: { sourceCode: targetCode },
      });
    }
  }
  await client.financialVoucher.updateMany({ where: { sourceDocumentCode: sourceCode, categoryCode: "ASSET_DISPOSAL" }, data: { sourceDocumentCode: targetCode } });
  await client.workItem.updateMany({ where: { linkedCode: sourceCode, linkedModule: { startsWith: "ASSET" } }, data: { linkedCode: targetCode } });
  await client.assetCatalogItem.update({ where: { id: source.id }, data: { deletedAt: new Date(), status: "INACTIVE", note: [source.note, `Đã gộp vào ${targetCode}`].filter(Boolean).join(" · ") } });

  return { movedRecords, renamedDebts, renamedJournals };
}
