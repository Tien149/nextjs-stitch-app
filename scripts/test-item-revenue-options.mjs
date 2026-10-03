/**
 * Nhóm doanh thu chọn cho mặt hàng (03/10/2026): chỉ nhóm món Bếp / Bar / Phụ thu; loại món chưa
 * có danh mục thì dùng nhóm dự phòng như P&L (VPS khách đã xoá REV_FOOD / REV_DRINK).
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-item-revenue-options.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadItemRevenueGroupResolver, loadItemRevenueOptions } from "../lib/revenue-source.ts";

const clientOf = (rows) => ({ masterDataItem: { findMany: async () => rows.map((row) => ({ matchKeywords: null, ...row })) } });
const vps = clientOf([
  { code: "REV_ADJUST", name: "Điều Chỉnh Doanh Thu POS", group: "REVENUE_SOURCE" },
  { code: "REV_SERVICE", name: "DT Phụ Thu", group: "REVENUE_SOURCE" },
  { code: "REV_SVC", name: "Doanh thu SVC", group: "REVENUE_SOURCE" },
  { code: "REV_VAT", name: "DT Thuế GTGT", group: "REVENUE_SOURCE" },
]);

test("thiếu danh mục Bếp / Bar: dùng nhóm dự phòng, bỏ SVC / thuế / điều chỉnh", async () => {
  const options = await loadItemRevenueOptions(vps);
  assert.deepEqual(options.map((option) => option.code), ["REV_FOOD", "REV_BAR", "REV_SERVICE"]);
});

test("đủ danh mục thì dùng danh mục, không thêm dự phòng", async () => {
  const options = await loadItemRevenueOptions(clientOf([
    { code: "REV_FOOD", name: "Doanh thu bếp", group: "REVENUE_SOURCE" },
    { code: "REV_DRINK", name: "Doanh thu bar", group: "REVENUE_SOURCE" },
    { code: "REV_SERVICE", name: "DT Phụ Thu", group: "REVENUE_SOURCE" },
    { code: "REV_REST", name: "Doanh Thu Nhà Hàng", group: "REVENUE_SOURCE" },
  ]));
  assert.deepEqual(options.map((option) => option.code), ["REV_FOOD", "REV_DRINK", "REV_SERVICE"]);
});

test("import quy chữ về nhóm món", async () => {
  const resolve = await loadItemRevenueGroupResolver(vps);
  assert.equal(resolve("Đồ ăn").code, "REV_FOOD");
  assert.equal(resolve("ĐỒ UỐNG").code, "REV_BAR");
  assert.equal(resolve("Khăn Lạnh").code, "REV_SERVICE");
  assert.equal(resolve("rev_food").code, "REV_FOOD");
  assert.equal(resolve("").code, null);
  assert.ok(resolve("Doanh thu SVC").error);
});
