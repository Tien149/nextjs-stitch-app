import assert from "node:assert/strict";
import test from "node:test";
import { cleanMoneySourceName, stripMoneySourceLabel } from "../lib/money-sources.ts";
import { revenueMatchesWalletSource } from "../lib/wallet-revenue-reconciliation.ts";

test("bỏ cụm quẹt thẻ / chuyển khoản khỏi tên nguồn tiền", () => {
  assert.equal(stripMoneySourceLabel("FDS quẹt thẻ viettinbank"), "FDS viettinbank");
  assert.equal(stripMoneySourceLabel("ASA - Chuyển Khoản Sacombank (HKD)"), "ASA - Sacombank (HKD)");
  assert.equal(stripMoneySourceLabel("Máy POS quẹt thẻ Asa"), "Máy POS Asa");
  assert.equal(stripMoneySourceLabel("POS quẹt thẻ"), "POS");
});

test("cắt cả bản không dấu, không phân biệt hoa thường", () => {
  assert.equal(stripMoneySourceLabel("FDSCHKHVIET chuyen khoan"), "FDSCHKHVIET");
  assert.equal(stripMoneySourceLabel("FDS QUẸT THẺ Vietinbank"), "FDS Vietinbank");
  assert.equal(stripMoneySourceLabel("FDS QuetThe Vietinbank"), "FDS Vietinbank");
});

test("dọn dấu nối và ngoặc bị mồ côi sau khi cắt", () => {
  assert.equal(stripMoneySourceLabel("FDS - Quẹt Thẻ - Vietinbank"), "FDS - Vietinbank");
  assert.equal(stripMoneySourceLabel("FDS (Quẹt thẻ) Vietinbank"), "FDS Vietinbank");
  assert.equal(stripMoneySourceLabel("Vietinbank - Chuyển khoản"), "Vietinbank");
  assert.equal(stripMoneySourceLabel("Chuyển khoản Vietinbank"), "Vietinbank");
});

test("không đụng tới tên không chứa cụm nào", () => {
  assert.equal(stripMoneySourceLabel("Ví MoMo Asa"), "Ví MoMo Asa");
  assert.equal(stripMoneySourceLabel("Tiền mặt Nam Mê"), "Tiền mặt Nam Mê");
  assert.equal(stripMoneySourceLabel("Techcombank Nam Mê"), "Techcombank Nam Mê");
});

test("tên chỉ gồm đúng cụm bị cắt thì giữ nguyên, không để nguồn tiền mất tên", () => {
  assert.equal(stripMoneySourceLabel("Chuyển khoản"), "");
  assert.equal(cleanMoneySourceName("Chuyển khoản"), "Chuyển khoản");
  assert.equal(cleanMoneySourceName("  Quẹt thẻ  "), "Quẹt thẻ");
  assert.equal(cleanMoneySourceName(null), "");
});

test("nguồn tiền POS vẫn nhận được doanh thu quẹt thẻ sau khi tên bị cắt", () => {
  const posSource = { code: "POS_HCM", name: "Máy POS Asa" };
  // Dòng doanh thu POS không khai cột Kênh: chỉ còn hình thức thanh toán để bám.
  const cardRow = { paymentMethod: "Quẹt thẻ", revenueSource: "THU_BAN_HANG", channel: null, netAmount: 100 };
  assert.equal(revenueMatchesWalletSource(cardRow, posSource), true);

  // Vẫn không được vơ nhầm doanh thu của ví khác nhóm.
  assert.equal(revenueMatchesWalletSource({ ...cardRow, paymentMethod: "MoMo" }, posSource), false);
  assert.equal(revenueMatchesWalletSource(cardRow, { code: "MOMO_HCM", name: "Ví MoMo Asa" }), false);
});
