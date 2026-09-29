/**
 * Gom các đối tác nhân viên NV-<cửa hàng>-<bộ phận> về MỘT đối tác Nhân viên chung (EMPLOYEE).
 *
 * Vì sao cần: trước commit 886ad6e (29/09/2026) import bảng lương theo bộ phận tự tạo mỗi bộ phận
 * một đối tác NV-<cửa hàng>-<bộ phận> để treo nợ lương thực nhận. Khách chốt chỉ dùng CHUNG một
 * mã (khách nhắc lại 29/09/2026: "không tạo nhiều mã đối tác của nhân viên"). Import đã sửa, nhưng
 * các đối tác và khoản nợ sinh từ những lần import trước vẫn còn nguyên.
 *
 * Script chỉ đụng đối tác NV-* do import tự tạo (ghi chú "Tự tạo khi import bảng lương theo bộ
 * phận"), không đụng mã NV-* khách tự khai. Với mỗi đối tác đó:
 *  - Đổi mã/tên đối tác sang EMPLOYEE trên công nợ, phiếu thu chi, phân bổ phiếu, sao kê, tiền
 *    cọc, phiếu kho và dòng bút toán — chỉ đổi nhãn đối tác, không đổi số tiền.
 *  - Xoá mềm đối tác NV-* (giữ chỗ mã như mọi danh mục khác).
 * Mã khoản nợ CNPT-LUONG-<kỳ>-<cửa hàng>-<bộ phận> giữ nguyên nên vẫn tách được nợ bếp với bar.
 *
 * Bỏ qua (và liệt kê ra): đối tác có công nợ hoặc phiếu thu chi rơi vào kỳ đã khoá sổ (luật chung
 * ở lib/phase3) — mở khoá kỳ rồi chạy lại.
 *
 * Chạy thử (không ghi gì):  npm run repair:payroll-employee-partner
 * Ghi thật:                 npm run repair:payroll-employee-partner -- --apply
 */
import { createRequire } from "node:module";
import { findClosedPeriod } from "../lib/phase3.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const apply = process.argv.includes("--apply");
const EMPLOYEE_PARTNER_CODE = "EMPLOYEE";
const EMPLOYEE_PARTNER_NAME = "Nhân viên";
const AUTO_NOTE = "Tự tạo khi import bảng lương theo bộ phận";

/** Bảng mang mã đối tác: [model, có cột partnerName không]. */
const PARTNER_TABLES = [
  ["debtRecord", true],
  ["financialVoucher", true],
  ["voucherAllocation", true],
  ["deposit", true],
  ["bankStatementTransaction", false],
  ["bankStatementAllocation", false],
  ["inventoryTransaction", false],
  ["journalLine", false],
];

async function main() {
  const partners = await prisma.masterDataItem.findMany({
    where: { type: "PARTNER", code: { startsWith: "NV-" }, note: AUTO_NOTE, deletedAt: null },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const target = await prisma.masterDataItem.findFirst({
    where: { type: "PARTNER", code: EMPLOYEE_PARTNER_CODE },
    select: { id: true, name: true, status: true, deletedAt: true },
  });
  if (target && (target.status !== "ACTIVE" || target.deletedAt)) {
    throw new Error(`Đối tác [${EMPLOYEE_PARTNER_CODE}] đang ngừng hoạt động/đã xoá — bật lại trước khi gom.`);
  }
  const targetName = target?.name || EMPLOYEE_PARTNER_NAME;

  const plan = [];
  const skipped = [];
  for (const partner of partners) {
    const [debts, vouchers] = await Promise.all([
      prisma.debtRecord.findMany({ where: { partnerCode: partner.code }, select: { documentDate: true, branchCode: true } }),
      prisma.financialVoucher.findMany({ where: { partnerCode: partner.code }, select: { voucherDate: true, branchCode: true } }),
    ]);
    const closed = await findClosedPeriod([
      ...debts.map((row) => ({ date: row.documentDate, branchCode: row.branchCode })),
      ...vouchers.map((row) => ({ date: row.voucherDate, branchCode: row.branchCode })),
    ], prisma);
    if (closed) {
      skipped.push({ doi_tac: partner.code, ly_do: `Có chứng từ ở kỳ đã khoá sổ ${closed.period || ""}`.trim() });
      continue;
    }
    const counts = {};
    for (const [model] of PARTNER_TABLES) counts[model] = await prisma[model].count({ where: { partnerCode: partner.code } });
    plan.push({ ...partner, counts });
  }

  console.log(`${apply ? "GHI THẬT" : "CHẠY THỬ (thêm --apply để ghi)"} — ${plan.length} đối tác NV-* gom về [${EMPLOYEE_PARTNER_CODE}] ${targetName}.`);
  if (plan.length) {
    console.table(plan.map((row) => ({
      doi_tac: row.code,
      ten: row.name,
      cong_no: row.counts.debtRecord,
      phieu_thu_chi: row.counts.financialVoucher,
      phan_bo_phieu: row.counts.voucherAllocation,
      dong_but_toan: row.counts.journalLine,
      khac: row.counts.deposit + row.counts.bankStatementTransaction + row.counts.bankStatementAllocation + row.counts.inventoryTransaction,
    })));
  }
  if (skipped.length) {
    console.log(`Bỏ qua ${skipped.length} đối tác:`);
    console.table(skipped);
  }
  if (!apply || plan.length === 0) return;

  if (!target) {
    await prisma.masterDataItem.create({
      data: { type: "PARTNER", code: EMPLOYEE_PARTNER_CODE, name: EMPLOYEE_PARTNER_NAME, partnerType: "EMPLOYEE", partnerGroup: "EXTERNAL", status: "ACTIVE", note: AUTO_NOTE },
    });
  }
  for (const partner of plan) {
    await prisma.$transaction(async (tx) => {
      for (const [model, hasName] of PARTNER_TABLES) {
        await tx[model].updateMany({
          where: { partnerCode: partner.code },
          data: hasName ? { partnerCode: EMPLOYEE_PARTNER_CODE, partnerName: targetName } : { partnerCode: EMPLOYEE_PARTNER_CODE },
        });
      }
      await tx.masterDataItem.update({
        where: { id: partner.id },
        data: { status: "INACTIVE", deletedAt: new Date(), deletedBy: "repair:payroll-employee-partner" },
      });
    });
  }
  console.log(`Đã gom ${plan.length} đối tác NV-* về [${EMPLOYEE_PARTNER_CODE}].`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
