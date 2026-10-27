/**
 * Nhận GỘP nhiều PO cùng NCC ở form Nhập kho (khách 27/10/2026) — lib/purchase-receive.ts: mỗi PO một
 * phiếu NM, một khoản công nợ, một lần nhận; chi phí mua hàng chia theo tiền hàng từng PO (PO cuối
 * nhận phần lẻ); dòng thêm vào đúng PO được chọn; lỗi ở một PO thì không PO nào được nhận.
 *
 * Chạy trên DB local với cửa hàng ZRM, tự dọn. Chạy: npm run test:purchase-receive-multi
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { allocateReceivePurchaseCost, postOrderReceive, prepareOrderReceive } from "../lib/purchase-receive.ts";
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

/** Như route RECEIVE_ORDERS: chuẩn bị từng PO, chia chi phí mua hàng, ghi chung một transaction. */
async function receiveMany(inputs, { at, purchaseCost = 0 }) {
  const receivedDate = vn(at);
  const plans = [];
  for (const input of inputs) plans.push(await prepareOrderReceive(session, input, receivedDate));
  const weights = plans.map((plan) => plan.stockLines.reduce((sum, line) => sum + Math.round(line.receiveQuantity * line.unitCost), 0));
  allocateReceivePurchaseCost(weights, purchaseCost).forEach((share, index) => { plans[index].purchaseCost = share; });
  return prisma.$transaction(async (tx) => {
    const rows = [];
    for (const plan of plans) rows.push(await postOrderReceive(tx, session, plan, receivedDate, ""));
    return rows;
  }, { timeout: 60000 });
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

test("chia chi phí mua hàng theo tiền hàng, PO cuối có tiền hàng nhận phần lẻ", () => {
  assert.deepEqual(allocateReceivePurchaseCost([100, 200], 30000), [10000, 20000]);
  assert.deepEqual(allocateReceivePurchaseCost([1, 1, 1], 100), [33, 33, 34]);
  assert.deepEqual(allocateReceivePurchaseCost([100, 0], 5000), [5000, 0], "PO chỉ có tài sản không nhận chi phí");
  assert.deepEqual(allocateReceivePurchaseCost([0, 0], 5000), [0, 0]);
});

test("nhận gộp 2 PO: mỗi PO một phiếu NM + công nợ riêng, dòng thêm vào đúng PO, huỷ lần nhận theo từng PO", async () => {
  const a = await newOrder("PO-ZRM-A", ids.rau, 10, 20000);
  const b = await newOrder("PO-ZRM-B", ids.rau, 5, 20000);
  const rows = await receiveMany([
    { orderId: a.id, lines: [{ lineId: a.lines[0].id, quantity: 10 }] },
    { orderId: b.id, lines: [{ lineId: b.lines[0].id, quantity: 5 }], extraLines: [{ itemId: ids.thit, unitCode: "KG", quantity: 1, unitCost: 100000 }] },
  ], { at: "2033-03-01T09:00", purchaseCost: 30000 });
  const [docA, docB] = rows.map((row) => row.stockTransaction);
  assert.notEqual(docA.code, docB.code, "hai phiếu NM khác mã trong cùng transaction");
  assert.equal(docA.referenceId, a.id);
  assert.equal(docB.referenceId, b.id);
  // Tiền hàng A 200.000, B 100.000 + 100.000 thịt → chi phí 30.000 chia 15.000 / 15.000.
  assert.equal(docA.purchaseCost, 15000);
  assert.equal(docB.purchaseCost, 15000);
  assert.equal(await balanceOf(ids.rau), 15);
  assert.equal(await balanceOf(ids.thit), 1);
  const after = await prisma.purchaseOrder.findMany({ where: { id: { in: [a.id, b.id] } }, include: { payable: true, lines: true }, orderBy: { code: "asc" } });
  assert.equal(after[0].payable.originalAmount, 215000);
  assert.equal(after[1].payable.originalAmount, 215000);
  assert.equal(after[0].lines.length, 1);
  assert.equal(after[1].lines.length, 2, "dòng thịt thêm vào PO B");
  assert.equal(after[0].status, "COMPLETED");

  await prisma.$transaction((tx) => cancelPurchaseReceipt(tx, { orderId: b.id, actor: "test" }));
  assert.equal(await balanceOf(ids.rau), 10, "huỷ lần nhận PO B không đụng PO A");
  assert.equal(await balanceOf(ids.thit), 0);
  const a2 = await prisma.purchaseOrder.findUnique({ where: { id: a.id }, include: { payable: true } });
  assert.equal(a2.payable.originalAmount, 215000);
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
