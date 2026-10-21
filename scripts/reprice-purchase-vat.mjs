/**
 * Đưa thuế GTGT đầu vào của phiếu nhập ĐÃ CÓ vào giá nhập kho (khách chốt 21/10/2026: giá vốn lấy
 * SAU thuế, đảo luật 21/09). Code mới (withInputVat, lib/inventory-stock.ts) đã làm cho phiếu lập /
 * sửa từ nay; script này sửa phiếu cũ một lần.
 *
 * - Dòng phiếu NHAP_* còn sống, vatAmount > 0, totalCost CHƯA gồm thuế (= tiền hàng + chi phí mua
 *   phân bổ, lệch ≤ 1 đ): totalCost += vatAmount, unitCost = totalCost ÷ SL.
 * - Giá bình quân tồn hiện tại cộng phần thuế (tồn > 0). Sau đó bấm "Tính giá vốn bình quân cả
 *   tháng" từ kỳ sớm nhất bị đổi + "Đồng bộ ghi sổ" để giá xuất / giá vốn đi theo.
 * - Bỏ qua phiếu thuộc kỳ đã khoá.
 *
 * Chạy thử: npm run repair:purchase-vat      Ghi thật: npm run repair:purchase-vat -- --apply
 */
import { prisma } from "../lib/prisma.ts";
import { isPeriodLocked } from "../lib/phase3.ts";

const apply = process.argv.includes("--apply");
const money = (value) => Math.round(value).toLocaleString("vi-VN");

try {
  const lines = await prisma.inventoryTransactionLine.findMany({
    where: { vatAmount: { gt: 0 }, transaction: { deletedAt: null, transactionType: { startsWith: "NHAP_" } } },
    select: {
      id: true, itemId: true, quantity: true, inputQuantity: true, inputUnitCost: true, unitCost: true, totalCost: true, vatAmount: true, purchaseCostShare: true,
      transaction: { select: { code: true, transactionDate: true, branchCode: true, warehouseCode: true } },
    },
  });
  const lockCache = new Map();
  const locked = async (date, branch) => {
    const key = `${date.toISOString().slice(0, 7)}|${branch}`;
    if (!lockCache.has(key)) lockCache.set(key, await isPeriodLocked(date, branch));
    return lockCache.get(key);
  };
  const todo = [];
  let alreadyIncluded = 0;
  let skippedLocked = 0;
  for (const line of lines) {
    const amount = Math.round((line.inputQuantity ?? line.quantity) * (line.inputUnitCost ?? line.unitCost));
    const withoutVat = amount + (line.purchaseCostShare || 0);
    if (Math.abs(line.totalCost - withoutVat) > 1) { alreadyIncluded += 1; continue; }
    if (await locked(line.transaction.transactionDate, line.transaction.branchCode)) { skippedLocked += 1; continue; }
    todo.push(line);
  }
  const byPeriod = new Map();
  const byBalance = new Map();
  for (const line of todo) {
    const period = new Date(line.transaction.transactionDate.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 7);
    const key = `${period}|${line.transaction.branchCode}`;
    byPeriod.set(key, (byPeriod.get(key) || 0) + line.vatAmount);
    const balanceKey = `${line.itemId}|${line.transaction.warehouseCode}`;
    byBalance.set(balanceKey, (byBalance.get(balanceKey) || 0) + line.vatAmount);
  }
  console.log(`Dòng nhập có thuế: ${lines.length} · cần cộng thuế: ${todo.length} · đã gồm thuế: ${alreadyIncluded} · kỳ khoá bỏ qua: ${skippedLocked}`);
  for (const [key, vat] of [...byPeriod].sort()) console.log(`  ${key}: +${money(vat)} đ`);

  if (!apply) {
    console.log("\nCHẠY THỬ — chưa ghi gì. Ghi thật: thêm --apply");
  } else if (todo.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const line of todo) {
        const totalCost = line.totalCost + line.vatAmount;
        await tx.inventoryTransactionLine.update({ where: { id: line.id }, data: { totalCost, unitCost: line.quantity > 0 ? totalCost / line.quantity : line.unitCost } });
      }
      for (const [key, vat] of byBalance) {
        const [itemId, warehouseCode] = key.split("|");
        const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode } } });
        if (!balance || !(balance.quantity > 0.000001)) continue;
        await tx.inventoryBalance.update({ where: { id: balance.id }, data: { averageCost: (balance.quantity * balance.averageCost + vat) / balance.quantity } });
      }
      await tx.auditLog.create({
        data: {
          module: "/inventory", action: "REPRICE_PURCHASE_VAT", entityType: "InventoryTransactionLine", actorName: "script reprice-purchase-vat",
          metadataJson: JSON.stringify({ lines: todo.length, periods: Object.fromEntries(byPeriod), lineIds: todo.map((line) => line.id) }),
        },
      });
    }, { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 });
    console.log(`\nĐÃ GHI: cộng thuế vào giá nhập ${todo.length} dòng. Tiếp theo: Tính giá vốn bình quân cả tháng từ kỳ sớm nhất ở trên + Đồng bộ ghi sổ.`);
  }
} finally {
  await prisma.$disconnect();
}
