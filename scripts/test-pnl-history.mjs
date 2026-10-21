/**
 * Số P&L nhập tay của các tháng trước khi lên phần mềm (khách 19/10/2026, lib/pnl-history.ts):
 *   - P&L một kỳ, bảng 12 tháng và doanh thu cùng kỳ nhiều năm đều lấy số nhập tay;
 *   - tháng × nhà hàng đã nhập tay thì bỏ số hệ thống của ô đó (không cộng trùng), nhà hàng khác
 *     cùng tháng vẫn giữ số hệ thống.
 *
 * Chạy trên DB local với nhà hàng PHT / PHU riêng, kỳ 2025-03 và tự dọn sạch.
 * Chạy: npm run test:pnl-history
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { getPnl } from "../lib/reports.ts";
import { getPnlMatrix, getRevenueTrendReport, getPnlHistoryEditor } from "../lib/report-budget.ts";
import { isPnlHistoryPeriod } from "../lib/pnl-history.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "PHT";
const OTHER = "PHU";
const PERIOD = "2025-03";
const OPEX_ITEM = "PNL_CP_MATBANG";
const COGS_ITEM = "COGS_BEP";

async function cleanup() {
  await prisma.pnlHistoryEntry.deleteMany({ where: { branchCode: { in: [BRANCH, OTHER] } } });
  await prisma.revenueImportRow.deleteMany({ where: { branchCode: { in: [BRANCH, OTHER] } } });
  await prisma.importBatch.deleteMany({ where: { fileName: "pnl-history-test" } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: { in: [BRANCH, OTHER] } } });
}

async function systemRevenue(branchCode, netAmount) {
  const batch = await prisma.importBatch.create({
    data: { importType: "REVENUE_POS", templateCode: "REVENUE_POS_STANDARD_V1", fileName: "pnl-history-test", uploadedBy: "test", status: "COMMITTED", totalRows: 1, validRows: 1, errorRows: 0 },
  });
  await prisma.revenueImportRow.create({
    data: {
      importBatchId: batch.id, saleDate: new Date("2025-03-15T00:00:00.000Z"), branchCode, revenueSource: "Đồ ăn", paymentMethod: "CASH",
      grossAmount: netAmount, netAmount, externalRef: `PHT-${branchCode}`,
    },
  });
}

test("số P&L nhập tay trước khi lên phần mềm", async (t) => {
  await cleanup();
  t.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  assert.equal(isPnlHistoryPeriod("2026-07"), true);
  assert.equal(isPnlHistoryPeriod("2026-08"), false);

  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "NH test số cũ", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: OTHER, name: "NH test số hệ thống", status: "ACTIVE" } });
  // Hệ thống có doanh thu cả hai nhà hàng; PHT sẽ nhập tay nên số hệ thống của PHT phải bị bỏ.
  await systemRevenue(BRANCH, 999_000);
  await systemRevenue(OTHER, 300_000);
  await prisma.pnlHistoryEntry.createMany({
    data: [
      { period: PERIOD, branchCode: BRANCH, metric: "revenue:FOOD", amount: 100_000_000 },
      { period: PERIOD, branchCode: BRANCH, metric: "revenue:DRINK", amount: 40_000_000 },
      { period: PERIOD, branchCode: BRANCH, metric: `pnlItem:${COGS_ITEM}`, amount: 45_000_000 },
      { period: PERIOD, branchCode: BRANCH, metric: `pnlItem:${OPEX_ITEM}`, amount: 20_000_000 },
    ],
  });

  const pnl = await getPnl(PERIOD, BRANCH);
  assert.equal(pnl.total.revenue, 140_000_000, "doanh thu = số nhập tay, bỏ 999.000 của hệ thống");
  assert.equal(pnl.total.cogs, 45_000_000);
  assert.equal(pnl.total.otherOpex, 20_000_000);
  assert.equal(pnl.total.netProfit, 75_000_000);

  const all = await getPnl(PERIOD, "ALL");
  assert.equal(all.total.revenue, 140_300_000, "nhà hàng chưa nhập tay vẫn giữ số hệ thống");

  const matrix = await getPnlMatrix("2025", BRANCH);
  const revenue = matrix.statement.find((line) => line.key === "revenue");
  assert.equal(revenue.months[2], 140_000_000, "bảng 12 tháng tháng 3");
  const opex = matrix.statement.find((line) => line.key === "otherOpex");
  assert.equal(opex.months[2], 20_000_000);
  assert.ok(opex.groups.some((group) => group.items.some((item) => item.code === OPEX_ITEM && item.months[2] === 20_000_000)), "lên đúng hạng mục");

  const trend = await getRevenueTrendReport("2026-03", BRANCH, 3);
  const year2025 = trend.series.find((row) => row.year === "2025");
  assert.equal(year2025.months[2], 140_000_000, "doanh thu cùng kỳ nhiều năm");

  const editor = await getPnlHistoryEditor("2026", BRANCH);
  assert.deepEqual(editor.months, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
  assert.ok(editor.lines.find((line) => line.key === "revenue").groups[0].items.length === 5, "Bếp, Bar, Phụ thu, SVC, Thuế GTGT");
  assert.ok(editor.lines.find((line) => line.key === "otherOpex").groups.some((group) => group.items.some((item) => item.metric === `pnlItem:${OPEX_ITEM}`)));
});
