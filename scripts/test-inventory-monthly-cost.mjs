/**
 * Giá vốn bình quân cả tháng theo từng kho (khách chốt 13/10/2026) — lib/inventory-monthly-cost.ts.
 * Chạy: npm run test:inventory-monthly-cost
 */
import assert from "node:assert/strict";
import test from "node:test";
import { computeMonthlyCosts } from "../lib/inventory-monthly-cost.ts";

const at = (day) => new Date(`${day}T10:00:00+07:00`);
let seq = 0;
const line = (itemId, quantity, unitCost = 0, inputUnitCost = unitCost) => ({
  id: `L${++seq}`, itemId, quantity, unitCost, totalCost: quantity * unitCost, inputUnitCost,
});
const doc = (code, transactionType, day, warehouseCode, lines, toWarehouseCode = null) => ({
  id: code, code, transactionType, transactionDate: at(day), branchCode: "ASA", warehouseCode, toWarehouseCode, lines,
});
const items = [
  { id: "NL", code: "NL", itemType: "RAW_MATERIAL" },
  { id: "BTP", code: "BTP", itemType: "SEMI_FINISHED" },
  { id: "TP", code: "TP", itemType: "FINISHED" },
];
const lineOf = (result, lineId) => result.lines.find((row) => row.lineId === lineId);
const keyOf = (result, period, itemId, warehouseCode) => result.keys.find((row) => row.period === period && row.itemId === itemId && row.warehouseCode === warehouseCode);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ≠ ${expected}`);

test("xuất đầu tháng lấy giá cả tháng, không phải giá lúc xuất", () => {
  const out = line("NL", 5);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08",
    opening: [{ itemId: "NL", warehouseCode: "KBEP", quantity: 10, value: 1000 }],
    documents: [
      doc("X1", "XUAT_HUY", "2026-08-05", "KBEP", [out]),
      doc("M1", "NHAP_MUA", "2026-08-20", "KBEP", [line("NL", 10, 200)]),
    ],
  });
  // (1.000 + 2.000) / 20 = 150
  near(lineOf(result, out.id).unitCost, 150);
  const key = keyOf(result, "2026-08", "NL", "KBEP");
  near(key.closingQty, 15);
  near(key.closingValue, 2250);
});

test("phiếu mua lùi ngày tính vào đúng tháng của nó, tháng sau nhận tồn cuối mới", () => {
  const augOut = line("NL", 10);
  const sepOut = line("NL", 5);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("M1", "NHAP_MUA", "2026-08-02", "KBEP", [line("NL", 10, 100)]),
      doc("X1", "XUAT_BAN", "2026-08-25", "KBEP", [augOut]),
      // nhập bổ sung sau nhưng ghi ngày tháng 8
      doc("M2", "NHAP_MUA", "2026-08-28", "KBEP", [line("NL", 10, 300)]),
      doc("M3", "NHAP_MUA", "2026-09-10", "KBEP", [line("NL", 10, 500)]),
      doc("X2", "XUAT_BAN", "2026-09-20", "KBEP", [sepOut]),
    ],
  });
  near(lineOf(result, augOut.id).unitCost, 200); // tháng 8: (1.000 + 3.000) / 20
  // tháng 9: tồn đầu 10 × 200 = 2.000 + 5.000 → 7.000 / 20 = 350
  near(lineOf(result, sepOut.id).unitCost, 350);
});

test("hàng tặng 0 đ và kiểm kê thừa không kéo giá bình quân", () => {
  const gift = line("NL", 10, 0, 0);
  const surplus = line("NL", 2, 0, null);
  const out = line("NL", 4);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("M1", "NHAP_MUA", "2026-08-02", "KBEP", [line("NL", 10, 100), gift]),
      doc("K1", "NHAP_KIEM_KE", "2026-08-10", "KBEP", [surplus]),
      doc("X1", "XUAT_BAN", "2026-08-12", "KBEP", [out]),
    ],
  });
  near(lineOf(result, out.id).unitCost, 100);
  near(lineOf(result, gift.id).unitCost, 100);
  near(lineOf(result, surplus.id).totalCost, 200);
  near(keyOf(result, "2026-08", "NL", "KBEP").closingValue, 1800);
});

test("chế biến: nhập BTP = Σ nguyên liệu theo giá tháng, xuất bán BTP lấy giá tháng của BTP", () => {
  const issue = line("NL", 2);
  const receipt = line("BTP", 4, 1, null);
  const sale = line("BTP", 4);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("RA-1-1X", "XUAT_CHE_BIEN", "2026-08-03", "KBEP", [issue]),
      doc("RA-1-1N", "NHAP_CHE_BIEN", "2026-08-03", "KBEP", [receipt]),
      doc("RA-1-SALE", "XUAT_BAN", "2026-08-03", "KBEP", [sale]),
      // mua sau khi rã (kho âm lúc rã) — giá tháng vẫn áp cho nguyên liệu đã rã
      doc("M1", "NHAP_MUA", "2026-08-20", "KBEP", [line("NL", 10, 1000)]),
    ],
  });
  near(lineOf(result, issue.id).totalCost, 2000);
  near(lineOf(result, receipt.id).totalCost, 2000);
  near(lineOf(result, sale.id).unitCost, 500);
});

test("định lượng hai tầng: BTP cấp 1 làm nguyên liệu cho thành phẩm", () => {
  const sale = line("TP", 1);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("M1", "NHAP_MUA", "2026-08-01", "KBEP", [line("NL", 10, 100)]),
      doc("RA-1-1X", "XUAT_CHE_BIEN", "2026-08-05", "KBEP", [line("NL", 3)]),
      doc("RA-1-1N", "NHAP_CHE_BIEN", "2026-08-05", "KBEP", [line("BTP", 3, 1, null)]),
      doc("RA-1-2X", "XUAT_CHE_BIEN", "2026-08-05", "KBEP", [line("BTP", 3)]),
      doc("RA-1-2N", "NHAP_CHE_BIEN", "2026-08-05", "KBEP", [line("TP", 1, 1, null)]),
      doc("RA-1-S", "XUAT_BAN", "2026-08-05", "KBEP", [sale]),
    ],
  });
  near(lineOf(result, sale.id).totalCost, 300);
});

test("điều chuyển: hai đầu cùng giá luật (giá mua gần nhất), kho nhận bình quân với giá đó", () => {
  const transfer = line("NL", 5);
  const destOut = line("NL", 5);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08",
    opening: [{ itemId: "NL", warehouseCode: "KBEP", quantity: 10, value: 500 }],
    documents: [
      doc("M1", "NHAP_MUA", "2026-08-02", "KBEP", [line("NL", 10, 150)]),
      doc("DC1", "DIEU_CHUYEN", "2026-08-10", "KBEP", [transfer], "KBAR"),
      doc("X1", "XUAT_BAN", "2026-08-15", "KBAR", [destOut]),
    ],
  });
  near(lineOf(result, transfer.id).unitCost, 150); // giá mua gần nhất, không phải bình quân kho (100)
  near(lineOf(result, destOut.id).unitCost, 150);
  const source = keyOf(result, "2026-08", "NL", "KBEP");
  near(source.averageCost, 100);
  near(source.closingQty, 15);
  near(source.closingValue, 2000 - 750); // phần chênh giá điều chuyển nằm lại kho chuyển
});

test("thành phẩm chuyển qua lại hai kho cùng tháng vẫn hội tụ", () => {
  const ab = line("TP", 2);
  const ba = line("TP", 1);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08",
    opening: [{ itemId: "TP", warehouseCode: "A", quantity: 10, value: 1000 }, { itemId: "TP", warehouseCode: "B", quantity: 10, value: 3000 }],
    documents: [
      doc("DC1", "DIEU_CHUYEN", "2026-08-05", "A", [ab], "B"),
      doc("DC2", "DIEU_CHUYEN", "2026-08-06", "B", [ba], "A"),
    ],
  });
  const a = keyOf(result, "2026-08", "TP", "A").averageCost;
  const b = keyOf(result, "2026-08", "TP", "B").averageCost;
  // a = (1000 + b) / 11 ; b = (3000 + 2a) / 12
  near(a, (1000 + b) / 11);
  near(b, (3000 + 2 * a) / 12);
  assert.ok(result.iterations["2026-08"] < 100);
});

test("kho không tồn, không nhập: lấy giá tháng trước, rồi giá kho khác, rồi giá mua gần nhất", () => {
  const sepOut = line("NL", 1);
  const otherOut = line("NL", 1);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("M1", "NHAP_MUA", "2026-08-02", "KBEP", [line("NL", 1, 400)]),
      doc("X1", "XUAT_BAN", "2026-08-03", "KBEP", [line("NL", 1)]),
      doc("X2", "XUAT_BAN", "2026-09-03", "KBEP", [sepOut]),
      doc("X3", "XUAT_BAN", "2026-09-03", "KBAR", [otherOut]),
    ],
  });
  near(lineOf(result, sepOut.id).unitCost, 400);
  near(lineOf(result, otherOut.id).unitCost, 400);
});

test("tồn đầu âm được định giá lại theo giá tháng, không thổi giá", () => {
  const out = line("NL", 1);
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("X1", "XUAT_BAN", "2026-08-03", "KBEP", [line("NL", 5)]),
      doc("M1", "NHAP_MUA", "2026-09-02", "KBEP", [line("NL", 10, 300)]),
      doc("X2", "XUAT_BAN", "2026-09-03", "KBEP", [out]),
    ],
  });
  near(lineOf(result, out.id).unitCost, 300);
  const sep = keyOf(result, "2026-09", "NL", "KBEP");
  near(sep.closingQty, 4);
  near(sep.closingValue, 1200);
});

test("ngày đầu tháng theo giờ VN (00:00 01/09 VN = 31/08 UTC) thuộc tháng 9", () => {
  const out = { ...line("NL", 1), id: "VN" };
  const result = computeMonthlyCosts({
    items, openingPeriod: "2026-08", opening: [],
    documents: [
      doc("M1", "NHAP_MUA", "2026-08-02", "KBEP", [line("NL", 1, 100)]),
      { ...doc("M2", "NHAP_MUA", "2026-09-01", "KBEP", [line("NL", 1, 300)]), transactionDate: new Date("2026-09-01T00:00:00+07:00") },
      { ...doc("X1", "XUAT_BAN", "2026-09-01", "KBEP", [out]), transactionDate: new Date("2026-09-01T00:00:00+07:00") },
    ],
  });
  assert.equal(lineOf(result, "VN").period, "2026-09");
  near(lineOf(result, "VN").unitCost, 200);
});
