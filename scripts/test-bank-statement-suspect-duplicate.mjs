import assert from "node:assert/strict";
import test from "node:test";
import { bankStatementSuspectKey, groupBankStatementRows } from "../lib/bank-statement-import.ts";

/**
 * Case Nam Mê 09/2026: file sao kê được sửa rồi import lại, cột Số tham chiếu đổi từ
 * "2102333" thành "21023" cho CÙNG một lần Vietinbank ghi có 1.782.837 đ ngày 03/08/2026
 * (cùng DOCNO trong diễn giải). Chống trùng cứng chạy theo Tài khoản + Số tham chiếu nên
 * không bắt được, sổ sao kê có hai dòng, và báo cáo Tiền về đủ chưa cộng dư đúng 1.782.837 đ.
 */
const bankAccount = "FDSCHKHVIET";
const transactionDate = new Date("2026-08-03T00:00:00.000Z");
const amount = 1_782_837;

const row = (transactionCode, overrides = {}) => ({
  sheetName: "Sheet1",
  rowNumber: 2,
  errors: [],
  rawValues: {},
  values: {
    bank_account: bankAccount,
    transaction_code: transactionCode,
    transaction_date: transactionDate,
    debit_amount: 0,
    credit_amount: amount,
    ...overrides,
  },
});

const keyOf = (parsedRow) => {
  const [group] = groupBankStatementRows([parsedRow]);
  return bankStatementSuspectKey(
    parsedRow.values.bank_account,
    parsedRow.values.transaction_date,
    group.debitAmount,
    group.creditAmount,
  );
};

test("hai số tham chiếu khác nhau của cùng một lần chuyển tiền cho ra cùng khoá nghi trùng", () => {
  assert.equal(keyOf(row("2102333")), keyOf(row("21023")));
});

test("khác số tiền thì không phải nghi trùng", () => {
  assert.notEqual(keyOf(row("21023")), keyOf(row("21024", { credit_amount: amount + 1 })));
});

test("khác chiều Nợ/Có thì không phải nghi trùng", () => {
  assert.notEqual(
    keyOf(row("21023")),
    keyOf(row("21024", { credit_amount: 0, debit_amount: amount })),
  );
});

test("khác ngày giao dịch thì không phải nghi trùng", () => {
  assert.notEqual(
    keyOf(row("21023")),
    keyOf(row("21024", { transaction_date: new Date("2026-08-04T00:00:00.000Z") })),
  );
});

test("khác tài khoản thì không phải nghi trùng", () => {
  assert.notEqual(keyOf(row("21023")), keyOf(row("21024", { bank_account: "ASACHKHMPOS" })));
});

test("lẻ đồng được làm tròn, để dòng trong file so được với số đã lưu trong CSDL", () => {
  assert.equal(
    bankStatementSuspectKey(bankAccount, transactionDate, 0, amount),
    bankStatementSuspectKey(bankAccount, transactionDate, 0, amount + 0.4),
  );
});

test("gộp nhiều dòng phân bổ thì khoá tính trên số tiền ròng của cả giao dịch", () => {
  const groups = groupBankStatementRows([
    row("21023", { credit_amount: 1_000_000 }),
    { ...row("21023", { credit_amount: 782_837 }), rowNumber: 3 },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(
    bankStatementSuspectKey(bankAccount, transactionDate, groups[0].debitAmount, groups[0].creditAmount),
    keyOf(row("2102333")),
  );
});
