/**
 * SỬA MỘT LẦN dữ liệu cũ: các file "T9.2026 2 - Copy", "THANG 10 1", "THANG 10 2 (20-25)" của NME ghi
 * "-" ở ô Mã combo trên cả dòng bán lẻ (khách 29/10/2026: SODR001, BEER015, SIGN005… là món bán chính,
 * không phải combo). Luật import KHÔNG đổi — ô Mã combo có ký tự bất kỳ (kể cả "-") vẫn là không rã;
 * script này chỉ gỡ ghi chú "Món con combo - — không rã" của các dòng đã nạp và đưa về hàng chờ rã
 * (PENDING); sau đó bấm Rã ở tab Chế biến. Món con combo thật mang mã có chữ/số nên không bị đụng.
 * Mã tham chiếu giữ nguyên để nạp lại file cũ vẫn nhận ra trùng. Bỏ qua dòng thuộc kỳ đã khoá.
 *
 * Chạy thử (không ghi): npm run repair:revenue-combo-placeholder [-- --from 2026-10-01]
 * Ghi thật:            npm run repair:revenue-combo-placeholder -- --apply [--from 2026-10-01]
 *   → lưu bản sao trạng thái cũ vào backups/repair-combo-<giờ>.json trước khi ghi.
 * Hoàn tác:            npm run repair:revenue-combo-placeholder -- --rollback backups/repair-combo-<giờ>.json
 *   → dòng còn CHỜ RÃ trả về như cũ; dòng đã rã thì liệt kê lần rã — hoàn tác lần rã đó ở tab Chế
 *     biến trước rồi chạy lại lệnh này.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadNonInventoryRevenueGroups, tracksInventory } from "../lib/revenue-source.ts";
import { isPeriodLocked } from "../lib/phase3.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const argValue = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; };
const from = argValue("--from");
const rollbackFile = argValue("--rollback");
const NOTE = /\s*(?:·\s*)?Món con combo (.*?) — không rã \(rã theo dòng combo\)/;

const vnMonth = (date) => new Date(date.getTime() + 7 * 3600_000).toISOString().slice(0, 7);

async function rollback(file) {
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const current = new Map((await prisma.revenueImportRow.findMany({
    where: { id: { in: saved.map((row) => row.id) } },
    select: { id: true, inventoryStatus: true },
  })).map((row) => [row.id, row.inventoryStatus]));
  let restored = 0;
  const exploded = new Map();
  for (const row of saved) {
    const status = current.get(row.id);
    if (status === undefined) continue; // dòng đã bị xoá
    if (String(status).startsWith("POSTED")) {
      const run = String(status).replace(/^POSTED:?/, "");
      exploded.set(run, (exploded.get(run) || 0) + 1);
      continue;
    }
    await prisma.revenueImportRow.update({ where: { id: row.id }, data: { note: row.note, inventoryStatus: row.inventoryStatus } });
    restored += 1;
  }
  console.log(`Đã trả ${restored}/${saved.length} dòng về như trước khi sửa.`);
  if (exploded.size > 0) {
    console.log("Còn dòng đã rã — hoàn tác các lần rã này ở Kho › Chế biến rồi chạy lại lệnh hoàn tác:");
    console.table([...exploded].map(([run, count]) => ({ "Lần rã": run, "Số dòng": count })));
  }
}

try {
  if (rollbackFile) {
    await rollback(rollbackFile);
    process.exit(0);
  }
  const rows = await prisma.revenueImportRow.findMany({
    where: {
      note: { contains: "Món con combo" }, inventoryStatus: "NOT_REQUIRED",
      ...(from ? { saleDate: { gte: new Date(`${from}T00:00:00+07:00`) } } : {}),
    },
    select: { id: true, saleDate: true, branchCode: true, note: true, productCode: true, productQuantity: true, revenueSource: true },
  });
  const nonInventoryGroups = await loadNonInventoryRevenueGroups(prisma);
  const lockCache = new Map();
  const summary = new Map();
  const updates = [];
  for (const row of rows) {
    const match = row.note?.match(NOTE);
    if (!match || /[\p{L}\p{N}]/u.test(match[1])) continue; // món con combo thật (mã combo có chữ/số)
    const key = `${row.branchCode} ${vnMonth(row.saleDate)}`;
    if (!lockCache.has(key)) lockCache.set(key, await isPeriodLocked(row.saleDate, row.branchCode));
    const entry = summary.get(key) || { pending: 0, notRequired: 0, locked: 0 };
    summary.set(key, entry);
    if (lockCache.get(key)) { entry.locked += 1; continue; }
    const note = row.note.replace(NOTE, "").trim() || null;
    const pending = Boolean(row.productCode) && (row.productQuantity || 0) > 0 && tracksInventory(row.revenueSource, nonInventoryGroups);
    if (pending) entry.pending += 1; else entry.notRequired += 1;
    updates.push({ id: row.id, note, inventoryStatus: pending ? "PENDING" : "NOT_REQUIRED", before: { id: row.id, note: row.note, inventoryStatus: "NOT_REQUIRED" } });
  }
  console.table([...summary].sort().map(([key, entry]) => ({ "Cửa hàng / tháng": key, "Về chờ rã": entry.pending, "Không cần rã": entry.notRequired, "Kỳ khoá (bỏ qua)": entry.locked })));
  if (!apply) {
    console.log(`Chạy thử: ${updates.length} dòng sẽ được sửa. Thêm --apply để ghi.`);
  } else {
    mkdirSync("backups", { recursive: true });
    const backup = `backups/repair-combo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(backup, JSON.stringify(updates.map((update) => update.before)));
    console.log(`Bản sao trạng thái cũ: ${backup}`);
    for (const update of updates) {
      await prisma.revenueImportRow.update({ where: { id: update.id }, data: { note: update.note, inventoryStatus: update.inventoryStatus } });
    }
    console.log(`Đã sửa ${updates.length} dòng. Vào Kho › Chế biến bấm Rã cho các ngày này. Hoàn tác: --rollback ${backup}`);
  }
} finally {
  await prisma.$disconnect();
}
