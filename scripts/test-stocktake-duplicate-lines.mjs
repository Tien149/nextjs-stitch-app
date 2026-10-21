/**
 * Một mã đếm ở hai dòng của phiếu kiểm (khách 21/10/2026: Gà Tre 0 + 7, giải trình lệch 7) — tính là
 * MỘT mã: sổ sách một lần, số đếm cộng lại; Chốt ghi đúng tổng đếm − tồn. DB local, tự dọn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.ts";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { postStocktakeAdjustments, resyncStocktake } from "../lib/stocktake-resync.ts";
import { snapshotExplanation } from "../lib/stocktake-explanation.ts";

const ITEM = "TEST-DUP-LINE";
const WH = "KHO_TEST_DUP";
const KK = "KK-TEST-DUP";
const at = (day) => new Date(`2033-03-${day}T10:00:00+07:00`);

async function cleanup() {
  const item = await prisma.inventoryItem.findFirst({ where: { code: ITEM, deletedAt: undefined } });
  if (!item) return;
  const lines = await prisma.inventoryTransactionLine.findMany({ where: { itemId: item.id }, select: { transactionId: true } });
  const ids = [...new Set(lines.map((line) => line.transactionId))];
  await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "sourceId" = ANY(${ids}))`;
  await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "sourceId" = ANY(${ids})`;
  await prisma.$executeRaw`DELETE FROM "InventoryTransactionLine" WHERE "transactionId" = ANY(${ids})`;
  await prisma.$executeRaw`DELETE FROM "InventoryTransaction" WHERE id = ANY(${ids})`;
  await prisma.$executeRaw`DELETE FROM "StocktakeLine" WHERE "itemId" = ${item.id}`;
  await prisma.$executeRaw`DELETE FROM "StocktakeSession" WHERE code = ${KK}`;
  await prisma.$executeRaw`DELETE FROM "InventoryBalance" WHERE "itemId" = ${item.id}`;
  await prisma.$executeRaw`DELETE FROM "InventoryItem" WHERE id = ${item.id}`;
}

test("mã đếm ở hai dòng: sổ sách một lần, đếm cộng lại", async (t) => {
  await cleanup();
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  const item = await prisma.inventoryItem.create({ data: { code: ITEM, name: "Gà tre test", unit: "CON", itemType: "RAW_MATERIAL" } });
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "TEST-DUP-M1", transactionType: "NHAP_MUA", transactionDate: at("02"), branchCode: "HCM", warehouseCode: WH, createdBy: "test",
    lines: [{ itemId: item.id, inputQuantity: 7, inputUnitCode: "", inputUnitCost: 100 }],
  }));
  const session = await prisma.stocktakeSession.create({
    data: { code: KK, stocktakeDate: at("05"), branchCode: "HCM", warehouseCode: WH, status: "APPROVED", approvedAt: new Date(),
      lines: { create: [
        { itemId: item.id, systemQuantity: 7, actualQuantity: 0, varianceQuantity: -7 },
        { itemId: item.id, systemQuantity: 7, actualQuantity: 7, varianceQuantity: 0 },
      ] } },
  });
  await resyncStocktake(session.id, "test");
  const lines = await prisma.stocktakeLine.findMany({ where: { stocktakeId: session.id } });
  assert.equal(lines.reduce((sum, line) => sum + line.systemQuantity, 0), 7, "sổ sách cộng các dòng = một lần tồn");
  assert.equal(lines.reduce((sum, line) => sum + line.varianceQuantity, 0), 0);

  const snapshot = await snapshotExplanation(prisma, "SESSION", session.id);
  const own = snapshot.lines.filter((line) => line.itemId === item.id);
  assert.equal(own.length, 1, "giải trình một dòng cho một mã");
  assert.equal(own[0].closing, 7);
  assert.equal(own[0].counted, 7);
  assert.equal(own[0].variance, 0);

  const posted = await postStocktakeAdjustments(session.id, "test");
  assert.equal(posted.documents.length, 0, "đếm đủ 7 thì không có chênh lệch");
});
