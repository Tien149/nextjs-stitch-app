/**
 * ĐỔI ĐVT TỒN KHO của MỘT mặt hàng sang đơn vị nhỏ hơn và chuyển toàn bộ số liệu cũ theo.
 *
 * Ca khách 13/11/2026: Nước Rửa Tay VTTHBE00045 tồn theo CAN3LIT (can 3 lít) nhưng bếp ASA mua
 * chai 500ml — tỷ lệ quy đổi < 1 bị chặn (ĐVT tồn phải là đơn vị nhỏ nhất) nên ai đó khai
 * CHAI500ML = 500 → 2 phiếu nhập chai thành 5.000 và 4.500 "can", tồn ASA_KBEP lên 9.501 can.
 * Đổi ĐVT tồn sang ML: CAN3LIT = 3.000, CHAI500ML = 500 — và 500 lúc trước tình cờ đã đúng là ml.
 *
 * Luật chuyển:
 * - Dòng số liệu theo ĐVT tồn CŨ (--from-factor, vd 1 CAN3LIT = 3000 ML): số lượng × hệ số, đơn
 *   giá ÷ hệ số, thành tiền giữ nguyên.
 * - Dòng nhập theo ĐVT trong --keep-units (CHAI500ML): số lượng ĐÃ là đơn vị mới, giữ nguyên.
 * - Số gộp (tồn, sổ sách giờ chốt, giải trình, giá bình quân tháng) gồm cả hai loại:
 *   mới = cũ × hệ số − (hệ số − 1) × phần của dòng keep-units.
 * - Đợt kiểm kê đã MỞ LẠI (bỏ) không chuyển — bản giải trình cũ của chúng xoá bằng nút Xoá bản cũ.
 *
 * Giá trị (tiền) không đổi nên bút toán, giá vốn, công nợ không phải ghi lại.
 *
 * Chạy thử (không ghi):  node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs \
 *   scripts/repair-item-stock-unit.mjs --item VTTHBE00045 --unit ML --factor 3000 --keep-units CHAI500ML --add-units CHAI500ML=500
 * Ghi thật: thêm --apply
 */
import { prisma } from "../lib/prisma.ts";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const apply = args.includes("--apply");
const itemCode = valueOf("--item").toUpperCase();
const newUnit = valueOf("--unit").toUpperCase();
const F = Number(valueOf("--factor"));
const keepUnits = new Set(valueOf("--keep-units").split(",").map((code) => code.trim().toUpperCase()).filter(Boolean));
const addUnits = valueOf("--add-units").split(",").filter(Boolean).map((pair) => {
  const [code, rate] = pair.split("=");
  return { code: code.trim().toUpperCase(), rate: Number(rate) };
});
if (!itemCode || !newUnit || !(F > 1)) throw new Error("Cần --item, --unit và --factor > 1");

const fmt = (value) => Number(value).toLocaleString("vi-VN", { maximumFractionDigits: 4 });
const log = (...parts) => console.log(...parts);
const mixed = (oldValue, keepPart) => Number(oldValue) * F - (F - 1) * keepPart;
const vnStart = (period) => new Date(`${period}-01T00:00:00+07:00`);
const STOCK_FIELDS_SCALE = ["inTransfer", "inOther", "inProduction", "outSale", "outTransfer", "outWaste", "outOther", "outProduction", "outTotal"];

const item = await prisma.inventoryItem.findFirst({ where: { code: itemCode } });
if (!item) throw new Error(`Không thấy mặt hàng ${itemCode}`);
const oldUnit = item.unit.trim().toUpperCase();
if (oldUnit === newUnit) throw new Error(`${itemCode} đã tồn theo ${newUnit}`);
log(`${item.code} ${item.name}: ĐVT tồn ${oldUnit} → ${newUnit}, 1 ${oldUnit} = ${F} ${newUnit}; giữ nguyên dòng nhập theo ${[...keepUnits].join(", ") || "(không)"}`);

