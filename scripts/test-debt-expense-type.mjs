import test from "node:test";
import assert from "node:assert/strict";
import { parseDebtExpenseType } from "../lib/debt-expense-type.ts";

test("bỏ trống là số dư đầu kỳ — file cũ import lại không đổi số", () => {
  assert.equal(parseDebtExpenseType(""), "OPENING");
  assert.equal(parseDebtExpenseType(null), "OPENING");
  assert.equal(parseDebtExpenseType(undefined), "OPENING");
  assert.equal(parseDebtExpenseType("   "), "OPENING");
});

test("nhận chữ phát sinh dù viết hoa/thường, có dấu hay không", () => {
  for (const value of ["Phát sinh", "PHAT SINH", "phat_sinh", "Phát sinh trong kỳ", "Chi phí", "x", "1", "Có"]) {
    assert.equal(parseDebtExpenseType(value), "INCURRED", `"${value}" phải là chi phí phát sinh`);
  }
});

test("nhận chữ đầu kỳ", () => {
  for (const value of ["Đầu kỳ", "dau ky", "Số dư đầu kỳ", "mang sang", "0", "Không"]) {
    assert.equal(parseDebtExpenseType(value), "OPENING", `"${value}" phải là số dư đầu kỳ`);
  }
});

/**
 * Chữ lạ trả null để bên gọi báo lỗi. Đoán bừa một ô là lệch hẳn một dòng chi phí trên P&L,
 * mà lệch kiểu đó thì không ai soát ra cho tới lúc chốt sổ.
 */
test("chữ lạ không đoán bừa", () => {
  assert.equal(parseDebtExpenseType("phát sinh tháng 8"), null);
  assert.equal(parseDebtExpenseType("tháng 8"), null);
  assert.equal(parseDebtExpenseType("abc"), null);
});

/** Dấu câu thừa không được làm hỏng ô khai đúng chữ. */
test("bỏ qua dấu câu thừa", () => {
  assert.equal(parseDebtExpenseType("Phát sinh."), "INCURRED");
  assert.equal(parseDebtExpenseType("(đầu kỳ)"), "OPENING");
});
