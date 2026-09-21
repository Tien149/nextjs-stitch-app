/**
 * Ngày ghi sổ của phiếu điều tiền.
 *
 * Chốt với khách 21/09/2026: MỌI loại phiếu, kể cả nộp tiền mặt, ghi sổ theo NGÀY CHỨNG TỪ.
 * Trước đó riêng nộp tiền mặt chạy theo `actualTransferDate` — ngày kế toán gõ lúc duyệt —
 * nên phiếu của ca ngày 2/8 duyệt ngày 8/8 làm sổ quỹ thu ngân ngày 2/8 không trừ.
 *
 * Chạy: npm run test:money-transfer-dates
 */
import assert from "node:assert/strict";
import test from "node:test";
import { effectiveMoneyTransferDate, effectiveMoneyTransferDateFilter } from "../lib/money-transfer-date.ts";

const transferDate = new Date("2026-08-10T00:00:00.000Z");
const actualTransferDate = new Date("2026-08-12T00:00:00.000Z");

test("nộp tiền mặt ghi theo ngày chứng từ, không theo ngày thực tế nộp", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: "CASH_DEPOSIT" }), transferDate);
});

test("nộp tiền mặt chưa khai ngày thực tế vẫn là ngày chứng từ", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate: null, transferPurpose: "CASH_DEPOSIT" }), transferDate);
});

test("điều tiền nội bộ giữ ngày chứng từ", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: null }), transferDate);
});

test("quyết toán ví giữ ngày chứng từ", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: "WALLET_SETTLEMENT" }), transferDate);
});

test("bộ lọc kỳ cũng chỉ xét ngày chứng từ", () => {
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-09-01T00:00:00.000Z");
  // Lọc theo actualTransferDate như trước thì phiếu ngày chứng từ 31/8 duyệt sang tháng 9 sẽ
  // rơi khỏi tháng 8 — đúng cái làm sổ quỹ thủng một khoản mà không ai thấy.
  assert.deepEqual(effectiveMoneyTransferDateFilter(start, end), { transferDate: { gte: start, lt: end } });
});
