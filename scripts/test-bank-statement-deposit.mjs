import test from "node:test";
import assert from "node:assert/strict";
import { bankStatementSpecialCategory, depositCategoryDirection } from "../lib/bank-statement-category.ts";

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

test("nhận diện khoản hoàn cọc cho khách", () => {
  // Tên không có chữ "tiền" nên trước đây lọt lưới, làm bảng danh mục mọc thêm một dòng
  // "Hoàn cọc cho khách" thứ hai bên cạnh dòng lấy từ sổ cọc.
  assert.equal(bankStatementSpecialCategory({ code: "CHI_HOAN_COC", name: "Hoàn cọc cho khách" }), "DEPOSIT");
  assert.equal(bankStatementSpecialCategory({ code: "HOAN_COC_CHO_KHACH", name: "Hoàn Cọc Cho Khách" }), "DEPOSIT");
});

test("không bắt nhầm danh mục có chữ cốc", () => {
  assert.equal(bankStatementSpecialCategory({ code: "CHI_MUA_COC_GIAY", name: "Chi mua cốc giấy" }), null);
});

test("tách được chiều tiền của danh mục cọc", () => {
  assert.equal(depositCategoryDirection({ code: "CHI_HOAN_COC", name: "Hoàn cọc cho khách" }), "REFUND");
  assert.equal(depositCategoryDirection({ code: "THU_TIEN_COC", name: "Thu tiền cọc của khách" }), "RECEIPT");
  assert.equal(depositCategoryDirection({ name: "Thu bán hàng" }), null);
});
