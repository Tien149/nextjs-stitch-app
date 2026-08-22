import assert from "node:assert/strict";
import test from "node:test";
import { ReconciliationSyncError, syncReconciledBankStatement } from "../lib/reconciliation-links.ts";

/**
 * Tx giả lập đúng bốn bảng mà hàm đồng bộ đụng tới, để kiểm tra logic mà không cần DB.
 */
function makeTx({ match, bank, allocations = [] }) {
  const state = { match, bank, allocations };
  return {
    state,
    reconciliationMatch: {
      findFirst: async () => state.match,
      update: async ({ data }) => Object.assign(state.match, data),
    },
    bankStatementTransaction: {
      findFirst: async () => state.bank,
      update: async ({ data }) => Object.assign(state.bank, data),
    },
    bankStatementAllocation: {
      findMany: async () => state.allocations,
      updateMany: async ({ data }) => state.allocations.forEach((row) => Object.assign(row, data)),
    },
  };
}

const bankReceipt = (overrides = {}) => ({
  id: "bank-1",
  transactionCode: "924T26800QKRMY5H",
  debitAmount: 0,
  creditAmount: 208_000,
  categoryCode: "THU_BANHANG",
  pnlItemCode: null,
  autoProcessNote: null,
  deletedAt: null,
  ...overrides,
});
const allocation = (overrides = {}) => ({
  id: "alloc-1",
  sourceRowNumber: 2,
  debitAmount: 0,
  creditAmount: 208_000,
  categoryCode: "THU_BANHANG",
  pnlItemCode: null,
  ...overrides,
});
const matchFor = (amount) => ({
  id: "match-1",
  bankTransactionId: "bank-1",
  targetType: "VOUCHER",
  targetId: "voucher-1",
  status: "MATCHED",
  targetAmount: amount,
  matchedAmount: amount,
});
const receiptVoucher = (amount, overrides = {}) => ({
  id: "voucher-1",
  code: "PTHU-2608-NME-00077",
  voucherType: "RECEIPT",
  amount,
  categoryCode: "THU_BANHANG",
  pnlItemCode: null,
  ...overrides,
});

test("sửa số tiền phiếu thu kéo theo dòng sao kê, dòng phân bổ và liên kết đối soát", async () => {
  const tx = makeTx({ match: matchFor(208_000), bank: bankReceipt(), allocations: [allocation()] });

  const result = await syncReconciledBankStatement(tx, receiptVoucher(209_790), "Kế toán A");

  assert.deepEqual(result, {
    transactionCode: "924T26800QKRMY5H",
    amount: { previous: 208_000, next: 209_790 },
  });
  assert.equal(tx.state.bank.creditAmount, 209_790);
  assert.equal(tx.state.bank.debitAmount, 0);
  assert.match(tx.state.bank.autoProcessNote, /PTHU-2608-NME-00077/);
  assert.equal(tx.state.allocations[0].creditAmount, 209_790);
  assert.equal(tx.state.match.targetAmount, 209_790);
  assert.equal(tx.state.match.matchedAmount, 209_790);
});

test("phiếu chi ghi vào cột Nợ của sao kê", async () => {
  const tx = makeTx({
    match: matchFor(5_000_000),
    bank: bankReceipt({ transactionCode: "GD-CHI-01", debitAmount: 5_000_000, creditAmount: 0, categoryCode: "CHI_MUA_NVL" }),
    allocations: [allocation({ debitAmount: 5_000_000, creditAmount: 0, categoryCode: "CHI_MUA_NVL" })],
  });

  await syncReconciledBankStatement(
    tx,
    { id: "voucher-1", code: "PTCHI-01", voucherType: "PAYMENT", amount: 4_800_000, categoryCode: "CHI_MUA_NVL", pnlItemCode: null },
    "Kế toán A",
  );

  assert.equal(tx.state.bank.debitAmount, 4_800_000);
  assert.equal(tx.state.bank.creditAmount, 0);
  assert.equal(tx.state.allocations[0].debitAmount, 4_800_000);
});

test("đổi khoản mục thu/chi trên phiếu kéo theo sao kê và mọi dòng phân bổ", async () => {
  const tx = makeTx({
    match: matchFor(208_000),
    bank: bankReceipt(),
    allocations: [allocation(), allocation({ id: "alloc-2", sourceRowNumber: 3, creditAmount: 0 })],
  });

  const result = await syncReconciledBankStatement(tx, receiptVoucher(208_000, { categoryCode: "THU_KHAC" }), "Kế toán A");

  assert.deepEqual(result.categoryCode, { previous: "THU_BANHANG", next: "THU_KHAC" });
  assert.equal(result.amount, undefined);
  assert.equal(tx.state.bank.categoryCode, "THU_KHAC");
  assert.deepEqual(tx.state.allocations.map((row) => row.categoryCode), ["THU_KHAC", "THU_KHAC"]);
  assert.equal(tx.state.bank.creditAmount, 208_000);
  assert.match(tx.state.bank.autoProcessNote, /khoản mục THU_BANHANG → THU_KHAC/);
});

