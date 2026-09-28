/**
 * Rã BOM cho điều chuyển bán thành phẩm + phần kiểm dư bán thành phẩm (khách chốt 28/09/2026):
 *   - điều chuyển BTP có định lượng vào hàng chờ, nút Rã trừ nguyên liệu ở KHO XUẤT theo TOÀN BỘ
 *     số chuyển rồi định giá lại phiếu điều chuyển theo giá vốn chế biến;
 *   - kiểm kê đếm DƯ BTP không nhập kiểm kê mà chờ rã, nút Rã trừ nguyên liệu ở kho được kiểm
 *     đúng phần dư; kiểm thiếu / NVL dư vẫn đi phiếu kiểm kê như cũ;
 *   - rã lại (rerunExplosions) gỡ và rã lại đúng các phiếu đó.
 *
 * Chạy trên DB thật với mã *_EXT, cửa hàng EXT riêng, ngày năm 2031 (không đụng doanh thu chờ
 * rã của cửa hàng thật) và tự dọn sạch kể cả khi test hỏng giữa chừng.
 *
 * Chạy: npm run test:explosion-sources
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport, rollbackImportBatch } from "../lib/import-commit.ts";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { postStockTransfer } from "../lib/inventory-transfer.ts";
import { executeExplosion, rerunExplosions } from "../lib/inventory-explosion.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const session = { name: "test-explosion-sources", role: "Admin", allowedBranches: ["ALL"] };
const BRANCH = "EXT";
const KITCHEN = "KBEP_EXT";
const BAR = "KBAR_EXT";
const NVL = "NVL_EXT_THIT";
const NVL_ROAST = "NVL_EXT_GIAVI";
const BTP = "BTP_EXT_SOT";
const BTP_NO_RECIPE = "BTP_EXT_KHONGDL";
const day = (value) => new Date(`${value}T00:00:00.000Z`);
const batchIds = [];

function fileFrom(headers, rows, fileName) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Kiem ke");
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], fileName);
}

async function importStocktake(rows) {
  const template = getImportTemplate("STOCKTAKE", "STOCKTAKE_STANDARD_V1");
  const file = fileFrom(["Ngay kiem ke", "Cua hang", "Kho", "Ma hang", "Ton thuc te", "Don gia"], rows, "kk-ext.xlsx");
  const parsed = await parseImportFile(file, template);
  await validateImportResult(parsed, "STOCKTAKE", session, {});
  const errors = parsed.rows.flatMap((row) => row.errors);
  assert.deepEqual(errors, [], `file phải sạch lỗi: ${errors.join(" / ")}`);
  const batch = await commitImport({
    importType: "STOCKTAKE", templateCode: template.code, fileName: file.name,
    uploadedBy: session.name, mapping: parsed.mapping, rows: parsed.rows,
  });
  batchIds.push(batch.id);
  return prisma.stocktakeSession.findFirst({
    where: { branchCode: BRANCH, createdBy: session.name, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { lines: true },
  });
}

async function balanceOf(itemCode, warehouseCode) {
  const item = await prisma.inventoryItem.findUnique({ where: { code: itemCode } });
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode } } });
  return { quantity: balance?.quantity || 0, averageCost: balance?.averageCost || 0 };
}

async function runDocs(runCode) {
  return prisma.inventoryTransaction.findMany({
    where: { referenceType: "PRODUCTION", referenceCode: runCode, deletedAt: null },
    include: { lines: { include: { item: true } } },
    orderBy: { code: "asc" },
  });
}

async function cleanup() {
  for (const batchId of batchIds) {
    await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    await prisma.importBatch.deleteMany({ where: { id: batchId } }).catch(() => undefined);
  }
  const itemIds = (await prisma.inventoryItem.findMany({ where: { code: { in: [NVL, NVL_ROAST, BTP, BTP_NO_RECIPE] } }, select: { id: true } })).map((row) => row.id);
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeSession.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.recipe.deleteMany({ where: { productCode: { in: [BTP, BTP_NO_RECIPE] } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: { in: [KITCHEN, BAR] } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH } });
}

async function seed() {
  await cleanup();
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test rã BOM", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: KITCHEN, name: "Kho bếp EXT", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: BAR, name: "Kho bar EXT", branch: BRANCH, group: "BAR", status: "ACTIVE" } });
  const nvl = await prisma.inventoryItem.create({ data: { code: NVL, name: "Thịt test", itemType: "RAW_MATERIAL", unit: "KG" } });
  const spice = await prisma.inventoryItem.create({ data: { code: NVL_ROAST, name: "Gia vị test", itemType: "RAW_MATERIAL", unit: "KG" } });
  await prisma.inventoryItem.create({ data: { code: BTP, name: "Sốt test", itemType: "SEMI_FINISHED", unit: "KG" } });
  await prisma.inventoryItem.create({ data: { code: BTP_NO_RECIPE, name: "BTP không định lượng", itemType: "SEMI_FINISHED", unit: "KG" } });
  // 1 kg sốt = 0,5 kg thịt + 0,1 kg gia vị.
  await prisma.recipe.create({
    data: {
      code: "DL_EXT_SOT", productCode: BTP, productName: "Sốt test", unit: "KG",
      effectiveFrom: day("2030-01-01"),
      lines: { create: [{ itemId: nvl.id, quantity: 0.5 }, { itemId: spice.id, quantity: 0.1 }] },
    },
  });
  // Kho bếp mua 20 kg thịt @ 100.000 và 5 kg gia vị @ 50.000 → 1 kg sốt = 55.000.
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM_EXT_1", transactionType: "NHAP_MUA", transactionDate: day("2031-01-01"),
    branchCode: BRANCH, warehouseCode: KITCHEN, createdBy: session.name,
    lines: [
      { itemId: nvl.id, inputQuantity: 20, inputUnitCode: "KG", inputUnitCost: 100000 },
      { itemId: spice.id, inputQuantity: 5, inputUnitCode: "KG", inputUnitCost: 50000 },
    ],
  }));
}

const explodeInput = (dateFrom, dateTo) => ({
  branchCode: BRANCH, warehouseCode: KITCHEN, toWarehouseCode: KITCHEN,
  kitchenWarehouseCode: KITCHEN, barWarehouseCode: BAR,
  dateFrom: day(dateFrom), dateTo: day(dateTo), note: "test", createdBy: session.name,
});

test("rã BOM cho điều chuyển và kiểm dư bán thành phẩm", async (t) => {
  await seed();
  t.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // --- Điều chuyển 4 kg sốt (có định lượng) + 1 kg thịt từ bếp sang bar ---
  const btp = await prisma.inventoryItem.findUnique({ where: { code: BTP } });
  const nvl = await prisma.inventoryItem.findUnique({ where: { code: NVL } });
  const transfer = await prisma.$transaction((tx) => postStockTransfer(tx, {
    code: "DCK_EXT_1", transactionDate: day("2031-01-05"), branchCode: BRANCH,
    warehouseCode: KITCHEN, toWarehouseCode: BAR, createdBy: session.name,
    lines: [
      { itemId: btp.id, inputQuantity: 4, inputUnitCode: "KG" },
      { itemId: nvl.id, inputQuantity: 1, inputUnitCode: "KG" },
    ],
  }));
  assert.equal(transfer.transaction.explosionStatus, "PENDING", "điều chuyển có BTP có định lượng phải vào hàng chờ rã");
  assert.equal((await balanceOf(BTP, KITCHEN)).quantity, -4, "trước khi rã kho bếp âm đúng số chuyển");

  // Điều chuyển chỉ có NVL / BTP không định lượng thì không có gì để rã.
  const plain = await prisma.$transaction(async (tx) => {
    const noRecipe = await tx.inventoryItem.findUnique({ where: { code: BTP_NO_RECIPE } });
    return postStockTransfer(tx, {
      code: "DCK_EXT_2", transactionDate: day("2031-01-05"), branchCode: BRANCH,
      warehouseCode: KITCHEN, toWarehouseCode: BAR, createdBy: session.name,
      lines: [{ itemId: noRecipe.id, inputQuantity: 1, inputUnitCode: "KG" }],
    });
  });
  assert.equal(plain.transaction.explosionStatus, null);

  // --- Rã lần 1: chỉ có điều chuyển trong khoảng ngày ---
  const first = await prisma.$transaction((tx) => executeExplosion(tx, explodeInput("2031-01-01", "2031-01-10")), { timeout: 60000 });
  assert.equal(first.kind, "POSTED");
  assert.equal(first.sources.length, 1);
  const firstDocs = await runDocs(first.runCode);
  const issue = firstDocs.find((doc) => doc.transactionType === "XUAT_CHE_BIEN");
  const receipt = firstDocs.find((doc) => doc.transactionType === "NHAP_CHE_BIEN");
  assert.equal(issue.warehouseCode, KITCHEN, "nguyên liệu trừ ở KHO XUẤT của điều chuyển");
  assert.equal(issue.transactionDate.toISOString(), day("2031-01-05").toISOString(), "phiếu chế biến mang ngày của phiếu điều chuyển");
  assert.equal(issue.lines.find((line) => line.item.code === NVL).quantity, 2, "4 kg sốt × 0,5 kg thịt");
  assert.ok(Math.abs(issue.lines.find((line) => line.item.code === NVL_ROAST).quantity - 0.4) < 1e-9);
  assert.equal(receipt.lines[0].quantity, 4);
  assert.equal(firstDocs.filter((doc) => doc.transactionType === "XUAT_BAN").length, 0, "điều chuyển không xuất bán");
  assert.equal((await balanceOf(BTP, KITCHEN)).quantity, 0, "rã xong kho bếp hết âm");
  assert.equal((await balanceOf(NVL, KITCHEN)).quantity, 20 - 1 - 2);

  const repriced = await prisma.inventoryTransaction.findUnique({ where: { id: transfer.transaction.id }, include: { lines: { include: { item: true } } } });
  assert.equal(repriced.explosionStatus, `POSTED:${first.runCode}`);
  const btpLine = repriced.lines.find((line) => line.item.code === BTP);
  assert.ok(Math.abs(btpLine.unitCost - 55000) < 0.01, `điều chuyển định giá lại theo giá vốn chế biến (được ${btpLine.unitCost})`);
  assert.ok(Math.abs((await balanceOf(BTP, BAR)).averageCost - 55000) < 0.01, "kho nhận mang giá vốn chế biến");

  // --- Kiểm kê: đếm 3 kg sốt (sổ 0) + thịt thiếu 1 kg ---
  const stocktake = await importStocktake([
    ["2031-01-20", BRANCH, KITCHEN, BTP, 3, ""],
    ["2031-01-20", BRANCH, KITCHEN, NVL, 16, ""],
  ]);
  assert.equal(stocktake.explosionStatus, "PENDING", "kiểm dư BTP có định lượng vào hàng chờ rã");
  const stocktakeDocs = await prisma.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: stocktake.id } });
  assert.deepEqual(stocktakeDocs.map((doc) => doc.transactionType), ["XUAT_KIEM_KE"], "phần dư BTP không nhập kiểm kê, NVL thiếu vẫn xuất kiểm kê");
  assert.equal((await balanceOf(BTP, KITCHEN)).quantity, 0, "chưa rã thì sốt chưa lên kho");

  const second = await prisma.$transaction((tx) => executeExplosion(tx, explodeInput("2031-01-11", "2031-01-31")), { timeout: 60000 });
  assert.equal(second.kind, "POSTED");
  const secondDocs = await runDocs(second.runCode);
  const stocktakeIssue = secondDocs.find((doc) => doc.transactionType === "XUAT_CHE_BIEN");
  assert.equal(stocktakeIssue.warehouseCode, KITCHEN);
  assert.equal(stocktakeIssue.lines.find((line) => line.item.code === NVL).quantity, 1.5, "3 kg dư × 0,5 kg thịt");
  assert.deepEqual(await balanceOf(BTP, KITCHEN).then((row) => row.quantity), 3, "rã xong tồn sốt đúng số đếm");
  assert.ok(Math.abs((await balanceOf(BTP, KITCHEN)).averageCost - 55000) < 0.01, "sốt kiểm dư có giá vốn từ nguyên liệu");
  assert.equal((await prisma.stocktakeSession.findUnique({ where: { id: stocktake.id } })).explosionStatus, `POSTED:${second.runCode}`);

  // Không còn gì chờ: bấm lại thì rỗng.
  const again = await prisma.$transaction((tx) => executeExplosion(tx, explodeInput("2031-01-01", "2031-01-31")), { timeout: 60000 });
  assert.equal(again.kind, "EMPTY");

  // --- Rã lại lần rã kiểm kê: gỡ phiếu cũ, rã lại đúng phiếu kiểm kê đó với mã mới ---
  const [rerun] = await prisma.$transaction((tx) => rerunExplosions(tx, [{ runCode: second.runCode, branchCode: BRANCH, date: day("2031-01-31"), productCodes: [] }], session.name), { timeout: 60000 });
  assert.ok(rerun.newRunCode && rerun.newRunCode !== second.runCode, "rã lại ra mã lần rã mới");
  assert.equal((await runDocs(second.runCode)).length, 0, "phiếu của lần rã cũ đã gỡ");
  assert.equal((await prisma.stocktakeSession.findUnique({ where: { id: stocktake.id } })).explosionStatus, `POSTED:${rerun.newRunCode}`);
  assert.equal((await balanceOf(BTP, KITCHEN)).quantity, 3, "rã lại không nhân đôi tồn");
  assert.equal((await balanceOf(NVL, KITCHEN)).quantity, 20 - 1 - 2 - 1 - 1.5);
});