// ---- Dòng phiếu kho: phân loại từng dòng ----
const txLines = await prisma.inventoryTransactionLine.findMany({ where: { itemId: item.id }, include: { transaction: true } });
const lineKind = (line) => {
  const unit = (line.inputUnitCode || oldUnit).trim().toUpperCase();
  if (unit === oldUnit && Math.abs((line.conversionRate || 1) - 1) < 1e-9) return "SCALE";
  if (keepUnits.has(unit)) return "KEEP";
  throw new Error(`Dòng ${line.transaction.code} nhập theo ${unit} hệ số ${line.conversionRate} — chưa có luật chuyển, dừng.`);
};
const keepMoves = [];
for (const line of txLines) {
  if (line.transaction.deletedAt || lineKind(line) !== "KEEP") continue;
  const t = line.transaction;
  if (t.transactionType === "DIEU_CHUYEN") {
    keepMoves.push({ warehouse: t.warehouseCode, date: t.transactionDate, type: t.transactionType, qty: -line.quantity });
    if (t.toWarehouseCode) keepMoves.push({ warehouse: t.toWarehouseCode, date: t.transactionDate, type: t.transactionType, qty: line.quantity });
  } else {
    keepMoves.push({ warehouse: t.warehouseCode, date: t.transactionDate, type: t.transactionType, qty: t.transactionType.startsWith("NHAP_") ? line.quantity : -line.quantity });
  }
}
if (keepMoves.some((move) => move.type !== "NHAP_MUA")) throw new Error("Dòng giữ nguyên đơn vị có loại phiếu khác Nhập mua — chưa có luật chuyển cho giải trình, dừng.");
const keepBefore = (warehouse, date) => keepMoves.filter((m) => m.warehouse === warehouse && (!date || m.date <= date)).reduce((s, m) => s + m.qty, 0);
const keepBetween = (warehouse, from, to) => keepMoves.filter((m) => m.warehouse === warehouse && (!from || m.date > from) && m.date <= to).reduce((s, m) => s + m.qty, 0);

const ops = [];
log("\n== Dòng phiếu kho");
for (const line of txLines) {
  // Phiếu đã xoá (hoàn tác rã / gỡ chênh lệch kiểm kê) để nguyên: số trên đó trộn hai đơn vị,
  // không chuyển đúng được, và không còn tính vào tồn.
  if (line.transaction.deletedAt) continue;
  const kind = lineKind(line);
  if (kind === "KEEP") {
    log(`  giữ  ${line.transaction.code} ${line.transaction.warehouseCode} ${fmt(line.quantity)} ${line.inputUnitCode}`);
    continue;
  }
  const data = { quantity: line.quantity * F, conversionRate: F, unitCost: line.unitCost / F, inputUnitCode: line.inputUnitCode || oldUnit, inputQuantity: line.inputQuantity ?? line.quantity };
  log(`  đổi  ${line.transaction.code} ${line.transaction.warehouseCode} ${fmt(line.quantity)} → ${fmt(data.quantity)}, đơn giá ${fmt(line.unitCost)} → ${fmt(data.unitCost)}`);
  ops.push((tx) => tx.inventoryTransactionLine.update({ where: { id: line.id }, data }));
}

// ---- Số dư đầu kỳ ----
log("\n== Số dư đầu kỳ tồn kho");
const openings = await prisma.openingBalance.findMany({ where: { balanceType: "INVENTORY", objectCode: item.code } });
for (const row of openings) {
  const data = { quantity: (row.quantity || 0) * F, unitCost: row.unitCost == null ? null : row.unitCost / F };
  log(`  ${row.period} ${row.warehouseCode}: ${fmt(row.quantity)} → ${fmt(data.quantity)}`);
  ops.push((tx) => tx.openingBalance.update({ where: { id: row.id }, data }));
}

// ---- Tồn hiện tại ----
log("\n== Tồn kho hiện tại");
for (const row of await prisma.inventoryBalance.findMany({ where: { itemId: item.id } })) {
  const quantity = mixed(row.quantity, keepBefore(row.warehouseCode, null));
  const averageCost = Math.abs(quantity) > 1e-9 ? (row.quantity * row.averageCost) / quantity : row.averageCost / F;
  log(`  ${row.warehouseCode}: ${fmt(row.quantity)} → ${fmt(quantity)}, giá ${fmt(row.averageCost)} → ${fmt(averageCost)}`);
  ops.push((tx) => tx.inventoryBalance.update({ where: { id: row.id }, data: { quantity, averageCost } }));
}

