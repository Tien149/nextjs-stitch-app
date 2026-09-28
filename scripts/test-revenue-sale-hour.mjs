/**
 * Doanh thu POS tách theo GIỜ + rã nguyên liệu tới giờ chốt kiểm kê (khách chốt 28/09/2026):
 *   - đọc giờ bán từ cột Thời gian ("31/08/2026 10:23", serial Excel có phần lẻ) hoặc cột Giờ;
 *   - gộp món theo từng giờ, file chỉ có ngày thì gộp và ra mã tham chiếu y như cũ;
 *   - nút Rã "tới giờ H": chỉ lấy doanh thu ngày cuối bán trước H, phiếu mang đúng H:00;
 *     rã cả ngày thì phiếu mang 23:59:59.
 *
 * Phần DB chạy với cửa hàng SHT riêng, ngày năm 2031, tự dọn. Chạy: npm run test:revenue-sale-hour
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportHour } from "../lib/import-date.ts";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { generatedRevenuePosReference } from "../lib/revenue-pos-reference.ts";
import { explosionPostingDate } from "../lib/revenue-date.ts";
import { executeExplosion } from "../lib/inventory-explosion.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

test("đọc giờ bán từ nhiều kiểu ô", () => {
  assert.equal(parseImportHour("31/08/2026 10:23"), 10);
  assert.equal(parseImportHour("31/08/2026 23:59:59"), 23);
  assert.equal(parseImportHour("2026-08-31T07:05:00"), 7);
  assert.equal(parseImportHour("10:23"), 10);
  assert.equal(parseImportHour("09:15 PM"), 21);
  assert.equal(parseImportHour(46265 + 10 / 24), 10, "serial Excel 10:00 không được rơi về 9 giờ");
  assert.equal(parseImportHour(46265 + (15 * 60 + 40) / 1440), 15);
  assert.equal(parseImportHour("31/08/2026"), null, "chỉ có ngày = doanh thu cả ngày");
  assert.equal(parseImportHour(46265), null);
  assert.equal(parseImportHour(""), null);
});

test("ngày giờ phiếu rã: tới giờ H hoặc 23:59:59 ngày cuối (giờ Việt Nam)", () => {
  const day = new Date("2026-08-31T00:00:00.000Z");
  assert.equal(explosionPostingDate(day, 11).toISOString(), "2026-08-31T04:00:00.000Z");
  assert.equal(explosionPostingDate(day, null).toISOString(), "2026-08-31T16:59:59.000Z");
});

test("file chỉ có ngày ra đúng mã tham chiếu cũ; có giờ thì mỗi giờ một mã", () => {
  const base = { sale_date: new Date("2026-08-31T00:00:00Z"), branch_code: "ASA", channel: "TAI CHO", revenue_source: "REV_FOOD", payment_method: "CASH", product_code: "CF1" };
  assert.equal(generatedRevenuePosReference({ ...base, sale_hour: null }), generatedRevenuePosReference(base));
  assert.notEqual(generatedRevenuePosReference({ ...base, sale_hour: 10 }), generatedRevenuePosReference({ ...base, sale_hour: 15 }));
});

test("import POS thô: gộp món theo giờ, dòng chỉ có ngày giữ giờ trống", async () => {
  const header = ["Thời gian", "Cửa hàng", "Mã hàng", "Tên hàng", "Số lượng", "Nhóm doanh thu", "Nguồn tiền", "Doanh thu", "Tổng tiền"];
  const rows = [
    ["31/08/2026 10:05", "ASA", "CF1", "Cà phê", 1, "ĐỒ UỐNG", "CASH", 30000, 30000],
    ["31/08/2026 10:40", "ASA", "CF1", "Cà phê", 2, "ĐỒ UỐNG", "CASH", 60000, 60000],
    [46265 + (15 * 60 + 20) / 1440, "ASA", "CF1", "Cà phê", 4, "ĐỒ UỐNG", "CASH", 120000, 120000],
    ["30/08/2026", "ASA", "CF1", "Cà phê", 5, "ĐỒ UỐNG", "CASH", 150000, 150000],
  ];
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Import doanh thu");
  const file = new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "pos-gio.xlsx");
  const parsed = await parseImportFile(file, getImportTemplate("REVENUE_POS", "REVENUE_POS_RAW_V1"));
  const byHour = new Map(parsed.rows.map((row) => [`${new Date(row.values.sale_date).toISOString().slice(0, 10)}|${row.values.sale_hour}`, row.values.product_quantity]));
  assert.equal(parsed.rows.length, 3);
  assert.equal(byHour.get("2026-08-31|10"), 3, "10:05 và 10:40 gộp chung giờ 10");
  assert.equal(byHour.get("2026-08-31|15"), 4);
  assert.equal(byHour.get("2026-08-30|null"), 5);
});

// ─────────────── Rã tới giờ trên DB thật ───────────────
const BRANCH = "SHT";
const KITCHEN = "KBEP_SHT";
const DISH = "SP_SHT_MON";
const DAY = new Date("2031-03-15T00:00:00.000Z");

async function cleanup() {
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  const batches = await prisma.revenueImportRow.findMany({ where: { branchCode: BRANCH }, select: { importBatchId: true } });
  await prisma.revenueImportRow.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.importBatch.deleteMany({ where: { id: { in: [...new Set(batches.map((row) => row.importBatchId))] } } });
  const item = await prisma.inventoryItem.findUnique({ where: { code: DISH } });
  if (item) {
    await prisma.inventoryBalance.deleteMany({ where: { itemId: item.id } });
    await prisma.inventoryItem.delete({ where: { id: item.id } });
  }
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: KITCHEN } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH } });
}

test("rã tới 11:00 chỉ lấy doanh thu bán trước 11 giờ; rã cả ngày lấy phần còn lại", async (t) => {
  await cleanup();
  t.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test giờ bán", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: KITCHEN, name: "Kho bếp SHT", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  await prisma.inventoryItem.create({ data: { code: DISH, name: "Món test giờ bán", itemType: "FINISHED", unit: "PHAN" } });
  const batch = await prisma.importBatch.create({ data: { importType: "REVENUE_POS", templateCode: "REVENUE_POS_RAW_V1", fileName: "sht.xlsx", status: "COMMITTED" } });
  const row = (hour, quantity) => ({
    importBatchId: batch.id, saleDate: DAY, saleHour: hour, branchCode: BRANCH, revenueSource: "ĐỒ ĂN", paymentMethod: "CASH",
    grossAmount: quantity * 1000, netAmount: quantity * 1000, externalRef: `SHT-${hour ?? "ALL"}`, productCode: DISH, productQuantity: quantity, inventoryStatus: "PENDING",
  });
  await prisma.revenueImportRow.createMany({ data: [row(9, 1), row(10, 2), row(15, 4), row(null, 8)] });

  const settings = { branchCode: BRANCH, warehouseCode: KITCHEN, toWarehouseCode: KITCHEN, kitchenWarehouseCode: KITCHEN, barWarehouseCode: "", dateFrom: DAY, dateTo: DAY, note: "", createdBy: "test" };
  const morning = await prisma.$transaction((tx) => executeExplosion(tx, { ...settings, timeTo: 11 }), { timeout: 60000 });
  assert.equal(morning.kind, "POSTED");
  assert.equal(morning.revenueRows, 2);
  assert.equal(morning.unsplitRows, 1, "dòng không có giờ ở lại hàng chờ");
  assert.equal(morning.postedAt.toISOString(), "2031-03-15T04:00:00.000Z");
  const morningSale = morning.documents.find((doc) => doc.transactionType === "XUAT_BAN");
  assert.equal(morningSale.lines.reduce((sum, line) => sum + line.quantity, 0), 3);
  assert.ok(morning.documents.every((doc) => doc.transactionDate.getTime() === morning.postedAt.getTime()));

  const rest = await prisma.$transaction((tx) => executeExplosion(tx, settings), { timeout: 60000 });
  assert.equal(rest.revenueRows, 2);
  assert.equal(rest.postedAt.toISOString(), "2031-03-15T16:59:59.000Z");
  const restSale = rest.documents.find((doc) => doc.transactionType === "XUAT_BAN");
  assert.equal(restSale.lines.reduce((sum, line) => sum + line.quantity, 0), 12);
  const pending = await prisma.revenueImportRow.count({ where: { branchCode: BRANCH, inventoryStatus: "PENDING" } });
  assert.equal(pending, 0);
});
