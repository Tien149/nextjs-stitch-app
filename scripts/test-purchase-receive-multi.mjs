/**
 * Nhận GỘP nhiều PO cùng NCC ở form Nhập kho (khách 27/10/2026) — lib/purchase-receive.ts: MỘT phiếu
 * NM cho cả lượt; công nợ, lần nhận vẫn tách theo từng PO (chi phí mua hàng theo dòng của PO); dòng
 * thêm vào đúng PO được chọn; huỷ lần nhận đảo cả phiếu; lỗi ở một PO thì không PO nào được nhận.
 *
 * Chạy trên DB local với cửa hàng ZRM, tự dọn. Chạy: npm run test:purchase-receive-multi
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postOrdersReceive, prepareOrderReceive } from "../lib/purchase-receive.ts";
import { cancelPurchaseReceipt } from "../lib/purchase-receipt-cancel.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "ZRM";
const WH = "ZRM_KHO";
const session = { name: "test-receive-multi", role: "Admin", allowedBranches: ["ALL"] };
const vn = (value) => new Date(`${value}:00.000+07:00`);
const ids = {};

async function cleanup() {
  const items = await prisma.inventoryItem.findMany({ where: { code: { in: ["ZRM_RAU", "ZRM_THIT"] } }, select: { id: true } });
  const orders = await prisma.purchaseOrder.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  await prisma.purchaseOrderReceipt.deleteMany({ where: { orderId: { in: orders.map((row) => row.id) } } });
  await prisma.supplierPayable.deleteMany({ where: { purchaseOrderId: { in: orders.map((row) => row.id) } } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.purchaseOrder.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: items.map((row) => row.id) } } });
  await prisma.itemUnitConversion.deleteMany({ where: { itemId: { in: items.map((row) => row.id) } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: items.map((row) => row.id) } } });
}

async function balanceOf(itemId) {
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode: WH } } });
  return balance?.quantity || 0;
}

const newOrder = (code, itemId, quantity, unitCost) => prisma.purchaseOrder.create({
  data: {
    code, supplierCode: "ZRM_NCC", supplierName: "NCC test", branchCode: BRANCH, warehouseCode: WH, status: "APPROVED", totalAmount: quantity * unitCost,
    lines: { create: [{ itemId, orderedQuantity: quantity, unitCost, totalCost: quantity * unitCost }] },
  },
  include: { lines: true },
});

/** Như route RECEIVE_ORDERS: chuẩn bị từng PO rồi ghi một lượt (một phiếu NM) trong một transaction. */
async function receiveMany(inputs, { at, purchaseCost = 0 }) {
  const receivedDate = vn(at);
  const plans = [];
  for (const input of inputs) plans.push(await prepareOrderReceive(session, input, receivedDate));
  return prisma.$transaction((tx) => postOrdersReceive(tx, session, plans, receivedDate, "", purchaseCost), { timeout: 60000 });
}

