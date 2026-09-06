import assert from "node:assert/strict";
import test from "node:test";
import { bucketOperatingCost, bucketSum, lastPicked, monthPickLabel, monthPickSummary, nodeValue, sumMonths } from "../components/reports/planning/planning-types.ts";

/**
 * Chip "Lũy kế tháng" cho tick từng tháng tùy ý (feedback khách 06/09/2026) nên mọi phép cộng
 * của cụm Hoạch định phải chạy theo DANH SÁCH tháng, không còn là "cộng từ T1 tới tháng N".
 */

const bucketOf = (revenue, payroll = 0, otherOpex = 0, depreciation = 0) => ({ revenue, payroll, otherOpex, depreciation });
const buckets = Array.from({ length: 12 }, (_, index) => bucketOf((index + 1) * 100, index + 1, 10, 1));

test("cộng đúng các tháng được tick, kể cả khi rời rạc", () => {
  const values = Array.from({ length: 12 }, (_, index) => index + 1);
  assert.equal(sumMonths(values, [0, 1, 2]), 6);
  assert.equal(sumMonths(values, [7]), 8);
  assert.equal(sumMonths(values, [1, 4, 8]), 2 + 5 + 9);
  assert.equal(sumMonths(values, []), 0);
  // Tháng ngoài khoảng không được làm hỏng tổng.
  assert.equal(sumMonths(values, [11, 20]), 12);
});

test("bucketSum / bucketOperatingCost đi theo đúng danh sách tháng", () => {
  assert.equal(bucketSum(buckets, "revenue", [7]), 800);
  assert.equal(bucketSum(buckets, "revenue", [0, 1, 2, 3, 4, 5, 6, 7]), 3600);
  assert.equal(bucketOperatingCost(buckets, [0, 2]), 1 + 10 + 1 + (3 + 10 + 1));
});

test("nodeValue lấy kế hoạch hay thực tế theo đúng tháng đang tick", () => {
  const node = { months: [1, 2, 3, 4], plan: [10, 20, 30, 40] };
  assert.equal(nodeValue(node, [1, 3], "actual"), 6);
  assert.equal(nodeValue(node, [1, 3], "plan"), 60);
  assert.equal(nodeValue({ months: [1, 2], plan: null }, [0, 1], "plan"), 0);
});

test("nhãn vùng tháng gọn khi liền mạch, liệt kê khi rời rạc", () => {
  assert.equal(monthPickLabel([]), "chưa chọn tháng");
  assert.equal(monthPickLabel([7]), "T8");
  assert.equal(monthPickLabel([0, 1, 2, 3, 4, 5, 6, 7]), "T1–T8");
  assert.equal(monthPickLabel([7, 2, 4]), "T3, T5, T8");
  assert.equal(monthPickSummary([0, 1]), "2 tháng (T1–T2)");
  assert.equal(monthPickSummary([]), "chưa chọn tháng");
});

test("mốc tháng lớn nhất cho các bảng/chart lũy kế", () => {
  assert.equal(lastPicked([]), -1);
  assert.equal(lastPicked([2, 9, 4]), 9);
});
