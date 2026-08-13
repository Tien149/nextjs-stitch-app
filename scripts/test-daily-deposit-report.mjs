import test from "node:test";
import assert from "node:assert/strict";
import { summarizeDailyDepositHistories } from "../lib/daily-deposit-report.ts";

const row = (action, amount, extra = {}) => ({
  action,
  amount,
  moneySourceGroup: "CASH",
  moneySourceCode: "FDSTIENMAT",
  ...extra,
});

test("cọc mới và bổ sung là tiền vào, không cộng Thu ngân khai", () => {
  const result = summarizeDailyDepositHistories([
    row("CREATE", 1_000_000),
    row("SUPPLEMENT", 500_000),
  ]);

  assert.equal(result.depositIn.cash, 1_500_000);
  assert.equal(result.offsetDeclared.cash, 0);
  assert.equal(result.directRefundOut.cash, 0);
});

test("cấn trừ chỉ cộng Thu ngân khai, không phát sinh tiền vào hoặc tiền ra", () => {
  const result = summarizeDailyDepositHistories([row("OFFSET", 400_000)]);

  assert.equal(result.offsetDeclared.cash, 400_000);
  assert.equal(result.depositIn.cash, 0);
  assert.equal(result.directRefundOut.cash, 0);
});

test("chuyển doanh thu không đi vào đối soát thu ngân và dòng tiền", () => {
  const result = summarizeDailyDepositHistories([row("TRANSFER_REVENUE", 700_000)]);

  assert.deepEqual(result, {
    depositIn: { cash: 0, transfer: 0, card: 0, grab: 0, other: 0 },
    directRefundOut: { cash: 0, transfer: 0, card: 0, grab: 0, other: 0 },
    offsetDeclared: { cash: 0, transfer: 0, card: 0, grab: 0, other: 0 },
  });
});

test("hoàn trực tiếp là tiền ra nhưng lịch sử đã có phiếu chi không bị cộng trùng", () => {
  const direct = summarizeDailyDepositHistories([row("REFUND", 300_000)]);
  const linkedVoucher = summarizeDailyDepositHistories([row("REFUND", 300_000, { voucherId: "voucher-1" })]);

  assert.equal(direct.directRefundOut.cash, 300_000);
  assert.equal(linkedVoucher.directRefundOut.cash, 0);
});

test("cấn trừ cọc Grab giữ đúng bucket Grab", () => {
  const result = summarizeDailyDepositHistories([
    row("OFFSET", 615_000, {
      moneySourceGroup: "WALLET",
      moneySourceCode: "FDSGRABFOOD",
      moneySourceName: "Grab Food",
    }),
  ]);

  assert.equal(result.offsetDeclared.grab, 615_000);
  assert.equal(result.offsetDeclared.card, 0);
});

test("điều chỉnh tăng/giảm được phản ánh đúng ngày thao tác", () => {
  const result = summarizeDailyDepositHistories([
    row("UPDATE", 100_000),
    row("UPDATE", -40_000),
  ]);

  assert.equal(result.depositIn.cash, 100_000);
  assert.equal(result.directRefundOut.cash, 40_000);
});
