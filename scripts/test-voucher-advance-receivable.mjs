import assert from "node:assert/strict";
import test from "node:test";
import { paymentCounterAccount, voucherJournalLines } from "../lib/voucher-accounting.ts";
import { ADVANCE_RECEIVABLE_ACTION, normalizePaymentPurpose, validatePaymentPurpose } from "../lib/voucher-rules.ts";
import { advanceReceivableDebtCode } from "../lib/voucher-side-effects.ts";

const chiHo = {
  voucherType: "PAYMENT",
  amount: 6_000_000,
  moneySourceCode: "FDS_BINH",
  partnerCode: "NCC001",
  receivablePartnerCode: "KH_TRUNG",
  categoryCode: "CHI_PHI_QUAN_LY",
  pnlItemCode: "PNL_QUAN_LY",
  depositAction: null,
  debtAction: ADVANCE_RECEIVABLE_ACTION,
};

test("chi hộ treo phải thu 131 thay vì chi phí 6428", () => {
  assert.equal(paymentCounterAccount(chiHo, "OPEX").account, "131");
  // Khoản mục quản trị không được kéo phiếu chi hộ về chi phí.
  assert.equal(paymentCounterAccount(chiHo, "COGS").account, "131");
  assert.equal(paymentCounterAccount({ ...chiHo, debtAction: null }, "OPEX").account, "6428");
});

test("vế Nợ 131 mang đối tác sẽ trả lại tiền, không mang hạng mục P&L", () => {
  const { lines } = voucherJournalLines(chiHo, "OPEX", "OPEX");
  const debit = lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "131");
  assert.equal(debit.debit, 6_000_000);
  assert.equal(debit.partnerCode, "KH_TRUNG");
  assert.equal(debit.pnlItemCode, null);
  const credit = lines.find((line) => line.credit);
  assert.equal(credit.accountCode, "1121");
  assert.equal(credit.credit, 6_000_000);
});

test("phiếu chi thường vẫn giữ nguyên cách hạch toán cũ", () => {
  const { lines } = voucherJournalLines({ ...chiHo, debtAction: null }, "OPEX", "OPEX");
  const debit = lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "6428");
  assert.equal(debit.partnerCode, "NCC001");
  assert.equal(debit.pnlItemCode, "PNL_QUAN_LY");
});

test("nội dung chi chỉ áp cho phiếu Chi và bắt buộc có đối tác thu lại", () => {
  assert.equal(normalizePaymentPurpose("PAYMENT", "accrue_receivable"), ADVANCE_RECEIVABLE_ACTION);
  assert.equal(normalizePaymentPurpose("RECEIPT", ADVANCE_RECEIVABLE_ACTION), "");
  assert.equal(normalizePaymentPurpose("PAYMENT", "SETTLE"), "");
  assert.equal(validatePaymentPurpose("PAYMENT", ADVANCE_RECEIVABLE_ACTION, ""), "Chi hộ phải chọn đối tác sẽ trả lại tiền.");
  assert.equal(validatePaymentPurpose("PAYMENT", ADVANCE_RECEIVABLE_ACTION, "KH_TRUNG"), null);
  assert.equal(validatePaymentPurpose("PAYMENT", "", ""), null);
});

test("mã khoản phải thu suy được từ mã phiếu nên duyệt lại không tạo trùng", () => {
  assert.equal(advanceReceivableDebtCode("UNC-2608-NME-00104"), "CNTHU-UNC-2608-NME-00104");
});
