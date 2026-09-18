import test from "node:test";
import assert from "node:assert/strict";
import { voucherJournalLines, receiptCounterAccount, paymentCounterAccount } from "../lib/voucher-accounting.ts";
import { createPnlDetailTree } from "../lib/reports.ts";
import { BANK_STATEMENT_SPLIT_SOURCE_SCOPE, isCollectOnBehalfCategory } from "../lib/voucher-rules.ts";

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

/* ------------------------------------------------------------------ *
 * Hai hang muc moi cua khoi THU NHAP KHAC (chot 16/09/2026):
 *   - "Doanh thu tai chinh"  <- khoan muc thu THU_LAI_NGAN_HANG
 *   - "Thu nhap khac"        <- chung tu gan hang muc P&L OTHER_IN_TNK
 * ------------------------------------------------------------------ */

const laiNganHang = { ...base, categoryCode: "THU_LAI_NGAN_HANG", pnlItemCode: null, partnerCode: "NH_TCB" };

test("lai ngan hang vao 711 du phieu co ten ngan hang o o doi tac", () => {
  // Nhom da chuan hoa la REVENUE_SOURCE (normalizeCategoryGroup gop RECEIPT vao day) nhung
  // khoan muc khong khai THAT nhom doanh thu -> cho isRevenueSourceCategory = false.
  assert.equal(receiptCounterAccount(laiNganHang, "REVENUE_SOURCE", null, { isRevenueSourceCategory: false }).account, "711");
  // Khong co doi tac cung vay.
  assert.equal(receiptCounterAccount({ ...laiNganHang, partnerCode: null }, "REVENUE_SOURCE", null, { isRevenueSourceCategory: false }).account, "711");
});

test("khoan muc khai THAT nhom doanh thu van thang, khong bi keo xuong 711", () => {
  assert.equal(receiptCounterAccount({ ...base, categoryCode: "THU_BANHANG" }, "REVENUE_SOURCE", "OTHER_INCOME", { isRevenueSourceCategory: true }).account, "511");
});

test("thu khac thuong (khong hang muc, khong thuoc bang thu nhap khac) van ghi 511 nhu cu", () => {
  const thuKhac = { ...base, categoryCode: "THU_KHAC", pnlItemCode: null, partnerCode: "KH001" };
  assert.equal(receiptCounterAccount(thuKhac, "REVENUE_SOURCE", null, { isRevenueSourceCategory: false }).account, "511");
});

test("thu coc / gach no van thang ca luat khoan mục lai ngan hang", () => {
  assert.equal(receiptCounterAccount({ ...laiNganHang, depositAction: "COLLECT" }, "REVENUE_SOURCE", null, { isRevenueSourceCategory: false }).account, "3387");
  assert.equal(receiptCounterAccount({ ...laiNganHang, debtAction: "SETTLE" }, "REVENUE_SOURCE", null, { isRevenueSourceCategory: false }).account, "131");
});

const CATALOG = {
  pnlGroups: [{ code: "PNLG_TNK", name: "Thu nhập khác", group: "OTHER_INCOME", status: "ACTIVE" }],
  pnlItems: [
    { code: "OTHER_IN_DTTC", name: "Doanh thu tài chính", group: "OTHER_INCOME", subGroup: "PNLG_TNK", status: "ACTIVE" },
    { code: "OTHER_IN_TNK", name: "Thu nhập khác", group: "OTHER_INCOME", subGroup: "PNLG_TNK", status: "ACTIVE" },
  ],
  categories: [{ code: "THU_KHAC", name: "Thu khác" }, { code: "THU_LAI_NGAN_HANG", name: "Thu lãi ngân hàng" }],
};
const OTHER_INCOME_ACCOUNT = { accountType: "OTHER_INCOME", reportGroup: "OTHER_INCOME" };

test("khoi Thu nhap khac nap san hang muc du chua phat sinh dong nao", () => {
  const groups = createPnlDetailTree(CATALOG, 1).groupsOf("otherIncome");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "Thu nhập khác");
  assert.deepEqual(groups[0].items.map((item) => item.name), ["Doanh thu tài chính", "Thu nhập khác"]);
  assert.deepEqual(groups[0].items.map((item) => item.total), [0, 0]);
});

