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

test("một kỳ không phải phân bổ; số kỳ lẻ giữ 2 chữ số thập phân (03/10/2026)", () => {
  assert.equal(normalizeAllocationMonths("12"), 12);
  assert.equal(normalizeAllocationMonths(12.7), 12.7);
  assert.equal(normalizeAllocationMonths("10,375"), 10.38);
  assert.equal(normalizeAllocationMonths(1.5), 1.5);
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
    "Chi trả trước phải khai số kỳ phân bổ lớn hơn 1 (được ghi số lẻ 2 chữ số).",
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

test("lịch phân bổ số kỳ lẻ: kỳ đủ = tổng ÷ số kỳ, kỳ cuối mang phần lẻ, cộng đúng tổng", async () => {
  const { splitAmountByPeriods, buildAllocationSchedules } = await import("../lib/phase3.ts");
  assert.deepEqual(splitAmountByPeriods(1_000_000, 2.5), [400_000, 400_000, 200_000]);
  assert.deepEqual(splitAmountByPeriods(1_000_000, 3), [333_333, 333_333, 333_334]);
  const parts = splitAmountByPeriods(1_234_567, 10.37);
  assert.equal(parts.length, 11);
  assert.equal(parts[0], 119_051);
  assert.equal(parts.reduce((sum, value) => sum + value, 0), 1_234_567);
  assert.deepEqual(splitAmountByPeriods(100, 0.5), [100]);
  assert.deepEqual(buildAllocationSchedules("2026-11", 300, 1.5).map((row) => row.period), ["2026-11", "2026-12"]);
});
