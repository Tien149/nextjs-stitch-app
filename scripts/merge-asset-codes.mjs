/**
 * Gộp mã Tài sản / CCDC từ dòng lệnh — cùng nghiệp vụ nút Gộp ở Danh mục mã (mergeAssetCodes,
 * lib/asset-catalog.ts): hồ sơ của mã bỏ thành đợt tiếp theo của mã giữ lại, mã bỏ vào Thùng rác.
 *
 * Chạy thử (không ghi): npm run merge:asset-codes -- <mã bỏ> <mã giữ lại>
 * Ghi thật:             npm run merge:asset-codes -- <mã bỏ> <mã giữ lại> --apply
 */
import { prismaRaw } from "../lib/prisma.ts";
import { mergeAssetCodes } from "../lib/asset-catalog.ts";
import { writeAuditLog } from "../lib/audit-log.ts";

const rawLog = console.log;
console.log = (...parts) => {
  if (typeof parts[0] === "string" && parts[0].startsWith("prisma:query")) return;
  rawLog(...parts);
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [sourceCode, targetCode] = args.filter((arg) => !arg.startsWith("--")).map((arg) => arg.toUpperCase());
if (!sourceCode || !targetCode) {
  console.error("Cần <mã bỏ> <mã giữ lại>");
  process.exit(1);
}

class DryRun extends Error {}
let result;
try {
  await prismaRaw.$transaction(async (tx) => {
    result = await mergeAssetCodes(tx, { sourceCode, targetCode });
    if (!apply) throw new DryRun();
  }, { timeout: 60_000 });
} catch (error) {
  if (!(error instanceof DryRun)) throw error;
}

for (const row of result.movedRecords) console.log(`Hồ sơ ${row.id}: ${sourceCode} đợt ${row.fromLot} -> ${targetCode} đợt ${row.toLot}`);
console.log(`Đổi mã công nợ: ${result.renamedDebts} · đổi mã bút toán ghi tăng: ${result.renamedJournals}`);
if (apply) {
  await writeAuditLog({
    actorId: "script", actorName: "script merge-asset-codes", actorRole: "Admin", module: "/assets",
    action: "MERGE_ASSET_CATALOG", entityType: "AssetCatalogItem", entityCode: targetCode, metadata: { sourceCode, targetCode, ...result },
  });
  console.log(`Đã gộp ${sourceCode} vào ${targetCode}.`);
} else {
  console.log("Chạy thử — chưa ghi gì. Thêm --apply để ghi.");
}
await prismaRaw.$disconnect();
