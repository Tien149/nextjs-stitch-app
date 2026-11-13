/**
 * Công nợ khai tay tách thuế GTGT (khách 13/11/2026): trước thuế + thuế suất → tiền thuế → sau thuế.
 * Số sau thuế vẫn là originalAmount báo cáo đọc.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-debt-vat.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDebtLineTax } from "../lib/debt-vat.ts";

test("trước thuế + 8% → tiền thuế tự tính, sau thuế = trước + thuế", () => {
  assert.deepEqual(resolveDebtLineTax({ amount: "", amountBeforeTax: "1000000", vatRate: "8%", vatAmount: "" }),
    { ok: true, amount: 1080000, amountBeforeTax: 1000000, vatRate: 0.08, vatAmount: 80000 });
});

test("tiền thuế sửa tay theo hoá đơn thì giữ số khai", () => {
  const tax = resolveDebtLineTax({ amountBeforeTax: "123457", vatRate: "10%", vatAmount: "12345" });
  assert.equal(tax.ok && tax.amount, 135802);
});

test("không khai trước thuế: số tiền khai thẳng là sau thuế, không tách thuế", () => {
  assert.deepEqual(resolveDebtLineTax({ amount: "500000", amountBeforeTax: "" }),
    { ok: true, amount: 500000, amountBeforeTax: null, vatRate: null, vatAmount: null });
});

test("KKKNT = không thuế; thuế suất lạ bị chặn", () => {
  const free = resolveDebtLineTax({ amountBeforeTax: 200000, vatRate: "KKKNT" });
  assert.equal(free.ok && free.amount, 200000);
  assert.equal(resolveDebtLineTax({ amountBeforeTax: 200000, vatRate: "7%" }).ok, false);
});
