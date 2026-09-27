/**
 * Tra xem phiếu nào đã trừ một mặt hàng ở một kho — nhất là trừ âm ở kho "không đúng bộ phận"
 * (dầu ăn, bột mì bị trừ ở kho BAR). Với phiếu rã BOM: in món / bán thành phẩm gây ra, và VÌ SAO
 * lần rã chọn kho đó (nhóm doanh thu, phân nhóm mặt hàng, hay rơi về kho mặc định của lần rã).
 *
 * Chạy:  npm run diagnose:stock-out -- --items NNBEGV00006,NNBEBT00012 --warehouses ASA_KBAR,FDS_KKVP
 * Chỉ đọc, không ghi gì.
 */
import { prisma } from "../lib/prisma.ts";
import { REVENUE_DEPARTMENT_CODES, buildRevenueDepartmentResolver } from "../lib/revenue-department.ts";

const args = process.argv.slice(2);
const listArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean) : [];
};
const itemCodes = listArg("--items");
const warehouseCodes = listArg("--warehouses");
if (itemCodes.length === 0 || warehouseCodes.length === 0) {
  console.log("Cách dùng: npm run diagnose:stock-out -- --items MA1,MA2 --warehouses KHO1,KHO2");
  process.exit(0);
}
const qty = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 3 }).format(value || 0);
const money = (value) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);
const day = (value) => new Date(value).toISOString().slice(0, 10);

