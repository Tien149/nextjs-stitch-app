/**
 * Dòng doanh thu bị coi nhầm là "món con combo" vì ô Mã combo ghi "-" (khách 29/10/2026: SIGN005 bán
 * 21 ly T10 mà kho chỉ rã 10 — 3.545 dòng NME 25/09–25/10 mang ghi chú "Món con combo - — không rã").
 * Gỡ ghi chú đó và đưa dòng về hàng chờ rã (PENDING) như dòng bán lẻ; sau đó bấm Rã ở tab Chế biến.
 * Mã tham chiếu giữ nguyên để nạp lại file cũ vẫn nhận ra trùng. Bỏ qua dòng thuộc kỳ đã khoá.
 *
 * Chạy thử (không ghi): npm run repair:revenue-combo-placeholder
 * Ghi thật:            npm run repair:revenue-combo-placeholder -- --apply
 */
import { createRequire } from "node:module";
import { normalizeComboCode } from "../lib/import-commit.ts";
import { loadNonInventoryRevenueGroups, tracksInventory } from "../lib/revenue-source.ts";
import { isPeriodLocked } from "../lib/phase3.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const NOTE = /\s*(?:·\s*)?Món con combo (.*?) — không rã \(rã theo dòng combo\)/;

const vnMonth = (date) => new Date(date.getTime() + 7 * 3600_000).toISOString().slice(0, 7);

try {
  const rows = await prisma.revenueImportRow.findMany({
    where: { note: { contains: "Món con combo" }, inventoryStatus: "NOT_REQUIRED" },
    select: { id: true, saleDate: true, branchCode: true, note: true, productCode: true, productQuantity: true, revenueSource: true },
  });
  const nonInventoryGroups = await loadNonInventoryRevenueGroups(prisma);
  const lockCache = new Map();
  const summary = new Map();
  const updates = [];
  for (const row of rows) {
    const match = row.note?.match(NOTE);
    if (!match || normalizeComboCode(match[1])) continue; // món con combo thật (mã combo có chữ/số)
    const key = `${row.branchCode} ${vnMonth(row.saleDate)}`;
    if (!lockCache.has(key)) lockCache.set(key, await isPeriodLocked(row.saleDate, row.branchCode));
    const entry = summary.get(key) || { pending: 0, notRequired: 0, locked: 0 };
    summary.set(key, entry);
    if (lockCache.get(key)) { entry.locked += 1; continue; }
    const note = row.note.replace(NOTE, "").trim() || null;
    const pending = Boolean(row.productCode) && (row.productQuantity || 0) > 0 && tracksInventory(row.revenueSource, nonInventoryGroups);
    if (pending) entry.pending += 1; else entry.notRequired += 1;
    updates.push({ id: row.id, note, inventoryStatus: pending ? "PENDING" : "NOT_REQUIRED" });
  }
  console.table([...summary].sort().map(([key, entry]) => ({ "Cửa hàng / tháng": key, "Về chờ rã": entry.pending, "Không cần rã": entry.notRequired, "Kỳ khoá (bỏ qua)": entry.locked })));
  if (!apply) {
    console.log(`Chạy thử: ${updates.length} dòng sẽ được sửa. Thêm --apply để ghi.`);
  } else {
    for (const update of updates) {
      await prisma.revenueImportRow.update({ where: { id: update.id }, data: { note: update.note, inventoryStatus: update.inventoryStatus } });
    }
    console.log(`Đã sửa ${updates.length} dòng. Vào Kho › Chế biến bấm Rã cho các ngày này.`);
  }
} finally {
  await prisma.$disconnect();
}
