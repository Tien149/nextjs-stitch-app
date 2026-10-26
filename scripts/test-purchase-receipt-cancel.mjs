/**
 * "Huỷ lần nhận" hàng PO (khách 26/10/2026) — lib/purchase-receipt-cancel.ts: hoàn kho, trả số đã nhận
 * trên dòng PO (dòng thêm lúc nhận thì bỏ, giá đổi lúc nhận thì về giá cũ), trừ công nợ NCC của PO;
 * chỉ lần nhận MỚI NHẤT huỷ được; lần nhận cũ chưa có bản ghi thì dựng lại từ phiếu nhập NM-…
 *
 * Chạy trên DB local với cửa hàng ZRC, tự dọn. Chạy: npm run test:purchase-receipt-cancel
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { cancelPurchaseReceipt } from "../lib/purchase-receipt-cancel.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "ZRC";
const WH = "ZRC_KHO";
const vn = (value) => new Date(`${value}:00.000+07:00`);
const ids = {};

async function cleanup() {
  const items = await prisma.inventoryItem.findMany({ where: { code: { in: ["ZRC_RAU", "ZRC_THIT"] } }, select: { id: true } });
  const orders = await prisma.purchaseOrder.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  await prisma.purchaseOrderReceipt.deleteMany({ where: { orderId: { in: orders.map((row) => row.id) } } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.purchaseOrder.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: items.map((row) => row.id) } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items.map((row) => row.id) } } });
}

async function balanceOf(itemId) {
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode: WH } } });
  return balance?.quantity || 0;
}

/** Một PO 1 dòng rau 10 KG giá 20.000. */
async function newOrder(code) {
  return prisma.purchaseOrder.create({
    data: {
      code, supplierCode: "ZRC_NCC", supplierName: "NCC test", branchCode: BRANCH, warehouseCode: WH, status: "APPROVED", totalAmount: 200000,
      lines: { create: [{ itemId: ids.rau, orderedQuantity: 10, unitCost: 20000, totalCost: 200000 }] },
    },
    include: { lines: true },
  });
}

/** Ghi một lần nhận như route RECEIVE_ORDER (phiếu NM + cộng dòng PO + công nợ + bản ghi lần nhận nếu `tracked`). */
async function receive(order, { code, quantity, unitCost, at, tracked = true, extra = null }) {
  return prisma.$transaction(async (tx) => {
    const doc = await postInventoryTransaction(tx, {
      code, transactionType: "NHAP_MUA", transactionDate: vn(at), branchCode: BRANCH, warehouseCode: WH,
      referenceType: "PURCHASE_ORDER", referenceId: order.id, referenceCode: order.code, partnerCode: "ZRC_NCC",
      lines: [
        { itemId: ids.rau, inputQuantity: quantity, inputUnitCode: "KG", inputUnitCost: unitCost },
        ...(extra ? [{ itemId: ids.thit, inputQuantity: extra.quantity, inputUnitCode: "KG", inputUnitCost: extra.unitCost }] : []),
      ],
    });
    const line = order.lines[0];
    const current = await tx.purchaseOrderLine.findUnique({ where: { id: line.id } });
    await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQuantity: current.receivedQuantity + quantity, unitCost, totalCost: 10 * unitCost } });
    const receiptLines = [{ lineId: line.id, quantity, createdLine: false, previousUnitCost: current.unitCost, previousTotalCost: current.totalCost }];
    if (extra) {
      const created = await tx.purchaseOrderLine.create({ data: { orderId: order.id, itemId: ids.thit, orderedQuantity: extra.quantity, receivedQuantity: extra.quantity, unitCost: extra.unitCost, totalCost: extra.quantity * extra.unitCost } });
      receiptLines.push({ lineId: created.id, quantity: extra.quantity, createdLine: true, previousUnitCost: null, previousTotalCost: null });
    }
    const value = quantity * unitCost + (extra ? extra.quantity * extra.unitCost : 0);
    await tx.supplierPayable.upsert({
      where: { purchaseOrderId: order.id },
      create: { purchaseOrderId: order.id, supplierCode: "ZRC_NCC", supplierName: "NCC test", recognizedDate: vn(at), originalAmount: value, outstandingAmount: value },
      update: { originalAmount: { increment: value }, outstandingAmount: { increment: value } },
    });
    await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: "PARTIALLY_RECEIVED" } });
    if (tracked) {
      await tx.purchaseOrderReceipt.create({ data: { orderId: order.id, stockTransactionId: doc.id, receivedDate: vn(at), payableAmount: value, lines: receiptLines, assetIds: [] } });
    }
    return doc;
  });
}

