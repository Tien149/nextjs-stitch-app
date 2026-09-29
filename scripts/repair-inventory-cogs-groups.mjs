/**
 * Chuyển hạng mục COGS Bếp / COGS Bar / COGS kho chung về đúng nhóm Giá vốn cùng bộ phận
 * (ensureInventoryCogsPnlItems, lib/accounting.ts). Trước 29/09/2026 cả ba bị gắn vào nhóm COGS
 * đầu tiên theo mã — VPS là COGS_BAR — nên donut Cơ cấu giá vốn ra 100% "COGS Bar".
 * Chỉ đổi nhóm của hạng mục trong danh mục, không đụng bút toán (P&L gom nhóm lúc đọc).
 * Lần Ghi sổ kỳ tiếp theo cũng tự sửa; script này để khỏi phải chờ.
 *
 * Chạy: npm run repair:inventory-cogs-groups
 */
import { prisma } from "../lib/prisma.ts";
import { ensureInventoryCogsPnlItems } from "../lib/accounting.ts";

const rawLog = console.log;
console.log = (...parts) => {
  if (typeof parts[0] === "string" && parts[0].startsWith("prisma:query")) return;
  rawLog(...parts);
};

const { created, moved } = await ensureInventoryCogsPnlItems();
if (created.length) console.log(`Tạo hạng mục: ${created.join(", ")}`);
for (const row of moved) console.log(`Chuyển ${row.code}: nhóm ${row.from || "(trống)"} -> ${row.to}`);
if (!created.length && !moved.length) console.log("Hạng mục giá vốn theo kho đã nằm đúng nhóm, không đổi gì.");
await prisma.$disconnect();
