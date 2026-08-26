/**
 * Kiểm chứng cách báo cáo Thu chi ngày tổng hợp phiếu thu (lib/daily-cash-receipts.ts):
 * - Phiếu thu KHÔNG phải Thu bán hàng (hoàn tiền NCC chi trùng...) phải nằm ở "Thu khác",
 *   không được cộng vào dòng Doanh thu bán hàng, nhưng tiền mặt vẫn tính vào số nộp.
 * - Khử trùng POS chỉ áp lên phiếu thu Thu bán hàng tiền mặt, và chỉ ở cửa hàng có POS tiền mặt.
 * - Thu cọc COLLECT/SUPPLEMENT không được cộng (đã tổng hợp từ bảng Deposit).
 *
 * Chạy: npm run test:daily-cash-receipts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyCashSummaryRows, summarizeDailyCashReceiptVouchers } from "../lib/daily-cash-receipts.ts";
import { isPartnerAllowedForVoucher } from "../lib/voucher-rules.ts";

const cashReceipt = (overrides = {}) => ({
  branchCode: "FDS",
  moneySourceCode: "CASH_FDS",
  amount: 100_000,
  categoryCode: "THU_BAN_HANG",
  depositAction: null,
  bucketKey: "cash",
  isCashSource: true,
  ...overrides,
});

const cashOf = (entries, code) => entries.find((entry) => entry.moneySourceCode === code)?.amount ?? 0;

test("phiếu thu hoàn NCC nằm ở Thu khác, không vào dòng doanh thu, vẫn tính vào tiền cần nộp", () => {
  const result = summarizeDailyCashReceiptVouchers(
    [
      cashReceipt({ amount: 500_000 }),
      cashReceipt({ amount: 200_000, categoryCode: "THU_HOAN_NCC" }),
    ],
    new Set(),
  );
  assert.equal(result.receipt.total, 700_000);
  assert.equal(result.receiptSales.total, 500_000);
  assert.equal(result.receiptOther.total, 200_000);
  assert.equal(result.receiptOther.cash, 200_000);
  // Không có POS tiền mặt -> không khử trùng, dòng doanh thu ăn đủ phần Thu bán hàng.
  assert.equal(result.receiptSalesRevenue.total, 500_000);
  assert.equal(result.duplicatedCashReceipts, 0);
  // Cả hai khoản đều là tiền mặt trong quỹ -> cộng đủ vào tiền cần nộp.
  assert.equal(cashOf(result.cashToDepositBySource, "CASH_FDS"), 700_000);
});

test("bất biến: sales + other = receipt, salesRevenue + other = receiptRevenue", () => {
  const result = summarizeDailyCashReceiptVouchers(
    [
      cashReceipt({ amount: 300_000 }),
      cashReceipt({ amount: 150_000, categoryCode: "THU_HOAN_NCC" }),
      cashReceipt({ amount: 80_000, categoryCode: "THU_KHAC", bucketKey: "transfer", isCashSource: false, moneySourceCode: "BANK_FDS" }),
    ],
    new Set(["FDS"]),
  );
  for (const key of ["total", "cash", "transfer", "card", "grab", "other"]) {
    assert.equal(result.receiptSales[key] + result.receiptOther[key], result.receipt[key], `receipt.${key}`);
    assert.equal(result.receiptSalesRevenue[key] + result.receiptOther[key], result.receiptRevenue[key], `receiptRevenue.${key}`);
  }
});

test("cửa hàng có POS tiền mặt: chỉ khử phiếu thu Thu bán hàng tiền mặt, Thu khác giữ nguyên", () => {
  const result = summarizeDailyCashReceiptVouchers(
    [
      cashReceipt({ amount: 400_000 }),
      cashReceipt({ amount: 250_000, categoryCode: "THU_HOAN_NCC" }),
    ],
    new Set(["FDS"]),
  );
  assert.equal(result.duplicatedCashReceipts, 400_000);
  // Phiếu thu bán hàng là chứng từ của doanh thu POS đã ghi -> phần sales sau khử trùng = 0.
  assert.equal(result.receiptSalesRevenue.total, 0);
  assert.equal(result.receiptSalesRevenue.cash, 0);
  // Khoản hoàn NCC không có trên file POS nên không bị khử.
  assert.equal(result.receiptOther.total, 250_000);
  // Tiền cần nộp: khoản sales đã nằm trong doanh thu POS (cộng ở nơi khác), ở đây chỉ còn khoản hoàn.
  assert.equal(cashOf(result.cashToDepositBySource, "CASH_FDS"), 250_000);
});

test("khử trùng xét riêng từng cửa hàng khi xem Tất cả cửa hàng", () => {
  const result = summarizeDailyCashReceiptVouchers(
    [
      cashReceipt({ amount: 400_000, branchCode: "NAM_ME", moneySourceCode: "CASH_NAM_ME" }),
      cashReceipt({ amount: 300_000, branchCode: "ASA", moneySourceCode: "CASH_ASA" }),
    ],
    new Set(["NAM_ME"]),
  );
  // Chỉ NAM MÊ có POS tiền mặt -> chỉ khử phiếu của NAM MÊ, phiếu ASA giữ nguyên.
  assert.equal(result.duplicatedCashReceipts, 400_000);
  assert.equal(result.receiptSalesRevenue.total, 300_000);
  assert.equal(cashOf(result.cashToDepositBySource, "CASH_NAM_ME"), 0);
  assert.equal(cashOf(result.cashToDepositBySource, "CASH_ASA"), 300_000);
});

test("thu cọc COLLECT/SUPPLEMENT không cộng vào bucket nào", () => {
  const result = summarizeDailyCashReceiptVouchers(
    [
      cashReceipt({ amount: 900_000, depositAction: "COLLECT" }),
      cashReceipt({ amount: 100_000, depositAction: "SUPPLEMENT", categoryCode: "THU_HOAN_NCC" }),
    ],
    new Set(),
  );
  assert.equal(result.receipt.total, 0);
  assert.equal(result.receiptOther.total, 0);
  assert.equal(result.cashToDepositBySource.length, 0);
});

test("phiếu thu ngân hàng không sinh dòng tiền mặt cần nộp", () => {
  const result = summarizeDailyCashReceiptVouchers(
    [cashReceipt({ categoryCode: "THU_HOAN_NCC", bucketKey: "transfer", isCashSource: false, moneySourceCode: "BANK_FDS" })],
    new Set(),
  );
  assert.equal(result.receiptOther.transfer, 100_000);
  assert.equal(result.receiptOther.cash, 0);
  assert.equal(cashOf(result.cashToDepositBySource, "BANK_FDS"), 0);
});

/* ---- Các dòng của bảng "Tổng hợp thu trong ngày" ---- */

