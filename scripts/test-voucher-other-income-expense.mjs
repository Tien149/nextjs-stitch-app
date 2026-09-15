import test from "node:test";
import assert from "node:assert/strict";
import { voucherJournalLines, receiptCounterAccount, paymentCounterAccount } from "../lib/voucher-accounting.ts";

const base = {
  voucherType: "RECEIPT",
  amount: 5_000_000,
  moneySourceCode: "FDSCHKHVIET",
  partnerCode: null,
  categoryCode: "THU_KHAC",
  pnlItemCode: "PNL_TN_LAINH",
  depositAction: null,
  debtAction: null,
  receivablePartnerCode: null,
};

test("phieu thu chon hang muc Thu nhap khac -> TK 711 kem hang muc", () => {
  const { lines } = voucherJournalLines(base, "RECEIPT", "OTHER_INCOME");
  const credit = lines.find((line) => line.credit);
  assert.equal(credit.accountCode, "711");
  assert.equal(credit.pnlItemCode, "PNL_TN_LAINH");
});

test("hang muc Thu nhap khac thang fallback treo 131 khi phieu co doi tac", () => {
  // Truoc day: co partnerCode la vao 131, khoan thu nhap khac khong bao gio len P&L.
  const withPartner = { ...base, partnerCode: "KH001" };
  assert.equal(receiptCounterAccount(withPartner, "RECEIPT", null).account, "131");
  assert.equal(receiptCounterAccount(withPartner, "RECEIPT", "OTHER_INCOME").account, "711");
});

test("thu tien coc / thu no van thang hang muc P&L", () => {
  assert.equal(receiptCounterAccount({ ...base, depositAction: "COLLECT" }, "RECEIPT", "OTHER_INCOME").account, "3387");
  assert.equal(receiptCounterAccount({ ...base, debtAction: "SETTLE" }, "RECEIPT", "OTHER_INCOME").account, "131");
});

test("phieu chi chon hang muc Chi phi khac -> TK 811, khong lan vao 6428", () => {
  const payment = { ...base, voucherType: "PAYMENT", pnlItemCode: "PNL_CP_PHAT" };
  const { lines } = voucherJournalLines(payment, "PAYMENT", "OTHER_EXPENSE");
  const debit = lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "811");
  assert.equal(debit.pnlItemCode, "PNL_CP_PHAT");
  // Khong khai hang muc thi giu nguyen cach cu.
  assert.equal(paymentCounterAccount(payment, "OPEX").account, "6428");
  assert.equal(paymentCounterAccount(payment, "COGS").account, "632");
  assert.equal(paymentCounterAccount(payment, "CAPEX").account, "211");
});

test("doanh thu ban hang van vao 511", () => {
  assert.equal(receiptCounterAccount(base, "REVENUE_SOURCE", null).account, "511");
});

test("khoan muc doanh thu thang hang muc Thu nhap khac khai nham", () => {
  // Neu hang muc thang o day thi mot khoan doanh thu bien mat khoi doanh thu thuan.
  assert.equal(receiptCounterAccount(base, "REVENUE_SOURCE", "OTHER_INCOME").account, "511");
});