test.before(async () => {
  await cleanup();
  ids.rau = (await prisma.inventoryItem.create({ data: { code: "ZRC_RAU", name: "Rau test", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
  ids.thit = (await prisma.inventoryItem.create({ data: { code: "ZRC_THIT", name: "Thịt test", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("huỷ lần nhận: hoàn kho, trả số đã nhận, giá dòng về giá cũ, bỏ dòng thêm lúc nhận, bỏ công nợ", async () => {
  const order = await newOrder("PO-ZRC-1");
  const doc = await receive(order, { code: "NM-ZRC-1", quantity: 12, unitCost: 21000, at: "2033-02-01T09:00", extra: { quantity: 2, unitCost: 100000 } });
  assert.equal(await balanceOf(ids.rau), 12, "nhận thừa 12/10");
  const result = await prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { orderId: order.id, actor: "test" }));
  assert.equal(result.receiptCode, "NM-ZRC-1");
  assert.equal(await balanceOf(ids.rau), 0);
  assert.equal(await balanceOf(ids.thit), 0);
  assert.ok((await prisma.inventoryTransaction.findUnique({ where: { id: doc.id } })).deletedAt, "phiếu nhập xoá mềm");
  const lines = await prisma.purchaseOrderLine.findMany({ where: { orderId: order.id } });
  assert.equal(lines.length, 1, "dòng thịt thêm lúc nhận bị bỏ");
  assert.equal(lines[0].receivedQuantity, 0);
  assert.equal(lines[0].unitCost, 20000, "giá dòng về giá trước lần nhận");
  const after = await prisma.purchaseOrder.findUnique({ where: { id: order.id }, include: { payable: true } });
  assert.equal(after.status, "APPROVED");
  assert.equal(after.payable, null, "công nợ về 0 thì bỏ hẳn");
  assert.equal(after.totalAmount, 200000);
});

test("thứ tự ngược lại: còn lần nhận sau thì không huỷ được lần trước; lần nhận cũ dựng lại từ phiếu nhập", async () => {
  const order = await newOrder("PO-ZRC-2");
  const first = await receive(order, { code: "NM-ZRC-2A", quantity: 4, unitCost: 20000, at: "2033-02-02T09:00", tracked: false });
  await receive(order, { code: "NM-ZRC-2B", quantity: 6, unitCost: 20000, at: "2033-02-03T09:00" });
  await assert.rejects(
    () => prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { stockTransactionId: first.id, actor: "test" })),
    /NM-ZRC-2B/,
  );
  await prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { orderId: order.id, actor: "test" }));
  let after = await prisma.purchaseOrder.findUnique({ where: { id: order.id }, include: { payable: true, lines: true } });
  assert.equal(after.lines[0].receivedQuantity, 4);
  assert.equal(after.payable.originalAmount, 80000);
  assert.equal(after.status, "PARTIALLY_RECEIVED");
  // Lần nhận cũ (không có bản ghi) giờ là mới nhất — huỷ theo phiếu nhập được.
  await prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { stockTransactionId: first.id, actor: "test" }));
  after = await prisma.purchaseOrder.findUnique({ where: { id: order.id }, include: { payable: true, lines: true } });
  assert.equal(after.lines[0].receivedQuantity, 0);
  assert.equal(after.payable, null);
  assert.equal(await balanceOf(ids.rau), 0);
});

test("đã có phiếu trả hàng NCC theo phiếu nhập thì chặn — xoá phiếu trả trước", async () => {
  const order = await newOrder("PO-ZRC-3");
  const doc = await receive(order, { code: "NM-ZRC-3", quantity: 5, unitCost: 20000, at: "2033-02-04T09:00" });
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "XTN-ZRC-3", transactionType: "XUAT_TRA_NCC", transactionDate: vn("2033-02-05T09:00"), branchCode: BRANCH, warehouseCode: WH,
    referenceCode: doc.code, partnerCode: "ZRC_NCC", lines: [{ itemId: ids.rau, inputQuantity: 1, inputUnitCode: "KG" }],
  }));
  await assert.rejects(() => prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { orderId: order.id, actor: "test" })), /XTN-ZRC-3/);
});
