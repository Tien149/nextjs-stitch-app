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
import { ensureRevenueComponentCategories, postJournalEntry, syncAccountingPeriod } from "../lib/accounting.ts";
import { REVENUE_SVC_CATEGORY_CODE, REVENUE_VAT_CATEGORY_CODE, revenuePosJournalLines } from "../lib/revenue-pos-journal.ts";
import { REVENUE_SERVICE_CATEGORY } from "../lib/revenue-source.ts";

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
// Nhóm doanh thu không theo dõi tồn kho: phụ thu / dịch vụ (mã REV_PHU của khách).
const SERVICE_CODE = "DT_RGTEST_PHU";
const SERVICE_ITEM = "ET_RGTEST_SVC";
const batchIds = [];
const seededCategories = [];
let seededBranch = false;
let autoServiceCategory = false;

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
  for (const [code, name, keywords, skipInventory] of [
    [FOOD_CODE, "Doanh Thu Bếp", null, false],
    [BAR_CODE, "Doanh Thu Bar", null, false],
    [COMBO_CODE, "Doanh thu combo", "Set combo; COMBO TRUA", false],
    // Phụ thu dịch vụ: bán ra không rút gì khỏi kho nên khai cờ không theo dõi tồn kho.
    [SERVICE_CODE, "Doanh Thu Phụ Thu", "DỊCH VỤ, PHỤ THU", true],
  ]) {
    const existing = await prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code, deletedAt: null } });
    if (existing) continue;
    await prisma.masterDataItem.create({ data: { type: "REVENUE_EXPENSE_CATEGORY", code, name, matchKeywords: keywords, skipInventory, group: "REVENUE_SOURCE", status: "ACTIVE" } });
    seededCategories.push(code);
  }
  // Món ăn đã khai nhóm doanh thu trong danh mục; món uống cố tình để trống để test đường lùi.
  await prisma.inventoryItem.create({ data: { code: FOOD_ITEM, name: "Món ăn test", unit: "Phần", itemType: "FINISHED", minStock: 0, revenueGroup: FOOD_CODE } });
  await prisma.inventoryItem.create({ data: { code: DRINK_ITEM, name: "Món uống test", unit: "Ly", itemType: "FINISHED", minStock: 0 } });
}

const ZERO_BRANCH = "RGTBR";

async function cleanup() {
  for (const batchId of batchIds.splice(0).reverse()) {
    await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    await prisma.importBatch.deleteMany({ where: { id: batchId } }).catch((error) => console.error("don batch", batchId, error.message));
  }
  // Lần chạy trước hỏng giữa chừng có thể để lại batch/bút toán: dọn theo tên file và cửa hàng test.
  const staleRows = await prisma.revenueImportRow.findMany({ where: { OR: [{ productCode: { contains: "RGTEST" } }, { branchCode: ZERO_BRANCH }] }, select: { id: true } });
  const staleEntries = await prisma.journalEntry.findMany({ where: { sourceType: "REVENUE_POS", sourceId: { in: staleRows.map((row) => row.id) } }, select: { id: true } });
  // JournalLine xoá theo (onDelete: Cascade) khi xoá JournalEntry.
  await prisma.journalEntry.deleteMany({ where: { id: { in: staleEntries.map((entry) => entry.id) } } });
  await prisma.importBatch.deleteMany({ where: { OR: [{ fileName: { startsWith: "pos-rgtest" } }, { fileName: { startsWith: "item-rgtest" } }] } });
  const items = await prisma.inventoryItem.findMany({ where: { code: { contains: "RGTEST" } }, select: { id: true } });
  const itemIds = items.map((item) => item.id);
  await prisma.itemUnitConversion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { code: { contains: "RGTEST" } } });
  if (seededCategories.length > 0) {
    await prisma.masterDataItem.deleteMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: { in: seededCategories } } });
  }
  // REV_SERVICE do import tự tạo trong test "file ghi Dịch vụ mà chưa có danh mục": chỉ dọn khi
  // chính test này sinh ra (DB đã có sẵn từ trước thì giữ).
  if (autoServiceCategory) {
    await prisma.masterDataItem.deleteMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: REVENUE_SERVICE_CATEGORY.code } });
    autoServiceCategory = false;
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

