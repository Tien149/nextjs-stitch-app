import assert from "node:assert/strict";
import test from "node:test";
import { advanceReceivableCounterpartJournal, paymentCounterAccount, voucherJournalLines } from "../lib/voucher-accounting.ts";
import { ADVANCE_RECEIVABLE_ACTION, normalizePaymentPurpose, validatePaymentPurpose } from "../lib/voucher-rules.ts";
import {
  advanceReceivableBeneficiaryBranch,
  advanceReceivableCounterpartDebtCode,
  advanceReceivableDebtCode,
} from "../lib/voucher-side-effects.ts";

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

/**
 * Nam Mê trả tiền cho NCC thay Asa. Vế bên Nam Mê (tiền ra, treo phải thu nội bộ) vốn đã
 * chạy đúng; thứ còn thiếu là vế bên Asa — nợ NCC của Asa phải tụt xuống và chuyển thành
 * nợ Nam Mê, nếu không Asa treo công nợ NCC mãi dù tiền đã trả.
 */
const chiHoNoiBo = {
  ...chiHo,
  branchCode: "NME",
  receivablePartnerCode: "NB-ASA",
};

/** Danh mục Cửa hàng thật. NB-THOA (một cá nhân ai đó đặt mã) không nằm trong đây. */
const BRANCHES = ["NME", "ASA"];

test("chi hộ nhà hàng khác treo phải thu NỘI BỘ 1368, không phải 131", () => {
  assert.equal(paymentCounterAccount(chiHoNoiBo, "OPEX", BRANCHES).account, "1368");
  const debit = voucherJournalLines(chiHoNoiBo, "OPEX", "OPEX", BRANCHES).lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "1368");
  assert.equal(debit.partnerCode, "NB-ASA");
  // Chi hộ đối tác bên ngoài không đổi: vẫn là phải thu 131 như trước.
  assert.equal(paymentCounterAccount(chiHo, "OPEX", BRANCHES).account, "131");
});

test("nhà hàng được chi hộ suy từ đối tác nội bộ, đối tác ngoài thì không có", () => {
  assert.equal(advanceReceivableBeneficiaryBranch(chiHoNoiBo, BRANCHES), "ASA");
  assert.equal(advanceReceivableBeneficiaryBranch({ ...chiHo, branchCode: "NME" }, BRANCHES), null);
  // Chọn đúng nhà hàng của chính phiếu thì không có vế đối ứng nào cả.
  assert.equal(advanceReceivableBeneficiaryBranch({ ...chiHoNoiBo, receivablePartnerCode: "NB-NME" }, BRANCHES), null);
  assert.equal(advanceReceivableBeneficiaryBranch({ ...chiHoNoiBo, debtAction: null }, BRANCHES), null);
});

/**
 * Mã đối tác bắt đầu bằng NB- KHÔNG phải bằng chứng đó là nhà hàng: khách đã tự đặt NB-THOA,
 * NB-CHAU cho cá nhân. Hiểu nhầm thì công nợ đối ứng và bút toán rơi vào một cửa hàng không
 * tồn tại, không màn hình nào nhìn thấy để sửa.
 */
test("mã NB- không có trong danh mục Cửa hàng thì coi như đối tác bên ngoài", () => {
  const chiHoCaNhan = { ...chiHoNoiBo, receivablePartnerCode: "NB-THOA" };
  assert.equal(advanceReceivableBeneficiaryBranch(chiHoCaNhan, BRANCHES), null);
  assert.equal(advanceReceivableCounterpartJournal(chiHoCaNhan, BRANCHES), null);
  assert.equal(paymentCounterAccount(chiHoCaNhan, "OPEX", BRANCHES).account, "131");
  // Quên truyền danh mục cửa hàng thì sai theo hướng an toàn: không sinh vế đối ứng nào.
  assert.equal(advanceReceivableBeneficiaryBranch(chiHoNoiBo), null);
  assert.equal(advanceReceivableCounterpartJournal(chiHoNoiBo), null);
});

test("bút toán đối ứng ghi ở sổ nhà hàng được chi hộ: giảm 331 NCC, tăng 3368 nội bộ", () => {
  const counterpart = advanceReceivableCounterpartJournal(chiHoNoiBo, BRANCHES);
  assert.equal(counterpart.branchCode, "ASA");
  const debit = counterpart.lines.find((line) => line.debit);
  assert.equal(debit.accountCode, "331");
  assert.equal(debit.debit, 6_000_000);
  assert.equal(debit.partnerCode, "NCC001");
  const credit = counterpart.lines.find((line) => line.credit);
  assert.equal(credit.accountCode, "3368");
  assert.equal(credit.partnerCode, "NB-NME");
  // Chi hộ đối tác bên ngoài là nợ của chính nhà hàng lập phiếu — không có sổ nào khác để ghi.
  assert.equal(advanceReceivableCounterpartJournal({ ...chiHo, branchCode: "NME" }, BRANCHES), null);
});

test("mã công nợ hai vế suy được từ mã phiếu nên duyệt lại không tạo trùng", () => {
  assert.equal(advanceReceivableCounterpartDebtCode("UNC-2608-NME-00166"), "CNTHU-UNC-2608-NME-00166-PTR");
});
