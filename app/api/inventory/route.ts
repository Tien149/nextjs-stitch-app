import { NextResponse } from "next/server";
import { Prisma } from "@prisma/custom-client";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, type TxClient } from "@/lib/prisma";
import { apiError, assertPeriodOpen, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess, repostInventoryCogs } from "@/lib/accounting";
import { allowedWarehousesOf, assertWarehouseAccess, scopeWarehouses } from "@/lib/warehouse-scope";
import { isWasteSubType, normalizeStockTransactionType, normalizeWasteSubType, postInventoryTransaction, repostInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { createPurchasePayable, purchasePayableCodeOf, removePurchasePayables, syncPurchasePayable, PURCHASE_PAYABLE_SOURCE } from "@/lib/purchase-payable";
import { postStockTransfer, syncTransferInternalDebt } from "@/lib/inventory-transfer";
import { STOCKTAKE_APPROVED, STOCKTAKE_PENDING, STOCKTAKE_RETURNED, isStocktakeEditable, stocktakeStatusLabel } from "@/lib/stocktake-status";
import { EXPLOSION_ISSUE_TYPES, EXPLOSION_PENDING, explodedRunOf, isExplosionIssueType, loadPendingExplosionSources, refreshTransferExplosionStatus, releaseExplosionSources, semiFinishedWithRecipeChecker } from "@/lib/explosion-sources";
import { averageCostByItem } from "@/lib/inventory-average-cost";
import { parseVatRate, VAT_RATE_CODES } from "@/lib/inventory-vat";
import { computeCostingLevels, computeRecipeUnitCosts, lineConversionRate, pickRecipeForDate, recipeContentSignature, type ExplosionRecipe } from "@/lib/production-explosion";
import { writeAuditLog } from "@/lib/audit-log";
import { executeExplosion, rerunExplosions, type AffectedExplosionRun } from "@/lib/inventory-explosion";
import {
  duplicatedInTrashMessage,
  findDeletedByUnique,
  softDeleteRecord,
  SoftDeleteError,
} from "@/lib/soft-delete";
import { scopePayloadByTab } from "@/lib/tab-scope";
import { isWarehouseStocktakeItemType } from "@/lib/inventory-scope";
import { nextStockDocCode, nextStocktakeCode } from "@/lib/inventory-stock";
import { isRevenueGroupCategory, normalizeRevenueExpenseGroup } from "@/lib/voucher-rules";
import { loadNonInventoryRevenueGroups, tracksInventory, type CategoryLookupClient } from "@/lib/revenue-source";
import { safeConversionRate } from "@/lib/unit-conversion";
import { explosionPostingDate } from "@/lib/revenue-date";

const menuHref = "/inventory";

/** Sai số cho phép khi so sánh số lượng tồn kho (Float). */
const quantityEpsilon = 0.000001;
/** Đề nghị/đơn mua hàng còn hiệu lực -> mặt hàng đang được sử dụng. */
const openRequestStatuses = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED"];
const openOrderStatuses = ["DRAFT", "APPROVED", "PARTIALLY_RECEIVED"];
/** Phiếu kho sinh tự động từ nghiệp vụ khác thì phải xử lý ở chứng từ gốc. */
const derivedReferenceTypes: Record<string, string> = {
  STOCKTAKE: "phiếu kiểm kê",
  PURCHASE_ORDER: "đơn mua hàng",
  PRODUCTION: "lệnh chế biến",
};

type InputLine = { itemId?: unknown; itemCode?: unknown; quantity?: unknown; actualQuantity?: unknown; inputQuantity?: unknown; unitCode?: unknown; inputUnitCode?: unknown; unitCost?: unknown; inputUnitCost?: unknown; vatRate?: unknown; vatAmount?: unknown; wasteRate?: unknown; conversionRate?: unknown; reason?: unknown };
const validItemTypes = ["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED", "PACKAGING", "TOOL", "ASSET"];

/**
 * Thue suat GTGT tu man hinh gui len ("8%", "KKKNT", o trong). Gia tri la thi chan ngay thay vi
 * nhan bua thanh 0%: sai thue suat la sai so cong no phai tra NCC.
 */
function vatRateFrom(value: unknown) {
  const parsed = parseVatRate(value);
  if (!parsed.ok) businessError(`Thuế suất GTGT [${cleanText(value)}] không hợp lệ. Chỉ nhận: ${VAT_RATE_CODES.join(", ")}`);
  return (parsed as { ok: true; rate: number | null }).rate;
}

function linesFrom(value: unknown) {
  if (!Array.isArray(value)) return [];
  return (value as InputLine[]).map((line) => ({
    itemId: cleanText(line.itemId),
    itemCode: cleanText(line.itemCode),
    quantity: toNumber(line.inputQuantity ?? line.quantity),
    inputQuantity: toNumber(line.inputQuantity ?? line.quantity),
    unitCode: cleanText(line.inputUnitCode ?? line.unitCode),
    inputUnitCode: cleanText(line.inputUnitCode ?? line.unitCode),
    unitCost: toNumber(line.inputUnitCost ?? line.unitCost),
    inputUnitCost: toNumber(line.inputUnitCost ?? line.unitCost),
    vatRate: vatRateFrom(line.vatRate),
    // Ô "Tiền thuế" để trống thì KHÔNG gửi số 0 xuống: 0 là một lời khai (thuế đúng bằng 0),
    // còn để trống nghĩa là cứ tính theo thuế suất như cũ.
    vatAmount: cleanText(line.vatAmount) === "" ? undefined : toNumber(line.vatAmount),
    wasteRate: toNumber(line.wasteRate),
    conversionRate: toNumber(line.conversionRate),
  })).filter((line) => (line.itemId || line.itemCode) && line.quantity > 0);
}

function stocktakeLinesFrom(value: unknown) {
  if (!Array.isArray(value)) return [];
  return (value as (InputLine & { systemQuantity?: unknown })[]).map((line) => ({
    itemId: cleanText(line.itemId),
    itemCode: cleanText(line.itemCode),
    actualQuantity: toNumber(line.actualQuantity ?? line.quantity),
    // Số tồn NGƯỜI ĐẾM đã thấy lúc chốt số — server so với tồn hiện tại để phát hiện tồn đã
    // đổi giữa lúc mở màn hình và lúc duyệt (bán hàng trong ngày...). Không gửi thì bỏ kiểm.
    systemQuantity: line.systemQuantity === undefined || line.systemQuantity === null || line.systemQuantity === "" ? null : toNumber(line.systemQuantity),
    unitCost: toNumber(line.unitCost ?? line.inputUnitCost),
    reason: cleanText(line.reason),
  })).filter((line) => (line.itemId || line.itemCode) && Number.isFinite(line.actualQuantity) && line.actualQuantity >= 0);
}

/** Ngày theo lịch máy chủ dạng YYYY-MM-DD — toISOString đổi sang UTC nên lệch ngày ở múi giờ +07. */
function isoDay(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function stockPrefix(transactionType: string) {
  if (transactionType === "NHAP_MUA") return "NM";
  if (transactionType === "NHAP_KHAC") return "NK";
  if (transactionType === "NHAP_CHE_BIEN") return "NCB";
  if (transactionType === "NHAP_KIEM_KE") return "NKK";
  if (transactionType === "XUAT_BAN") return "XB";
  if (transactionType === "XUAT_HUY") return "HH";
  if (transactionType === "XUAT_TEST_MON") return "XTM";
  if (transactionType === "XUAT_CHE_BIEN") return "XCB";
  if (transactionType === "XUAT_KIEM_KE") return "XKK";
  if (transactionType === "DIEU_CHUYEN") return "DCK";
  return "XK";
}

function normalizeItemType(value: unknown) {
  const raw = cleanText(value).toUpperCase();
  if (!raw || raw === "MATERIAL" || raw === "RAW" || raw === "NVL") return "RAW_MATERIAL";
  if (raw === "BTP" || raw === "SEMI" || raw === "SEMI_FINISHED_GOOD") return "SEMI_FINISHED";
  if (raw === "TP" || raw === "PRODUCT" || raw === "FINISHED_GOOD") return "FINISHED";
  return raw;
}


/** Phân nhóm mặt hàng phải tồn tại, còn hoạt động và thuộc đúng loại mặt hàng. */
async function resolveItemCategory(itemType: string, value: unknown) {
  const categoryCode = cleanText(value).toUpperCase();
  if (!categoryCode) return null;
  const group = await prisma.masterDataItem.findFirst({
    where: { type: "INVENTORY_ITEM_GROUP", code: categoryCode, status: "ACTIVE" },
  });
  if (!group) businessError(`Phân nhóm [${categoryCode}] không tồn tại hoặc đã ngưng hoạt động.`);
  const groupType = (group?.group || "").toUpperCase();
  if (groupType && groupType !== "OTHER" && groupType !== itemType) {
    businessError(`Phân nhóm ${group?.name} thuộc loại ${groupType}, không gán được cho mặt hàng loại ${itemType}.`);
  }
  return group?.code || null;
}

/**
 * Nhóm doanh thu của mặt hàng: mã danh mục Thu/Chi khai ở nhóm NHÓM DOANH THU (REVENUE_SOURCE).
 * Loại thu quỹ (thu tiền thừa, thu đặt cọc, NCC hoàn tiền...) là tiền vào thật nhưng không phải
 * doanh thu nên không gán được — import doanh thu POS dùng đúng mã này làm categoryCode 511.
 *
 * `currentCode` là giá trị đang lưu của mặt hàng: dữ liệu cũ lỡ gán loại thu vẫn sửa được các
 * trường khác mà không bị chặn, giao diện lo phần cảnh báo để người dùng gán lại.
 */
async function resolveItemRevenueGroup(value: unknown, currentCode?: string | null) {
  const code = cleanText(value).toUpperCase();
  if (!code) return null;
  if (code === (currentCode || "").toUpperCase()) return currentCode || null;
  const category = await prisma.masterDataItem.findFirst({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code, status: "ACTIVE" },
  });
  if (!category) businessError(`Nhóm doanh thu [${code}] không tồn tại hoặc đã ngưng hoạt động.`);
  if (!isRevenueGroupCategory(category?.group)) {
    businessError(`Danh mục ${category?.name} là ${normalizeRevenueExpenseGroup(category?.group) === "PAYMENT" ? "danh mục Chi" : "loại thu khác, không phải nhóm doanh thu"}. Khai lại ở Cài đặt > Thu/Chi với nhóm "Thu: Nhóm doanh thu (bán hàng)" rồi gán.`);
  }
  return category?.code || null;
}

/** Dòng định mức khi sửa BOM: báo lỗi rõ ràng thay vì lặng lẽ loại bỏ. */
function editableRecipeLines(value: unknown) {
  if (!Array.isArray(value)) businessError("Danh sách nguyên liệu không hợp lệ");
  const lines = (value as InputLine[]).map((line) => ({
    itemId: cleanText(line.itemId),
    itemCode: cleanText(line.itemCode),
    quantity: toNumber(line.quantity ?? line.inputQuantity),
    unitCode: cleanText(line.unitCode ?? line.inputUnitCode),
    conversionRate: toNumber(line.conversionRate),
    wasteRate: toNumber(line.wasteRate),
  }));
  if (lines.length === 0) businessError("Định lượng cần ít nhất một nguyên liệu");
  for (const line of lines) {
    if (!line.itemId && !line.itemCode) businessError("Nguyên liệu là bắt buộc trên từng dòng");
    if (!(line.quantity > 0)) businessError("Định lượng của từng nguyên liệu phải lớn hơn 0");
    if (line.wasteRate < 0) businessError("Tỷ lệ hao hụt không được âm");
  }
  return lines;
}

async function createOrUpdateConversion(itemId: string, purchaseUnit: string, conversionRate: number, note?: string) {
  if (!purchaseUnit && !conversionRate) return null;
  if (!purchaseUnit) businessError("ĐVT mua là bắt buộc khi khai báo quy đổi");
  if (!Number.isFinite(conversionRate) || conversionRate <= 0) businessError("Tỷ lệ quy đổi phải lớn hơn 0");
  if (conversionRate < 1) businessError("Tỷ lệ quy đổi phải tính từ ĐVT mua về ĐVT cơ bản và không được nhỏ hơn 1");
  const unitCode = purchaseUnit.toUpperCase();
  if (unitCode.length > 32) businessError("ĐVT mua không được vượt quá 32 ký tự");
  // "1 KG = 1000 KG" là khai sai (đúng ra ĐVT tồn là G). Chặn tại đây để không đẻ thêm dữ liệu
  // hỏng — thứ đã làm 1.277 mặt hàng trong danh mục nhân sai số lượng gấp 1000 lần.
  const owner = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { unit: true, code: true } });
  if (owner && unitCode === owner.unit.trim().toUpperCase() && conversionRate !== 1) {
    businessError(`ĐVT mua [${purchaseUnit}] trùng ĐVT tồn kho của ${owner.code} nên tỷ lệ quy đổi phải là 1. Nếu ý bạn là "1 ${purchaseUnit} = ${conversionRate} đơn vị nhỏ hơn" thì hãy sửa ĐVT tồn kho của mặt hàng thành đơn vị nhỏ đó (ví dụ ĐVT tồn G, ĐVT mua KG, tỷ lệ 1000).`);
  }
  return prisma.itemUnitConversion.upsert({
    where: { itemId_unitCode: { itemId, unitCode } },
    create: { itemId, unitCode, unitName: purchaseUnit, conversionRate, isDefaultPurchase: conversionRate > 1, note: note || null },
    update: { unitName: purchaseUnit, conversionRate, isDefaultPurchase: conversionRate > 1, note: note || null },
  });
}

/** Mặt hàng đính kèm trên dòng phiếu: màn hình chỉ đọc mấy cột này, không cần cả bản ghi. */
const lineItemSelect = { id: true, code: true, name: true, unit: true, itemType: true, minStock: true, requiresImage: true } as const;

type MovementLineSource = {
  id: string;
  code: string;
  transactionType: string;
  transactionDate: Date;
  warehouseCode: string;
  toWarehouseCode: string | null;
  referenceCode: string | null;
  lines: Array<{ quantity: number; totalCost: number; item: { code: string; name: string; unit: string } }>;
};

/**
 * Nhật ký nhập/xuất từng dòng của tab Tồn kho. Điều chuyển sinh hai dòng: vế xuất ở kho đi và
 * vế nhập ở kho nhận.
 */
function buildStockMovements(transactions: MovementLineSource[]) {
  const rows: Array<{
    transactionId: string; code: string; transactionType: string; transactionDate: Date;
    warehouseCode: string; toWarehouseCode: string | null; itemCode: string; itemName: string; unit: string;
    quantity: number; inboundQuantity: number; outboundQuantity: number; value: number; referenceCode: string | null;
  }> = [];
  for (const transaction of transactions) {
    const inbound = transaction.transactionType.startsWith("NHAP_");
    const outbound = transaction.transactionType.startsWith("XUAT_") || transaction.transactionType === "DIEU_CHUYEN";
    if (!inbound && !outbound) continue;
    for (const line of transaction.lines) {
      const base = {
        transactionId: transaction.id,
        code: transaction.code,
        transactionType: transaction.transactionType,
        transactionDate: transaction.transactionDate,
        itemCode: line.item.code,
        itemName: line.item.name,
        unit: line.item.unit,
        quantity: line.quantity,
        value: line.totalCost,
        referenceCode: transaction.referenceCode,
      };
      rows.push({
        ...base,
        warehouseCode: transaction.warehouseCode,
        toWarehouseCode: transaction.toWarehouseCode,
        inboundQuantity: inbound ? line.quantity : 0,
        outboundQuantity: inbound ? 0 : line.quantity,
      });
      if (transaction.transactionType === "DIEU_CHUYEN" && transaction.toWarehouseCode) {
        rows.push({ ...base, warehouseCode: transaction.toWarehouseCode, toWarehouseCode: null, inboundQuantity: line.quantity, outboundQuantity: 0 });
      }
    }
  }
  return rows;
}

/**
 * Tổng nhập/xuất từ trước tới nay theo mặt hàng × kho × loại phiếu, cộng sẵn trong SQL. Trước
 * đây GET nạp nguyên lịch sử phiếu kho kèm từng dòng và mặt hàng chỉ để cộng mấy con số này —
 * rã nguyên liệu mỗi ngày sinh hàng trăm dòng nên màn Kho càng dùng lâu càng chậm.
 * `side = 'TO'` là vế nhập của điều chuyển, đứng ở kho nhận.
 */
/**
 * Kỳ của bảng Nhập - Xuất - Tồn ở tab Tồn kho: cùng ô Từ ngày / Đến ngày với nhật ký phát sinh
 * (reportFrom / reportTo). Cắt theo NGÀY UTC như màn hình lọc nhật ký (ngày ISO), để hai bảng
 * khớp nhau. Bỏ trống đầu nào là không chặn đầu đó.
 */