const bucket = (cash, extra = {}) => ({ total: cash, cash, transfer: 0, card: 0, grab: 0, other: 0, ...extra });
const zero = () => bucket(0);
const labelsOf = (rows) => rows.map((row) => row.label);

test("dòng doanh thu chỉ ăn phiếu thu bán hàng, khoản hoàn đứng dòng Thu khác", () => {
  const rows = buildDailyCashSummaryRows({
    revenue: bucket(4_000_000),
    receipt: bucket(8_000_000),
    receiptRevenue: bucket(8_000_000),
    receiptSalesRevenue: bucket(5_000_000),
    receiptOther: bucket(3_000_000),
    deposit: zero(),
    cashExpenseTotal: 1_000_000,
  });
  assert.deepEqual(labelsOf(rows), ["Doanh thu bán hàng", "Thu khác (ngoài bán hàng)", "Đặt cọc"]);
  assert.equal(rows[0].bucket.total, 9_000_000);
  assert.equal(rows[1].bucket.total, 3_000_000);
  // Chi tiền mặt chỉ trừ ở dòng doanh thu; tổng số nộp vẫn đủ cả khoản hoàn.
  assert.equal(rows[0].cashToDeposit, 8_000_000);
  assert.equal(rows[1].cashToDeposit, 3_000_000);
  assert.equal(rows[0].cashToDeposit + rows[1].cashToDeposit, 4_000_000 + 5_000_000 + 3_000_000 - 1_000_000);
});

test("không có khoản thu ngoài bán hàng thì không thêm dòng Thu khác 0 đ", () => {
  const rows = buildDailyCashSummaryRows({
    revenue: bucket(4_000_000),
    receipt: bucket(5_000_000),
    receiptRevenue: bucket(5_000_000),
    receiptSalesRevenue: bucket(5_000_000),
    receiptOther: zero(),
    deposit: zero(),
    cashExpenseTotal: 0,
  });
  assert.deepEqual(labelsOf(rows), ["Doanh thu bán hàng", "Đặt cọc"]);
});

test("payload cũ chưa tách trường thì giữ nguyên hành vi cũ, không vỡ màn hình", () => {
  const rows = buildDailyCashSummaryRows({
    revenue: bucket(4_000_000),
    receipt: bucket(8_000_000),
    receiptRevenue: bucket(8_000_000),
    deposit: zero(),
    cashExpenseTotal: 0,
  });
  assert.deepEqual(labelsOf(rows), ["Doanh thu bán hàng", "Đặt cọc"]);
  assert.equal(rows[0].bucket.total, 12_000_000);
});

/* ---- Đối tác được chọn trên phiếu ---- */

test("phiếu thu tiền mặt: NCC/nhân viên mở theo loại thu, thu bán hàng vẫn bó khách hàng", () => {
  const receipt = (partnerType, categoryCode) => isPartnerAllowedForVoucher({ voucherType: "RECEIPT", partnerType, categoryCode });
  assert.equal(receipt("SUPPLIER", "THU_HOAN_NCC"), true);
  assert.equal(receipt("EMPLOYEE", "THU_HOAN_TAM_UNG"), true);
  assert.equal(receipt("SUPPLIER", "THU_BAN_HANG"), false);
  assert.equal(receipt("CUSTOMER", "THU_BAN_HANG"), true);
  assert.equal(receipt("BOTH", "THU_BAN_HANG"), true);
  // Chưa chọn khoản mục thì giữ danh sách chặt, tránh chào nhầm NCC ngay khi mở form.
  assert.equal(receipt("SUPPLIER", ""), false);
  assert.equal(receipt("CUSTOMER", ""), true);
});

test("phiếu chi và chứng từ ngân hàng giữ nguyên hành vi cũ", () => {
  assert.equal(isPartnerAllowedForVoucher({ voucherType: "PAYMENT", partnerType: "SUPPLIER" }), true);
  assert.equal(isPartnerAllowedForVoucher({ voucherType: "PAYMENT", partnerType: "CUSTOMER" }), false);
  for (const partnerType of ["SUPPLIER", "CUSTOMER", "EMPLOYEE"]) {
    assert.equal(isPartnerAllowedForVoucher({ voucherType: "RECEIPT", partnerType, categoryCode: "THU_BAN_HANG", isBankChannel: true }), true);
  }
});