test("lai ngan hang chua gan hang muc van xep dung dong Doanh thu tai chinh", () => {
  const tree = createPnlDetailTree(CATALOG, 1);
  tree.add({ account: OTHER_INCOME_ACCOUNT, pnlItemCode: null, categoryCode: "THU_LAI_NGAN_HANG", debit: 0, credit: 5_000_000 }, 0);
  tree.add({ account: OTHER_INCOME_ACCOUNT, pnlItemCode: "OTHER_IN_TNK", categoryCode: "THU_KHAC", debit: 0, credit: 3_000_000 }, 0);
  const group = tree.groupsOf("otherIncome")[0];
  assert.equal(group.total, 8_000_000);
  assert.deepEqual(
    group.items.map((item) => [item.name, item.total]),
    [["Doanh thu tài chính", 5_000_000], ["Thu nhập khác", 3_000_000]],
  );
});

test("dong doanh thu van gom theo khoan mục thu, khong bi doi theo khoi Thu nhap khac", () => {
  const tree = createPnlDetailTree(CATALOG, 1);
  tree.add({ account: { accountType: "REVENUE", reportGroup: "REVENUE" }, pnlItemCode: null, categoryCode: "THU_KHAC", debit: 0, credit: 1_000_000 }, 0);
  const groups = tree.groupsOf("revenue");
  assert.deepEqual(groups.map((group) => [group.name, group.total]), [["Thu khác", 1_000_000]]);
});

/**
 * Tách một lần quẹt thành tiền bán hàng + tiền thu hộ: phần thu hộ là tiền của đối tác, phải
 * treo 131. Khoản mục thu nào cũng thuộc nhóm "Thu" nên nếu không có luật riêng, nó rơi thẳng
 * vào Có 511 và biến tiền thu hộ thành doanh thu trên sổ.
 */
test("phiếu tách từ dòng sao kê treo công nợ đối tác, không ghi doanh thu", () => {
  const { lines, reason } = voucherJournalLines(
    {
      voucherType: "RECEIPT",
      amount: 500_000,
      moneySourceCode: "MOMO_HCM",
      partnerCode: "KH-001",
      categoryCode: "THU_KHAC",
      pnlItemCode: null,
      depositAction: null,
      debtAction: null,
      sourceScope: BANK_STATEMENT_SPLIT_SOURCE_SCOPE,
    },
    "REVENUE_SOURCE",
  );

  assert.match(reason, /thu hộ/i);
  assert.deepEqual(lines.map((line) => line.accountCode), ["1121", "131"]);
  assert.equal(lines[1].credit, 500_000);
  assert.equal(lines[1].partnerCode, "KH-001");
});

test("phiếu thu thường của cùng khoản mục vẫn ghi Có 511 như cũ", () => {
  const { lines } = voucherJournalLines(
    {
      voucherType: "RECEIPT",
      amount: 500_000,
      moneySourceCode: "MOMO_HCM",
      partnerCode: "KH-001",
      categoryCode: "THU_KHAC",
      pnlItemCode: null,
      depositAction: null,
      debtAction: null,
    },
    "REVENUE_SOURCE",
  );

  assert.deepEqual(lines.map((line) => line.accountCode), ["1121", "511"]);
});

/**
 * Khoản mục "Thu hộ" trong danh mục thuộc nhóm Thu khác, mà mọi khoản mục nhóm Thu đều ghi
 * Có 511. Phải nhận diện theo mã, nếu không phiếu thu hộ lập tay lại thành doanh thu.
 */
test("phiếu thu khoản mục Thu hộ treo công nợ đối tác thay vì ghi doanh thu", () => {
  assert.equal(isCollectOnBehalfCategory("thu_ho"), true);
  const { lines, reason } = voucherJournalLines(
    {
      voucherType: "RECEIPT",
      amount: 1_400_000,
      moneySourceCode: "VCB_HCM",
      partnerCode: "KH_LE",
      categoryCode: "THU_HO",
      pnlItemCode: null,
      depositAction: null,
      debtAction: null,
    },
    "REVENUE_SOURCE",
  );

  assert.match(reason, /thu hộ/i);
  assert.deepEqual(lines.map((line) => line.accountCode), ["1121", "131"]);
  assert.equal(lines[1].partnerCode, "KH_LE");
});

test("thu hộ chưa khai đối tác treo phải trả khác, vẫn không phải doanh thu", () => {
  const { lines } = voucherJournalLines(
    {
      voucherType: "RECEIPT",
      amount: 1_400_000,
      moneySourceCode: "VCB_HCM",
      partnerCode: null,
      categoryCode: "THU_HO",
      pnlItemCode: null,
      depositAction: null,
      debtAction: null,
    },
    "REVENUE_SOURCE",
  );

  assert.deepEqual(lines.map((line) => line.accountCode), ["1121", "3388"]);
});
