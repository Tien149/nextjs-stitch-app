import assert from "node:assert/strict";
import test from "node:test";
import { buildBalanceSheet, equityOpeningJournalLines, openingDifferenceOf } from "../lib/balance-sheet.ts";

const acct = (code, accountType, normalBalance, debit, credit, before = [0, 0], reportGroup = accountType) =>
  ({ code, name: code, accountType, reportGroup, normalBalance, debit, credit, debitBeforeYear: before[0], creditBeforeYear: before[1] });

test("nguồn vốn đầu kỳ: Nợ 4199 / Có 411 · 421 · 341, lỗ lũy kế đảo chiều", () => {
  assert.deepEqual(equityOpeningJournalLines({ balanceType: "EQUITY_CAPITAL", amount: 1000 }).map((l) => [l.accountCode, l.debit || 0, l.credit || 0]), [["4199", 1000, 0], ["411", 0, 1000]]);
  assert.deepEqual(equityOpeningJournalLines({ balanceType: "RETAINED_EARNINGS", amount: -300 }).map((l) => [l.accountCode, l.debit || 0, l.credit || 0]), [["421", 300, 0], ["4199", 0, 300]]);
  const loan = equityOpeningJournalLines({ balanceType: "LOAN", amount: 500, objectCode: "NH_VCB" });
  assert.equal(loan[1].accountCode, "341");
  assert.equal(loan[1].partnerCode, "NH_VCB");
  assert.deepEqual(equityOpeningJournalLines({ balanceType: "CASH", amount: 1 }), []);
});

test("chênh lệch đầu kỳ = tài sản − nợ − nguồn vốn đã khai", () => {
  const rows = [
    { balanceType: "BANK", amount: 6000 }, { balanceType: "AP", amount: 4600 },
    { balanceType: "EQUITY_CAPITAL", amount: 1000 }, { balanceType: "RETAINED_EARNINGS", amount: 400 },
  ];
  assert.equal(openingDifferenceOf(rows), 0);
  assert.equal(openingDifferenceOf(rows.slice(0, 2)), 1400);
});

test("bảng cân đối: chỉ tài sản / nợ / vốn, 711 & doanh thu chi phí dồn vào 421, hao mòn âm", () => {
  const sheet = buildBalanceSheet([
    acct("1121", "ASSET", "DEBIT", 7000, 1000),
    acct("211", "ASSET", "DEBIT", 500, 0),
    acct("214", "ASSET", "CREDIT", 0, 100, [0, 0], "ACCUMULATED_DEPRECIATION"),
    acct("331", "LIABILITY", "CREDIT", 0, 4600),
    acct("411", "EQUITY", "CREDIT", 0, 1000),
    acct("421", "EQUITY", "CREDIT", 0, 400),
    acct("4199", "EQUITY", "CREDIT", 1400, 1400),
    // Năm trước: 511 có 800, 6428 nợ 500 → lãi 300; năm nay: 511 thêm 1000, 711 200, 632 900, 6424 100 → lãi 200.
    acct("511", "REVENUE", "CREDIT", 0, 1800, [0, 800]),
    acct("711", "OTHER_INCOME", "CREDIT", 0, 200),
    acct("632", "COGS", "DEBIT", 900, 0),
    acct("6428", "OPEX", "DEBIT", 500, 0, [500, 0]),
    acct("6424", "OPEX", "DEBIT", 100, 0),
  ], "2026");
  assert.equal(sheet.rows.some((row) => ["511", "711", "632", "6428", "4199"].includes(row.code)), false);
  assert.equal(sheet.rows.find((row) => row.code === "214").amount, -100);
  const retained = sheet.rows.find((row) => row.code === "421");
  assert.equal(retained.amount, 400 + 300 + 200);
  assert.deepEqual(retained.detail.map((part) => part.amount), [400, 300, 200]);
  assert.equal(sheet.assets, 6000 + 500 - 100);
  assert.equal(sheet.equity, 1000 + 900);
  assert.equal(sheet.balanced, false); // dữ liệu giả không cân — chỉ kiểm phép cộng
  assert.equal(sheet.openingDifference, 0);
});

test("4199 còn số thì hiện dòng cảnh báo", () => {
  const sheet = buildBalanceSheet([acct("1121", "ASSET", "DEBIT", 100, 0), acct("4199", "EQUITY", "CREDIT", 0, 100)], "2026");
  const row = sheet.rows.find((item) => item.code === "4199");
  assert.ok(row.warning);
  assert.equal(sheet.openingDifference, 100);
  assert.equal(sheet.balanced, true);
});
