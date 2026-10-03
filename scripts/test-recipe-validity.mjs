/**
 * Lọc định lượng / giá thành theo tháng (khách hỏi 03/10/2026): phiên bản áp dụng từ 01/08 không
 * sửa thì vẫn thuộc tháng 9; đổi giá 2 lần trong tháng thì tháng đó có 3 phiên bản nối tiếp.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-recipe-validity.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recipeValidity, validityInMonth, vnDay } from "../lib/recipe-validity.ts";
import { buildMonthlyCostSummary } from "../lib/recipe-cost-summary.ts";

const line = (code, quantity) => ({ itemId: code, quantity, unitCode: null, conversionRate: 1, wasteRate: 0, item: { code, name: code, unit: "GR", itemType: "RAW_MATERIAL" } });
const recipe = (id, version, effectiveFrom, sellingPrice, branchCode = null, qty = 100) => ({
  id, productCode: "SP_A", productName: "Món A", branchCode, unit: "PHAN", outputConversionRate: 1, version, effectiveFrom, status: "ACTIVE", sellingPrice, lines: [line("NVL_X", qty)],
});

test("ngày VN: lưu 00:00 UTC hay 17:00 UTC hôm trước đều ra cùng ngày", () => {
  assert.equal(vnDay("2026-08-01T00:00:00.000Z"), "2026-08-01");
  assert.equal(vnDay("2026-07-31T17:00:00.000Z"), "2026-08-01");
});

test("áp dụng từ 01/08 không sửa thì vẫn thuộc tháng 9", () => {
  const validity = recipeValidity([recipe("v1", 1, "2026-08-01T00:00:00Z", 50000)]);
  assert.deepEqual(validityInMonth(validity.get("v1"), "2026-09"), { from: "2026-09-01", to: "2026-09-30" });
  assert.equal(validityInMonth(validity.get("v1"), "2026-07"), null);
});

test("đổi giá 2 lần trong tháng: 3 phiên bản nối tiếp, mỗi bản đúng khoảng ngày", () => {
  const recipes = [
    recipe("v1", 1, "2026-08-01T00:00:00Z", 50000),
    recipe("v2", 2, "2026-09-11T00:00:00Z", 55000),
    recipe("v3", 3, "2026-09-21T00:00:00Z", 60000, null, 120),
  ];
  const rows = buildMonthlyCostSummary({ recipes, items: [{ code: "SP_A", name: "Món A", unit: "PHAN", itemType: "FINISHED" }], averageCostByItemId: new Map([["NVL_X", 100]]), month: "2026-09" });
  assert.deepEqual(rows.map((row) => [row.version, row.appliedFrom, row.appliedTo, row.sellingPrice, row.unitCost]), [
    [1, "2026-09-01", "2026-09-10", 50000, 10000],
    [2, "2026-09-11", "2026-09-20", 55000, 10000],
    [3, "2026-09-21", "2026-09-30", 60000, 12000],
  ]);
});

test("trùng ngày áp dụng: version lớn thắng, bản nhỏ không áp dụng; cửa hàng riêng là phạm vi riêng", () => {
  const validity = recipeValidity([
    recipe("a", 1, "2026-09-05T00:00:00Z", 1),
    recipe("b", 2, "2026-09-05T00:00:00Z", 2),
    recipe("c", 1, "2026-09-01T00:00:00Z", 3, "NME"),
  ]);
  assert.equal(validity.get("a"), null);
  assert.deepEqual(validity.get("b"), { from: "2026-09-05", to: null });
  assert.deepEqual(validity.get("c"), { from: "2026-09-01", to: null });
});
