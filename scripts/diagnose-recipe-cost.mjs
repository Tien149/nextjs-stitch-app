/**
 * Soi cost định lượng của một hoặc nhiều món: từng dòng nguyên liệu, giá vốn đang dùng, kho nào
 * đang âm, bán thành phẩm quên khai hệ số mẻ... để biết vì sao "% cost" vọt lên hàng trăm phần trăm.
 *
 * Chạy:  npm run diagnose:recipe-cost -- 4CGK1S 6CGK2S
 *        npm run diagnose:recipe-cost -- 4CGK1S --branch ASA
 * Chỉ đọc, không ghi gì.
 */
import { prisma } from "../lib/prisma.ts";
import { averageCostByItem } from "../lib/inventory-average-cost.ts";
import { computeRecipeUnitCosts, lineConversionRate, pickRecipeForDate } from "../lib/production-explosion.ts";

const args = process.argv.slice(2);
const branchIndex = args.indexOf("--branch");
const branchCode = branchIndex >= 0 ? (args[branchIndex + 1] || "").toUpperCase() : null;
const codes = args
  .filter((value, index) => !value.startsWith("--") && !(branchIndex >= 0 && index === branchIndex + 1))
  .map((value) => value.toUpperCase());
if (codes.length === 0) {
  console.log("Cách dùng: npm run diagnose:recipe-cost -- <mã món> [<mã món>...] [--branch <cửa hàng>]");
  process.exit(0);
}

const money = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);
const price = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 4 }).format(value || 0);

/** Cách gộp CŨ của Sheet tổng hợp (cộng cả kho âm) — để thấy chênh trước / sau khi vá. */
function oldAverage(balances) {
  const buckets = new Map();
  for (const balance of balances) {
    const bucket = buckets.get(balance.itemId) || { quantity: 0, value: 0, last: 0 };
    bucket.quantity += balance.quantity;
    bucket.value += balance.quantity * balance.averageCost;
    if (balance.averageCost > 0) bucket.last = balance.averageCost;
    buckets.set(balance.itemId, bucket);
  }
  const result = new Map();
  for (const [itemId, bucket] of buckets) result.set(itemId, bucket.quantity > 0.000001 ? bucket.value / bucket.quantity : bucket.last);
  return result;
}

try {
  const [recipes, balances] = await Promise.all([
    prisma.recipe.findMany({ where: { deletedAt: null }, include: { lines: { include: { item: true } } } }),
    prisma.inventoryBalance.findMany({ select: { itemId: true, warehouseCode: true, quantity: true, averageCost: true } }),
  ]);
  const newCost = averageCostByItem(balances);
  const oldCost = oldAverage(balances);
  const now = new Date();
  const unitCostsNew = computeRecipeUnitCosts(recipes, newCost, now, branchCode || undefined);
  const unitCostsOld = computeRecipeUnitCosts(recipes, oldCost, now, branchCode || undefined);
  const recipesByCode = new Map();
  for (const recipe of recipes) {
    const code = recipe.productCode.toUpperCase();
    if (!recipesByCode.has(code)) recipesByCode.set(code, []);
    recipesByCode.get(code).push(recipe);
  }

  for (const code of codes) {
    const recipe = pickRecipeForDate(recipesByCode.get(code) || [], now, branchCode || undefined);
    if (!recipe) { console.log(`\n${code}: không có định lượng đang áp dụng${branchCode ? ` cho ${branchCode}` : ""}.`); continue; }
    const cost = unitCostsNew.get(code) || 0;
    const before = unitCostsOld.get(code) || 0;
    console.log(`\n=== ${code} - ${recipe.productName} (V${recipe.version}, ${recipe.branchCode || "dùng chung"}) ===`);
    console.log(`Mẻ: 1 ${recipe.unit} = ${recipe.outputConversionRate} ĐVT tồn | giá bán ${money(recipe.sellingPrice)} đ`);
    console.log(`Cost / ĐVT tồn: trước khi vá ${money(before)} đ -> sau khi vá ${money(cost)} đ${recipe.sellingPrice > 0 ? ` (${(cost / recipe.sellingPrice * 100).toFixed(1)}% giá bán)` : ""}`);
    for (const line of recipe.lines) {
      const component = line.item.code.toUpperCase();
      const rate = lineConversionRate(line);
      const quantityBase = line.quantity * rate * (1 + (line.wasteRate || 0) / 100);
      const fromRecipe = unitCostsNew.get(component);
      const unitCost = Number.isFinite(fromRecipe) && fromRecipe !== undefined ? fromRecipe : newCost.get(line.itemId) || 0;
      const lineCost = quantityBase * unitCost;
      const flags = [];
      if (fromRecipe !== undefined) {
        const sub = pickRecipeForDate(recipesByCode.get(component) || [], now, branchCode || undefined);
        if (sub && (!sub.outputConversionRate || sub.outputConversionRate === 1) && line.item.unit && !/^(phan|phần|mon|món|cai|cái|ly|suat|suất)$/i.test(line.item.unit)) {
          flags.push(`BTP khai 1 mẻ = 1 ${line.item.unit} — mẻ thật ra nhiều ${line.item.unit} hơn thì cost bị nhân lên`);
        }
      } else {
        const rows = balances.filter((row) => row.itemId === line.itemId);
        if (rows.some((row) => row.quantity < 0) && rows.some((row) => row.quantity > 0)) flags.push("có kho âm lẫn kho dương (Sheet cũ bị đội giá ở đây)");
        const old = oldCost.get(line.itemId) || 0;
        if (old > 0 && unitCost > 0 && old / unitCost > 1.5) flags.push(`giá gộp cũ ${price(old)} đ gấp ${(old / unitCost).toFixed(1)} lần`);
      }
      if (rate !== 1 && line.unitCode) flags.push(`ĐVT dòng ${line.unitCode} x${rate}`);
      if (recipe.sellingPrice > 0 && lineCost > recipe.sellingPrice * recipe.outputConversionRate * 0.5) flags.push("MỘT DÒNG đã hơn 50% giá bán");
      console.log(`  - ${line.item.code} ${line.item.name}: ${line.quantity} ${line.unitCode || line.item.unit}`
        + ` = ${price(quantityBase)} ${line.item.unit} x ${price(unitCost)} đ = ${money(lineCost)} đ`
        + (flags.length ? `\n      ! ${flags.join(" | ")}` : ""));
      if (fromRecipe === undefined) {
        for (const row of balances.filter((candidate) => candidate.itemId === line.itemId)) {
          console.log(`      kho ${row.warehouseCode}: tồn ${price(row.quantity)} ${line.item.unit}, bình quân ${price(row.averageCost)} đ`);
        }
      }
    }
  }
} finally {
  await prisma.$disconnect();
}
