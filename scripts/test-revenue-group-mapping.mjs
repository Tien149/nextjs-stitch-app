/**
 * Chốt luật quy "Nhóm doanh thu" trong file về MÃ danh mục Thu (lib/revenue-source.ts):
 * file của khách ghi chữ "ĐỒ ĂN"/"ĐỒ UỐNG" chứ không ghi mã, trước đây chữ đó chui thẳng vào
 * categoryCode của dòng Có 511 nên doanh thu nằm ở "Chưa phân loại" và không suy được Bếp/Bar.
 *
 * Chạy trên DB thật với mã *_RGTEST và tự dọn sạch kể cả khi test hỏng giữa chừng.
 *
 * Chạy: npm run test:revenue-group
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport, rollbackImportBatch } from "../lib/import-commit.ts";
import { normalizeRevenueSources } from "../lib/revenue-source-normalize.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const session = { name: "test-rgroup", role: "Admin", allowedBranches: ["ALL"] };
const BRANCH = "NME";
const FOOD_ITEM = "SP_RGTEST_FOOD";
const DRINK_ITEM = "SP_RGTEST_DRINK";
const NEW_ITEM = "SP_RGTEST_NEW";
// Danh mục Thu của khách: Bếp = đồ ăn, Bar = đồ uống (ảnh màn hình 30/08/2026).
const FOOD_CODE = "REV_FOOD";
const BAR_CODE = "REV_BAR";
const COMBO_CODE = "DT_RGTEST_COMBO";
const batchIds = [];
const seededCategories = [];
let seededBranch = false;

function fileFrom(headers, rows, sheetName, fileName) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], fileName);
}

async function runImport(importType, templateCode, file) {
  const template = getImportTemplate(importType, templateCode);
  const parsed = await parseImportFile(file, template);
  await validateImportResult(parsed, importType, session, {});
  const errors = parsed.rows.flatMap((row) => row.errors);
  assert.deepEqual(errors, [], `file phải sạch lỗi: ${errors.join(" / ")}`);
  const batch = await commitImport({
    importType, templateCode, fileName: file.name,
    uploadedBy: session.name, mapping: parsed.mapping, rows: parsed.rows,
  });
  batchIds.push(batch.id);
  return { parsed, batch };
}

async function seed() {
  const branch = await prisma.masterDataItem.findFirst({ where: { type: "BRANCH", code: BRANCH, deletedAt: null } });
  if (!branch) {
    await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "NAM MÊ Kitchen & Bar", status: "ACTIVE" } });
    seededBranch = true;
  }
  // Danh mục thứ ba cố tình đặt mã vô nghĩa và chỉ khai TỪ KHOÁ: đây là đường người dùng tự
  // dạy hệ thống đọc file mà không cần đụng mã nguồn.
  for (const [code, name, keywords] of [
    [FOOD_CODE, "Doanh Thu Bếp", null],
    [BAR_CODE, "Doanh Thu Bar", null],
    [COMBO_CODE, "Doanh thu combo", "Set combo; COMBO TRUA"],
  ]) {
    const existing = await prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code, deletedAt: null } });
    if (existing) continue;
    await prisma.masterDataItem.create({ data: { type: "REVENUE_EXPENSE_CATEGORY", code, name, matchKeywords: keywords, group: "REVENUE_SOURCE", status: "ACTIVE" } });
    seededCategories.push(code);
  }
  // Món ăn đã khai nhóm doanh thu trong danh mục; món uống cố tình để trống để test đường lùi.
  await prisma.inventoryItem.create({ data: { code: FOOD_ITEM, name: "Món ăn test", unit: "Phần", itemType: "FINISHED", minStock: 0, revenueGroup: FOOD_CODE } });
  await prisma.inventoryItem.create({ data: { code: DRINK_ITEM, name: "Món uống test", unit: "Ly", itemType: "FINISHED", minStock: 0 } });
}

async function cleanup() {
  for (const batchId of batchIds.reverse()) {
    await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    await prisma.importBatch.deleteMany({ where: { id: batchId } }).catch(() => undefined);
  }
  const items = await prisma.inventoryItem.findMany({ where: { code: { contains: "RGTEST" } }, select: { id: true } });
  const itemIds = items.map((item) => item.id);
  await prisma.itemUnitConversion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { code: { contains: "RGTEST" } } });
  if (seededCategories.length > 0) {
    await prisma.masterDataItem.deleteMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: { in: seededCategories } } });
  }
  if (seededBranch) await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH, name: "NAM MÊ Kitchen & Bar" } });
}

const POS_HEADERS = ["Ngày", "Cửa hàng", "Mã hàng", "Tên hàng", "Số lượng", "Hình thức bán", "Nhóm doanh thu", "Nguồn tiền", "Doanh thu", "SVC", "VAT", "Tổng doanh thu"];
const posLine = (itemCode, itemName, revenueGroup, amount) =>
  ["01/08/2026", BRANCH, itemCode, itemName, 1, "Tại chỗ", revenueGroup, "FDSTIENMAT", amount, 0, 0, amount];

test("nhóm doanh thu: chữ trong file quy về mã danh mục, không quy được thì lấy danh mục mặt hàng", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    posLine(FOOD_ITEM, "Món ăn test", "ĐỒ ĂN", 100),
    posLine(DRINK_ITEM, "Món uống test", "ĐỒ UỐNG", 200),
    posLine(FOOD_ITEM, "Món ăn test", "-", 300),
    posLine(DRINK_ITEM, "Món uống test", "Set combo", 400),
    posLine(DRINK_ITEM, "Món uống test", "Tiệc cưới", 500),
  ], "Import doanh thu", "pos-rgtest.xlsx"));

  const rows = await prisma.revenueImportRow.findMany({
    where: { productCode: { in: [FOOD_ITEM, DRINK_ITEM] } },
    select: { productCode: true, netAmount: true, revenueSource: true, departmentCode: true },
  });
  const byAmount = new Map(rows.map((row) => [row.netAmount, row]));
  assert.equal(rows.length, 5, "năm tổ hợp nhóm doanh thu khác nhau không bị gộp");

  // "ĐỒ ĂN" -> mã danh mục Thu của bếp, và suy luôn bộ phận KIT cho báo cáo tỷ trọng lương.
  assert.equal(byAmount.get(100).revenueSource, FOOD_CODE);
  assert.equal(byAmount.get(100).departmentCode, "KIT");
  assert.equal(byAmount.get(200).revenueSource, BAR_CODE);
  assert.equal(byAmount.get(200).departmentCode, "BAR");
  // Ô "-" là ô trống trá hình: lấy nhóm doanh thu khai ở danh mục mặt hàng.
  assert.equal(byAmount.get(300).revenueSource, FOOD_CODE);
  assert.equal(byAmount.get(300).departmentCode, "KIT");
  // Chữ lạ nhưng đã được khai làm TỪ KHOÁ của một danh mục -> về đúng danh mục đó.
  assert.equal(byAmount.get(400).revenueSource, COMBO_CODE);
  // Mã danh mục "DT_RGTEST_COMBO" chẳng nói lên bếp hay bar, và tên cũng vậy -> không đoán bừa.
  assert.equal(byAmount.get(400).departmentCode, null);
  // Chữ lạ chưa ai khai, mã hàng cũng chưa gán nhóm -> giữ chữ thô, không bịa.
  assert.equal(byAmount.get(500).revenueSource, "Tiệc cưới");
  assert.equal(byAmount.get(500).departmentCode, null);

  // revenueSource chính là categoryCode của dòng Có 511 khi chạy ghi sổ (lib/accounting.ts),
  // nên chỉ cần chốt nó là mã danh mục Thu đang hoạt động thì P&L mới cắt đúng nhóm.
  const category = await prisma.masterDataItem.findFirst({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: byAmount.get(100).revenueSource, status: "ACTIVE", deletedAt: null },
    select: { name: true },
  });
  assert.equal(category.name, "Doanh Thu Bếp");
});

test("danh mục mặt hàng: cột Nhóm doanh thu ghi chữ cũng lưu thành mã", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  await runImport("INVENTORY_ITEM", "INVENTORY_ITEM_STANDARD_V1", fileFrom(
    ["Mã mặt hàng", "Tên mặt hàng", "Loại hàng", "Nhóm doanh thu", "Đơn vị tính"],
    [[NEW_ITEM, "Món mới test", "FINISHED", "Đồ uống", "Ly"]],
    "Danh muc mat hang", "item-rgtest.xlsx",
  ));

  const item = await prisma.inventoryItem.findUnique({ where: { code: NEW_ITEM }, select: { revenueGroup: true } });
  assert.equal(item.revenueGroup, BAR_CODE);
});

test("sửa từ khoá trên danh mục rồi bấm chuẩn hoá: doanh thu đã import chạy lại đúng nhóm", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    posLine(DRINK_ITEM, "Món uống test", "Tiệc cưới", 500),
  ], "Import doanh thu", "pos-rgtest-normalize.xlsx"));

  const before = await prisma.revenueImportRow.findFirst({ where: { productCode: DRINK_ITEM }, select: { id: true, revenueSource: true } });
  assert.equal(before.revenueSource, "Tiệc cưới", "lúc import chưa ai khai từ khoá này");

  // Đúng thao tác của người dùng trên màn hình Cài đặt: thêm từ khoá cho danh mục.
  await prisma.masterDataItem.updateMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: COMBO_CODE },
    data: { matchKeywords: "Set combo; COMBO TRUA; Tiệc cưới" },
  });

  // Bấm "Kiểm tra": chỉ đếm, không ghi. Con số phải đúng 1 dòng — nếu đụng dữ liệu khác thì
  // dừng ngay ở đây trước khi ghi bất cứ thứ gì.
  const preview = await normalizeRevenueSources(prisma, { apply: false });
  assert.equal(preview.applied, false);
  assert.equal(preview.changedRows, 1);
  assert.deepEqual(preview.groups.map((group) => group.revenueSource), [COMBO_CODE]);
  const stillOld = await prisma.revenueImportRow.findUnique({ where: { id: before.id }, select: { revenueSource: true } });
  assert.equal(stillOld.revenueSource, "Tiệc cưới", "chạy thử tuyệt đối không được ghi gì");

  // Bấm "Chuẩn hoá": ghi thật.
  const applied = await normalizeRevenueSources(prisma, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.changedRows, 1);
  const after = await prisma.revenueImportRow.findUnique({ where: { id: before.id }, select: { revenueSource: true } });
  assert.equal(after.revenueSource, COMBO_CODE);

  // Chạy lại lần nữa không đổi gì thêm.
  const again = await normalizeRevenueSources(prisma, { apply: false });
  assert.equal(again.changedRows, 0);
});
