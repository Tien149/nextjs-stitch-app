/**
 * Kiểm tra applyImportRowEdits: ô sửa tay trên popup xem trước doanh thu phải được ép kiểu
 * lại theo template, chấm lỗi lại cho đúng dòng bị đụng và không làm lệch dòng khác.
 *
 * Chạy: npm run test:import-row-edits
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { applyImportRowEdits, parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const template = getImportTemplate("REVENUE_POS", "REVENUE_POS_STANDARD_V1");

function buildFile(rows) {
  const headers = template.fields.filter((field) => !field.hiddenFromMapping).map((field) => field.label);
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))], { cellDates: true });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Doanh thu");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return new File([buffer], "doanh_thu.xlsx");
}

const label = (field) => template.fields.find((item) => item.field === field).label;

test("sửa ô sai kiểu thì dòng hết lỗi, dòng khác giữ nguyên", async () => {
  const file = buildFile([
    { [label("sale_date")]: "2026-08-01", [label("branch_code")]: "HCM", [label("revenue_source")]: "THU_BANHANG", [label("channel")]: "Tại chỗ", [label("payment_method")]: "TM_HCM", [label("gross_amount")]: 1000000, [label("net_amount")]: 1100000 },
    { [label("sale_date")]: "abc", [label("branch_code")]: "HCM", [label("revenue_source")]: "THU_BANHANG", [label("channel")]: "Grab", [label("payment_method")]: "FDSGRABFOOD", [label("gross_amount")]: "x", [label("net_amount")]: 500000 },
  ]);
  const parsed = await parseImportFile(file, template);
  assert.equal(parsed.totalRows, 2);
  assert.equal(parsed.errorRows, 1);
  const broken = parsed.rows.find((row) => row.errors.length > 0);

  const fixed = applyImportRowEdits(parsed, template, [
    { sheetName: broken.sheetName, rowNumber: broken.rowNumber, values: { sale_date: "2026-08-02", gross_amount: "450.000" } },
  ]);
  assert.equal(fixed.errorRows, 0, fixed.rows.map((row) => row.errors.join("; ")).join(" | "));
  const fixedRow = fixed.rows.find((row) => row.rowNumber === broken.rowNumber);
  assert.ok(fixedRow.values.sale_date instanceof Date);
  assert.equal(fixedRow.values.sale_date.toISOString().slice(0, 10), "2026-08-02");
  assert.equal(fixedRow.values.gross_amount, 450000);
  // Cột không sửa vẫn giữ giá trị đã đọc từ file.
  assert.equal(fixedRow.values.net_amount, 500000);
  assert.equal(fixedRow.values.payment_method, "FDSGRABFOOD");
  // Dấu vết: giá trị sửa ghi vào rawValues dưới header đã map.
  assert.equal(fixedRow.rawValues[parsed.mapping.sale_date], "2026-08-02");
  // Dòng không đụng tới là cùng object cũ.
  const untouched = parsed.rows.find((row) => row.errors.length === 0);
  assert.equal(fixed.rows.find((row) => row.rowNumber === untouched.rowNumber), untouched);
});

test("xoá trắng cột bắt buộc thì báo lỗi bắt buộc, sửa sai kiểu thì báo sai kiểu", async () => {
  const file = buildFile([
    { [label("sale_date")]: "2026-08-01", [label("branch_code")]: "HCM", [label("revenue_source")]: "THU_BANHANG", [label("channel")]: "Tại chỗ", [label("payment_method")]: "TM_HCM", [label("gross_amount")]: 1000000, [label("net_amount")]: 1100000 },
  ]);
  const parsed = await parseImportFile(file, template);
  assert.equal(parsed.errorRows, 0);
  const row = parsed.rows[0];
  const edited = applyImportRowEdits(parsed, template, [
    { sheetName: row.sheetName, rowNumber: row.rowNumber, values: { branch_code: "", net_amount: "một triệu" } },
  ]);
  assert.equal(edited.errorRows, 1);
  assert.equal(edited.validRows, 0);
  const errors = edited.rows[0].errors.join("; ");
  assert.match(errors, /Cửa hàng|Chi nhánh|bắt buộc/);
  assert.match(errors, /phải là số/);
});

test("bản sửa trỏ tới dòng không tồn tại thì bỏ qua, không đổi kết quả", async () => {
  const file = buildFile([
    { [label("sale_date")]: "2026-08-01", [label("branch_code")]: "HCM", [label("revenue_source")]: "THU_BANHANG", [label("channel")]: "Tại chỗ", [label("payment_method")]: "TM_HCM", [label("gross_amount")]: 1000000, [label("net_amount")]: 1100000 },
  ]);
  const parsed = await parseImportFile(file, template);
  const edited = applyImportRowEdits(parsed, template, [{ sheetName: "Khac", rowNumber: 999, values: { gross_amount: "1" } }]);
  assert.deepEqual(edited.rows, parsed.rows);
  assert.equal(applyImportRowEdits(parsed, template, []), parsed);
});
