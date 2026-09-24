import test from "node:test";
import assert from "node:assert/strict";
import { splitWalletFeeByDay, walletFeeDayLines } from "../lib/wallet-fee-journal.ts";

const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

test("phí chia theo phí từng dòng sao kê khi mọi dòng đã có gross (khớp bảng Tiền về đủ chưa)", () => {
  // Ca Nam Mê: Momo trả gộp 01/08 + 02/08, phí từng ngày 782.825 và 721.226.
  const days = splitWalletFeeByDay({
    feeAmount: 1_504_051,
    grabExpenseAmount: 0,
    lines: [
      { day: "2026-08-02", netAmount: 42_989_455, grossAmount: 43_710_681 },
      { day: "2026-08-01", netAmount: 46_661_173, grossAmount: 47_443_998 },
    ],
    fallbackDay: "2026-08-02",
  });
  assert.deepEqual(days, [
    { day: "2026-08-01", cardFee: 782_825, grabFee: 0 },
    { day: "2026-08-02", cardFee: 721_226, grabFee: 0 },
  ]);
});

test("dòng cũ thiếu gross: chia theo tiền thực về, giữ tổng tới đồng", () => {
  const days = splitWalletFeeByDay({
    feeAmount: 1_000,
    grabExpenseAmount: 0,
    lines: [
      { day: "2026-07-31", netAmount: 1, grossAmount: 0 },
      { day: "2026-08-01", netAmount: 1, grossAmount: null },
      { day: "2026-08-02", netAmount: 1, grossAmount: 5 },
    ],
    fallbackDay: "2026-08-02",
  });
  assert.equal(days.length, 3);
  assert.equal(sum(days, "cardFee"), 1_000);
  assert.ok(days.every((d) => d.cardFee >= 333 && d.cardFee <= 334));
});

test("không nối dòng sao kê nào: cả phí về ngày dự phòng", () => {
  const days = splitWalletFeeByDay({ feeAmount: 507_000, grabExpenseAmount: 0, lines: [], fallbackDay: "2026-08-10" });
  assert.deepEqual(days, [{ day: "2026-08-10", cardFee: 507_000, grabFee: 0 }]);
});

test("phí Grab tách riêng, tổng Grab và thẻ đều giữ nguyên", () => {
  const days = splitWalletFeeByDay({
    feeAmount: 1_001,
    grabExpenseAmount: 1_001,
    lines: [
      { day: "2026-08-01", netAmount: 700, grossAmount: 1_200 },
      { day: "2026-08-02", netAmount: 700, grossAmount: 1_201 },
    ],
    fallbackDay: "2026-08-02",
  });
  assert.equal(sum(days, "grabFee"), 1_001);
  assert.equal(sum(days, "cardFee"), 0);
});

test("bút toán phí một ngày cân Nợ/Có và mang hạng mục P&L chuẩn", () => {
  const lines = walletFeeDayLines(
    { day: "2026-08-01", cardFee: 300, grabFee: 200 },
    { feeCategoryCode: "CHI_PHI_QUET_THE", grabExpenseCategoryCode: "CHI_PHI_BAN_HANG_GRAB", fromAccountCode: "1121" },
  );
  const debit = lines.reduce((s, l) => s + (l.debit || 0), 0);
  const credit = lines.reduce((s, l) => s + (l.credit || 0), 0);
  assert.equal(debit, 500);
  assert.equal(credit, 500);
  assert.deepEqual(lines.filter((l) => l.debit).map((l) => l.pnlItemCode).sort(), ["PNL_CP_BANHANG_GRAB", "PNL_CP_QUETTHE"]);
});
