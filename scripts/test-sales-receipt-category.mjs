/**
 * Khoản mục thu nào được tính là TIỀN BÁN HÀNG ĐÃ VỀ trên tab "Tiền về đủ chưa".
 *
 * Khách báo 21/09/2026: nguồn tiền mặt ngày 30/8 doanh thu 10.566.297 đ mà cột "Tiền đã vô"
 * ra 11.566.297 đ, dư đúng 1.000.000 đ của một phiếu thu lại công nợ phải thu. Vế ngân
 * hàng/ví vốn đã lọc theo khoản mục bán hàng, riêng vế tiền mặt cộng mọi phiếu thu đã duyệt.
 *
 * Chạy: npm run test:sales-receipt-category
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isSalesReceiptCategory, SALES_RECEIPT_CATEGORY_CODES } from "../lib/voucher-rules.ts";

test("hai cách viết mã thu bán hàng đều là doanh thu", () => {
  // `THU_BAN_HANG` là mã trên dòng sao kê; `THU_BANHANG` là mã trong danh mục khai sẵn
  // ("Thu bán hàng trong ngày"). Bỏ sót cái nào là cột "Tiền đã vô" của nguồn đó về 0.
  assert.equal(isSalesReceiptCategory("THU_BAN_HANG"), true);
  assert.equal(isSalesReceiptCategory("THU_BANHANG"), true);
});

test("mã viết thường / lẫn khoảng trắng vẫn nhận", () => {
  assert.equal(isSalesReceiptCategory(" thu_banhang "), true);
  assert.equal(isSalesReceiptCategory("thu_ban_hang"), true);
});

test("các khoản thu KHÔNG phải doanh thu thì không tính là tiền bán hàng về", () => {
  // Đây mới là gốc của con số dư: tiền vào quỹ thật, nhưng không phải tiền của doanh thu
  // ngày hôm đó nên không được bù vào vế "đã về".
  for (const code of ["THU_CONGNO_KHACH", "THU_HOAN_TAMUNG", "THU_KHAC", "THU_TIEN_COC", "THU_HO"]) {
    assert.equal(isSalesReceiptCategory(code), false, `${code} không phải doanh thu bán hàng`);
  }
});

test("phiếu chưa khai khoản mục không được mặc định thành doanh thu", () => {
  assert.equal(isSalesReceiptCategory(null), false);
  assert.equal(isSalesReceiptCategory(undefined), false);
  assert.equal(isSalesReceiptCategory(""), false);
});

test("danh sách mã không rỗng và không lẫn mã chi", () => {
  assert.ok(SALES_RECEIPT_CATEGORY_CODES.length > 0);
  assert.ok(SALES_RECEIPT_CATEGORY_CODES.every((code) => code === code.toUpperCase()),
    "isSalesReceiptCategory so sánh sau toUpperCase nên mã khai thường sẽ không bao giờ khớp");
  assert.ok(!SALES_RECEIPT_CATEGORY_CODES.some((code) => code.startsWith("CHI")));
});
