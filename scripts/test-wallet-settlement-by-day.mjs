import test from "node:test";
import assert from "node:assert/strict";
import { planWalletGrossByDay } from "../lib/wallet-settlement-by-day.ts";

const d = (value) => new Date(`${value}T00:00:00Z`);

// Ca thật 126B2680FCCJ1ACG: Momo trả gộp 07, 08, 09/08 trong một lần ngày 10/08.
const lines = [
  { revenueDate: d("2026-08-07"), netAmount: 22_500_604 },
  { revenueDate: d("2026-08-08"), netAmount: 29_914_137 },
  { revenueDate: d("2026-08-09"), netAmount: 18_320_502 },
];
const revenueByDay = new Map([
  ["2026-08-07", 22_878_093],
  ["2026-08-08", 30_416_001],
  ["2026-08-09", 18_627_861],
]);

test("phí tính riêng từng ngày: đủ 1.186.712 đ chứ không chỉ phí ngày cuối", () => {
  const result = planWalletGrossByDay({ lines, revenueByDay, claimedByDay: new Map() });
  assert.equal(result.ok, true);
  assert.equal(result.plan.totalNet, 70_735_243);
  assert.equal(result.plan.totalGross, 71_921_955);
  assert.equal(result.plan.totalFee, 1_186_712);
  assert.deepEqual(result.plan.days.map((row) => row.feeAmount), [377_489, 501_864, 307_359]);
  assert.deepEqual(result.plan.lineGross, [22_878_093, 30_416_001, 18_627_861]);
});

test("phần gross ngày đó đã được sao kê khác nhận thì trừ ra", () => {
  const result = planWalletGrossByDay({
    lines: [{ revenueDate: d("2026-08-07"), netAmount: 10_000_000 }],
    revenueByDay: new Map([["2026-08-07", 22_878_093]]),
    claimedByDay: new Map([["2026-08-07", 12_700_000]]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.totalGross, 10_178_093);
  assert.equal(result.plan.totalFee, 178_093);
});

test("ngày chưa đủ doanh thu POS thì không tính, báo đúng ngày", () => {
  const result = planWalletGrossByDay({
    lines,
    revenueByDay: new Map([["2026-08-07", 22_878_093], ["2026-08-09", 18_627_861]]),
    claimedByDay: new Map(),
    walletLabel: "FDS - Quẹt Thẻ Momo",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /0?8\/0?8\/2026/);
});

test("doanh thu nhỏ hơn tiền về (khai sai ngày) thì dừng, không ra phí âm", () => {
  const result = planWalletGrossByDay({
    lines: [{ revenueDate: d("2026-08-09"), netAmount: 70_735_243 }],
    revenueByDay,
    claimedByDay: new Map(),
  });
  assert.equal(result.ok, false);
});

test("hai dòng cùng ngày chia gross theo tỷ trọng, tổng khớp tuyệt đối", () => {
  const result = planWalletGrossByDay({
    lines: [
      { revenueDate: d("2026-08-07"), netAmount: 10_000_000 },
      { revenueDate: d("2026-08-07"), netAmount: 12_500_604 },
    ],
    revenueByDay,
    claimedByDay: new Map(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.lineGross[0] + result.plan.lineGross[1], 22_878_093);
  assert.equal(result.plan.totalFee, 377_489);
});
