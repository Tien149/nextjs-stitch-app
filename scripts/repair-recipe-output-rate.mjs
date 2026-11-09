/**
 * SỬA MỘT LẦN định lượng khai mẻ dạng "650GR" mà hệ số quy đổi để 1 (khách chốt 09/11/2026:
 * "650GR được hiểu là số 650"). Hệ số 1 làm cost 1 GR BTP = cost cả mẻ — Sốt Pesto ASA 368.037 đ/GR.
 * Chỉ sửa định lượng có hệ số đúng bằng 1 và ĐVT mẻ = <số><ĐVT tồn> (lib/recipe-output-rate).
 * Mẻ trùng ĐVT tồn mà khai cho cả mẻ (Bò Tái NME: mẻ GR, nguyên liệu 1.100 GR) KHÔNG suy được —
 * script chỉ liệt kê, sửa tay trên màn Định lượng.
 *
 * Chạy thử (không ghi): npm run repair:recipe-output-rate
 * Ghi thật:            npm run repair:recipe-output-rate -- --apply
 *   → lưu bản cũ vào backups/repair-recipe-output-rate-<giờ>.json trước khi ghi.
 * Định lượng đã dùng để rã thì sau khi sửa phải Rã lại các ngày đó (script báo số phiếu RA).
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { inferOutputConversionRate, outputConversionRateProblem } from "../lib/recipe-output-rate.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

const recipes = await prisma.recipe.findMany({
  where: { outputConversionRate: 1 },
  select: { id: true, code: true, productCode: true, productName: true, branchCode: true, unit: true, outputConversionRate: true, status: true },
});
const items = new Map((await prisma.inventoryItem.findMany({
  where: { code: { in: [...new Set(recipes.map((recipe) => recipe.productCode))] } },
  select: { code: true, unit: true },
})).map((item) => [item.code.toUpperCase(), item.unit]));

const fixable = [];
const manual = [];
for (const recipe of recipes) {
  const stockUnit = items.get(recipe.productCode.toUpperCase());
  if (!outputConversionRateProblem(recipe.unit, stockUnit, recipe.outputConversionRate)) continue;
  const rate = inferOutputConversionRate(recipe.unit, stockUnit);
  (rate ? fixable : manual).push({ ...recipe, stockUnit, rate });
}

for (const row of fixable) {
  console.log(`SỬA  ${row.code} ${row.productName} [${row.branchCode || "chung"}] mẻ ${row.unit} → hệ số ${row.rate} ${row.stockUnit}`);
}
for (const row of manual) {
  console.log(`TAY  ${row.code} ${row.productName} [${row.branchCode || "chung"}] mẻ ${row.unit} ≠ ĐVT tồn ${row.stockUnit}, hệ số 1 — không suy được`);
}
console.log(`Tổng: ${fixable.length} sửa được, ${manual.length} phải sửa tay.`);

if (apply && fixable.length) {
  mkdirSync("backups", { recursive: true });
  const file = `backups/repair-recipe-output-rate-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(fixable.map(({ id, code, outputConversionRate }) => ({ id, code, outputConversionRate })), null, 2));
  for (const row of fixable) {
    await prisma.recipe.update({ where: { id: row.id }, data: { outputConversionRate: row.rate } });
  }
  console.log(`Đã ghi ${fixable.length} định lượng. Bản cũ: ${file}`);
} else if (!apply) {
  console.log("Chạy thử — chưa ghi. Thêm -- --apply để ghi.");
}
await prisma.$disconnect();
