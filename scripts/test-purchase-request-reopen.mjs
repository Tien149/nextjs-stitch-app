/**
 * Một PR tách nhiều PO, huỷ một PO thì PR mở lại đúng các dòng của PO đó (khách 27/10/2026) —
 * lib/purchase-request-open-lines.ts. Chạy trên DB local với cửa hàng ZRQ, tự dọn.
 * Chạy: npm run test:purchase-request-reopen
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { openRequestLines, syncRequestCompletion } from "../lib/purchase-request-open-lines.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "ZRQ";
const ITEMS = ["ZRQ_RAU", "ZRQ_THIT", "ZRQ_CA"];

async function cleanup() {
  await prisma.purchaseOrder.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.purchaseRequest.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryItem.deleteMany({ where: { code: { in: ITEMS } } });
}

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("huỷ một trong hai PO của PR: chỉ dòng của PO đó mở lại; xoá mềm PO cũng vậy", async () => {
  await cleanup();
  const items = [];
  for (const code of ITEMS) items.push(await prisma.inventoryItem.create({ data: { code, name: code, unit: "KG", itemType: "RAW_MATERIAL" } }));
  const pr = await prisma.purchaseRequest.create({
    data: {
      code: "PR-ZRQ-1", branchCode: BRANCH, requestedBy: "test", reason: "test", status: "ORDERED",
      lines: { create: items.map((item) => ({ itemId: item.id, quantity: 1 })) },
    },
    include: { lines: true },
  });
  const lineOf = (index) => pr.lines.find((line) => line.itemId === items[index].id);
  const order = (code, indexes) => prisma.purchaseOrder.create({
    data: {
      code, requestId: pr.id, supplierCode: code, supplierName: code, branchCode: BRANCH, warehouseCode: "ZRQ_KHO", status: "APPROVED", totalAmount: 0,
      lines: { create: indexes.map((index) => ({ itemId: items[index].id, orderedQuantity: 1, unitCost: 0, totalCost: 0, requestLineId: lineOf(index).id })) },
    },
  });
  const a = await order("PO-ZRQ-A", [0, 1]);
  const b = await order("PO-ZRQ-B", [2]);
  assert.deepEqual(await openRequestLines(prisma, pr.id, pr.lines), []);

  await prisma.purchaseOrder.update({ where: { id: b.id }, data: { status: "CANCELLED" } });
  assert.deepEqual((await openRequestLines(prisma, pr.id, pr.lines)).map((line) => line.id), [lineOf(2).id], "chỉ dòng của PO B mở lại");

  await prisma.purchaseOrder.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
  assert.equal((await openRequestLines(prisma, pr.id, pr.lines)).length, 3, "PO A vào Thùng rác thì cả PR mở lại");
});

test("PR tự Hoàn tất khi mọi PO còn hiệu lực đã Hoàn tất; PO quay lại nhận dở thì PR về Đã lên PO", async () => {
  const item = await prisma.inventoryItem.create({ data: { code: "ZRQ_CA", name: "ZRQ_CA", unit: "KG", itemType: "RAW_MATERIAL" } }).catch(() => prisma.inventoryItem.findFirst({ where: { code: "ZRQ_CA" } }));
  const pr = await prisma.purchaseRequest.create({
    data: { code: "PR-ZRQ-2", branchCode: BRANCH, requestedBy: "test", reason: "test", status: "ORDERED", lines: { create: [{ itemId: item.id, quantity: 2 }] } },
  });
  const order = (code, status) => prisma.purchaseOrder.create({
    data: { code, requestId: pr.id, supplierCode: code, supplierName: code, branchCode: BRANCH, warehouseCode: "ZRQ_KHO", status, totalAmount: 0, lines: { create: [{ itemId: item.id, orderedQuantity: 1, unitCost: 0, totalCost: 0 }] } },
  });
  const statusOf = async () => (await prisma.purchaseRequest.findUnique({ where: { id: pr.id } })).status;
  await order("PO-ZRQ-C", "COMPLETED");
  const d = await order("PO-ZRQ-D", "PARTIALLY_RECEIVED");
  await order("PO-ZRQ-E", "CANCELLED");
  await syncRequestCompletion(prisma, pr.id);
  assert.equal(await statusOf(), "ORDERED", "còn PO nhận dở");
  await prisma.purchaseOrder.update({ where: { id: d.id }, data: { status: "COMPLETED", closedAt: new Date() } });
  await syncRequestCompletion(prisma, pr.id);
  assert.equal(await statusOf(), "COMPLETED", "PO đã huỷ không tính; PO đóng thiếu tính là xong");
  await prisma.purchaseOrder.update({ where: { id: d.id }, data: { status: "PARTIALLY_RECEIVED", closedAt: null } });
  await syncRequestCompletion(prisma, pr.id);
  assert.equal(await statusOf(), "ORDERED");
  await prisma.purchaseRequest.update({ where: { id: pr.id }, data: { status: "APPROVED" } });
  await prisma.purchaseOrder.update({ where: { id: d.id }, data: { status: "COMPLETED" } });
  await syncRequestCompletion(prisma, pr.id);
  assert.equal(await statusOf(), "APPROVED", "PR đang chờ duyệt phần mở lại thì không đụng");
});
