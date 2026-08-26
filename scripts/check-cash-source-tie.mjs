/**
 * Kiểm tra bất biến của Báo cáo nguồn tiền: dòng TỔNG cột Thu/Chi của bảng "Biến động nguồn
 * tiền" phải bằng đúng Tổng thu/Tổng chi của hai bảng Tổng quan theo danh mục.
 *
 * Hai bên được ghi qua cùng một cửa (recordFlow trong lib/reports.ts) nên chỉ lệch khi có
 * khoản thu/chi không tra được nguồn tiền. Chạy trên dữ liệu thật:
 *   npm run check:cash-source-tie -- 2026-08
 */
import { getCashSourceReport } from "../lib/reports.ts";
import { PrismaClient } from "@prisma/custom-client";

const period = process.argv[2] || new Date().toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(period)) {
  console.error("Kỳ báo cáo phải có dạng YYYY-MM, ví dụ 2026-08");
  process.exit(1);
}

const prisma = new PrismaClient();
const branches = [...new Set((await prisma.masterDataItem.findMany({
  where: { type: "MONEY_SOURCE" }, select: { branch: true },
})).map((row) => row.branch).filter((branch) => branch && branch !== "ALL"))];
await prisma.$disconnect();

const money = (value) => Math.round(value).toLocaleString("vi-VN").padStart(18);
let failed = 0;
for (const branchCode of ["ALL", ...branches]) {
  const report = await getCashSourceReport([period], branchCode);
  const sourceIn = report.sources.reduce((sum, row) => sum + row.in, 0);
  const sourceOut = report.sources.reduce((sum, row) => sum + row.out, 0);
  const gapIn = Math.round(report.totals.in - sourceIn);
  const gapOut = Math.round(report.totals.out - sourceOut);
  const ok = gapIn === 0 && gapOut === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? "✔" : "✘"} ${String(branchCode).padEnd(8)} thu ${money(report.totals.in)} / nguồn ${money(sourceIn)}`
    + `   chi ${money(report.totals.out)} / nguồn ${money(sourceOut)}`
    + (ok ? "" : `   LỆCH thu ${money(gapIn)} chi ${money(gapOut)}`));
}
console.log(failed === 0 ? `\nKỳ ${period}: tất cả phạm vi đều khớp.` : `\nKỳ ${period}: ${failed} phạm vi còn lệch.`);
process.exit(failed === 0 ? 0 : 1);
