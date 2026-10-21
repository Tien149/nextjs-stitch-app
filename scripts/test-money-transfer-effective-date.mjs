/**
 * Ngày ghi sổ của phiếu điều tiền.
 *
 * Khách chốt lại 21/10/2026: phiếu NỘP TIỀN MẶT ghi sổ theo `actualTransferDate` — ngày kế toán
 * điền lúc duyệt, cả lô điền chung một ngày thì cả lô ghi ngày đó (nguồn nộp trừ, nguồn nhận cộng).
 * Loại khác giữ ngày chứng từ. (21/09 → 21/10 từng chạy theo ngày chứng từ.)
 *
 * Chạy: npm run test:money-transfer-dates
 */
import assert from "node:assert/strict";
import test from "node:test";
import { effectiveMoneyTransferDate, effectiveMoneyTransferDateFilter } from "../lib/money-transfer-date.ts";

const transferDate = new Date("2026-08-10T00:00:00.000Z");
const actualTransferDate = new Date("2026-08-12T00:00:00.000Z");

test("nộp tiền mặt ghi theo ngày kế toán điền lúc duyệt", () => {
  assert.equal(effectiveMoneyTransferDate({ transferDate, actualTransferDate, transferPurpose: "CASH_DEPOSIT" }), actualTransferDate);
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

test("bộ lọc kỳ: nộp tiền mặt theo ngày thực tế, loại khác theo ngày chứng từ", () => {
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-09-01T00:00:00.000Z");
  assert.deepEqual(effectiveMoneyTransferDateFilter(start, end), {
    OR: [
      { transferPurpose: "CASH_DEPOSIT", actualTransferDate: { gte: start, lt: end } },
      { transferPurpose: "CASH_DEPOSIT", actualTransferDate: null, transferDate: { gte: start, lt: end } },
      { transferPurpose: null, transferDate: { gte: start, lt: end } },
      { transferPurpose: { not: "CASH_DEPOSIT" }, transferDate: { gte: start, lt: end } },
    ],
  });
});
