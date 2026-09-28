/**
 * Quy mã phòng ban của lương ĐÃ IMPORT về mã danh mục DEPARTMENT.
 *
 * Vì sao cần: trước 28/09/2026 import bảng lương lưu nguyên chữ ô "Phòng ban" ("Team Bar",
 * "bar") thay vì mã danh mục. Import đã vá (lib/import-validation.ts) và biểu đồ lương đã tự quy
 * lúc đọc (lib/report-budget.ts), nhưng dữ liệu cũ trong sổ vẫn mang chữ sai: P&L / Tổng hợp chi
 * phí theo bộ phận vẫn tách nó thành một bộ phận lạ. Script này sửa tại chỗ, giữ nguyên id.
 *
 * Sửa đồng thời để không lệch nhau:
 *  - PayrollImportRow.departmentCode (mẫu lương theo nhân viên) + dòng bút toán PAYROLL của nó.
 *  - PayrollDepartmentRow.departmentCode (mẫu theo bộ phận) + dòng bút toán PAYROLL_DEPARTMENT.
 * KHÔNG đổi mã công nợ (CNPT-LUONG-...-<phòng ban>) và mã đối tác NV-<cửa hàng>-<phòng ban>: đó là
 * mã định danh chứng từ, công nợ không có cột phòng ban nên báo cáo không đọc chỗ đó.
 *
 * Bỏ qua (và liệt kê ra):
 *  - Kỳ đã khoá sổ (luật chung ở lib/phase3).
 *  - Chữ không khớp mã/tên bộ phận nào — cần khai thêm bộ phận hoặc sửa tay.
 *  - Mẫu theo bộ phận mà kỳ + cửa hàng đó đã có sẵn một dòng mang đúng mã (trùng khoá) — phải gộp tay.
 *
 * Chạy thử (không ghi gì):  npm run repair:payroll-department
 * Ghi thật:                 npm run repair:payroll-department -- --apply
 */
import { createRequire } from "node:module";
import { createDepartmentResolver } from "../lib/department-resolve.ts";
import { findClosedPeriod } from "../lib/phase3.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");

async function main() {
  const departments = await prisma.masterDataItem.findMany({
    where: { type: "DEPARTMENT", status: "ACTIVE", deletedAt: null },
    select: { code: true, name: true },
  });
  const resolve = createDepartmentResolver(departments);
  const masterCodes = new Set(departments.map((item) => item.code));

  const [employeeRows, departmentRows] = await Promise.all([
    prisma.payrollImportRow.findMany({
      where: { deletedAt: null, departmentCode: { not: "" }, NOT: { departmentCode: { in: [...masterCodes] } } },
      select: { id: true, period: true, branchCode: true, departmentCode: true, employeeCode: true },
    }),
    prisma.payrollDepartmentRow.findMany({
      where: { deletedAt: null, NOT: { departmentCode: { in: [...masterCodes] } } },
      select: { id: true, period: true, branchCode: true, departmentCode: true },
    }),
  ]);

  const plan = [];
  const skipped = [];
  const candidates = [
    ...employeeRows.map((row) => ({ ...row, kind: "EMPLOYEE", sourceType: "PAYROLL", label: `NV ${row.employeeCode}` })),
    ...departmentRows.map((row) => ({ ...row, kind: "DEPARTMENT", sourceType: "PAYROLL_DEPARTMENT", label: "Theo bộ phận" })),
  ];
  for (const row of candidates) {
    const base = { kind: row.label, period: row.period, branch: row.branchCode, from: row.departmentCode };
    const target = resolve(row.departmentCode);
    if (!target) { skipped.push({ ...base, reason: "Không khớp mã/tên bộ phận nào" }); continue; }
    if (target === row.departmentCode) continue;
    if (await findClosedPeriod({ period: row.period, branchCode: row.branchCode }, prisma)) {
      skipped.push({ ...base, to: target, reason: "Kỳ đã khoá sổ" });
      continue;
    }
    if (row.kind === "DEPARTMENT") {
      // Khoá (kỳ, cửa hàng, phòng ban) tính cả dòng đã xoá mềm.
      const clash = await prisma.payrollDepartmentRow.findFirst({
        where: { period: row.period, branchCode: row.branchCode, departmentCode: target, NOT: { id: row.id } },
        select: { id: true },
      });
      if (clash) { skipped.push({ ...base, to: target, reason: "Kỳ + cửa hàng đã có dòng mang đúng mã — gộp tay" }); continue; }
    }
    plan.push({ ...row, target });
  }

  // Dòng bút toán đi theo từng dòng lương (sourceType + sourceId) và đang mang đúng chữ cũ.
  let journalLines = 0;
  for (const row of plan) {
    row.journalLines = await prisma.journalLine.count({
      where: { departmentCode: row.departmentCode, entry: { sourceType: row.sourceType, sourceId: row.id } },
    });
    journalLines += row.journalLines;
  }

  console.log(`${apply ? "GHI THẬT" : "CHẠY THỬ (thêm --apply để ghi)"} — ${plan.length} dòng lương cần quy mã, ${journalLines} dòng bút toán đi kèm.`);
  if (plan.length) {
    console.table(plan.map((row) => ({ loai: row.label, ky: row.period, cua_hang: row.branchCode, tu: row.departmentCode, thanh: row.target, dong_but_toan: row.journalLines })));
  }
  if (skipped.length) {
    console.log(`Bỏ qua ${skipped.length} dòng:`);
    console.table(skipped);
  }
  if (!apply || plan.length === 0) return;

  for (const row of plan) {
    await prisma.$transaction(async (tx) => {
      if (row.kind === "EMPLOYEE") await tx.payrollImportRow.update({ where: { id: row.id }, data: { departmentCode: row.target } });
      else await tx.payrollDepartmentRow.update({ where: { id: row.id }, data: { departmentCode: row.target } });
      await tx.journalLine.updateMany({
        where: { departmentCode: row.departmentCode, entry: { sourceType: row.sourceType, sourceId: row.id } },
        data: { departmentCode: row.target },
      });
    });
  }
  console.log(`Đã quy mã ${plan.length} dòng lương.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
