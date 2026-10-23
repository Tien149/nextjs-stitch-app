/**
 * Chuyển công nợ phải trả A → B không qua thu chi (khách 23/10/2026, lib/debt-transfer.ts):
 *   - gạch nợ A (khoản cũ trước), sinh khoản phải trả mới của B, bút toán Nợ 331 (A) / Có 331 (B);
 *   - sổ công nợ: A giảm, B tăng đúng số chuyển; xoá phiếu trả lại nguyên trạng.
 *
 * Chạy trên DB local với cửa hàng TCN và đối tác TCN-A / TCN-B riêng, tự dọn sạch.
 * Chạy: npm run test:debt-transfer
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDebtTransfer, deleteDebtTransfer } from "../lib/debt-transfer.ts";
import { loadDebtOverview, parseDateRange } from "../lib/debt-overview.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "TCN";
const A = "TCN-A";
const B = "TCN-B";

async function cleanup() {
  const transfers = await prisma.debtTransfer.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  await prisma.journalEntry.deleteMany({ where: { sourceType: "DEBT_TRANSFER", sourceId: { in: transfers.map((row) => row.id) } } });
  await prisma.debtSettlement.deleteMany({ where: { debt: { branchCode: BRANCH } } });
  await prisma.debtTransfer.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.debtRecord.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.masterDataItem.deleteMany({ where: { OR: [{ type: "PARTNER", code: { in: [A, B] } }, { type: "BRANCH", code: BRANCH }] } });
}

const balanceOf = async (partnerCode) => (await loadDebtOverview({ branchCode: BRANCH, range: parseDateRange(null, null), partnerCode })).balance;

test("chuyển công nợ phải trả giữa hai đối tác", async (t) => {
  await cleanup();
  t.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "NH test chuyển nợ", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PARTNER", code: A, name: "NCC A", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PARTNER", code: B, name: "NCC B", status: "ACTIVE" } });
  const date = new Date("2026-10-05T00:00:00");
  const old = await prisma.debtRecord.create({ data: { code: "TCN-OLD", debtType: "PAYABLE", partnerCode: A, partnerName: "NCC A", branchCode: BRANCH, documentDate: new Date("2026-10-01T00:00:00"), originalAmount: 400_000, outstandingAmount: 400_000, description: "Nợ cũ", sourceType: "IMPORT" } });
  const newer = await prisma.debtRecord.create({ data: { code: "TCN-NEW", debtType: "PAYABLE", partnerCode: A, partnerName: "NCC A", branchCode: BRANCH, documentDate: new Date("2026-10-03T00:00:00"), originalAmount: 600_000, outstandingAmount: 600_000, description: "Nợ mới", sourceType: "IMPORT" } });
  assert.equal(await balanceOf(A), 1_000_000);

  const result = await createDebtTransfer({ branchCode: BRANCH, documentDate: date, fromPartnerCode: A, toPartnerCode: B, amount: 700_000, description: "A chỉ định trả cho B" }, "test");
  assert.deepEqual(result.settled, ["TCN-OLD", "TCN-NEW"], "gạch khoản cũ trước");
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: old.id } })).status, "SETTLED");
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: newer.id } })).outstandingAmount, 300_000);
  const target = await prisma.debtRecord.findFirst({ where: { code: result.transfer.code } });
  assert.equal(target.partnerCode, B);
  assert.equal(target.recognizeExpense, false, "không ghi chi phí lần hai");
  assert.equal(await balanceOf(A), 300_000, "A giảm phải trả");
  assert.equal(await balanceOf(B), 700_000, "B tăng phải trả");

  const entry = await prisma.journalEntry.findFirst({ where: { sourceType: "DEBT_TRANSFER", sourceId: result.transfer.id }, include: { lines: { include: { account: true } } } });
  const debit = entry.lines.find((line) => line.debit > 0);
  const credit = entry.lines.find((line) => line.credit > 0);
  assert.equal(debit.account.code, "331");
  assert.equal(debit.partnerCode, A);
  assert.equal(credit.account.code, "331");
  assert.equal(credit.partnerCode, B);
  assert.equal(credit.credit, 700_000);

  await deleteDebtTransfer(result.transfer.id);
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: old.id } })).outstandingAmount, 400_000);
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: newer.id } })).status, "OPEN");
  assert.equal(await prisma.debtRecord.count({ where: { code: result.transfer.code } }), 0);
  assert.equal(await prisma.journalEntry.count({ where: { sourceType: "DEBT_TRANSFER", sourceId: result.transfer.id } }), 0);
  assert.equal(await balanceOf(A), 1_000_000);
  assert.equal(await balanceOf(B), 0);
});
