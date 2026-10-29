/**
 * Combo trong file doanh thu POS (khách chốt 12/10/2026): dòng mã combo mang doanh thu và rã theo
 * định lượng combo; các dòng món con 0 đ ghi mã combo ở cột "Mã combo" thì KHÔNG vào hàng chờ rã
 * (rã cả hai là trừ kho hai lần). Cùng món bán lẻ (không có mã combo) vẫn rã như thường.
 *
 * Phần DB dùng cửa hàng HCM, ngày năm 2031 và mã hàng riêng, tự dọn.
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-revenue-combo.mjs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport } from "../lib/import-commit.ts";
import { generatedRevenuePosReference } from "../lib/revenue-pos-reference.ts";
import { prisma, prismaRaw } from "../lib/prisma.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const session = { name: "test", role: "Admin", allowedBranches: ["ALL"] };
const template = getImportTemplate("REVENUE_POS", "REVENUE_POS_RAW_V1");
const CODES = ["CBTEST_COMBO", "CBTEST_CON1", "CBTEST_CON2"];

function posFile(rows) {
  const header = ["Thời gian", "Cửa hàng", "Mã hàng", "Tên hàng", "Mã combo", "Số lượng", "Nhóm doanh thu", "Nguồn tiền", "Thành tiền", "Tổng tiền"];
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Import doanh thu");
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "pos-combo.xlsx");
}

const fileRows = [
  ["15/03/2031", "HCM", "CBTEST_COMBO", "Combo test", "", 2, "ĐỒ ĂN", "TM_HCM", 400000, 400000],
  ["15/03/2031", "HCM", "CBTEST_CON1", "Món con 1", "CBTEST_COMBO", 2, "ĐỒ ĂN", "TM_HCM", 0, 0],
  ["15/03/2031", "HCM", "CBTEST_CON2", "Món con 2", "CBTEST_COMBO", 2, "ĐỒ ĂN", "TM_HCM", 0, 0],
  // Cùng món con nhưng bán lẻ: vẫn phải rã.
  ["15/03/2031", "HCM", "CBTEST_CON1", "Món con 1", "", 1, "ĐỒ ĂN", "TM_HCM", 90000, 90000],
  // Ô Mã combo có ký tự bất kỳ, kể cả "-" (khách chốt 29/10/2026) = không rã.
  ["15/03/2031", "HCM", "CBTEST_CON2", "Món con 2", "-", 3, "ĐỒ ĂN", "TM_HCM", 120000, 120000],
];

test("mã tham chiếu: món con combo tách khỏi món bán lẻ; file không có cột combo giữ mã cũ", () => {
  const base = { sale_date: new Date("2031-03-15T00:00:00Z"), branch_code: "HCM", channel: "", revenue_source: "REV_FOOD", payment_method: "TM_HCM", product_code: "CBTEST_CON1" };
  assert.equal(generatedRevenuePosReference({ ...base, combo_code: "" }), generatedRevenuePosReference(base));
  assert.notEqual(generatedRevenuePosReference({ ...base, combo_code: "CBTEST_COMBO" }), generatedRevenuePosReference(base));
});

test("import: dòng combo chờ rã, món con có mã combo không rã, Mã combo ghi \"-\" cũng không rã, món bán lẻ vẫn rã", async () => {
  const parsed = await parseImportFile(posFile(fileRows), template);
  assert.equal(parsed.mapping.combo_code, "Mã combo");
  assert.equal(parsed.rows.length, 5, "món con trong combo không gộp với cùng món bán lẻ");
  await validateImportResult(parsed, "REVENUE_POS", session, {});
  assert.deepEqual(parsed.rows.flatMap((row) => row.errors), []);
  const batch = await commitImport({ importType: "REVENUE_POS", templateCode: template.code, fileName: "pos-combo.xlsx", uploadedBy: "test", mapping: parsed.mapping, rows: parsed.rows });
  const rows = await prisma.revenueImportRow.findMany({ where: { importBatchId: batch.id } });
  const status = rows.map((row) => `${row.productCode}|${row.productQuantity}|${row.inventoryStatus}`).sort();
  assert.deepEqual(status, [
    "CBTEST_COMBO|2|PENDING",
    "CBTEST_CON1|1|PENDING",
    "CBTEST_CON1|2|NOT_REQUIRED",
    "CBTEST_CON2|2|NOT_REQUIRED",
    "CBTEST_CON2|3|NOT_REQUIRED",
  ]);
  assert.match(rows.find((row) => row.productCode === "CBTEST_CON2").note || "", /Món con combo CBTEST_COMBO/);
});

after(async () => {
  const rows = await prismaRaw.revenueImportRow.findMany({ where: { productCode: { in: CODES } }, select: { importBatchId: true } });
  const batchIds = [...new Set(rows.map((row) => row.importBatchId))];
  await prismaRaw.journalLine.deleteMany({ where: { entry: { sourceId: { in: (await prismaRaw.revenueImportRow.findMany({ where: { importBatchId: { in: batchIds } }, select: { id: true } })).map((row) => row.id) } } } });
  await prismaRaw.journalEntry.deleteMany({ where: { sourceId: { in: (await prismaRaw.revenueImportRow.findMany({ where: { importBatchId: { in: batchIds } }, select: { id: true } })).map((row) => row.id) } } });
  await prismaRaw.revenueImportRow.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prismaRaw.importRow.deleteMany({ where: { importBatchId: { in: batchIds } } });
  await prismaRaw.importBatch.deleteMany({ where: { id: { in: batchIds } } });
  await prismaRaw.itemUnitConversion.deleteMany({ where: { item: { code: { in: CODES } } } });
  await prismaRaw.inventoryItem.deleteMany({ where: { code: { in: CODES } } });
  await prisma.$disconnect();
  await prismaRaw.$disconnect();
});
