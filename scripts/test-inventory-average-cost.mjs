/**
 * Giá vốn bình quân toàn hệ thống cho cost định lượng — kho tồn âm không được kéo giá vọt lên.
 * Chạy: npm run test:average-cost
 */
import assert from "node:assert/strict";
import test from "node:test";
import { averageCostByItem } from "../lib/inventory-average-cost.ts";

test("kho tồn âm không cộng vào bình quân (trước đây ra 1.090 đ/gr)", () => {
  const costs = averageCostByItem([
    { itemId: "GA", quantity: 1000, averageCost: 100 },
    { itemId: "GA", quantity: -990, averageCost: 90 },
  ]);
  assert.equal(costs.get("GA"), 100);
});

test("nhiều kho dương vẫn bình quân gia quyền như cũ", () => {
  const costs = averageCostByItem([
    { itemId: "GA", quantity: 100, averageCost: 100 },
    { itemId: "GA", quantity: 300, averageCost: 120 },
  ]);
  assert.equal(costs.get("GA"), 115);
});

test("mọi kho đều âm: bình quân theo độ lớn tồn, không tuỳ thứ tự dữ liệu", () => {
  const forward = averageCostByItem([
    { itemId: "GA", quantity: -100, averageCost: 100 },
    { itemId: "GA", quantity: -300, averageCost: 120 },
  ]);
  const backward = averageCostByItem([
    { itemId: "GA", quantity: -300, averageCost: 120 },
    { itemId: "GA", quantity: -100, averageCost: 100 },
  ]);
  assert.equal(forward.get("GA"), 115);
  assert.equal(backward.get("GA"), 115);
});

test("vừa xuất hết (tồn 0) vẫn giữ giá cũ, không rơi về 0", () => {
  const costs = averageCostByItem([{ itemId: "GA", quantity: 0, averageCost: 95 }]);
  assert.equal(costs.get("GA"), 95);
});

test("không kho nào có giá thì 0", () => {
  const costs = averageCostByItem([{ itemId: "GA", quantity: -5, averageCost: 0 }]);
  assert.equal(costs.get("GA"), 0);
});
