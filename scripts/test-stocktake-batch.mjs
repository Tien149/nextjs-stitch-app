/**
 * Duyệt GỘP phiếu đếm theo vị trí, sổ sách tại GIỜ CHỐT, mở lại rồi duyệt lại với giờ chốt khác
 * (khách chốt 28/09/2026) — lib/stocktake-batch.ts.
 *
 * Chạy trên DB thật với cửa hàng KKTB riêng, ngày năm 2031, tự dọn sạch kể cả khi test hỏng.
 * Chạy: npm run test:stocktake-batch
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { approveStocktakeBatch, buildBatchPreview, reopenStocktakeBatch } from "../lib/stocktake-batch.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "KKTB";
const WH = "KBEP_KKTB";
const GA = "NVL_KKTB_GA";
const BO = "NVL_KKTB_BO";
const HOP = "BB_KKTB_HOP";
const SOT = "BTP_KKTB_SOT";
/** Giờ Việt Nam -> Date (UTC+7). */
const vn = (value) => new Date(`${value}:00.000+07:00`);

async function balanceOf(code) {
  const item = await prisma.inventoryItem.findUnique({ where: { code } });
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: WH } } });
  return balance?.quantity || 0;
}

async function cleanup() {
  const itemIds = (await prisma.inventoryItem.findMany({ where: { code: { in: [GA, BO, HOP, SOT] } }, select: { id: true } })).map((row) => row.id);
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeSession.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeBatch.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeLocation.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.itemUnitConversion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: WH } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH } });
}

const ids = {};

async function seed() {
  await cleanup();
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test kiểm kê gộp", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: WH, name: "Kho bếp KKTB", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  for (const [code, itemType, unit] of [[GA, "RAW_MATERIAL", "KG"], [BO, "RAW_MATERIAL", "KG"], [HOP, "PACKAGING", "CAI"], [SOT, "SEMI_FINISHED", "KG"]]) {
    ids[code] = (await prisma.inventoryItem.create({ data: { code, name: code, itemType, unit } })).id;
  }
  await prisma.itemUnitConversion.create({ data: { itemId: ids[GA], unitCode: "THUNG", conversionRate: 10, isDefaultPurchase: true } });
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM_KKTB_1", transactionType: "NHAP_MUA", transactionDate: vn("2031-01-01T08:00"), branchCode: BRANCH, warehouseCode: WH,
    lines: [
      { itemId: ids[GA], inputQuantity: 20, inputUnitCode: "KG", inputUnitCost: 100 },
      { itemId: ids[BO], inputQuantity: 5, inputUnitCode: "KG", inputUnitCost: 200 },
      { itemId: ids[HOP], inputQuantity: 100, inputUnitCode: "CAI", inputUnitCost: 1 },
      { itemId: ids[SOT], inputQuantity: 3, inputUnitCode: "KG", inputUnitCost: 50 },
    ],
  }));
  // Bán trước giờ chốt 11h và sau giờ chốt.
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "XB_KKTB_1", transactionType: "XUAT_BAN", transactionDate: vn("2031-01-02T10:00"), branchCode: BRANCH, warehouseCode: WH,
    lines: [{ itemId: ids[GA], inputQuantity: 3, inputUnitCode: "KG" }],
  }));
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "XB_KKTB_2", transactionType: "XUAT_BAN", transactionDate: vn("2031-01-02T15:00"), branchCode: BRANCH, warehouseCode: WH,
    lines: [{ itemId: ids[GA], inputQuantity: 2, inputUnitCode: "KG" }],
  }));
  for (const [code, sortOrder] of [["TU_DONG", 1], ["TU_MAT", 2]]) {
    await prisma.stocktakeLocation.create({ data: { branchCode: BRANCH, warehouseCode: WH, code, name: code, sortOrder } });
  }
  const sheet = (code, locationCode, lines) => prisma.stocktakeSession.create({
    data: {
      code, branchCode: BRANCH, warehouseCode: WH, locationCode, stocktakeDate: vn("2031-01-02T11:00"), status: "PENDING", createdBy: "test",
      lines: { create: lines.map(([itemCode, actualQuantity]) => ({ itemId: ids[itemCode], systemQuantity: 0, actualQuantity, varianceQuantity: 0 })) },
    },
  });
  ids.sheet1 = (await sheet("KK_KKTB_1", "TU_DONG", [[GA, 12]])).id;
  ids.sheet2 = (await sheet("KK_KKTB_2", "TU_MAT", [[GA, 4], [HOP, 90]])).id;
}

