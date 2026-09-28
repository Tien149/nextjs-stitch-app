import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { payrollCatalogItemCode, resolvePnlItemCode } from "../lib/reports.ts";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";

const XLSX = createRequire(import.meta.url)("xlsx");

const catalog = [
  { code: "PNL_GV_NVL", name: "Giá vốn nguyên vật liệu", subGroup: "GV", status: "ACTIVE" },
  { code: "PNL_CP_KHAUHAO", name: "Chi phí khấu hao", subGroup: "CPBD", status: "ACTIVE" },
  { code: "PNL_CP_LUONG", name: "Chi phí lương và phụ cấp", subGroup: "CPNLD", status: "ACTIVE" },
];

test("hạng mục lương lấy từ danh mục theo tên, bỏ qua hạng mục đã ngừng", () => {
  assert.equal(payrollCatalogItemCode(catalog), "PNL_CP_LUONG");
  assert.equal(payrollCatalogItemCode(catalog.map((item) => ({ ...item, status: "INACTIVE" }))), null);
  assert.equal(payrollCatalogItemCode([]), null);
});

test("bút toán lương 6421 tự nhận hạng mục lương, không rơi vào Chưa phân loại", () => {
  const payrollLine = { pnlItemCode: null, account: { reportGroup: "PAYROLL" } };
  assert.equal(resolvePnlItemCode(payrollLine, "PNL_CP_KHAUHAO", "PNL_CP_LUONG"), "PNL_CP_LUONG");
  // Không truyền mã lương (nơi gọi cũ) thì giữ nguyên hành vi trước đây.
  assert.equal(resolvePnlItemCode(payrollLine, "PNL_CP_KHAUHAO"), null);
});

test("hạng mục khai tay trên chứng từ luôn thắng mã suy ra theo tài khoản", () => {
  const line = { pnlItemCode: "PNL_CP_MATBANG", account: { reportGroup: "PAYROLL" } };
  assert.equal(resolvePnlItemCode(line, "PNL_CP_KHAUHAO", "PNL_CP_LUONG"), "PNL_CP_MATBANG");
});

test("bút toán chi phí thường vẫn không có hạng mục nếu chưa khai", () => {
  const line = { pnlItemCode: null, account: { reportGroup: "OPEX" } };
  assert.equal(resolvePnlItemCode(line, "PNL_CP_KHAUHAO", "PNL_CP_LUONG"), null);
});

test("số lượng nhân sự nhận số lẻ (0,5 — người làm chia đôi hai bộ phận), không báo lỗi số nguyên", async () => {
  const header = ["Kỳ", "Cửa hàng", "Phòng ban", "Số lượng nhân sự", "Tổng chi phí công ty", "Lương thực nhận (VNĐ)"];
  const rows = [
    ["2026-08", "ASA", "BDM", 0.5, 13662100, 12054493],
    ["2026-08", "ASA", "APH", "1,25", 48226474, 42933219],
    ["2026-08", "ASA", "KIT", 21, 289854342, 269154807],
  ];
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Luong");
  const file = new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "luong-bo-phan.xlsx");
  const parsed = await parseImportFile(file, getImportTemplate("PAYROLL", "PAYROLL_DEPARTMENT_V1"));
  assert.deepEqual(parsed.rows.map((row) => row.values.headcount), [0.5, 1.25, 21]);
  assert.ok(parsed.rows.every((row) => !row.errors.some((error) => error.includes("số nguyên"))));
});
