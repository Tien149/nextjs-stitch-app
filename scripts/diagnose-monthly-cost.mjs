/**
 * CHẠY THỬ tính giá vốn bình quân cả tháng theo từng kho (lib/inventory-monthly-cost.ts, khách
 * chốt 13/10/2026) trên dữ liệu thật — CHỈ ĐỌC, không ghi gì. In tổng hợp và xuất file Excel so
 * sánh giá vốn / tồn kho hiện tại (bình quân liên hoàn theo thứ tự nhập liệu) với sau khi tính lại.
 *
 * Chạy:  npm run diagnose:monthly-cost
 *        npm run diagnose:monthly-cost -- --out /tmp/so-sanh-gia-von.xlsx
 */
import * as XLSX from "xlsx";
import { prisma } from "../lib/prisma.ts";
import { computeMonthlyCosts } from "../lib/inventory-monthly-cost.ts";
import {
  COGS_STOCK_TYPES,
  INVENTORY_COGS_PNL_ITEMS,
  INVENTORY_COGS_START_PERIOD,
  PACKAGING_EXPENSE_PNL_ITEM,
  UNIFORM_EXPENSE_PNL_ITEM,
  planInventoryCogsJournal,
} from "../lib/inventory-cogs.ts";

const rawLog = console.log;
console.log = (...parts) => {
  if (typeof parts[0] === "string" && parts[0].startsWith("prisma:query")) return;
  rawLog(...parts);
};

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
};
const outPath = valueOf("--out", "so-sanh-gia-von-binh-quan-thang.xlsx");
const vnd = (value) => Math.round(Number(value) || 0);
const money = (value) => vnd(value).toLocaleString("vi-VN");
const PNL_LABELS = new Map([
  [INVENTORY_COGS_PNL_ITEMS.KITCHEN.code, INVENTORY_COGS_PNL_ITEMS.KITCHEN.name],
  [INVENTORY_COGS_PNL_ITEMS.BAR.code, INVENTORY_COGS_PNL_ITEMS.BAR.name],
  [INVENTORY_COGS_PNL_ITEMS.OTHER.code, "COGS kho chung"],
  [PACKAGING_EXPENSE_PNL_ITEM.code, PACKAGING_EXPENSE_PNL_ITEM.name],
  [UNIFORM_EXPENSE_PNL_ITEM.code, UNIFORM_EXPENSE_PNL_ITEM.name],
]);
const SOURCE_LABELS = {
  AVERAGE: "Bình quân tháng",
  OPENING: "Tồn đầu (tháng không nhập)",
  INBOUND: "Giá nhập trong tháng (tồn đầu ≤ 0)",
  PREVIOUS: "Giá tháng trước của kho",
  OTHER_WAREHOUSE: "Giá tháng kho khác cùng mã",
  LATEST_PURCHASE: "Giá nhập mua gần nhất",
  NONE: "Chưa có giá",
};