function stockPeriod(searchParams: URLSearchParams) {
  const parse = (value: string | null) => {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const from = parse(searchParams.get("reportFrom"));
  const to = parse(searchParams.get("reportTo"));
  return { from, toEnd: to ? new Date(to.getTime() + 86_400_000) : null };
}

type MovementTotalRow = {
  itemId: string; warehouseCode: string; transactionType: string; side: string;
  /** Phát sinh TRONG kỳ. */
  quantity: number; value: number;
  /** Phát sinh từ đầu kỳ trở đi (để lùi tồn hiện tại về tồn đầu kỳ). */
  afterFromQuantity: number;
  /** Phát sinh sau cuối kỳ (để lùi tồn hiện tại về tồn cuối kỳ). */
  afterToQuantity: number;
};

async function loadMovementTotals(branchCode: string, period: { from: Date | null; toEnd: Date | null } = { from: null, toEnd: null }) {
  const branchSql = branchCode === "ALL" ? Prisma.empty : Prisma.sql`AND t."branchCode" = ${branchCode}`;
  // Không chặn đầu nào thì kỳ = toàn bộ lịch sử: tồn đầu kỳ = tồn hiện tại trừ mọi phát sinh,
  // tồn cuối kỳ = tồn hiện tại — y như trước khi có ô ngày.
  const from = period.from || new Date("1900-01-01T00:00:00Z");
  const toEnd = period.toEnd || new Date("3000-01-01T00:00:00Z");
  const columns = Prisma.sql`
    COALESCE(SUM(l."quantity") FILTER (WHERE t."transactionDate" >= ${from} AND t."transactionDate" < ${toEnd}), 0)::float8 AS quantity,
    COALESCE(SUM(l."totalCost") FILTER (WHERE t."transactionDate" >= ${from} AND t."transactionDate" < ${toEnd}), 0)::float8 AS value,
    COALESCE(SUM(l."quantity") FILTER (WHERE t."transactionDate" >= ${from}), 0)::float8 AS "afterFromQuantity",
    COALESCE(SUM(l."quantity") FILTER (WHERE t."transactionDate" >= ${toEnd}), 0)::float8 AS "afterToQuantity"`;
  return prisma.$queryRaw<MovementTotalRow[]>(Prisma.sql`
    SELECT l."itemId", t."warehouseCode", t."transactionType", 'FROM' AS side, ${columns}
    FROM "InventoryTransactionLine" l
    JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
    WHERE t."deletedAt" IS NULL ${branchSql}
      AND (LEFT(t."transactionType", 5) IN ('NHAP_', 'XUAT_') OR t."transactionType" = 'DIEU_CHUYEN')
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT l."itemId", t."toWarehouseCode", t."transactionType", 'TO' AS side, ${columns}
    FROM "InventoryTransactionLine" l
    JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
    WHERE t."deletedAt" IS NULL ${branchSql}
      AND t."transactionType" = 'DIEU_CHUYEN' AND t."toWarehouseCode" IS NOT NULL
    GROUP BY 1, 2, 3
  `);
}

/**
 * Bảng Nhập - Xuất - Tồn theo kỳ: nhập / xuất = phát sinh trong kỳ; tồn đầu kỳ và cuối kỳ lùi
 * từ tồn HIỆN TẠI của kho bằng phát sinh sau mốc tương ứng. Giá trị tồn cuối kỳ tính theo giá
 * bình quân hiện tại của kho (không lưu lịch sử bình quân theo ngày).
 */
function buildStockSummary<TBalance extends { itemId: string; warehouseCode: string; quantity: number; averageCost: number }>(
  balances: TBalance[],
  movementTotals: MovementTotalRow[],
) {
  type Bucket = { inbound: number; outbound: number; netAfterFrom: number; netAfterTo: number; byType: Record<string, { inbound: number; outbound: number; value: number }> };
  const movements = new Map<string, Bucket>();
  for (const row of movementTotals) {
    const key = `${row.itemId}|${row.warehouseCode}`;
    const bucket = movements.get(key) || { inbound: 0, outbound: 0, netAfterFrom: 0, netAfterTo: 0, byType: {} };
    const sign = row.side === "FROM" && !row.transactionType.startsWith("NHAP_") ? -1 : 1;
    if (sign > 0) bucket.inbound += row.quantity;
    else bucket.outbound += row.quantity;
    bucket.netAfterFrom += sign * row.afterFromQuantity;
    bucket.netAfterTo += sign * row.afterToQuantity;
    if (row.quantity) {
      bucket.byType[row.transactionType] ||= { inbound: 0, outbound: 0, value: 0 };
      if (sign > 0) bucket.byType[row.transactionType].inbound += row.quantity;
      else bucket.byType[row.transactionType].outbound += row.quantity;
      bucket.byType[row.transactionType].value += row.value;
    }
    movements.set(key, bucket);
  }
  return balances.map((balance) => {
    const movement = movements.get(`${balance.itemId}|${balance.warehouseCode}`) || { inbound: 0, outbound: 0, netAfterFrom: 0, netAfterTo: 0, byType: {} };
    const closingQuantity = balance.quantity - movement.netAfterTo;
    return {
      item: (balance as unknown as { item: unknown }).item,
      warehouseCode: balance.warehouseCode,
      openingQuantity: balance.quantity - movement.netAfterFrom,
      inboundQuantity: movement.inbound,
      outboundQuantity: movement.outbound,
      closingQuantity,
      averageCost: balance.averageCost,
      closingValue: closingQuantity * balance.averageCost,
      movementByType: movement.byType,
    };
  });
}

/** Báo cáo hủy hàng cộng trong SQL: mỗi mặt hàng × loại hủy một dòng, đếm số dòng phiếu. */
async function loadWasteTotals(branchCode: string) {
  return prisma.$queryRaw<Array<{ itemId: string; itemCode: string; itemName: string; unit: string; itemType: string; subType: string; quantity: number; value: number; lineCount: number }>>(Prisma.sql`
    SELECT l."itemId", i."code" AS "itemCode", i."name" AS "itemName", i."unit", i."itemType",
           COALESCE(t."subType", 'KHONG_PHAN_LOAI') AS "subType",
           SUM(l."quantity")::float8 AS quantity, SUM(l."totalCost")::float8 AS value, COUNT(*)::int AS "lineCount"
    FROM "InventoryTransactionLine" l
    JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
    JOIN "InventoryItem" i ON i."id" = l."itemId"
    WHERE t."deletedAt" IS NULL AND t."transactionType" = 'XUAT_HUY'
      ${branchCode === "ALL" ? Prisma.empty : Prisma.sql`AND t."branchCode" = ${branchCode}`}
    GROUP BY 1, 2, 3, 4, 5, 6
  `);
}

/**
 * Khoảng ngày của nhật ký nhập/xuất (tab Tồn kho). Màn hình lọc lại đúng theo ngày ISO, nên ở
 * đây nới mỗi đầu một ngày cho khỏi hụt vì lệch múi giờ. Bỏ trống đầu nào là không chặn đầu đó.
 */
function movementDateFilter(searchParams: URLSearchParams) {
  const parse = (value: string | null, shiftDays: number) => {
    if (!value) return undefined;
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return undefined;
    return new Date(date.getTime() + shiftDays * 86_400_000);
  };
  const gte = parse(searchParams.get("reportFrom"), -1);
  const lt = parse(searchParams.get("reportTo"), 2);
  return gte || lt ? { transactionDate: { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) } } : {};
}

async function loadStockMovements(branchFilter: { branchCode?: string }, searchParams: URLSearchParams) {
  const transactions = await prisma.inventoryTransaction.findMany({
    where: { ...branchFilter, ...movementDateFilter(searchParams) },
    select: {
      id: true, code: true, transactionType: true, transactionDate: true, warehouseCode: true, toWarehouseCode: true, referenceCode: true,
      lines: { select: { quantity: true, totalCost: true, item: { select: { code: true, name: true, unit: true } } } },
    },
    orderBy: { transactionDate: "asc" },
  });
  return buildStockMovements(transactions);
}

/**
 * Lõi của nút "Rã nguyên liệu từ doanh thu" — tách riêng để RÃ LẠI được sau khi sửa định lượng
 * (UPDATE_RECIPE / CREATE_RECIPE lùi ngày áp dụng) bằng đúng một đường code với lần rã gốc.
 * Chạy trong transaction của người gọi; không kiểm tra quyền, cửa hàng, kho, khoá sổ — người
 * gọi làm việc đó.
 */
/** Một lần rã (RA-...) đã dùng định lượng của món vừa sửa. */

/**
 * Sửa định lượng mà lần rã cũ đã dùng thì phải hỏi lại người dùng trước khi rã lại —
 * ném lỗi này ra khỏi transaction để huỷ mọi thay đổi, route bắt lại trả danh sách lần rã.
 */
class RecipeRerunConfirmation extends Error {
  constructor(public runs: AffectedExplosionRun[]) {
    super("RECIPE_RERUN_CONFIRMATION");
  }
}

async function loadRecipeVersions(tx: TxClient, productCode: string) {
  const recipes = await tx.recipe.findMany({
    where: { productCode: { equals: productCode, mode: "insensitive" }, deletedAt: null },
    include: { lines: { include: { item: true } } },
  });
  return recipes as unknown as ExplosionRecipe[];
}

/**
 * Các lần rã (còn sống) có món này mà định lượng áp cho ĐÚNG ngày + cửa hàng của lần rã đó
 * đã khác đi sau thay đổi: sửa dòng nguyên liệu, đổi ngày áp dụng, hay thêm phiên bản lùi
 * ngày. Chỉ so NỘI DUNG định lượng (recipeContentSignature) — sửa tên hay giá bán không cần
 * rã lại. Lần rã dùng bản riêng của cửa hàng khác thì không bị kéo theo.
 *
 * Lần rã chọn phiên bản theo ngày cuối khoảng rã (dateTo = ngày chứng từ), nên ở đây cũng so
 * theo ngày chứng từ.
 */
async function findRunsAffectedByRecipes(
  tx: TxClient,
  productCodes: string[],
  before: ExplosionRecipe[],
  after: ExplosionRecipe[],
): Promise<AffectedExplosionRun[]> {
  const codes = [...new Set(productCodes.map((code) => code.toUpperCase()))];
  const items = await tx.inventoryItem.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  if (items.length === 0) return [];
  const codeById = new Map(items.map((item) => [item.id, item.code.toUpperCase()]));
  const documents = await tx.inventoryTransaction.findMany({
    where: {
      referenceType: "PRODUCTION",
      referenceCode: { startsWith: "RA-" },
      deletedAt: null,
      lines: { some: { itemId: { in: items.map((item) => item.id) } } },
    },
    select: { referenceCode: true, branchCode: true, transactionDate: true, lines: { select: { itemId: true } } },
  });
  const runs = new Map<string, AffectedExplosionRun>();
  for (const doc of documents) {
    const runCode = doc.referenceCode || "";
    if (!runCode) continue;
    const run = runs.get(runCode) || { runCode, branchCode: doc.branchCode, date: doc.transactionDate, productCodes: [] };
    // Ngày của lần rã = ngày muộn nhất trên phiếu (phiếu cho điều chuyển / kiểm kê mang ngày riêng).
    if (doc.transactionDate > run.date) run.date = doc.transactionDate;
    for (const line of doc.lines) {
      const code = codeById.get(line.itemId);
      if (code && !run.productCodes.includes(code)) run.productCodes.push(code);
    }
    runs.set(runCode, run);
  }
  const versionsOf = (list: ExplosionRecipe[], code: string) => list.filter((recipe) => recipe.productCode.toUpperCase() === code);
  return [...runs.values()]
    .filter((run) => run.productCodes.some((code) =>
      recipeContentSignature(pickRecipeForDate(versionsOf(before, code), run.date, run.branchCode))
        !== recipeContentSignature(pickRecipeForDate(versionsOf(after, code), run.date, run.branchCode))))
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.runCode.localeCompare(b.runCode));
}

/** Sau khi commit: ghi nhật ký cho từng lần rã mới để lần sửa định lượng sau còn rã lại được nó. */
async function logRecipeReruns(
  session: Parameters<typeof writeAuditLog>[0]["session"],
  reruns: Awaited<ReturnType<typeof rerunExplosions>>,
  recipeCode: string,
) {
  for (const rerun of reruns) {
    if (!rerun.newRunCode) continue;
    await writeAuditLog({
      session, module: menuHref, action: "EXPLODE_PRODUCTION",
      entityType: "InventoryTransaction", entityCode: rerun.newRunCode, branchCode: rerun.branchCode,
      metadata: {
        ...rerun.settings,
        dateTo: rerun.date,
        rerunOf: rerun.oldRunCode,
        reason: `Sửa định lượng ${recipeCode}`,
        documents: rerun.documents,
      },
    });
  }
}

/**
 * Sau khi rã / rã lại commit: tự ghi sổ lại giá vốn theo kho của đúng các kỳ x cửa hàng có phiếu
 * đổi (khách chốt 28/09/2026), để P&L không phải chờ bấm Ghi sổ kỳ. Phiếu cũ của lần rã lại có
 * cùng ngày với phiếu mới (cùng nguồn, cùng ngày chốt) nên chỉ cần ngày của phiếu mới + ngày lần rã.
 */
async function repostCogsForReruns(
  reruns: Awaited<ReturnType<typeof rerunExplosions>>,
  extra: Array<{ date: Date | string; branchCode: string | null | undefined }>,
  actor: string,
) {
  const codes = reruns.flatMap((rerun) => rerun.documents);
  const documents = codes.length > 0
    ? await prisma.inventoryTransaction.findMany({ where: { code: { in: codes } }, select: { transactionDate: true, branchCode: true } })
    : [];
  return repostInventoryCogs([
    ...reruns.map((rerun) => ({ date: rerun.date, branchCode: rerun.branchCode })),
    ...documents.map((doc) => ({ date: doc.transactionDate, branchCode: doc.branchCode })),
    ...extra,
  ], actor);
}

