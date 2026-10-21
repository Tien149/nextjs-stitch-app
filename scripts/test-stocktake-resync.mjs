/**
 * Chênh lệch kiểm kê chỉ ghi nhận khi chốt giải trình (khách 21/10/2026) — lib/stocktake-resync.ts.
 * Duyệt không ghi phiếu điều chỉnh; bổ sung phiếu TRƯỚC giờ chốt thì sổ sách sống đi theo; Chốt ghi
 * -N/-X theo tồn hệ thống tại giờ chốt; Mở chốt gỡ ra. DB local, kỳ 2033-01, tự dọn.
 * Chạy: npm run test:stocktake-resync
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.ts";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { postStocktakeAdjustments, resyncStocktake, unpostStocktakeAdjustments } from "../lib/stocktake-resync.ts";

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

test("chênh lệch kiểm kê: số sống trước khi chốt, chốt mới ghi phiếu, mở chốt gỡ ra", async (t) => {
  await cleanup();
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  const item = await prisma.inventoryItem.create({ data: { code: ITEM, name: "NVL test resync", unit: "GR", itemType: "RAW_MATERIAL" } });
  await post("TEST-RS-M1", "NHAP_MUA", "02", 100, { itemId: item.id, unitCost: 1000 });

  // Phiếu duyệt theo luật cũ còn sót phiếu xuất kiểm kê 40 (sổ 100, đếm 60): đồng bộ thì gỡ ra.
  const session = await prisma.stocktakeSession.create({
    data: { code: KK, stocktakeDate: at("05"), branchCode: BRANCH, warehouseCode: WH, status: "APPROVED", approvedAt: new Date(),
      lines: { create: [{ itemId: item.id, systemQuantity: 100, actualQuantity: 60, varianceQuantity: -40 }] } },
  });
  await post(`${KK}-X`, "XUAT_KIEM_KE", "05", 40, { itemId: item.id, header: { referenceType: "STOCKTAKE", referenceId: session.id, referenceCode: KK } });
  const live = await resyncStocktake(session.id, "test");
  assert.equal(live.changed, true);
  assert.equal(await balanceQty(item.id), 100, "chưa chốt: chưa ghi nhận chênh lệch");
  assert.equal(await prisma.inventoryTransaction.count({ where: { referenceType: "STOCKTAKE", referenceId: session.id } }), 0);

  // Phiếu kiểm kê của lần rã kiểm dư (NK/BN luật cũ) cũng gỡ khi chưa chốt — NXT không có nhập kiểm kê.
  await post("RA-TEST-RS-1NK", "NHAP_KIEM_KE", "05", 20, { itemId: item.id, header: { referenceType: "PRODUCTION", referenceId: session.id, referenceCode: "RA-TEST-RS" } });
  await resyncStocktake(session.id, "test");
  assert.equal(await balanceQty(item.id), 100, "NK của lần rã bị gỡ");
  assert.equal(await prisma.inventoryTransaction.count({ where: { referenceId: session.id, deletedAt: null, transactionType: { in: ["NHAP_KIEM_KE", "XUAT_KIEM_KE"] } } }), 0);

  // Bổ sung phiếu hủy 30 NGÀY 03 (trước giờ chốt): sổ sống = 70, chênh lệch −10.
  await post("TEST-RS-H1", "XUAT_HUY", "03", 30, { itemId: item.id });
  await resyncStocktake(session.id, "test");
  let line = await prisma.stocktakeLine.findFirst({ where: { stocktakeId: session.id } });
  assert.equal(line.systemQuantity, 70);
  assert.equal(line.varianceQuantity, -10);

  // Phiếu SAU giờ chốt không đổi sổ sách tại giờ chốt.
  await post("TEST-RS-B1", "XUAT_BAN", "10", 5, { itemId: item.id });
  await resyncStocktake(session.id, "test");
  line = await prisma.stocktakeLine.findFirst({ where: { stocktakeId: session.id } });
  assert.equal(line.systemQuantity, 70);

  // Chốt: ghi xuất kiểm kê 10 -> tồn tại giờ chốt = 60, hiện tại = 55.
  const posted = await postStocktakeAdjustments(session.id, "test");
  assert.equal(posted.documents.length, 1);
  const adjustments = await prisma.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: session.id }, include: { lines: true } });
  assert.deepEqual(adjustments.map((doc) => [doc.transactionType, doc.lines[0].quantity]), [["XUAT_KIEM_KE", 10]]);
  assert.equal(await balanceQty(item.id), 55);

  // Giải trình đã chốt: đồng bộ không đụng.
  await prisma.stocktakeExplanation.create({ data: { sourceType: "SESSION", sourceId: session.id, sourceCode: KK, branchCode: BRANCH, warehouseCode: WH, periodTo: at("05"), status: "LOCKED", lines: [] } });
  assert.equal((await resyncStocktake(session.id, "test")).skipped, "giải trình đã chốt");

  // Mở chốt: gỡ phiếu, tồn về chưa ghi nhận.
  const unposted = await unpostStocktakeAdjustments(session.id, "test");
  assert.equal(unposted.changed, true);
  assert.equal(await balanceQty(item.id), 65);
});
