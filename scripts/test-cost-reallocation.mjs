import assert from "node:assert/strict";
import test from "node:test";
import {
  costReallocationTotal,
  expenseAccountForPnlGroup,
  internalPartnerCode,
  journalIsBalanced,
  planCostReallocationJournals,
  validateCostReallocation,
} from "../lib/cost-reallocation.ts";

const baseInput = {
  fromBranchCode: "NME",
  pnlItemCode: "CPBD_GAS",
  lines: [
    { toBranchCode: "ASA", amount: 3_000_000 },
    { toBranchCode: "HCM", amount: 2_000_000 },
  ],
};

test("tổng phiếu luôn bằng tổng các dòng phân bổ", () => {
  assert.equal(costReallocationTotal(baseInput.lines), 5_000_000);
});

test("phân bổ hợp lệ thì không có lỗi", () => {
  assert.deepEqual(validateCostReallocation(baseInput), []);
});

test("không cho phân bổ về chính nhà hàng đã trả", () => {
  const errors = validateCostReallocation({ ...baseInput, lines: [{ toBranchCode: "NME", amount: 1_000 }] });
  assert.ok(errors.some((message) => message.includes("phải khác nhà hàng đã trả")));
});

test("bắt trùng nhà hàng trên hai dòng", () => {
  const errors = validateCostReallocation({
    ...baseInput,
    lines: [{ toBranchCode: "ASA", amount: 1_000 }, { toBranchCode: "ASA", amount: 2_000 }],
  });
  assert.ok(errors.some((message) => message.includes("bị khai trùng")));
});

test("số tiền phải lớn hơn 0 và bắt buộc có hạng mục P&L", () => {
  const errors = validateCostReallocation({ fromBranchCode: "NME", pnlItemCode: "", lines: [{ toBranchCode: "ASA", amount: 0 }] });
  assert.ok(errors.some((message) => message.includes("Hạng mục P&L")));
  assert.ok(errors.some((message) => message.includes("lớn hơn 0")));
});

test("chi phí giảm ở nhà hàng đã trả, tăng đúng phần ở nhà hàng nhận", () => {
  const journals = planCostReallocationJournals(baseInput, "OPEX");
  assert.equal(journals.length, 3);

  const [fromJournal, asaJournal, hcmJournal] = journals;
  assert.equal(fromJournal.branchCode, "NME");
  // Ghi Có tài khoản chi phí = giảm chi phí trên P&L của nhà hàng đã trả.
  const fromExpense = fromJournal.lines.find((line) => line.accountCode === "6428");
  assert.equal(fromExpense.credit, 5_000_000);
  assert.equal(fromExpense.pnlItemCode, "CPBD_GAS");
  assert.equal(fromJournal.lines.find((line) => line.accountCode === "1368").debit, 5_000_000);

  assert.equal(asaJournal.branchCode, "ASA");
  assert.equal(asaJournal.lines.find((line) => line.accountCode === "6428").debit, 3_000_000);
  assert.equal(hcmJournal.lines.find((line) => line.accountCode === "6428").debit, 2_000_000);

  // Tổng chi phí toàn công ty không đổi: -5tr ở NME, +3tr ASA, +2tr HCM.
  const netExpense = journals
    .flatMap((journal) => journal.lines)
    .filter((line) => line.accountCode === "6428")
    .reduce((sum, line) => sum + line.debit - line.credit, 0);
  assert.equal(netExpense, 0);
});

test("mọi bút toán đều cân", () => {
  for (const journal of planCostReallocationJournals(baseInput, "OPEX")) {
    assert.ok(journalIsBalanced(journal), `Bút toán ${journal.branchCode} không cân`);
  }
});

test("hạng mục giá vốn đi vào tài khoản 632", () => {
  assert.equal(expenseAccountForPnlGroup("COGS"), "632");
  assert.equal(expenseAccountForPnlGroup("OPEX"), "6428");
  assert.equal(expenseAccountForPnlGroup(null), "6428");
  const journals = planCostReallocationJournals(baseInput, "COGS");
  assert.ok(journals[0].lines.some((line) => line.accountCode === "632" && line.credit === 5_000_000));
});

test("công nợ nội bộ gắn đúng đối tác đại diện nhà hàng", () => {
  assert.equal(internalPartnerCode("nme"), "NB-NME");
  const journals = planCostReallocationJournals(baseInput, "OPEX");
  assert.equal(journals[1].lines.find((line) => line.accountCode === "3368").partnerCode, "NB-NME");
});
