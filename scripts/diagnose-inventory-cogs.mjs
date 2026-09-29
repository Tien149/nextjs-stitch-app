/**
 * Soi vì sao giá vốn theo kho (COGS Bếp / COGS Bar, lib/inventory-cogs.ts) chưa lên P&L của một kỳ:
 * code đã có luật mới chưa, doanh thu đã rã chưa, phiếu xuất có giá không, đã ghi sổ chưa, kỳ còn
 * phiếu chi mua ghi 632 kiểu cũ (phải bấm Ghi sổ kỳ lại) không, kỳ có khoá không — rồi kết luận.
 *
 * Chạy:  npm run diagnose:inventory-cogs -- 2026-09
 *        npm run diagnose:inventory-cogs -- 2026-09 --branch HCM
 * Chỉ đọc, không ghi gì.
 */
import { execSync } from "node:child_process";
import { prisma } from "../lib/prisma.ts";
import { periodBounds } from "../lib/accounting.ts";
import { isPeriodLocked } from "../lib/phase3.ts";
import { getPnl } from "../lib/reports.ts";
import {
  COGS_PURCHASE_SOURCE_TYPES,
  COGS_STOCK_TYPES,
  INVENTORY_COGS_PNL_ITEMS,
  INVENTORY_COGS_START_DATE,
  INVENTORY_COGS_START_PERIOD,
  PACKAGING_EXPENSE_PNL_ITEM,
} from "../lib/inventory-cogs.ts";
import { departmentFromWarehouseGroup } from "../lib/revenue-department.ts";

// lib/prisma.ts luôn bật log truy vấn — lọc đi để kết quả chẩn đoán đọc được.
const rawLog = console.log;
console.log = (...parts) => {
  if (typeof parts[0] === "string" && parts[0].startsWith("prisma:query")) return;
  rawLog(...parts);
};

const args = process.argv.slice(2);
const branchIndex = args.indexOf("--branch");
const onlyBranch = branchIndex >= 0 ? (args[branchIndex + 1] || "").toUpperCase() : null;
const period = args.find((value) => /^\d{4}-\d{2}$/.test(value));
if (!period) {
  console.log("Cách dùng: npm run diagnose:inventory-cogs -- <YYYY-MM> [--branch <cửa hàng>]");
  process.exit(0);
}

const money = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value || 0));
const line = (text = "") => console.log(text);
const warn = (text) => console.log(`  ⚠️  ${text}`);
const ok = (text) => console.log(`  ✅ ${text}`);

