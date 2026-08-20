import assert from "node:assert/strict";
import test from "node:test";
import {
  internalTransferDebtCodes,
  isCrossBranchTransfer,
  moneySourceBranchCode,
  planMoneyTransferJournals,
  resolveTransferMoneySource,
  transferBranches,
  transferJournalIsBalanced,
  transferLegsForBranch,
} from "../lib/internal-transfer.ts";

const moneySources = [
  { code: "ASAATIENCOO", name: "Tiền cô ASA", branch: "ASA", status: "ACTIVE" },
  { code: "FDSTIENBINH", name: "Tiền Bình", branch: "NME", status: "ACTIVE" },
  { code: "QUYCHUNG", name: "Quỹ dùng chung", branch: null, status: "ACTIVE" },
  { code: "ASACU", name: "Nguồn cũ ASA", branch: "ASA", status: "INACTIVE" },
  { code: "TIENMAT_ASA", name: "Tiền mặt", branch: "ASA", status: "ACTIVE" },
  { code: "TIENMAT_NME", name: "Tiền mặt", branch: "NME", status: "ACTIVE" },
];

const sameBranch = {
  branchCode: "ASA",
  amount: 5_000_000,
  feeAmount: 0,
  fromAccountCode: "1111",
  toAccountCode: "1121",
  description: "Nộp tiền vào ngân hàng",
};

const crossBranch = {
  branchCode: "ASA",
  fromBranchCode: "ASA",
  toBranchCode: "NME",
  amount: 111_281_000,
  feeAmount: 0,
  fromAccountCode: "1111",
  toAccountCode: "1121",
  description: "Cô rút tiền để chi lương tháng 07.2026 cho 2 nhà hàng",
};

test("cột cửa hàng để trống nghĩa là cùng cửa hàng với phiếu", () => {
  assert.deepEqual(transferBranches({ branchCode: "ASA" }), {
    fromBranchCode: "ASA",
    toBranchCode: "ASA",
    isCrossBranch: false,
  });
  assert.equal(isCrossBranchTransfer(crossBranch), true);
});

test("điều tiền trong một cửa hàng vẫn giữ nguyên một bút toán như cũ", () => {
  const journals = planMoneyTransferJournals(sameBranch);
  assert.equal(journals.length, 1);
  assert.equal(journals[0].branchCode, "ASA");
  assert.equal(journals[0].sourceType, "MONEY_TRANSFER");
  assert.equal(journals[0].lines.find((line) => line.accountCode === "1121").debit, 5_000_000);
  assert.equal(journals[0].lines.find((line) => line.accountCode === "1111").credit, 5_000_000);
  assert.ok(transferJournalIsBalanced(journals[0]));
});

test("điều tiền liên nhà hàng: bên chuyển phải thu, bên nhận phải trả", () => {
  const journals = planMoneyTransferJournals(crossBranch);
  assert.equal(journals.length, 2);

  const [outJournal, inJournal] = journals;
  assert.equal(outJournal.branchCode, "ASA");
  assert.equal(outJournal.sourceType, "MONEY_TRANSFER");
  const receivable = outJournal.lines.find((line) => line.accountCode === "1368");
  assert.equal(receivable.debit, 111_281_000);
  assert.equal(receivable.partnerCode, "NB-NME");
  assert.equal(outJournal.lines.find((line) => line.accountCode === "1111").credit, 111_281_000);
  // Tiền không còn tự chui vào nguồn của cửa hàng kia trong sổ của bên chuyển.
  assert.equal(outJournal.lines.some((line) => line.accountCode === "1121"), false);

  assert.equal(inJournal.branchCode, "NME");
  assert.equal(inJournal.sourceType, "MONEY_TRANSFER_COUNTERPART");
  assert.equal(inJournal.lines.find((line) => line.accountCode === "1121").debit, 111_281_000);
  const payable = inJournal.lines.find((line) => line.accountCode === "3368");
  assert.equal(payable.credit, 111_281_000);
  assert.equal(payable.partnerCode, "NB-ASA");

  assert.ok(journals.every((journal) => transferJournalIsBalanced(journal)));
});

test("phí/chênh lệch của phiếu liên nhà hàng nằm ở bên chuyển", () => {
  const journals = planMoneyTransferJournals({ ...crossBranch, amount: 1_000_000, feeAmount: 20_000, feeCategoryCode: "PHI_NH" });
  const [outJournal, inJournal] = journals;
  assert.equal(outJournal.lines.find((line) => line.accountCode === "6428").debit, 20_000);
  assert.equal(outJournal.lines.find((line) => line.accountCode === "1111").credit, 1_020_000);
  assert.equal(inJournal.lines.some((line) => line.accountCode === "6428"), false);
  assert.ok(journals.every((journal) => transferJournalIsBalanced(journal)));
});

test("mỗi cửa hàng chỉ thấy vế tiền của chính mình, xem toàn công ty thì thấy đủ", () => {
  assert.deepEqual(transferLegsForBranch(crossBranch, "ASA"), { out: true, in: false });
  assert.deepEqual(transferLegsForBranch(crossBranch, "NME"), { out: false, in: true });
  assert.deepEqual(transferLegsForBranch(crossBranch, "ALL"), { out: true, in: true });
  assert.deepEqual(transferLegsForBranch(sameBranch, "ASA"), { out: true, in: true });
});

test("mã công nợ nội bộ bám theo mã phiếu điều tiền", () => {
  assert.deepEqual(internalTransferDebtCodes("CTNB-202608-ASA-0001"), {
    receivableCode: "CTNB-202608-ASA-0001-PT",
    payableCode: "CTNB-202608-ASA-0001-PTR",
  });
});

test("nguồn nhận của nhà hàng khác được nhận, không còn báo không thuộc cửa hàng", () => {
  const found = resolveTransferMoneySource(moneySources, "FDSTIENBINH", "ASA");
  assert.equal(found.source.code, "FDSTIENBINH");
  assert.equal(found.ambiguous, false);
  assert.equal(moneySourceBranchCode(found.source, "ASA"), "NME");
});

test("nguồn của chính cửa hàng luôn được ưu tiên trước nguồn dùng chung", () => {
  assert.equal(resolveTransferMoneySource(moneySources, "Tiền mặt", "NME").source.code, "TIENMAT_NME");
  assert.equal(moneySourceBranchCode(resolveTransferMoneySource(moneySources, "QUYCHUNG", "ASA").source, "ASA"), "ASA");
});

test("hai nhà hàng đặt trùng tên nguồn thì báo lỗi chứ không đoán bên nào", () => {
  const found = resolveTransferMoneySource(moneySources, "Tiền mặt", "HCM");
  assert.equal(found.source, null);
  assert.equal(found.ambiguous, true);
});

test("nguồn đã ngưng hoạt động vẫn bị chặn", () => {
  assert.deepEqual(resolveTransferMoneySource(moneySources, "ASACU", "ASA"), { source: null, ambiguous: false });
  assert.deepEqual(resolveTransferMoneySource(moneySources, "", "ASA"), { source: null, ambiguous: false });
});