// ---- Giá bình quân tháng ----
log("\n== Giá bình quân tháng");
for (const row of await prisma.inventoryMonthlyCost.findMany({ where: { itemId: item.id }, orderBy: [{ period: "asc" }, { warehouseCode: "asc" }] })) {
  const start = vnStart(row.period);
  const [year, month] = row.period.split("-").map(Number);
  const nextPeriod = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
  const end = new Date(vnStart(nextPeriod).getTime() - 1);
  const openKeep = keepBefore(row.warehouseCode, new Date(start.getTime() - 1));
  const inKeep = keepBetween(row.warehouseCode, new Date(start.getTime() - 1), end);
  const data = {
    openingQty: mixed(row.openingQty, openKeep),
    inQty: mixed(row.inQty, inKeep),
    followQty: row.followQty * F,
    outQty: row.outQty * F,
    closingQty: mixed(row.closingQty, openKeep + inKeep),
  };
  const basisQty = data.openingQty + data.inQty + data.followQty;
  data.averageCost = basisQty > 1e-9 ? (row.openingValue + row.inValue + row.followValue) / basisQty : row.averageCost / F;
  log(`  ${row.period} ${row.warehouseCode}: đầu ${fmt(row.openingQty)}→${fmt(data.openingQty)}, nhập ${fmt(row.inQty)}→${fmt(data.inQty)}, cuối ${fmt(row.closingQty)}→${fmt(data.closingQty)}, giá ${fmt(row.averageCost)}→${fmt(data.averageCost)}`);
  ops.push((tx) => tx.inventoryMonthlyCost.update({ where: { id: row.id }, data }));
}

// ---- Phiếu kiểm kê (số đếm từng phiếu) ----
log("\n== Phiếu kiểm kê");
const rateFor = (unit, stored) => {
  const code = unit.trim().toUpperCase();
  if (code === oldUnit) return F;
  if (code === newUnit) return 1;
  if (keepUnits.has(code)) return stored;
  throw new Error(`Số đếm theo ĐVT ${code} — chưa có luật chuyển, dừng.`);
};
const newActualBySessionLine = new Map();
const stocktakeLines = await prisma.stocktakeLine.findMany({ where: { itemId: item.id }, include: { stocktake: true } });
for (const line of stocktakeLines) {
  const session = line.stocktake;
  let inputs = null;
  try { inputs = line.unitInputs ? JSON.parse(line.unitInputs) : null; } catch { inputs = null; }
  let actualQuantity;
  let unitInputs = line.unitInputs;
  if (Array.isArray(inputs) && inputs.length > 0) {
    const converted = inputs.map((entry) => ({ ...entry, conversionRate: rateFor(entry.unitCode, entry.conversionRate) }));
    actualQuantity = converted.reduce((sum, entry) => sum + Number(entry.quantity || 0) * entry.conversionRate, 0);
    unitInputs = JSON.stringify(converted);
  } else {
    actualQuantity = line.actualQuantity * F;
  }
  // Phiếu theo vị trí: sổ sách nằm ở đợt duyệt gộp, số trên phiếu chỉ là số đếm.
  const systemQuantity = session.locationCode ? line.systemQuantity * F : mixed(line.systemQuantity, keepBefore(session.warehouseCode, session.stocktakeDate));
  const data = { actualQuantity, systemQuantity, varianceQuantity: actualQuantity - systemQuantity, unitInputs, unitCost: line.unitCost == null ? null : line.unitCost / F };
  newActualBySessionLine.set(line.id, actualQuantity);
  log(`  ${session.code} ${session.warehouseCode}${session.locationCode ? `/${session.locationCode}` : ""}: đếm ${fmt(line.actualQuantity)} → ${fmt(actualQuantity)}, sổ ${fmt(line.systemQuantity)} → ${fmt(systemQuantity)}`);
  ops.push((tx) => tx.stocktakeLine.update({ where: { id: line.id }, data }));
}

// ---- Đợt duyệt gộp còn hiệu lực ----
log("\n== Đợt kiểm kê duyệt gộp (chỉ đợt đang duyệt)");
const newCountedByBatch = new Map();
for (const line of await prisma.stocktakeBatchLine.findMany({ where: { itemId: item.id }, include: { batch: true } })) {
  if (line.batch.status !== "APPROVED") {
    log(`  bỏ qua ${line.batch.code} (${line.batch.status})`);
    continue;
  }
  const sessionLines = stocktakeLines.filter((row) => row.stocktake.batchId === line.batchId && !row.stocktake.deletedAt);
  const breakdown = {};
  for (const row of sessionLines) breakdown[row.stocktake.locationCode || row.stocktake.code] = (breakdown[row.stocktake.locationCode || row.stocktake.code] || 0) + newActualBySessionLine.get(row.id);
  const countedQuantity = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  const bookQuantity = mixed(line.bookQuantity, keepBefore(line.batch.warehouseCode, line.batch.cutoffAt));
  const unitCost = Math.abs(bookQuantity) > 1e-9 ? (line.unitCost * line.bookQuantity) / bookQuantity : line.unitCost / F;
  const varianceQuantity = countedQuantity - bookQuantity;
  newCountedByBatch.set(line.batchId, countedQuantity);
  log(`  ${line.batch.code} ${line.batch.warehouseCode}: sổ ${fmt(line.bookQuantity)} → ${fmt(bookQuantity)}, đếm ${fmt(line.countedQuantity)} → ${fmt(countedQuantity)}, lệch ${fmt(line.varianceQuantity)} → ${fmt(varianceQuantity)}`);
  ops.push((tx) => tx.stocktakeBatchLine.update({
    where: { id: line.id },
    data: { bookQuantity, countedQuantity, varianceQuantity, unitCost, varianceValue: varianceQuantity * unitCost, breakdownJson: JSON.stringify(breakdown) },
  }));
}

