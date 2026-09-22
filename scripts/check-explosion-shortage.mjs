/**
 * Dry-run nút "Rã nguyên liệu": mô phỏng đúng thứ tự trừ/nhập kho của EXPLODE_PRODUCTION rồi
 * chỉ ra mặt hàng nào âm kho ở kho nào — thay cho lỗi "Khong the xuat vuot ton kho" không nói
 * được gì. KHÔNG ghi bất cứ thứ gì vào DB.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs \
 *     scripts/check-explosion-shortage.mjs ASA 2026-08-01 2026-08-01 ASA_KBAR ASA_KBAR ASA_KBEP ASA_KBAR
 *   (cửa hàng, từ ngày, đến ngày, kho xuất NVL, kho nhập BTP/TP, kho ĐỒ ĂN, kho ĐỒ UỐNG)
 *   Bỏ trống hai tham số cuối bằng "-" để mô phỏng khi không tách kho Bếp/Bar.
 */
import { explodeSalesDemand } from "../lib/production-explosion.ts";
import { loadNonInventoryRevenueGroups, tracksInventory } from "../lib/revenue-source.ts";
import { buildRevenueDepartmentResolver, REVENUE_DEPARTMENT_CODES } from "../lib/revenue-department.ts";
import { PrismaClient } from "@prisma/custom-client";

const [branchCode, fromArg, toArg, warehouseCode, toWarehouseArg, kitchenArg, barArg] = process.argv.slice(2);
if (!branchCode || !fromArg || !warehouseCode) {
  console.error("Thiếu tham số: <cửa hàng> <từ ngày> [đến ngày] <kho xuất NVL> [kho nhập] [kho bếp] [kho bar]");
  process.exit(1);
}
const dash = (value) => (!value || value === "-" ? "" : value);
const toWarehouseCode = dash(toWarehouseArg) || warehouseCode;
const kitchenWarehouseCode = dash(kitchenArg);
const barWarehouseCode = dash(barArg);
const dateFrom = new Date(`${fromArg}T00:00:00.000Z`);
const dateTo = new Date(`${toArg || fromArg}T00:00:00.000Z`);
const rangeEnd = new Date(dateTo);
rangeEnd.setHours(23, 59, 59, 999);

const prisma = new PrismaClient();
const pendingRows = await prisma.revenueImportRow.findMany({
  where: {
    inventoryStatus: "PENDING",
    productCode: { not: null },
    productQuantity: { gt: 0 },
    branchCode,
    saleDate: { gte: dateFrom, lte: rangeEnd },
    deletedAt: null,
  },
});
const nonInventoryGroups = await loadNonInventoryRevenueGroups(prisma);
const inventoryRows = pendingRows.filter((row) => tracksInventory(row.revenueSource, nonInventoryGroups));
console.log(`Dòng doanh thu chờ rã: ${pendingRows.length}, có theo dõi kho: ${inventoryRows.length}`);
if (inventoryRows.length === 0) process.exit(0);

const recipeVersions = await prisma.recipe.findMany({ where: { deletedAt: null }, include: { lines: { include: { item: true } } } });
const plan = explodeSalesDemand({
  demands: inventoryRows.map((row) => ({ productCode: row.productCode || "", quantity: row.productQuantity || 0 })),
  recipes: recipeVersions,
  date: dateTo,
  branchCode,
});

const planProductCodes = [
  ...plan.productions.map((step) => step.productCode),
  ...plan.producedSales.map((sale) => sale.productCode),
  ...plan.directSales.map((sale) => sale.productCode),
];
const resolveDepartment = await buildRevenueDepartmentResolver(prisma, planProductCodes);
const revenueSourceByProduct = new Map();
for (const row of inventoryRows) {
  const code = (row.productCode || "").toUpperCase();
  if (code && !revenueSourceByProduct.has(code)) revenueSourceByProduct.set(code, row.revenueSource);
}
const itemRevenueGroups = await prisma.inventoryItem.findMany({
  where: { code: { in: [...new Set(planProductCodes.map((code) => code.toUpperCase()))] } },
  select: { code: true, revenueGroup: true },
});
const revenueGroupByItem = new Map(itemRevenueGroups.map((item) => [item.code.toUpperCase(), item.revenueGroup]));
const departmentWarehouseOf = (productCode) => {
  const code = (productCode || "").toUpperCase();
  const revenueSource = revenueSourceByProduct.get(code) || revenueGroupByItem.get(code) || null;
  const department = resolveDepartment({ revenueSource }) || resolveDepartment({ productCode: code });
  if (department === REVENUE_DEPARTMENT_CODES.KITCHEN && kitchenWarehouseCode) return kitchenWarehouseCode;
  if (department === REVENUE_DEPARTMENT_CODES.BAR && barWarehouseCode) return barWarehouseCode;
  return null;
};

// Tồn hiện tại theo (mã hàng, kho) — mô phỏng trên bản sao trong bộ nhớ.
const balanceRows = await prisma.inventoryBalance.findMany({ include: { item: { select: { code: true, name: true, unit: true } } } });
const stock = new Map();
const nameOf = new Map();
for (const row of balanceRows) {
  stock.set(`${row.item.code.toUpperCase()}|${row.warehouseCode}`, row.quantity);
  nameOf.set(row.item.code.toUpperCase(), `${row.item.name} (${row.item.unit})`);
}
const shortages = [];
const move = (code, warehouse, quantity, direction, context) => {
  const key = `${(code || "").toUpperCase()}|${warehouse}`;
  const before = stock.get(key) || 0;
  const after = direction === "IN" ? before + quantity : before - quantity;
  stock.set(key, after);
  if (after < -0.000001) shortages.push({ code, warehouse, need: quantity, before, missing: -after, context });
};

for (const step of plan.productions) {
  const stepWarehouse = departmentWarehouseOf(step.productCode);
  for (const component of step.components) {
    move(component.item.code, stepWarehouse || warehouseCode, component.quantityBase, "OUT", `NVL của ${step.productCode}`);
  }
  move(step.productCode, stepWarehouse || toWarehouseCode, step.quantityBase, "IN", "nhập chế biến");
}
for (const sale of plan.producedSales) {
  move(sale.productCode, departmentWarehouseOf(sale.productCode) || toWarehouseCode, sale.quantityBase, "OUT", "xuất bán (chế biến)");
}
for (const sale of plan.directSales) {
  move(sale.productCode, departmentWarehouseOf(sale.productCode) || warehouseCode, sale.quantityBase, "OUT", "xuất bán thẳng");
}

await prisma.$disconnect();
if (shortages.length === 0) {
  console.log("Không có mặt hàng nào âm kho — phép rã này sẽ chạy trót lọt.");
  process.exit(0);
}
console.log(`\n${shortages.length} lần âm kho (theo đúng thứ tự phiếu sẽ ghi):\n`);
const num = (value) => Number(value.toFixed(3)).toLocaleString("vi-VN");
for (const row of shortages) {
  console.log(`✘ ${row.code.padEnd(14)} ${row.warehouse.padEnd(10)} cần ${num(row.need).padStart(12)}  tồn ${num(row.before).padStart(12)}  THIẾU ${num(row.missing).padStart(12)}  [${row.context}] ${nameOf.get(row.code.toUpperCase()) || ""}`);
}
process.exit(1);
