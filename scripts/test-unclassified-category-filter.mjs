import test from "node:test";
import assert from "node:assert/strict";
import { categoryCodeTokensByType } from "../lib/cashflow-categories.ts";

/** Danh mục mẫu: một khoản mục Thu, một khoản mục Chi. */
const categories = [
  { code: "THU_BANHANG", name: "Thu tiền từ bán hàng", group: "RECEIPT" },
  { code: "chi_nvl", name: "Chi nguyên vật liệu", group: "CHI" },
];

test("mã và tên khoản mục vào đúng nhóm Thu/Chi, có cả biến thể viết hoa", () => {
  const tokens = categoryCodeTokensByType(categories);

  assert.ok(tokens.RECEIPT.includes("THU_BANHANG"));
  assert.ok(tokens.RECEIPT.includes("Thu tiền từ bán hàng"));
  assert.ok(tokens.PAYMENT.includes("chi_nvl"));
  assert.ok(tokens.PAYMENT.includes("CHI_NVL"), "mã viết thường phải có thêm biến thể viết hoa");
});

test("mã Chi không được coi là đã phân loại khi nằm trên phiếu Thu", () => {
  const tokens = categoryCodeTokensByType(categories);

  // Bộ lọc 'chưa phân loại' của phiếu Thu so với tokens.RECEIPT, nên mã Chi phải rơi ra ngoài.
  assert.equal(tokens.RECEIPT.includes("chi_nvl"), false);
  assert.equal(tokens.PAYMENT.includes("THU_BANHANG"), false);
});

test("khoản mục không rõ nhóm thì không tính là đã phân loại ở cả hai bên", () => {
  const tokens = categoryCodeTokensByType([{ code: "KHONG_RO", name: "Chưa khai nhóm", group: "" }]);

  assert.deepEqual(tokens, { RECEIPT: [], PAYMENT: [] });
});
