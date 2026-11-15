import test from "node:test";
import assert from "node:assert/strict";
import { pickRevenueSource } from "../lib/revenue-source.ts";

const index = { toCode: (text) => ({ "ĐỒ ĂN": "REV_FOOD", "ĐỒ UỐNG": "REV_BAR" })[String(text).toUpperCase()] || "" };

test("nhóm khai trên mặt hàng thắng chữ trong file (chị Bình chốt 15/11/2026)", () => {
  // Mì Ý Bò Đút Lò: POS ghi nhầm Đồ uống, danh mục khai Đồ ăn -> Đồ ăn.
  assert.equal(pickRevenueSource("ĐỒ UỐNG", "REV_FOOD", index), "REV_FOOD");
});

test("mặt hàng chưa khai nhóm thì vẫn lấy theo file; file trống thì rỗng", () => {
  assert.equal(pickRevenueSource("ĐỒ UỐNG", "", index), "REV_BAR");
  assert.equal(pickRevenueSource("-", "", index), "");
  assert.equal(pickRevenueSource("Tiệc cưới", "", index), "Tiệc cưới");
});
