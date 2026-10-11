/**
 * Nhật ký nhập/xuất gửi dạng gọn (lib/stock-movement-pack): bung lại phải ra đúng từng dòng cũ,
 * kể cả hai vế của phiếu điều chuyển.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-stock-movement-pack.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { packStockMovements, unpackStockMovements } from "../lib/stock-movement-pack.ts";

const date = new Date("2026-10-05T03:00:00.000Z");
const base = {
  transactionId: "t1", code: "DC-01", transactionType: "DIEU_CHUYEN", subType: null, transactionDate: date, branchCode: "NME",
  itemName: "Cá điêu hồng", unit: "KG", itemType: "RAW_MATERIAL", goodsGroup: "CÁ", itemCode: "CA01",
  quantity: 2, unitCost: 80000, value: 160000, referenceCode: null, partnerCode: "VE01", partnerName: "NCC A", note: "ghi chú",
};
const rows = [
  { ...base, warehouseCode: "K1", toWarehouseCode: "K2", counterpartWarehouseCode: "K2", inboundQuantity: 0, outboundQuantity: 2 },
  { ...base, warehouseCode: "K2", toWarehouseCode: null, counterpartWarehouseCode: "K1", inboundQuantity: 2, outboundQuantity: 0 },
  { ...base, transactionId: "t2", code: "NM-01", transactionType: "NHAP_MUA", warehouseCode: "K1", toWarehouseCode: null, counterpartWarehouseCode: null, itemCode: "CA02", itemName: "Cá lóc", quantity: 5, value: 400000, inboundQuantity: 5, outboundQuantity: 0 },
  { ...base, transactionId: "t2", code: "NM-01", transactionType: "NHAP_MUA", warehouseCode: "K1", toWarehouseCode: null, counterpartWarehouseCode: null, quantity: 1, value: 80000, inboundQuantity: 1, outboundQuantity: 0 },
];

test("bung lại đúng từng dòng; phiếu và mặt hàng chỉ gửi một lần", () => {
  const packed = packStockMovements(rows);
  assert.equal(packed.docs.length, 3);
  assert.equal(packed.items.length, 2);
  const back = unpackStockMovements(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(back, rows.map((row) => ({ ...row, transactionDate: date.toISOString() })));
});
