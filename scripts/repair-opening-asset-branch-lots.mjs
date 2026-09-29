/**
 * Dựng lại tài sản/CCDC đầu kỳ bị nhà hàng khác "cướp" mất đợt.
 *
 * Vì sao cần: trước 29/09/2026 import số dư đầu kỳ tài sản (OPENING_ASSET_TOOL_V1) ghép đợt theo
 * mã + nguyên giá + kỳ bắt đầu mà KHÔNG xét cửa hàng. Hai nhà hàng dùng chung mã (ASA và NME cùng
 * mua tủ đông TSCDKIT0014 42.310.000 đ) thì file import sau ghi đè luôn đợt của nhà hàng import
 * trước: dòng số dư đầu kỳ của nhà hàng trước vẫn còn (Nợ 211/242 vẫn ghi), nhưng tài sản của nó
 * biến mất khỏi danh sách và không được khấu hao. Import đã sửa (lib/import-commit.ts), còn dữ
 * liệu đã bị ghi đè thì script này dựng lại.
 *
 * Dòng số dư ASSET bị coi là mất tài sản khi: không tài sản nào trỏ openingBalanceId về nó, cửa
 * hàng của dòng không có đợt nào cùng mã (kể cả đợt đã xoá — tự xoá thì thôi), và mã đang nằm ở
 * nhà hàng khác. Mỗi dòng như vậy sinh một đợt mới của mã, đúng cửa hàng/kho/số liệu trên dòng.
 *
 * Sau khi ghi: chạy lại khấu hao/phân bổ các kỳ đã chạy cho cửa hàng đó (đợt mới chưa có kỳ nào).
 *
 * Chạy thử (không ghi gì):  npm run repair:opening-asset-branch-lots
 * Ghi thật:                 npm run repair:opening-asset-branch-lots -- --apply
 */
import { createRequire } from "node:module";
import { openingAssetRecordData } from "../lib/opening-asset.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const money = (value) => Math.round(value || 0).toLocaleString("vi-VN");

const openings = await prisma.openingBalance.findMany({
  where: { balanceType: "ASSET", deletedAt: null, objectCode: { not: null } },
  orderBy: [{ objectCode: "asc" }, { branchCode: "asc" }, { period: "asc" }],
});

const missing = [];
for (const opening of openings) {
  const code = opening.objectCode.trim().toUpperCase();
  if (!code) continue;
  const linked = await prisma.assetRecord.findFirst({ where: { openingBalanceId: opening.id }, select: { id: true } });
  if (linked) continue;
  // Kể cả đợt đã xoá: người dùng tự xoá tài sản thì không dựng lại.
  const sameBranch = await prisma.assetRecord.findFirst({ where: { code, branchCode: opening.branchCode }, select: { id: true } });
  if (sameBranch) continue;
  // Dấu hiệu bị ghi đè: mã đang nằm ở nhà hàng khác.
  const otherBranch = await prisma.assetRecord.findFirst({ where: { code, branchCode: { not: opening.branchCode }, deletedAt: null }, select: { id: true } });
  if (!otherBranch) continue;
  missing.push({ opening, code });
}

if (missing.length === 0) {
  console.log("Không có dòng số dư đầu kỳ tài sản nào bị mất đợt, không đổi gì.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`${missing.length} dòng số dư đầu kỳ tài sản không còn tài sản ở đúng cửa hàng:`);
for (const { opening, code } of missing) {
  const holders = await prisma.assetRecord.findMany({ where: { code, deletedAt: null }, select: { lotNo: true, branchCode: true } });
  const holderText = holders.map((lot) => `đợt ${lot.lotNo} ở ${lot.branchCode}`).join(", ");
  console.log(`  - ${opening.period} ${opening.branchCode} ${code} ${opening.objectName || ""} · nguyên giá ${money(opening.originalCost)} · còn lại ${money(opening.amount)} (hiện: ${holderText})`);
}

if (!apply) {
  console.log("\nChạy thử, chưa ghi gì. Thêm -- --apply để tạo lại các đợt trên.");
  await prisma.$disconnect();
  process.exit(0);
}

for (const { opening, code } of missing) {
  const created = await prisma.$transaction(async (tx) => {
    // Cùng khoá với nextAssetLot (lib/asset-code-generator.ts) để không đụng số đợt với người đang ghi.
    await tx.$queryRaw`SELECT 1::integer AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtext(${`asset-lot:${code}`}))) AS advisory_lock`;
    const latest = await tx.assetRecord.findFirst({ where: { code }, orderBy: { lotNo: "desc" }, select: { lotNo: true } });
    return tx.assetRecord.create({ data: { code, lotNo: (latest?.lotNo || 0) + 1, ...openingAssetRecordData(opening) } });
  });
  console.log(`Đã tạo ${code} đợt ${created.lotNo} cho ${created.branchCode}.`);
}
await prisma.$disconnect();