let commit = "?";
for (const env of [process.env, { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" }]) {
  try { commit = execSync("git log -1 --format='%h %s'", { env, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); break; } catch { /* không có git / macOS chưa nhận license Xcode */ }
}

line(`=== Chẩn đoán giá vốn theo kho — kỳ ${period}${onlyBranch ? ` — cửa hàng ${onlyBranch}` : ""} ===`);
line(`Code trong thư mục: ${commit}`);
line(`Giờ máy chủ: ${new Date().toString()} (TZ=${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone})`);
line("Lưu ý: app đang chạy chỉ có luật mới nếu đã build + khởi động lại SAU khi pull code này.");
line();

if (period < INVENTORY_COGS_START_PERIOD) {
  line(`Kỳ ${period} trước mốc ${INVENTORY_COGS_START_PERIOD}: giá vốn kỳ này VẪN lấy theo phiếu chi mua (632), không theo kho. Đây là đúng thiết kế.`);
  await prisma.$disconnect();
  process.exit(0);
}

const { start, end } = periodBounds(period);
const from = start.getTime() < INVENTORY_COGS_START_DATE.getTime() ? INVENTORY_COGS_START_DATE : start;

const [warehouses, pnlItems] = await Promise.all([
  prisma.masterDataItem.findMany({ where: { type: "WAREHOUSE" }, select: { code: true, name: true, group: true, branch: true } }),
  prisma.masterDataItem.findMany({
    where: { type: "PNL_ITEM", code: { in: [...Object.values(INVENTORY_COGS_PNL_ITEMS).map((item) => item.code), PACKAGING_EXPENSE_PNL_ITEM.code] } },
    select: { code: true, group: true, subGroup: true, status: true },
  }),
]);
const warehouseByCode = new Map(warehouses.map((warehouse) => [warehouse.code, warehouse]));

line("— Hạng mục P&L của giá vốn theo kho —");
if (pnlItems.length === 0) {
  warn("Chưa có COGS_BEP / COGS_BAR / COGS_KHAC: hệ thống CHƯA ghi sổ kỳ nào bằng code mới (hạng mục tự tạo ở lần Ghi sổ đầu tiên).");
} else {
  for (const item of pnlItems) line(`  ${item.code}: nhóm ${item.subGroup || "(chưa gắn nhóm)"} · loại ${item.group} · ${item.status}`);
}
line();

const branchRows = await prisma.inventoryTransaction.groupBy({
  by: ["branchCode"],
  where: { transactionDate: { gte: from, lt: end }, ...(onlyBranch ? { branchCode: onlyBranch } : {}) },
  _count: true,
});
const revenueBranches = await prisma.revenueImportRow.groupBy({
  by: ["branchCode"],
  where: { saleDate: { gte: from, lt: end }, deletedAt: null, ...(onlyBranch ? { branchCode: onlyBranch } : {}) },
  _count: true,
});
const branches = [...new Set([...branchRows.map((row) => row.branchCode), ...revenueBranches.map((row) => row.branchCode), ...(onlyBranch ? [onlyBranch] : [])])].filter(Boolean).sort();
if (branches.length === 0) line("Không có phiếu kho hay doanh thu nào trong kỳ.");

for (const branchCode of branches) {
  line(`================ Cửa hàng ${branchCode} ================`);
  const verdicts = [];

  // 1. Khoá sổ
  const locked = await isPeriodLocked(start, branchCode);
  if (locked) { warn(`Kỳ ${period} ĐÃ KHOÁ SỔ — ghi sổ lại bị bỏ qua, P&L giữ nguyên số lúc khoá.`); verdicts.push("Kỳ đã khoá: mở khoá sổ rồi Ghi sổ kỳ lại."); }

  // 2. Doanh thu đã rã chưa
  const revenue = await prisma.revenueImportRow.groupBy({
    by: ["inventoryStatus"],
    where: { branchCode, saleDate: { gte: from, lt: end }, deletedAt: null },
    _count: true,
    _sum: { netAmount: true },
  });
  const statusOf = (status) => (status === null ? "chưa có trạng thái" : status === "PENDING" ? "CHỜ RÃ" : status === "NOT_REQUIRED" ? "không theo dõi kho" : status.startsWith("POSTED:") ? "đã rã" : status);
  const revenueByStatus = new Map();
  for (const row of revenue) {
    const key = statusOf(row.inventoryStatus);
    const current = revenueByStatus.get(key) || { count: 0, amount: 0 };
    current.count += row._count;
    current.amount += row._sum.netAmount || 0;
    revenueByStatus.set(key, current);
  }
  line("— Doanh thu POS trong kỳ theo trạng thái rã —");
  if (revenueByStatus.size === 0) warn("Không có dòng doanh thu nào trong kỳ.");
  for (const [key, value] of revenueByStatus) line(`  ${key}: ${value.count} dòng · ${money(value.amount)} đ`);
  const pending = revenueByStatus.get("CHỜ RÃ");
  if (pending?.count) { warn(`${pending.count} dòng doanh thu CHƯA RÃ — phần này chưa có phiếu xuất bán nên chưa có giá vốn.`); verdicts.push("Rã hết doanh thu tháng ở màn Kho & Định lượng."); }
  line();

  // 3. Phiếu kho tính giá vốn
  const documents = await prisma.inventoryTransaction.findMany({
    where: { branchCode, transactionDate: { gte: from, lt: end }, transactionType: { in: [...COGS_STOCK_TYPES] } },
    select: { id: true, code: true, transactionType: true, warehouseCode: true, lines: { select: { totalCost: true, unitCost: true, item: { select: { code: true } } } } },
  });
  line("— Phiếu kho tính giá vốn (xuất bán / hủy / test món / xuất khác / kiểm kê) —");
  const byType = new Map();
  const zeroDocs = [];
  const zeroItems = new Set();
  const unknownWarehouses = new Set();
  // Tách theo bộ phận của kho bị trừ — đúng luật postInventoryCogs — để thấy ngay vì sao một
  // dòng COGS Bếp / COGS Bar không lên (không có phiếu, phiếu giá 0, hay kiểm kê thừa làm âm).
  const byDepartment = new Map();
  let stockTotal = 0;
  for (const doc of documents) {
    const total = doc.lines.reduce((sum, row) => sum + (row.totalCost || 0), 0);
    const signed = doc.transactionType === "NHAP_KIEM_KE" ? -total : total;
    stockTotal += signed;
    const bucket = byType.get(doc.transactionType) || { count: 0, amount: 0 };
    bucket.count += 1;
    bucket.amount += total;
    byType.set(doc.transactionType, bucket);
    if (!(total > 0)) zeroDocs.push(doc.code);
    for (const row of doc.lines) if (!(row.totalCost > 0)) zeroItems.add(row.item.code);
    const warehouse = warehouseByCode.get(doc.warehouseCode);
    const dept = departmentFromWarehouseGroup(warehouse?.group);
    if (dept !== "KIT" && dept !== "BAR") unknownWarehouses.add(`${doc.warehouseCode} (nhóm kho: ${warehouse?.group || "trống"})`);
    const deptKey = dept === "KIT" ? "Bếp" : dept === "BAR" ? "Bar" : "Kho chung";
    const deptBucket = byDepartment.get(deptKey) || { net: 0, zero: 0, types: new Map(), warehouses: new Set() };
    deptBucket.net += signed;
    if (!(total > 0)) deptBucket.zero += 1;
    deptBucket.warehouses.add(doc.warehouseCode);
    const typeBucket = deptBucket.types.get(doc.transactionType) || { count: 0, amount: 0 };
    typeBucket.count += 1;
    typeBucket.amount += total;
    deptBucket.types.set(doc.transactionType, typeBucket);
    byDepartment.set(deptKey, deptBucket);
  }
  if (documents.length === 0) {
    warn("KHÔNG có phiếu kho nào tính giá vốn trong kỳ.");
    verdicts.push("Chưa có phiếu xuất: rã doanh thu tháng (và duyệt kiểm kê / lập phiếu hủy nếu có).");
  }
  for (const [type, value] of byType) line(`  ${type}: ${value.count} phiếu · ${money(value.amount)} đ`);
  if (documents.length) line(`  → Giá vốn theo kho dự kiến (kiểm kê thừa đã trừ): ${money(stockTotal)} đ`);
  if (documents.length) {
    line("  Theo bộ phận của kho bị trừ:");
    for (const deptKey of ["Bếp", "Bar", "Kho chung"]) {
      const bucket = byDepartment.get(deptKey);
      if (!bucket) {
        if (deptKey !== "Kho chung") warn(`${deptKey}: KHÔNG có phiếu nào tính giá vốn → dòng COGS ${deptKey} sẽ trống.`);
        continue;
      }
      const types = [...bucket.types].map(([type, value]) => `${type} ${value.count} phiếu ${money(value.amount)} đ`).join(" · ");
      line(`    ${deptKey} (kho ${[...bucket.warehouses].join(", ")}): ${money(bucket.net)} đ — ${types}${bucket.zero ? ` · ${bucket.zero} phiếu giá 0` : ""}`);
      if (!(bucket.net > 0.5)) warn(`${deptKey}: giá vốn ròng ${money(bucket.net)} đ (kiểm kê thừa ≥ xuất, hoặc phiếu xuất giá 0) → donut Cơ cấu giá vốn không vẽ được lát này.`);
    }
  }
  if (zeroDocs.length) {
    warn(`${zeroDocs.length} phiếu tổng giá trị 0 đ (không sinh bút toán): ${zeroDocs.slice(0, 10).join(", ")}${zeroDocs.length > 10 ? "..." : ""}`);
    verdicts.push("Phiếu xuất giá 0: khai tồn đầu kỳ / nhập mua có giá cho nguyên liệu, rồi rã lại ngày đó.");
  }
  if (zeroItems.size) warn(`${zeroItems.size} mã hàng xuất với giá 0: ${[...zeroItems].slice(0, 12).join(", ")}${zeroItems.size > 12 ? "..." : ""}`);
  if (unknownWarehouses.size) warn(`Kho không nhận ra Bếp/Bar → vào dòng COGS kho chung: ${[...unknownWarehouses].join(", ")}`);
  line();

  // 4. Đã ghi sổ chưa
  const entries = await prisma.journalEntry.findMany({
    where: { branchCode, sourceType: "INVENTORY_ISSUE", entryDate: { gte: from, lt: end } },
    select: { sourceId: true, lines: { select: { debit: true, credit: true, pnlItemCode: true, account: { select: { code: true } } } } },
  });
  const posted = new Set(entries.map((entry) => entry.sourceId));
  const postedByItem = new Map();
  for (const entry of entries) {
    for (const row of entry.lines) {
      if (row.account.code === "152") continue;
      const key = `${row.account.code} ${row.pnlItemCode || ""}`.trim();
      postedByItem.set(key, (postedByItem.get(key) || 0) + row.debit - row.credit);
    }
  }
  const missing = documents.filter((doc) => doc.lines.reduce((sum, row) => sum + (row.totalCost || 0), 0) > 0 && !posted.has(doc.id));
  line("— Bút toán giá vốn trên sổ cái (INVENTORY_ISSUE) —");
  line(`  ${entries.length} bút toán`);
  for (const [key, amount] of postedByItem) line(`  ${key}: ${money(amount)} đ`);
  if (missing.length) {
    warn(`${missing.length}/${documents.length} phiếu có giá trị nhưng CHƯA có bút toán giá vốn: ${missing.slice(0, 10).map((doc) => doc.code).join(", ")}${missing.length > 10 ? "..." : ""}`);
  } else if (documents.length) {
    ok("Mọi phiếu có giá trị đều đã có bút toán giá vốn.");
  }
  line();

  // 5. Phiếu chi mua ghi kiểu cũ
  const oldLines = await prisma.journalLine.findMany({
    where: { account: { code: "632" }, entry: { branchCode, entryDate: { gte: from, lt: end }, deletedAt: null, sourceType: { in: [...COGS_PURCHASE_SOURCE_TYPES] } } },
    select: { debit: true, credit: true, entry: { select: { sourceType: true } } },
  });
  const oldAmount = oldLines.reduce((sum, row) => sum + row.debit - row.credit, 0);
  line("— Phiếu chi / công nợ / điều chỉnh quỹ mua hàng nhóm Giá vốn —");
  if (oldLines.length) {
    warn(`${oldLines.length} dòng còn ghi Nợ 632 KIỂU CŨ (${money(oldAmount)} đ): kỳ này CHƯA Ghi sổ lại từ khi lên luật mới.`);
    line("     Hệ thống cố ý KHÔNG tự ghi giá vốn theo kho cho kỳ này (tránh tính giá vốn hai lần).");
    verdicts.unshift(`BẤM GHI SỔ KỲ ${period} (màn Kế toán) cho cửa hàng ${branchCode} — sau đó rã sẽ tự cập nhật.`);
  } else {
    ok("Không còn dòng mua hàng ghi 632 — kỳ đã theo luật mới (mua hàng vào 152).");
  }
  line();

  // 6. P&L thực tế đang đọc
  try {
    const pnl = await getPnl(period, branchCode);
    const cogs = pnl.statement.find((row) => row.key === "cogs");
    line("— Dòng Giá vốn trên P&L kỳ này —");
    line(`  Tổng: ${money(cogs?.amount)} đ`);
    for (const group of cogs?.groups || []) for (const item of group.items || []) if (Math.abs(item.amount) > 0.5) line(`  · ${item.name || item.code}: ${money(item.amount)} đ`);
  } catch (error) {
    warn(`Không đọc được P&L: ${error instanceof Error ? error.message : error}`);
  }
  line();

  if (missing.length && !oldLines.length && !locked) verdicts.push(`Có phiếu chưa lên sổ: bấm Ghi sổ kỳ ${period} cho ${branchCode} một lần.`);
  line("→ KẾT LUẬN:");
  if (verdicts.length === 0) ok("Không thấy vướng gì ở dữ liệu. Nếu màn hình vẫn không có COGS: app đang chạy bản cũ (build/khởi động lại chưa xong) hoặc đang xem nhầm cửa hàng / kỳ.");
  else verdicts.forEach((text, index) => line(`  ${index + 1}. ${text}`));
  line();
}

await prisma.$disconnect();