test("đổi hạng mục P&L trên phiếu chi kéo theo sao kê", async () => {
  const tx = makeTx({
    match: matchFor(2_450_000),
    bank: bankReceipt({ debitAmount: 2_450_000, creditAmount: 0, categoryCode: "CHI_VANPHONGPHAM", pnlItemCode: "PNL_CP_VANPHONG" }),
    allocations: [allocation({ debitAmount: 2_450_000, creditAmount: 0, categoryCode: "CHI_VANPHONGPHAM", pnlItemCode: "PNL_CP_VANPHONG" })],
  });

  const result = await syncReconciledBankStatement(
    tx,
    { id: "voucher-1", code: "UNC-01", voucherType: "PAYMENT", amount: 2_450_000, categoryCode: "CHI_VANPHONGPHAM", pnlItemCode: "PNL_CP_KHAC" },
    "Kế toán A",
  );

  assert.deepEqual(result.pnlItemCode, { previous: "PNL_CP_VANPHONG", next: "PNL_CP_KHAC" });
  assert.equal(tx.state.bank.pnlItemCode, "PNL_CP_KHAC");
  assert.equal(tx.state.allocations[0].pnlItemCode, "PNL_CP_KHAC");
});

test("phiếu thu không mang P&L nên không xoá P&L đã khai trên sao kê", async () => {
  const tx = makeTx({
    match: matchFor(208_000),
    bank: bankReceipt({ pnlItemCode: "PNL_CP_VANPHONG" }),
    allocations: [allocation({ pnlItemCode: "PNL_CP_VANPHONG" })],
  });

  const result = await syncReconciledBankStatement(tx, receiptVoucher(208_000), "Kế toán A");

  assert.equal(result, null);
  assert.equal(tx.state.bank.pnlItemCode, "PNL_CP_VANPHONG");
});

test("phiếu bỏ trống khoản mục thì giữ nguyên khoản mục của sao kê", async () => {
  const tx = makeTx({ match: matchFor(208_000), bank: bankReceipt(), allocations: [allocation()] });

  const result = await syncReconciledBankStatement(tx, receiptVoucher(208_000, { categoryCode: null }), "Kế toán A");

  assert.equal(result, null);
  assert.equal(tx.state.bank.categoryCode, "THU_BANHANG");
});

test("dòng sao kê lịch sử không có dòng phân bổ vẫn đồng bộ được", async () => {
  const tx = makeTx({ match: matchFor(208_000), bank: bankReceipt() });

  await syncReconciledBankStatement(tx, receiptVoucher(210_000, { categoryCode: "THU_KHAC" }), "Kế toán A");

  assert.equal(tx.state.bank.creditAmount, 210_000);
  assert.equal(tx.state.bank.categoryCode, "THU_KHAC");
});

test("không có gì đổi thì không đụng vào sao kê, chỉ vá liên kết lệch", async () => {
  const tx = makeTx({
    match: { ...matchFor(208_000), targetAmount: 999, matchedAmount: 999 },
    bank: bankReceipt(),
  });

  const result = await syncReconciledBankStatement(tx, receiptVoucher(208_000), "Kế toán A");

  assert.equal(result, null);
  assert.equal(tx.state.bank.autoProcessNote, null);
  assert.equal(tx.state.match.targetAmount, 208_000);
  assert.equal(tx.state.match.matchedAmount, 208_000);
});

test("giao dịch nhiều dòng phân bổ thì chặn sửa số tiền, không đoán cách chia lại", async () => {
  const tx = makeTx({
    match: matchFor(208_000),
    bank: bankReceipt(),
    allocations: [allocation({ creditAmount: 100_000 }), allocation({ id: "alloc-2", sourceRowNumber: 3, creditAmount: 108_000 })],
  });

  await assert.rejects(
    () => syncReconciledBankStatement(tx, receiptVoucher(209_790), "Kế toán A"),
    (error) => error instanceof ReconciliationSyncError && /2 dòng phân bổ/.test(error.message),
  );
  assert.equal(tx.state.bank.creditAmount, 208_000);
});

test("các dòng phân bổ khác khoản mục nhau thì chặn, không xoá phân loại từng dòng", async () => {
  const tx = makeTx({
    match: matchFor(208_000),
    bank: bankReceipt(),
    allocations: [allocation(), allocation({ id: "alloc-2", sourceRowNumber: 3, creditAmount: 0, categoryCode: "THU_KHAC" })],
  });

  await assert.rejects(
    () => syncReconciledBankStatement(tx, receiptVoucher(208_000, { categoryCode: "THU_TIEN_COC" }), "Kế toán A"),
    (error) => error instanceof ReconciliationSyncError && /khoản mục thu\/chi khác nhau/.test(error.message),
  );
  assert.equal(tx.state.bank.categoryCode, "THU_BANHANG");
});

test("phiếu ngược chiều với sao kê thì chặn thay vì lật cột Nợ/Có", async () => {
  const tx = makeTx({
    match: matchFor(208_000),
    bank: bankReceipt({ debitAmount: 208_000, creditAmount: 0 }),
  });

  await assert.rejects(
    () => syncReconciledBankStatement(tx, receiptVoucher(209_790), "Kế toán A"),
    (error) => error instanceof ReconciliationSyncError && /ngược chiều/.test(error.message),
  );
});

test("phiếu tiền mặt không dính sao kê thì bỏ qua", async () => {
  const tx = makeTx({ match: null, bank: bankReceipt() });

  assert.equal(await syncReconciledBankStatement(tx, receiptVoucher(1_000), "Kế toán A"), null);
  assert.equal(tx.state.bank.creditAmount, 208_000);
});