/** Câu trả lời 409 "cần xác nhận rã lại" dùng chung cho tạo và sửa định lượng. */
function rerunConfirmationResponse(error: RecipeRerunConfirmation) {
  return NextResponse.json({
    needsRerunConfirm: true,
    affectedRuns: error.runs.map((run) => ({
      runCode: run.runCode,
      branchCode: run.branchCode,
      date: run.date,
      productCodes: run.productCodes,
    })),
    error: `Định lượng này đã được dùng ở ${error.runs.length} lần rã nguyên liệu. Xác nhận để gỡ và rã lại theo định lượng mới.`,
  }, { status: 409 });
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const branchCode = requestedBranch(auth.session, searchParams.get("branchCode") || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };
    // Phạm vi kho của người dùng (xếp chồng lên phạm vi cửa hàng): null = mọi kho của cửa hàng.
    const scopedWarehouseCodes = allowedWarehousesOf(auth.session);
    const inScopedWarehouses = scopedWarehouseCodes ? { in: scopedWarehouseCodes, mode: "insensitive" as const } : undefined;
    const warehouseFilter = inScopedWarehouses
      ? { OR: [{ warehouseCode: inScopedWarehouses }, { toWarehouseCode: inScopedWarehouses }] }
      : {};
    const inScope = (warehouseCode: string | null | undefined) =>
      !scopedWarehouseCodes || scopedWarehouseCodes.includes((warehouseCode || "").toUpperCase());

    // Đổi khoảng ngày của nhật ký nhập/xuất ở tab Tồn kho chỉ cần tải lại đúng phần đó.
    if (searchParams.get("view") === "movements") {
      // Cùng khoảng ngày với bảng Nhập - Xuất - Tồn nên trả luôn bảng đó theo kỳ mới.
      const periodWarehouses = await prisma.masterDataItem.findMany({
        where: { type: "WAREHOUSE", ...(branchCode === "ALL" ? {} : { branch: branchCode }) },
        select: { code: true },
      });
      const [stockMovements, periodBalances, periodTotals] = await Promise.all([
        loadStockMovements(branchFilter, searchParams).then((rows) => rows.filter((row) => inScope(row.warehouseCode))),
        prisma.inventoryBalance.findMany({
          where: { warehouseCode: { in: scopeWarehouses(auth.session, periodWarehouses).map((row) => row.code) } },
          include: { item: true },
          orderBy: [{ warehouseCode: "asc" }, { item: { name: "asc" } }],
        }),
        loadMovementTotals(branchCode, stockPeriod(searchParams)),
      ]);
      const stockSummary = buildStockSummary(periodBalances, periodTotals);
      return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { stockMovements, stockSummary }));
    }

    /**
     * Khoảng ngày của danh sách phiếu trên hai màn Nhập kho / Xuất kho. Trước đây chỉ lấy 100
     * chứng từ mới nhất theo createdAt, nên rã nguyên liệu cả tháng xong là phiếu xuất bán của
     * những ngày đầu rơi mất và người dùng tưởng hệ thống không sinh phiếu (feedback khách
     * 05/09/2026). Mặc định 90 ngày gần nhất; người dùng chọn lại khoảng ngày thì lấy đúng khoảng đó.
     */
    const flowTo = new Date(searchParams.get("flowTo") || Date.now());
    if (Number.isNaN(flowTo.getTime())) flowTo.setTime(Date.now());
    flowTo.setHours(23, 59, 59, 999);
    const flowFromParam = searchParams.get("flowFrom");
    const flowFrom = flowFromParam ? new Date(flowFromParam) : new Date(flowTo.getTime() - 90 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(flowFrom.getTime())) flowFrom.setTime(flowTo.getTime() - 90 * 24 * 60 * 60 * 1000);
    flowFrom.setHours(0, 0, 0, 0);

    // Get warehouses belonging to this branch
    const allowedWarehouses = await prisma.masterDataItem.findMany({
      where: {
        type: "WAREHOUSE",
        ...(branchCode === "ALL" ? {} : { branch: branchCode }),
      },
      select: { code: true }
    });
    const warehouseCodes = scopeWarehouses(auth.session, allowedWarehouses).map((w) => w.code);

    const [items, balances, transactions, flowTransactions, transferTransactions, wasteTransactions, movementTotals, wasteTotals, stockMovements, recipes, warehouses, stocktakes, itemGroups, receiptCategoryList, pendingRevenueRows, partners, allBalances, nonInventoryGroups] = await Promise.all([
      prisma.inventoryItem.findMany({ include: { unitConversions: { orderBy: [{ isDefaultPurchase: "desc" }, { unitCode: "asc" }] } }, orderBy: { name: "asc" } }),
      prisma.inventoryBalance.findMany({
        where: { warehouseCode: { in: warehouseCodes } },
        include: { item: true },
        orderBy: [{ warehouseCode: "asc" }, { item: { name: "asc" } }]
      }),
      prisma.inventoryTransaction.findMany({
        where: { ...branchFilter, ...warehouseFilter },
        include: { lines: { include: { item: { select: lineItemSelect } } } },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      // Danh sách phiếu của hai màn Nhập kho / Xuất kho: lọc theo NGÀY CHỨNG TỪ chứ không cắt
      // 100 dòng mới nhất, để phiếu xuất bán của cả kỳ đã rã đều hiện đủ.
      prisma.inventoryTransaction.findMany({
        where: { ...branchFilter, ...warehouseFilter, transactionDate: { gte: flowFrom, lte: flowTo } },
        include: { lines: { include: { item: { select: lineItemSelect } } } },
        orderBy: { transactionDate: "desc" },
        take: 2000,
      }),
      // Tab Điều chuyển: truy vấn riêng theo khoảng ngày chứng từ, để phiếu xuất bán sinh từ rã
      // BOM (hàng nghìn dòng/tháng) không đẩy phiếu điều chuyển ra khỏi giới hạn của danh sách chung.
      prisma.inventoryTransaction.findMany({
        where: { ...branchFilter, ...warehouseFilter, transactionType: "DIEU_CHUYEN", transactionDate: { gte: flowFrom, lte: flowTo } },
        include: { lines: { include: { item: { select: lineItemSelect } } } },
        orderBy: [{ transactionDate: "desc" }, { code: "desc" }],
        take: 2000,
      }),
      // Tab Hủy hàng: danh sách phiếu hủy theo cùng khoảng ngày chứng từ, cùng lý do như trên.
      prisma.inventoryTransaction.findMany({
        where: { ...branchFilter, ...warehouseFilter, transactionType: "XUAT_HUY", transactionDate: { gte: flowFrom, lte: flowTo } },
        include: { lines: { include: { item: { select: lineItemSelect } } } },
        orderBy: [{ transactionDate: "desc" }, { code: "desc" }],
        take: 2000,
      }),
      loadMovementTotals(branchCode, stockPeriod(searchParams)),
      loadWasteTotals(branchCode),
      loadStockMovements(branchFilter, searchParams).then((rows) => rows.filter((row) => inScope(row.warehouseCode))),
      prisma.recipe.findMany({ include: { lines: { include: { item: { select: lineItemSelect } } } }, orderBy: { updatedAt: "desc" } }),
      prisma.masterDataItem.findMany({
        where: {
          type: "WAREHOUSE", status: "ACTIVE",
          ...(branchCode === "ALL" ? {} : { branch: branchCode }),
          ...(inScopedWarehouses ? { code: inScopedWarehouses } : {}),
        },
        orderBy: [{ branch: "asc" }, { code: "asc" }],
      }),
      // Phiếu còn chờ duyệt / bị trả lại luôn phải hiện (kế toán cần duyệt, nhà hàng cần sửa) dù đã
      // cũ; phiếu mới cập nhật lên đầu.
      prisma.stocktakeSession.findMany({
        where: {
          ...(branchCode === "ALL" ? {} : { branchCode }),
          ...(inScopedWarehouses ? { warehouseCode: inScopedWarehouses } : {}),
          OR: [{ status: { not: "APPROVED" } }, { updatedAt: { gte: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000) } }],
        },
        include: { lines: { include: { item: true } } },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      prisma.masterDataItem.findMany({
        where: { type: "INVENTORY_ITEM_GROUP", status: "ACTIVE" },
        orderBy: { name: "asc" },
      }),
      // Danh mục Thu để phục vụ cột "Nhóm doanh thu" của mặt hàng: lấy cả nhóm doanh thu (ô chọn)
      // lẫn loại thu quỹ (chỉ để gọi tên mã đang bị gán sai), bỏ hẳn nhóm Chi. Việc tách hai
      // danh sách làm ở dưới cho khỏi phải hai lần truy vấn.
      prisma.masterDataItem.findMany({
        where: { type: "REVENUE_EXPENSE_CATEGORY", status: "ACTIVE", NOT: { group: "PAYMENT" } },
        select: { id: true, code: true, name: true, group: true },
        orderBy: { name: "asc" },
      }),
      // Dòng doanh thu có mã hàng nhưng CHƯA rã nguyên liệu — nguồn của nút "Rã nguyên liệu".
      prisma.revenueImportRow.findMany({
        where: { inventoryStatus: "PENDING", productCode: { not: null }, deletedAt: null, ...branchFilter },
        orderBy: [{ saleDate: "asc" }, { branchCode: "asc" }],
        select: { id: true, saleDate: true, branchCode: true, productCode: true, productQuantity: true, revenueSource: true },
        take: 2000,
      }),
      // Danh mục đối tác để gọi TÊN nhà cung cấp trên phiếu nhập/xuất (phiếu chỉ lưu mã).
      // Lấy cả đối tác đã Ngưng: phiếu cũ vẫn phải hiện đúng tên NCC lúc mua.
      prisma.masterDataItem.findMany({
        where: { type: "PARTNER" },
        select: { code: true, name: true, group: true, status: true },
        orderBy: { name: "asc" },
      }),
      // Giá vốn bình quân toàn hệ thống của từng mặt hàng (tổng giá trị / tổng tồn mọi kho)
      // — dùng cho cost định lượng, không phụ thuộc bộ lọc cửa hàng của màn hình.
      prisma.inventoryBalance.findMany({ select: { itemId: true, quantity: true, averageCost: true } }),
      loadNonInventoryRevenueGroups(prisma as unknown as CategoryLookupClient),
    ]);

    // Bảng tra kho -> cửa hàng cho bộ lọc Cửa hàng ở tab Tồn kho. Lấy cả kho đã ngưng: kho ngưng
    // vẫn còn tồn / phát sinh cũ, danh sách `warehouses` (chỉ kho đang dùng) không gọi được cửa hàng.
    const warehouseBranches = await prisma.masterDataItem.findMany({
      where: { type: "WAREHOUSE" },
      select: { code: true, branch: true },
    });

    // Cùng một luật với nút "Tính giá vốn & giá thành" — xem lib/inventory-average-cost.ts
    // (trước đây chỗ này cộng cả kho tồn âm, giá bình quân vọt gấp chục lần).
    const averageCostByItemId = averageCostByItem(allBalances);

    // Cost đa cấp theo định lượng: BTP trong định lượng món lấy cost từ định lượng của
    // chính BTP đó (không cần BTP có tồn kho), NVL lấy giá vốn bình quân.
    const explosionRecipes = recipes as unknown as ExplosionRecipe[];
    // Định lượng khai theo cửa hàng: cùng một món mỗi nơi pha một kiểu nên cost phải tính
    // RIÊNG từng phạm vi — bản dùng chung, rồi từng cửa hàng có công thức riêng. Tính một
    // lần cho tất cả rồi tra ra là bản riêng của cửa hàng không bị gán cost của bản chung.
    const recipeScopes = [...new Set(["", ...explosionRecipes.map((recipe) => (recipe.branchCode || "").toUpperCase())])];
    const unitCostsByScope = new Map(recipeScopes.map((scope) => [
      scope,
      computeRecipeUnitCosts(explosionRecipes, averageCostByItemId, new Date(), scope || undefined),
    ]));
    const unitCostOfRecipe = (productCode: string, branchCode?: string | null) => {
      const scope = (branchCode || "").toUpperCase();
      const costs = unitCostsByScope.get(scope) || unitCostsByScope.get("");
      return costs?.get(productCode.toUpperCase());
    };
    /**
     * Cost tính theo CHÍNH các dòng của từng phiên bản (bảng chi tiết tách mỗi nguyên liệu một
     * dòng như file import, nên phải có cost từng dòng). Trước đây mọi phiên bản của một món đều
     * hiện cost của bản đang áp dụng hôm nay — V1 cũ nhìn như trùng V2.
     * Thành phần là BTP có định lượng thì lấy cost theo định lượng của BTP đó, NVL lấy bình quân.
     */
    const recipesWithCost = recipes.map((recipe) => {
      const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
      const lines = recipe.lines.map((line) => {
        const componentRecipeCost = unitCostOfRecipe(line.item.code, recipe.branchCode);
        const componentUnitCost = Number.isFinite(componentRecipeCost)
          ? (componentRecipeCost as number)
          : averageCostByItemId.get(line.itemId) || 0;
        const quantityBase = line.quantity * lineConversionRate(line as unknown as ExplosionRecipe["lines"][number]) * (1 + line.wasteRate / 100);
        return { ...line, quantityBase, componentUnitCost, lineCost: quantityBase * componentUnitCost };
      });
      const batchCost = lines.reduce((sum, line) => sum + line.lineCost, 0);
      return { ...recipe, lines, estimatedCost: batchCost, estimatedUnitCost: batchCost / outputRate };
    });

    // "Sheet tổng hợp" giá vốn & giá thành: mỗi mã sản phẩm một dòng, theo phiên bản
    // định lượng đang áp dụng hôm nay. FINISHED tính %cost = giá cost / giá bán.
    // Mỗi MÓN + PHẠM VI một dòng: món khai công thức riêng ở 2 cửa hàng thì có 2 dòng giá
    // thành khác nhau, gộp một dòng như trước là che mất chênh lệch giữa hai nơi.
    const summaryScopes = new Map<string, { productCode: string; branchCode: string }>();
    for (const recipe of explosionRecipes) {
      const productCode = recipe.productCode.toUpperCase();
      const branchCode = (recipe.branchCode || "").toUpperCase();
      summaryScopes.set(`${productCode}|${branchCode}`, { productCode, branchCode });
    }
    const itemByCode = new Map(items.map((item) => [item.code.toUpperCase(), item]));
    const costSummary = [...summaryScopes.values()].map(({ productCode, branchCode }) => {
      const versions = explosionRecipes.filter((recipe) =>
        recipe.productCode.toUpperCase() === productCode && (recipe.branchCode || "").toUpperCase() === branchCode);
      const current = pickRecipeForDate(versions, new Date(), branchCode || undefined);
      const productItem = itemByCode.get(productCode);
      const unitCost = unitCostOfRecipe(productCode, branchCode) ?? 0;
      const sellingPrice = current?.sellingPrice || 0;
      return {
        productCode,
        branchCode,
        productName: current?.productName || productItem?.name || productCode,
        group: productItem?.itemType || "FINISHED",
        stockUnit: productItem?.unit || "",
        batchUnit: current?.unit || productItem?.unit || "",
        outputConversionRate: current?.outputConversionRate || 1,
        sellingPrice,
        unitCost: Number.isFinite(unitCost) ? unitCost : 0,
        costRatio: sellingPrice > 0 && Number.isFinite(unitCost) ? (unitCost as number) / sellingPrice : null,
        version: current && "version" in current ? (current as { version?: number }).version || 0 : 0,
      };
    }).sort((a, b) => a.productCode.localeCompare(b.productCode) || a.branchCode.localeCompare(b.branchCode));
    const stockSummary = buildStockSummary(balances, movementTotals);
    // Báo cáo hủy hàng: mã nào hủy nhiều nhất, tách theo loại hủy (hết hạn / chất lượng).
    const wasteBuckets = new Map<string, {
      itemCode: string; itemName: string; unit: string; itemType: string;
      totalQuantity: number; totalValue: number; documentCount: number;
      bySubType: Record<string, { quantity: number; value: number }>;
    }>();
    for (const row of wasteTotals) {
      const bucket = wasteBuckets.get(row.itemId) || {
        itemCode: row.itemCode, itemName: row.itemName, unit: row.unit, itemType: row.itemType,
        totalQuantity: 0, totalValue: 0, documentCount: 0, bySubType: {},
      };
      bucket.totalQuantity += row.quantity;
      bucket.totalValue += row.value;
      bucket.documentCount += row.lineCount;
      bucket.bySubType[row.subType] ||= { quantity: 0, value: 0 };
      bucket.bySubType[row.subType].quantity += row.quantity;
      bucket.bySubType[row.subType].value += row.value;
      wasteBuckets.set(row.itemId, bucket);
    }
    const wasteReport = [...wasteBuckets.values()].sort((a, b) => b.totalValue - a.totalValue);

    // Doanh thu chờ rã nguyên liệu, gom theo ngày + cửa hàng cho tab Chế biến. Dòng thuộc nhóm
    // doanh thu khai "không theo dõi tồn kho" (phụ thu, dịch vụ) bị loại ngay ở đây: dữ liệu
    // import trước khi khai cờ vẫn đang mang trạng thái PENDING, đếm vào là báo sai việc phải làm.
    const inventoryPendingRows = pendingRevenueRows.filter((row) => tracksInventory(row.revenueSource, nonInventoryGroups));
    const pendingByDay = new Map<string, { saleDate: Date; branchCode: string; rowCount: number; totalQuantity: number }>();
    for (const row of inventoryPendingRows) {
      const key = `${row.saleDate.toISOString().slice(0, 10)}|${row.branchCode}`;
      const bucket = pendingByDay.get(key) || { saleDate: row.saleDate, branchCode: row.branchCode, rowCount: 0, totalQuantity: 0 };
      bucket.rowCount += 1;
      bucket.totalQuantity += row.productQuantity || 0;
      pendingByDay.set(key, bucket);
    }
    // Danh sách xuất bán chờ rã, gom theo mã hàng: đây là số lượng sẽ chạy định lượng (chỉ nhóm
    // Đồ ăn / Đồ uống — dịch vụ đã bị loại ở trên). Tên và nhóm doanh thu lấy từ danh mục mặt hàng.
    const pendingByItem = new Map<string, { productCode: string; productName: string; revenueSource: string; rowCount: number; totalQuantity: number }>();
    for (const row of inventoryPendingRows) {
      const code = (row.productCode || "").toUpperCase();
      const bucket = pendingByItem.get(code) || {
        productCode: code,
        productName: itemByCode.get(code)?.name || code,
        revenueSource: row.revenueSource || itemByCode.get(code)?.revenueGroup || "",
        rowCount: 0,
        totalQuantity: 0,
      };
      bucket.rowCount += 1;
      bucket.totalQuantity += row.productQuantity || 0;
      pendingByItem.set(code, bucket);
    }
    // Điều chuyển bán thành phẩm + kiểm dư bán thành phẩm đang chờ rã (khách chốt 28/09/2026):
    // cùng nguồn với nút Rã (loadPendingExplosionSources) nên số hiện ra đúng bằng số sẽ rã.
    const [pendingTransferDocs, pendingStocktakeDocs] = await Promise.all([
      prisma.inventoryTransaction.findMany({ where: { ...branchFilter, transactionType: { in: EXPLOSION_ISSUE_TYPES }, explosionStatus: EXPLOSION_PENDING, deletedAt: null }, select: { id: true, branchCode: true } }),
      prisma.stocktakeSession.findMany({ where: { ...branchFilter, status: "APPROVED", explosionStatus: EXPLOSION_PENDING, deletedAt: null }, select: { id: true, branchCode: true } }),
    ]);
    const pendingSourceBranches = [...new Set([...pendingTransferDocs, ...pendingStocktakeDocs].map((doc) => doc.branchCode))];
    const pendingSources = [];
    for (const sourceBranch of pendingSourceBranches) {
      const sources = await loadPendingExplosionSources(prisma as unknown as TxClient, {
        branchCode: sourceBranch,
        dateFrom: new Date(0),
        rangeEnd: new Date(),
        ids: {
          transferIds: pendingTransferDocs.filter((doc) => doc.branchCode === sourceBranch).map((doc) => doc.id),
          stocktakeIds: pendingStocktakeDocs.filter((doc) => doc.branchCode === sourceBranch).map((doc) => doc.id),
        },
      });
      for (const source of sources) {
        pendingSources.push({
          kind: source.kind,
          code: source.code,
          date: source.date,
          branchCode: sourceBranch,
          warehouseCode: source.warehouseCode,
          items: source.demands.map((demand) => ({
            itemCode: demand.productCode,
            itemName: itemByCode.get(demand.productCode.toUpperCase())?.name || demand.productCode,
            unit: itemByCode.get(demand.productCode.toUpperCase())?.unit || "",
            quantity: demand.quantity,
          })),
        });
      }
    }
    pendingSources.sort((a, b) => a.date.getTime() - b.date.getTime() || a.code.localeCompare(b.code));
    const pendingSales = {
      total: inventoryPendingRows.length,
      byDay: [...pendingByDay.values()],
      byItem: [...pendingByItem.values()].sort((a, b) => b.totalQuantity - a.totalQuantity),
      sources: pendingSources,
    };
    // Ô chọn của mặt hàng chỉ nhận nhóm doanh thu; loại thu quỹ trả riêng để màn hình gọi đúng
    // tên mã đang bị gán sai thay vì hiện trơ mã "(ngoài danh mục)".
    const revenueGroups = receiptCategoryList.filter((category) => isRevenueGroupCategory(category.group));
    const receiptCategories = receiptCategoryList.filter((category) => !isRevenueGroupCategory(category.group));

    return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { items, balances, transactions, flowTransactions, transferTransactions, wasteTransactions, partners, flowRange: { from: isoDay(flowFrom), to: isoDay(flowTo) }, recipes: recipesWithCost, warehouses, warehouseBranches, stocktakes, stockSummary, stockMovements, itemGroups, revenueGroups, receiptCategories, costSummary, wasteReport, pendingSales }));
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);
    // Mở lại phiếu đã duyệt là sửa lại số đã chốt, không phải lập chứng từ mới -> quyền "edit".
    // Duyệt / trả lại / mở lại phiếu kiểm kê là việc của kế toán -> quyền "approve" (khách yêu
    // cầu 28/09/2026); nhà hàng chỉ có "create" để Gửi duyệt và sửa phiếu chưa duyệt.
    const auth = requireMenuAction(
      request,
      menuHref,
      ["APPROVE_STOCKTAKE", "RETURN_STOCKTAKE", "REOPEN_STOCKTAKE"].includes(action) ? "approve" : action === "REVERT_PRODUCTION" ? "edit" : "create",
    );
    if (!auth.ok) return auth.response;

    if (action === "CREATE_ITEM") {
      const itemCode = cleanText(body.code);
      const name = cleanText(body.name);
      const unit = cleanText(body.unit);
      const itemType = normalizeItemType(body.itemType);
      const purchaseUnit = cleanText(body.purchaseUnit);
      const conversionRate = toNumber(body.conversionRate);

      if (!itemCode || !name || !unit) businessError("Mã, tên và đơn vị tính là bắt buộc");

      if (!validItemTypes.includes(itemType)) businessError("Loại mặt hàng không hợp lệ");
      const uppercaseCode = itemCode.toUpperCase();
      if (await findDeletedByUnique("InventoryItem", { code: uppercaseCode })) {
        businessError(duplicatedInTrashMessage(uppercaseCode, "Hàng hoá / Nguyên vật liệu"));
      }

      const item = await prisma.inventoryItem.create({
        data: {
          code: uppercaseCode,
          name,
          unit,
          itemType,
          category: await resolveItemCategory(itemType, body.category),
          revenueGroup: await resolveItemRevenueGroup(body.revenueGroup),
          minStock: toNumber(body.minStock),
          requiresImage: !!body.requiresImage,
          note: cleanText(body.note) || null,
        },
      });
      await createOrUpdateConversion(item.id, unit, 1, "ĐVT cơ bản");
      if (purchaseUnit) await createOrUpdateConversion(item.id, purchaseUnit, conversionRate, cleanText(body.conversionNote));
      const result = await prisma.inventoryItem.findUnique({ where: { id: item.id }, include: { unitConversions: true } });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "UPSERT_UNIT_CONVERSION") {
      const itemId = cleanText(body.itemId);
      const purchaseUnit = cleanText(body.purchaseUnit || body.unitCode);
      const conversionRate = toNumber(body.conversionRate);
      if (!itemId) businessError("Mặt hàng là bắt buộc");
      const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) businessError("Không tìm thấy mặt hàng");
      const conversion = await createOrUpdateConversion(itemId, purchaseUnit, conversionRate, cleanText(body.note));
      return NextResponse.json(conversion, { status: 201 });
    }

    if (action === "CREATE_RECIPE") {
      // POS luôn so mã món dạng UPPERCASE; giữ nguyên chữ thường ở đây là BOM không bao giờ khớp.
      const productCode = cleanText(body.productCode).toUpperCase();
      const productName = cleanText(body.productName);
      if (!productCode || !productName) businessError("Định lượng cần mã món, tên món và nguyên liệu");
      // Cửa hàng áp dụng: trống = công thức dùng chung cho mọi cửa hàng, khai mã = bản riêng
      // của cửa hàng đó (cùng món mỗi nơi pha một kiểu — khách chốt 20/09/2026).
      //
      // Khai được NHIỀU cửa hàng một lần, đúng kiểu một mặt hàng khai nhiều ĐVT mua: công thức
      // giống nhau thì chọn hết các cửa hàng dùng chung công thức đó, hệ thống lưu mỗi nơi một
      // bản và màn hình gom lại thành MỘT dòng. Cửa hàng nào sau này pha khác thì khai riêng
      // cho nơi đó, dòng tự tách ra.
      const requestedBranches = Array.isArray(body.branchCodes) ? body.branchCodes : [body.branchCode];
      const recipeBranchCodes = [...new Set(requestedBranches
        .map((value: unknown) => cleanText(value).toUpperCase())
        .filter((value: string) => value && value !== "ALL"))] as string[];
      for (const branch of recipeBranchCodes) {
        assertBranchAccess(auth.session, branch);
        const branchMaster = await prisma.masterDataItem.findFirst({ where: { type: "BRANCH", code: branch, status: "ACTIVE" } });
        if (!branchMaster) businessError(`Cửa hàng ${branch} không tồn tại hoặc ngưng hoạt động`);
      }
      // Không chọn cửa hàng nào = bản dùng chung (một "phạm vi" rỗng).
      const recipeScopes = recipeBranchCodes.length > 0 ? recipeBranchCodes : [""];
      // Dòng nguyên liệu lỗi phải báo rõ, không lặng lẽ loại bỏ — thiếu nguyên liệu là trừ kho thiếu vĩnh viễn.
      const inputLines = editableRecipeLines(body.lines);
      const productItem = await prisma.inventoryItem.findUnique({ where: { code: productCode } });
      if (!productItem) businessError(`Khong tim thay san pham ${productCode}`);
      if (!["FINISHED", "SEMI_FINISHED"].includes(productItem.itemType)) {
        businessError("Định lượng chỉ khai cho thành phẩm (SP_) hoặc bán thành phẩm (BTP_)");
      }
      if (inputLines.some((line) => line.itemId === productItem.id || line.itemCode.toUpperCase() === productItem.code)) {
        businessError("BOM khong duoc tham chieu chinh san pham do");
      }

      // Hệ số quy đổi mẻ chuẩn bị về ĐVT tồn kho (BTP nấu 1kg = 1000 gr...). Trống = 1.
      const outputConversionRate = body.outputConversionRate !== undefined && cleanText(body.outputConversionRate) !== ""
        ? toNumber(body.outputConversionRate)
        : 1;
      if (!(outputConversionRate > 0)) businessError("Hệ số quy đổi về ĐVT tồn kho phải lớn hơn 0");
      const effectiveFrom = body.effectiveFrom ? toDate(body.effectiveFrom) : new Date();
      // BTP không có giá bán (spec kế toán: cột giá bán bỏ với bán thành phẩm).
      const sellingPrice = productItem.itemType === "SEMI_FINISHED" ? 0 : toNumber(body.sellingPrice);

      // Nguyên liệu có thể khai bằng ĐVT quy đổi (chai830gr) — tra hệ số từ danh mục quy
      // đổi của mặt hàng, hoặc nhận hệ số khai thẳng trên dòng (ưu tiên số khai thẳng).
      const resolvedLines: Array<{ itemId: string; quantity: number; unitCode: string | null; conversionRate: number; wasteRate: number }> = [];
      for (const line of inputLines) {
        const item = line.itemId
          ? await prisma.inventoryItem.findUnique({ where: { id: line.itemId }, include: { unitConversions: true } })
          : await prisma.inventoryItem.findUnique({ where: { code: line.itemCode.toUpperCase() }, include: { unitConversions: true } });
        if (!item) businessError(`Không tìm thấy nguyên liệu ${line.itemCode || line.itemId}`);
        const unitCode = cleanText(line.unitCode);
        let conversionRate = line.conversionRate > 0 ? line.conversionRate : 0;
        if (!conversionRate) {
          if (!unitCode || unitCode.toUpperCase() === item.unit.toUpperCase()) {
            conversionRate = 1;
          } else {
            const conversion = item.unitConversions.find((candidate) => candidate.unitCode.toUpperCase() === unitCode.toUpperCase());
            if (!conversion) {
              businessError(`ĐVT [${unitCode}] chưa có trong quy đổi của ${item.code}. Khai quy đổi ở tab Mặt hàng hoặc điền hệ số quy đổi trên dòng định lượng.`);
            }
            conversionRate = conversion?.conversionRate || 1;
          }
        }
        // Hệ số khai THẲNG trên dòng cũng phải qua luật bất biến của lib/unit-conversion:
        // "300 GR × 1000" cho nguyên liệu vốn tính bằng GR là quy đổi một đơn vị ra chính nó,
        // và định lượng sai kiểu đó làm rã BOM lẫn giá thành nhân sai 1000 lần mỗi cấp.
        conversionRate = safeConversionRate(item.unit, { unitCode: unitCode || item.unit, conversionRate });
        resolvedLines.push({ itemId: item.id, quantity: line.quantity, unitCode: unitCode || null, conversionRate, wasteRate: line.wasteRate });
      }

      // Phiên bản đếm riêng trong từng phạm vi: bản chung và bản của mỗi cửa hàng có chuỗi
      // version độc lập, và tạo bản này chỉ hạ bản ACTIVE cùng phạm vi.
      //
      // Bản mới có ngày áp dụng LÙI về trước (sao chép bản cũ rồi chọn ngày) thì những lần rã
      // từ ngày đó trở đi đã rã theo bản cũ — phải hỏi người dùng rồi rã lại, như khi sửa.
      for (const scopeBranch of recipeScopes) {
        const latest = await prisma.recipe.findFirst({ where: { productCode, branchCode: scopeBranch || null }, orderBy: { version: "desc" } });
        const recipeCode = `${productCode}${scopeBranch ? `-${scopeBranch}` : ""}-V${(latest?.version || 0) + 1}`;
        if (await findDeletedByUnique("Recipe", { code: recipeCode })) {
          businessError(duplicatedInTrashMessage(recipeCode, "Định mức (BOM)"));
        }
      }
      let created;
      try {
        created = await prisma.$transaction(async (tx) => {
          const before = await loadRecipeVersions(tx, productCode);
          const createdRecipes = [];
          for (const scopeBranch of recipeScopes) {
            const recipeScope = { productCode, branchCode: scopeBranch || null };
            const latest = await tx.recipe.findFirst({ where: recipeScope, orderBy: { version: "desc" } });
            const recipeCode = `${productCode}${scopeBranch ? `-${scopeBranch}` : ""}-V${(latest?.version || 0) + 1}`;
            if (latest) await tx.recipe.updateMany({ where: { ...recipeScope, status: "ACTIVE" }, data: { status: "INACTIVE" } });
            createdRecipes.push(await tx.recipe.create({
              data: {
                code: recipeCode,
                productCode,
                branchCode: scopeBranch || null,
                productName,
                // Cùng mặc định với import (ĐVT tồn kho của sản phẩm) — hai luồng ra dữ liệu giống nhau.
                unit: cleanText(body.unit) || productItem.unit,
                outputConversionRate,
                sellingPrice,
                effectiveFrom,
                version: (latest?.version || 0) + 1,
                note: cleanText(body.note) || null,
                lines: { create: resolvedLines },
              },
              include: { lines: { include: { item: true } } },
            }));
          }
          const after = await loadRecipeVersions(tx, productCode);
          const affected = await findRunsAffectedByRecipes(tx, [productCode], before, after);
          if (affected.length > 0) {
            await assertPeriodOpen(affected.map((run) => ({ date: run.date, branchCode: run.branchCode })), "rã lại theo định lượng mới", tx);
            if (!body.confirmRerun) throw new RecipeRerunConfirmation(affected);
          }
          const reruns = affected.length > 0 ? await rerunExplosions(tx, affected, auth.session.name) : [];
          return { createdRecipes, reruns };
        }, { timeout: 300000, maxWait: 20000 });
      } catch (error) {
        if (error instanceof RecipeRerunConfirmation) return rerunConfirmationResponse(error);
        throw error;
      }
      const { createdRecipes, reruns } = created;
      await logRecipeReruns(auth.session, reruns, createdRecipes[0]?.code || productCode);
      const cogsRepost = reruns.length > 0 ? await repostCogsForReruns(reruns, [], auth.session.name) : [];
      // Giữ nguyên hình dạng cũ của response (một định lượng) để màn hình cũ không vỡ, kèm
      // danh sách đầy đủ khi khai một lúc nhiều cửa hàng.
      return NextResponse.json({ ...createdRecipes[0], recipes: createdRecipes, reruns: reruns.map(({ oldRunCode, newRunCode }) => ({ oldRunCode, newRunCode })), cogsRepost }, { status: 201 });
    }

    if (action === "PRODUCE_SEMI_FINISHED") {
      const productCode = cleanText(body.productCode).toUpperCase();
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const toWarehouseCode = cleanText(body.toWarehouseCode) || warehouseCode;
      const productionDate = toDate(body.productionDate);
      const productQuantity = toNumber(body.productQuantity);
      if (!productCode || !branchCode || !warehouseCode || productQuantity <= 0) businessError("Lenh che bien can san pham, cua hang, kho va so luong > 0");
      assertBranchAccess(auth.session, branchCode);
      assertWarehouseAccess(auth.session, warehouseCode, "Kho xuất NVL");
      assertWarehouseAccess(auth.session, toWarehouseCode, "Kho nhập BTP");
      const [productItem, recipeVersions] = await Promise.all([
        prisma.inventoryItem.findUnique({ where: { code: productCode } }),
        // Công thức đúng là bản có hiệu lực TẠI NGÀY CHẾ BIẾN (pickRecipeForDate bên dưới),
        // không phải bản mới nhất: đổi định lượng hôm nay rồi lập lệnh cho tuần trước phải
        // ăn theo công thức cũ.
        prisma.recipe.findMany({ where: { productCode }, include: { lines: { include: { item: true } } } }),
      ]);
      if (!productItem) businessError(`Khong tim thay ban thanh pham ${productCode}`);
      if (productItem.itemType !== "SEMI_FINISHED") businessError("Che bien chi ap dung cho mat hang ban thanh pham");
      // Chọn phiên bản định lượng theo ngày chế biến, không phải phiên bản mới nhất.
      // Công thức của CHÍNH cửa hàng đang chế biến; nơi chưa khai riêng thì dùng bản chung.
      const recipe = pickRecipeForDate(recipeVersions as unknown as ExplosionRecipe[], productionDate, branchCode);
      if (!recipe || recipe.lines.length === 0) businessError(`Chua co dinh luong ap dung cho ${productCode} tai cua hang ${branchCode}`);
      if (await isPeriodLocked(productionDate, branchCode)) businessError("Ky ke toan da khoa");
      // productQuantity khai theo ĐVT tồn kho; định lượng khai cho MỘT mẻ `unit`.
      const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
      const batchQuantity = productQuantity / outputRate;
      const result = await prisma.$transaction(async (tx) => {
        const referenceCode = cleanText(body.referenceCode) || await nextStockDocCode(tx, "CB", productionDate);
        const issue = await postInventoryTransaction(tx, {
          code: `${referenceCode}-X`,
          transactionType: "XUAT_CHE_BIEN",
          transactionDate: productionDate,
          branchCode,
          warehouseCode,
          referenceType: "PRODUCTION",
          referenceCode,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          lines: recipe.lines.map((line) => ({
            itemId: line.itemId,
            inputQuantity: line.quantity * (line.conversionRate || 1) * (1 + line.wasteRate / 100) * batchQuantity,
            inputUnitCode: "",
            inputUnitCost: 0,
          })),
        });
        const totalCost = issue.lines.reduce((sum, line) => sum + line.totalCost, 0);
        const receipt = await postInventoryTransaction(tx, {
          code: `${referenceCode}-N`,
          transactionType: "NHAP_CHE_BIEN",
          transactionDate: productionDate,
          branchCode,
          warehouseCode: toWarehouseCode,
          referenceType: "PRODUCTION",
          referenceCode,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          lines: [{
            itemId: productItem.id,
            inputQuantity: productQuantity,
            inputUnitCode: productItem.unit,
            inputUnitCost: productQuantity > 0 ? totalCost / productQuantity : 0,
          }],
        });
        return { issue, receipt };
      });
      return NextResponse.json(result, { status: 201 });
    }

    /**
     * Kiểm kê kho HAI BƯỚC (khách yêu cầu 28/09/2026): nhà hàng đếm xong bấm "Gửi duyệt" — phiếu
     * nằm ở Chờ duyệt, CHƯA đụng tồn kho, nhà hàng mở lại sửa / bổ sung được tới khi kế toán duyệt
     * (bị trả lại cũng sửa rồi gửi lại được). Kế toán (quyền "Duyệt") bấm Duyệt ở danh sách phiếu
     * mới sinh phiếu điều chỉnh tồn — lib/stocktake-status.ts.
     *
     * Số sổ sách của từng dòng chốt lúc ĐẾM (lần đầu dòng đó được lưu); lúc duyệt ghi đúng phần
     * chênh lên tồn hiện tại, nên hàng nhập/xuất trong lúc chờ duyệt không bị đè.
     */
    if (action === "SAVE_STOCKTAKE") {
      const stocktakeId = cleanText(body.stocktakeId);
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const stocktakeDate = toDate(body.stocktakeDate);
      const rows = stocktakeLinesFrom(body.lines);
      if (!branchCode || !warehouseCode || rows.length === 0) businessError("Kiểm kê cần cửa hàng, kho và ít nhất một mặt hàng");
      assertBranchAccess(auth.session, branchCode);
      assertWarehouseAccess(auth.session, warehouseCode);
      // Trước đây ô Kho ở form kiểm kê không lọc theo cửa hàng (khách chọn NAM MÊ vẫn ra kho của
      // cửa hàng khác, 28/09/2026) và API cũng không kiểm — phiếu có thể ghi kho lạc cửa hàng.
      const stocktakeWarehouse = await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode } });
      if (!stocktakeWarehouse) businessError(`Kho ${warehouseCode} không thuộc cửa hàng ${branchCode}.`);
      if (await isPeriodLocked(stocktakeDate, branchCode)) businessError("Kỳ kế toán đã khoá");
      const existing = stocktakeId
        ? await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId }, include: { lines: true } })
        : null;
      if (stocktakeId) {
        if (!existing) businessError("Không tìm thấy phiếu kiểm kê cần sửa");
        assertBranchAccess(auth.session, existing.branchCode);
        assertWarehouseAccess(auth.session, existing.warehouseCode);
        if (!isStocktakeEditable(existing.status)) {
          businessError(`Phiếu kiểm kê ${existing.code} đã được kế toán duyệt nên không sửa được nữa. Nhờ kế toán Mở lại phiếu trước.`);
        }
        if (existing.locationCode) businessError(`Phiếu ${existing.code} là phiếu đếm theo vị trí — sửa ở mục Kiểm kê theo vị trí.`);
      }
      const requestedStocktakeCode = cleanText(body.code);
      if (!existing && requestedStocktakeCode && await findDeletedByUnique("StocktakeSession", { code: requestedStocktakeCode })) {
        businessError(duplicatedInTrashMessage(requestedStocktakeCode, "Phiếu kiểm kê"));
      }
      const result = await prisma.$transaction(async (tx) => {
        const isExplodable = await semiFinishedWithRecipeChecker(tx, branchCode);
        // Phiếu đang sửa: dòng đã có giữ nguyên số sổ sách chốt lúc đếm lần đầu (đổi kho thì đếm lại từ đầu).
        const savedSystem = new Map(existing && existing.warehouseCode === warehouseCode
          ? existing.lines.map((line) => [line.itemId, line.systemQuantity] as const)
          : []);
        const lineData = [];
        for (const row of rows) {
          const item = row.itemId
            ? await tx.inventoryItem.findUnique({ where: { id: row.itemId } })
            : await tx.inventoryItem.findUnique({ where: { code: row.itemCode.toUpperCase() } });
          if (!item) businessError(`Không tìm thấy mặt hàng ${row.itemCode || row.itemId}`);
          // CCDC & Tài sản kiểm kê ở màn hình Tài sản & Khấu hao, không nằm trong kiểm kê kho.
          if (!isWarehouseStocktakeItemType(item.itemType)) {
            businessError(`Mặt hàng ${item.code} là CCDC/Tài sản và phải được kiểm kê tại phân hệ Tài sản & khấu hao.`);
          }
          const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode } } });
          let systemQuantity = savedSystem.get(item.id);
          if (systemQuantity === undefined) {
            systemQuantity = balance?.quantity || 0;
            // Khoá lạc quan: người đếm chốt số dựa trên tồn HỌ NHÌN THẤY. Tồn đã đổi từ lúc mở màn
            // hình mà cứ lưu thì chênh lệch sẽ "hoàn lại" toàn bộ phát sinh. Bắt tải lại danh sách.
            if (row.systemQuantity !== null && Math.abs(row.systemQuantity - systemQuantity) > quantityEpsilon) {
              businessError(`Tồn của ${item.code} đã thay đổi từ lúc tải danh sách (${row.systemQuantity} → ${systemQuantity}). Bấm "Nạp danh sách kho" để lấy số mới rồi kiểm lại dòng này.`);
            }
          }
          const varianceQuantity = row.actualQuantity - systemQuantity;
          // Hàng đếm THỪA mà chưa có giá vốn thì bắt khai đơn giá ngay lúc gửi — để kế toán duyệt
          // được luôn. BTP có định lượng chờ rã BOM lấy giá từ nguyên liệu nên thôi.
          if (varianceQuantity > 0 && !isExplodable(item) && (balance?.averageCost || 0) <= 0 && row.unitCost <= 0) {
            businessError(`${item.code} chưa có giá vốn trong kho ${warehouseCode}. Nhập "Đơn giá" cho dòng này để ghi nhận phần thừa ${varianceQuantity} ${item.unit}.`);
          }
          lineData.push({
            itemId: item.id,
            systemQuantity,
            actualQuantity: row.actualQuantity,
            varianceQuantity,
            unitCost: row.unitCost > 0 ? row.unitCost : null,
            reason: row.reason || cleanText(body.reason) || null,
          });
        }
        // Gửi (lại) là về Chờ duyệt; lý do trả lại lần trước giữ nguyên để kế toán đối chiếu.
        const header = { stocktakeDate, branchCode, warehouseCode, status: STOCKTAKE_PENDING, note: cleanText(body.note) || null };
        const stocktake = existing
          ? await tx.stocktakeSession.update({ where: { id: existing.id }, data: header })
          : await tx.stocktakeSession.create({
            data: { ...header, code: requestedStocktakeCode || await nextStocktakeCode(tx, stocktakeDate), createdBy: auth.session.name },
          });
        await tx.stocktakeLine.deleteMany({ where: { stocktakeId: stocktake.id } });
        await tx.stocktakeLine.createMany({ data: lineData.map((line) => ({ ...line, stocktakeId: stocktake.id })) });
        return tx.stocktakeSession.findUnique({ where: { id: stocktake.id }, include: { lines: { include: { item: true } } } });
      });
      await writeAuditLog({
        session: auth.session, module: menuHref, action: existing ? "RESUBMIT_STOCKTAKE" : "SUBMIT_STOCKTAKE",
        entityType: "StocktakeSession", entityId: result?.id || null, entityCode: result?.code || null, branchCode,
        metadata: { warehouseCode, lines: rows.length },
      });
      return NextResponse.json(result, { status: existing ? 200 : 201 });
    }

    /**
     * Kế toán trả lại phiếu đang Chờ duyệt kèm lý do: phiếu về "Bị trả lại", nhà hàng thấy lý do,
     * sửa rồi gửi lại. Không đụng tồn kho (chưa duyệt thì chưa có gì để hoàn).
     */
    if (action === "RETURN_STOCKTAKE") {
      const stocktakeId = cleanText(body.stocktakeId) || cleanText(body.id);
      const reason = cleanText(body.reason);
      if (!stocktakeId) businessError("Thiếu phiếu kiểm kê cần trả lại");
      if (!reason) businessError("Nhập lý do trả lại để nhà hàng biết cần sửa gì");
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
      assertWarehouseAccess(auth.session, stocktake.warehouseCode);
      if (stocktake.status !== STOCKTAKE_PENDING) {
        businessError(`Phiếu kiểm kê ${stocktake.code} đang ở trạng thái ${stocktakeStatusLabel(stocktake.status)}, chỉ trả lại được phiếu Chờ duyệt.`);
      }
      const result = await prisma.stocktakeSession.update({
        where: { id: stocktakeId },
        data: { status: STOCKTAKE_RETURNED, returnedReason: reason, returnedBy: auth.session.name, returnedAt: new Date() },
        include: { lines: { include: { item: true } } },
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "RETURN_STOCKTAKE", entityType: "StocktakeSession", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { reason } });
      return NextResponse.json(result);
    }

    /** Kế toán duyệt phiếu kiểm kê đang Chờ duyệt: sinh phiếu nhập/xuất điều chỉnh theo phần chênh. */
    if (action === "APPROVE_STOCKTAKE") {
      const stocktakeId = cleanText(body.stocktakeId) || cleanText(body.id);
      if (!stocktakeId) businessError("Chọn phiếu kiểm kê cần duyệt ở danh sách phiếu (nhà hàng bấm Gửi duyệt trước).");
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId }, include: { lines: { include: { item: true } } } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
      assertWarehouseAccess(auth.session, stocktake.warehouseCode);
      if (stocktake.status !== STOCKTAKE_PENDING) {
        businessError(`Phiếu kiểm kê ${stocktake.code} đang ở trạng thái ${stocktakeStatusLabel(stocktake.status)}, chỉ duyệt được phiếu Chờ duyệt.`);
      }
      // Phiếu đếm theo vị trí chỉ là một phần của kho — duyệt gộp theo giờ chốt (lib/stocktake-batch.ts).
      if (stocktake.locationCode) businessError(`Phiếu ${stocktake.code} là phiếu đếm theo vị trí — chọn cùng các phiếu khác của kho và bấm Duyệt gộp.`);
      const { branchCode, warehouseCode, stocktakeDate } = stocktake;
      if (await isPeriodLocked(stocktakeDate, branchCode)) businessError("Kỳ kế toán đã khoá");
      const result = await prisma.$transaction(async (tx) => {
        const inboundLines = [];
        const outboundLines = [];
        // Kiểm DƯ bán thành phẩm có định lượng không nhập kiểm kê mà chờ rã BOM (khách chốt
        // 28/09/2026): phần dư là hàng đã chế biến nên phải trừ nguyên liệu tương ứng.
        const isExplodable = await semiFinishedWithRecipeChecker(tx, branchCode);
        let deferredSurplus = false;
        for (const line of stocktake.lines) {
          const item = line.item;
          const varianceQuantity = line.actualQuantity - line.systemQuantity;
          if (Math.abs(varianceQuantity) <= quantityEpsilon) continue;
          const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode } } });
          const surplusToExplode = varianceQuantity > 0 && isExplodable(item);
          const surplusUnitCost = (balance?.averageCost || 0) > 0 ? balance?.averageCost || 0 : line.unitCost || 0;
          if (varianceQuantity > 0 && !surplusToExplode && surplusUnitCost <= 0) {
            businessError(`${item.code} chưa có giá vốn trong kho ${warehouseCode}. Trả lại phiếu để nhà hàng nhập "Đơn giá" cho phần thừa ${varianceQuantity} ${item.unit}.`);
          }
          if (surplusToExplode) deferredSurplus = true;
          else if (varianceQuantity > 0) inboundLines.push({ itemId: item.id, inputQuantity: varianceQuantity, inputUnitCode: item.unit, inputUnitCost: surplusUnitCost });
          if (varianceQuantity < 0) outboundLines.push({ itemId: item.id, inputQuantity: Math.abs(varianceQuantity), inputUnitCode: item.unit, inputUnitCost: 0 });
        }
        await tx.stocktakeSession.update({
          where: { id: stocktake.id },
          data: {
            status: STOCKTAKE_APPROVED,
            approvedBy: auth.session.name,
            approvedAt: new Date(),
            ...(deferredSurplus ? { explosionStatus: EXPLOSION_PENDING } : {}),
          },
        });
        const docs = [];
        if (inboundLines.length > 0) docs.push(await postInventoryTransaction(tx, {
          code: `${stocktake.code}-N`,
          transactionType: "NHAP_KIEM_KE",
          transactionDate: stocktakeDate,
          branchCode,
          warehouseCode,
          referenceType: "STOCKTAKE",
          referenceId: stocktake.id,
          referenceCode: stocktake.code,
          createdBy: auth.session.name,
          lines: inboundLines,
        }));
        if (outboundLines.length > 0) docs.push(await postInventoryTransaction(tx, {
          code: `${stocktake.code}-X`,
          transactionType: "XUAT_KIEM_KE",
          transactionDate: stocktakeDate,
          branchCode,
          warehouseCode,
          referenceType: "STOCKTAKE",
          referenceId: stocktake.id,
          referenceCode: stocktake.code,
          createdBy: auth.session.name,
          lines: outboundLines,
        }));
        return { stocktake: await tx.stocktakeSession.findUnique({ where: { id: stocktake.id }, include: { lines: { include: { item: true } } } }), transactions: docs };
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "APPROVE_STOCKTAKE", entityType: "StocktakeSession", entityId: stocktake.id, entityCode: stocktake.code, branchCode, metadata: { transactions: result.transactions.map((doc) => doc.code) } });
      return NextResponse.json(result);
    }

    /**
     * Mở lại phiếu kiểm kê đã duyệt.
     *
     * Duyệt kiểm kê là thao tác một chiều: phiếu sinh ra ở trạng thái APPROVED kèm 1-2 phiếu
     * nhập/xuất điều chỉnh tồn, mà cả UPDATE_STOCKTAKE lẫn DELETE đều chặn phiếu đã duyệt.
     * Đếm nhầm một dòng là không còn đường sửa, chỉ còn cách lập phiếu điều chỉnh tay.
     *
     * Mở lại = hoàn kho đúng bằng hai phiếu điều chỉnh đó rồi xoá chúng, đưa phiếu kiểm kê về
     * Chờ duyệt (luồng hai bước 28/09/2026): nhà hàng sửa số đếm rồi gửi lại, kế toán duyệt lại;
     * phiếu chưa duyệt xoá được như thường vì không còn phiếu kho nào trỏ vào.
     */
    if (action === "REOPEN_STOCKTAKE") {
      const stocktakeId = cleanText(body.stocktakeId) || cleanText(body.id);
      if (!stocktakeId) businessError("Thiếu phiếu kiểm kê cần mở lại");
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
      assertWarehouseAccess(auth.session, stocktake.warehouseCode);
      if (stocktake.status !== "APPROVED") businessError(`Phiếu kiểm kê ${stocktake.code} đang ở trạng thái ${stocktake.status}, chưa duyệt nên không có gì để mở lại.`);
      if (stocktake.batchId || stocktake.locationCode) businessError(`Phiếu ${stocktake.code} được duyệt gộp theo vị trí — mở lại cả đợt kiểm kê ở mục Kiểm kê theo vị trí.`);
      await assertPeriodOpen({ date: stocktake.stocktakeDate, branchCode: stocktake.branchCode }, "mở lại phiếu kiểm kê");
      const explodedRun = explodedRunOf(stocktake.explosionStatus);
      if (explodedRun) {
        businessError(`Phần kiểm dư bán thành phẩm của phiếu ${stocktake.code} đã rã BOM trong lần rã ${explodedRun}. Hoàn tác lần rã đó ở tab Chế biến trước khi mở lại phiếu.`);
      }

      const documents = await prisma.inventoryTransaction.findMany({
        where: { referenceType: "STOCKTAKE", referenceId: stocktake.id },
        include: { lines: true },
      });

      // Cùng luật với xoá phiếu kho: chỉ hoàn kho chính xác được khi chưa có phiếu nào phát
      // sinh sau trên cùng mặt hàng/kho. Có phiếu sau mà cứ hoàn thì số tồn sẽ nhảy sai.
      const documentIds = documents.map((document) => document.id);
      const itemIds = [...new Set(documents.flatMap((document) => document.lines.map((line) => line.itemId)))];
      const warehouseCodes = [...new Set(documents.flatMap((document) => [document.warehouseCode, document.toWarehouseCode].filter((value): value is string => !!value)))];
      if (documentIds.length > 0) {
        const newer = await prisma.inventoryTransaction.findFirst({
          where: {
            id: { notIn: documentIds },
            createdAt: { gt: documents[0].createdAt },
            lines: { some: { itemId: { in: itemIds } } },
            OR: [{ warehouseCode: { in: warehouseCodes } }, { toWarehouseCode: { in: warehouseCodes } }],
          },
          orderBy: { createdAt: "asc" },
        });
        if (newer) {
          businessError(`Đã có phiếu ${newer.code} phát sinh sau phiếu kiểm kê ${stocktake.code} trên cùng mặt hàng/kho nên không hoàn kho chính xác được. Hãy xoá các phiếu phát sinh sau, hoặc lập phiếu điều chỉnh kho thay vì mở lại.`);
        }
      }

      const reversals = [];
      for (const document of documents) {
        reversals.push({ code: document.code, lines: await reverseTransactionStock(document) });
        await softDeleteRecord({ model: "InventoryTransaction", id: document.id, session: auth.session, reason: `Mở lại phiếu kiểm kê ${stocktake.code}` });
      }
      // Từ mốc giá vốn theo kho (INVENTORY_COGS_START_PERIOD) phiếu kiểm kê lên sổ giá vốn (INVENTORY_ISSUE, lib/inventory-cogs.ts): dọn
      // theo để P&L không giữ chênh kiểm kê của lần duyệt đã hoàn.
      if (documentIds.length > 0) {
        await prisma.journalEntry.deleteMany({ where: { sourceType: "INVENTORY_ISSUE", sourceId: { in: documentIds } } });
      }

      const result = await prisma.stocktakeSession.update({
        where: { id: stocktakeId },
        // Về Chờ duyệt (không phải Nháp): nhà hàng sửa được, kế toán duyệt lại. Phần kiểm dư đang
        // chờ rã cũng bỏ khỏi hàng chờ: duyệt lại mới tính lại.
        data: { status: STOCKTAKE_PENDING, approvedBy: null, approvedAt: null, explosionStatus: null },
        include: { lines: { include: { item: true } } },
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "REOPEN_STOCKTAKE", entityType: "StocktakeSession", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { reversedDocuments: documents.map((document) => document.code), reversals } });
      return NextResponse.json(result);
    }

    /**
     * Nút "Rã nguyên liệu" tab Chế biến: lấy số bán từ các dòng import doanh thu còn chờ
     * (PENDING), rã theo định lượng đang áp dụng theo thứ tự BTP → TP → combo rồi tự sinh
     * phiếu: XUAT_CHE_BIEN nguyên liệu + NHAP_CHE_BIEN sản phẩm cho từng cấp, cuối cùng
     * XUAT_BAN đúng số đã bán. Món không có định lượng (bia, nước chai) xuất bán thẳng.
     */
    if (action === "EXPLODE_PRODUCTION") {
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const toWarehouseCode = cleanText(body.toWarehouseCode) || warehouseCode;
      const dateFrom = toDate(body.dateFrom);
      const dateTo = toDate(body.dateTo || body.dateFrom);
      if (!branchCode || branchCode === "ALL") businessError("Chọn cửa hàng cần rã nguyên liệu");
      if (!warehouseCode) businessError("Chọn kho xuất nguyên liệu");
      assertBranchAccess(auth.session, branchCode);
      const sourceWarehouse = await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode } });
      if (!sourceWarehouse) businessError(`Kho ${warehouseCode} không thuộc cửa hàng ${branchCode}.`);
      /**
       * Đồ ăn trừ kho Bếp, đồ uống trừ kho Bar (khách chốt 20/09/2026). Bộ phận của từng món do
       * lib/revenue-department suy ra: nhóm mặt hàng -> nhóm kho, hoặc nhóm doanh thu
       * (REV_FOOD / "ĐỒ ĂN" -> Bếp, REV_BAR / "ĐỒ UỐNG" -> Bar). Món không suy được (bán thành
       * phẩm dùng chung, combo gồm cả ăn lẫn uống, món chưa gán nhóm doanh thu) vẫn đi kho mặc
       * định như trước, và được đếm lại để người dùng biết mà gán dần.
       */
      const kitchenWarehouseCode = cleanText(body.kitchenWarehouseCode);
      const barWarehouseCode = cleanText(body.barWarehouseCode);
      for (const [label, code] of [["Bếp", kitchenWarehouseCode], ["Bar", barWarehouseCode]] as const) {
        if (!code) continue;
        const warehouse = await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code, branch: branchCode } });
        if (!warehouse) businessError(`Kho ${label} (${code}) không thuộc cửa hàng ${branchCode}.`);
      }
      if (dateTo.getTime() < dateFrom.getTime()) businessError("Khoảng ngày rã không hợp lệ (từ ngày sau đến ngày trước)");
      // Rã TỚI GIỜ của ngày cuối (kiểm kê chốt theo giờ, khách chốt 28/09/2026): 1–23 giờ Việt Nam,
      // chỉ lấy doanh thu có giờ bán nhỏ hơn. Trống = cả ngày.
      const timeToText = cleanText(body.timeTo);
      const timeTo = timeToText === "" ? null : Number(timeToText.split(":")[0]);
      if (timeTo !== null && !(Number.isInteger(timeTo) && timeTo >= 1 && timeTo <= 23)) businessError("Giờ rã tới phải là giờ tròn từ 01:00 đến 23:00");
      if (await isPeriodLocked(explosionPostingDate(dateTo, timeTo), branchCode)) businessError("Kỳ kế toán đã khóa");

      /**
       * RÃ LẠI (khách chốt 27/09/2026: "user muốn chỉnh thì cứ chạy, trừ khi đã khoá kỳ"): khoảng
       * ngày chọn có dòng doanh thu ĐÃ RÃ thì lần bấm đầu trả 409 kèm danh sách lần rã để xác
       * nhận; bấm đồng ý (confirmRerun) thì gỡ các lần rã đó rồi rã lại ĐÚNG các dòng của chúng
       * với kho đang chọn, sau đó rã tiếp phần còn chờ — cùng một transaction. Trước đây nút Rã
       * chỉ nhận dòng PENDING nên ngày đã rã không làm lại được, còn nút hoàn tác chỉ hiện 6 lần
       * rã mới nhất.
       */
      const rangeEnd = new Date(dateTo);
      rangeEnd.setHours(23, 59, 59, 999);
      const postedStatuses = await prisma.revenueImportRow.findMany({
        where: { branchCode, deletedAt: null, saleDate: { gte: dateFrom, lte: rangeEnd }, inventoryStatus: { startsWith: "POSTED:RA-" } },
        distinct: ["inventoryStatus"],
        select: { inventoryStatus: true },
      });
      // Điều chuyển / kiểm kê trong khoảng ngày đã rã cũng kéo lần rã của chúng vào rã lại.
      const [postedTransfers, postedStocktakes] = await Promise.all([
        prisma.inventoryTransaction.findMany({
          where: { branchCode, deletedAt: null, transactionType: { in: EXPLOSION_ISSUE_TYPES }, transactionDate: { gte: dateFrom, lte: rangeEnd }, explosionStatus: { startsWith: "POSTED:RA-" } },
          distinct: ["explosionStatus"],
          select: { explosionStatus: true },
        }),
        prisma.stocktakeSession.findMany({
          where: { branchCode, deletedAt: null, stocktakeDate: { gte: dateFrom, lte: rangeEnd }, explosionStatus: { startsWith: "POSTED:RA-" } },
          distinct: ["explosionStatus"],
          select: { explosionStatus: true },
        }),
      ]);
      const rerunCodes = [...new Set([
        ...postedStatuses.map((row) => (row.inventoryStatus || "").slice("POSTED:".length)),
        ...[...postedTransfers, ...postedStocktakes].map((row) => explodedRunOf(row.explosionStatus) || ""),
      ].filter(Boolean))];
      const rerunRuns: AffectedExplosionRun[] = [];
      for (const runCode of rerunCodes) {
        // Ngày chứng từ của lần rã = ngày MUỘN nhất trên phiếu (phiếu điều chuyển / kiểm kê của
        // lần rã mang ngày riêng của chúng, sớm hơn ngày cuối khoảng rã).
        const doc = await prisma.inventoryTransaction.findFirst({
          where: { referenceType: "PRODUCTION", referenceCode: runCode, deletedAt: null },
          select: { branchCode: true, transactionDate: true },
          orderBy: { transactionDate: "desc" },
        });
        rerunRuns.push({ runCode, branchCode: doc?.branchCode || branchCode, date: doc?.transactionDate || dateTo, productCodes: [] });
      }
      for (const run of rerunRuns) {
        if (await isPeriodLocked(run.date, run.branchCode)) {
          businessError(`Lần rã ${run.runCode} (ngày ${run.date.toISOString().slice(0, 10)}) nằm trong kỳ kế toán đã khoá nên không rã lại được. Mở khoá kỳ trước.`);
        }
      }
      if (rerunRuns.length > 0 && body.confirmRerun !== true) {
        const rowCounts = await prisma.revenueImportRow.groupBy({
          by: ["inventoryStatus"],
          where: { inventoryStatus: { in: rerunCodes.map((code) => `POSTED:${code}`) }, deletedAt: null },
          _count: { _all: true },
        });
        const statuses = rerunCodes.map((code) => `POSTED:${code}`);
        const [transferCounts, stocktakeCounts] = await Promise.all([
          prisma.inventoryTransaction.groupBy({ by: ["explosionStatus"], where: { explosionStatus: { in: statuses }, deletedAt: null }, _count: { _all: true } }),
          prisma.stocktakeSession.groupBy({ by: ["explosionStatus"], where: { explosionStatus: { in: statuses }, deletedAt: null }, _count: { _all: true } }),
        ]);
        return NextResponse.json({
          needsRerunConfirm: true,
          runs: rerunRuns.map((run) => ({
            runCode: run.runCode,
            date: run.date,
            revenueRows: rowCounts.find((row) => row.inventoryStatus === `POSTED:${run.runCode}`)?._count._all || 0,
            transfers: transferCounts.find((row) => row.explosionStatus === `POSTED:${run.runCode}`)?._count._all || 0,
            stocktakes: stocktakeCounts.find((row) => row.explosionStatus === `POSTED:${run.runCode}`)?._count._all || 0,
          })),
        }, { status: 409 });
      }

      const { outcome, reruns } = await prisma.$transaction(async (tx) => {
        const rerunResults = rerunRuns.length > 0
          ? await rerunExplosions(tx, rerunRuns, auth.session.name, {
            overrideSettings: (_run, original) => ({ ...original, warehouseCode, toWarehouseCode, kitchenWarehouseCode, barWarehouseCode }),
            note: (run) => `rã lại ${run.runCode} theo yêu cầu`,
          })
          : [];
        // Rã lại xong, dòng còn chờ trong khoảng ngày (nếu có) rã thành một lần mới như thường.
        const fresh = await executeExplosion(tx, {
          branchCode, warehouseCode, toWarehouseCode, kitchenWarehouseCode, barWarehouseCode,
          dateFrom, dateTo, timeTo, note: cleanText(body.note), createdBy: auth.session.name,
        });
        return { outcome: fresh, reruns: rerunResults };
      }, { timeout: 10 * 60 * 1000, maxWait: 30000 });

      for (const rerun of reruns) {
        if (!rerun.newRunCode) continue;
        await writeAuditLog({
          session: auth.session, module: menuHref, action: "EXPLODE_PRODUCTION",
          entityType: "InventoryTransaction", entityCode: rerun.newRunCode, branchCode: rerun.branchCode,
          metadata: { ...rerun.settings, dateTo: rerun.date, rerunOf: rerun.oldRunCode, reason: "Rã lại theo yêu cầu", documents: rerun.documents },
        });
      }
      const rerunSummary = reruns.map((rerun) => ({ oldRunCode: rerun.oldRunCode, newRunCode: rerun.newRunCode }));
      const cogsRepost = await repostCogsForReruns(
        reruns,
        outcome.kind === "POSTED" ? outcome.documents.map((doc) => ({ date: doc.transactionDate, branchCode: doc.branchCode })) : [],
        auth.session.name,
      );
      if (outcome.kind === "EMPTY") {
        if (reruns.length > 0) {
          return NextResponse.json({ reruns: rerunSummary, runCode: null, documentCount: reruns.reduce((sum, rerun) => sum + rerun.documents.length, 0), cogsRepost });
        }
        businessError(timeTo === null
          ? "Không có dòng doanh thu, phiếu điều chuyển hay kiểm kê bán thành phẩm nào đang chờ rã trong khoảng ngày đã chọn."
          : `Không có dòng doanh thu nào bán trước ${String(timeTo).padStart(2, "0")}:00 đang chờ rã. Rã tới giờ chỉ lấy được dòng có giờ bán — file POS chỉ ghi ngày thì phải rã cả ngày.`);
      }
      // Dòng không theo dõi tồn kho đã được thả khỏi hàng chờ (transaction trên đã commit) —
      // báo lỗi sau khi commit để lần bấm sau không gặp lại chúng.
      if (outcome.kind === "ALL_SKIPPED" && reruns.length > 0) {
        return NextResponse.json({ reruns: rerunSummary, runCode: null, documentCount: reruns.reduce((sum, rerun) => sum + rerun.documents.length, 0), cogsRepost });
      }
      if (outcome.kind === "ALL_SKIPPED") {
        businessError(`Cả ${outcome.skippedRows} dòng doanh thu trong khoảng ngày này đều thuộc nhóm doanh thu không theo dõi tồn kho — đã bỏ khỏi hàng chờ, không có gì để rã.`);
      }
      const { plan, stockUsed, negativeItems, zeroCostItems, undecidedProducts, sources, keptPriceTransfers } = outcome;

      await writeAuditLog({
        session: auth.session, module: menuHref, action: "EXPLODE_PRODUCTION",
        entityType: "InventoryTransaction", entityCode: outcome.runCode, branchCode,
        metadata: {
          dateFrom, dateTo, timeTo, postedAt: outcome.postedAt, ...outcome.warehouses,
          revenueRows: outcome.revenueRows,
          skippedRows: outcome.skippedRows,
          sources: sources.map((source) => source.code),
          keptPriceTransfers,
          undecidedProducts,
          negativeItems,
          zeroCostItems,
          productions: plan.productions.map((step) => ({ productCode: step.productCode, quantityBase: step.quantityBase })),
          stockUsed,
          documents: outcome.documents.map((doc) => doc.code),
        },
      });
      return NextResponse.json({
        reruns: rerunSummary,
        runCode: outcome.runCode,
        postedAt: outcome.postedAt,
        // Rã tới giờ: dòng doanh thu ngày cuối không có giờ bán nên còn nằm ở hàng chờ.
        unsplitRows: outcome.unsplitRows,
        documentCount: outcome.documents.length,
        revenueRows: outcome.revenueRows,
        skippedRows: outcome.skippedRows,
        transferCount: sources.filter((source) => source.kind === "TRANSFER").length,
        issueCount: sources.filter((source) => source.kind === "ISSUE").length,
        stocktakeCount: sources.filter((source) => source.kind === "STOCKTAKE").length,
        keptPriceTransfers,
        // Số món phải dùng kho mặc định vì không suy được bếp/bar — để màn hình nhắc người dùng
        // gán Nhóm doanh thu cho những mã này.
        undecidedCount: undecidedProducts.length,
        undecidedProducts: undecidedProducts.slice(0, 20),
        // Hệ quả của luật xuất âm, để màn hình nhắc người dùng đi khai tồn/giá cho các mã này.
        negativeCount: negativeItems.length,
        negativeItems: negativeItems.slice(0, 20),
        zeroCostCount: zeroCostItems.length,
        zeroCostItems: zeroCostItems.slice(0, 20),
        productions: plan.productions.map((step) => ({ productCode: step.productCode, quantityBase: step.quantityBase, batchQuantity: step.batchQuantity })),
        directSales: plan.directSales,
        // Phần lấy từ tồn thay vì chế biến mới (lấy tồn trước, chế biến phần thiếu).
        stockUsed,
        documents: outcome.documents,
        cogsRepost,
      }, { status: 201 });
    }

    /**
     * Nút "Tính giá vốn & giá thành" cuối kỳ.
     *
     * Chạy tuần tự đúng thứ tự kế toán: giá vốn nguyên liệu (bình quân gia quyền theo tồn)
     * → giá thành bán thành phẩm cấp 1 → cấp 2 → ... → thành phẩm → combo. Kết quả ghi
     * đè giá vốn bình quân của chính các mặt hàng có định lượng trong kho của cửa hàng,
     * nhờ vậy mọi phiếu xuất/nhập chế biến/điều chỉnh sau đó đều lấy đúng giá mới.
     */
    if (action === "RUN_COSTING") {
      const branchCode = cleanText(body.branchCode) || "ALL";
      const costingDate = toDate(body.costingDate);
      if (branchCode !== "ALL") assertBranchAccess(auth.session, branchCode);
      if (branchCode !== "ALL" && await isPeriodLocked(costingDate, branchCode)) businessError("Kỳ kế toán đã khóa");

      const warehouses = await prisma.masterDataItem.findMany({
        where: { type: "WAREHOUSE", status: "ACTIVE", ...(branchCode === "ALL" ? {} : { branch: branchCode }) },
        select: { code: true },
      });
      const warehouseCodes = warehouses.map((warehouse) => warehouse.code);
      if (warehouseCodes.length === 0) businessError(`Cửa hàng ${branchCode} chưa khai kho nào để tính giá.`);

      const [items, balances, recipeRows] = await Promise.all([
        prisma.inventoryItem.findMany({ select: { id: true, code: true, itemType: true } }),
        prisma.inventoryBalance.findMany({ select: { itemId: true, warehouseCode: true, quantity: true, averageCost: true } }),
        prisma.recipe.findMany({ where: { deletedAt: null }, include: { lines: { include: { item: true } } } }),
      ]);

      // Bước 1 — giá vốn nguyên liệu: bình quân GIA QUYỀN theo tồn DƯƠNG của mọi kho (kho âm
      // không cộng vào), dùng chung với Sheet tổng hợp — xem lib/inventory-average-cost.ts.
      const averageCostByItemId = averageCostByItem(balances);

      // Bước 2..n — giá thành theo tầng định lượng.
      const itemTypeByCode = new Map(items.map((item) => [item.code.toUpperCase(), item.itemType]));
      // Tính giá cho cửa hàng nào thì ăn công thức của chính cửa hàng đó; chạy "Tất cả cửa
      // hàng" thì lấy bản dùng chung (món chỉ có bản riêng vẫn lên bảng, xem scopeRecipesToBranch).
      const levels = computeCostingLevels(
        recipeRows as unknown as ExplosionRecipe[],
        averageCostByItemId,
        costingDate,
        itemTypeByCode,
        branchCode === "ALL" ? undefined : branchCode,
      );
      const itemByCode = new Map(items.map((item) => [item.code.toUpperCase(), item]));

      // Bước cuối — giá vốn cuối kỳ: ghi đè bình quân của mặt hàng có định lượng trong kho
      // của cửa hàng đang tính. Chỉ đụng mặt hàng thực sự tính được giá (> 0).
      let updatedBalances = 0;
      await prisma.$transaction(async (tx) => {
        for (const level of levels) {
          for (const product of level.products) {
            if (!(product.unitCost > 0)) continue;
            const item = itemByCode.get(product.productCode);
            if (!item) continue;
            const result = await tx.inventoryBalance.updateMany({
              where: { itemId: item.id, warehouseCode: { in: warehouseCodes } },
              data: { averageCost: product.unitCost },
            });
            updatedBalances += result.count;
          }
        }
      }, { timeout: 60000 });

      await writeAuditLog({
        session: auth.session, module: menuHref, action: "RUN_COSTING",
        entityType: "InventoryBalance", entityCode: `COSTING-${costingDate.toISOString().slice(0, 10)}`,
        branchCode: branchCode === "ALL" ? undefined : branchCode,
        metadata: {
          costingDate, warehouseCodes, updatedBalances,
          levels: levels.map((level) => ({ level: level.level, products: level.products.length })),
        },
      });

      return NextResponse.json({
        costingDate,
        branchCode,
        materialCount: averageCostByItemId.size,
        updatedBalances,
        levels,
      }, { status: 201 });
    }

    /**
     * Hoàn tác nguyên một lần rã nguyên liệu: hoàn kho + xoá mềm mọi phiếu của lần rã
     * (mã RA-...), trả các dòng doanh thu về trạng thái chờ rã. Phiếu của lần rã bị chặn
     * xoá lẻ (referenceType PRODUCTION) nên đây là đường lùi duy nhất — và an toàn vì đi
     * theo đúng cụm.
     */
    /**
     * Hoàn tác một lần sinh phiếu kho theo cặp: rã nguyên liệu (RA-...) và chế biến bán thành
     * phẩm (CB-...) đều đẻ ra một chùm phiếu PRODUCTION dùng chung `referenceCode`, nên hoàn
     * tác y hệt nhau — hoàn kho từng dòng rồi xoá cả chùm. Chế biến trước đây không có đường
     * lùi: lập nhầm số mẻ là nguyên liệu đã trừ khỏi kho mà không gỡ lại được.
     */
    if (action === "REVERT_EXPLOSION" || action === "REVERT_PRODUCTION") {
      const runCode = (cleanText(body.runCode) || cleanText(body.referenceCode)).toUpperCase();
      const runLabel = action === "REVERT_PRODUCTION" ? "lệnh chế biến" : "lần rã";
      if (!runCode) businessError(action === "REVERT_PRODUCTION" ? "Thiếu mã lệnh chế biến (CB-...)" : "Thiếu mã lần rã (RA-...)");
      const documents = await prisma.inventoryTransaction.findMany({
        where: { referenceType: "PRODUCTION", referenceCode: runCode, deletedAt: null },
        include: { lines: true },
        orderBy: { createdAt: "desc" },
      });
      if (documents.length === 0) businessError(`Không tìm thấy phiếu nào của ${runLabel} ${runCode}`);
      const branchCode = documents[0]?.branchCode || "";
      assertBranchAccess(auth.session, branchCode);
      await assertPeriodOpen(documents.map((doc) => ({ date: doc.transactionDate, branchCode: doc.branchCode })), `hoàn tác ${runLabel}`);

      // Chỉ hoàn kho chính xác khi chưa có phiếu nào khác phát sinh sau trên cùng mặt hàng/kho.
      const documentIds = documents.map((doc) => doc.id);
      const itemIds = [...new Set(documents.flatMap((doc) => doc.lines.map((line) => line.itemId)))];
      const warehouseCodes = [...new Set(documents.flatMap((doc) => [doc.warehouseCode, doc.toWarehouseCode]).filter((value): value is string => !!value))];
      const earliest = documents[documents.length - 1];
      const newer = await prisma.inventoryTransaction.findFirst({
        where: {
          id: { notIn: documentIds },
          deletedAt: null,
          createdAt: { gt: earliest?.createdAt || new Date(0) },
          lines: { some: { itemId: { in: itemIds } } },
          OR: [
            { warehouseCode: { in: warehouseCodes } },
            { toWarehouseCode: { in: warehouseCodes } },
          ],
        },
      });
      if (newer) {
        businessError(`Đã có phiếu ${newer.code} phát sinh sau ${runLabel} ${runCode} trên cùng mặt hàng/kho nên không thể hoàn tác chính xác. Xoá phiếu đó trước.`);
      }

      await prisma.$transaction(async (tx) => {
        for (const doc of documents) {
          for (const line of doc.lines) {
            const direction = doc.transactionType.startsWith("NHAP_") ? "IN" : "OUT";
            const balance = await tx.inventoryBalance.findUnique({
              where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode: doc.warehouseCode } },
            });
            const currentQuantity = balance?.quantity || 0;
            const currentAverage = balance?.averageCost || 0;
            const currentValue = currentQuantity * currentAverage;
            // Hoàn tác không chặn ở mức 0 (luật xuất âm): lần rã chạy trên kho đang âm thì hoàn
            // lại cũng phải về đúng số âm cũ, cắt về 0 là tự nhiên mất hàng.
            const newQuantity = direction === "IN" ? currentQuantity - line.quantity : currentQuantity + line.quantity;
            const newValue = direction === "IN" ? currentValue - line.totalCost : currentValue + line.totalCost;
            const averageCost = newQuantity > quantityEpsilon ? Math.max(newValue / newQuantity, 0) : currentAverage;
            await tx.inventoryBalance.upsert({
              where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode: doc.warehouseCode } },
              create: { itemId: line.itemId, warehouseCode: doc.warehouseCode, quantity: newQuantity, averageCost },
              update: { quantity: newQuantity, averageCost },
            });
          }
          await tx.inventoryTransaction.update({
            where: { id: doc.id },
            data: { deletedAt: new Date(), deletedBy: auth.session.name },
          });
        }
        await tx.revenueImportRow.updateMany({
          where: { inventoryStatus: `POSTED:${runCode}` },
          data: { inventoryStatus: "PENDING" },
        });
        // Điều chuyển / kiểm dư bán thành phẩm của lần rã về lại hàng chờ.
        await releaseExplosionSources(tx, runCode);
      }, { timeout: 60000 });

      await writeAuditLog({
        session: auth.session, module: menuHref, action,
        entityType: "InventoryTransaction", entityCode: runCode, branchCode,
        metadata: { documents: documents.map((doc) => doc.code) },
      });
      // Phiếu của lần rã / chế biến vừa hoàn tác thành mồ côi trên sổ: ghi lại giá vốn kỳ đó để dọn.
      // Chế biến (CB-) chỉ có phiếu sản xuất, không phải phiếu giá vốn — không cần ghi lại.
      const cogsRepost = action === "REVERT_EXPLOSION"
        ? await repostInventoryCogs(documents.map((doc) => ({ date: doc.transactionDate, branchCode: doc.branchCode })), auth.session.name)
        : [];
      return NextResponse.json({ runCode, revertedDocuments: documents.length, cogsRepost });
    }

    /**
     * Điều chuyển kho — tab riêng. Cùng nhà hàng: chỉ cộng trừ tồn giữa hai kho.
     * Khác nhà hàng: sinh cặp công nợ nội bộ phải thu/phải trả theo trị giá xuất kho.
     * Không cho điều chuyển nhóm FINISHED (postStockTransfer chặn tầng cuối).
     */
    if (action === "TRANSFER_STOCK") {
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const toWarehouseCode = cleanText(body.toWarehouseCode);
      const transactionDate = toDate(body.transactionDate);
      if (!branchCode || !warehouseCode || !toWarehouseCode) businessError("Điều chuyển cần cửa hàng, kho xuất và kho nhận");
      if (warehouseCode === toWarehouseCode) businessError("Kho xuất và kho nhận không được trùng nhau");
      assertBranchAccess(auth.session, branchCode);
      // Chỉ chặn kho xuất: điều chuyển sang kho của bộ phận khác là việc bình thường.
      assertWarehouseAccess(auth.session, warehouseCode, "Kho xuất");
      const [sourceWarehouse, destinationWarehouse] = await Promise.all([
        prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode } }),
        prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: toWarehouseCode, status: "ACTIVE" } }),
      ]);
      if (!sourceWarehouse) businessError(`Kho ${warehouseCode} không thuộc cửa hàng ${branchCode}.`);
      if (!destinationWarehouse) businessError(`Kho nhận ${toWarehouseCode} không tồn tại hoặc ngưng hoạt động`);
      const toBranchCode = (destinationWarehouse?.branch || branchCode).toUpperCase();
      if (destinationWarehouse?.branch) assertBranchAccess(auth.session, destinationWarehouse.branch);
      if (await isPeriodLocked(transactionDate, branchCode)) businessError("Kỳ kế toán đã khóa");
      if (toBranchCode !== branchCode.toUpperCase() && await isPeriodLocked(transactionDate, toBranchCode)) {
        businessError(`Kỳ kế toán của cửa hàng nhận ${toBranchCode} đã khóa`);
      }
      const inputLines = linesFrom(body.lines);
      if (inputLines.length === 0) businessError("Cần ít nhất một dòng hàng điều chuyển");

      const requestedCode = cleanText(body.code);
      if (requestedCode && await findDeletedByUnique("InventoryTransaction", { code: requestedCode })) {
        businessError(duplicatedInTrashMessage(requestedCode, "Phiếu điều chuyển kho"));
      }
      const result = await prisma.$transaction(async (tx) => {
        const transferCode = requestedCode || await nextStockDocCode(tx, "DCK", transactionDate);
        return postStockTransfer(tx, {
          code: transferCode,
          transactionDate,
          branchCode,
          warehouseCode,
          toWarehouseCode,
          toBranchCode,
          referenceCode: cleanText(body.referenceCode) || null,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          lines: inputLines,
        });
      });
      await writeAuditLog({
        session: auth.session, module: menuHref, action: "TRANSFER_STOCK",
        entityType: "InventoryTransaction", entityId: result.transaction.id, entityCode: result.transaction.code, branchCode,
        metadata: { toBranchCode, warehouseCode, toWarehouseCode, crossBranch: toBranchCode !== branchCode.toUpperCase(), receivable: result.receivable?.code, payable: result.payable?.code },
      });
      return NextResponse.json(result, { status: 201 });
    }

    const transactionType = normalizeStockTransactionType(action === "RECORD_WASTE" ? "XUAT_HUY" : body.transactionType);
    const transactionDate = toDate(body.transactionDate);
    const branchCode = cleanText(body.branchCode);
    const warehouseCode = cleanText(body.warehouseCode);
    const toWarehouseCode = cleanText(body.toWarehouseCode);
    if (!branchCode || !warehouseCode) businessError("Cửa hàng và kho là bắt buộc");
    assertBranchAccess(auth.session, branchCode);
    assertWarehouseAccess(auth.session, warehouseCode);

    // Validate that the warehouse belongs to the branch
    const warehouse = await prisma.masterDataItem.findFirst({
      where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode }
    });
    if (!warehouse) {
      businessError(`Kho ${warehouseCode} không thuộc chi nhánh ${branchCode}.`);
    }
    let destinationBranchCode: string | null = null;
    if (transactionType === "DIEU_CHUYEN") {
      const destinationWarehouse = await prisma.masterDataItem.findFirst({
        where: { type: "WAREHOUSE", code: toWarehouseCode, status: "ACTIVE" }
      });
      if (!destinationWarehouse) businessError(`Kho nhận ${toWarehouseCode} không tồn tại hoặc ngưng hoạt động`);
      if (destinationWarehouse?.branch) assertBranchAccess(auth.session, destinationWarehouse.branch);
      // Điều chuyển liên nhà hàng giờ được hỗ trợ chính thức: phiếu nhớ cửa hàng nhận
      // (toBranchCode) và postStockTransfer sinh cặp công nợ nội bộ, nên báo cáo hai bên
      // đều giải thích được tồn tăng/giảm.
      destinationBranchCode = (destinationWarehouse?.branch || branchCode).toUpperCase();
    }

    if (await isPeriodLocked(transactionDate, branchCode)) businessError("Kỳ kế toán đã khóa");
    if (destinationBranchCode && destinationBranchCode !== branchCode.toUpperCase() && await isPeriodLocked(transactionDate, destinationBranchCode)) {
      businessError(`Kỳ kế toán của cửa hàng nhận ${destinationBranchCode} đã khóa`);
    }

    // Loại hủy bắt buộc khi hủy hàng từ tab Hủy hàng; phiếu XUAT_HUY khác (import cũ) thì tuỳ chọn.
    let wasteSubType: string | null = null;
    if (transactionType === "XUAT_HUY") {
      wasteSubType = normalizeWasteSubType(body.wasteType ?? body.subType);
      if (wasteSubType && !isWasteSubType(wasteSubType)) {
        businessError("Loại hủy không hợp lệ. Chọn: Hết hạn sử dụng hoặc Không đảm bảo chất lượng.");
      }
      if (action === "RECORD_WASTE" && !wasteSubType) {
        businessError("Chọn loại hủy: Hết hạn sử dụng hoặc Không đảm bảo chất lượng.");
      }
    }

    let inputLines = linesFrom(body.lines);
    if (action === "RECORD_WASTE" && cleanText(body.recipeId)) {
      // Hủy theo món: rã định lượng của món ra nguyên liệu (kể cả hệ số quy đổi ĐVT).
      const recipe = await prisma.recipe.findUnique({ where: { id: cleanText(body.recipeId) }, include: { lines: true } });
      if (!recipe) businessError("Không tìm thấy định lượng món hủy");
      const productQuantity = toNumber(body.productQuantity);
      if (productQuantity <= 0) businessError("Số lượng món hủy phải lớn hơn 0");
      const outputRate = recipe && recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
      const batches = productQuantity / outputRate;
      inputLines = (recipe?.lines || []).map((line) => {
        const quantity = line.quantity * (line.conversionRate || 1) * (1 + line.wasteRate / 100) * batches;
        return {
          itemId: line.itemId,
          itemCode: "",
          // Hủy hàng không có thuế đầu vào: khai rõ để cùng kiểu với dòng người dùng gửi lên.
          vatAmount: undefined,
          quantity,
          inputQuantity: quantity,
          unitCode: "",
          inputUnitCode: "",
          unitCost: 0,
          inputUnitCost: 0,
          // Huy hang la phieu XUAT: khong co hoa don dau vao nen khong co thue GTGT.
          vatRate: null,
          wasteRate: 0,
          conversionRate: 1,
        };
      });
    }
    if (inputLines.length === 0) businessError("Cần ít nhất một dòng nguyên liệu");

    const requestedTransactionCode = cleanText(body.code);
    if (requestedTransactionCode && await findDeletedByUnique("InventoryTransaction", { code: requestedTransactionCode })) {
      businessError(duplicatedInTrashMessage(requestedTransactionCode, "Phiếu nhập/xuất kho"));
    }

    // NCC / đối tác của phiếu. Chỉ nhận mã có trong danh mục để cột "Tên NCC" và bộ lọc
    // đối tác trên màn Nhập/Xuất kho không bao giờ hiện mã lạ không tra được tên.
    const stockPartnerCode = cleanText(body.partnerCode) || null;
    const paymentDueDate = cleanText(body.paymentDueDate) ? new Date(cleanText(body.paymentDueDate)) : null;
    if (paymentDueDate && Number.isNaN(paymentDueDate.getTime())) businessError("Hạn thanh toán không hợp lệ");
    if (stockPartnerCode) {
      const partner = await prisma.masterDataItem.findFirst({ where: { type: "PARTNER", code: stockPartnerCode } });
      if (!partner) businessError(`Đối tác ${stockPartnerCode} không có trong danh mục`);
    }

    const result = await prisma.$transaction(async (tx) => {
      const transactionCode = cleanText(body.code) || await nextStockDocCode(tx, stockPrefix(transactionType), transactionDate);
      // Điều chuyển luôn đi qua postStockTransfer để chặn FINISHED và sinh công nợ nội bộ
      // khi kho nhận thuộc nhà hàng khác — kể cả phiếu tạo từ màn hình Nhập/Xuất cũ.
      if (transactionType === "DIEU_CHUYEN") {
        const transfer = await postStockTransfer(tx, {
          code: transactionCode,
          transactionDate,
          branchCode,
          warehouseCode,
          toWarehouseCode,
          toBranchCode: destinationBranchCode,
          referenceCode: cleanText(body.referenceCode) || null,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          lines: inputLines,
        });
        return transfer.transaction;
      }
      const posted = await postInventoryTransaction(tx, {
        code: transactionCode,
        transactionType,
        subType: wasteSubType,
        transactionDate,
        branchCode,
        warehouseCode,
        toWarehouseCode,
        partnerCode: stockPartnerCode,
        referenceType: action === "RECORD_WASTE" ? "POS_WASTE" : cleanText(body.referenceType) || null,
        referenceCode: cleanText(body.referenceCode) || null,
        note: cleanText(body.note) || null,
        createdBy: auth.session.name,
        lines: inputLines,
      });
      // Nhập mua có khai NCC thì sinh khoản phải trả, đúng luật của phiếu nhập từ file import.
      await createPurchasePayable(tx, posted, { dueDate: paymentDueDate });
      return posted;
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

/**
 * Sửa thông tin nghiệp vụ của các thực thể kho.
 * body: { action: "UPDATE_ITEM" | "UPDATE_TRANSACTION" | "UPDATE_STOCKTAKE" | "UPDATE_RECIPE", ... }
 */
export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "edit");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const action = cleanText(body.action);

    // Bật/ngưng hàng loạt: rollback lô import ngưng cả danh mục (lib/import-commit.ts),
    // import lại KHÔNG bật lại được nếu file thiếu cột Trạng thái — 3.500 mã kẹt "Ngưng" thì
    // không thể sửa tay từng mã, và mọi file BOM/nhập kho đều bị chặn.
    if (action === "BULK_SET_ITEM_STATUS") {
      const status = cleanText(body.status).toUpperCase() || "ACTIVE";
      if (!["ACTIVE", "INACTIVE"].includes(status)) businessError("Trạng thái chỉ nhận ACTIVE hoặc INACTIVE");
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map((id: unknown) => cleanText(id)).filter(Boolean) : [];
      if (itemIds.length === 0) businessError("Chưa chọn mặt hàng nào để đổi trạng thái");
      const result = await prisma.inventoryItem.updateMany({
        where: { id: { in: itemIds }, deletedAt: null, status: { not: status } },
        data: { status },
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "BULK_SET_ITEM_STATUS", entityType: "InventoryItem", metadata: { status, requested: itemIds.length, changed: result.count } });
      return NextResponse.json({ status, requested: itemIds.length, changed: result.count });
    }

    if (action === "UPDATE_ITEM") {
      const itemId = cleanText(body.itemId) || cleanText(body.id);
      if (!itemId) businessError("Thiếu mặt hàng cần sửa");
      const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
      if (!item) businessError("Không tìm thấy mặt hàng");

      const name = body.name !== undefined ? cleanText(body.name) : item.name;
      if (!name) businessError("Tên mặt hàng không được để trống");
      const unit = body.unit !== undefined ? cleanText(body.unit) : item.unit;
      if (!unit) businessError("Đơn vị tính không được để trống");
      const itemType = body.itemType !== undefined ? normalizeItemType(body.itemType) : item.itemType;
      if (!validItemTypes.includes(itemType)) businessError("Loại mặt hàng không hợp lệ");
      const minStock = body.minStock !== undefined ? toNumber(body.minStock) : item.minStock;
      if (minStock < 0) businessError("Tồn tối thiểu không được âm");

      const [postedLines, stockBalance] = await Promise.all([
        prisma.inventoryTransactionLine.count({ where: { itemId } }),
        prisma.inventoryBalance.aggregate({ where: { itemId }, _sum: { quantity: true } }),
      ]);
      const onHand = stockBalance._sum.quantity || 0;
      const hasHistory = postedLines > 0 || Math.abs(onHand) > quantityEpsilon;

      if (hasHistory && unit.toUpperCase() !== item.unit.toUpperCase()) {
        businessError(`Mặt hàng ${item.code} đã phát sinh giao dịch/tồn kho nên không thể đổi đơn vị tính cơ bản. Hãy khai báo quy đổi đơn vị thay vì sửa ĐVT.`);
      }
      if (hasHistory && itemType !== item.itemType) {
        businessError(`Mặt hàng ${item.code} đã phát sinh giao dịch/tồn kho nên không thể đổi loại mặt hàng.`);
      }
      const result = await prisma.inventoryItem.update({
        where: { id: itemId },
        data: {
          name,
          unit,
          itemType,
          minStock,
          ...(body.category !== undefined ? { category: await resolveItemCategory(itemType, body.category) } : {}),
          ...(body.revenueGroup !== undefined ? { revenueGroup: await resolveItemRevenueGroup(body.revenueGroup, item.revenueGroup) } : {}),
          ...(body.requiresImage !== undefined ? { requiresImage: !!body.requiresImage } : {}),
          ...(body.status !== undefined ? { status: cleanText(body.status).toUpperCase() || "ACTIVE" } : {}),
          ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
        },
        include: { unitConversions: true },
      });
      if (unit.toUpperCase() !== item.unit.toUpperCase()) {
        await createOrUpdateConversion(itemId, unit, 1, "ĐVT cơ bản");
      }
      if (body.purchaseUnit !== undefined && cleanText(body.purchaseUnit)) {
        await createOrUpdateConversion(itemId, cleanText(body.purchaseUnit), toNumber(body.conversionRate), cleanText(body.conversionNote));
      }

      await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_ITEM", entityType: "InventoryItem", entityId: result.id, entityCode: result.code, metadata: { changedFields: Object.keys(body).filter((field) => field !== "action" && field !== "itemId" && field !== "id"), postedLines, onHand } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_TRANSACTION") {
      const transactionId = cleanText(body.transactionId) || cleanText(body.id);
      if (!transactionId) businessError("Thiếu phiếu kho cần sửa");
      const transaction = await prisma.inventoryTransaction.findUnique({
        where: { id: transactionId },
        include: { lines: true },
      });
      if (!transaction) businessError("Không tìm thấy phiếu nhập/xuất kho");
      assertBranchAccess(auth.session, transaction.branchCode);
      assertWarehouseAccess(auth.session, transaction.warehouseCode);

      const derivedFrom = transaction.referenceType ? derivedReferenceTypes[transaction.referenceType] : undefined;
      if (derivedFrom) {
        businessError(`Phiếu ${transaction.code} được sinh tự động từ ${derivedFrom} ${transaction.referenceCode || ""}`.trim() + " nên phải sửa ở chứng từ gốc.");
      }
      if (await isPeriodLocked(transaction.transactionDate, transaction.branchCode)) businessError("Kỳ kế toán đã khóa");

      const transactionDate = body.transactionDate !== undefined ? toDate(body.transactionDate) : transaction.transactionDate;
      if (body.transactionDate !== undefined && await isPeriodLocked(transactionDate, transaction.branchCode)) {
        businessError("Kỳ kế toán của ngày chứng từ mới đã khóa");
      }

      const editedLines = body.lines !== undefined ? linesFrom(body.lines) : [];
      const warehouseCode = body.warehouseCode !== undefined ? cleanText(body.warehouseCode) : transaction.warehouseCode;
      const toWarehouseCode = body.toWarehouseCode !== undefined ? cleanText(body.toWarehouseCode) : transaction.toWarehouseCode;
      if (warehouseCode !== transaction.warehouseCode) assertWarehouseAccess(auth.session, warehouseCode);
      const isTransfer = transaction.transactionType === "DIEU_CHUYEN";
      // Điều chuyển định giá theo NGÀY chứng từ (luật đơn giá trong tháng), nên đổi ngày cũng
      // phải ghi lại dòng để giá và công nợ nội bộ đi theo tháng mới.
      const rewritesLines = editedLines.length > 0 || warehouseCode !== transaction.warehouseCode || toWarehouseCode !== transaction.toWarehouseCode
        || (isTransfer && transactionDate.getTime() !== transaction.transactionDate.getTime());

      if (body.lines !== undefined && editedLines.length === 0) businessError("Phiếu phải còn ít nhất một dòng mặt hàng");
      // Điều chuyển đã rã BOM: phiếu chế biến của lần rã tính theo đúng số / kho / ngày này.
      const transferRun = explodedRunOf(transaction.explosionStatus);
      if (rewritesLines && transferRun) {
        businessError(`Phiếu ${transaction.code} đã rã BOM trong lần rã ${transferRun}. Hoàn tác lần rã đó ở tab Chế biến rồi mới sửa số lượng, kho hay ngày.`);
      }

      /**
       * Điều chuyển: cửa hàng nhận đi theo KHO NHẬN, đổi kho nhận sang nhà hàng khác thì phiếu
       * đổi phạm vi (nội bộ ↔ liên nhà hàng). Cặp công nợ nội bộ được đồng bộ lại theo số mới
       * sau khi ghi phiếu (syncTransferInternalDebt) — nợ đã gạch thì chặn ở đó.
       */
      let toBranchCode = transaction.toBranchCode;
      if (isTransfer) {
        if (!toWarehouseCode) businessError("Điều chuyển kho bắt buộc có kho nhận");
        const destination = await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: toWarehouseCode } });
        if (!destination) businessError(`Kho nhận ${toWarehouseCode} không có trong danh mục`);
        const destinationBranch = (destination.branch || transaction.branchCode).toUpperCase();
        toBranchCode = destinationBranch !== transaction.branchCode.toUpperCase() ? destinationBranch : null;
        for (const branch of new Set([transaction.toBranchCode, toBranchCode].filter((value): value is string => !!value))) {
          if (await isPeriodLocked(transaction.transactionDate, branch) || await isPeriodLocked(transactionDate, branch)) {
            businessError(`Kỳ kế toán của cửa hàng nhận ${branch} đã khóa`);
          }
        }
      }

      // Nhập mua đã sinh công nợ NCC: sửa xong phải dựng lại khoản nợ theo số mới, nhưng đã
      // gạch nợ bằng phiếu chi thì không đụng được nữa.
      const purchaseDebt = await prisma.debtRecord.findFirst({
        where: { code: purchasePayableCodeOf(transaction.code), sourceType: PURCHASE_PAYABLE_SOURCE, deletedAt: null },
        include: { settlements: true },
      });
      if (purchaseDebt && purchaseDebt.settlements.length > 0) {
        businessError(`Công nợ ${purchaseDebt.code} của phiếu ${transaction.code} đã được gạch nợ nên không sửa được phiếu. Hoàn tác phiếu chi gạch nợ trước.`);
      }

      if (warehouseCode !== transaction.warehouseCode) {
        const warehouse = await prisma.masterDataItem.findFirst({
          where: { type: "WAREHOUSE", code: warehouseCode, branch: transaction.branchCode },
        });
        if (!warehouse) businessError(`Kho ${warehouseCode} không thuộc chi nhánh ${transaction.branchCode}.`);
      }

      // Phiếu hủy sửa được loại hủy (nhiều phiếu import cũ đang "Chưa phân loại"); để trống = bỏ phân loại.
      let subType = transaction.subType;
      if (transaction.transactionType === "XUAT_HUY" && body.subType !== undefined) {
        subType = normalizeWasteSubType(body.subType);
        if (subType && !isWasteSubType(subType)) {
          businessError("Loại hủy không hợp lệ. Chọn: Hết hạn sử dụng hoặc Không đảm bảo chất lượng.");
        }
      }

      const partnerCode = body.partnerCode !== undefined ? cleanText(body.partnerCode) || null : transaction.partnerCode;
      if (partnerCode && partnerCode !== transaction.partnerCode) {
        const partner = await prisma.masterDataItem.findFirst({ where: { type: "PARTNER", code: partnerCode } });
        if (!partner) businessError(`Đối tác ${partnerCode} không có trong danh mục`);
      }

      const result = await prisma.$transaction(async (tx) => {
        const updated = rewritesLines
          ? await repostInventoryTransaction(tx, transaction, {
            transactionDate,
            branchCode: transaction.branchCode,
            warehouseCode,
            toWarehouseCode,
            toBranchCode,
            subType,
            partnerCode,
            referenceCode: body.referenceCode !== undefined ? cleanText(body.referenceCode) || null : transaction.referenceCode,
            note: body.note !== undefined ? cleanText(body.note) || null : transaction.note,
            // Giu nguyen thue suat VA tien thue da khai cua dong cu khi chi sua phan dau phieu:
            // bo qua o day la sua ngay chung tu cung lam bay het thue (cong no NCC tut xuong so
            // truoc thue), hoac lam mat so thue khai theo hoa don va quay ve so tu tinh.
            lines: editedLines.length > 0 ? editedLines : transaction.lines.map((line) => ({
              itemId: line.itemId,
              inputQuantity: line.inputQuantity ?? line.quantity,
              inputUnitCode: line.inputUnitCode ?? "",
              inputUnitCost: line.inputUnitCost ?? line.unitCost,
              vatRate: line.vatRate,
              vatAmount: line.vatAmount,
            })),
          })
          : await tx.inventoryTransaction.update({
            where: { id: transactionId },
            data: {
              transactionDate,
              partnerCode,
              subType,
              ...(body.referenceCode !== undefined ? { referenceCode: cleanText(body.referenceCode) || null } : {}),
              ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
            },
            include: { lines: { include: { item: true } } },
          });

        // Điều chuyển: cặp công nợ nội bộ theo trị giá và phạm vi mới của phiếu; dòng đổi thì
        // hàng chờ rã tính lại (thêm / bỏ bán thành phẩm).
        if (isTransfer) {
          await refreshTransferExplosionStatus(tx, updated.id);
          return (await syncTransferInternalDebt(tx, updated.id)).transaction;
        }
        // Huỷ / xuất khác: dòng đổi thì hàng chờ rã tính lại như điều chuyển.
        if (isExplosionIssueType(updated.transactionType)) await refreshTransferExplosionStatus(tx, updated.id);
        // Công nợ nhập mua theo số mới: sửa khoản đang có, bỏ NCC thì thu khoản nợ về.
        await syncPurchasePayable(tx, { ...updated, partnerCode }, { importBatchId: transaction.importBatchId });
        return updated;
      });

      await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_TRANSACTION", entityType: "InventoryTransaction", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousDate: transaction.transactionDate, transactionDate, rewritesLines, lineCount: result.lines.length } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_STOCKTAKE") {
      const stocktakeId = cleanText(body.stocktakeId) || cleanText(body.id);
      if (!stocktakeId) businessError("Thiếu phiếu kiểm kê cần sửa");
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
      assertWarehouseAccess(auth.session, stocktake.warehouseCode);
      if (stocktake.status === "APPROVED") {
        businessError(`Phiếu kiểm kê ${stocktake.code} đã duyệt và đã điều chỉnh tồn kho nên không thể sửa.`);
      }
      if (stocktake.locationCode) businessError(`Phiếu ${stocktake.code} là phiếu đếm theo vị trí — sửa ở mục Kiểm kê theo vị trí.`);

      const warehouseCode = body.warehouseCode !== undefined ? cleanText(body.warehouseCode) : stocktake.warehouseCode;
      if (!warehouseCode) businessError("Kho kiểm kê không được để trống");
      assertWarehouseAccess(auth.session, warehouseCode);
      const stocktakeDate = body.stocktakeDate !== undefined ? toDate(body.stocktakeDate) : stocktake.stocktakeDate;
      if (await isPeriodLocked(stocktakeDate, stocktake.branchCode)) businessError("Kỳ kế toán đã khóa");
      if (warehouseCode !== stocktake.warehouseCode) {
        const warehouse = await prisma.masterDataItem.findFirst({
          where: { type: "WAREHOUSE", code: warehouseCode, branch: stocktake.branchCode },
        });
        if (!warehouse) businessError(`Kho ${warehouseCode} không thuộc chi nhánh ${stocktake.branchCode}.`);
      }

      const result = await prisma.stocktakeSession.update({
        where: { id: stocktakeId },
        data: {
          warehouseCode,
          stocktakeDate,
          ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
        },
        include: { lines: { include: { item: true } } },
      });

      await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_STOCKTAKE", entityType: "StocktakeSession", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { warehouseCode, stocktakeDate } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_RECIPE") {
      /**
       * Sửa thẳng một phiên bản định lượng. Bảng gom các cửa hàng pha giống nhau về một dòng
       * (mỗi nơi vẫn là một bản ghi riêng), nên nhận `recipeIds` để sửa cả dòng một lượt.
       *
       * Phiên bản đã được dùng để rã nguyên liệu thì sửa xong phải rã lại: lần gọi đầu trả 409
       * kèm danh sách lần rã, người dùng xác nhận thì gọi lại với `confirmRerun` — gỡ phiếu cũ
       * và rã lại theo định lượng mới trong CÙNG transaction. Kỳ đã khoá sổ thì chặn hẳn.
       */
      const requestedIds = Array.isArray(body.recipeIds) ? body.recipeIds : [body.recipeId || body.id];
      const recipeIds = [...new Set(requestedIds.map((value: unknown) => cleanText(value)).filter(Boolean))] as string[];
      if (recipeIds.length === 0) businessError("Thiếu định lượng cần sửa");
      const targets = await prisma.recipe.findMany({ where: { id: { in: recipeIds } } });
      if (targets.length !== recipeIds.length) businessError("Không tìm thấy định lượng");
      const productCode = targets[0].productCode;
      if (targets.some((recipe) => recipe.productCode.toUpperCase() !== productCode.toUpperCase())) {
        businessError("Chỉ sửa cùng lúc các định lượng của cùng một món");
      }
      for (const recipe of targets) {
        if (recipe.branchCode) assertBranchAccess(auth.session, recipe.branchCode);
      }

      const changes: Prisma.RecipeUpdateInput = {};
      if (body.productName !== undefined) {
        const productName = cleanText(body.productName);
        if (!productName) businessError("Tên món không được để trống");
        changes.productName = productName;
      }
      if (body.unit !== undefined) {
        const unit = cleanText(body.unit);
        if (!unit) businessError("Đơn vị tính của món không được để trống");
        changes.unit = unit;
      }
      if (body.sellingPrice !== undefined) {
        const sellingPrice = toNumber(body.sellingPrice);
        if (sellingPrice < 0) businessError("Giá bán không được âm");
        changes.sellingPrice = sellingPrice;
      }
      if (body.outputConversionRate !== undefined) {
        const outputConversionRate = cleanText(body.outputConversionRate) === "" ? 1 : toNumber(body.outputConversionRate);
        if (!(outputConversionRate > 0)) businessError("Hệ số quy đổi về ĐVT tồn kho phải lớn hơn 0");
        changes.outputConversionRate = outputConversionRate;
      }
      if (body.effectiveFrom !== undefined) changes.effectiveFrom = toDate(body.effectiveFrom);
      if (body.note !== undefined) changes.note = cleanText(body.note) || null;
      const nextStatus = body.status !== undefined ? cleanText(body.status).toUpperCase() || "ACTIVE" : null;
      if (nextStatus) changes.status = nextStatus;

      const nextLines = body.lines !== undefined ? editableRecipeLines(body.lines) : null;
      const resolvedLines: { itemId: string; quantity: number; unitCode: string | null; conversionRate: number; wasteRate: number }[] = [];
      if (nextLines) {
        const productItem = await prisma.inventoryItem.findUnique({ where: { code: productCode.toUpperCase() } });
        for (const line of nextLines) {
          const item = line.itemId
            ? await prisma.inventoryItem.findUnique({ where: { id: line.itemId }, include: { unitConversions: true } })
            : await prisma.inventoryItem.findUnique({ where: { code: line.itemCode.toUpperCase() }, include: { unitConversions: true } });
          if (!item) businessError(`Không tìm thấy nguyên liệu ${line.itemCode || line.itemId}`);
          if (productItem && item.id === productItem.id) businessError("BOM không được tham chiếu chính sản phẩm đó");
          let conversionRate = line.conversionRate > 0 ? line.conversionRate : 0;
          if (!conversionRate) {
            if (!line.unitCode || line.unitCode.toUpperCase() === item.unit.toUpperCase()) {
              conversionRate = 1;
            } else {
              const conversion = item.unitConversions.find((candidate) => candidate.unitCode.toUpperCase() === line.unitCode.toUpperCase());
              if (!conversion) {
                businessError(`ĐVT [${line.unitCode}] chưa có trong quy đổi của ${item.code}. Khai quy đổi ở tab Mặt hàng hoặc điền hệ số quy đổi trên dòng.`);
              }
              conversionRate = conversion?.conversionRate || 1;
            }
          }
          // Cùng luật với đường tạo mới: hệ số tự khai không được quy một đơn vị ra chính nó.
          conversionRate = safeConversionRate(item.unit, { unitCode: line.unitCode || item.unit, conversionRate });
          resolvedLines.push({ itemId: item.id, quantity: line.quantity, unitCode: line.unitCode || null, conversionRate, wasteRate: line.wasteRate });
        }
      }

      let outcome;
      try {
        outcome = await prisma.$transaction(async (tx) => {
          const before = await loadRecipeVersions(tx, productCode);
          const updated = [];
          for (const recipe of targets) {
            if (nextLines) {
              await tx.recipeLine.deleteMany({ where: { recipeId: recipe.id } });
              await tx.recipeLine.createMany({ data: resolvedLines.map((line) => ({ recipeId: recipe.id, ...line })) });
            }
            // Bật ACTIVE cho bản này thì hạ các bản ACTIVE khác của cùng món — hai bản cùng ACTIVE
            // là POS chọn theo version cao nhất, chưa chắc bản người dùng vừa duyệt.
            if (nextStatus === "ACTIVE") {
              await tx.recipe.updateMany({ where: { productCode: recipe.productCode, branchCode: recipe.branchCode, status: "ACTIVE", id: { not: recipe.id } }, data: { status: "INACTIVE" } });
            }
            updated.push(await tx.recipe.update({
              where: { id: recipe.id },
              data: changes,
              include: { lines: { include: { item: true } } },
            }));
          }
          const after = await loadRecipeVersions(tx, productCode);
          const affected = await findRunsAffectedByRecipes(tx, [productCode], before, after);
          if (affected.length > 0) {
            await assertPeriodOpen(affected.map((run) => ({ date: run.date, branchCode: run.branchCode })), "rã lại theo định lượng mới", tx);
            if (!body.confirmRerun) throw new RecipeRerunConfirmation(affected);
          }
          const reruns = affected.length > 0 ? await rerunExplosions(tx, affected, auth.session.name) : [];
          return { updated, reruns };
        }, { timeout: 300000, maxWait: 20000 });
      } catch (error) {
        if (error instanceof RecipeRerunConfirmation) return rerunConfirmationResponse(error);
        throw error;
      }

      const { updated, reruns } = outcome;
      for (const result of updated) {
        await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_RECIPE", entityType: "Recipe", entityId: result.id, entityCode: result.code, metadata: { productCode: result.productCode, lines: result.lines.length, reruns: reruns.map(({ oldRunCode, newRunCode }) => ({ oldRunCode, newRunCode })) } });
      }
      await logRecipeReruns(auth.session, reruns, updated[0]?.code || productCode);
      const cogsRepost = reruns.length > 0 ? await repostCogsForReruns(reruns, [], auth.session.name) : [];
      return NextResponse.json({ ...updated[0], recipes: updated, reruns: reruns.map(({ oldRunCode, newRunCode }) => ({ oldRunCode, newRunCode })), cogsRepost });
    }

    return businessError("Thao tác cập nhật kho không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

/**
 * Hoàn kho cho một phiếu nhập/xuất trước khi xoá mềm.
 * Chỉ chạy sau khi đã xác nhận phiếu là chứng từ mới nhất trên từng cặp mặt hàng/kho,
 * nhờ vậy tồn kho và giá vốn bình quân trở về đúng trạng thái trước khi ghi sổ.
 */
async function reverseTransactionStock(transaction: {
  id: string;
  code: string;
  transactionType: string;
  warehouseCode: string;
  toWarehouseCode: string | null;
  lines: { itemId: string; quantity: number; totalCost: number }[];
}) {
  return prisma.$transaction(async (tx) => reverseStockEffect(tx, transaction));
}

/**
 * Xoá mềm dữ liệu kho.
 * query: ?type=ITEM|TRANSACTION|STOCKTAKE|RECIPE&id=<id>&reason=<lý do>
 */
export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const type = (cleanText(searchParams.get("type")) || cleanText(searchParams.get("entity"))).toUpperCase();
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id) businessError("Thiếu ID bản ghi cần xoá");

    if (["ITEM", "INVENTORY_ITEM", "INVENTORYITEM"].includes(type)) {
      const item = await prisma.inventoryItem.findUnique({ where: { id } });
      if (!item) businessError("Không tìm thấy mặt hàng");

      const [balances, postedLines, recipeCount, openRequests, openOrders] = await Promise.all([
        prisma.inventoryBalance.findMany({ where: { itemId: id } }),
        prisma.inventoryTransactionLine.count({ where: { itemId: id } }),
        prisma.recipe.count({ where: { lines: { some: { itemId: id } } } }),
        prisma.purchaseRequest.count({ where: { status: { in: openRequestStatuses }, lines: { some: { itemId: id } } } }),
        prisma.purchaseOrder.count({ where: { status: { in: openOrderStatuses }, lines: { some: { itemId: id } } } }),
      ]);

      const remaining = balances.filter((balance) => Math.abs(balance.quantity) > quantityEpsilon);
      if (remaining.length > 0) {
        const detail = remaining.map((balance) => `${balance.warehouseCode}: ${balance.quantity}`).join(", ");
        businessError(`Mặt hàng ${item.code} vẫn còn tồn kho (${detail}) nên không thể xoá. Hãy xuất hết tồn trước khi xoá.`);
      }
      if (postedLines > 0) {
        businessError(`Mặt hàng ${item.code} đã phát sinh ${postedLines} dòng giao dịch kho nên không thể xoá. Hãy chuyển sang trạng thái Ngưng hoạt động.`);
      }
      if (recipeCount > 0) {
        businessError(`Mặt hàng ${item.code} đang được dùng trong ${recipeCount} định mức (BOM) nên không thể xoá.`);
      }
      if (openRequests > 0 || openOrders > 0) {
        businessError(`Mặt hàng ${item.code} đang nằm trong ${openRequests} đề nghị mua hàng và ${openOrders} đơn mua hàng chưa hoàn tất nên không thể xoá.`);
      }

      return NextResponse.json(await softDeleteRecord({ model: "InventoryItem", id, session: auth.session, reason }));
    }

    if (["TRANSACTION", "STOCK_TRANSACTION", "INVENTORY_TRANSACTION", "INVENTORYTRANSACTION"].includes(type)) {
      const transaction = await prisma.inventoryTransaction.findUnique({ where: { id }, include: { lines: true } });
      if (!transaction) businessError("Không tìm thấy phiếu nhập/xuất kho");
      assertBranchAccess(auth.session, transaction.branchCode);
      assertWarehouseAccess(auth.session, transaction.warehouseCode);

      // Phiếu thuộc lô import vẫn xoá được từng cái: khách import cả tháng vài nghìn dòng,
      // sai một phiếu mà bắt rollback nguyên lô là mất hết phần còn lại (khách hỏi 21/09/2026).
      const derivedFrom = transaction.referenceType ? derivedReferenceTypes[transaction.referenceType] : undefined;
      if (derivedFrom) {
        businessError(`Phiếu ${transaction.code} được sinh tự động từ ${derivedFrom} ${transaction.referenceCode || ""}`.trim() + " nên phải xử lý ở chứng từ gốc, xoá riêng phiếu này sẽ làm lệch tồn kho.");
      }
      if (await isPeriodLocked(transaction.transactionDate, transaction.branchCode)) {
        businessError(`Kỳ kế toán của phiếu ${transaction.code} đã khóa nên không thể xoá.`);
      }
      const transferRun = explodedRunOf(transaction.explosionStatus);
      if (transferRun) {
        businessError(`Phiếu ${transaction.code} đã rã BOM trong lần rã ${transferRun}. Hoàn tác lần rã đó ở tab Chế biến trước khi xoá phiếu.`);
      }

      // Phiếu điều chuyển liên nhà hàng: phải thu hồi được cặp công nợ nội bộ trước.
      const internalDebtCodes = [transaction.internalReceivableDebtCode, transaction.internalPayableDebtCode]
        .filter((value): value is string => !!value);
      if (internalDebtCodes.length > 0) {
        const internalDebts = await prisma.debtRecord.findMany({
          where: { code: { in: internalDebtCodes }, deletedAt: null },
          include: { settlements: true },
        });
        const settled = internalDebts.find((debt) => debt.settlements.length > 0);
        if (settled) {
          businessError(`Công nợ nội bộ ${settled.code} của phiếu ${transaction.code} đã được gạch nợ nên không thể xoá phiếu. Hoàn tác các phiếu thu/chi gạch nợ trước.`);
        }
        for (const debt of internalDebts) {
          await softDeleteRecord({ model: "DebtRecord", id: debt.id, session: auth.session, reason: `Xoá theo phiếu điều chuyển ${transaction.code}` });
        }
      }

      // Khoản phải trả NCC sinh từ phiếu nhập mua phải mất theo phiếu; đã gạch nợ thì chặn.
      // Helper dùng chung với rollback import (nơi message hiện thẳng), nên đổi sang lỗi nghiệp
      // vụ ở đây để API trả 400 kèm lời nhắc thay vì 500 trống.
      try {
        await removePurchasePayables(prisma, [transaction.code]);
      } catch (error) {
        businessError(error instanceof Error ? error.message : "Không thu hồi được công nợ mua hàng của phiếu");
      }
      // Hoàn kho TRƯỚC khi xoá mềm: hoàn kho báo lỗi (hàng đã xuất hết) thì phiếu còn nguyên,
      // còn xoá mềm chạy transaction riêng nên không rollback kèm được.
      const reversals = await reverseTransactionStock(transaction);
      const result = await softDeleteRecord({ model: "InventoryTransaction", id, session: auth.session, reason });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "REVERSE_STOCK", entityType: "InventoryTransaction", entityId: transaction.id, entityCode: transaction.code, branchCode: transaction.branchCode, metadata: { transactionType: transaction.transactionType, reversals, internalDebtCodes } });
      return NextResponse.json(result);
    }

    if (["STOCKTAKE", "STOCKTAKE_SESSION", "STOCKTAKESESSION"].includes(type)) {
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
      assertWarehouseAccess(auth.session, stocktake.warehouseCode);
      if (stocktake.status === "APPROVED") {
        businessError(`Phiếu kiểm kê ${stocktake.code} đã duyệt và đã sinh phiếu điều chỉnh tồn kho nên không thể xoá.`);
      }
      const linkedTransactions = await prisma.inventoryTransaction.count({
        where: { referenceType: "STOCKTAKE", referenceId: stocktake.id },
      });
      if (linkedTransactions > 0) {
        businessError(`Phiếu kiểm kê ${stocktake.code} đã sinh ${linkedTransactions} phiếu nhập/xuất kho nên không thể xoá.`);
      }
      return NextResponse.json(await softDeleteRecord({ model: "StocktakeSession", id, session: auth.session, reason }));
    }

    if (["RECIPE", "BOM"].includes(type)) {
      const recipe = await prisma.recipe.findUnique({ where: { id } });
      if (!recipe) businessError("Không tìm thấy định lượng");
      const newerVersion = await prisma.recipe.count({
        where: { productCode: recipe.productCode, branchCode: recipe.branchCode, version: { gt: recipe.version } },
      });
      if (recipe.status === "ACTIVE" && newerVersion === 0) {
        const usedInProduction = await prisma.inventoryTransaction.count({
          where: { referenceType: "PRODUCTION", lines: { some: { item: { code: recipe.productCode.toUpperCase() } } } },
        });
        if (usedInProduction > 0) {
          businessError(`Định lượng ${recipe.code} đang là phiên bản áp dụng và đã dùng để chế biến ${usedInProduction} lần nên không thể xoá. Hãy tạo phiên bản mới thay thế.`);
        }
      }
      return NextResponse.json(await softDeleteRecord({ model: "Recipe", id, session: auth.session, reason }));
    }

    return businessError(`Loại dữ liệu "${type || "(trống)"}" không được hỗ trợ. Dùng type=ITEM, TRANSACTION, STOCKTAKE hoặc RECIPE.`);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
