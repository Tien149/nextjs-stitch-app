/**
 * Một lần (khách 03/11/2026): kỳ phân bổ đã "Ghi nhận" mà không có bút toán ACCRUAL. Trước bản vá nút
 * Ghi nhận chỉ đổi trạng thái, chờ Đồng bộ ghi sổ mới có bút toán — khách Bỏ ghi nhận (xoá bút toán) rồi
 * Ghi nhận lại kỳ 08, 09 là phân bổ biến mất khỏi Tổng hợp chi phí và P&L. Ghi bù đúng các kỳ thiếu, kỳ
 * khoá sổ thì postJournalEntry tự bỏ qua.
 *
 * Xem trước:  npm run repair:missing-accrual-journals
 * Chạy thật:  npm run repair:missing-accrual-journals -- --apply
 */
import { prisma } from "../lib/prisma.ts";
import { postAccrualScheduleJournals } from "../lib/accounting.ts";

const apply = process.argv.includes("--apply");
const schedules = await prisma.accrualSchedule.findMany({ where: { status: "POSTED", accrual: { deletedAt: null } }, include: { accrual: true }, orderBy: { period: "asc" } });
const posted = new Set((await prisma.journalEntry.findMany({ where: { sourceType: "ACCRUAL", sourceId: { in: schedules.map((row) => row.id) } }, select: { sourceId: true } })).map((row) => row.sourceId));
const missing = schedules.filter((row) => !posted.has(row.id));
const groups = new Map();
for (const row of missing) {
  const key = `${row.period} ${row.accrual.branchCode}`;
  const current = groups.get(key) || { count: 0, amount: 0 };
  groups.set(key, { count: current.count + 1, amount: current.amount + row.amount });
}
for (const [key, value] of groups) console.log(`${key}: ${value.count} kỳ, ${Math.round(value.amount).toLocaleString("vi-VN")} đ`);
console.log(`Tổng: ${missing.length} kỳ thiếu bút toán`);
if (apply && missing.length > 0) {
  const results = await postAccrualScheduleJournals(missing, "repair:missing-accrual-journals");
  const skipped = results.filter((result) => result === "SKIPPED_LOCKED").length;
  console.log(`Đã ghi ${results.length - skipped} bút toán${skipped ? `, bỏ qua ${skipped} kỳ đã khoá` : ""}`);
}
if (!apply) console.log("\nXem trước — thêm --apply để chạy thật.");
await prisma.$disconnect();
