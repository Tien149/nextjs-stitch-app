/**
 * Giải trình kiểm kê (khách yêu cầu 03/10/2026): nhập/xuất trong kỳ theo loại phiếu, đầu kỳ =
 * cuối kỳ − nhập + xuất, chênh lệch = kiểm kê − cuối kỳ; phiếu điều chỉnh kiểm kê không vào cột nào.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-stocktake-explanation.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildExplanationLines } from "../lib/stocktake-explanation.ts";

const count = (itemId, closing, counted, goodsGroup = null) => ({ itemId, itemCode: itemId.toUpperCase(), itemName: itemId, goodsGroup, unit: "GR", closing, counted, unitCost: 10 });

test("tách nhập / xuất theo loại phiếu, đầu kỳ suy ra để hàng khớp", () => {
  const [line] = buildExplanationLines([count("a", 500, 480)], [
    { itemId: "a", transactionType: "NHAP_MUA", incoming: false, quantity: 1000 },
    { itemId: "a", transactionType: "DIEU_CHUYEN", incoming: true, quantity: 200 },
    { itemId: "a", transactionType: "DIEU_CHUYEN", incoming: false, quantity: 50 },
    { itemId: "a", transactionType: "NHAP_KHAC", incoming: false, quantity: 10 },
    { itemId: "a", transactionType: "NHAP_CHE_BIEN", incoming: false, quantity: 5 },
    { itemId: "a", transactionType: "XUAT_BAN", incoming: false, quantity: 300 },
    { itemId: "a", transactionType: "XUAT_HUY", incoming: false, quantity: 20 },
    { itemId: "a", transactionType: "XUAT_TEST_MON", incoming: false, quantity: 7 },
    { itemId: "a", transactionType: "XUAT_KHAC", incoming: false, quantity: 3 },
    { itemId: "a", transactionType: "XUAT_CHE_BIEN", incoming: false, quantity: 600 },
    { itemId: "a", transactionType: "XUAT_KIEM_KE", incoming: false, quantity: 999 },
  ]);
  assert.deepEqual(
    [line.inPurchase, line.inTransfer, line.inOther, line.inProduction, line.inTotal],
    [1000, 200, 10, 5, 1215],
  );
  assert.deepEqual(
    [line.outSale, line.outTransfer, line.outWaste, line.outOther, line.outProduction, line.outTotal],
    [300, 50, 20, 10, 600, 980],
  );
  assert.equal(line.opening, 500 - 1215 + 980);
  assert.equal(line.opening + line.inTotal - line.outTotal, line.closing);
  assert.equal(line.variance, -20);
  assert.equal(line.varianceValue, -200);
});

test("giữ giải trình cũ theo mã hàng, xếp theo nhóm hàng hóa rồi mã", () => {
  const lines = buildExplanationLines(
    [count("b", 1, 1, "Rau"), count("a", 2, 1, "Hải sản"), count("c", 0, 0)],
    [],
    new Map([["a", "Hư do bảo quản"]]),
  );
  assert.deepEqual(lines.map((line) => line.itemId), ["a", "b", "c"]);
  assert.equal(lines[0].explanation, "Hư do bảo quản");
  assert.equal(lines[1].explanation, "");
});
