import assert from "node:assert/strict";
import test from "node:test";
import { effectiveMoneyTransferDate } from "../lib/money-transfer-date.ts";

const transferDate = new Date("2026-08-10T00:00:00.000Z");
const actualTransferDate = new Date("2026-08-12T00:00:00.000Z");

test("cash deposit uses actual transfer date", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: "CASH_DEPOSIT" }), actualTransferDate);
});

test("legacy cash deposit falls back to transfer date", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate: null, transferPurpose: "CASH_DEPOSIT" }), transferDate);
});

test("internal transfer keeps transfer date", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: null }), transferDate);
});

test("wallet settlement keeps transfer date", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: "WALLET_SETTLEMENT" }), transferDate);
});
