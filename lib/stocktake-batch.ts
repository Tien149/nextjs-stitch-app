import { Prisma } from "@prisma/custom-client";
import type { TxClient } from "@/lib/prisma";
import { latestKnownUnitCost, postInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { STOCKTAKE_APPROVED, STOCKTAKE_PENDING } from "@/lib/stocktake-status";
import { loadNonInventoryRevenueGroups, tracksInventory, type CategoryLookupClient } from "@/lib/revenue-source";
import {
  LOCATION_STOCKTAKE_ITEM_TYPES,
  bookAtCutoff,
  consolidateStocktake,
  hasVariance,
  type BookRow,
  type Sheet,
} from "@/lib/stocktake-consolidate";

/**
 * Duyệt GỘP phiếu đếm theo vị trí (khách chốt 28/09/2026) — xem lib/stocktake-consolidate.ts.
 *
 * Luồng: nhà hàng đếm từng vị trí -> Gửi duyệt (PENDING). Kế toán chọn các phiếu của một kho,
 * chọn GIỜ CHỐT (mặc định lúc bấm) -> Xem tổng hợp -> Duyệt: sinh MỘT đợt StocktakeBatch với
 * phiếu -N (NHAP_KIEM_KE) / -X (XUAT_KIEM_KE) mang đúng giờ chốt. Sổ sách = mọi phiếu kho có
 * ngày chứng từ <= giờ chốt, nên chứng từ giải trình phải lập với ngày giờ TRƯỚC giờ chốt.
 *
 * Mở lại đợt: đảo phiếu điều chỉnh (không cần là phiếu cuối — reverseStockEffect trả đúng số
 * lượng + giá trị), phiếu đếm về Chờ duyệt; duyệt lại được chọn giờ chốt khác. Kỳ khoá sổ chặn.
 */

type Tx = TxClient;

export const STOCKTAKE_BATCH_APPROVED = "APPROVED";
export const STOCKTAKE_BATCH_REOPENED = "REOPENED";

function batchError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

/** Giờ Việt Nam (không có giờ mùa hè) để nói "ngày chốt" cho người dùng. */
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
function vnDayWindow(date: Date) {
  const local = new Date(date.getTime() + VN_OFFSET_MS);
  const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - VN_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
export function formatVnDateTime(date: Date) {
  const local = new Date(date.getTime() + VN_OFFSET_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${local.getUTCFullYear()}`;
}

export async function nextStocktakeBatchCode(tx: Tx, cutoffAt: Date) {
  const head = `KKT-${cutoffAt.getUTCFullYear()}-`;
  const rows = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "StocktakeBatch" WHERE "code" LIKE ${head + "%"}`;
  return head + String(nextSeqFromCodes(rows.map((row) => row.code), head)).padStart(4, "0");
}

/** Σ(nhập − xuất) của kho theo mã, chỉ phiếu có ngày chứng từ SAU giờ chốt. */
export async function netMovementsAfter(tx: Tx, warehouseCode: string, cutoffAt: Date) {
  const rows = await tx.$queryRaw<Array<{ itemId: string; net: number }>>(Prisma.sql`
    SELECT "itemId", SUM(delta)::float8 AS net FROM (
      SELECT l."itemId", CASE WHEN LEFT(t."transactionType", 5) = 'NHAP_' THEN l."quantity" ELSE -l."quantity" END AS delta
      FROM "InventoryTransactionLine" l
      JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
      WHERE t."deletedAt" IS NULL AND t."warehouseCode" = ${warehouseCode} AND t."transactionDate" > ${cutoffAt}
        AND (LEFT(t."transactionType", 5) IN ('NHAP_', 'XUAT_') OR t."transactionType" = 'DIEU_CHUYEN')
      UNION ALL
      SELECT l."itemId", l."quantity" AS delta
      FROM "InventoryTransactionLine" l
      JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
      WHERE t."deletedAt" IS NULL AND t."transactionType" = 'DIEU_CHUYEN' AND t."toWarehouseCode" = ${warehouseCode}
        AND t."transactionDate" > ${cutoffAt}
    ) moves
    GROUP BY 1
  `);
  return new Map(rows.map((row) => [row.itemId, row.net]));
}

/** Sổ sách nguyên liệu + bao bì của kho tại giờ chốt. */
export async function loadBookAtCutoff(tx: Tx, warehouseCode: string, cutoffAt: Date): Promise<BookRow[]> {
  const [balances, laterNet] = await Promise.all([
    tx.inventoryBalance.findMany({
      where: { warehouseCode, item: { itemType: { in: [...LOCATION_STOCKTAKE_ITEM_TYPES] } } },
      select: { itemId: true, quantity: true, averageCost: true },
    }),
    netMovementsAfter(tx, warehouseCode, cutoffAt),
  ]);
  const scoped = new Set(balances.map((balance) => balance.itemId));
  // Mã có phát sinh sau giờ chốt nhưng chưa có dòng tồn: phải xác nhận thuộc phạm vi.
  const extra = [...laterNet.keys()].filter((itemId) => !scoped.has(itemId));
  if (extra.length > 0) {
    const items = await tx.inventoryItem.findMany({
      where: { id: { in: extra }, itemType: { in: [...LOCATION_STOCKTAKE_ITEM_TYPES] } },
      select: { id: true },
    });
    for (const item of items) scoped.add(item.id);
  }
  const scopedNet = new Map([...laterNet].filter(([itemId]) => scoped.has(itemId)));
  return bookAtCutoff(balances, scopedNet);
}

export type BatchPreviewRow = {
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  itemType: string;
  breakdown: Record<string, number>;
  countedQuantity: number;
  bookQuantity: number;
  varianceQuantity: number;
  unitCost: number;
  varianceValue: number;
  notCounted: boolean;
  /** Đếm THỪA mà chưa tìm được đơn giá nào — kế toán phải nhập trước khi duyệt. */
  needsUnitCost: boolean;
};

export type BatchPreview = {
  branchCode: string;
  warehouseCode: string;
  cutoffAt: Date;
  sheets: Array<{ id: string; code: string; locationCode: string; createdBy: string | null; lineCount: number }>;
  locations: Array<{ code: string; name: string }>;
  rows: BatchPreviewRow[];
  warnings: string[];
  totals: { shortageValue: number; surplusValue: number; varianceRows: number; notCountedRows: number };
};

/**
 * Bảng tổng hợp của một đợt duyệt (chưa ghi gì). `unitCosts` là đơn giá kế toán nhập tay cho
 * phần thừa của mã chưa có giá (itemId -> đ/ĐVT tồn).
 */
export async function buildBatchPreview(
  tx: Tx,
  input: { stocktakeIds: string[]; cutoffAt: Date; unitCosts?: Record<string, number> },
): Promise<BatchPreview> {
  const ids = [...new Set(input.stocktakeIds.filter(Boolean))];
  if (ids.length === 0) batchError("Chọn ít nhất một phiếu đếm để duyệt");
  if (Number.isNaN(input.cutoffAt.getTime())) batchError("Giờ chốt không hợp lệ");

  const sessions = await tx.stocktakeSession.findMany({
    where: { id: { in: ids } },
    include: { lines: { include: { item: { select: { id: true, itemType: true } } } } },
    orderBy: { code: "asc" },
  });
  if (sessions.length !== ids.length) batchError("Có phiếu đếm không còn tồn tại — tải lại danh sách");
  const warehouses = new Set(sessions.map((session) => session.warehouseCode));
  if (warehouses.size > 1) batchError(`Mỗi lần duyệt chỉ gộp phiếu của MỘT kho (đang chọn ${[...warehouses].join(", ")}).`);
  const [{ branchCode, warehouseCode }] = sessions;
  for (const session of sessions) {
    if (!session.locationCode) batchError(`Phiếu ${session.code} không phải phiếu đếm theo vị trí — duyệt riêng ở danh sách phiếu kiểm kê cả kho.`);
    if (session.status !== STOCKTAKE_PENDING) batchError(`Phiếu ${session.code} không ở trạng thái Chờ duyệt.`);
    const outOfScope = session.lines.find((line) => !(LOCATION_STOCKTAKE_ITEM_TYPES as readonly string[]).includes(line.item.itemType));
    if (outOfScope) batchError(`Phiếu ${session.code} có mặt hàng ngoài nhóm nguyên liệu / bao bì.`);
  }

  const book = await loadBookAtCutoff(tx, warehouseCode, input.cutoffAt);
  const sheets: Sheet[] = sessions.map((session) => ({
    code: session.code,
    locationCode: session.locationCode || "",
    lines: session.lines.map((line) => ({ itemId: line.itemId, actualQuantity: line.actualQuantity, unitCost: line.unitCost })),
  }));
  const consolidated = consolidateStocktake(sheets, book);
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: consolidated.map((row) => row.itemId) } },
    select: { id: true, code: true, name: true, unit: true, itemType: true },
  });
  const itemById = new Map(items.map((item) => [item.id, item]));

  const rows: BatchPreviewRow[] = [];
  for (const row of consolidated) {
    const item = itemById.get(row.itemId);
    if (!item) continue;
    let unitCost = row.averageCost;
    if (row.varianceQuantity > 0) {
      // Phần THỪA nhập kho: giá bình quân kho, không có thì giá nhà hàng khai / kế toán nhập /
      // giá mua gần nhất đã biết. Phần THIẾU xuất theo bình quân kho lúc ghi.
      const manual = input.unitCosts?.[row.itemId] || 0;
      if (manual > 0) unitCost = manual;
      else if (unitCost <= 0) unitCost = row.declaredUnitCost > 0 ? row.declaredUnitCost : await latestKnownUnitCost(tx, row.itemId);
    }
    rows.push({
      itemId: row.itemId,
      itemCode: item.code,
      itemName: item.name,
      unit: item.unit,
      itemType: item.itemType,
      breakdown: row.breakdown,
      countedQuantity: row.countedQuantity,
      bookQuantity: row.bookQuantity,
      varianceQuantity: row.varianceQuantity,
      unitCost,
      varianceValue: row.varianceQuantity * unitCost,
      notCounted: row.notCounted,
      needsUnitCost: row.varianceQuantity > 0 && !(unitCost > 0),
    });
  }
  rows.sort((a, b) => Number(hasVariance(b)) - Number(hasVariance(a)) || Math.abs(b.varianceValue) - Math.abs(a.varianceValue) || a.itemCode.localeCompare(b.itemCode));

  const locationCodes = [...new Set(sessions.map((session) => session.locationCode || ""))];
  const locations = await tx.stocktakeLocation.findMany({ where: { warehouseCode, code: { in: locationCodes } }, select: { code: true, name: true, sortOrder: true } });
  const locationName = new Map(locations.map((location) => [location.code, location]));
  const orderedLocations = locationCodes
    .map((code) => ({ code, name: locationName.get(code)?.name || code, sortOrder: locationName.get(code)?.sortOrder ?? 9999 }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
    .map(({ code, name }) => ({ code, name }));

  return {
    branchCode,
    warehouseCode,
    cutoffAt: input.cutoffAt,
    sheets: sessions.map((session) => ({ id: session.id, code: session.code, locationCode: session.locationCode || "", createdBy: session.createdBy, lineCount: session.lines.length })),
    locations: orderedLocations,
    rows,
    warnings: await batchWarnings(tx, { branchCode, warehouseCode, cutoffAt: input.cutoffAt, selectedIds: ids }),
    totals: {
      shortageValue: rows.filter((row) => row.varianceQuantity < 0).reduce((sum, row) => sum + row.varianceValue, 0),
      surplusValue: rows.filter((row) => row.varianceQuantity > 0).reduce((sum, row) => sum + row.varianceValue, 0),
      varianceRows: rows.filter(hasVariance).length,
      notCountedRows: rows.filter((row) => row.notCounted).length,
    },
  };
}

/**
 * Những thứ làm sổ sách tại giờ chốt chưa đủ tin — hiện cho kế toán trước khi bấm duyệt, không chặn:
 * doanh thu chưa rã, lần rã gộp ngày vắt qua giờ chốt, doanh thu ngày chốt chưa tách giờ,
 * phiếu đếm khác của kho còn chờ mà chưa chọn.
 */
async function batchWarnings(tx: Tx, input: { branchCode: string; warehouseCode: string; cutoffAt: Date; selectedIds: string[] }) {
  const warnings: string[] = [];
  const { start: dayStart, end: dayEnd } = vnDayWindow(input.cutoffAt);
  const nonInventoryGroups = await loadNonInventoryRevenueGroups(tx as unknown as CategoryLookupClient);

  /**
   * Doanh thu có giờ bán (file POS có giờ) chia được đúng tại giờ chốt: dòng ngày chốt có giờ
   * < giờ chốt là "trước", >= là "sau". Dòng không có giờ thì không chia được. Giờ chốt lẻ phút
   * (11:30) thì cả giờ 11 nằm ở giữa — coi như trước để không bỏ sót.
   */
  const cutoffLocal = new Date(input.cutoffAt.getTime() + VN_OFFSET_MS);
  const cutoffHour = cutoffLocal.getUTCHours() + (cutoffLocal.getUTCMinutes() > 0 || cutoffLocal.getUTCSeconds() > 0 ? 1 : 0);
  const sameDay = (date: Date) => date.getTime() >= dayStart.getTime() && date.getTime() < dayEnd.getTime();
  const beforeCutoff = (row: { saleDate: Date; saleHour: number | null }) =>
    !sameDay(row.saleDate) || (row.saleHour !== null && row.saleHour < cutoffHour);

  const pending = await tx.revenueImportRow.findMany({
    where: { branchCode: input.branchCode, deletedAt: null, inventoryStatus: "PENDING", productCode: { not: null }, saleDate: { lt: dayEnd } },
    select: { saleDate: true, saleHour: true, revenueSource: true },
  });
  const pendingRows = pending
    .filter((row) => tracksInventory(row.revenueSource, nonInventoryGroups))
    .filter((row) => beforeCutoff(row) || row.saleHour === null);
  if (pendingRows.length > 0) {
    const days = [...new Set(pendingRows.map((row) => formatVnDateTime(row.saleDate).slice(6)))].slice(0, 5);
    warnings.push(`Còn ${pendingRows.length} dòng doanh thu trước giờ chốt CHƯA rã nguyên liệu (${days.join(", ")}${days.length >= 5 ? "…" : ""}) — sổ sách đang cao hơn thực tế. Rã ở tab Chế biến (ngày chốt chọn "Rã tới giờ") trước khi duyệt.`);
  }

  const postedRows = await tx.revenueImportRow.findMany({
    // Lần rã vắt qua giờ chốt chỉ có thể chứa doanh thu gần giờ chốt; soi 62 ngày là đủ và
    // không phải nạp cả lịch sử doanh thu (hàng chục nghìn dòng mỗi tháng).
    where: { branchCode: input.branchCode, deletedAt: null, saleDate: { gte: new Date(dayStart.getTime() - 62 * 86_400_000), lt: dayEnd }, inventoryStatus: { startsWith: "POSTED:RA-" } },
    select: { saleDate: true, saleHour: true, inventoryStatus: true },
  });
  const runOf = (row: { inventoryStatus: string | null }) => (row.inventoryStatus || "").slice("POSTED:".length);
  const earlyRuns = [...new Set(postedRows.filter(beforeCutoff).map(runOf).filter(Boolean))];
  const lateSaleRuns = [...new Set(postedRows.filter((row) => !beforeCutoff(row)).map(runOf).filter(Boolean))];
  const runDocs = earlyRuns.length + lateSaleRuns.length === 0 ? [] : await tx.inventoryTransaction.findMany({
    where: { referenceType: "PRODUCTION", referenceCode: { in: [...earlyRuns, ...lateSaleRuns] }, deletedAt: null, warehouseCode: input.warehouseCode },
    select: { referenceCode: true, transactionDate: true },
  });
  // Lần rã có doanh thu TRƯỚC giờ chốt nhưng phiếu ghi SAU giờ chốt (rã gộp tới cuối tháng):
  // sổ sách tại giờ chốt chưa trừ phần bán đó.
  const late = [...new Set(runDocs.filter((doc) => earlyRuns.includes(doc.referenceCode || "") && doc.transactionDate > input.cutoffAt).map((doc) => doc.referenceCode))];
  if (late.length > 0) {
    warnings.push(`Lần rã ${late.join(", ")} gộp cả doanh thu TRƯỚC giờ chốt nhưng ghi phiếu sau giờ chốt — phần bán đó chưa trừ vào sổ sách. Hoàn tác rồi rã lại, ngày chốt chọn "Rã tới giờ" ${formatVnDateTime(input.cutoffAt).slice(0, 5)}.`);
  }
  // Ngược lại: phiếu ghi TRƯỚC giờ chốt mà gồm cả doanh thu sau giờ chốt / cả ngày không có giờ
  // (phiếu rã cũ mang 07:00 sáng) — sổ sách bị trừ lố phần bán sau giờ chốt.
  const early = [...new Set(runDocs.filter((doc) => lateSaleRuns.includes(doc.referenceCode || "") && doc.transactionDate <= input.cutoffAt).map((doc) => doc.referenceCode))];
  if (early.length > 0) {
    warnings.push(`Lần rã ${early.join(", ")} ghi phiếu trước giờ chốt nhưng gồm cả doanh thu SAU giờ chốt (hoặc doanh thu cả ngày không có giờ) — sổ sách đang bị trừ lố. Hoàn tác và rã lại tới đúng giờ chốt.`);
  }

  const unsplit = await tx.revenueImportRow.count({
    where: { branchCode: input.branchCode, deletedAt: null, productCode: { not: null }, saleDate: { gte: dayStart, lt: dayEnd }, saleHour: null },
  });
  if (unsplit > 0) {
    warnings.push(`${unsplit} dòng doanh thu POS ngày chốt chỉ có NGÀY, không có giờ bán — không chia được trước/sau ${formatVnDateTime(input.cutoffAt).slice(0, 5)}. Import lại file POS có cột Thời gian kèm giờ (dd/mm/yyyy hh:mm).`);
  }
  if (cutoffLocal.getUTCMinutes() > 0) {
    warnings.push(`Giờ chốt lẻ phút: doanh thu có giờ bán ${cutoffLocal.getUTCHours()}h được tính TRƯỚC giờ chốt (dữ liệu chia theo giờ tròn). Nên chốt giờ tròn.`);
  }

  const others = await tx.stocktakeSession.findMany({
    where: { warehouseCode: input.warehouseCode, locationCode: { not: null }, status: { in: [STOCKTAKE_PENDING, "RETURNED", "DRAFT"] }, id: { notIn: input.selectedIds } },
    select: { code: true, locationCode: true, status: true },
  });
  if (others.length > 0) {
    warnings.push(`Kho còn ${others.length} phiếu đếm chưa chọn (${others.slice(0, 6).map((row) => `${row.code} · ${row.locationCode}`).join(", ")}${others.length > 6 ? "…" : ""}). Mã chỉ nằm trên các phiếu đó sẽ bị tính đếm = 0.`);
  }
  return warnings;
}

export async function approveStocktakeBatch(
  tx: Tx,
  input: { stocktakeIds: string[]; cutoffAt: Date; unitCosts?: Record<string, number>; approvedBy: string; note?: string | null },
) {
  const preview = await buildBatchPreview(tx, input);
  const missing = preview.rows.filter((row) => row.needsUnitCost);
  if (missing.length > 0) {
    batchError(`Chưa có đơn giá cho phần thừa của ${missing.map((row) => row.itemCode).slice(0, 8).join(", ")}${missing.length > 8 ? "…" : ""}. Nhập đơn giá ở bảng tổng hợp rồi duyệt lại.`);
  }
  const later = await tx.stocktakeBatch.findFirst({
    where: { warehouseCode: preview.warehouseCode, status: STOCKTAKE_BATCH_APPROVED, cutoffAt: { gte: preview.cutoffAt } },
    orderBy: { cutoffAt: "desc" },
  });
  if (later) {
    batchError(`Kho ${preview.warehouseCode} đã có đợt ${later.code} chốt lúc ${formatVnDateTime(later.cutoffAt)} — không duyệt được đợt có giờ chốt sớm hơn hoặc bằng. Mở lại đợt đó trước.`);
  }

  const code = await nextStocktakeBatchCode(tx, preview.cutoffAt);
  const batch = await tx.stocktakeBatch.create({
    data: {
      code,
      branchCode: preview.branchCode,
      warehouseCode: preview.warehouseCode,
      cutoffAt: preview.cutoffAt,
      status: STOCKTAKE_BATCH_APPROVED,
      approvedBy: input.approvedBy,
      approvedAt: new Date(),
      note: [input.note || "", `Phiếu đếm: ${preview.sheets.map((sheet) => `${sheet.code} (${sheet.locationCode})`).join(", ")}`].filter(Boolean).join(" · "),
    },
  });

  const variances = preview.rows.filter(hasVariance);
  const surplus = variances.filter((row) => row.varianceQuantity > 0);
  const shortage = variances.filter((row) => row.varianceQuantity < 0);
  const base = {
    transactionDate: preview.cutoffAt,
    branchCode: preview.branchCode,
    warehouseCode: preview.warehouseCode,
    referenceType: "STOCKTAKE",
    referenceId: batch.id,
    referenceCode: code,
    note: `Kiểm kê chốt ${formatVnDateTime(preview.cutoffAt)}`,
    createdBy: input.approvedBy,
  };
  const docs = [];
  if (surplus.length > 0) docs.push(await postInventoryTransaction(tx, {
    ...base,
    code: `${code}-N`,
    transactionType: "NHAP_KIEM_KE",
    lines: surplus.map((row) => ({ itemId: row.itemId, inputQuantity: row.varianceQuantity, inputUnitCode: row.unit, inputUnitCost: row.unitCost })),
  }));
  if (shortage.length > 0) docs.push(await postInventoryTransaction(tx, {
    ...base,
    code: `${code}-X`,
    transactionType: "XUAT_KIEM_KE",
    lines: shortage.map((row) => ({ itemId: row.itemId, inputQuantity: Math.abs(row.varianceQuantity), inputUnitCode: row.unit, inputUnitCost: 0 })),
  }));

  // Giá trị thật lấy từ dòng phiếu đã ghi (phần thiếu xuất theo bình quân kho lúc ghi).
  const postedCost = new Map<string, number>();
  for (const doc of docs) for (const line of doc.lines) postedCost.set(line.itemId, line.unitCost);
  const lineData = preview.rows.map((row) => {
    const unitCost = postedCost.get(row.itemId) ?? row.unitCost;
    return {
      batchId: batch.id,
      itemId: row.itemId,
      bookQuantity: row.bookQuantity,
      countedQuantity: row.countedQuantity,
      varianceQuantity: row.varianceQuantity,
      unitCost,
      varianceValue: row.varianceQuantity * unitCost,
      breakdownJson: JSON.stringify(row.breakdown),
      notCounted: row.notCounted,
    };
  });
  if (lineData.length > 0) await tx.stocktakeBatchLine.createMany({ data: lineData });
  const shortageValue = lineData.filter((line) => line.varianceQuantity < 0).reduce((sum, line) => sum + line.varianceValue, 0);
  const surplusValue = lineData.filter((line) => line.varianceQuantity > 0).reduce((sum, line) => sum + line.varianceValue, 0);
  await tx.stocktakeBatch.update({ where: { id: batch.id }, data: { shortageValue, surplusValue } });

  const approvedAt = new Date();
  await tx.stocktakeSession.updateMany({
    where: { id: { in: preview.sheets.map((sheet) => sheet.id) } },
    data: { status: STOCKTAKE_APPROVED, approvedBy: input.approvedBy, approvedAt, batchId: batch.id },
  });
  return { batch: { ...batch, shortageValue, surplusValue }, documents: docs.map((doc) => doc.code), preview };
}

/**
 * Mở lại đợt đã duyệt: đảo phiếu điều chỉnh, phiếu đếm về Chờ duyệt. Chặn khi đã có đợt SAU trên
 * cùng kho (sổ sách của đợt sau tính trên kết quả đợt này) — mở lại từ đợt mới nhất trở về.
 */
export async function reopenStocktakeBatch(tx: Tx, input: { batchId: string; reopenedBy: string }) {
  const batch = await tx.stocktakeBatch.findUnique({ where: { id: input.batchId }, include: { sessions: { select: { id: true } } } });
  if (!batch) batchError("Không tìm thấy đợt kiểm kê");
  if (batch.status !== STOCKTAKE_BATCH_APPROVED) batchError(`Đợt ${batch.code} không ở trạng thái Đã duyệt.`);
  const later = await tx.stocktakeBatch.findFirst({
    where: { warehouseCode: batch.warehouseCode, status: STOCKTAKE_BATCH_APPROVED, cutoffAt: { gt: batch.cutoffAt } },
    orderBy: { cutoffAt: "asc" },
  });
  if (later) batchError(`Kho ${batch.warehouseCode} đã có đợt ${later.code} chốt sau (${formatVnDateTime(later.cutoffAt)}). Mở lại đợt đó trước.`);

  const documents = await tx.inventoryTransaction.findMany({
    where: { referenceType: "STOCKTAKE", referenceId: batch.id, deletedAt: null },
    include: { lines: true },
  });
  const now = new Date();
  for (const doc of documents) {
    await reverseStockEffect(tx, doc);
    await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: now, deletedBy: input.reopenedBy } });
  }
  if (documents.length > 0) {
    await tx.journalEntry.deleteMany({ where: { sourceType: "INVENTORY_ISSUE", sourceId: { in: documents.map((doc) => doc.id) } } });
  }
  await tx.stocktakeSession.updateMany({
    where: { batchId: batch.id },
    data: { status: STOCKTAKE_PENDING, approvedBy: null, approvedAt: null, batchId: null },
  });
  const updated = await tx.stocktakeBatch.update({
    where: { id: batch.id },
    data: { status: STOCKTAKE_BATCH_REOPENED, reopenedBy: input.reopenedBy, reopenedAt: now },
  });
  return { batch: updated, documents: documents.map((doc) => doc.code), sessionIds: batch.sessions.map((session) => session.id) };
}
