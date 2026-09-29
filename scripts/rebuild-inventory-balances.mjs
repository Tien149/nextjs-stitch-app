/**
 * Dựng lại SỐ LƯỢNG tồn kho (InventoryBalance.quantity) từ sổ: đầu kỳ đã chốt + Σ(nhập − xuất)
 * của mọi phiếu kho còn sống (điều chuyển: trừ kho xuất, cộng kho nhận).
 *
 * Vì sao cần: lưu / import số dư đầu kỳ tồn kho từng GHI ĐÈ số dư bằng đúng số đầu kỳ, xoá mất
 * phát sinh đã có; hoàn tác phiếu sau đó lại cộng / trừ lần nữa nên đẻ ra tồn "ma" (VPS 26/09/2026
 * lưu đầu kỳ sau khi đã rã tháng 8 → ~800 mã × kho lệch). Code đã sửa (lib/opening-inventory.ts),
 * script này dọn dữ liệu cũ. Rã BOM đọc tồn để "lấy tồn trước" nên phải dọn TRƯỚC khi rã lại.
 *
 * Chỉ sửa số lượng; giá bình quân giữ nguyên — bấm "Tính giá vốn & giá thành" sau đó nếu cần.
 *
 * Chạy thử (mặc định, không ghi gì): npm run rebuild:inventory-balances
 * Chỉ vài kho:                       npm run rebuild:inventory-balances -- --warehouses ASA_KBEP,NME_KBEP
 * Ghi thật:                          npm run rebuild:inventory-balances -- --apply
 */
import { Prisma } from "@prisma/custom-client";
import { prisma } from "../lib/prisma.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const warehouses = valueOf("--warehouses").split(",").map((code) => code.trim().toUpperCase()).filter(Boolean);
const epsilon = 0.0005;
const qty = (value) => Number(value).toLocaleString("vi-VN", { maximumFractionDigits: 3 });