// ---- Bản giải trình (số chụp) ----
log("\n== Bản giải trình kiểm kê");
const explanations = await prisma.stocktakeExplanation.findMany({ where: { warehouseCode: { not: "" } } });
for (const explanation of explanations) {
  const lines = Array.isArray(explanation.lines) ? explanation.lines : [];
  const index = lines.findIndex((line) => line.itemId === item.id);
  if (index < 0) continue;
  // Bản của đợt đã mở lại: bản cũ chờ xoá (nút Xoá bản cũ), số đầu kỳ lấy theo lúc chụp — bỏ qua.
  if (explanation.sourceType === "BATCH" && !newCountedByBatch.has(explanation.sourceId)) {
    log(`  bỏ qua ${explanation.sourceCode} (đợt đã mở lại)`);
    continue;
  }
  const old = lines[index];
  const wh = explanation.warehouseCode;
  const openKeep = explanation.periodFrom ? keepBefore(wh, explanation.periodFrom) : 0;
  const inKeep = keepBetween(wh, explanation.periodFrom, explanation.periodTo);
  const next = { ...old, unit: newUnit };
  for (const field of STOCK_FIELDS_SCALE) next[field] = Number(old[field] || 0) * F;
  next.opening = mixed(old.opening, openKeep);
  next.inPurchase = mixed(old.inPurchase, inKeep);
  next.inTotal = mixed(old.inTotal, inKeep);
  next.closing = mixed(old.closing, openKeep + inKeep);
  const sessionLine = explanation.sourceType === "SESSION" ? stocktakeLines.find((row) => row.stocktakeId === explanation.sourceId) : null;
  next.counted = sessionLine ? newActualBySessionLine.get(sessionLine.id)
    : newCountedByBatch.has(explanation.sourceId) ? newCountedByBatch.get(explanation.sourceId)
    : Number(old.counted || 0); // đợt đã mở lại: bản cũ, giữ số đếm
  next.variance = next.counted - next.closing;
  next.unitCost = Math.abs(next.closing) > 1e-9 && Number(old.closing) ? (Number(old.unitCost || 0) * Number(old.closing)) / next.closing : Number(old.unitCost || 0) / F;
  next.varianceValue = Math.round(next.variance * next.unitCost);
  log(`  ${explanation.sourceCode} ${wh} (${explanation.status}): đầu ${fmt(old.opening)}→${fmt(next.opening)}, nhập mua ${fmt(old.inPurchase)}→${fmt(next.inPurchase)}, cuối ${fmt(old.closing)}→${fmt(next.closing)}, đếm ${fmt(old.counted)}→${fmt(next.counted)}, lệch ${fmt(old.variance)}→${fmt(next.variance)}`);
  const updated = lines.map((line, i) => (i === index ? next : line));
  ops.push((tx) => tx.stocktakeExplanation.update({ where: { id: explanation.id }, data: { lines: updated } }));
}

