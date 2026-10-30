/**
 * Bán thành phẩm trong kiểm kê theo vị trí (khách 26/10/2026): BTP vào được form; duyệt gộp so sổ
 * sách MỌI mã của kho — BTP không ai đếm là đếm 0 (khách 30/10/2026); kiểm DƯ BTP có định lượng không nhập
 * kiểm kê mà đưa đợt vào hàng chờ rã BOM (như phiếu kiểm cả kho, luật 28/09/2026).
 *
 * Chạy trên DB local với cửa hàng KKBT, năm 2032, tự dọn. Chạy: npm run test:stocktake-batch-btp
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction, reverseStockEffect } from "../lib/inventory-stock.ts";
import { resyncStocktakeBatch } from "../lib/stocktake-resync.ts";
import { loadStocktakeSource } from "../lib/stocktake-explanation.ts";
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
  // Phiếu đếm KHÔNG có BTP_KKBT_KHONGDL → mã đó tính đếm 0 (thiếu 4 kg).
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

test("xem trước: BTP có trên phiếu được so sổ sách và đánh dấu chờ rã; BTP không đếm thì đếm 0", async () => {
  const preview = await prisma.$transaction((tx) => buildBatchPreview(tx, { stocktakeIds: [ids.sheet], cutoffAt: vn("2032-01-02T11:00") }));
  const row = (code) => preview.rows.find((candidate) => candidate.itemCode === code);
  assert.equal(row(BTP).varianceQuantity, 3);
  assert.equal(row(BTP).deferToExplosion, true);
  assert.equal(row(NVL).varianceQuantity, 0);
  assert.equal(row(BTP_NO_RECIPE).notCounted, true, "BTP không có trên phiếu đếm nào: đếm 0");
  assert.equal(row(BTP_NO_RECIPE).varianceQuantity, -4);
});

test("duyệt gộp: kiểm dư BTP không nhập kiểm kê, đợt vào hàng chờ rã BOM", async () => {
  const outcome = await prisma.$transaction((tx) => approveStocktakeBatch(tx, { stocktakeIds: [ids.sheet], cutoffAt: vn("2032-01-02T11:00"), approvedBy: "test" }));
  ids.batch = outcome.batch.id;
  assert.deepEqual(outcome.documents, [`${outcome.batch.code}-X`], "chỉ phiếu xuất cho BTP không đếm, không nhập kiểm kê phần dư BTP");
  assert.equal(await balanceOf(BTP_NO_RECIPE), 0);
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
  ids.again = again.batch.id;
  await prisma.stocktakeBatch.update({ where: { id: again.batch.id }, data: { explosionStatus: "POSTED:RA-KKBT-1" } });
  await assert.rejects(() => prisma.$transaction((tx) => reopenStocktakeBatch(tx, { batchId: again.batch.id, reopenedBy: "test" })), /RA-KKBT-1/);

  // Hoàn tác lần rã trả đợt về hàng chờ, cùng danh sách với phiếu kiểm cả kho.
  const released = await prisma.$transaction((tx) => releaseExplosionSources(tx, "RA-KKBT-1"));
  assert.ok(released.stocktakeIds.includes(again.batch.id));
  assert.equal((await prisma.stocktakeBatch.findUnique({ where: { id: again.batch.id } })).explosionStatus, "PENDING");
});

test("rã kiểm dư sau khi duyệt: -N/-X ghi lại để mọi mã về đúng số đếm; hoàn tác rã thì về như lúc duyệt", async () => {
  // Giả lập lần rã RA-KKBT-1 (dư BTP 3 kg × 2 kg hành) — phiếu mang giờ chốt, referenceId = đợt.
  const cutoffAt = vn("2032-01-02T12:00");
  const production = { transactionDate: cutoffAt, branchCode: BRANCH, warehouseCode: WH, referenceType: "PRODUCTION", referenceId: ids.again, referenceCode: "RA-KKBT-1" };
  const docs = await prisma.$transaction(async (tx) => [
    await postInventoryTransaction(tx, { ...production, code: "RA-KKBT-1-1X", transactionType: "XUAT_CHE_BIEN", lines: [{ itemId: ids[NVL], inputQuantity: 6, inputUnitCode: "KG", inputUnitCost: 0 }] }),
    await postInventoryTransaction(tx, { ...production, code: "RA-KKBT-1-1N", transactionType: "NHAP_CHE_BIEN", lines: [{ itemId: ids[BTP], inputQuantity: 3, inputUnitCode: "KG", inputUnitCost: 200 }] }),
  ]);
  await prisma.stocktakeBatch.update({ where: { id: ids.again }, data: { explosionStatus: "POSTED:RA-KKBT-1" } });
  assert.equal(await balanceOf(NVL), 4, "trước khi sửa: hành đã đếm 10 bị rã trừ thêm 6");

  const synced = await resyncStocktakeBatch(ids.again, "test");
  assert.equal(synced.changed, true);
  assert.equal(await balanceOf(NVL), 10, "hành về đúng số đếm");
  assert.equal(await balanceOf(BTP), 5, "BTP = số đếm, không nhập kiểm kê thêm");
  const source = await loadStocktakeSource(prisma, "BATCH", ids.again);
  const line = (code) => source.countLines.find((row) => row.itemCode === code);
  assert.equal(line(BTP).closing, 5, "Giải trình / Kết quả: BTP dư đã rã hết chênh");
  assert.equal(line(NVL).closing, 4, "hành: sổ sách sau rã, chênh +6 = phần làm ra BTP dư");
  assert.equal((await resyncStocktakeBatch(ids.again, "test")).changed, false, "chạy lại không đổi gì");

  // Hoàn tác rã: đợt về chờ rã, -N bù hành bị gỡ, kiểm dư BTP vẫn hoãn.
  await prisma.$transaction(async (tx) => {
    for (const doc of docs) {
      await reverseStockEffect(tx, doc);
      await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
    }
  });
  await prisma.$transaction((tx) => releaseExplosionSources(tx, "RA-KKBT-1"));
  await resyncStocktakeBatch(ids.again, "test");
  assert.equal(await balanceOf(NVL), 10);
  assert.equal(await balanceOf(BTP), 2, "kiểm dư BTP chờ rã: chưa nhập kiểm kê");
  assert.equal(await balanceOf(BTP_NO_RECIPE), 0, "BTP không đếm vẫn về 0");
  const left = await prisma.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: ids.again, deletedAt: null }, include: { lines: true } });
  assert.deepEqual(left.flatMap((doc) => doc.lines.map((row) => row.itemId)), [ids[BTP_NO_RECIPE]], "chỉ còn phiếu xuất của BTP không đếm");
});
