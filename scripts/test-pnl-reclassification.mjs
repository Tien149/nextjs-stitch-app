/**
 * Phiếu điều chỉnh hạng mục P&L trong một nhà hàng (khách 30/10/2026) — lib/pnl-reclassification.ts.
 * Luật thuần + một lượt trên DB local: bút toán của phiếu làm hạng mục A giảm, B tăng đúng số tiền
 * trên P&L (byPnlItem) mà tổng chi phí nhà hàng không đổi. Tự dọn bút toán test.
 *
 * Chạy: npm run test:pnl-reclassification
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { availableForPnlReclassEdit, planPnlReclassJournal, validatePnlReclass } from "../lib/pnl-reclassification.ts";
import { journalIsBalanced } from "../lib/cost-reallocation.ts";
import { getPnl } from "../lib/reports.ts";
import { postedExpenseForPnlItem } from "../lib/expense-summary.ts";
import { ensureDefaultAccounts } from "../lib/accounting.ts";
import { prisma, prismaRaw } from "../lib/prisma.ts";

const TEST_CODE = "JE-DCHM-TEST-0001";

after(async () => {
  await prismaRaw.journalEntry.deleteMany({ where: { code: TEST_CODE } });
  await prisma.$disconnect();
  await prismaRaw.$disconnect();
});

test("kiểm tra: A khác B, số tiền dương, đủ ô", () => {
  assert.deepEqual(validatePnlReclass({ branchCode: "HCM", fromPnlItemCode: "A", toPnlItemCode: "B", amount: 1 }), []);
  assert.ok(validatePnlReclass({ branchCode: "HCM", fromPnlItemCode: "A", toPnlItemCode: "a", amount: 1 }).some((error) => error.includes("khác nhau")));
  assert.ok(validatePnlReclass({ branchCode: "HCM", fromPnlItemCode: "A", toPnlItemCode: "B", amount: 0 }).some((error) => error.includes("lớn hơn 0")));
  assert.ok(validatePnlReclass({ branchCode: "", fromPnlItemCode: "", toPnlItemCode: "", amount: 1 }).length >= 3);
});

test("bút toán: Nợ B / Có A, đúng tài khoản theo nhóm (Giá vốn 632, còn lại 6428), cân", () => {
  const journal = planPnlReclassJournal({ branchCode: "hcm", fromPnlItemCode: "GV_A", toPnlItemCode: "CP_B", amount: 500 }, { from: "COGS", to: "OPEX" });
  assert.equal(journal.branchCode, "HCM");
  assert.deepEqual(journal.lines.map((line) => [line.accountCode, line.debit, line.credit, line.pnlItemCode]), [
    ["6428", 500, 0, "CP_B"],
    ["632", 0, 500, "GV_A"],
  ]);
  assert.ok(journalIsBalanced(journal));
});

test("sửa phiếu: cộng trả số cũ chỉ khi cùng kỳ, nhà hàng, hạng mục A", () => {
  const next = { period: "2026-08", branchCode: "HCM", fromPnlItemCode: "A" };
  assert.equal(availableForPnlReclassEdit({ postedAmount: 100, next, current: null }), 100);
  assert.equal(availableForPnlReclassEdit({ postedAmount: 100, next, current: { ...next, amount: 40 } }), 140);
  assert.equal(availableForPnlReclassEdit({ postedAmount: 100, next, current: { ...next, fromPnlItemCode: "C", amount: 40 } }), 100);
});

test("DB: P&L hạng mục A giảm, B tăng đúng số, tổng chi phí không đổi", async () => {
  const period = "2026-08";
  const branchCode = "HCM";
  const [from, to] = ["PNL_CP_MATBANG", "PNL_CP_DIENNUOC"];
  const amount = 10_000_000;
  const postedBefore = await postedExpenseForPnlItem(period, branchCode, from);
  if (postedBefore < amount) return; // DB local không có dữ liệu mẫu thì bỏ qua phần này
  const before = await getPnl(period, branchCode);
  const accounts = await ensureDefaultAccounts();
  const accountId = new Map(accounts.map((row) => [row.code, row.id]));
  const journal = planPnlReclassJournal({ branchCode, fromPnlItemCode: from, toPnlItemCode: to, amount }, { from: "OPEX", to: "OPEX" });
  await prismaRaw.journalEntry.create({
    data: {
      code: TEST_CODE, entryDate: new Date("2026-08-15T00:00:00Z"), period, branchCode,
      sourceType: "PNL_RECLASS", sourceId: "test", sourceCode: "DCHM-TEST", description: "test", status: "POSTED",
      lines: { create: journal.lines.map((line) => ({ accountId: accountId.get(line.accountCode), debit: line.debit, credit: line.credit, pnlItemCode: line.pnlItemCode })) },
    },
  });
  const after = await getPnl(period, branchCode);
  const itemAmount = (pnl, code) => pnl.byPnlItem.find((row) => row.code === code)?.amount || 0;
  assert.equal(itemAmount(after, from), itemAmount(before, from) - amount);
  assert.equal(itemAmount(after, to), itemAmount(before, to) + amount);
  const totalCost = (pnl) => pnl.total.cogs + pnl.total.payroll + pnl.total.otherOpex + pnl.total.otherExpense + pnl.total.capex;
  assert.ok(Math.abs(totalCost(after) - totalCost(before)) < 1, "tổng chi phí nhà hàng không đổi");
  assert.equal(await postedExpenseForPnlItem(period, branchCode, from), postedBefore - amount);
});
