import test from "node:test";
import assert from "node:assert/strict";
import {
  remainingWalletGross,
  selectWalletDeclaredRevenue,
  walletRevenueBucket,
} from "../lib/wallet-revenue-reconciliation.ts";

const momo = { code: "FDSMOMO", name: "MoMo" };
const vnpay = { code: "FDSVNPAY", name: "VNPay" };
const grab = { code: "FDSGRABFOOD", name: "Grab Food" };

const pos = (paymentMethod, netAmount) => ({ paymentMethod, revenueSource: "THU_BAN_HANG", channel: "POS", netAmount });
const manual = (cardAmount, grabAmount) => ({ cardAmount, grabAmount });

test("classifies Grab separately from card/wallet sources", () => {
  assert.equal(walletRevenueBucket(grab), "GRAB");
  assert.equal(walletRevenueBucket(momo), "CARD_WALLET");
  assert.equal(walletRevenueBucket(vnpay), "CARD_WALLET");
});

test("POS wins when POS and manual revenue both exist", () => {
  const result = selectWalletDeclaredRevenue({
    posRows: [pos("MOMO", 900)],
    manualRows: [manual(5_000, 0)],
    bucketSources: [momo, vnpay],
    bucket: "CARD_WALLET",
  });
  assert.deepEqual(result, { source: "POS", amount: 900 });
});

test("does not use manual as a supplement when the day has any POS row", () => {
  const result = selectWalletDeclaredRevenue({
    posRows: [pos("CASH", 1_000)],
    manualRows: [manual(5_000, 0)],
    bucketSources: [momo, vnpay],
    bucket: "CARD_WALLET",
  });
  assert.deepEqual(result, { source: "POS", amount: 0 });
});

test("falls back to manual cardAmount when the day has no POS", () => {
  const result = selectWalletDeclaredRevenue({
    posRows: [],
    manualRows: [manual(49_596_998, 1_000)],
    bucketSources: [momo, vnpay],
    bucket: "CARD_WALLET",
  });
  assert.deepEqual(result, { source: "MANUAL", amount: 49_596_998 });
});

test("MoMo and VNPay share one manual cardAmount bucket", () => {
  const sources = [momo, vnpay];
  const first = selectWalletDeclaredRevenue({ posRows: [], manualRows: [manual(10_000, 0)], bucketSources: sources, bucket: "CARD_WALLET" });
  assert.equal(first.amount, 10_000);
  assert.equal(remainingWalletGross(first.amount, 6_000), 4_000);
  assert.equal(remainingWalletGross(first.amount, 10_000), 0);
});

test("Grab uses grabAmount and never cardAmount", () => {
  const result = selectWalletDeclaredRevenue({
    posRows: [],
    manualRows: [manual(49_596_998, 2_153_000)],
    bucketSources: [grab],
    bucket: "GRAB",
  });
  assert.deepEqual(result, { source: "MANUAL", amount: 2_153_000 });
});

test("sums split-shift manual entries exactly once", () => {
  const result = selectWalletDeclaredRevenue({
    posRows: [],
    manualRows: [manual(20_000, 500), manual(30_000, 700)],
    bucketSources: [momo],
    bucket: "CARD_WALLET",
  });
  assert.equal(result.amount, 50_000);
});

test("returns NONE when neither POS nor manual revenue exists", () => {
  const result = selectWalletDeclaredRevenue({ posRows: [], manualRows: [], bucketSources: [momo], bucket: "CARD_WALLET" });
  assert.deepEqual(result, { source: "NONE", amount: 0 });
});

test("remaining gross never becomes negative", () => {
  assert.equal(remainingWalletGross(10_000, 12_000), 0);
});
