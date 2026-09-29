/**
 * Khoản lương lẻ P&L đọc thẳng chứng từ (loadDirectPayrollExpenseRows): chỉ những dòng mà
 * "Đồng bộ ghi sổ" sẽ ghi Nợ chi phí lương mới được lấy. Kiểm luật định khoản dùng chung
 * (voucherJournalLines / payableDebtDebitLine) + luật xếp dòng P&L (pnlLineKeyOf).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { payableDebtDebitLine, pnlItemGroupLookup, voucherJournalLines } from "@/lib/voucher-accounting";
import { createPnlItemRefLookup, pnlLineKeyOf } from "@/lib/reports";
import { ADVANCE_RECEIVABLE_ACTION, PREPAID_ALLOCATION_ACTION } from "@/lib/voucher-rules";

const pnlGroups = [
  { code: "G_PAYROLL", name: "Chi phí nhân sự", group: "OPEX" },
  { code: "G_FIXED", name: "Chi phí cố định", group: "OPEX" },
];
const pnlItems = [
  { code: "CPNLD_FOH", name: "CP lương FOH", group: null, subGroup: "G_PAYROLL" },
  { code: "CP_DIEN", name: "Tiền điện", group: null, subGroup: "G_FIXED" },
];
const accounts = new Map([
  ["6428", { accountType: "OPEX", reportGroup: "OPERATING_EXPENSE" }],
  ["331", { accountType: "LIABILITY", reportGroup: "PAYABLE" }],
  ["242", { accountType: "ASSET", reportGroup: "PREPAID" }],
  ["131", { accountType: "ASSET", reportGroup: "RECEIVABLE" }],
  ["1111", { accountType: "ASSET", reportGroup: "CASH" }],
]);
const itemGroup = pnlItemGroupLookup(pnlItems, pnlGroups);
const refOf = createPnlItemRefLookup(pnlItems, pnlGroups);

/** Số tiền lương lẻ mà P&L lấy từ các dòng định khoản — cùng luật với loadDirectPayrollExpenseRows. */
function payrollAmount(lines) {
  return lines
    .filter((line) => (line.debit || 0) > 0 && accounts.has(line.accountCode))
    .filter((line) => pnlLineKeyOf(accounts.get(line.accountCode), refOf(line.pnlItemCode || null)) === "payroll")
    .reduce((sum, line) => sum + line.debit, 0);
}

const voucher = (extra = {}) => ({
  voucherType: "PAYMENT", amount: 315000, moneySourceCode: "CASH_NM", partnerCode: "NV01", categoryCode: null,
  pnlItemCode: "CPNLD_FOH", depositAction: null, debtAction: null, voucherDate: new Date("2026-08-15T00:00:00"), ...extra,
});
const linesOf = (row) => voucherJournalLines(row, null, row.pnlItemCode ? itemGroup.get(row.pnlItemCode) ?? null : null, ["NAM_ME", "ASA"]).lines;

test("phiếu chi gắn hạng mục nhóm nhân sự lên dòng Chi phí nhân sự", () => {
  assert.equal(payrollAmount(linesOf(voucher())), 315000);
});

test("phiếu chi hạng mục nhóm khác không lên dòng nhân sự", () => {
  assert.equal(payrollAmount(linesOf(voucher({ pnlItemCode: "CP_DIEN" }))), 0);
});

test("trả nợ (331), chi trả trước (242), chi hộ (131) không phải chi phí lương kỳ này", () => {
  assert.equal(payrollAmount(linesOf(voucher({ debtAction: "SETTLE" }))), 0);
  assert.equal(payrollAmount(linesOf(voucher({ debtAction: PREPAID_ALLOCATION_ACTION }))), 0);
  assert.equal(payrollAmount(linesOf(voucher({ debtAction: ADVANCE_RECEIVABLE_ACTION, receivablePartnerCode: "KH01" }))), 0);
});

test("công nợ phải trả phát sinh trong kỳ gắn hạng mục lương lên dòng nhân sự; khoản phân bổ thì không", () => {
  const debt = { recognizeExpense: true, allocationMonths: null, documentDate: new Date("2026-08-20T00:00:00"), originalAmount: 200000, partnerCode: "NV02", categoryCode: null, pnlItemCode: "CPNLD_FOH" };
  assert.equal(payrollAmount([payableDebtDebitLine(debt, itemGroup.get("CPNLD_FOH") ?? null)]), 200000);
  const allocated = { ...debt, recognizeExpense: false, allocationMonths: 6 };
  assert.equal(payrollAmount([payableDebtDebitLine(allocated, itemGroup.get("CPNLD_FOH") ?? null)]), 0);
});
