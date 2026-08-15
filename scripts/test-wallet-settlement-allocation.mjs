import test from "node:test";
import assert from "node:assert/strict";
import { allocateWalletSettlementGroup } from "../lib/wallet-settlement-allocation.ts";

test("ASA 01/08 splits Grab expense and card fee without losing one dong", () => {
  const rows = allocateWalletSettlementGroup({
    grossAmount: 39_256_465,
    grabRevenueAmount: 655_000,
    transactions: [
      { id: "98304-03082026-330", netAmount: 27_382_720 },
      { id: "48738-03082026-558", netAmount: 10_581_821 },
    ],
  });

  assert.equal(rows.reduce((sum, row) => sum + row.netAmount, 0), 37_964_541);
  assert.equal(rows.reduce((sum, row) => sum + row.grossAmount, 0), 39_256_465);
  assert.equal(rows.reduce((sum, row) => sum + row.feeAmount, 0), 1_291_924);
  assert.equal(rows.reduce((sum, row) => sum + row.grabExpenseAmount, 0), 655_000);
  assert.equal(rows.reduce((sum, row) => sum + row.cardFeeAmount, 0), 636_924);
  assert.ok(rows.every((row) => row.grossAmount === row.netAmount + row.feeAmount));
});

test("single auto settlement keeps the exact gross and fee", () => {
  const [row] = allocateWalletSettlementGroup({
    grossAmount: 1_000_000,
    grabRevenueAmount: 0,
    transactions: [{ id: "one", netAmount: 970_000 }],
  });
  assert.deepEqual(row, {
    id: "one",
    netAmount: 970_000,
    grossAmount: 1_000_000,
    feeAmount: 30_000,
    grabExpenseAmount: 0,
    cardFeeAmount: 30_000,
  });
});

test("rejects a group whose bank net exceeds wallet gross", () => {
  assert.throws(() => allocateWalletSettlementGroup({
    grossAmount: 900_000,
    grabRevenueAmount: 0,
    transactions: [{ id: "bad", netAmount: 1_000_000 }],
  }), /gross Ví nhỏ hơn/);
});
