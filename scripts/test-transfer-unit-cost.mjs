/**
 * Luật đơn giá điều chuyển (khách chốt 27/09/2026):
 *  - nguyên liệu, bao bì: giá nhập mua gần nhất trong tháng, không có thì bình quân tháng liền kề;
 *  - bán thành phẩm: giá vốn rã BOM (nhập chế biến) bình quân trong tháng.
 * Chạy: npm run test:transfer-unit-cost
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pickTransferUnitCost } from "../lib/inventory-stock.ts";

const d = (value) => new Date(`${value}T00:00:00.000Z`);
const line = (date, quantity, unitCost) => ({ transactionDate: d(date), quantity, unitCost, totalCost: quantity * unitCost });
const transferDate = d("2026-09-15");

test("nguyên liệu: lấy phiếu mua gần nhất TRƯỚC ngày điều chuyển trong tháng", () => {
  const lines = [line("2026-09-03", 10, 100), line("2026-09-12", 5, 120), line("2026-09-20", 8, 150)];
  assert.equal(pickTransferUnitCost({ itemType: "RAW_MATERIAL", transactionDate: transferDate, lines }), 120);
});

test("bao bì: trong tháng chỉ có phiếu mua SAU ngày điều chuyển thì vẫn lấy trong tháng", () => {
  const lines = [line("2026-08-28", 10, 90), line("2026-09-20", 8, 150)];
  assert.equal(pickTransferUnitCost({ itemType: "PACKAGING", transactionDate: transferDate, lines }), 150);
});

test("nguyên liệu: trong tháng không mua thì bình quân gia quyền tháng liền kề", () => {
  const lines = [line("2026-08-05", 10, 100), line("2026-08-25", 30, 140)];
  // (10x100 + 30x140) / 40 = 130
  assert.equal(pickTransferUnitCost({ itemType: "RAW_MATERIAL", transactionDate: transferDate, lines }), 130);
});

test("nguyên liệu: tháng liền kề cũng trống thì lùi tới tháng gần nhất có mua", () => {
  const lines = [line("2026-05-10", 4, 80), line("2026-05-20", 4, 100)];
  assert.equal(pickTransferUnitCost({ itemType: "RAW_MATERIAL", transactionDate: transferDate, lines }), 90);
});

test("nguyên liệu: quá 12 tháng không mua thì trả 0 để caller dùng giá khác", () => {
  const lines = [line("2025-06-10", 4, 80)];
  assert.equal(pickTransferUnitCost({ itemType: "RAW_MATERIAL", transactionDate: transferDate, lines }), 0);
});

test("bán thành phẩm: bình quân các lần rã BOM trong tháng, không lấy lần gần nhất", () => {
  const lines = [line("2026-09-02", 10, 50000), line("2026-09-14", 10, 70000), line("2026-09-28", 20, 60000)];
  // (500k + 700k + 1.200k) / 40 = 60.000
  assert.equal(pickTransferUnitCost({ itemType: "SEMI_FINISHED", transactionDate: transferDate, lines }), 60000);
});

test("bán thành phẩm: tháng chưa rã BOM thì lấy giá vốn tháng gần nhất đã rã", () => {
  const lines = [line("2026-07-02", 10, 50000)];
  assert.equal(pickTransferUnitCost({ itemType: "SEMI_FINISHED", transactionDate: transferDate, lines }), 50000);
});

test("CCDC không có luật riêng: trả 0", () => {
  const lines = [line("2026-09-02", 10, 50000)];
  assert.equal(pickTransferUnitCost({ itemType: "TOOL", transactionDate: transferDate, lines }), 0);
});
