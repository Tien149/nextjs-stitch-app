/**
 * Chi phí mua hàng phân bổ theo trị giá dòng (khách chốt 13/10/2026) — lib/purchase-cost.ts.
 * Chạy: npm run test:purchase-cost
 */
import assert from "node:assert/strict";
import test from "node:test";
import { allocatePurchaseCost } from "../lib/purchase-cost.ts";

test("chia theo trị giá dòng, tổng đúng bằng chi phí", () => {
  const shares = allocatePurchaseCost(100000, [{ amount: 300000, quantity: 1 }, { amount: 100000, quantity: 5 }]);
  assert.deepEqual(shares, [75000, 25000]);
});

test("làm tròn tới đồng, đồng dư vào dòng có phần lẻ lớn nhất", () => {
  const shares = allocatePurchaseCost(100, [{ amount: 1, quantity: 1 }, { amount: 1, quantity: 1 }, { amount: 1, quantity: 1 }]);
  assert.equal(shares.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(shares, [34, 33, 33]);
});

test("dòng hàng tặng 0 đ không nhận chi phí khi phiếu còn dòng có tiền", () => {
  assert.deepEqual(allocatePurchaseCost(5000, [{ amount: 0, quantity: 10 }, { amount: 20000, quantity: 2 }]), [0, 5000]);
});

test("phiếu toàn hàng tặng thì chia theo số lượng", () => {
  assert.deepEqual(allocatePurchaseCost(9000, [{ amount: 0, quantity: 1 }, { amount: 0, quantity: 2 }]), [3000, 6000]);
});

test("không có chi phí hoặc số âm thì 0", () => {
  assert.deepEqual(allocatePurchaseCost(0, [{ amount: 5, quantity: 1 }]), [0]);
  assert.deepEqual(allocatePurchaseCost(-10, [{ amount: 5, quantity: 1 }]), [0]);
});
