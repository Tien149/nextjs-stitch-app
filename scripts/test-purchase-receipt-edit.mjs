/**
 * Sửa phiếu NM nhận hàng PO ngay ở màn Nhập kho (khách 28/10/2026) — lib/purchase-receipt-edit.ts:
 * ghi lại phiếu như route UPDATE_TRANSACTION rồi kéo dòng PO, lần nhận, công nợ NCC theo số mới.
 *
 * Chạy trên DB local với cửa hàng ZRE, tự dọn. Chạy: npm run test:purchase-receipt-edit
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postOrdersReceive, prepareOrderReceive } from "../lib/purchase-receive.ts";
import { cancelPurchaseReceipt } from "../lib/purchase-receipt-cancel.ts";
import { postInventoryTransaction, repostInventoryTransaction } from "../lib/inventory-stock.ts";
import { syncPurchaseReceiptEdit } from "../lib/purchase-receipt-edit.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "ZRE";
const WH = "ZRE_KHO";
const session = { name: "test-receipt-edit", role: "Admin", allowedBranches: ["ALL"] };
const vn = (value) => new Date(`${value}:00.000+07:00`);
const ids = {};

async function cleanup() {
  const items = await prisma.inventoryItem.findMany({ where: { code: { in: ["ZRE_RAU", "ZRE_THIT"] } }, select: { id: true } });
  const orders = await prisma.purchaseOrder.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  await prisma.purchaseOrderReceipt.deleteMany({ where: { orderId: { in: orders.map((row) => row.id) } } });
  await prisma.supplierPayable.deleteMany({ where: { purchaseOrderId: { in: orders.map((row) => row.id) } } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.purchaseOrder.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: items.map((row) => row.id) } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items.map((row) => row.id) } } });
}

async function balanceOf(itemId) {
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode: WH } } });
  return balance?.quantity || 0;
}

const newOrder = (code, itemId, quantity, unitCost) => prisma.purchaseOrder.create({
  data: {
    code, supplierCode: "ZRE_NCC", supplierName: "NCC test", branchCode: BRANCH, warehouseCode: WH, status: "APPROVED", totalAmount: quantity * unitCost,
    lines: { create: [{ itemId, orderedQuantity: quantity, unitCost, totalCost: quantity * unitCost }] },
  },
  include: { lines: true },
});

async function receiveMany(inputs, { at, purchaseCost = 0 }) {
  const receivedDate = vn(at);
  const plans = [];
  for (const input of inputs) plans.push(await prepareOrderReceive(session, input, receivedDate));
  const [row] = await prisma.$transaction((tx) => postOrdersReceive(tx, session, plans, receivedDate, "", purchaseCost), { timeout: 60000 });
  return row.stockTransaction;
}

/** Như route UPDATE_TRANSACTION với phiếu nhận PO: ghi lại phiếu rồi đồng bộ PO. */
async function editDoc(docId, lines, { at, purchaseCost } = {}) {
  const transaction = await prisma.inventoryTransaction.findUnique({ where: { id: docId }, include: { lines: true } });
  return prisma.$transaction(async (tx) => {
    const updated = await repostInventoryTransaction(tx, transaction, {
      transactionDate: at ? vn(at) : transaction.transactionDate,
      branchCode: transaction.branchCode,
      warehouseCode: transaction.warehouseCode,
      partnerCode: transaction.partnerCode,
      referenceCode: transaction.referenceCode,
      note: transaction.note,
      purchaseCost: purchaseCost ?? transaction.purchaseCost,
      lines: lines.map((line) => ({ vatRate: null, discountRate: "", discountAmount: "", note: "", ...line })),
    });
    await syncPurchaseReceiptEdit(tx, { ...transaction, transactionDate: updated.transactionDate }, transaction.lines, updated.inputOrderLines, lines.map((line) => line.sourceLineId || null));
    return updated;
  }, { timeout: 60000 });
}

const orderOf = (id) => prisma.purchaseOrder.findUnique({ where: { id }, include: { lines: true, payable: true } });

