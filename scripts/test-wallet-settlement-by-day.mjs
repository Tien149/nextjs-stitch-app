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

test("ngày chưa có doanh thu POS không chặn cả phiếu: các ngày khác vẫn ra phí, ngày thiếu phí tạm 0", () => {
  const result = planWalletGrossByDay({
    lines,
    revenueByDay: new Map([["2026-08-07", 22_878_093], ["2026-08-09", 18_627_861]]),
    claimedByDay: new Map(),
    walletLabel: "FDS - Quẹt Thẻ Momo",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.pendingDays.map((row) => row.day), ["2026-08-08"]);
  assert.match(result.plan.pendingDays[0].reason, /0?8\/0?8\/2026/);
  assert.deepEqual(result.plan.days.map((row) => row.feeAmount), [377_489, 0, 307_359]);
  assert.equal(result.plan.lineGross[1], 29_914_137);
  assert.equal(result.plan.totalFee, 377_489 + 307_359);
});

test("ngày chờ doanh thu giữ nguyên gross đang ghi trên dòng", () => {
  const result = planWalletGrossByDay({
    lines: [lines[0], { ...lines[1], grossAmount: 30_416_001 }],
    revenueByDay: new Map([["2026-08-07", 22_878_093]]),
    claimedByDay: new Map(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.totalFee, 377_489 + 501_864);
});

test("không ngày nào có doanh thu thì không tính, giữ nguyên phiếu", () => {
  const result = planWalletGrossByDay({ lines, revenueByDay: new Map(), claimedByDay: new Map() });
  assert.equal(result.ok, false);
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

// Ca QTVI-2608-NME-00090 (26/09/2026): Grab trả đầu tháng 8 gộp doanh thu 31/07 (trước ngày lên
// hệ thống 01/08) và 01/08. Ngày 31/07 không ghi phí dù có số doanh thu, ngày 01/08 tính bình thường.
test("ngày doanh thu trước ngày lên hệ thống: phí 0, gross = tiền về, không chặn phiếu", () => {
  const result = planWalletGrossByDay({
    lines: [
      { revenueDate: d("2026-07-31"), netAmount: 5_000_000, grossAmount: 5_649_131 },
      { revenueDate: d("2026-08-01"), netAmount: 3_000_000 },
    ],
    revenueByDay: new Map([["2026-07-31", 5_649_131], ["2026-08-01", 3_300_000]]),
    claimedByDay: new Map(),
    goLiveDay: "2026-08-01",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.lineGross, [5_000_000, 3_300_000]);
  assert.deepEqual(result.plan.days.map((row) => row.feeAmount), [0, 300_000]);
  assert.equal(result.plan.pendingDays.length, 0);
});
