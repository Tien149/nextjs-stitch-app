/**
 * Báo cáo tab Tồn kho (khách yêu cầu 03/10/2026): Nhập - Xuất - Tồn có trị giá, gộp theo cửa
 * hàng / tách loại theo kho; tổng hợp nhập / xuất theo mặt hàng, loại, kho, NCC.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-stock-report.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { aggregateNxtByStore, isEmptyNxtRow, movementDirection, sortNxtRows, summarizeMovements, toNxtRow } from "../lib/stock-report.ts";

const item = (id, goodsGroup = null) => ({ id, code: id.toUpperCase(), name: id, unit: "GR", goodsGroup });
const summary = (itemId, warehouseCode, extra = {}) => ({
  item: item(itemId, extra.goodsGroup), warehouseCode,
  openingQuantity: 10, openingValue: 100, inboundQuantity: 5, inboundValue: 60, outboundQuantity: 3, outboundValue: 33,
  closingQuantity: 12, closingValue: 127, averageCost: 10, movementByType: {}, ...extra,
});

test("tách nhập / xuất theo loại, điều chuyển theo vế", () => {
  const row = toNxtRow(summary("a", "K1", { movementByType: {
    NHAP_MUA: { inbound: 4, outbound: 0, inboundValue: 50, outboundValue: 0 },
    NHAP_DIEU_CHUYEN: { inbound: 1, outbound: 0, inboundValue: 10, outboundValue: 0 },
    XUAT_BAN: { inbound: 0, outbound: 2, inboundValue: 0, outboundValue: 22 },
    XUAT_TEST_MON: { inbound: 0, outbound: 1, inboundValue: 0, outboundValue: 11 },
  } }), "B1");
  assert.deepEqual(row.byCategory["IN:purchase"], { quantity: 4, value: 50 });
  assert.deepEqual(row.byCategory["IN:transfer"], { quantity: 1, value: 10 });
  assert.deepEqual(row.byCategory["OUT:sale"], { quantity: 2, value: 22 });
  assert.deepEqual(row.byCategory["OUT:other"], { quantity: 1, value: 11 });
  assert.equal(row.opening.value + row.inbound.value - row.outbound.value, row.closing.value);
});

test("API cũ gộp DIEU_CHUYEN: tách lại hai vế", () => {
  const row = toNxtRow(summary("a", "K1", { movementByType: { DIEU_CHUYEN: { inbound: 2, outbound: 3, inboundValue: 20, outboundValue: 30 } } }), "B1");
  assert.deepEqual(row.byCategory["IN:transfer"], { quantity: 2, value: 20 });
  assert.deepEqual(row.byCategory["OUT:transfer"], { quantity: 3, value: 30 });
});

test("gộp các kho của cùng cửa hàng, khác cửa hàng thì tách dòng", () => {
  const rows = aggregateNxtByStore([
    toNxtRow(summary("a", "K1"), "B1"),
    toNxtRow(summary("a", "K2"), "B1"),
    toNxtRow(summary("a", "K3"), "B2"),
  ]);
  assert.equal(rows.length, 2);
  const b1 = rows.find((row) => row.branchCode === "B1");
  assert.deepEqual([b1.opening.quantity, b1.closing.value, b1.warehouseCode], [20, 254, ""]);
});

test("dòng trống và sắp xếp theo nhóm (chưa gán nhóm xuống cuối)", () => {
  const empty = toNxtRow(summary("z", "K1", { openingQuantity: 0, openingValue: 0, inboundQuantity: 0, inboundValue: 0, outboundQuantity: 0, outboundValue: 0, closingQuantity: 1e-9, closingValue: 0.3 }), "B1");
  assert.equal(isEmptyNxtRow(empty), true);
  const sorted = sortNxtRows([toNxtRow(summary("c", "K1"), "B1"), toNxtRow(summary("b", "K1", { goodsGroup: "Thịt" }), "B1"), toNxtRow(summary("a", "K1", { goodsGroup: "Bia" }), "B1")]);
  assert.deepEqual(sorted.map((row) => row.item.code), ["A", "B", "C"]);
});

const move = (extra) => ({ transactionId: "t1", code: "P1", transactionType: "NHAP_MUA", transactionDate: "2026-10-01", warehouseCode: "K1", itemCode: "A", itemName: "a", unit: "GR", inboundQuantity: 1, outboundQuantity: 0, value: 10, referenceCode: null, ...extra });

test("chiều của dòng điều chuyển", () => {
  assert.deepEqual(movementDirection(move({ transactionType: "DIEU_CHUYEN", inboundQuantity: 2 })), { direction: "IN", type: "NHAP_DIEU_CHUYEN" });
  assert.deepEqual(movementDirection(move({ transactionType: "DIEU_CHUYEN", inboundQuantity: 0, outboundQuantity: 2 })), { direction: "OUT", type: "XUAT_DIEU_CHUYEN" });
});

test("tổng hợp theo mặt hàng / NCC: đếm phiếu không trùng", () => {
  const rows = [
    move({}),
    move({ itemCode: "a", inboundQuantity: 2, value: 30 }),
    move({ transactionId: "t2", partnerCode: "NCC1", partnerName: "Một", value: 5 }),
  ];
  const byItem = summarizeMovements(rows, "item", { type: (t) => t, warehouse: () => "" });
  assert.deepEqual([byItem.length, byItem[0].quantity, byItem[0].value, byItem[0].documentCount], [1, 4, 45, 2]);
  const byPartner = summarizeMovements(rows, "partner", { type: (t) => t, warehouse: () => "" });
  assert.deepEqual(byPartner.map((row) => [row.label, row.value, row.documentCount]), [["(Không có NCC)", 40, 1], ["NCC1", 5, 1]]);
});
