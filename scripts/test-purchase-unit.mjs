/**
 * PR / báo giá / PO giữ ĐVT đặt hàng (khách 21/10/2026) — helpers ở lib/unit-conversion.ts.
 * DB lưu theo ĐVT tồn kèm unitCode + hệ số; hiển thị quy ngược lại.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { purchaseLineRate, purchaseLineUnit, purchaseUnitOptions, toPurchasePrice, toPurchaseQuantity } from "../lib/unit-conversion.ts";

test("dòng 1 KG lưu 1.000 GR hiển thị lại đúng 1 KG, giá theo KG", () => {
  const line = { unitCode: "KG", conversionRate: 1000, item: { unit: "GR" } };
  assert.equal(toPurchaseQuantity(1000, line), 1);
  assert.equal(toPurchaseQuantity(1500, line), 1.5);
  assert.equal(toPurchasePrice(77, line), 77000);
  assert.equal(toPurchasePrice(77.5, line), 77500);
  assert.equal(purchaseLineUnit(line), "KG");
});

test("dòng cũ không có ĐVT đặt = ĐVT tồn, hệ số 1", () => {
  const line = { unitCode: null, conversionRate: 1, item: { unit: "GR" } };
  assert.equal(purchaseLineRate(line), 1);
  assert.equal(toPurchaseQuantity(1000, line), 1000);
  assert.equal(purchaseLineUnit(line), "GR");
  assert.equal(purchaseLineRate({ unitCode: "KG", conversionRate: 0 }), 1);
});

test("danh sách ĐVT chọn: ĐVT tồn + quy đổi, bỏ dòng khai trùng ĐVT tồn", () => {
  const options = purchaseUnitOptions("GR", [
    { unitCode: "KG", conversionRate: 1000 },
    { unitCode: "GR", conversionRate: 1000 },
    { unitCode: "THUNG", unitName: "Thùng", conversionRate: 10000 },
  ]);
  assert.deepEqual(options.map((option) => [option.unitCode, option.conversionRate]), [["GR", 1], ["KG", 1000], ["THUNG", 10000]]);
});
