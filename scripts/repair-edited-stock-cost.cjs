/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Dò và sửa trị giá của phiếu XUẤT / ĐIỀU CHUYỂN bị hộp thoại "Sửa phiếu" làm sai đơn giá.
 *
 * Lỗi (sửa ngày 27/09/2026): hộp thoại Sửa hiện ô "Đơn giá" bằng giá vốn theo ĐVT TỒN (đ/gr)
 * nhưng đặt cạnh ĐVT nhập (chai, KG, phần...), rồi gửi con số đó lên như giá của ĐVT nhập. Máy
 * chủ chia tiếp cho hệ số quy đổi: phiếu hủy 2 chai tương ớt (1 chai = 830 gr) bấm Lưu không đổi
 * gì mà trị giá rớt từ 64.000 đ xuống 77 đ. Dấu vết để lại trên dòng phiếu:
 *   - inputUnitCost = giá cũ theo ĐVT tồn (38,55), unitCost = inputUnitCost / hệ số (0,046).
 *
 * Phiếu import có khai đơn giá theo ĐVT nhập cũng mang đúng hình dạng đó (32.000 đ/chai ->
 * 38,55 đ/gr) nên còn so với GIÁ THAM CHIẾU của mặt hàng (trung vị đơn giá nhập mua theo ĐVT
 * tồn): inputUnitCost gần giá tham chiếu -> dòng bị lỗi; gần giá tham chiếu x hệ số -> đơn giá
 * khai hợp lệ, không đụng.
 *
 * --apply chỉ sửa dòng của phiếu XUAT_*: unitCost = inputUnitCost, totalCost = SL x giá đó.
 * Phiếu xuất không đổi giá bình quân kho nên sửa dòng là đủ. Phiếu ĐIỀU CHUYỂN chỉ liệt kê: kho
 * nhận đã nhập theo giá sai, phải xem tay.
 *
 * Phần cuối liệt kê kho có giá bình quân thấp bất thường (dưới 1/5 giá tham chiếu): phiếu sai
 * mà bị sửa tiếp / xoá thì bước hoàn kho cộng trả trị giá sai vào kho, kéo giá bình quân xuống.
 *
 * Chạy thử:  node scripts/repair-edited-stock-cost.cjs
 * Ghi thật:  node scripts/repair-edited-stock-cost.cjs --apply
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes("--apply");
const money = (value) => new Intl.NumberFormat("vi-VN").format(Math.round(value || 0));
const price = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 4 }).format(value || 0);

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function main() {
  // Chỉ phiếu từng được sửa qua hộp thoại (có nhật ký UPDATE_TRANSACTION).
  const logs = await prisma.auditLog.findMany({
    where: { action: "UPDATE_TRANSACTION", entityType: "InventoryTransaction", entityId: { not: null } },
    select: { entityId: true },
  });
  const editCount = new Map();
  for (const log of logs) editCount.set(log.entityId, (editCount.get(log.entityId) || 0) + 1);
  if (editCount.size === 0) {
    console.log("Không có phiếu kho nào từng được sửa qua hộp thoại Sửa phiếu.");
    return;
  }

  const lines = await prisma.inventoryTransactionLine.findMany({
    where: {
      transactionId: { in: [...editCount.keys()] },
      conversionRate: { gt: 1.000001 },
      inputUnitCost: { gt: 0 },
      transaction: { deletedAt: null, NOT: { transactionType: { startsWith: "NHAP_" } } },
    },
    include: {
      item: { select: { id: true, code: true, name: true, unit: true } },
      transaction: { select: { id: true, code: true, transactionType: true, transactionDate: true, warehouseCode: true, toWarehouseCode: true } },
    },
  });
  const shaped = lines.filter((line) => Math.abs(line.unitCost * line.conversionRate - line.inputUnitCost) <= Math.max(0.01, line.inputUnitCost * 0.001));

  // Giá tham chiếu theo ĐVT tồn: trung vị đơn giá nhập mua; chưa nhập mua thì giá bình quân cao nhất các kho.
  const itemIds = [...new Set(shaped.map((line) => line.itemId))];
  const purchaseLines = itemIds.length ? await prisma.inventoryTransactionLine.findMany({
    where: { itemId: { in: itemIds }, unitCost: { gt: 0 }, transaction: { transactionType: "NHAP_MUA", deletedAt: null } },
    select: { itemId: true, unitCost: true },
  }) : [];
  const balances = itemIds.length ? await prisma.inventoryBalance.findMany({ where: { itemId: { in: itemIds } } }) : [];
  const reference = new Map();
  for (const itemId of itemIds) {
    const purchase = median(purchaseLines.filter((line) => line.itemId === itemId).map((line) => line.unitCost));
    const balance = Math.max(0, ...balances.filter((row) => row.itemId === itemId).map((row) => row.averageCost));
    reference.set(itemId, purchase || balance);
  }

  const bug = [];
  const legit = [];
  const unsure = [];
  for (const line of shaped) {
    const ref = reference.get(line.itemId) || 0;
    if (!ref) { unsure.push(line); continue; }
    const asBase = Math.abs(Math.log(line.inputUnitCost / ref));
    const asInput = Math.abs(Math.log(line.inputUnitCost / (ref * line.conversionRate)));
    (asBase < asInput ? bug : legit).push(line);
  }

  const describe = (line) => {
    const t = line.transaction;
    const right = line.quantity * line.inputUnitCost;
    return `${t.code} · ${t.transactionDate.toISOString().slice(0, 10)} · ${t.transactionType} · ${t.warehouseCode}${t.toWarehouseCode ? ` -> ${t.toWarehouseCode}` : ""}\n`
      + `    ${line.item.code} ${line.item.name}: ${line.inputQuantity ?? line.quantity} ${line.inputUnitCode || line.item.unit} (x${line.conversionRate} ${line.item.unit})`
      + ` | đang ghi ${price(line.unitCost)} đ/${line.item.unit} = ${money(line.totalCost)} đ`
      + ` | đúng ${price(line.inputUnitCost)} đ/${line.item.unit} = ${money(right)} đ`
      + ` | lệch ${money(right - line.totalCost)} đ | sửa ${editCount.get(t.id)} lần`;
  };

  console.log(`Phiếu đã từng sửa: ${editCount.size}. Dòng có dấu vết chia đôi hệ số: ${shaped.length}.`);
  console.log(`\n== BỊ LỖI (${bug.length} dòng) ==`);
  for (const line of bug) console.log(describe(line));
  if (legit.length) {
    console.log(`\n== Đơn giá khai theo ĐVT nhập, KHÔNG đụng (${legit.length} dòng) ==`);
    for (const line of legit) console.log(`  ${line.transaction.code} ${line.item.code}: ${price(line.inputUnitCost)} đ/${line.inputUnitCode}`);
  }
  if (unsure.length) {
    console.log(`\n== Không có giá tham chiếu, xem tay (${unsure.length} dòng) ==`);
    for (const line of unsure) console.log(describe(line));
  }

  const fixable = bug.filter((line) => line.transaction.transactionType.startsWith("XUAT_"));
  const transfers = bug.filter((line) => !line.transaction.transactionType.startsWith("XUAT_"));
  if (transfers.length) {
    console.log(`\n!! ${transfers.length} dòng ĐIỀU CHUYỂN bị lỗi: kho nhận đã nhập theo giá sai, script không tự sửa — xem tay.`);
  }
  const totalGap = fixable.reduce((sum, line) => sum + line.quantity * line.inputUnitCost - line.totalCost, 0);
  console.log(`\nSẽ sửa ${fixable.length} dòng phiếu xuất, tổng trị giá tăng ${money(totalGap)} đ.`);

  // Kho có giá bình quân thấp bất thường so với giá tham chiếu.
  const lowAverage = balances.filter((row) => {
    const ref = reference.get(row.itemId) || 0;
    return ref > 0 && row.averageCost > 0 && row.averageCost < ref / 5;
  });
  if (lowAverage.length) {
    console.log(`\n== Giá bình quân kho thấp bất thường (< 1/5 giá tham chiếu) — có thể bị kéo xuống ==`);
    for (const row of lowAverage) {
      const line = shaped.find((candidate) => candidate.itemId === row.itemId);
      console.log(`  ${row.warehouseCode} ${line ? line.item.code : row.itemId}: bình quân ${price(row.averageCost)} đ, tham chiếu ${price(reference.get(row.itemId))} đ, tồn ${row.quantity}`);
    }
    console.log("  -> khai lại giá bằng phiếu nhập điều chỉnh / kiểm kê, script không tự sửa giá bình quân.");
  }

  if (!apply) {
    console.log("\nChạy thử — chưa ghi gì. Thêm --apply để sửa các dòng phiếu xuất ở mục BỊ LỖI.");
    return;
  }
  for (const line of fixable) {
    await prisma.inventoryTransactionLine.update({
      where: { id: line.id },
      // Script dùng client thô, không qua lớp làm tròn tiền của lib/prisma.ts — tròn tay trị giá.
      data: { unitCost: line.inputUnitCost, totalCost: Math.round(line.quantity * line.inputUnitCost), inputUnitCost: null },
    });
  }
  console.log(`Đã sửa ${fixable.length} dòng.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
