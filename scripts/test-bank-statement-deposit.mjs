import test from "node:test";
import assert from "node:assert/strict";
import { bankStatementSpecialCategory } from "../lib/bank-statement-category.ts";

const depositCategory = { code: "THU_COC", name: "Thu Tiền Khách Đặt Cọc" };

test("nhận diện khoản thu tiền cọc", () => {
  assert.equal(bankStatementSpecialCategory(depositCategory), "DEPOSIT");
});

test("nhận diện theo tên tiếng Việt dù tên có thêm chữ khách đặt cọc", () => {
  assert.equal(bankStatementSpecialCategory({ name: "Thu tiền từ khách đặt cọc" }), "DEPOSIT");
});

test("phân biệt tiền cọc với công nợ", () => {
  assert.equal(bankStatementSpecialCategory({ name: "Thu công nợ khách hàng" }), "DEBT");
  assert.equal(bankStatementSpecialCategory({ name: "Thu bán hàng" }), null);
});
