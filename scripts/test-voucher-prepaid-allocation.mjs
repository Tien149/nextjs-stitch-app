import assert from "node:assert/strict";
import test from "node:test";
import { paymentCounterAccount, voucherJournalLines } from "../lib/voucher-accounting.ts";
import { ADVANCE_RECEIVABLE_ACTION, normalizeAllocationMonths, normalizePaymentPurpose, PREPAID_ALLOCATION_ACTION, validatePaymentPurpose } from "../lib/voucher-rules.ts";

/** Phiếu chi 3.000.000đ gia hạn phần mềm 12 tháng — khoản mở đầu cho tính năng này. */
const traTruoc = {
  voucherType: "PAYMENT",
  amount: 3_000_000,
  moneySourceCode: "FDS_BINH",
  partnerCode: "NCC_FABI",
  receivablePartnerCode: null,
  categoryCode: "CPBD_PHANMEM",
  pnlItemCode: "CPBD_CPBH",
  depositAction: null,
  debtAction: PREPAID_ALLOCATION_ACTION,
};

test("chi trả trước treo 242 thay vì vào chi phí ngay", () => {
  assert.equal(paymentCounterAccount(traTruoc, "OPEX").account, "242");
  // Khoản mục/hạng mục là chi phí vẫn không kéo được phiếu về 6428 — chi phí thuộc các kỳ sau.
  assert.equal(paymentCounterAccount(traTruoc, "COGS").account, "242");
  assert.equal(paymentCounterAccount({ ...traTruoc, debtAction: null }, "OPEX").account, "6428");
});

test("vế Nợ 242 không mang hạng mục P&L — hạng mục đó thuộc về lịch phân bổ", () => {
  const { lines } = voucherJournalLines(traTruoc, "OPEX", "OPEX");
  const debit = lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "242");
  assert.equal(debit.debit, 3_000_000);
  assert.equal(debit.pnlItemCode, null);
  // Khoản mục thu/chi vẫn giữ để báo cáo dòng tiền biết tiền ra vì việc gì.
  assert.equal(debit.categoryCode, "CPBD_PHANMEM");
  const credit = lines.find((line) => line.credit);
  assert.equal(credit.accountCode, "1121");
  assert.equal(credit.credit, 3_000_000);
});

test("chi hộ và chi thường không bị ảnh hưởng", () => {
  assert.equal(paymentCounterAccount({ ...traTruoc, debtAction: ADVANCE_RECEIVABLE_ACTION }, "OPEX").account, "131");
  const { lines } = voucherJournalLines({ ...traTruoc, debtAction: null }, "OPEX", "OPEX");
  const debit = lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "6428");
  assert.equal(debit.pnlItemCode, "CPBD_CPBH");
});

test("nội dung chi mới chỉ áp cho phiếu Chi", () => {
  assert.equal(normalizePaymentPurpose("PAYMENT", "allocate_prepaid"), PREPAID_ALLOCATION_ACTION);
  assert.equal(normalizePaymentPurpose("RECEIPT", PREPAID_ALLOCATION_ACTION), "");
});

test("một kỳ không phải phân bổ, số kỳ phải từ 2 trở lên", () => {
  assert.equal(normalizeAllocationMonths("12"), 12);
  assert.equal(normalizeAllocationMonths(12.7), 12);
  assert.equal(normalizeAllocationMonths(1), 0);
  assert.equal(normalizeAllocationMonths(0), 0);
  assert.equal(normalizeAllocationMonths(""), 0);
  assert.equal(normalizeAllocationMonths("mười hai"), 0);
});

test("thiếu số kỳ, kỳ bắt đầu hoặc hạng mục P&L đều bị chặn từ luật nghiệp vụ", () => {
  const ok = { months: 12, startPeriod: "2026-09", pnlItemCode: "CPBD_CPBH" };
  assert.equal(validatePaymentPurpose("PAYMENT", PREPAID_ALLOCATION_ACTION, "", ok), null);
  assert.equal(
    validatePaymentPurpose("PAYMENT", PREPAID_ALLOCATION_ACTION, "", { ...ok, months: 1 }),
    "Chi trả trước phải khai số kỳ phân bổ từ 2 trở lên.",
  );
  assert.equal(
    validatePaymentPurpose("PAYMENT", PREPAID_ALLOCATION_ACTION, "", { ...ok, startPeriod: "" }),
    "Chi trả trước phải khai kỳ bắt đầu phân bổ.",
  );
  assert.equal(
    validatePaymentPurpose("PAYMENT", PREPAID_ALLOCATION_ACTION, "", { ...ok, pnlItemCode: "" }),
    "Chi trả trước phải chọn hạng mục P&L để số phân bổ lên đúng dòng chi phí.",
  );
  // Chi hộ vẫn kiểm theo đối tác như cũ, không bị luật mới chen vào.
  assert.equal(validatePaymentPurpose("PAYMENT", ADVANCE_RECEIVABLE_ACTION, "", ok), "Chi hộ phải chọn đối tác sẽ trả lại tiền.");
  assert.equal(validatePaymentPurpose("PAYMENT", ADVANCE_RECEIVABLE_ACTION, "KH_TRUNG", ok), null);
});

/**
 * Cái bẫy chính của tính năng: nếu phiếu chi vẫn vào 6428 mà lịch phân bổ cũng ghi 6428
 * thì một khoản 3 triệu thành 6 triệu chi phí. Chốt lại bằng số cho chắc.
 */
test("tổng chi phí lên P&L đúng bằng số tiền phiếu, không nhân đôi", () => {
  const { lines } = voucherJournalLines(traTruoc, "OPEX", "OPEX");
  const expenseFromVoucher = lines
    .filter((line) => line.accountCode.startsWith("64") || line.accountCode === "632")
    .reduce((sum, line) => sum + (line.debit || 0), 0);
  assert.equal(expenseFromVoucher, 0);

  const months = 12;
  const perPeriod = traTruoc.amount / months;
  assert.equal(expenseFromVoucher + perPeriod * months, traTruoc.amount);
});
