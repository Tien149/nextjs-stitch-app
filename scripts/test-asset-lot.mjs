/**
 * Tài sản/CCDC nhiều đợt dưới một mã (lib/asset-lot.ts, 26/09/2026).
 *   npm run test:asset-lot
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assetLotLabel, assetPayableCode, assetAcquisitionJournalCode, distributeStocktakeCount, groupAssetLots } from "../lib/asset-lot.ts";

test("nhãn và mã công nợ/bút toán: đợt 1 giữ dạng cũ, đợt sau thêm hậu tố", () => {
  assert.equal(assetLotLabel({ code: "CCDCKIT0003", lotNo: 1 }), "CCDCKIT0003");
  assert.equal(assetLotLabel({ code: "CCDCKIT0003" }), "CCDCKIT0003");
  assert.equal(assetLotLabel({ code: "CCDCKIT0003", lotNo: 2 }), "CCDCKIT0003 · đợt 2");
  assert.equal(assetPayableCode({ code: "CCDCKIT0003", lotNo: 1 }), "CN-CCDCKIT0003");
  assert.equal(assetPayableCode({ code: "CCDCKIT0003", lotNo: 3 }), "CN-CCDCKIT0003-L3");
  assert.equal(assetAcquisitionJournalCode({ code: "TSCDBAR0001", lotNo: 2 }), "JE-ASSET-TSCDBAR0001-L2");
});

const lots = [
  { id: "a", lotNo: 1, quantity: 5 },
  { id: "b", lotNo: 2, quantity: 3 },
];

test("đếm đúng bằng sổ: từng đợt giữ nguyên", () => {
  assert.deepEqual(distributeStocktakeCount(lots, 8).map((lot) => [lot.id, lot.systemQuantity, lot.actualQuantity]), [["a", 5, 5], ["b", 3, 3]]);
});

test("đếm thừa: phần thừa ghi vào đợt mới nhất", () => {
  assert.deepEqual(distributeStocktakeCount(lots, 10).map((lot) => [lot.id, lot.actualQuantity]), [["a", 5], ["b", 5]]);
});

test("đếm thiếu: trừ từ đợt mới nhất về đợt cũ", () => {
  assert.deepEqual(distributeStocktakeCount(lots, 6).map((lot) => [lot.id, lot.actualQuantity]), [["a", 5], ["b", 1]]);
  assert.deepEqual(distributeStocktakeCount(lots, 2).map((lot) => [lot.id, lot.actualQuantity]), [["a", 2], ["b", 0]]);
  assert.deepEqual(distributeStocktakeCount(lots, 0).map((lot) => [lot.id, lot.actualQuantity]), [["a", 0], ["b", 0]]);
});

test("đợt truyền vào không theo thứ tự vẫn chia đúng; số âm coi như 0", () => {
  const shuffled = [lots[1], lots[0]];
  assert.deepEqual(distributeStocktakeCount(shuffled, 9).map((lot) => [lot.id, lot.actualQuantity]), [["a", 5], ["b", 4]]);
  assert.deepEqual(distributeStocktakeCount(lots, -3).map((lot) => lot.actualQuantity), [0, 0]);
  assert.deepEqual(distributeStocktakeCount([], 4), []);
});

test("gom đợt theo mã, giữ thứ tự mã xuất hiện và sắp đợt tăng dần", () => {
  const grouped = groupAssetLots([
    { code: "B", lotNo: 2 },
    { code: "A", lotNo: 1 },
    { code: "B", lotNo: 1 },
  ]);
  assert.deepEqual(grouped.map((group) => [group.code, group.lots.map((lot) => lot.lotNo)]), [["B", [1, 2]], ["A", [1]]]);
});
