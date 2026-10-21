/**
 * Xoá từng dòng doanh thu trên Sổ doanh thu (khách 21/10/2026) — deleteRevenueImportRows.
 * Xoá cứng dòng + bút toán, trừ số dòng của lô, lô hết dòng thì ROLLED_BACK; dòng đã rã bị chặn.
 * DB local, ngày 2033-02, tự dọn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma.ts";
import { deleteRevenueImportRows } from "../lib/import-commit.ts";

const FILE = "TEST-REVENUE-ROW-DELETE.xlsx";
const day = new Date("2033-02-10T00:00:00Z");

async function cleanup() {
  const batches = await prisma.importBatch.findMany({ where: { fileName: FILE }, select: { id: true } });
  const ids = batches.map((batch) => batch.id);
  if (ids.length === 0) return;
  const rows = await prisma.$queryRaw`SELECT id FROM "RevenueImportRow" WHERE "importBatchId" = ANY(${ids})`;
  const rowIds = rows.map((row) => row.id);
  await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" IN (SELECT id FROM "JournalEntry" WHERE "sourceId" = ANY(${rowIds}))`;
  await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "sourceId" = ANY(${rowIds})`;
  await prisma.$executeRaw`DELETE FROM "RevenueImportRow" WHERE "importBatchId" = ANY(${ids})`;
  await prisma.$executeRaw`DELETE FROM "ImportBatch" WHERE id = ANY(${ids})`;
}

const row = (batchId, ref, extra = {}) => prisma.revenueImportRow.create({
  data: { importBatchId: batchId, saleDate: day, branchCode: "HCM", revenueSource: "REV_FOOD", paymentMethod: "CASH", grossAmount: 100000, netAmount: 100000, externalRef: ref, ...extra },
});

test("xoá từng dòng doanh thu: xoá dòng + bút toán, cập nhật lô; dòng đã rã bị chặn", async (t) => {
  await cleanup();
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  const batch = await prisma.importBatch.create({ data: { importType: "REVENUE_POS", templateCode: "TEST", fileName: FILE, status: "COMMITTED", totalRows: 3, validRows: 3 } });
  const a = await row(batch.id, "TEST-RRD-A");
  const b = await row(batch.id, "TEST-RRD-B");
  const posted = await row(batch.id, "TEST-RRD-C", { inventoryStatus: "POSTED:RA-TEST-1" });
  await prisma.journalEntry.create({ data: { entryDate: day, branchCode: "HCM", sourceType: "REVENUE_POS", sourceId: a.id, sourceCode: a.externalRef, code: "TEST-RRD-JE-A", period: "2033-02", description: "test" } });

  await assert.rejects(() => deleteRevenueImportRows({ ids: [a.id, posted.id], actor: "test", note: "thử" }), /rã nguyên liệu/);
  assert.equal(await prisma.revenueImportRow.count({ where: { importBatchId: batch.id } }), 3, "bị chặn thì không xoá dòng nào");

  const result = await deleteRevenueImportRows({ ids: [a.id], actor: "test", note: "nhập trùng" });
  assert.equal(result.deletedRows, 1);
  assert.equal(await prisma.revenueImportRow.count({ where: { id: a.id } }), 0);
  assert.equal(await prisma.journalEntry.count({ where: { sourceType: "REVENUE_POS", sourceId: a.id } }), 0);
  let updated = await prisma.importBatch.findUnique({ where: { id: batch.id } });
  assert.equal(updated.totalRows, 2);
  assert.equal(updated.status, "COMMITTED");

  await prisma.revenueImportRow.update({ where: { id: posted.id }, data: { inventoryStatus: null } });
  await deleteRevenueImportRows({ ids: [b.id, posted.id], actor: "test", note: "xoá hết" });
  updated = await prisma.importBatch.findUnique({ where: { id: batch.id } });
  assert.equal(updated.totalRows, 0);
  assert.equal(updated.status, "ROLLED_BACK");
});
