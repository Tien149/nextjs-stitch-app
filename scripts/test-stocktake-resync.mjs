/**
 * Chênh lệch kiểm kê tự cập nhật tới khi chốt (khách 21/10/2026) — lib/stocktake-resync.ts.
 * Duyệt xong mà bổ sung phiếu TRƯỚC giờ chốt thì sổ sách + phiếu -N/-X đi theo; phiếu sau giờ chốt
 * không đổi gì; giải trình đã chốt thì số đứng yên. DB local, kỳ 2033-01, tự dọn.
 * Chạy: npm run test:stocktake-resync
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.ts";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { resyncStocktake } from "../lib/stocktake-resync.ts";

const ITEM = "TEST-RESYNC-NVL";
const WH = "KHO_HCM";
const BRANCH = "HCM";
const KK = "KK-TEST-RESYNC";
const at = (day) => new Date(`2033-01-${day}T10:00:00+07:00`);

async function cleanup() {
  const item = await prisma.inventoryItem.findFirst({ where: { code: ITEM, deletedAt: undefined } });
  if (item) {
    const lines = await prisma.inventoryTransactionLine.findMany({ where: { itemId: item.id }, select: { transactionId: true } });
    const ids = [...new Set(lines.map((line) => line.transactionId))];
    await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "sourceId" = ANY(${ids}))`;
    await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "sourceId" = ANY(${ids})`;
    await prisma.$executeRaw`DELETE FROM "InventoryTransactionLine" WHERE "transactionId" = ANY(${ids})`;
    await prisma.$executeRaw`DELETE FROM "InventoryTransaction" WHERE id = ANY(${ids})`;
    await prisma.$executeRaw`DELETE FROM "StocktakeExplanation" WHERE "sourceCode" = ${KK}`;
    await prisma.$executeRaw`DELETE FROM "StocktakeLine" WHERE "itemId" = ${item.id}`;
    await prisma.$executeRaw`DELETE FROM "StocktakeSession" WHERE code = ${KK}`;
    await prisma.$executeRaw`DELETE FROM "InventoryBalance" WHERE "itemId" = ${item.id}`;
    await prisma.$executeRaw`DELETE FROM "InventoryItem" WHERE id = ${item.id}`;
  }
}

const post = (code, transactionType, day, quantity, extra = {}) => prisma.$transaction((tx) => postInventoryTransaction(tx, {
  code, transactionType, transactionDate: at(day), branchCode: BRANCH, warehouseCode: WH, createdBy: "test",
  lines: [{ itemId: extra.itemId, inputQuantity: quantity, inputUnitCode: "", inputUnitCost: extra.unitCost ?? 0 }], ...extra.header,
}));
const balanceQty = async (itemId) => (await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode: WH } } }))?.quantity;

test("chênh lệch kiểm kê chưa chốt đi theo phiếu bổ sung trước giờ chốt", async (t) => {
  await cleanup();
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  const item = await prisma.inventoryItem.create({ data: { code: ITEM, name: "NVL test resync", unit: "GR", itemType: "RAW_MATERIAL" } });
  await post("TEST-RS-M1", "NHAP_MUA", "02", 100, { itemId: item.id, unitCost: 1000 });

  // Duyệt kiểm kê lúc sổ = 100, đếm 60 -> xuất kiểm kê 40.
  const session = await prisma.stocktakeSession.create({
    data: { code: KK, stocktakeDate: at("05"), branchCode: BRANCH, warehouseCode: WH, status: "APPROVED", approvedAt: new Date(),
      lines: { create: [{ itemId: item.id, systemQuantity: 100, actualQuantity: 60, varianceQuantity: -40 }] } },
  });
  await post(`${KK}-X`, "XUAT_KIEM_KE", "05", 40, { itemId: item.id, header: { referenceType: "STOCKTAKE", referenceId: session.id, referenceCode: KK } });
  assert.equal(await balanceQty(item.id), 60);

  // Bổ sung phiếu hủy 30 NGÀY 03 (trước giờ chốt) sau khi đã duyệt: sổ đúng = 70, thiếu thật = 10.
  await post("TEST-RS-H1", "XUAT_HUY", "03", 30, { itemId: item.id });
  assert.equal(await balanceQty(item.id), 30, "trước khi đồng bộ: trừ hai lần");
  const first = await resyncStocktake(session.id, "test");
  assert.equal(first.changed, true);
  assert.equal(await balanceQty(item.id), 60, "tồn tại giờ chốt đúng bằng số đếm");
  const line = await prisma.stocktakeLine.findFirst({ where: { stocktakeId: session.id } });
  assert.equal(line.systemQuantity, 70);
  assert.equal(line.varianceQuantity, -10);
  const adjustments = await prisma.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: session.id }, include: { lines: true } });
  assert.deepEqual(adjustments.map((doc) => [doc.transactionType, doc.lines[0].quantity]), [["XUAT_KIEM_KE", 10]]);

  // Phiếu SAU giờ chốt không đổi chênh lệch.
  await post("TEST-RS-B1", "XUAT_BAN", "10", 5, { itemId: item.id });
  assert.equal((await resyncStocktake(session.id, "test")).changed, false);
  assert.equal(await balanceQty(item.id), 55);

  // Giải trình đã chốt: số đứng yên dù có phiếu bổ sung trước giờ chốt.
  await prisma.stocktakeExplanation.create({ data: { sourceType: "SESSION", sourceId: session.id, sourceCode: KK, branchCode: BRANCH, warehouseCode: WH, periodTo: at("05"), status: "LOCKED", lines: [] } });
  await post("TEST-RS-H2", "XUAT_HUY", "04", 5, { itemId: item.id });
  const locked = await resyncStocktake(session.id, "test");
  assert.equal(locked.changed, false);
  assert.equal(locked.skipped, "giải trình đã chốt");
});