try {
  const [documents, items, openingRows, warehouses] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { deletedAt: null },
      select: {
        id: true, code: true, transactionType: true, transactionDate: true, branchCode: true, warehouseCode: true, toWarehouseCode: true,
        lines: { select: { id: true, itemId: true, quantity: true, unitCost: true, totalCost: true, inputUnitCost: true } },
      },
    }),
    prisma.inventoryItem.findMany({ select: { id: true, code: true, name: true, itemType: true, unit: true } }),
    prisma.openingBalance.findMany({
      where: { balanceType: "INVENTORY", deletedAt: null, status: { in: ["CONFIRMED", "POSTED"] }, warehouseCode: { not: null } },
      select: { period: true, objectCode: true, warehouseCode: true, quantity: true, amount: true },
    }),
    prisma.masterDataItem.findMany({ where: { type: "WAREHOUSE" }, select: { code: true, name: true, group: true, branch: true } }),
  ]);

  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemByCode = new Map(items.map((item) => [item.code.toUpperCase(), item]));
  const warehouseByCode = new Map(warehouses.map((warehouse) => [warehouse.code, warehouse]));
  const openingPeriod = openingRows.map((row) => row.period).sort()[0] || INVENTORY_COGS_START_PERIOD;
  const opening = [];
  let openingMissing = 0;
  for (const row of openingRows) {
    const item = itemByCode.get(String(row.objectCode || "").toUpperCase());
    if (!item) { openingMissing += 1; continue; }
    opening.push({ itemId: item.id, warehouseCode: row.warehouseCode, quantity: Number(row.quantity) || 0, value: Number(row.amount) || 0 });
  }

  const started = Date.now();
  const result = computeMonthlyCosts({ items, opening, openingPeriod, documents });
  const elapsed = Date.now() - started;
  const newLine = new Map(result.lines.map((row) => [row.lineId, row]));

  // ---- Giá vốn P&L theo tháng × nhà hàng × hạng mục (cùng luật postInventoryCogs, chưa tính lịch phân bổ đồng phục).
  const cogs = new Map();
  const addCogs = (period, branchCode, label, before, after) => {
    const key = `${period}|${branchCode}|${label}`;
    const row = cogs.get(key) || { period, branchCode, label, before: 0, after: 0, fromZero: 0 };
    row.before += before;
    row.after += after;
    cogs.set(key, row);
  };
  const cogsOf = (doc, totals) => {
    const lines = planInventoryCogsJournal({
      transactionType: doc.transactionType,
      warehouseGroup: warehouseByCode.get(doc.warehouseCode)?.group,
      lines: doc.lines.map((line) => ({ totalCost: totals(line), itemType: itemById.get(line.itemId)?.itemType })),
    });
    const out = new Map();
    for (const line of lines) {
      if (line.accountCode === "152") continue;
      const label = PNL_LABELS.get(line.pnlItemCode || "") || line.pnlItemCode || line.accountCode;
      out.set(label, (out.get(label) || 0) + (line.debit || 0) - (line.credit || 0));
    }
    return out;
  };
  const zeroLines = new Map();
  for (const doc of documents) {
    const period = newLine.get(doc.lines[0]?.id)?.period;
    if (!period) continue;
    if (doc.transactionType.startsWith("XUAT_")) {
      const stat = zeroLines.get(period) || { before: 0, after: 0, total: 0 };
      for (const line of doc.lines) {
        stat.total += 1;
        if (!(line.totalCost > 0)) stat.before += 1;
        if (!((newLine.get(line.id)?.totalCost || 0) > 0)) stat.after += 1;
      }
      zeroLines.set(period, stat);
    }
    if (!COGS_STOCK_TYPES.includes(doc.transactionType)) continue;
    const before = cogsOf(doc, (line) => line.totalCost);
    const after = cogsOf(doc, (line) => newLine.get(line.id)?.totalCost || 0);
    // Phần tăng do dòng trước đây 0 đ (xuất âm chưa có giá) nay có giá.
    const zeroPart = cogsOf(doc, (line) => (line.totalCost > 0 ? 0 : newLine.get(line.id)?.totalCost || 0));
    for (const label of new Set([...before.keys(), ...after.keys()])) addCogs(period, doc.branchCode, label, before.get(label) || 0, after.get(label) || 0);
    for (const [label, value] of zeroPart) cogs.get(`${period}|${doc.branchCode}|${label}`).fromZero += value;
  }
  const cogsRows = [...cogs.values()].sort((a, b) => a.period.localeCompare(b.period) || a.branchCode.localeCompare(b.branchCode) || a.label.localeCompare(b.label));

  // ---- Tồn kho cuối tháng theo kho: hiện tại (cộng dồn trị giá các phiếu như báo cáo tồn) vs sau tính lại.
  const beforeFlow = new Map();
  const addFlow = (period, warehouseCode, value) => {
    const key = `${period}|${warehouseCode}`;
    beforeFlow.set(key, (beforeFlow.get(key) || 0) + value);
  };
  for (const doc of documents) {
    const period = newLine.get(doc.lines[0]?.id)?.period;
    if (!period) continue;
    for (const line of doc.lines) {
      if (doc.transactionType === "DIEU_CHUYEN" && doc.toWarehouseCode) {
        addFlow(period, doc.warehouseCode, -line.totalCost);
        addFlow(period, doc.toWarehouseCode, line.totalCost);
      } else addFlow(period, doc.warehouseCode, doc.transactionType.startsWith("NHAP_") ? line.totalCost : -line.totalCost);
    }
  }
  const warehouseCodes = [...new Set(result.keys.map((key) => key.warehouseCode))].sort();
  const stockRows = [];
  for (const warehouseCode of warehouseCodes) {
    let before = opening.filter((row) => row.warehouseCode === warehouseCode).reduce((sum, row) => sum + row.value, 0);
    for (const period of result.periods) {
      before += beforeFlow.get(`${period}|${warehouseCode}`) || 0;
      const after = result.keys.filter((key) => key.period === period && key.warehouseCode === warehouseCode).reduce((sum, key) => sum + key.closingValue, 0);
      stockRows.push({ period, warehouseCode, branch: warehouseByCode.get(warehouseCode)?.branch || "", before, after });
    }
  }

  // ---- In ra màn hình.
  console.log(`Tính giá bình quân tháng: ${documents.length} phiếu, ${result.lines.length} dòng, ${opening.length} dòng tồn đầu kỳ ${openingPeriod}${openingMissing ? ` (${openingMissing} dòng đầu kỳ không khớp mã hàng)` : ""} — ${elapsed} ms.`);
  console.log(`Số vòng lặp theo tháng: ${Object.entries(result.iterations).map(([period, count]) => `${period}: ${count}`).join(", ")}`);
  for (const row of result.unconverged) console.log(`  CHƯA HỘI TỤ ${row.period} ${itemById.get(row.itemId)?.code} @ ${row.warehouseCode}: giá ${money(row.averageCost)}, vòng cuối đổi ${row.change.toFixed(4)}`);
  console.log("\nGiá vốn / chi phí theo kho (hiện tại → sau tính lại):");
  for (const row of cogsRows) console.log(`  ${row.period} ${row.branchCode} ${row.label}: ${money(row.before)} → ${money(row.after)} (${row.after - row.before >= 0 ? "+" : ""}${money(row.after - row.before)})`);
  console.log("\nDòng xuất 0 đ (hiện tại → sau tính lại):");
  for (const [period, stat] of [...zeroLines].sort()) console.log(`  ${period}: ${stat.before} → ${stat.after} / ${stat.total} dòng xuất`);
  const reval = result.keys.reduce((sum, key) => sum + key.revaluation, 0);
  const residual = result.keys.reduce((sum, key) => sum + key.residual, 0);
  console.log(`\nĐịnh giá lại tồn đầu âm: ${money(reval)} · trị giá lẻ khi tồn về 0: ${money(residual)}`);

  // ---- Excel.
  const book = XLSX.utils.book_new();
  const sheet = (name, header, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws["!cols"] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(book, ws, name);
  };
  sheet("Ghi chu", ["Nội dung"], [
    ["SO SÁNH GIÁ VỐN: HIỆN TẠI (bình quân liên hoàn theo thứ tự nhập liệu) vs BÌNH QUÂN CẢ THÁNG THEO TỪNG KHO — CHẠY THỬ, CHƯA GHI GÌ"],
    [`Dữ liệu lúc chạy: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · ${documents.length} phiếu kho · tồn đầu kỳ ${openingPeriod}`],
    ["Giá tháng (mã × kho) = (Trị giá tồn đầu + Trị giá nhập) ÷ (SL tồn đầu + SL nhập). Mọi phiếu xuất trong tháng lấy giá này, không phụ thuộc thứ tự nhập liệu."],
    ["Nhập tính vào bình quân: nhập mua có giá, nhập chế biến (= tổng nguyên liệu theo giá tháng), nhập điều chuyển. Hàng tặng 0 đ, kiểm kê thừa đi theo giá bình quân."],
    ["Điều chuyển: giữ luật 27/09 — nguyên liệu/bao bì giá nhập mua gần nhất trong tháng, không có thì bình quân nhập mua tháng liền trước; bán thành phẩm bình quân nhập chế biến tháng. Hai đầu cùng giá."],
    ["Kho không tồn, không nhập (xuất âm): giá tháng trước của kho → giá tháng kho khác cùng mã → giá nhập mua gần nhất."],
    ["Giá vốn P&L tính theo cùng luật ghi sổ (COGS Bếp/Bar/kho chung, bao bì → vật tư tiêu hao, đồng phục → CP đồng phục), chưa tính lịch phân bổ đồng phục."],
    [`Định giá lại tồn đầu âm: ${money(reval)} đ · Trị giá lẻ khi tồn về 0 (chênh giá điều chuyển): ${money(residual)} đ`],
  ], [160]);
  const totalsByPeriod = new Map();
  for (const row of cogsRows) {
    const total = totalsByPeriod.get(row.period) || { before: 0, after: 0, fromZero: 0 };
    total.before += row.before;
    total.after += row.after;
    total.fromZero += row.fromZero;
    totalsByPeriod.set(row.period, total);
  }
  const summaryRows = [];
  for (const [period, total] of [...totalsByPeriod].sort()) {
    for (const row of cogsRows.filter((item) => item.period === period)) {
      summaryRows.push([row.period, row.branchCode, row.label, vnd(row.before), vnd(row.after), vnd(row.after - row.before), vnd(row.fromZero), vnd(row.after - row.before - row.fromZero)]);
    }
    summaryRows.push([period, "TỔNG", "", vnd(total.before), vnd(total.after), vnd(total.after - total.before), vnd(total.fromZero), vnd(total.after - total.before - total.fromZero)]);
  }
  sheet("Tong hop gia von", ["Tháng", "Nhà hàng", "Hạng mục", "Hiện tại", "Sau tính lại", "Chênh lệch", "Trong đó: dòng 0 đ nay có giá", "Trong đó: tính lại giá"],
    summaryRows, [9, 10, 26, 16, 16, 16, 22, 20]);
  sheet("Dong xuat 0d", ["Tháng", "Tổng dòng xuất", "Dòng 0 đ hiện tại", "Dòng 0 đ sau tính lại"],
    [...zeroLines].sort().map(([period, stat]) => [period, stat.total, stat.before, stat.after]), [9, 16, 18, 20]);
  sheet("Ton kho cuoi thang", ["Tháng", "Nhà hàng", "Kho", "Trị giá hiện tại", "Sau tính lại", "Chênh lệch"],
    stockRows.map((row) => [row.period, row.branch, row.warehouseCode, vnd(row.before), vnd(row.after), vnd(row.after - row.before)]), [9, 10, 12, 18, 18, 16]);

  const oldOutByKey = new Map();
  for (const doc of documents) {
    if (doc.transactionType.startsWith("NHAP_")) continue;
    for (const line of doc.lines) {
      const period = newLine.get(line.id)?.period;
      const key = `${period}|${line.itemId}|${doc.warehouseCode}`;
      oldOutByKey.set(key, (oldOutByKey.get(key) || 0) + line.totalCost);
    }
  }
  sheet("Chi tiet mat hang",
    ["Tháng", "Kho", "Mã", "Tên", "Loại", "ĐVT", "SL đầu", "Trị giá đầu", "SL nhập (tính BQ)", "Trị giá nhập", "SL nhập theo BQ", "Giá BQ tháng", "Nguồn giá", "SL xuất", "Trị giá xuất hiện tại", "Trị giá xuất sau tính lại", "Chênh xuất", "SL cuối", "Trị giá cuối"],
    result.keys
      .map((key) => {
        const item = itemById.get(key.itemId);
        const oldOut = oldOutByKey.get(`${key.period}|${key.itemId}|${key.warehouseCode}`) || 0;
        return [key.period, key.warehouseCode, item?.code || key.itemId, item?.name || "", item?.itemType || "", item?.unit || "",
          key.openingQty, vnd(key.openingValue), key.inQty, vnd(key.inValue), key.followQty, Math.round(key.averageCost * 100) / 100, SOURCE_LABELS[key.priceSource] || key.priceSource,
          key.outQty, vnd(oldOut), vnd(key.outValue), vnd(key.outValue - oldOut), key.closingQty, vnd(key.closingValue)];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || Math.abs(b[16]) - Math.abs(a[16])),
    [9, 11, 14, 32, 14, 7, 10, 14, 12, 14, 12, 12, 26, 10, 16, 16, 14, 10, 14]);
  const unpriced = new Map();
  for (const key of result.keys) {
    if (key.priceSource !== "NONE" || key.outQty <= 0) continue;
    const id = `${key.itemId}|${key.warehouseCode}`;
    const row = unpriced.get(id) || { itemId: key.itemId, warehouseCode: key.warehouseCode, periods: [], outQty: 0 };
    row.periods.push(key.period);
    row.outQty += key.outQty;
    unpriced.set(id, row);
  }
  sheet("Ma chua co gia", ["Mã", "Tên", "Loại", "ĐVT", "Kho", "Tháng", "SL đã xuất", "Cần làm"],
    [...unpriced.values()]
      .map((row) => {
        const item = itemById.get(row.itemId);
        return [item?.code || row.itemId, item?.name || "", item?.itemType || "", item?.unit || "", row.warehouseCode, row.periods.join(", "), row.outQty,
          ["SEMI_FINISHED", "FINISHED"].includes(item?.itemType || "") ? "Kiểm tra định lượng (nguyên liệu chưa có giá)" : "Chưa có tồn đầu kỳ / phiếu nhập mua nào có giá"];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[4]).localeCompare(String(b[4]))),
    [14, 32, 14, 7, 11, 18, 12, 44]);
  console.log(`Mã × kho đã xuất mà chưa có giá nào: ${unpriced.size}`);
  const transferRows = [];
  for (const doc of documents) {
    if (doc.transactionType !== "DIEU_CHUYEN") continue;
    for (const line of doc.lines) {
      const after = newLine.get(line.id);
      const item = itemById.get(line.itemId);
      transferRows.push([after?.period || "", doc.code, doc.warehouseCode, doc.toWarehouseCode || "", item?.code || "", item?.name || "", line.quantity,
        Math.round(line.unitCost * 100) / 100, Math.round((after?.unitCost || 0) * 100) / 100, vnd(line.totalCost), vnd(after?.totalCost || 0), vnd((after?.totalCost || 0) - line.totalCost)]);
    }
  }
  sheet("Dieu chuyen", ["Tháng", "Phiếu", "Kho chuyển", "Kho nhận", "Mã", "Tên", "SL", "Đơn giá hiện tại", "Đơn giá sau tính lại", "Trị giá hiện tại", "Sau tính lại", "Chênh lệch"],
    transferRows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))), [9, 18, 11, 11, 14, 30, 8, 14, 16, 14, 14, 12]);

  XLSX.writeFile(book, outPath);
  console.log(`\nĐã xuất file so sánh: ${outPath}`);
  console.log("CHẠY THỬ — không ghi gì vào dữ liệu.");
} finally {
  await prisma.$disconnect();
}