try {
  const [items, warehouses, itemGroups] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { code: { in: itemCodes } } }),
    prisma.masterDataItem.findMany({ where: { type: "WAREHOUSE", code: { in: warehouseCodes } } }),
    prisma.masterDataItem.findMany({ where: { type: "INVENTORY_ITEM_GROUP" }, select: { code: true, name: true, subGroup: true } }),
  ]);
  const groupByCode = new Map(itemGroups.map((group) => [group.code.toUpperCase(), group]));
  console.log("Kho:");
  for (const code of warehouseCodes) {
    const warehouse = warehouses.find((row) => row.code.toUpperCase() === code);
    console.log(warehouse
      ? `  ${warehouse.code} — ${warehouse.name} | cửa hàng ${warehouse.branch || "(trống)"} | nhóm kho ${warehouse.group || "(trống)"} | ${warehouse.status}`
      : `  ${code} — KHÔNG có trong danh mục kho`);
  }

  const lines = await prisma.inventoryTransactionLine.findMany({
    where: {
      itemId: { in: items.map((item) => item.id) },
      transaction: {
        deletedAt: null,
        OR: [{ warehouseCode: { in: warehouseCodes } }, { toWarehouseCode: { in: warehouseCodes } }],
      },
    },
    include: { item: true, transaction: true },
  });

  // Món / BTP của từng phiếu xuất chế biến rã BOM: ghi chú dạng "Rã nguyên liệu <mã> (...)".
  const productOf = (note) => (note || "").match(/Rã nguyên liệu\s+(\S+)/)?.[1]?.toUpperCase() || null;
  const productCodes = [...new Set(lines.map((line) => productOf(line.transaction.note)).filter(Boolean))];
  const products = productCodes.length ? await prisma.inventoryItem.findMany({ where: { code: { in: productCodes } } }) : [];
  const productByCode = new Map(products.map((item) => [item.code.toUpperCase(), item]));
  const resolveDepartment = await buildRevenueDepartmentResolver(prisma, productCodes);
  const lastRevenueSource = new Map();
  for (const code of productCodes) {
    const row = await prisma.revenueImportRow.findFirst({
      where: { productCode: code, deletedAt: null, NOT: { revenueSource: "" } },
      orderBy: { saleDate: "desc" },
      select: { revenueSource: true },
    });
    lastRevenueSource.set(code, row?.revenueSource || null);
  }
  const runs = [...new Set(lines.filter((line) => line.transaction.referenceType === "PRODUCTION").map((line) => line.transaction.referenceCode).filter(Boolean))];
  const runLogs = runs.length ? await prisma.auditLog.findMany({ where: { action: "EXPLODE_PRODUCTION", entityCode: { in: runs } }, orderBy: { occurredAt: "desc" } }) : [];
  const runMeta = new Map();
  for (const log of runLogs) {
    if (runMeta.has(log.entityCode)) continue;
    try { runMeta.set(log.entityCode, JSON.parse(log.metadataJson || "{}")); } catch { runMeta.set(log.entityCode, {}); }
  }

  for (const item of items) {
    for (const warehouseCode of warehouseCodes) {
      const own = lines.filter((line) => line.itemId === item.id
        && (line.transaction.warehouseCode.toUpperCase() === warehouseCode || (line.transaction.toWarehouseCode || "").toUpperCase() === warehouseCode));
      if (own.length === 0) continue;
      const balance = await prisma.inventoryBalance.findFirst({ where: { itemId: item.id, warehouseCode } });
      console.log(`\n=== ${item.code} ${item.name} @ ${warehouseCode} — tồn hiện tại ${qty(balance?.quantity)} ${item.unit} ===`);

      const byType = new Map();
      for (const line of own) {
        const t = line.transaction;
        const incoming = t.transactionType.startsWith("NHAP_") || (t.transactionType === "DIEU_CHUYEN" && (t.toWarehouseCode || "").toUpperCase() === warehouseCode);
        const key = `${incoming ? "VÀO" : "RA "} ${t.transactionType}`;
        const bucket = byType.get(key) || { quantity: 0, count: 0 };
        bucket.quantity += line.quantity;
        bucket.count += 1;
        byType.set(key, bucket);
      }
      for (const [key, bucket] of [...byType.entries()].sort()) console.log(`  ${key}: ${qty(bucket.quantity)} ${item.unit} (${bucket.count} dòng)`);

      // Rã BOM: gom theo món / BTP gây ra.
      const production = own.filter((line) => line.transaction.transactionType === "XUAT_CHE_BIEN");
      const byProduct = new Map();
      for (const line of production) {
        const code = productOf(line.transaction.note) || "(không rõ)";
        const bucket = byProduct.get(code) || { quantity: 0, runs: new Set() };
        bucket.quantity += line.quantity;
        if (line.transaction.referenceCode) bucket.runs.add(line.transaction.referenceCode);
        byProduct.set(code, bucket);
      }
      if (byProduct.size) console.log("  Xuất chế biến theo món / BTP:");
      for (const [code, bucket] of [...byProduct.entries()].sort((a, b) => b[1].quantity - a[1].quantity)) {
        const product = productByCode.get(code);
        const revenueSource = lastRevenueSource.get(code) || product?.revenueGroup || null;
        const byRevenue = revenueSource ? resolveDepartment({ revenueSource }) : null;
        const byGroup = resolveDepartment({ productCode: code });
        const group = product?.category ? groupByCode.get(product.category.toUpperCase()) : null;
        const deptLabel = (department) => (department === REVENUE_DEPARTMENT_CODES.KITCHEN ? "kho BẾP" : department === REVENUE_DEPARTMENT_CODES.BAR ? "kho BAR" : department);
        const reason = byRevenue
          ? `nhóm doanh thu ${revenueSource} -> ${deptLabel(byRevenue)}`
          : byGroup
            ? `phân nhóm ${product?.category}${group ? ` (${group.name}, kho ${group.subGroup || "?"})` : ""} -> ${deptLabel(byGroup)}`
            : `KHÔNG suy được bộ phận (nhóm doanh thu ${revenueSource || "trống"}, phân nhóm ${product?.category || "trống"}) -> rơi về KHO MẶC ĐỊNH của lần rã`;
        console.log(`    ${code} ${product?.name || ""} [${product?.itemType || "?"}]: ${qty(bucket.quantity)} ${item.unit}`);
        console.log(`      lý do chọn kho: ${reason}`);
        const sampleRuns = [...bucket.runs].slice(0, 3).map((run) => {
          const meta = runMeta.get(run) || {};
          return `${run} (mặc định ${meta.warehouseCode || "?"}, bếp ${meta.kitchenWarehouseCode || "—"}, bar ${meta.barWarehouseCode || "—"})`;
        });
        console.log(`      lần rã: ${sampleRuns.join("; ")}${bucket.runs.size > 3 ? ` ... +${bucket.runs.size - 3}` : ""}`);
      }

      // Các phiếu ra khác (hủy, xuất khác, kiểm kê, điều chuyển, import...).
      const others = own.filter((line) => line.transaction.transactionType !== "XUAT_CHE_BIEN" && !line.transaction.transactionType.startsWith("NHAP_")
        && !(line.transaction.transactionType === "DIEU_CHUYEN" && (line.transaction.toWarehouseCode || "").toUpperCase() === warehouseCode));
      if (others.length) console.log("  Phiếu ra khác:");
      for (const line of others.sort((a, b) => a.transaction.transactionDate - b.transaction.transactionDate).slice(0, 30)) {
        const t = line.transaction;
        console.log(`    ${day(t.transactionDate)} ${t.code} ${t.transactionType}${t.toWarehouseCode ? ` -> ${t.toWarehouseCode}` : ""}: ${qty(line.quantity)} ${item.unit}, ${money(line.totalCost)} đ${t.importBatchId ? " [import]" : ""}${t.note ? ` — ${t.note}` : ""}`);
      }
      if (others.length > 30) console.log(`    ... còn ${others.length - 30} dòng`);
    }
  }
} finally {
  await prisma.$disconnect();
}
