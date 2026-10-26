/**
 * Bán thành phẩm trong kiểm kê theo vị trí (khách 26/10/2026): BTP vào được form; duyệt gộp so sổ
 * sách BTP CHỈ khi có trên phiếu đếm (không có thì bỏ qua); kiểm DƯ BTP có định lượng không nhập
 * kiểm kê mà đưa đợt vào hàng chờ rã BOM (như phiếu kiểm cả kho, luật 28/09/2026).
 *
 * Chạy trên DB local với cửa hàng KKBT, năm 2032, tự dọn. Chạy: npm run test:stocktake-batch-btp
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { approveStocktakeBatch, buildBatchPreview, reopenStocktakeBatch } from "../lib/stocktake-batch.ts";
import { loadPendingExplosionSources, releaseExplosionSources } from "../lib/explosion-sources.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "KKBT";
const WH = "KBEP_KKBT";
const NVL = "NVL_KKBT_HANH";
const BTP = "BTP_KKBT_HANHPHI";
const BTP_NO_RECIPE = "BTP_KKBT_KHONGDL";
const vn = (value) => new Date(`${value}:00.000+07:00`);
const ids = {};

async function cleanup() {
  const itemIds = (await prisma.inventoryItem.findMany({ where: { code: { in: [NVL, BTP, BTP_NO_RECIPE] } }, select: { id: true } })).map((row) => row.id);
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeSession.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeBatch.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeLocation.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.recipe.deleteMany({ where: { productCode: BTP } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.masterDataItem.deleteMany({ where: { OR: [{ type: "WAREHOUSE", code: WH }, { type: "BRANCH", code: BRANCH }] } });
}

async function balanceOf(code) {
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: ids[code], warehouseCode: WH } } });
  return balance?.quantity || 0;
}

test.before(async () => {
  await cleanup();
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test BTP kiểm kê", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: WH, name: "Kho bếp KKBT", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  for (const [code, itemType] of [[NVL, "RAW_MATERIAL"], [BTP, "SEMI_FINISHED"], [BTP_NO_RECIPE, "SEMI_FINISHED"]]) {
    ids[code] = (await prisma.inventoryItem.create({ data: { code, name: code, itemType, unit: "KG" } })).id;
  }
  // Chỉ BTP_KKBT_HANHPHI có định lượng (rã được); BTP còn lại không có thì đi như nguyên liệu.
  await prisma.recipe.create({ data: { code: "DL_KKBT_1", productCode: BTP, productName: BTP, unit: "KG", lines: { create: [{ itemId: ids[NVL], quantity: 2 }] } } });
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM_KKBT_1", transactionType: "NHAP_MUA", transactionDate: vn("2032-01-01T08:00"), branchCode: BRANCH, warehouseCode: WH,
    lines: [
      { itemId: ids[NVL], inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 100 },
      { itemId: ids[BTP], inputQuantity: 2, inputUnitCode: "KG", inputUnitCost: 300 },
      { itemId: ids[BTP_NO_RECIPE], inputQuantity: 4, inputUnitCode: "KG", inputUnitCost: 50 },
    ],
  }));
  await prisma.stocktakeLocation.create({ data: { branchCode: BRANCH, warehouseCode: WH, code: "TU_NGOT", name: "Tủ ngọt", sortOrder: 1 } });
  // Phiếu đếm KHÔNG có BTP_KKBT_KHONGDL → mã đó bỏ qua, không tính đếm 0.
  ids.sheet = (await prisma.stocktakeSession.create({
    data: {
      code: "KK_KKBT_1", branchCode: BRANCH, warehouseCode: WH, locationCode: "TU_NGOT", stocktakeDate: vn("2032-01-02T11:00"), status: "PENDING", createdBy: "test",
      lines: { create: [[NVL, 10], [BTP, 5]].map(([code, actualQuantity]) => ({ itemId: ids[code], systemQuantity: 0, actualQuantity, varianceQuantity: 0 })) },
    },
  })).id;
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("xem trước: BTP có trên phiếu được so sổ sách và đánh dấu chờ rã; BTP không đếm thì bỏ qua", async () => {
  const preview = await prisma.$transaction((tx) => buildBatchPreview(tx, { stocktakeIds: [ids.sheet], cutoffAt: vn("2032-01-02T11:00") }));
  const row = (code) => preview.rows.find((candidate) => candidate.itemCode === code);
  assert.equal(row(BTP).varianceQuantity, 3);
  assert.equal(row(BTP).deferToExplosion, true);
  assert.equal(row(NVL).varianceQuantity, 0);
  assert.equal(row(BTP_NO_RECIPE), undefined, "BTP không có trên phiếu đếm nào: bỏ qua, không tính đếm 0");
});

test("duyệt gộp: kiểm dư BTP không nhập kiểm kê, đợt vào hàng chờ rã BOM", async () => {
  const outcome = await prisma.$transaction((tx) => approveStocktakeBatch(tx, { stocktakeIds: [ids.sheet], cutoffAt: vn("2032-01-02T11:00"), approvedBy: "test" }));
  ids.batch = outcome.batch.id;
  assert.deepEqual(outcome.documents, [], "không có phiếu nhập kiểm kê cho phần dư BTP");
  assert.equal(await balanceOf(BTP), 2, "tồn BTP chưa đổi — chờ rã BOM mới nhập");
  const batch = await prisma.stocktakeBatch.findUnique({ where: { id: ids.batch } });
  assert.equal(batch.explosionStatus, "PENDING");

  const sources = await prisma.$transaction((tx) => loadPendingExplosionSources(tx, { branchCode: BRANCH, dateFrom: new Date(0), rangeEnd: vn("2032-12-31T23:59") }));
  const source = sources.find((candidate) => candidate.id === ids.batch);
  assert.equal(source.kind, "STOCKTAKE_BATCH");
  assert.equal(source.warehouseCode, WH);
  assert.deepEqual(source.demands, [{ productCode: BTP, quantity: 3 }]);
});

test("mở lại đợt chờ rã: xoá trạng thái chờ; đợt đã rã thì chặn mở lại", async () => {
  await prisma.$transaction((tx) => reopenStocktakeBatch(tx, { batchId: ids.batch, reopenedBy: "test" }));
  assert.equal((await prisma.stocktakeBatch.findUnique({ where: { id: ids.batch } })).explosionStatus, null);

  const again = await prisma.$transaction((tx) => approveStocktakeBatch(tx, { stocktakeIds: [ids.sheet], cutoffAt: vn("2032-01-02T12:00"), approvedBy: "test" }));
  await prisma.stocktakeBatch.update({ where: { id: again.batch.id }, data: { explosionStatus: "POSTED:RA-KKBT-1" } });
  await assert.rejects(() => prisma.$transaction((tx) => reopenStocktakeBatch(tx, { batchId: again.batch.id, reopenedBy: "test" })), /RA-KKBT-1/);

  // Hoàn tác lần rã trả đợt về hàng chờ, cùng danh sách với phiếu kiểm cả kho.
  const released = await prisma.$transaction((tx) => releaseExplosionSources(tx, "RA-KKBT-1"));
  assert.ok(released.stocktakeIds.includes(again.batch.id));
  assert.equal((await prisma.stocktakeBatch.findUnique({ where: { id: again.batch.id } })).explosionStatus, "PENDING");
});
