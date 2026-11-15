import test from "node:test";
import assert from "node:assert/strict";
import { allocateByWeight, planWalletFeeRecalc } from "../lib/wallet-fee-recalc-plan.ts";

const cell = (date, code, revenue, received) => ({
  date, moneySourceCode: code, moneySourceName: code, branchCode: "NME", group: "WALLET", revenue, received, remaining: revenue - received,
});
const voucher = (id, wallet = "VNPAY", fee = 0, extra = {}) => ({ id, code: id, walletCode: wallet, feeAmount: fee, grabExpenseAmount: 0, isGrab: false, locked: false, ...extra });
const line = (id, day, credit, voucherId, gross = null, wallet = "VNPAY") => ({ id, day, walletCode: wallet, creditAmount: credit, grossAmount: gross, voucherId });
const all = () => true;

test("chia số nguyên giữ tổng tới đồng", () => {
  assert.deepEqual(allocateByWeight(10, [1, 1, 1]), [4, 3, 3]);
  assert.equal(allocateByWeight(822_343, [36_569_732, 1_508_577]).reduce((a, b) => a + b, 0), 822_343);
});

test("ca thật 19–20/10 VNPAY NAM MÊ: hai phiếu cùng ngày chia phí ngày theo tiền về, không phiếu nào ôm cả ngày", () => {
  const plan = planWalletFeeRecalc({
    cells: [cell("2026-10-19", "VNPAY", 38_900_652, 36_569_732 + 1_508_577), cell("2026-10-20", "VNPAY", 32_090_520, 31_412_141)],
    lines: [
      line("a19", "2026-10-19", 36_569_732, "v64"),
      line("a20", "2026-10-20", 31_412_141, "v64"),
      line("b19", "2026-10-19", 1_508_577, "v45", 38_900_652),
    ],
    vouchers: [voucher("v64", "VNPAY", 0), voucher("v45", "VNPAY", 37_392_075)],
    inScope: all,
  });
  const fee = Object.fromEntries(plan.changes.map((c) => [c.id, c.feeAfter]));
  assert.equal(fee.v64 + fee.v45, 822_343 + 678_379);
  assert.ok(fee.v45 < 40_000, `v45 = ${fee.v45}`);
  assert.equal(plan.lineUpdates.find((row) => row.id === "b19").grossAmount, 1_508_577 + fee.v45);
});

test("ngày chưa có doanh thu POS giữ phí đang lưu; ngày ngoài phạm vi cũng vậy", () => {
  const plan = planWalletFeeRecalc({
    cells: [cell("2026-10-31", "VNPAY", 1_000_000, 980_000)],
    lines: [line("x", "2026-10-30", 500_000, "v1", 505_000), line("y", "2026-10-31", 980_000, "v1"), line("z", "2026-11-01", 700_000, "v1", 707_000)],
    vouchers: [voucher("v1", "VNPAY", 0)],
    inScope: (day) => day.startsWith("2026-10"),
  });
  assert.equal(plan.changes[0].feeAfter, 5_000 + 20_000 + 7_000);
  assert.deepEqual(plan.skippedDays.map((row) => row.day), ["2026-10-30"]);
});

test("ví Grab: toàn bộ phí là chi phí Grab; phiếu khoá không đụng, phần của nó giữ nguyên", () => {
  const plan = planWalletFeeRecalc({
    cells: [cell("2026-09-29", "GRAB", 1_000_000, 700_000)],
    lines: [line("g1", "2026-09-29", 400_000, "open", null, "GRAB"), line("g2", "2026-09-29", 300_000, "lock", 400_000, "GRAB")],
    vouchers: [voucher("open", "GRAB", 197_284, { isGrab: true }), voucher("lock", "GRAB", 100_000, { isGrab: true, locked: true })],
    inScope: all,
  });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].id, "open");
  assert.equal(plan.changes[0].feeAfter, 200_000);
  assert.equal(plan.changes[0].grabAfter, 200_000);
});

test("doanh thu trước ngày lên hệ thống: phí 0; về dư: phí 0", () => {
  const plan = planWalletFeeRecalc({
    cells: [cell("2026-08-02", "VNPAY", 1_000_000, 1_100_000)],
    lines: [line("p", "2026-07-31", 649_131, "v1", 1_298_262), line("q", "2026-08-02", 1_100_000, "v1")],
    vouchers: [voucher("v1", "VNPAY", 649_131)],
    inScope: all,
    goLiveDay: "2026-08-01",
  });
  assert.equal(plan.changes[0].feeAfter, 0);
});