test("nhóm doanh thu không theo dõi tồn kho: doanh thu vẫn ghi nhận, dòng bán không vào hàng chờ rã", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    posLine(SERVICE_ITEM, "Phụ thu dịch vụ không gian", "DỊCH VỤ", 700),
    posLine(FOOD_ITEM, "Món ăn test", "ĐỒ ĂN", 100),
  ], "Import doanh thu", "pos-rgtest-service.xlsx"));

  const service = await prisma.revenueImportRow.findFirst({
    where: { productCode: SERVICE_ITEM },
    select: { revenueSource: true, netAmount: true, inventoryStatus: true },
  });
  // Doanh thu vẫn về đúng nhóm và đủ tiền — chỉ phần kho là được miễn.
  assert.equal(service.revenueSource, SERVICE_CODE);
  assert.equal(service.netAmount, 700);
  assert.equal(service.inventoryStatus, "NOT_REQUIRED", "dòng dịch vụ không được vào hàng chờ rã nguyên liệu");
  // Mã phụ thu không phải mặt hàng kho: import không được đẻ thêm "thành phẩm" cho nó.
  const item = await prisma.inventoryItem.findUnique({ where: { code: SERVICE_ITEM } });
  assert.equal(item, null);

  const food = await prisma.revenueImportRow.findFirst({ where: { productCode: FOOD_ITEM }, select: { inventoryStatus: true } });
  assert.equal(food.inventoryStatus, "PENDING", "món ăn vẫn phải chờ rã như cũ");
});

test("khai cờ không theo dõi tồn kho sau khi đã import: bấm chuẩn hoá là thả khỏi hàng chờ rã", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  // Lúc import chưa ai khai cờ — đúng tình huống dữ liệu cũ đang kẹt ở hàng chờ: mã phụ thu
  // buộc phải nằm trong danh mục mặt hàng thì file POS mới qua được bước kiểm.
  await prisma.masterDataItem.updateMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: SERVICE_CODE },
    data: { skipInventory: false },
  });
  await prisma.inventoryItem.create({ data: { code: SERVICE_ITEM, name: "Phụ thu dịch vụ", unit: "Lần", itemType: "FINISHED", minStock: 0 } });
  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    posLine(SERVICE_ITEM, "Phụ thu dịch vụ không gian", "DỊCH VỤ", 700),
  ], "Import doanh thu", "pos-rgtest-service-late.xlsx"));
  const before = await prisma.revenueImportRow.findFirst({ where: { productCode: SERVICE_ITEM }, select: { id: true, inventoryStatus: true } });
  assert.equal(before.inventoryStatus, "PENDING");

  await prisma.masterDataItem.updateMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: SERVICE_CODE },
    data: { skipInventory: true },
  });

  // Chạy thử: đếm đúng một dòng sẽ thả, và tuyệt đối chưa ghi gì.
  const preview = await normalizeRevenueSources(prisma, { apply: false });
  assert.equal(preview.releasedRows, 1);
  const stillPending = await prisma.revenueImportRow.findUnique({ where: { id: before.id }, select: { inventoryStatus: true } });
  assert.equal(stillPending.inventoryStatus, "PENDING");

  const applied = await normalizeRevenueSources(prisma, { apply: true });
  assert.equal(applied.releasedRows, 1);
  const after = await prisma.revenueImportRow.findUnique({ where: { id: before.id }, select: { inventoryStatus: true } });
  assert.equal(after.inventoryStatus, "NOT_REQUIRED");

  // Chạy lại lần nữa không còn gì để thả.
  const again = await normalizeRevenueSources(prisma, { apply: false });
  assert.equal(again.releasedRows, 0);
});