test.before(async () => {
  await cleanup();
  ids.rau = (await prisma.inventoryItem.create({ data: { code: "ZRE_RAU", name: "Rau test", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
  ids.thit = (await prisma.inventoryItem.create({ data: { code: "ZRE_THIT", name: "Thịt test", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("sửa số lượng + đơn giá phiếu nhận một PO: kho, dòng PO, công nợ, lần nhận đi theo; huỷ lần nhận vẫn trả về giá cũ", async () => {
  const order = await newOrder("PO-ZRE-A", ids.rau, 10, 20000);
  const doc = await receiveMany([{ orderId: order.id, lines: [{ lineId: order.lines[0].id, quantity: 10, vatRate: "8%" }] }], { at: "2034-01-05T09:00" });
  assert.equal((await orderOf(order.id)).payable.originalAmount, 216000);

  await editDoc(doc.id, [{ sourceLineId: doc.lines[0].id, itemId: ids.rau, inputQuantity: 8, inputUnitCode: "KG", inputUnitCost: 21000, vatRate: 0.08 }], { at: "2034-01-06T09:00" });
  assert.equal(await balanceOf(ids.rau), 8);
  const after = await orderOf(order.id);
  assert.equal(after.lines[0].receivedQuantity, 8);
  assert.equal(after.lines[0].unitCost, 21000);
  assert.equal(after.status, "PARTIALLY_RECEIVED");
  assert.equal(after.payable.originalAmount, 181440, "8 × 21.000 + 8%");
  const [receipt] = await prisma.purchaseOrderReceipt.findMany({ where: { orderId: order.id, status: "ACTIVE" } });
  assert.equal(receipt.payableAmount, 181440);
  assert.equal(receipt.receivedDate.toISOString(), vn("2034-01-06T09:00").toISOString());
  assert.equal(receipt.lines[0].quantity, 8);
  assert.equal(receipt.lines[0].previousUnitCost, 20000);

  await prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { stockTransactionId: doc.id, actor: "test" }));
  const back = await orderOf(order.id);
  assert.equal(back.lines[0].receivedQuantity, 0);
  assert.equal(back.lines[0].unitCost, 20000, "huỷ lần nhận trả về giá trước khi nhận");
  assert.equal(back.payable, null);
  assert.equal(await balanceOf(ids.rau), 0);
});

test("phiếu một PO: thêm mặt hàng thành dòng thêm của PO; xoá lại dòng đó thì bỏ dòng PO", async () => {
  const order = await newOrder("PO-ZRE-B", ids.rau, 5, 10000);
  const doc = await receiveMany([{ orderId: order.id, lines: [{ lineId: order.lines[0].id, quantity: 5 }] }], { at: "2034-01-07T09:00" });
  await editDoc(doc.id, [
    { sourceLineId: doc.lines[0].id, itemId: ids.rau, inputQuantity: 5, inputUnitCode: "KG", inputUnitCost: 10000 },
    { itemId: ids.thit, inputQuantity: 2, inputUnitCode: "KG", inputUnitCost: 50000 },
  ]);
  let current = await orderOf(order.id);
  assert.equal(current.lines.length, 2);
  assert.equal(current.status, "COMPLETED");
  assert.equal(current.payable.originalAmount, 150000);
  assert.equal(await balanceOf(ids.thit), 2);

  const edited = await prisma.inventoryTransaction.findUnique({ where: { id: doc.id }, include: { lines: true } });
  const rauLine = edited.lines.find((line) => line.itemId === ids.rau);
  await editDoc(doc.id, [{ sourceLineId: rauLine.id, itemId: ids.rau, inputQuantity: 5, inputUnitCode: "KG", inputUnitCost: 10000 }]);
  current = await orderOf(order.id);
  assert.equal(current.lines.length, 1, "dòng thêm lúc sửa bị bỏ khi xoá khỏi phiếu");
  assert.equal(current.payable.originalAmount, 50000);
  assert.equal(await balanceOf(ids.thit), 0);
});

test("phiếu gộp 2 PO: sửa chi phí mua hàng chia lại công nợ; xoá hết dòng một PO thì gỡ PO đó khỏi phiếu; thêm mặt hàng bị chặn", async () => {
  const a = await newOrder("PO-ZRE-C", ids.rau, 10, 10000);
  const b = await newOrder("PO-ZRE-D", ids.rau, 10, 10000);
  const doc = await receiveMany([
    { orderId: a.id, lines: [{ lineId: a.lines[0].id, quantity: 10 }] },
    { orderId: b.id, lines: [{ lineId: b.lines[0].id, quantity: 10 }] },
  ], { at: "2034-01-08T09:00", purchaseCost: 10000 });
  const current = await prisma.inventoryTransaction.findUnique({ where: { id: doc.id }, include: { lines: true } });
  const [l1, l2] = current.lines;
  await editDoc(doc.id, [
    { sourceLineId: l1.id, itemId: ids.rau, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 10000 },
    { sourceLineId: l2.id, itemId: ids.rau, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 10000 },
  ], { purchaseCost: 20000 });
  const payables = (await prisma.supplierPayable.findMany({ where: { purchaseOrderId: { in: [a.id, b.id] } } })).map((row) => row.originalAmount).sort();
  assert.deepEqual(payables, [110000, 110000], "chi phí mua 20.000 chia đôi");

  await assert.rejects(() => editDoc(doc.id, [
    { sourceLineId: l1.id, itemId: ids.rau, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 10000 },
    { sourceLineId: l2.id, itemId: ids.rau, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 10000 },
    { itemId: ids.thit, inputQuantity: 1, inputUnitCode: "KG", inputUnitCost: 10000 },
  ]), /gộp nhiều PO/);

  const fresh = await prisma.inventoryTransaction.findUnique({ where: { id: doc.id }, include: { lines: true } });
  await editDoc(doc.id, [{ sourceLineId: fresh.lines[0].id, itemId: ids.rau, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 10000 }], { purchaseCost: 0 });
  const after = await prisma.purchaseOrder.findMany({ where: { id: { in: [a.id, b.id] } }, include: { payable: true, lines: true } });
  const kept = after.find((row) => row.payable);
  const dropped = after.find((row) => !row.payable);
  assert.ok(kept && dropped, "một PO còn nợ, PO kia bỏ hẳn khoản nợ");
  assert.equal(kept.payable.originalAmount, 100000);
  assert.equal(dropped.status, "APPROVED");
  assert.equal(dropped.lines[0].receivedQuantity, 0);
  const updatedDoc = await prisma.inventoryTransaction.findUnique({ where: { id: doc.id } });
  assert.equal(updatedDoc.referenceCode, kept.code);
  assert.equal(updatedDoc.referenceId, kept.id);
  assert.equal(await prisma.purchaseOrderReceipt.count({ where: { orderId: dropped.id, status: "ACTIVE" } }), 0);
});

test("phiếu nhận PO cũ (chưa có bản ghi lần nhận): sửa dựng bản ghi lần nhận giữ thứ tự cũ", async () => {
  const order = await newOrder("PO-ZRE-E", ids.rau, 10, 10000);
  const doc = await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM-ZRE-0001", transactionType: "NHAP_MUA", transactionDate: vn("2034-01-09T09:00"), branchCode: BRANCH, warehouseCode: WH,
    referenceType: "PURCHASE_ORDER", referenceId: order.id, referenceCode: order.code, partnerCode: "ZRE_NCC", createdBy: "test",
    lines: [{ itemId: ids.rau, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 10000 }],
  }));
  await prisma.purchaseOrderLine.update({ where: { id: order.lines[0].id }, data: { receivedQuantity: 10 } });
  await prisma.supplierPayable.create({ data: { purchaseOrderId: order.id, supplierCode: "ZRE_NCC", supplierName: "NCC test", recognizedDate: doc.transactionDate, originalAmount: 100000, outstandingAmount: 100000 } });

  await editDoc(doc.id, [{ sourceLineId: doc.lines[0].id, itemId: ids.rau, inputQuantity: 6, inputUnitCode: "KG", inputUnitCost: 10000 }]);
  const after = await orderOf(order.id);
  assert.equal(after.lines[0].receivedQuantity, 6);
  assert.equal(after.payable.originalAmount, 60000);
  const receipt = await prisma.purchaseOrderReceipt.findFirst({ where: { orderId: order.id, status: "ACTIVE" } });
  assert.equal(receipt.payableAmount, 60000);
  assert.equal(receipt.createdAt.toISOString(), doc.createdAt.toISOString());
});
