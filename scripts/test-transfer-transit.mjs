/**
 * Điều chuyển "hàng đi đường" (khách 26/10/2026): lập phiếu chờ duyệt là trừ kho xuất ngay theo ngày
 * giờ lên phiếu (kho xuất → kho đi đường); Trả lại / Huỷ đảo về kho xuất; gửi lại trừ theo số mới;
 * Duyệt nhận cộng kho nhận đúng số gửi theo ngày giờ nhận (kho đi đường → kho nhận) và sinh công nợ
 * nội bộ khi khác nhà hàng. Phiếu cũ chưa có chặng chuyển đi thì duyệt như trước.
 *
 * Chạy trên DB local với cửa hàng ZTA / ZTB, năm 2033, tự dọn. Chạy: npm run test:transfer-transit
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { approveTransferRequest, dispatchTransferRequest, transitWarehouseCode, undoTransferDispatch } from "../lib/inventory-transfer-request.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const A = "ZTA";
const B = "ZTB";
const WA = "ZTA_KHO";
const WB = "ZTB_KHO";
const ITEM = "NVL_ZT_DUONG";
const TRANSIT = transitWarehouseCode(A, WB);
const vn = (value) => new Date(`${value}:00.000+07:00`);
const ids = {};

async function cleanup() {
  const item = await prisma.inventoryItem.findUnique({ where: { code: ITEM } });
  await prisma.debtRecord.deleteMany({ where: { branchCode: { in: [A, B] } } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: { in: [A, B] } } });
  await prisma.inventoryTransferRequest.deleteMany({ where: { branchCode: { in: [A, B] } } });
  if (item) await prisma.inventoryBalance.deleteMany({ where: { itemId: item.id } });
  await prisma.inventoryItem.deleteMany({ where: { code: ITEM } });
  await prisma.masterDataItem.deleteMany({ where: { OR: [
    { type: "BRANCH", code: { in: [A, B] } },
    { type: "WAREHOUSE", code: { in: [WA, WB, TRANSIT] } },
    { type: "PARTNER", code: { in: [`NB-${A}`, `NB-${B}`] } },
  ] } });
}

async function balanceOf(warehouseCode) {
  const balance = await prisma.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: ids.item, warehouseCode } } });
  return balance?.quantity || 0;
}

const newRequest = (code, quantity, requestDate) => prisma.inventoryTransferRequest.create({
  data: {
    code, status: "PENDING", requestDate, branchCode: A, warehouseCode: WA, toBranchCode: B, toWarehouseCode: WB, createdBy: "test",
    lines: [{ itemId: ids.item, itemCode: ITEM, itemName: ITEM, unit: "KG", inputQuantity: quantity, inputUnitCode: null }],
  },
});

test.before(async () => {
  await cleanup();
  for (const code of [A, B]) await prisma.masterDataItem.create({ data: { type: "BRANCH", code, name: `NH ${code}`, status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: WA, name: "Kho A", branch: A, status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: WB, name: "Kho B", branch: B, status: "ACTIVE" } });
  ids.item = (await prisma.inventoryItem.create({ data: { code: ITEM, name: "Đường", unit: "KG", itemType: "RAW_MATERIAL" } })).id;
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM-ZT-1", transactionType: "NHAP_MUA", transactionDate: vn("2033-01-01T08:00"), branchCode: A, warehouseCode: WA,
    lines: [{ itemId: ids.item, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 20000 }],
  }));
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("lập phiếu: trừ kho xuất ngay theo ngày giờ lên phiếu, hàng nằm ở kho đi đường", async () => {
  ids.request = (await newRequest("DCK-ZT-0001", 4, vn("2033-01-02T10:15"))).id;
  const request = await prisma.$transaction((tx) => dispatchTransferRequest(tx, ids.request));
  assert.equal(await balanceOf(WA), 6);
  assert.equal(await balanceOf(TRANSIT), 4);
  assert.equal(await balanceOf(WB), 0, "kho nhận chưa cộng");
  const dispatch = await prisma.inventoryTransaction.findUnique({ where: { id: request.dispatchTransactionId } });
  assert.equal(dispatch.code, "DCK-ZT-0001-DI");
  assert.equal(dispatch.referenceType, "TRANSFER_REQUEST");
  assert.equal(dispatch.transactionDate.getTime(), vn("2033-01-02T10:15").getTime());
  const transit = await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: TRANSIT } });
  assert.equal(transit.status, "INACTIVE", "kho đi đường không hiện trong ô chọn kho");
});

test("trả lại: hàng về kho xuất; gửi lại trừ theo số mới với mã chuyển đi mới", async () => {
  let request = await prisma.inventoryTransferRequest.findUnique({ where: { id: ids.request } });
  await prisma.$transaction((tx) => undoTransferDispatch(tx, request, "test"));
  assert.equal(await balanceOf(WA), 10);
  assert.equal(await balanceOf(TRANSIT), 0);
  await prisma.inventoryTransferRequest.update({
    where: { id: ids.request },
    data: { lines: [{ itemId: ids.item, itemCode: ITEM, itemName: ITEM, unit: "KG", inputQuantity: 5, inputUnitCode: null }] },
  });
  request = await prisma.$transaction((tx) => dispatchTransferRequest(tx, ids.request));
  const dispatch = await prisma.inventoryTransaction.findUnique({ where: { id: request.dispatchTransactionId } });
  assert.equal(dispatch.code, "DCK-ZT-0001-DI2");
  assert.equal(await balanceOf(WA), 5);
  assert.equal(await balanceOf(TRANSIT), 5);
});

test("duyệt nhận: cộng kho nhận đúng số gửi theo giờ nhận, công nợ nội bộ khi khác nhà hàng", async () => {
  const result = await prisma.$transaction((tx) => approveTransferRequest(tx, { id: ids.request, receivedDate: vn("2033-01-02T15:30"), approvedBy: "test" }));
  assert.equal(await balanceOf(TRANSIT), 0);
  assert.equal(await balanceOf(WB), 5);
  assert.equal(await balanceOf(WA), 5, "kho xuất đã trừ lúc lập phiếu, không trừ thêm");
  const receive = result.transaction;
  assert.equal(receive.code, "DCK-ZT-0001");
  assert.equal(receive.warehouseCode, TRANSIT);
  assert.equal(receive.toWarehouseCode, WB);
  assert.equal(receive.transactionDate.getTime(), vn("2033-01-02T15:30").getTime());
  assert.ok(receive.internalReceivableDebtCode && receive.internalPayableDebtCode, "liên nhà hàng sinh cặp công nợ nội bộ");
  const request = await prisma.inventoryTransferRequest.findUnique({ where: { id: ids.request } });
  assert.equal(request.status, "APPROVED");
});

test("phiếu cũ chưa có chặng chuyển đi: duyệt ghi thẳng kho xuất → kho nhận như trước", async () => {
  const legacy = await newRequest("DCK-ZT-0002", 2, vn("2033-01-03T09:00"));
  await prisma.$transaction((tx) => approveTransferRequest(tx, { id: legacy.id, receivedDate: vn("2033-01-03T11:00"), approvedBy: "test" }));
  assert.equal(await balanceOf(WA), 3);
  assert.equal(await balanceOf(WB), 7);
});