test("ghi sổ doanh thu POS: nhóm doanh thu = Doanh thu − Giảm giá, SVC và thuế GTGT tách dòng riêng, chuẩn hoá không ghi đè", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  const headers = ["Ngày", "Cửa hàng", "Mã hàng", "Tên hàng", "Số lượng", "Hình thức bán", "Nhóm doanh thu", "Nguồn tiền", "Doanh thu", "Giảm giá", "SVC", "VAT", "Tổng doanh thu"];
  // Mặt hàng chưa khai nhóm doanh thu + file ghi chữ lạ chưa ai khai: giữ chữ thô, lát nữa khai
  // từ khoá rồi chuẩn hoá để thấy chuẩn hoá chỉ đổi dòng nhóm doanh thu của món.
  const JOURNAL_ITEM = "SP_RGTEST_JOURNAL";
  await prisma.inventoryItem.create({ data: { code: JOURNAL_ITEM, name: "Món test ghi sổ", unit: "Phần", itemType: "FINISHED", minStock: 0 } });
  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(headers, [
    ["01/08/2026", BRANCH, JOURNAL_ITEM, "Món test ghi sổ", 2, "Tại chỗ", "Tiệc cưới RGTEST", "FDSTIENMAT", 500000, 50000, 22500, 37800, 510300],
  ], "Import doanh thu", "pos-rgtest-journal.xlsx"));
  const row = await prisma.revenueImportRow.findFirst({ where: { productCode: JOURNAL_ITEM } });
  assert.equal(row.revenueSource, "Tiệc cưới RGTEST");
  assert.equal(row.netAmount, 510300, "Tổng tiền (số lên Tiền về đủ chưa) giữ nguyên");

  // Ghi sổ đúng như syncAccountingPeriod làm cho từng dòng doanh thu.
  await ensureRevenueComponentCategories();
  const posted = await postJournalEntry({
    entryDate: row.saleDate, branchCode: row.branchCode, sourceType: "REVENUE_POS", sourceId: row.id,
    sourceCode: row.externalRef, description: `Doanh thu ${row.externalRef}`, createdBy: session.name,
    lines: revenuePosJournalLines(row),
  });
  if (posted === "SKIPPED_LOCKED") { t.skip("kỳ 2026-08 của NME đang khoá trên DB này"); return; }
  const readLines = async () => {
    const entry = await prisma.journalEntry.findUnique({
      where: { sourceType_sourceId: { sourceType: "REVENUE_POS", sourceId: row.id } },
      include: { lines: { include: { account: true } } },
    });
    return entry.lines.map((line) => ({ account: line.account.code, debit: line.debit, credit: line.credit, categoryCode: line.categoryCode })).sort((a, b) => a.credit - b.credit);
  };
  assert.deepEqual(await readLines(), [
    { account: "1121", debit: 510300, credit: 0, categoryCode: null },
    { account: "511", debit: 0, credit: 22500, categoryCode: REVENUE_SVC_CATEGORY_CODE },
    { account: "511", debit: 0, credit: 37800, categoryCode: REVENUE_VAT_CATEGORY_CODE },
    { account: "511", debit: 0, credit: 450000, categoryCode: "Tiệc cưới RGTEST" },
  ]);
  // Danh mục cho hai dòng tách riêng phải có tên để P&L không hiện mã trơ.
  const svc = await prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: REVENUE_SVC_CATEGORY_CODE, deletedAt: null } });
  assert.ok(svc && svc.skipInventory === true && svc.group === "REVENUE_SOURCE", "Doanh thu SVC là nhóm doanh thu không theo dõi tồn kho");

  // Khai từ khoá rồi chuẩn hoá: chỉ dòng nhóm doanh thu của món đổi mã, SVC / thuế giữ nguyên.
  await prisma.masterDataItem.updateMany({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: COMBO_CODE },
    data: { matchKeywords: "Set combo; COMBO TRUA; Tiệc cưới RGTEST" },
  });
  const applied = await normalizeRevenueSources(prisma, { apply: true });
  assert.ok(applied.journalLines >= 1);
  assert.deepEqual(await readLines(), [
    { account: "1121", debit: 510300, credit: 0, categoryCode: null },
    { account: "511", debit: 0, credit: 22500, categoryCode: REVENUE_SVC_CATEGORY_CODE },
    { account: "511", debit: 0, credit: 37800, categoryCode: REVENUE_VAT_CATEGORY_CODE },
    { account: "511", debit: 0, credit: 450000, categoryCode: COMBO_CODE },
  ]);
});

