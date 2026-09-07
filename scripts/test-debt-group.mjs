/**
 * Phiếu công nợ nhiều hạng mục P&L (trích trước cuối tháng): các dòng mang mã `<phiếu>/1`, `/2`...
 * Chốt hai điều: (1) suy ra mã phiếu cha / số dòng đúng từ mã; (2) cấp số phiếu kế tiếp KHÔNG bị
 * lỗ vì `Number("0007/2")` là NaN — phải lược hậu tố trước khi tính MAX + 1.
 *
 * Chạy: npm run test:debt-group
 */
import test from "node:test";
import assert from "node:assert/strict";
import { debtGroupCode, debtLineNumber, stripDebtLineSuffix } from "../lib/debt-group.ts";
import { nextSeqFromCodes } from "../lib/voucher-code-generator.ts";

const PREFIX = "CNPT-202609-";

test("mã phẳng là khoản đơn, không thuộc phiếu nào", () => {
  assert.equal(debtGroupCode("CNPT-202609-0007"), null);
  assert.equal(debtLineNumber("CNPT-202609-0007"), null);
  assert.equal(stripDebtLineSuffix("CNPT-202609-0007"), "CNPT-202609-0007");
});

test("mã dòng /n trỏ về mã phiếu cha và số dòng", () => {
  assert.equal(debtGroupCode("CNPT-202609-0007/1"), "CNPT-202609-0007");
  assert.equal(debtGroupCode("CNPT-202609-0007/12"), "CNPT-202609-0007");
  assert.equal(debtLineNumber("CNPT-202609-0007/12"), 12);
  assert.equal(stripDebtLineSuffix("CNPT-202609-0007/12"), "CNPT-202609-0007");
});

test("hậu tố hỏng không bị đọc thành số dòng", () => {
  assert.equal(debtLineNumber("CNPT-202609-0007/x"), null);
  assert.equal(debtLineNumber("CNPT-202609-0007/0"), null);
});

test("cấp số phiếu kế tiếp tính cả phiếu nhiều dòng", () => {
  const issued = [`${PREFIX}0005`, `${PREFIX}0006/1`, `${PREFIX}0006/2`, `${PREFIX}0007/1`, `${PREFIX}0007/2`, `${PREFIX}0007/3`];
  // Không lược hậu tố thì MAX chỉ thấy 0005 → cấp 0006, đâm trúng phiếu đang sống.
  assert.equal(nextSeqFromCodes(issued, PREFIX), 6);
  // Lược hậu tố → MAX = 0007 → cấp 0008.
  assert.equal(nextSeqFromCodes(issued.map(stripDebtLineSuffix), PREFIX), 8);
});