test.before(async () => {
  await cleanup();
  ids.rau = (await prisma.inventoryItem.create({ data: { code: "ZRM_RAU", name: "Rau test", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
  ids.thit = (await prisma.inventoryItem.create({ data: { code: "ZRM_THIT", name: "Thịt test", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("nhận gộp 2 PO: một phiếu NM, công nợ riêng từng PO, dòng thêm vào đúng PO, huỷ lần nhận đảo cả phiếu", async () => {
  const a = await newOrder("PO-ZRM-A", ids.rau, 10, 20000);
  const b = await newOrder("PO-ZRM-B", ids.rau, 5, 20000);
  const rows = await receiveMany([
    { orderId: a.id, lines: [{ lineId: a.lines[0].id, quantity: 10 }] },
    { orderId: b.id, lines: [{ lineId: b.lines[0].id, quantity: 5 }], extraLines: [{ itemId: ids.thit, unitCode: "KG", quantity: 1, unitCost: 100000 }] },
  ], { at: "2033-03-01T09:00", purchaseCost: 30000 });
  const [docA, docB] = rows.map((row) => row.stockTransaction);
  assert.equal(docA.id, docB.id, "một phiếu NM cho cả lượt");
  assert.equal(docA.lines.length, 3);
  assert.equal(docA.referenceCode, "PO-ZRM-A, PO-ZRM-B");
  // Tiền hàng A 200.000, B 100.000 + 100.000 thịt → chi phí 30.000 theo dòng: 15.000 / 7.500 / 7.500.
  assert.equal(docA.purchaseCost, 30000);
  assert.equal(await balanceOf(ids.rau), 15);
  assert.equal(await balanceOf(ids.thit), 1);
  const after = await prisma.purchaseOrder.findMany({ where: { id: { in: [a.id, b.id] } }, include: { payable: true, lines: true }, orderBy: { code: "asc" } });
  assert.equal(after[0].payable.originalAmount, 215000);
  assert.equal(after[1].payable.originalAmount, 215000);
  assert.equal(after[0].lines.length, 1);
  assert.equal(after[1].lines.length, 2, "dòng thịt thêm vào PO B");
  assert.equal(after[0].status, "COMPLETED");

  const receipts = await prisma.purchaseOrderReceipt.findMany({ where: { orderId: { in: [a.id, b.id] } } });
  assert.deepEqual(receipts.map((row) => row.stockTransactionId), [docA.id, docA.id]);

  const cancelled = await prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { stockTransactionId: docA.id, actor: "test" }));
  assert.equal(cancelled.orderCode.split(", ").sort().join(","), "PO-ZRM-A,PO-ZRM-B");
  assert.equal(await balanceOf(ids.rau), 0, "huỷ phiếu gộp hoàn kho cả hai PO");
  assert.equal(await balanceOf(ids.thit), 0);
  const back = await prisma.purchaseOrder.findMany({ where: { id: { in: [a.id, b.id] } }, include: { payable: true, lines: true }, orderBy: { code: "asc" } });
  assert.deepEqual(back.map((row) => row.status), ["APPROVED", "APPROVED"]);
  assert.deepEqual(back.map((row) => row.payable), [null, null]);
  assert.equal(back[1].lines.length, 1, "dòng thêm lúc nhận bị bỏ");
  assert.equal((await prisma.inventoryTransaction.findFirst({ where: { id: docA.id }, select: { deletedAt: true } }))?.deletedAt != null || !(await prisma.inventoryTransaction.findFirst({ where: { id: docA.id } })), true);
});

test("dòng PO đặt THÙNG nhận theo KG: kho cộng đúng số KG, phiếu NM ghi ĐVT KG, giá theo KG", async () => {
  await prisma.itemUnitConversion.create({ data: { itemId: ids.rau, unitCode: "THUNG", unitName: "Thùng", conversionRate: 10 } });
  const order = await prisma.purchaseOrder.create({
    data: {
      code: "PO-ZRM-E", supplierCode: "ZRM_NCC", supplierName: "NCC test", branchCode: BRANCH, warehouseCode: WH, status: "APPROVED", totalAmount: 400000,
      lines: { create: [{ itemId: ids.rau, orderedQuantity: 20, unitCost: 20000, totalCost: 400000, unitCode: "THUNG", conversionRate: 10 }] },
    },
    include: { lines: true },
  });
  const before = await balanceOf(ids.rau);
  const [row] = await receiveMany([{ orderId: order.id, lines: [{ lineId: order.lines[0].id, quantity: 7, unitCode: "KG", unitCost: 21000 }] }], { at: "2033-03-03T09:00" });
  assert.equal(await balanceOf(ids.rau), before + 7);
  const line = row.stockTransaction.lines[0];
  assert.equal(line.inputUnitCode, "KG");
  assert.equal(line.quantity, 7);
  assert.equal(line.inputUnitCost, 21000);
  const after = await prisma.purchaseOrder.findUnique({ where: { id: order.id }, include: { lines: true } });
  assert.equal(after.lines[0].receivedQuantity, 7);
  assert.equal(after.lines[0].unitCost, 21000, "giá dòng PO theo ĐVT tồn");
  assert.equal(after.status, "PARTIALLY_RECEIVED");

  const [again] = await receiveMany([{ orderId: order.id, lines: [{ lineId: order.lines[0].id, quantity: 1 }] }], { at: "2033-03-03T10:00" });
  assert.equal(again.stockTransaction.lines[0].inputUnitCode, "Thùng", "không chọn thì vẫn theo ĐVT đặt (engine kho ghi tên ĐVT)");
  assert.equal(await balanceOf(ids.rau), before + 17);
  await assert.rejects(() => receiveMany([{ orderId: order.id, lines: [{ lineId: order.lines[0].id, quantity: 1, unitCode: "BAO" }] }], { at: "2033-03-03T11:00" }), /chưa khai/);
});

test("huỷ phiếu gộp khi một PO đã có lần nhận sau → chặn, không đảo gì", async () => {
  const c = await newOrder("PO-ZRM-F", ids.rau, 10, 20000);
  const d = await newOrder("PO-ZRM-G", ids.rau, 10, 20000);
  const before = await balanceOf(ids.rau);
  const [first] = await receiveMany([
    { orderId: c.id, lines: [{ lineId: c.lines[0].id, quantity: 4 }] },
    { orderId: d.id, lines: [{ lineId: d.lines[0].id, quantity: 4 }] },
  ], { at: "2033-03-04T09:00" });
  await receiveMany([{ orderId: d.id, lines: [{ lineId: d.lines[0].id, quantity: 1 }] }], { at: "2033-03-04T10:00" });
  await assert.rejects(() => prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { stockTransactionId: first.stockTransaction.id, actor: "test" })), /PO-ZRM-G còn lần nhận/);
  assert.equal(await balanceOf(ids.rau), before + 9);
});

test("lỗi ở một PO thì không PO nào được nhận", async () => {
  const c = await newOrder("PO-ZRM-C", ids.rau, 4, 20000);
  const d = await newOrder("PO-ZRM-D", ids.rau, 4, 0);
  const before = await balanceOf(ids.rau);
  await assert.rejects(() => receiveMany([
    { orderId: c.id, lines: [{ lineId: c.lines[0].id, quantity: 4 }] },
    { orderId: d.id, lines: [{ lineId: d.lines[0].id, quantity: 4 }] },
  ], { at: "2033-03-02T09:00" }), /chưa có đơn giá/);
  assert.equal(await balanceOf(ids.rau), before);
  const c2 = await prisma.purchaseOrder.findUnique({ where: { id: c.id }, include: { payable: true } });
  assert.equal(c2.status, "APPROVED");
  assert.equal(c2.payable, null);
});