test("file ghi Dịch vụ mà chưa có danh mục phụ thu: import tự tạo Doanh thu phụ thu, không vào hàng chờ rã, không tạo mặt hàng", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();
  // Xoá danh mục phụ thu seed sẵn để mô phỏng DB chưa ai khai nhóm Dịch vụ.
  await prisma.masterDataItem.deleteMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: SERVICE_CODE } });
  seededCategories.splice(seededCategories.indexOf(SERVICE_CODE), 1);
  const preExisting = await prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: REVENUE_SERVICE_CATEGORY.code, deletedAt: null } });
  if (preExisting) { t.skip("DB này đã có REV_SERVICE sẵn"); return; }
  autoServiceCategory = true;

  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    posLine(SERVICE_ITEM, "Phụ thu dịch vụ không gian", "DỊCH VỤ", 5400000),
  ], "Import doanh thu", "pos-rgtest-service-auto.xlsx"));

  const row = await prisma.revenueImportRow.findFirst({ where: { productCode: SERVICE_ITEM }, select: { revenueSource: true, inventoryStatus: true, departmentCode: true } });
  assert.equal(row.revenueSource, REVENUE_SERVICE_CATEGORY.code, "DỊCH VỤ phải quy về danh mục Doanh thu phụ thu vừa tự tạo");
  assert.equal(row.inventoryStatus, "NOT_REQUIRED");
  assert.equal(row.departmentCode, null, "dịch vụ không thuộc Bếp hay Bar");
  const category = await prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: REVENUE_SERVICE_CATEGORY.code, deletedAt: null } });
  assert.equal(category.name, "Doanh thu phụ thu");
  assert.equal(category.skipInventory, true);
  assert.equal(category.group, "REVENUE_SOURCE", "phải là nhóm doanh thu để lên dòng 1 của P&L");
  assert.equal(await prisma.inventoryItem.findUnique({ where: { code: SERVICE_ITEM } }), null, "mã dịch vụ không được thành mặt hàng kho");
});

test("mã món chưa có trong danh mục: file có Tên hàng thì tự tạo thành phẩm kèm nhóm doanh thu, vẫn chờ rã", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup();
  await seed();

  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    posLine(NEW_ITEM, "Bún chả giò thịt nướng", "ĐỒ ĂN", 285000),
  ], "Import doanh thu", "pos-rgtest-new-item.xlsx"));

  const item = await prisma.inventoryItem.findUnique({ where: { code: NEW_ITEM } });
  assert.ok(item, "thành phẩm mới phải được tạo từ Tên hàng trong file");
  assert.equal(item.name, "Bún chả giò thịt nướng");
  assert.equal(item.itemType, "FINISHED");
  assert.equal(item.revenueGroup, FOOD_CODE, "nhóm doanh thu quy từ ĐỒ ĂN gán luôn cho mặt hàng mới");
  const row = await prisma.revenueImportRow.findFirst({ where: { productCode: NEW_ITEM }, select: { inventoryStatus: true, productQuantity: true, departmentCode: true } });
  assert.equal(row.inventoryStatus, "PENDING", "số lượng bán chờ nút Rã nguyên liệu để sinh phiếu Xuất bán");
  assert.equal(row.productQuantity, 1);
  assert.equal(row.departmentCode, "KIT");

  // Không có cột Tên hàng thì không có gì để tạo mặt hàng: vẫn chặn như cũ.
  const headersNoName = POS_HEADERS.filter((header) => header !== "Tên hàng");
  const template = getImportTemplate("REVENUE_POS", "REVENUE_POS_RAW_V1");
  const parsed = await parseImportFile(fileFrom(headersNoName, [
    ["01/08/2026", BRANCH, "SP_RGTEST_NONAME", 1, "Tại chỗ", "ĐỒ ĂN", "FDSTIENMAT", 100, 0, 0, 100],
  ], "Import doanh thu", "pos-rgtest-noname.xlsx"), template);
  await validateImportResult(parsed, "REVENUE_POS", session, {});
  assert.match(parsed.rows[0].errors.join(" / "), /Khong tim thay ma mon POS SP_RGTEST_NONAME/);
});

