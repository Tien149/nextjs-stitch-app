import assert from "node:assert/strict";
import test from "node:test";
import { breakEvenOf, costTotalsOf, opexKindOf, splitOpex } from "../components/reports/planning/cost-structure.ts";

const bucket = (values) => ({ revenue: 0, cogs: 0, payroll: 0, otherOpex: 0, otherIncome: 0, otherExpense: 0, capex: 0, interest: 0, ...values });

test("nhóm OPEX: cố định / marketing / biến đổi theo tên, nhóm khác vào cố định", () => {
  assert.equal(opexKindOf("A. Chi phí cố định"), "fixed");
  assert.equal(opexKindOf("C. Chi phí Marketing"), "marketing");
  assert.equal(opexKindOf("B. Chi phí biến đổi"), "variable");
  assert.equal(opexKindOf("Chi phí khác"), "fixed");
});

test("FC = CAPEX + cố định + nhân sự; VC = giá vốn + biến đổi + marketing", () => {
  const buckets = [bucket({ revenue: 1000, cogs: 300, payroll: 150, otherOpex: 200, capex: 50 })];
  const data = { statement: [{ key: "otherOpex", groups: [
    { name: "Chi phí cố định", months: [90], plan: null },
    { name: "Chi phí Marketing", months: [40], plan: null },
    { name: "Chi phí biến đổi", months: [60], plan: null },
  ] }] };
  const split = splitOpex(data, buckets, false);
  // 200 − 40 − 60 = 100: gồm 90 nhóm cố định + 10 OPEX chưa gắn nhóm.
  assert.deepEqual([split.fixed[0], split.marketing[0], split.variable[0]], [100, 40, 60]);
  const result = breakEvenOf(costTotalsOf(buckets, split));
  assert.equal(result.fixed, 50 + 100 + 150);
  assert.equal(result.variable, 300 + 60 + 40);
  assert.equal(Math.round(result.bep), Math.round(300 / (1 - 0.4)));
});

test("biến phí ≥ doanh thu thì không có điểm hòa vốn", () => {
  assert.equal(breakEvenOf({ revenue: 100, cogs: 100, payroll: 0, capex: 0, opexFixed: 10, opexMarketing: 0, opexVariable: 0 }).bep, null);
});
