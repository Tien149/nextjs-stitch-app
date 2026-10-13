/**
 * CHẠY THỬ tính giá vốn bình quân cả tháng theo từng kho (lib/inventory-monthly-cost.ts, khách
 * chốt 13/10/2026) trên dữ liệu thật — CHỈ ĐỌC, không ghi gì. In tổng hợp và xuất file Excel so
 * sánh giá vốn / tồn kho hiện tại (bình quân liên hoàn theo thứ tự nhập liệu) với sau khi tính lại.
 *
 * Chạy:  npm run diagnose:monthly-cost
 *        npm run diagnose:monthly-cost -- --out /tmp/so-sanh-gia-von.xlsx --from 2026-08
 * Ghi thật thì bấm "Ghi giá vốn" ở Kho > Định lượng > Giá thành sản phẩm.
 */
import * as XLSX from "xlsx";
import { prisma } from "../lib/prisma.ts";
import { previewMonthlyCost } from "../lib/inventory-monthly-cost-db.ts";

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
const fromPeriod = valueOf("--from", "") || null;
const vnd = (value) => Math.round(Number(value) || 0);
const money = (value) => vnd(value).toLocaleString("vi-VN");
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
  const started = Date.now();
  const { report, result, source, status } = await previewMonthlyCost(fromPeriod);
  const elapsed = Date.now() - started;
  const itemById = new Map(source.items.map((item) => [item.id, item]));
  const warehouseByCode = new Map(source.warehouses.map((warehouse) => [warehouse.code, warehouse]));
  const newLine = new Map(result.lines.map((row) => [row.lineId, row]));
  const inRange = (period) => period >= report.fromPeriod && period <= report.toPeriod;

  console.log(`Tính giá bình quân tháng: ${source.documents.length} phiếu, ${result.lines.length} dòng, ${source.opening.length} dòng tồn đầu kỳ ${source.openingPeriod} — ${elapsed} ms.`);
  console.log(`Trạng thái: ${status.map((row) => `${row.period} ${row.status}`).join(", ")}`);
  console.log(`Khoảng tính: ${report.fromPeriod} → ${report.toPeriod} · số vòng lặp: ${Object.entries(result.iterations).map(([period, count]) => `${period}: ${count}`).join(", ")}`);
  for (const row of result.unconverged) console.log(`  CHƯA HỘI TỤ ${row.period} ${itemById.get(row.itemId)?.code} @ ${row.warehouseCode}: giá ${money(row.averageCost)}, vòng cuối đổi ${row.change.toFixed(4)}`);
  if (report.locked) console.log(`  KHOÁ SỔ: ${report.locked}`);
  console.log("\nGiá vốn / chi phí theo kho (hiện tại → sau tính lại):");
  for (const row of report.cogs) console.log(`  ${row.period} ${row.branchCode} ${row.label}: ${money(row.before)} → ${money(row.after)} (${row.after - row.before >= 0 ? "+" : ""}${money(row.after - row.before)})`);
  console.log("\nDòng xuất 0 đ (hiện tại → sau tính lại):");
  for (const row of report.zeroLines) console.log(`  ${row.period}: ${row.before} → ${row.after} / ${row.total} dòng xuất`);
  console.log(`\n${report.changedLines} dòng phiếu đổi giá · ${report.changedTransfers.length} phiếu điều chuyển liên nhà hàng (${report.changedTransfers.filter((row) => row.settledDebt).length} đã gạch nợ) · ${report.unpriced.length} mã × kho chưa có giá`);
  console.log(`Định giá lại tồn đầu âm: ${money(report.revaluation)} · trị giá lẻ khi tồn về 0: ${money(report.residual)}`);

  const book = XLSX.utils.book_new();
  const sheet = (name, header, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws["!cols"] = widths.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(book, ws, name);
  };
  sheet("Ghi chu", ["Nội dung"], [
    ["SO SÁNH GIÁ VỐN: HIỆN TẠI vs BÌNH QUÂN CẢ THÁNG THEO TỪNG KHO — CHẠY THỬ, CHƯA GHI GÌ"],
    [`Dữ liệu lúc chạy: ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · ${source.documents.length} phiếu kho · tồn đầu kỳ ${source.openingPeriod} · khoảng ${report.fromPeriod} → ${report.toPeriod}`],
    ["Giá tháng (mã × kho) = (Trị giá tồn đầu + Trị giá nhập) ÷ (SL tồn đầu + SL nhập). Mọi phiếu xuất trong tháng lấy giá này, không phụ thuộc thứ tự nhập liệu."],
    ["Nhập tính vào bình quân: nhập mua có giá, nhập chế biến (= tổng nguyên liệu theo giá tháng), nhập điều chuyển. Hàng tặng 0 đ, kiểm kê thừa đi theo giá bình quân."],
    ["Điều chuyển: giữ luật 27/09 — nguyên liệu/bao bì giá nhập mua gần nhất trong tháng, không có thì bình quân nhập mua tháng liền trước; bán thành phẩm bình quân nhập chế biến tháng. Hai đầu cùng giá."],
    ["Kho không tồn, không nhập (xuất âm): giá tháng trước của kho → giá tháng kho khác cùng mã → giá nhập mua gần nhất."],
    [`Định giá lại tồn đầu âm: ${money(report.revaluation)} đ · Trị giá lẻ khi tồn về 0 (chênh giá điều chuyển): ${money(report.residual)} đ`],
  ], [160]);
  const summaryRows = [];
  for (const period of [...new Set(report.cogs.map((row) => row.period))]) {
    const rows = report.cogs.filter((row) => row.period === period);
    for (const row of rows) summaryRows.push([row.period, row.branchCode, row.label, vnd(row.before), vnd(row.after), vnd(row.after - row.before), vnd(row.fromZero), vnd(row.after - row.before - row.fromZero)]);
    const total = rows.reduce((sum, row) => ({ before: sum.before + row.before, after: sum.after + row.after, fromZero: sum.fromZero + row.fromZero }), { before: 0, after: 0, fromZero: 0 });
    summaryRows.push([period, "TỔNG", "", vnd(total.before), vnd(total.after), vnd(total.after - total.before), vnd(total.fromZero), vnd(total.after - total.before - total.fromZero)]);
  }
  sheet("Tong hop gia von", ["Tháng", "Nhà hàng", "Hạng mục", "Hiện tại", "Sau tính lại", "Chênh lệch", "Trong đó: dòng 0 đ nay có giá", "Trong đó: tính lại giá"], summaryRows, [9, 10, 26, 16, 16, 16, 22, 20]);
  sheet("Dong xuat 0d", ["Tháng", "Tổng dòng xuất", "Dòng 0 đ hiện tại", "Dòng 0 đ sau tính lại"], report.zeroLines.map((row) => [row.period, row.total, row.before, row.after]), [9, 16, 18, 20]);

  // Tồn kho cuối tháng theo kho: hiện tại (cộng dồn trị giá các phiếu như báo cáo tồn) vs sau tính lại.
  const beforeFlow = new Map();
  const addFlow = (key, value) => beforeFlow.set(key, (beforeFlow.get(key) || 0) + value);
  const oldOutByKey = new Map();
  for (const doc of source.documents) {
    for (const line of doc.lines) {
      const period = newLine.get(line.id)?.period;
      if (!period) continue;
      if (doc.transactionType === "DIEU_CHUYEN" && doc.toWarehouseCode) {
        addFlow(`${period}|${doc.warehouseCode}`, -line.totalCost);
        addFlow(`${period}|${doc.toWarehouseCode}`, line.totalCost);
      } else addFlow(`${period}|${doc.warehouseCode}`, doc.transactionType.startsWith("NHAP_") ? line.totalCost : -line.totalCost);
      if (!doc.transactionType.startsWith("NHAP_")) {
        const key = `${period}|${line.itemId}|${doc.warehouseCode}`;
        oldOutByKey.set(key, (oldOutByKey.get(key) || 0) + line.totalCost);
      }
    }
  }
  const stockRows = [];
  for (const warehouseCode of [...new Set(result.keys.map((key) => key.warehouseCode))].sort()) {
    let before = source.opening.filter((row) => row.warehouseCode === warehouseCode).reduce((sum, row) => sum + row.value, 0);
    for (const period of result.periods) {
      before += beforeFlow.get(`${period}|${warehouseCode}`) || 0;
      if (!inRange(period)) continue;
      const after = result.keys.filter((key) => key.period === period && key.warehouseCode === warehouseCode).reduce((sum, key) => sum + key.closingValue, 0);
      stockRows.push([period, warehouseByCode.get(warehouseCode)?.branch || "", warehouseCode, vnd(before), vnd(after), vnd(after - before)]);
    }
  }
  sheet("Ton kho cuoi thang", ["Tháng", "Nhà hàng", "Kho", "Trị giá hiện tại", "Sau tính lại", "Chênh lệch"], stockRows, [9, 10, 12, 18, 18, 16]);
  sheet("Chi tiet mat hang",
    ["Tháng", "Kho", "Mã", "Tên", "Loại", "ĐVT", "SL đầu", "Trị giá đầu", "SL nhập (tính BQ)", "Trị giá nhập", "SL nhập theo BQ", "Giá BQ tháng", "Nguồn giá", "SL xuất", "Trị giá xuất hiện tại", "Trị giá xuất sau tính lại", "Chênh xuất", "SL cuối", "Trị giá cuối"],
    result.keys
      .filter((key) => inRange(key.period))
      .map((key) => {
        const item = itemById.get(key.itemId);
        const oldOut = oldOutByKey.get(`${key.period}|${key.itemId}|${key.warehouseCode}`) || 0;
        return [key.period, key.warehouseCode, item?.code || key.itemId, item?.name || "", item?.itemType || "", item?.unit || "",
          key.openingQty, vnd(key.openingValue), key.inQty, vnd(key.inValue), key.followQty, Math.round(key.averageCost * 100) / 100, SOURCE_LABELS[key.priceSource] || key.priceSource,
          key.outQty, vnd(oldOut), vnd(key.outValue), vnd(key.outValue - oldOut), key.closingQty, vnd(key.closingValue)];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])) || Math.abs(b[16]) - Math.abs(a[16])),
    [9, 11, 14, 32, 14, 7, 10, 14, 12, 14, 12, 12, 26, 10, 16, 16, 14, 10, 14]);
  sheet("Ma chua co gia", ["Mã", "Tên", "Loại", "ĐVT", "Kho", "Tháng", "SL đã xuất", "Cần làm"],
    report.unpriced.map((row) => [row.itemCode, row.itemName, row.itemType, row.unit, row.warehouseCode, row.periods.join(", "), row.outQty,
      ["SEMI_FINISHED", "FINISHED"].includes(row.itemType) ? "Kiểm tra định lượng (nguyên liệu chưa có giá)" : "Chưa có tồn đầu kỳ / phiếu nhập mua nào có giá"]),
    [14, 32, 14, 7, 11, 18, 12, 44]);
  const transferRows = [];
  for (const doc of source.documents) {
    if (doc.transactionType !== "DIEU_CHUYEN") continue;
    for (const line of doc.lines) {
      const after = newLine.get(line.id);
      if (!after || !inRange(after.period)) continue;
      const item = itemById.get(line.itemId);
      transferRows.push([after.period, doc.code, doc.warehouseCode, doc.toWarehouseCode || "", item?.code || "", item?.name || "", line.quantity,
        Math.round(line.unitCost * 100) / 100, Math.round(after.unitCost * 100) / 100, vnd(line.totalCost), vnd(after.totalCost), vnd(after.totalCost - line.totalCost)]);
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