test("ghi sổ cả kỳ: dòng 0 đồng (đá, cà phê free) không làm hỏng kỳ, vẫn nằm ở hàng chờ rã", async (t) => {
  // Cửa hàng riêng để syncAccountingPeriod chỉ đụng dữ liệu của test này.
  const ZERO_ITEM = "SP_RGTEST_ZERO";
  const seededZeroBranch = !(await prisma.masterDataItem.findFirst({ where: { type: "BRANCH", code: ZERO_BRANCH, deletedAt: null } }));
  if (seededZeroBranch) await prisma.masterDataItem.create({ data: { type: "BRANCH", code: ZERO_BRANCH, name: "Cửa hàng test ghi sổ", status: "ACTIVE" } });
  t.after(async () => {
    await cleanup();
    if (seededZeroBranch) await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: ZERO_BRANCH } });
    await prisma.$disconnect();
  });
  await cleanup();
  await seed();

  const line = (code, name, group, qty, amount) => ["01/08/2026", ZERO_BRANCH, code, name, qty, "Tại chỗ", group, "FDSTIENMAT", amount, 0, 0, amount];
  await runImport("REVENUE_POS", "REVENUE_POS_RAW_V1", fileFrom(POS_HEADERS, [
    line(ZERO_ITEM, "Đá", "ĐỒ UỐNG", 3, 0),
    line(FOOD_ITEM, "Món ăn test", "ĐỒ ĂN", 1, 100),
  ], "Import doanh thu", "pos-rgtest-zero.xlsx"));

  const summary = await syncAccountingPeriod("2026-08", ZERO_BRANCH, session.name);
  if (summary.skipped > 0 && summary.created + summary.updated === 0) {
    const zeroRow = await prisma.revenueImportRow.findFirst({ where: { productCode: ZERO_ITEM }, select: { inventoryStatus: true } });
    assert.equal(zeroRow.inventoryStatus, "PENDING");
    t.skip("kỳ 2026-08 của cửa hàng test đang khoá trên DB này"); return;
  }
  // Kỳ còn các bút toán khác (khấu hao, phân bổ...) cũng báo SKIPPED nên không đếm đúng 1;
  // chốt bằng chính bút toán của hai dòng.
  assert.ok(summary.skipped >= 1, "dòng 0 đồng phải được bỏ qua chứ không làm hỏng kỳ");
  const foodRow = await prisma.revenueImportRow.findFirst({ where: { productCode: FOOD_ITEM, branchCode: ZERO_BRANCH }, select: { id: true } });
  assert.ok(await prisma.journalEntry.findFirst({ where: { sourceType: "REVENUE_POS", sourceId: foodRow.id } }), "dòng có tiền vẫn ghi sổ bình thường");
  const zeroRow = await prisma.revenueImportRow.findFirst({ where: { productCode: ZERO_ITEM }, select: { id: true, inventoryStatus: true, productQuantity: true } });
  assert.equal(zeroRow.inventoryStatus, "PENDING", "đá vẫn phải rã kho dù không thu tiền");
  assert.equal(zeroRow.productQuantity, 3);
  assert.equal(await prisma.journalEntry.findFirst({ where: { sourceType: "REVENUE_POS", sourceId: zeroRow.id } }), null, "dòng 0 đồng không có bút toán");
});
