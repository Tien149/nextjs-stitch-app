import test from "node:test";
import assert from "node:assert/strict";
import { checkWalletFeeRate, walletFeeRateMessage, WALLET_FEE_RATE_LIMITS } from "../lib/wallet-settlement-allocation.ts";

test("ca that 08/2026: phi 98% cua vi Momo ASA phai bi chan", () => {
  // QTVI-2608-ASA-00047: ve 328.391 d, phi 22.286.614 d — Gross khai cho ca ngay trong khi
  // ngan hang moi tra mot dot.
  const check = checkWalletFeeRate("CARD_WALLET", 22_615_005, 328_391);
  assert.equal(check.ok, false);
  assert.ok(check.rate > 0.98);
  assert.match(walletFeeRateMessage(check, 22_615_005, 328_391), /không quá 10%/);
});

test("phi quet the that (1,6%) van di qua", () => {
  // QTVI-2608-NME-00022 truoc khi bi sua: 1.811.556 -> 1.782.837.
  const check = checkWalletFeeRate("CARD_WALLET", 1_811_556, 1_782_837);
  assert.equal(check.ok, true);
  assert.equal(check.feeAmount, 28_719);
});

test("hoa hong Grab 24,5% nam trong nguong rieng cua Grab", () => {
  const grab = checkWalletFeeRate("GRAB", 2_627_000, 1_977_869);
  assert.equal(grab.ok, true);
  // Cung con so do ma la vi the thi phai chan.
  assert.equal(checkWalletFeeRate("CARD_WALLET", 2_627_000, 1_977_869).ok, false);
});

test("phi bang 0 va so hop le deu ok", () => {
  assert.equal(checkWalletFeeRate("CARD_WALLET", 1_000_000, 1_000_000).ok, true);
  assert.equal(checkWalletFeeRate("CARD_WALLET", 1_000_000, 900_000).ok, true);
});

test("so vo ly khong duoc coi la hop le", () => {
  // Gross nho hon tien ve, gross am, tien ve 0.
  assert.equal(checkWalletFeeRate("CARD_WALLET", 900_000, 1_000_000).ok, false);
  assert.equal(checkWalletFeeRate("CARD_WALLET", 0, 1_000_000).ok, false);
  assert.equal(checkWalletFeeRate("CARD_WALLET", 1_000_000, 0).ok, false);
  assert.equal(checkWalletFeeRate("CARD_WALLET", 1_000_000, 0).rate, null);
});

test("nguong doc tu file dung chung voi script backfill", () => {
  assert.equal(WALLET_FEE_RATE_LIMITS.CARD_WALLET, 0.1);
  assert.equal(WALLET_FEE_RATE_LIMITS.GRAB, 0.35);
});
