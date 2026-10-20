/**
 * Ghi sổ lại một nguồn đã có bút toán bị XOÁ MỀM (khách 20/10/2026): trước đây postJournalEntry
 * không thấy bản đã xoá, create đâm unique (sourceType, sourceId) -> P2002 và Đồng bộ ghi sổ kỳ 08
 * dừng trước khấu hao + phân bổ (CAPEX = 0). Nay khôi phục đúng bản đó với dòng mới.
 *
 * Chạy trên DB local, kỳ 2032-03, tự dọn. npm run test:journal-revive
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.ts";
import { postJournalEntry } from "../lib/accounting.ts";

const SOURCE = { sourceType: "TEST_REVIVE", sourceId: "test-revive-1" };
const entry = (amount) => ({
  entryDate: new Date("2032-03-15T00:00:00.000Z"), branchCode: "NME", ...SOURCE, sourceCode: "TEST", description: "test", createdBy: "test",
  lines: [{ accountCode: "6428", debit: amount }, { accountCode: "1111", credit: amount }],
});

async function cleanup() {
  const rows = await prisma.journalEntry.findMany({ where: { ...SOURCE, deletedAt: undefined }, select: { id: true } });
  await prisma.journalLine.deleteMany({ where: { entryId: { in: rows.map((row) => row.id) } } });
  await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "sourceType" = ${SOURCE.sourceType}`;
}

test("ghi lại nguồn có bút toán đã xoá mềm thì khôi phục, không vỡ unique", async (t) => {
  await cleanup();
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  assert.equal(await postJournalEntry(entry(100_000)), "CREATED");
  await prisma.journalEntry.deleteMany({ where: SOURCE });
  assert.equal(await prisma.journalEntry.count({ where: SOURCE }), 0, "đã xoá mềm");
  assert.equal(await postJournalEntry(entry(150_000)), "CREATED");
  const revived = await prisma.journalEntry.findFirst({ where: SOURCE, include: { lines: true } });
  assert.ok(revived, "bút toán sống lại");
  assert.equal(revived.lines.reduce((sum, line) => sum + line.debit, 0), 150_000);
  assert.equal(await postJournalEntry(entry(150_000)), "SKIPPED_EXISTS");
});
