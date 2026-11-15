import test from "node:test";
import assert from "node:assert/strict";
import { buildWalletFeeCheck, expectedWalletFee } from "../lib/wallet-fee-check.ts";

const cell = (date, code, revenue, received, group = "WALLET") => ({
  date, moneySourceCode: code, moneySourceName: code, branchCode: "NME", group, revenue, received, remaining: revenue - received,
});

test("phí đúng: chỉ ví đã có tiền về mà còn thiếu", () => {
  assert.equal(expectedWalletFee(cell("2026-10-19", "VNPAY", 1000, 980)), 20);
  assert.equal(expectedWalletFee(cell("2026-10-19", "VNPAY", 1000, 0)), 0); // chưa về
  assert.equal(expectedWalletFee(cell("2026-10-19", "VNPAY", 1000, 1200)), 0); // về dư
  assert.equal(expectedWalletFee(cell("2026-10-19", "VCB", 1000, 900, "BANK")), 0);
});

test("ca thật 24/10 VNPAY: ghi sổ thừa 792.666 đ thì báo kèm mã phiếu", () => {
  const check = buildWalletFeeCheck({
    cells: [cell("2026-10-24", "FDSTHEVNPAY", 60_600_598, 59_631_957), cell("2026-10-25", "FDSTHEVNPAY", 54_132_227, 53_106_973)],
    booked: [
      { date: "2026-10-24", moneySourceCode: "FDSTHEVNPAY", amount: 1_761_307, voucherCode: "QTVI-2610-NME-00056" },
      { date: "2026-10-25", moneySourceCode: "FDSTHEVNPAY", amount: 1_025_254, voucherCode: "QTVI-2610-NME-00056" },
    ],
    sourceOf: () => null,
    vouchersOf: (date) => (date === "2026-10-24" ? ["QTVI-2610-NME-00061"] : []),
  });
  assert.equal(check.rows.length, 1);
  assert.equal(check.rows[0].gap, 792_666);
  assert.deepEqual(check.rows[0].voucherCodes, ["QTVI-2610-NME-00056", "QTVI-2610-NME-00061"]);
});

test("lệch làm tròn dưới 1.000 đ không báo; phí ghi vào ngày không có ô vẫn báo", () => {
  const check = buildWalletFeeCheck({
    cells: [cell("2026-10-04", "GRAB", 1000_000, 800_000)],
    booked: [
      { date: "2026-10-04", moneySourceCode: "GRAB", amount: 200_001, voucherCode: "A" },
      { date: "2026-07-31", moneySourceCode: "GRAB", amount: 649_131, voucherCode: "B" },
    ],
    sourceOf: (code) => ({ name: `Ví ${code}`, branchCode: "NME" }),
  });
  assert.equal(check.rows.length, 1);
  assert.equal(check.rows[0].date, "2026-07-31");
  assert.equal(check.rows[0].moneySourceName, "Ví GRAB");
  assert.equal(check.expectedTotal, 200_000);
  assert.equal(check.bookedTotal, 849_132);
});