try {
  const warehouseFilter = warehouses.length ? Prisma.sql`WHERE x.kho IN (${Prisma.join(warehouses)})` : Prisma.empty;
  const rows = await prisma.$queryRaw(Prisma.sql`
    WITH mv AS (
      SELECT l."itemId", t."warehouseCode" AS kho,
        CASE WHEN LEFT(t."transactionType", 5) = 'NHAP_' THEN l.quantity ELSE -l.quantity END AS d
      FROM "InventoryTransactionLine" l JOIN "InventoryTransaction" t ON t.id = l."transactionId"
      WHERE t."deletedAt" IS NULL
      UNION ALL
      SELECT l."itemId", t."toWarehouseCode", l.quantity
      FROM "InventoryTransactionLine" l JOIN "InventoryTransaction" t ON t.id = l."transactionId"
      WHERE t."deletedAt" IS NULL AND t."transactionType" = 'DIEU_CHUYEN' AND t."toWarehouseCode" IS NOT NULL
    ),
    ps AS (SELECT "itemId", kho, SUM(d) AS s FROM mv GROUP BY 1, 2),
    dk AS (
      SELECT i.id AS "itemId", o."warehouseCode" AS kho, SUM(o.quantity) AS q
      FROM "OpeningBalance" o JOIN "InventoryItem" i ON UPPER(i.code) = UPPER(o."objectCode")
      WHERE o."balanceType" = 'INVENTORY' AND o."deletedAt" IS NULL AND o.status IN ('CONFIRMED', 'POSTED') AND o."warehouseCode" IS NOT NULL
      GROUP BY 1, 2
    ),
    keys AS (
      SELECT "itemId", "warehouseCode" AS kho FROM "InventoryBalance"
      UNION SELECT "itemId", kho FROM ps
      UNION SELECT "itemId", kho FROM dk
    ),
    x AS (
      SELECT k."itemId", k.kho, b.id AS "balanceId", b.quantity AS so_du, b."averageCost" AS gia,
        COALESCE(dk.q, 0) AS dau_ky, COALESCE(ps.s, 0) AS phat_sinh
      FROM keys k
      LEFT JOIN "InventoryBalance" b ON b."itemId" = k."itemId" AND b."warehouseCode" = k.kho
      LEFT JOIN dk ON dk."itemId" = k."itemId" AND dk.kho = k.kho
      LEFT JOIN ps ON ps."itemId" = k."itemId" AND ps.kho = k.kho
    )
    SELECT x."itemId", i.code, x.kho, x."balanceId", COALESCE(x.so_du, 0)::float8 AS so_du, COALESCE(x.gia, 0)::float8 AS gia,
      x.dau_ky::float8 AS dau_ky, x.phat_sinh::float8 AS phat_sinh
    FROM x JOIN "InventoryItem" i ON i.id = x."itemId"
    ${warehouseFilter}
  `);
  const wrong = rows
    .map((row) => ({ ...row, dung: row.dau_ky + row.phat_sinh, lech: row.so_du - (row.dau_ky + row.phat_sinh) }))
    .filter((row) => Math.abs(row.lech) > epsilon)
    .sort((a, b) => Math.abs(b.lech) - Math.abs(a.lech));

  const byWarehouse = new Map();
  for (const row of wrong) {
    const current = byWarehouse.get(row.kho) || { count: 0, abs: 0 };
    current.count += 1;
    current.abs += Math.abs(row.lech);
    byWarehouse.set(row.kho, current);
  }
  console.log(`Đối chiếu ${rows.length} dòng mã × kho${warehouses.length ? ` (${warehouses.join(", ")})` : ""}: ${wrong.length} dòng số dư lệch sổ.`);
  for (const [kho, stat] of [...byWarehouse.entries()].sort()) console.log(`  ${kho}: ${stat.count} mã, tổng lệch ${qty(stat.abs)}`);
  if (wrong.length > 0) {
    console.log("\nLệch nhiều nhất (số dư → đúng theo sổ = đầu kỳ + phát sinh):");
    for (const row of wrong.slice(0, 30)) {
      console.log(`  ${row.code} @ ${row.kho}: ${qty(row.so_du)} → ${qty(row.dung)} (đầu kỳ ${qty(row.dau_ky)}, phát sinh ${qty(row.phat_sinh)}, lệch ${qty(row.lech)})`);
    }
    if (wrong.length > 30) console.log(`  ... còn ${wrong.length - 30} dòng`);
  }

  const drafts = await prisma.openingBalance.count({ where: { balanceType: "INVENTORY", status: "DRAFT" } });
  if (drafts > 0) console.log(`\nLưu ý: ${drafts} dòng đầu kỳ tồn kho đang Nháp — chưa chốt nên KHÔNG tính vào sổ.`);

  if (!apply) {
    console.log(`\nCHẠY THỬ — chưa ghi gì.${wrong.length ? " Kiểm tra xong thì chạy lại với --apply." : ""}`);
  } else if (wrong.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of wrong) {
        if (row.balanceId) {
          await tx.inventoryBalance.update({ where: { id: row.balanceId }, data: { quantity: row.dung } });
        } else {
          await tx.inventoryBalance.create({ data: { itemId: row.itemId, warehouseCode: row.kho, quantity: row.dung, averageCost: 0 } });
        }
      }
      await tx.auditLog.create({
        data: {
          module: "/inventory",
          action: "REBUILD_INVENTORY_BALANCES",
          entityType: "InventoryBalance",
          actorName: "script rebuild-inventory-balances",
          metadataJson: JSON.stringify({
            warehouses,
            fixed: wrong.length,
            rows: wrong.map((row) => ({ code: row.code, kho: row.kho, before: row.so_du, after: row.dung })),
          }),
        },
      });
    }, { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 });
    console.log(`\nĐÃ GHI: sửa số lượng ${wrong.length} dòng số dư theo sổ (danh sách trước/sau lưu ở nhật ký REBUILD_INVENTORY_BALANCES).`);
  }
} finally {
  await prisma.$disconnect();
}
