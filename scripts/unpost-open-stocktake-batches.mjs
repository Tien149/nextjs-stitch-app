/**
 * Một lần (khách 30/10/2026): đợt kiểm kê theo vị trí giờ chỉ ghi -N/-X khi CHỐT giải trình. Các đợt đã
 * duyệt theo luật cũ mà giải trình chưa chốt (hoặc chưa lập) còn phiếu -N/-X ghi lúc duyệt → gỡ ra
 * (resyncStocktakeBatch chế độ thường), tính lại giá vốn kỳ đó. Đợt đã chốt giải trình, kỳ khoá: giữ nguyên.
 *
 * Xem trước:  npm run repair:unpost-open-stocktake-batches
 * Chạy thật:  npm run repair:unpost-open-stocktake-batches -- --apply
 * Đảo lại: Chốt giải trình (hoặc Mở chốt rồi Chốt) ghi lại -N/-X theo số sống.
 */
import { prisma } from "../lib/prisma.ts";
import { resyncStocktakeBatch } from "../lib/stocktake-resync.ts";
import { repostInventoryCogs } from "../lib/accounting.ts";

const apply = process.argv.includes("--apply");
const batches = await prisma.stocktakeBatch.findMany({ where: { status: "APPROVED" }, orderBy: { cutoffAt: "asc" } });
const targets = [];
for (const batch of batches) {
  const explanation = await prisma.stocktakeExplanation.findFirst({ where: { sourceType: "BATCH", sourceId: batch.id }, select: { status: true } });
  const docs = await prisma.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: batch.id, deletedAt: null }, select: { code: true } });
  const locked = explanation?.status === "LOCKED";
  console.log(`${batch.code} ${batch.warehouseCode} giải trình=${explanation?.status || "chưa lập"} phiếu=${docs.map((doc) => doc.code).join(", ") || "-"}${locked ? " → giữ (đã chốt)" : docs.length ? " → gỡ" : ""}`);
  if (locked || docs.length === 0 || !apply) continue;
  const result = await resyncStocktakeBatch(batch.id, "repair:unpost-open-stocktake-batches");
  console.log(`  ${result.skipped ? `bỏ qua: ${result.skipped}` : `đã gỡ (changed=${result.changed})`}`);
  if (result.changed) targets.push({ date: result.date, branchCode: result.branchCode });
}
if (apply && targets.length > 0) {
  const reposted = await repostInventoryCogs(targets, "repair:unpost-open-stocktake-batches");
  console.log("Tính lại giá vốn:", JSON.stringify(reposted));
}
if (!apply) console.log("\nXem trước — thêm --apply để chạy thật.");
await prisma.$disconnect();
