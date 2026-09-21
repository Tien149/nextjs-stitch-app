/**
 * Dòng CAPEX trên P&L chỉ lấy bên NỢ của 211/242.
 *
 * 211/242 còn bị ghi CÓ ở những nghiệp vụ không phải hoàn lại tiền đầu tư — rõ nhất là phân bổ
 * chi phí trả trước hàng kỳ (Nợ 6428 / Có 242). Trừ vế Có vào dòng CAPEX thì tháng nào chạy
 * phân bổ là CAPEX âm một cục đúng bằng số phân bổ (khách báo 21/09/2026: CAPEX tháng 9 hiện
 * −88.225.863 đ, trong khi tháng đó không mua sắm gì).
 *
 * Chạy: npm run test:capex-debit-only
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pnlLineAmount } from "../lib/reports.ts";

test("CAPEX chỉ cộng bên Nợ", () => {
  assert.equal(pnlLineAmount("capex", { debit: 10770975, credit: 0 }), 10770975);
});

test("vế Có 242 của phân bổ KHÔNG trừ vào CAPEX", () => {
  // Bút toán phân bổ: Nợ 6428 88.225.863 / Có 242 88.225.863.
  // Vế Nợ đã nằm ở dòng OPEX; vế Có không được kéo CAPEX xuống âm.
  assert.equal(pnlLineAmount("capex", { debit: 0, credit: 88225863 }), 0);
});

test("mua sắm rồi phân bổ trong cùng kỳ: CAPEX vẫn là số đã bỏ ra", () => {
  const lines = [
    { debit: 88225863, credit: 0 },  // chi trả trước, treo Nợ 242
    { debit: 0, credit: 88225863 },  // phân bổ kỳ đầu, rút 242 xuống
  ];
  const capex = lines.reduce((sum, line) => sum + pnlLineAmount("capex", line), 0);
  assert.equal(capex, 88225863);
});

test("dòng chi phí thường vẫn lấy Nợ trừ Có", () => {
  assert.equal(pnlLineAmount("otherOpex", { debit: 1000, credit: 200 }), 800);
  assert.equal(pnlLineAmount("cogs", { debit: 500, credit: 0 }), 500);
  assert.equal(pnlLineAmount("payroll", { debit: 0, credit: 300 }), -300);
});

test("dòng thu lấy Có trừ Nợ", () => {
  assert.equal(pnlLineAmount("revenue", { debit: 0, credit: 5000 }), 5000);
  assert.equal(pnlLineAmount("otherIncome", { debit: 100, credit: 5000 }), 4900);
});
