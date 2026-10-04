import assert from "node:assert/strict";
import test from "node:test";
import { isAdvanceSettlementDebt, isEmployeeAdvanceCategory } from "../lib/employee-advance.ts";
import { payableDebtDebitLine, receiptCounterAccount, voucherJournalLines } from "../lib/voucher-accounting.ts";
import { voucherPartnerRequirement } from "../lib/voucher-rules.ts";

/** Đúng phiếu khách hỏi 04/10/2026: PCHI-2610-NME-00002 tạm ứng 7 triệu cho team MKT. */
const tamUng = {
  voucherType: "PAYMENT",
  amount: 7_000_000,
  moneySourceCode: "FDSTIENBINH",
  partnerCode: "NV00001",
  receivablePartnerCode: null,
  categoryCode: "CHI_TAM_UNG",
  pnlItemCode: null,
  depositAction: null,
  debtAction: null,
};

test("nhận diện khoản mục tạm ứng / hoàn tạm ứng theo mã", () => {
  for (const code of ["CHI_TAM_UNG", "THU_HOAN_UNG", "THU_HOAN_TAM_UNG", "chi_tamung"]) assert.equal(isEmployeeAdvanceCategory(code), true, code);
  for (const code of ["CHI_NCC_THANG_NAY", "THU_HOAN_NCC", "CHI_HOANCOC", "", null]) assert.equal(isEmployeeAdvanceCategory(code), false, String(code));
});

test("phiếu chi tạm ứng treo Nợ 141, không vào chi phí (kể cả lỡ khai hạng mục)", () => {
  const { lines } = voucherJournalLines({ ...tamUng, pnlItemCode: "CPBD_MKT" }, "PAYMENT", "OPEX");
  const debit = lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "141");
  assert.equal(debit.partnerCode, "NV00001");
  assert.equal(debit.pnlItemCode, null);
  assert.equal(lines.find((line) => line.credit).accountCode, "1121");
});

test("phiếu thu nhân viên nộp lại tiền thừa ghi Có 141, không phải doanh thu", () => {
  const nopLai = { ...tamUng, voucherType: "RECEIPT", amount: 500_000, categoryCode: "THU_HOAN_UNG" };
  assert.equal(receiptCounterAccount(nopLai, "REVENUE_SOURCE", null, { isRevenueSourceCategory: false }).account, "141");
});

test("tạm ứng bắt buộc chọn nhân viên", () => {
  assert.match(voucherPartnerRequirement({ category: { code: "CHI_TAM_UNG", name: "Chi Tạm Ứng Nhân Viên" } }), /nhân viên/);
  assert.equal(voucherPartnerRequirement({ category: { code: "CHI_NCC_THANG_NAY", name: "Chi NCC" } }), null);
});

test("hoàn ứng vào chi phí theo nhóm hạng mục như công nợ phải trả khai tay", () => {
  assert.equal(isAdvanceSettlementDebt("ADVANCE_SETTLEMENT"), true);
  assert.equal(isAdvanceSettlementDebt("MANUAL"), false);
  const row = { recognizeExpense: true, allocationMonths: null, documentDate: new Date("2026-10-04T00:00:00Z"), originalAmount: 2_500_000, partnerCode: "NV00001", categoryCode: null, pnlItemCode: "CPBD_MKT" };
  const debit = payableDebtDebitLine(row, "OPEX");
  assert.equal(debit.accountCode, "6428");
  assert.equal(debit.pnlItemCode, "CPBD_MKT");
});
