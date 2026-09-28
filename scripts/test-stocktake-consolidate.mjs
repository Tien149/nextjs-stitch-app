/**
 * Kiểm kê theo vị trí + duyệt gộp (khách chốt 28/09/2026) — phần tính thuần.
 * Chạy: npm run test:stocktake-consolidate
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bookAtCutoff, consolidateStocktake, isLocationStocktakeItemType, resolveUnitInputs } from "../lib/stocktake-consolidate.ts";

const bottle = [{ unitCode: "THUNG", conversionRate: 24 }, { unitCode: "CHAI", conversionRate: 330 }];

test("đếm nhiều ĐVT cùng lúc quy về ĐVT tồn", () => {
  const result = resolveUnitInputs("ML", bottle, [
    { unitCode: "thung", quantity: "1" },
    { unitCode: "CHAI", quantity: "2" },
    { unitCode: "", quantity: "100" },
  ]);
  assert.equal(result.error, undefined);
  assert.equal(result.baseQuantity, 24 + 660 + 100);
});

test("ô để trống bỏ qua, ĐVT chưa khai quy đổi và số âm bị chặn", () => {
  assert.equal(resolveUnitInputs("ML", bottle, [{ unitCode: "CHAI", quantity: "" }]).inputs.length, 0);
  assert.match(resolveUnitInputs("ML", bottle, [{ unitCode: "KET", quantity: "1" }]).error, /KET/);
  assert.match(resolveUnitInputs("ML", bottle, [{ unitCode: "CHAI", quantity: "-1" }]).error, /âm/);
});

test("hệ số lấy từ danh mục, không nhận hệ số gửi lên", () => {
  const result = resolveUnitInputs("ML", bottle, [{ unitCode: "CHAI", quantity: "1", conversionRate: 999 }]);
  assert.equal(result.baseQuantity, 330);
});

test("cùng mã ở nhiều vị trí thì cộng tổng rồi mới so sổ sách", () => {
  const rows = consolidateStocktake(
    [
      { code: "KK-1", locationCode: "TU_DONG", lines: [{ itemId: "GA", actualQuantity: 3 }] },
      { code: "KK-2", locationCode: "TU_MAT", lines: [{ itemId: "GA", actualQuantity: 2 }] },
      { code: "KK-3", locationCode: "KE_KHO", lines: [{ itemId: "GA", actualQuantity: 0 }] },
    ],
    [{ itemId: "GA", quantity: 6, averageCost: 100 }],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].breakdown, { TU_DONG: 3, TU_MAT: 2, KE_KHO: 0 });
  assert.equal(rows[0].countedQuantity, 5);
  assert.equal(rows[0].varianceQuantity, -1);
  assert.equal(rows[0].notCounted, false);
});

test("mã có sổ sách mà không nằm trên phiếu nào = đếm 0; sổ sách 0 không ai đếm thì bỏ", () => {
  const rows = consolidateStocktake(
    [{ code: "KK-1", locationCode: "TU_DONG", lines: [{ itemId: "GA", actualQuantity: 1 }] }],
    [
      { itemId: "GA", quantity: 1, averageCost: 100 },
      { itemId: "BO", quantity: 4, averageCost: 200 },
      { itemId: "HEO", quantity: 0, averageCost: 50 },
    ],
  );
  const bo = rows.find((row) => row.itemId === "BO");
  assert.equal(bo.notCounted, true);
  assert.equal(bo.varianceQuantity, -4);
  assert.equal(rows.some((row) => row.itemId === "HEO"), false);
});

test("hai phiếu cùng vị trí cộng dồn; đơn giá khai lấy số lớn nhất", () => {
  const [row] = consolidateStocktake(
    [
      { code: "KK-1", locationCode: "TU_DONG", lines: [{ itemId: "GA", actualQuantity: 1, unitCost: 90 }] },
      { code: "KK-2", locationCode: "TU_DONG", lines: [{ itemId: "GA", actualQuantity: 2, unitCost: 120 }] },
    ],
    [],
  );
  assert.equal(row.breakdown.TU_DONG, 3);
  assert.equal(row.declaredUnitCost, 120);
  assert.equal(row.varianceQuantity, 3);
});

test("sổ sách tại giờ chốt = tồn hiện tại − phát sinh ròng sau giờ chốt", () => {
  const book = bookAtCutoff(
    [{ itemId: "GA", quantity: 10, averageCost: 100 }],
    new Map([["GA", -4], ["BO", 2]]),
  );
  assert.equal(book.find((row) => row.itemId === "GA").quantity, 14);
  assert.equal(book.find((row) => row.itemId === "BO").quantity, -2);
});

test("chỉ nguyên liệu và bao bì được đếm theo vị trí", () => {
  assert.equal(isLocationStocktakeItemType("RAW_MATERIAL"), true);
  assert.equal(isLocationStocktakeItemType("packaging"), true);
  assert.equal(isLocationStocktakeItemType("SEMI_FINISHED"), false);
  assert.equal(isLocationStocktakeItemType("TOOL"), false);
});