test.before(seed);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("tổng hợp: cộng các vị trí, sổ sách lấy tại giờ chốt, mã không ai đếm = 0, bỏ BTP", async () => {
  const preview = await prisma.$transaction((tx) => buildBatchPreview(tx, { stocktakeIds: [ids.sheet1, ids.sheet2], cutoffAt: vn("2031-01-02T11:00") }));
  const row = (code) => preview.rows.find((candidate) => candidate.itemCode === code);
  assert.deepEqual(row(GA).breakdown, { TU_DONG: 12, TU_MAT: 4 });
  assert.equal(row(GA).bookQuantity, 17, "20 mua − 3 bán lúc 10h; phần bán 15h sau giờ chốt không tính");
  assert.equal(row(GA).varianceQuantity, -1);
  assert.equal(row(BO).notCounted, true);
  assert.equal(row(BO).varianceQuantity, -5);
  assert.equal(row(HOP).varianceQuantity, -10);
  assert.equal(row(SOT), undefined, "bán thành phẩm không thuộc kiểm kê theo vị trí");
});

test("duyệt gộp: một bộ phiếu điều chỉnh mang đúng giờ chốt, tồn hiện tại trừ đúng phần chênh", async () => {
  const outcome = await prisma.$transaction((tx) => approveStocktakeBatch(tx, { stocktakeIds: [ids.sheet1, ids.sheet2], cutoffAt: vn("2031-01-02T11:00"), approvedBy: "test" }));
  ids.batch1 = outcome.batch.id;
  assert.deepEqual(outcome.documents, [`${outcome.batch.code}-X`]);
  const doc = await prisma.inventoryTransaction.findUnique({ where: { code: `${outcome.batch.code}-X` }, include: { lines: true } });
  assert.equal(doc.transactionDate.getTime(), vn("2031-01-02T11:00").getTime());
  assert.equal(doc.lines.length, 3);
  assert.equal(await balanceOf(GA), 14, "20 − 3 − 2 − 1 thiếu");
  assert.equal(await balanceOf(BO), 0);
  assert.equal(await balanceOf(HOP), 90);
  const sessions = await prisma.stocktakeSession.findMany({ where: { id: { in: [ids.sheet1, ids.sheet2] } } });
  assert.ok(sessions.every((session) => session.status === "APPROVED" && session.batchId === ids.batch1));
  const lines = await prisma.stocktakeBatchLine.findMany({ where: { batchId: ids.batch1 } });
  assert.equal(lines.length, 3);
  assert.equal(outcome.batch.shortageValue, -(1 * 100 + 5 * 200 + 10 * 1));
});

test("mở lại đợt: đảo phiếu điều chỉnh dù đã có phiếu phát sinh sau, phiếu đếm về Chờ duyệt", async () => {
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "XB_KKTB_3", transactionType: "XUAT_BAN", transactionDate: vn("2031-01-02T18:00"), branchCode: BRANCH, warehouseCode: WH,
    lines: [{ itemId: ids[HOP], inputQuantity: 5, inputUnitCode: "CAI" }],
  }));
  await prisma.$transaction((tx) => reopenStocktakeBatch(tx, { batchId: ids.batch1, reopenedBy: "test" }));
  assert.equal(await balanceOf(GA), 15);
  assert.equal(await balanceOf(BO), 5);
  assert.equal(await balanceOf(HOP), 95);
  const batch = await prisma.stocktakeBatch.findUnique({ where: { id: ids.batch1 } });
  assert.equal(batch.status, "REOPENED");
  const sessions = await prisma.stocktakeSession.findMany({ where: { id: { in: [ids.sheet1, ids.sheet2] } } });
  assert.ok(sessions.every((session) => session.status === "PENDING" && session.batchId === null));
});

test("duyệt lại với giờ chốt khác: sổ sách tính lại theo giờ mới", async () => {
  const outcome = await prisma.$transaction((tx) => approveStocktakeBatch(tx, { stocktakeIds: [ids.sheet1, ids.sheet2], cutoffAt: vn("2031-01-02T16:00"), approvedBy: "test" }));
  const lines = await prisma.stocktakeBatchLine.findMany({ where: { batchId: outcome.batch.id }, include: { item: true } });
  const line = (code) => lines.find((candidate) => candidate.item.code === code);
  assert.equal(line(GA).bookQuantity, 15, "giờ chốt 16h đã trừ cả phần bán 15h");
  assert.equal(line(GA).varianceQuantity, 1, "đếm 16 > sổ 15: thừa 1");
  assert.equal(line(GA).unitCost, 100);
  assert.equal(line(HOP).bookQuantity, 100, "phần bán hộp lúc 18h nằm sau giờ chốt");
  assert.equal(await balanceOf(GA), 16);
  assert.equal(await balanceOf(HOP), 85, "95 − 10 thiếu");
});

test("không duyệt được đợt có giờ chốt sớm hơn đợt đã duyệt của cùng kho", async () => {
  const extra = await prisma.stocktakeSession.create({
    data: { code: "KK_KKTB_3", branchCode: BRANCH, warehouseCode: WH, locationCode: "TU_DONG", status: "PENDING", lines: { create: [{ itemId: ids[GA], systemQuantity: 0, actualQuantity: 1, varianceQuantity: 0 }] } },
  });
  await assert.rejects(
    prisma.$transaction((tx) => approveStocktakeBatch(tx, { stocktakeIds: [extra.id], cutoffAt: vn("2031-01-02T12:00"), approvedBy: "test" })),
    /Mở lại đợt đó trước/,
  );
});
