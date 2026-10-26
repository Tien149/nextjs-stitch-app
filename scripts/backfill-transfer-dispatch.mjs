/**
 * Ghi phiếu CHUYỂN ĐI cho các phiếu điều chuyển đang CHỜ DUYỆT lập trước 26/10/2026 (khách chốt: phiếu
 * chờ bên nhận duyệt vẫn trừ kho xuất theo ngày giờ lên phiếu). Phiếu "Bị trả lại" không trừ — chờ bên
 * chuyển sửa & gửi lại. Kỳ đã khoá thì bỏ qua và liệt kê.
 *
 * Chạy thử (chỉ liệt kê):  node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs scripts/backfill-transfer-dispatch.mjs
 * Ghi thật:                 ... scripts/backfill-transfer-dispatch.mjs --apply
 */
import { createRequire } from "node:module";
import { dispatchTransferRequest } from "../lib/inventory-transfer-request.ts";
import { isPeriodLocked } from "../lib/phase3.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

const pending = await prisma.inventoryTransferRequest.findMany({
  where: { status: "PENDING", dispatchTransactionId: null, deletedAt: null },
  orderBy: { requestDate: "asc" },
});
console.log(`${pending.length} phiếu chờ duyệt chưa trừ kho xuất${apply ? "" : " (chạy thử — thêm --apply để ghi)"}`);
let done = 0;
for (const request of pending) {
  const label = `${request.code} ${request.warehouseCode} → ${request.toWarehouseCode} lúc ${request.requestDate.toISOString()}`;
  if (await isPeriodLocked(request.requestDate, request.branchCode)) {
    console.log(`  BỎ QUA (kỳ đã khoá): ${label}`);
    continue;
  }
  if (!apply) {
    console.log(`  sẽ trừ kho xuất: ${label}`);
    continue;
  }
  const updated = await prisma.$transaction((tx) => dispatchTransferRequest(tx, request.id), { timeout: 60000 });
  const doc = await prisma.inventoryTransaction.findUnique({ where: { id: updated.dispatchTransactionId }, select: { code: true } });
  console.log(`  đã ghi ${doc?.code}: ${label}`);
  done += 1;
}
if (apply) console.log(`Xong: ${done} phiếu.`);
await prisma.$disconnect();
