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
  // Tham số thứ 3 là hàm bộ phận -> hạng mục lương (createPayrollItemResolver).
  assert.equal(resolvePnlItemCode(payrollLine, "PNL_CP_KHAUHAO", () => "PNL_CP_LUONG"), "PNL_CP_LUONG");
  // Không truyền mã lương (nơi gọi cũ) thì giữ nguyên hành vi trước đây.
  assert.equal(resolvePnlItemCode(payrollLine, "PNL_CP_KHAUHAO"), null);
});

test("hạng mục khai tay trên chứng từ luôn thắng mã suy ra theo tài khoản", () => {
  const line = { pnlItemCode: "PNL_CP_MATBANG", account: { reportGroup: "PAYROLL" } };
  assert.equal(resolvePnlItemCode(line, "PNL_CP_KHAUHAO", () => "PNL_CP_LUONG"), "PNL_CP_MATBANG");
});

test("bút toán chi phí thường vẫn không có hạng mục nếu chưa khai", () => {
  const line = { pnlItemCode: null, account: { reportGroup: "OPEX" } };
  assert.equal(resolvePnlItemCode(line, "PNL_CP_KHAUHAO", () => "PNL_CP_LUONG"), null);
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

// ─────────────── Import thật vào DB: công nợ + chi phí (khách chốt 28/09/2026) ───────────────
test("import lương theo bộ phận: nợ lương về đối tác EMPLOYEE, nợ BHXH VE00117 = hai cột bảo hiểm, chi phí lấy cột Tổng chi phí công ty", async () => {
  const { validateImportResult } = await import("../lib/import-validation.ts");
  const { commitImport, rollbackImportBatch } = await import("../lib/import-commit.ts");
  const { prisma } = await import("../lib/prisma.ts");
  const session = { name: "test-payroll-department", role: "Admin", allowedBranches: ["ALL"] };
  const template = getImportTemplate("PAYROLL", "PAYROLL_DEPARTMENT_V1");
  const header = ["Kỳ lương", "Cửa hàng", "Phòng ban", "Số lượng nhân sự", "Bảo hiểm (công ty chịu)", "Bảo hiểm bắt buộc", "TỔNG CHI PHÍ CÔNG TY", "LƯƠNG THỰC NHẬN (VNĐ)"];
  const rows = [
    ["2031-03", "HCM", "BEP", 2.5, 3000000, 1000000, 30000000, 25000000],
    // Tổng trong file lệch hẳn tổng các cột con: vẫn lấy đúng số trong file.
    ["2031-03", "HCM", "BAR", 1, 500000, 200000, 9000000, 8000000],
  ];
  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Luong");
  const file = new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "test-luong-bo-phan-cong-no.xlsx");
  const parsed = await parseImportFile(file, template);
  await validateImportResult(parsed, "PAYROLL", session, {});
  assert.deepEqual(parsed.rows.flatMap((row) => row.errors), []);
  const batch = await commitImport({ importType: "PAYROLL", templateCode: template.code, fileName: file.name, uploadedBy: session.name, mapping: parsed.mapping, rows: parsed.rows });
  try {
    const payroll = await prisma.payrollDepartmentRow.findMany({ where: { importBatchId: batch.id }, orderBy: { departmentCode: "asc" } });
    assert.deepEqual(payroll.map((row) => [row.departmentCode, row.totalCompanyCost]), [["BAR", 9000000], ["BEP", 30000000]]);
    const debts = await prisma.debtRecord.findMany({ where: { importBatchId: batch.id }, orderBy: { code: "asc" } });
    const byCode = new Map(debts.map((debt) => [debt.code, debt]));
    assert.equal(byCode.get("CNPT-LUONG-203103-HCM-BEP").partnerCode, "EMPLOYEE");
    assert.equal(byCode.get("CNPT-LUONG-203103-HCM-BEP").originalAmount, 25000000);
    assert.equal(byCode.get("CNPT-BHXH-203103-HCM-BEP").partnerCode, "VE00117");
    assert.equal(byCode.get("CNPT-BHXH-203103-HCM-BEP").originalAmount, 4000000);
    assert.equal(byCode.get("CNPT-LUONG-203103-HCM-BAR").partnerCode, "EMPLOYEE");
    assert.equal(byCode.get("CNPT-BHXH-203103-HCM-BAR").originalAmount, 700000);
    assert.ok(debts.every((debt) => debt.debtType === "PAYABLE" && debt.status === "OPEN" && !debt.recognizeExpense), "nợ lương chỉ là vế phải trả, chi phí đã lên từ Tổng chi phí công ty");
  } finally {
    await rollbackImportBatch({ batchId: batch.id, actor: session.name, note: "dọn test" });
    await prisma.$disconnect();
  }
});