// ---- Đề nghị mua / đơn mua / lần nhận ----
log("\n== Đề nghị mua, đơn mua, lần nhận");
for (const line of await prisma.purchaseRequestLine.findMany({ where: { itemId: item.id } })) {
  if ((line.unitCode || oldUnit).toUpperCase() !== oldUnit || Math.abs(line.conversionRate - 1) > 1e-9) throw new Error(`Dòng đề nghị mua ${line.id} theo ${line.unitCode} hệ số ${line.conversionRate} — dừng.`);
  log(`  PR dòng ${line.id}: ${fmt(line.quantity)} → ${fmt(line.quantity * F)}`);
  ops.push((tx) => tx.purchaseRequestLine.update({ where: { id: line.id }, data: { quantity: line.quantity * F, conversionRate: F, unitCode: oldUnit, estimatedUnitCost: line.estimatedUnitCost == null ? null : line.estimatedUnitCost / F } }));
}
const poLines = await prisma.purchaseOrderLine.findMany({ where: { itemId: item.id } });
for (const line of poLines) {
  if ((line.unitCode || oldUnit).toUpperCase() !== oldUnit || Math.abs(line.conversionRate - 1) > 1e-9) throw new Error(`Dòng đơn mua ${line.id} theo ${line.unitCode} hệ số ${line.conversionRate} — dừng.`);
  log(`  PO dòng ${line.id}: đặt ${fmt(line.orderedQuantity)} → ${fmt(line.orderedQuantity * F)}, nhận ${fmt(line.receivedQuantity)} → ${fmt(line.receivedQuantity * F)}`);
  ops.push((tx) => tx.purchaseOrderLine.update({ where: { id: line.id }, data: { orderedQuantity: line.orderedQuantity * F, receivedQuantity: line.receivedQuantity * F, conversionRate: F, unitCode: oldUnit, unitCost: line.unitCost / F } }));
}
const poLineIds = new Set(poLines.map((line) => line.id));
for (const receipt of await prisma.purchaseOrderReceipt.findMany({ where: { orderId: { in: [...new Set(poLines.map((line) => line.orderId))] } } })) {
  const lines = Array.isArray(receipt.lines) ? receipt.lines : [];
  if (!lines.some((line) => poLineIds.has(line.lineId))) continue;
  const updated = lines.map((line) => (poLineIds.has(line.lineId)
    ? { ...line, quantity: Number(line.quantity) * F, ...(line.previousUnitCost != null ? { previousUnitCost: Number(line.previousUnitCost) / F } : {}) }
    : line));
  log(`  lần nhận ${receipt.id}: đổi ${lines.filter((line) => poLineIds.has(line.lineId)).length} dòng`);
  ops.push((tx) => tx.purchaseOrderReceipt.update({ where: { id: receipt.id }, data: { lines: updated } }));
}
for (const [label, model] of [["Mẫu đặt hàng", "purchaseRequestTemplateLine"], ["Bảng giá NCC", "supplierPriceListLine"], ["Báo giá NCC", "supplierQuoteLine"], ["Định lượng", "recipeLine"]]) {
  const count = await prisma[model].count({ where: { itemId: item.id } });
  if (count > 0) throw new Error(`${label} có ${count} dòng của ${itemCode} — chưa có luật chuyển, dừng.`);
}

// ---- Danh mục ĐVT ----
log("\n== Mặt hàng & ĐVT quy đổi");
log(`  ĐVT tồn ${oldUnit} → ${newUnit}; ${oldUnit} = ${F}; ${newUnit} = 1; ${addUnits.map((unit) => `${unit.code} = ${unit.rate}`).join("; ")}`);
ops.push((tx) => tx.inventoryItem.update({ where: { id: item.id }, data: { unit: newUnit } }));
const conversionUpsert = (tx, unitCode, rate) => tx.itemUnitConversion.upsert({
  where: { itemId_unitCode: { itemId: item.id, unitCode } },
  create: { itemId: item.id, unitCode, unitName: unitCode, conversionRate: rate, isDefaultPurchase: rate > 1 },
  update: { conversionRate: rate, isDefaultPurchase: rate > 1, deletedAt: null, deletedBy: null },
});
ops.push((tx) => conversionUpsert(tx, oldUnit, F));
ops.push((tx) => conversionUpsert(tx, newUnit, 1));
for (const unit of addUnits) ops.push((tx) => conversionUpsert(tx, unit.code, unit.rate));

if (!apply) {
  log(`\nChạy thử: ${ops.length} thao tác, chưa ghi gì. Thêm --apply để ghi.`);
} else {
  await prisma.$transaction(async (tx) => {
    for (const op of ops) await op(tx);
    await tx.auditLog.create({
      data: {
        actorName: "Hỗ trợ kỹ thuật (script)", module: "/inventory", action: "REPAIR_ITEM_STOCK_UNIT", entityType: "InventoryItem",
        entityId: item.id, entityCode: item.code, status: "SUCCESS",
        message: `Đổi ĐVT tồn ${oldUnit} → ${newUnit} (1 ${oldUnit} = ${F} ${newUnit}), giữ dòng ${[...keepUnits].join(", ")}`,
      },
    });
  }, { timeout: 120000 });
  log(`\nĐã ghi ${ops.length} thao tác.`);
}
await prisma.$disconnect();
