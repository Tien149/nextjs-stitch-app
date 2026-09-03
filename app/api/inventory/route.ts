import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { isWasteSubType, normalizeStockTransactionType, normalizeWasteSubType, postInventoryTransaction } from "@/lib/inventory-stock";
import { postStockTransfer } from "@/lib/inventory-transfer";
import { computeCostingLevels, computeRecipeUnitCosts, explodeSalesDemand, pickRecipeForDate, type ExplosionRecipe } from "@/lib/production-explosion";
import { writeAuditLog } from "@/lib/audit-log";
import {
  duplicatedInTrashMessage,
  findDeletedByUnique,
  softDeleteRecord,
  SoftDeleteError,
} from "@/lib/soft-delete";
import { scopePayloadByTab } from "@/lib/tab-scope";
import { isWarehouseStocktakeItemType, itemCodePrefixError } from "@/lib/inventory-scope";
import { nextStockDocCode, nextStocktakeCode } from "@/lib/inventory-stock";
import { isRevenueGroupCategory, normalizeRevenueExpenseGroup } from "@/lib/voucher-rules";

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

type InputLine = { itemId?: unknown; itemCode?: unknown; quantity?: unknown; actualQuantity?: unknown; inputQuantity?: unknown; unitCode?: unknown; inputUnitCode?: unknown; unitCost?: unknown; inputUnitCost?: unknown; wasteRate?: unknown; conversionRate?: unknown; reason?: unknown };
const validItemTypes = ["RAW_MATERIAL", "SEMI_FINISHED", "FINISHED", "PACKAGING", "TOOL", "ASSET"];

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

/** Quy ước tiền tố mã theo loại mặt hàng — rule nằm ở inventory-scope để import dùng chung. */
function assertItemCodePrefix(itemType: string, uppercaseCode: string) {
  const message = itemCodePrefixError(itemType, uppercaseCode);
  if (message) businessError(message);
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

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const branchCode = requestedBranch(auth.session, searchParams.get("branchCode") || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };

    // Get warehouses belonging to this branch
    const allowedWarehouses = await prisma.masterDataItem.findMany({
      where: {
        type: "WAREHOUSE",
        ...(branchCode === "ALL" ? {} : { branch: branchCode }),
      },
      select: { code: true }
    });
    const warehouseCodes = allowedWarehouses.map((w) => w.code);

    const [items, balances, transactions, reportTransactions, recipes, warehouses, stocktakes, itemGroups, receiptCategoryList, pendingRevenueRows] = await Promise.all([
      prisma.inventoryItem.findMany({ include: { unitConversions: { orderBy: [{ isDefaultPurchase: "desc" }, { unitCode: "asc" }] } }, orderBy: { name: "asc" } }),
      prisma.inventoryBalance.findMany({
        where: { warehouseCode: { in: warehouseCodes } },
        include: { item: true },
        orderBy: [{ warehouseCode: "asc" }, { item: { name: "asc" } }]
      }),
      prisma.inventoryTransaction.findMany({
        where: { ...branchFilter },
        include: { lines: { include: { item: true } } },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      prisma.inventoryTransaction.findMany({
        where: { ...branchFilter },
        include: { lines: { include: { item: true } } },
        orderBy: { transactionDate: "asc" },
      }),
      prisma.recipe.findMany({ include: { lines: { include: { item: { include: { balances: true } } } } }, orderBy: { updatedAt: "desc" } }),
      prisma.masterDataItem.findMany({
        where: { type: "WAREHOUSE", status: "ACTIVE", ...(branchCode === "ALL" ? {} : { branch: branchCode }) },
        orderBy: [{ branch: "asc" }, { code: "asc" }],
      }),
      prisma.stocktakeSession.findMany({
        where: { ...(branchCode === "ALL" ? {} : { branchCode }) },
        include: { lines: { include: { item: true } } },
        orderBy: { createdAt: "desc" },
        take: 20,
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
        select: { id: true, saleDate: true, branchCode: true, productCode: true, productQuantity: true },
        take: 2000,
      }),
    ]);

    // Giá vốn bình quân toàn hệ thống của từng mặt hàng (tổng giá trị / tổng tồn mọi kho)
    // — dùng cho cost định lượng, không phụ thuộc bộ lọc cửa hàng của màn hình.
    const allBalances = await prisma.inventoryBalance.findMany({ select: { itemId: true, quantity: true, averageCost: true } });
    const costAggregate = new Map<string, { quantity: number; value: number; lastAverage: number }>();
    for (const balance of allBalances) {
      const bucket = costAggregate.get(balance.itemId) || { quantity: 0, value: 0, lastAverage: 0 };
      bucket.quantity += balance.quantity;
      bucket.value += balance.quantity * balance.averageCost;
      if (balance.averageCost > 0) bucket.lastAverage = balance.averageCost;
      costAggregate.set(balance.itemId, bucket);
    }
    const averageCostByItemId = new Map<string, number>();
    for (const [itemId, bucket] of costAggregate) {
      averageCostByItemId.set(itemId, bucket.quantity > quantityEpsilon ? bucket.value / bucket.quantity : bucket.lastAverage);
    }

    // Cost đa cấp theo định lượng: BTP trong định lượng món lấy cost từ định lượng của
    // chính BTP đó (không cần BTP có tồn kho), NVL lấy giá vốn bình quân.
    const explosionRecipes = recipes as unknown as ExplosionRecipe[];
    const recipeUnitCosts = computeRecipeUnitCosts(explosionRecipes, averageCostByItemId, new Date());
    const recipesWithCost = recipes.map((recipe) => {
      const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
      const unitCost = recipeUnitCosts.get(recipe.productCode.toUpperCase());
      const batchCost = Number.isFinite(unitCost) ? (unitCost as number) * outputRate : 0;
      return { ...recipe, estimatedCost: batchCost, estimatedUnitCost: Number.isFinite(unitCost) ? unitCost : 0 };
    });

    // "Sheet tổng hợp" giá vốn & giá thành: mỗi mã sản phẩm một dòng, theo phiên bản
    // định lượng đang áp dụng hôm nay. FINISHED tính %cost = giá cost / giá bán.
    const productCodes = [...new Set(recipes.map((recipe) => recipe.productCode.toUpperCase()))];
    const itemByCode = new Map(items.map((item) => [item.code.toUpperCase(), item]));
    const costSummary = productCodes.map((productCode) => {
      const versions = explosionRecipes.filter((recipe) => recipe.productCode.toUpperCase() === productCode);
      const current = pickRecipeForDate(versions, new Date());
      const productItem = itemByCode.get(productCode);
      const unitCost = recipeUnitCosts.get(productCode) ?? 0;
      const sellingPrice = current?.sellingPrice || 0;
      return {
        productCode,
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
    }).sort((a, b) => a.productCode.localeCompare(b.productCode));
    const movements = new Map<string, { inbound: number; outbound: number; inboundValue: number; outboundValue: number; byType: Record<string, { inbound: number; outbound: number; value: number }> }>();
    const touch = (itemId: string, warehouseCode: string) => {
      const key = `${itemId}|${warehouseCode}`;
      if (!movements.has(key)) movements.set(key, { inbound: 0, outbound: 0, inboundValue: 0, outboundValue: 0, byType: {} });
      return movements.get(key)!;
    };
    const addType = (bucket: { byType: Record<string, { inbound: number; outbound: number; value: number }> }, type: string, direction: "IN" | "OUT", quantity: number, value: number) => {
      bucket.byType[type] ||= { inbound: 0, outbound: 0, value: 0 };
      if (direction === "IN") bucket.byType[type].inbound += quantity;
      else bucket.byType[type].outbound += quantity;
      bucket.byType[type].value += value;
    };
    const stockMovements: Array<{
      transactionId: string;
      code: string;
      transactionType: string;
      transactionDate: Date;
      warehouseCode: string;
      toWarehouseCode: string | null;
      itemCode: string;
      itemName: string;
      unit: string;
      quantity: number;
      inboundQuantity: number;
      outboundQuantity: number;
      value: number;
      referenceCode: string | null;
    }> = [];
    for (const transaction of reportTransactions) {
      for (const line of transaction.lines) {
        if (transaction.transactionType.startsWith("NHAP_")) {
          const bucket = touch(line.itemId, transaction.warehouseCode);
          bucket.inbound += line.quantity;
          bucket.inboundValue += line.totalCost;
          addType(bucket, transaction.transactionType, "IN", line.quantity, line.totalCost);
          stockMovements.push({
            transactionId: transaction.id,
            code: transaction.code,
            transactionType: transaction.transactionType,
            transactionDate: transaction.transactionDate,
            warehouseCode: transaction.warehouseCode,
            toWarehouseCode: transaction.toWarehouseCode,
            itemCode: line.item.code,
            itemName: line.item.name,
            unit: line.item.unit,
            quantity: line.quantity,
            inboundQuantity: line.quantity,
            outboundQuantity: 0,
            value: line.totalCost,
            referenceCode: transaction.referenceCode,
          });
        } else if (transaction.transactionType.startsWith("XUAT_")) {
          const bucket = touch(line.itemId, transaction.warehouseCode);
          bucket.outbound += line.quantity;
          bucket.outboundValue += line.totalCost;
          addType(bucket, transaction.transactionType, "OUT", line.quantity, line.totalCost);
          stockMovements.push({
            transactionId: transaction.id,
            code: transaction.code,
            transactionType: transaction.transactionType,
            transactionDate: transaction.transactionDate,
            warehouseCode: transaction.warehouseCode,
            toWarehouseCode: transaction.toWarehouseCode,
            itemCode: line.item.code,
            itemName: line.item.name,
            unit: line.item.unit,
            quantity: line.quantity,
            inboundQuantity: 0,
            outboundQuantity: line.quantity,
            value: line.totalCost,
            referenceCode: transaction.referenceCode,
          });
        } else if (transaction.transactionType === "DIEU_CHUYEN") {
          const source = touch(line.itemId, transaction.warehouseCode);
          source.outbound += line.quantity;
          source.outboundValue += line.totalCost;
          addType(source, transaction.transactionType, "OUT", line.quantity, line.totalCost);
          stockMovements.push({
            transactionId: transaction.id,
            code: transaction.code,
            transactionType: transaction.transactionType,
            transactionDate: transaction.transactionDate,
            warehouseCode: transaction.warehouseCode,
            toWarehouseCode: transaction.toWarehouseCode,
            itemCode: line.item.code,
            itemName: line.item.name,
            unit: line.item.unit,
            quantity: line.quantity,
            inboundQuantity: 0,
            outboundQuantity: line.quantity,
            value: line.totalCost,
            referenceCode: transaction.referenceCode,
          });
          if (transaction.toWarehouseCode) {
            const destination = touch(line.itemId, transaction.toWarehouseCode);
            destination.inbound += line.quantity;
            destination.inboundValue += line.totalCost;
            addType(destination, transaction.transactionType, "IN", line.quantity, line.totalCost);
            stockMovements.push({
              transactionId: transaction.id,
              code: transaction.code,
              transactionType: transaction.transactionType,
              transactionDate: transaction.transactionDate,
              warehouseCode: transaction.toWarehouseCode,
              toWarehouseCode: null,
              itemCode: line.item.code,
              itemName: line.item.name,
              unit: line.item.unit,
              quantity: line.quantity,
              inboundQuantity: line.quantity,
              outboundQuantity: 0,
              value: line.totalCost,
              referenceCode: transaction.referenceCode,
            });
          }
        }
      }
    }
    const stockSummary = balances.map((balance) => {
      const movement = movements.get(`${balance.itemId}|${balance.warehouseCode}`) || { inbound: 0, outbound: 0, inboundValue: 0, outboundValue: 0, byType: {} };
      return {
        item: balance.item,
        warehouseCode: balance.warehouseCode,
        openingQuantity: balance.quantity - movement.inbound + movement.outbound,
        inboundQuantity: movement.inbound,
        outboundQuantity: movement.outbound,
        closingQuantity: balance.quantity,
        averageCost: balance.averageCost,
        closingValue: balance.quantity * balance.averageCost,
        movementByType: movement.byType,
      };
    });
    // Báo cáo hủy hàng: mã nào hủy nhiều nhất, tách theo loại hủy (hết hạn / chất lượng).
    const wasteBuckets = new Map<string, {
      itemCode: string; itemName: string; unit: string; itemType: string;
      totalQuantity: number; totalValue: number; documentCount: number;
      bySubType: Record<string, { quantity: number; value: number }>;
    }>();
    for (const transaction of reportTransactions) {
      if (transaction.transactionType !== "XUAT_HUY") continue;
      const subType = transaction.subType || "KHONG_PHAN_LOAI";
      for (const line of transaction.lines) {
        const bucket = wasteBuckets.get(line.itemId) || {
          itemCode: line.item.code, itemName: line.item.name, unit: line.item.unit, itemType: line.item.itemType,
          totalQuantity: 0, totalValue: 0, documentCount: 0, bySubType: {},
        };
        bucket.totalQuantity += line.quantity;
        bucket.totalValue += line.totalCost;
        bucket.documentCount += 1;
        bucket.bySubType[subType] ||= { quantity: 0, value: 0 };
        bucket.bySubType[subType].quantity += line.quantity;
        bucket.bySubType[subType].value += line.totalCost;
        wasteBuckets.set(line.itemId, bucket);
      }
    }
    const wasteReport = [...wasteBuckets.values()].sort((a, b) => b.totalValue - a.totalValue);

    // Doanh thu chờ rã nguyên liệu, gom theo ngày + cửa hàng cho tab Chế biến.
    const pendingByDay = new Map<string, { saleDate: Date; branchCode: string; rowCount: number; totalQuantity: number }>();
    for (const row of pendingRevenueRows) {
      const key = `${row.saleDate.toISOString().slice(0, 10)}|${row.branchCode}`;
      const bucket = pendingByDay.get(key) || { saleDate: row.saleDate, branchCode: row.branchCode, rowCount: 0, totalQuantity: 0 };
      bucket.rowCount += 1;
      bucket.totalQuantity += row.productQuantity || 0;
      pendingByDay.set(key, bucket);
    }
    const pendingSales = { total: pendingRevenueRows.length, byDay: [...pendingByDay.values()] };
    // Ô chọn của mặt hàng chỉ nhận nhóm doanh thu; loại thu quỹ trả riêng để màn hình gọi đúng
    // tên mã đang bị gán sai thay vì hiện trơ mã "(ngoài danh mục)".
    const revenueGroups = receiptCategoryList.filter((category) => isRevenueGroupCategory(category.group));
    const receiptCategories = receiptCategoryList.filter((category) => !isRevenueGroupCategory(category.group));

    return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { items, balances, transactions, recipes: recipesWithCost, warehouses, stocktakes, stockSummary, stockMovements, itemGroups, revenueGroups, receiptCategories, costSummary, wasteReport, pendingSales }));
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const action = cleanText(body.action);

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
      assertItemCodePrefix(itemType, uppercaseCode);
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
        resolvedLines.push({ itemId: item.id, quantity: line.quantity, unitCode: unitCode || null, conversionRate, wasteRate: line.wasteRate });
      }

      const latest = await prisma.recipe.findFirst({ where: { productCode }, orderBy: { version: "desc" } });
      const recipeCode = `${productCode}-V${(latest?.version || 0) + 1}`;
      if (await findDeletedByUnique("Recipe", { code: recipeCode })) {
        businessError(duplicatedInTrashMessage(recipeCode, "Định mức (BOM)"));
      }
      if (latest) await prisma.recipe.updateMany({ where: { productCode, status: "ACTIVE" }, data: { status: "INACTIVE" } });
      const recipe = await prisma.recipe.create({
        data: {
          code: recipeCode,
          productCode,
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
      });
      return NextResponse.json(recipe, { status: 201 });
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
      const recipe = pickRecipeForDate(recipeVersions as unknown as ExplosionRecipe[], productionDate);
      if (!recipe || recipe.lines.length === 0) businessError(`Chua co dinh luong ap dung cho ${productCode}`);
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

    if (action === "APPROVE_STOCKTAKE") {
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const stocktakeDate = toDate(body.stocktakeDate);
      const rows = stocktakeLinesFrom(body.lines);
      if (!branchCode || !warehouseCode || rows.length === 0) businessError("Kiem ke can cua hang, kho va it nhat mot mat hang");
      assertBranchAccess(auth.session, branchCode);
      if (await isPeriodLocked(stocktakeDate, branchCode)) businessError("Ky ke toan da khoa");
      const requestedStocktakeCode = cleanText(body.code);
      if (requestedStocktakeCode && await findDeletedByUnique("StocktakeSession", { code: requestedStocktakeCode })) {
        businessError(duplicatedInTrashMessage(requestedStocktakeCode, "Phiếu kiểm kê"));
      }
      const result = await prisma.$transaction(async (tx) => {
        const stocktake = await tx.stocktakeSession.create({
          data: {
            code: cleanText(body.code) || await nextStocktakeCode(tx, stocktakeDate),
            stocktakeDate,
            branchCode,
            warehouseCode,
            status: "APPROVED",
            approvedBy: auth.session.name,
            approvedAt: new Date(),
            note: cleanText(body.note) || null,
            createdBy: auth.session.name,
          },
        });
        const inboundLines = [];
        const outboundLines = [];
        for (const row of rows) {
          const item = row.itemId
            ? await tx.inventoryItem.findUnique({ where: { id: row.itemId } })
            : await tx.inventoryItem.findUnique({ where: { code: row.itemCode.toUpperCase() } });
          if (!item) businessError(`Khong tim thay mat hang ${row.itemCode || row.itemId}`);
          // CCDC & Tài sản kiểm kê ở màn hình Tài sản & Khấu hao, không nằm trong kiểm kê kho.
          if (!isWarehouseStocktakeItemType(item.itemType)) {
            businessError(`Mặt hàng ${item.code} là CCDC/Tài sản và phải được kiểm kê tại phân hệ Tài sản & khấu hao.`);
          }
          const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode } } });
          const systemQuantity = balance?.quantity || 0;
          // Khoá lạc quan: người đếm chốt số dựa trên tồn HỌ NHÌN THẤY. Nếu tồn hệ thống đã đổi
          // (bán hàng, nhập kho... sau lúc mở màn hình) mà cứ duyệt thì chênh lệch sẽ "hoàn lại"
          // toàn bộ phát sinh trong ngày. Bắt tải lại danh sách thay vì âm thầm đảo số.
          if (row.systemQuantity !== null && Math.abs(row.systemQuantity - systemQuantity) > quantityEpsilon) {
            businessError(`Tồn của ${item.code} đã thay đổi từ lúc tải danh sách (${row.systemQuantity} → ${systemQuantity}). Bấm "Nạp danh sách kho" để lấy số mới rồi kiểm lại dòng này.`);
          }
          const varianceQuantity = row.actualQuantity - systemQuantity;
          // Hàng đếm THỪA mà chưa có giá vốn thì bắt khai đơn giá — nhập giá 0 là giá trị kho
          // sai và giá vốn món ăn theo sai vĩnh viễn.
          if (varianceQuantity > 0 && (balance?.averageCost || 0) <= 0 && row.unitCost <= 0) {
            businessError(`${item.code} chưa có giá vốn trong kho ${warehouseCode}. Nhập "Đơn giá" cho dòng này để ghi nhận phần thừa ${varianceQuantity} ${item.unit}.`);
          }
          await tx.stocktakeLine.create({
            data: {
              stocktakeId: stocktake.id,
              itemId: item.id,
              systemQuantity,
              actualQuantity: row.actualQuantity,
              varianceQuantity,
              reason: row.reason || cleanText(body.reason) || null,
            },
          });
          if (varianceQuantity > 0) inboundLines.push({ itemId: item.id, inputQuantity: varianceQuantity, inputUnitCode: item.unit, inputUnitCost: (balance?.averageCost || 0) > 0 ? balance?.averageCost || 0 : row.unitCost });
          if (varianceQuantity < 0) outboundLines.push({ itemId: item.id, inputQuantity: Math.abs(varianceQuantity), inputUnitCode: item.unit, inputUnitCost: 0 });
        }
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
      return NextResponse.json(result, { status: 201 });
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
      if (dateTo.getTime() < dateFrom.getTime()) businessError("Khoảng ngày rã không hợp lệ (từ ngày sau đến ngày trước)");
      const rangeEnd = new Date(dateTo);
      rangeEnd.setHours(23, 59, 59, 999);
      if (await isPeriodLocked(dateTo, branchCode)) businessError("Kỳ kế toán đã khóa");

      const pendingRows = await prisma.revenueImportRow.findMany({
        where: {
          inventoryStatus: "PENDING",
          productCode: { not: null },
          productQuantity: { gt: 0 },
          branchCode,
          saleDate: { gte: dateFrom, lte: rangeEnd },
          deletedAt: null,
        },
      });
      if (pendingRows.length === 0) {
        businessError("Không có dòng doanh thu nào đang chờ rã nguyên liệu trong khoảng ngày đã chọn.");
      }

      const recipeVersions = await prisma.recipe.findMany({
        where: { deletedAt: null },
        include: { lines: { include: { item: true } } },
      });
      const plan = explodeSalesDemand({
        demands: pendingRows.map((row) => ({ productCode: row.productCode || "", quantity: row.productQuantity || 0 })),
        recipes: recipeVersions as unknown as ExplosionRecipe[],
        date: dateTo,
      });

      const result = await prisma.$transaction(async (tx) => {
        const runCode = await nextStockDocCode(tx, "RA", dateTo);
        const documents = [];
        let sequence = 0;
        // 1) Chế biến từng cấp theo đúng thứ tự BTP → TP → combo.
        for (const step of plan.productions) {
          sequence += 1;
          const productItem = await tx.inventoryItem.findUnique({ where: { code: step.productCode } });
          if (!productItem) businessError(`Không tìm thấy sản phẩm ${step.productCode}`);
          const issue = await postInventoryTransaction(tx, {
            code: `${runCode}-${sequence}X`,
            transactionType: "XUAT_CHE_BIEN",
            transactionDate: dateTo,
            branchCode,
            warehouseCode,
            referenceType: "PRODUCTION",
            referenceCode: runCode,
            note: `Rã nguyên liệu ${step.productCode} (${cleanText(body.note) || "theo doanh thu"})`,
            createdBy: auth.session.name,
            lines: step.components.map((component) => ({
              itemId: component.item.id,
              inputQuantity: component.quantityBase,
              inputUnitCode: "",
              inputUnitCost: 0,
            })),
          });
          const totalCost = issue.lines.reduce((sum, line) => sum + line.totalCost, 0);
          const receipt = await postInventoryTransaction(tx, {
            code: `${runCode}-${sequence}N`,
            transactionType: "NHAP_CHE_BIEN",
            transactionDate: dateTo,
            branchCode,
            warehouseCode: toWarehouseCode,
            referenceType: "PRODUCTION",
            referenceCode: runCode,
            note: `Nhập chế biến ${step.productCode} từ rã nguyên liệu`,
            createdBy: auth.session.name,
            lines: [{
              itemId: productItem?.id || "",
              inputQuantity: step.quantityBase,
              inputUnitCode: productItem?.unit || "",
              inputUnitCost: step.quantityBase > 0 ? totalCost / step.quantityBase : 0,
            }],
          });
          documents.push(issue, receipt);
        }
        // 2) Xuất bán: sản phẩm vừa chế biến xuất từ kho nhập chế biến, hàng bán thẳng
        //    (không định lượng) xuất từ kho nguyên liệu.
        const saleGroups: Array<{ warehouse: string; sales: typeof plan.producedSales; label: string }> = [
          { warehouse: toWarehouseCode, sales: plan.producedSales, label: "chế biến" },
          { warehouse: warehouseCode, sales: plan.directSales, label: "bán thẳng" },
        ];
        for (const group of saleGroups) {
          if (group.sales.length === 0) continue;
          const lines = [];
          for (const sale of group.sales) {
            const item = await tx.inventoryItem.findUnique({ where: { code: sale.productCode } });
            if (!item) businessError(`Không tìm thấy mặt hàng ${sale.productCode} để xuất bán`);
            lines.push({ itemId: item?.id || "", inputQuantity: sale.quantityBase, inputUnitCode: item?.unit || "", inputUnitCost: 0 });
          }
          sequence += 1;
          documents.push(await postInventoryTransaction(tx, {
            code: `${runCode}-${sequence}XB`,
            transactionType: "XUAT_BAN",
            transactionDate: dateTo,
            branchCode,
            warehouseCode: group.warehouse,
            referenceType: "PRODUCTION",
            referenceCode: runCode,
            note: `Xuất bán theo rã nguyên liệu ${runCode} (${group.label})`,
            createdBy: auth.session.name,
            lines,
          }));
        }
        // 3) Đánh dấu các dòng doanh thu đã rã kèm mã lần rã, để hoàn tác được cả cụm
        //    (REVERT_EXPLOSION) và không rã trùng lần sau.
        await tx.revenueImportRow.updateMany({
          where: { id: { in: pendingRows.map((row) => row.id) } },
          data: { inventoryStatus: `POSTED:${runCode}` },
        });
        return { runCode, documents };
      }, { timeout: 60000 });

      await writeAuditLog({
        session: auth.session, module: menuHref, action: "EXPLODE_PRODUCTION",
        entityType: "InventoryTransaction", entityCode: result.runCode, branchCode,
        metadata: {
          dateFrom, dateTo, warehouseCode, toWarehouseCode,
          revenueRows: pendingRows.length,
          productions: plan.productions.map((step) => ({ productCode: step.productCode, quantityBase: step.quantityBase })),
          documents: result.documents.map((doc) => doc.code),
        },
      });
      return NextResponse.json({
        runCode: result.runCode,
        documentCount: result.documents.length,
        revenueRows: pendingRows.length,
        productions: plan.productions.map((step) => ({ productCode: step.productCode, quantityBase: step.quantityBase, batchQuantity: step.batchQuantity })),
        directSales: plan.directSales,
        documents: result.documents,
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

      // Bước 1 — giá vốn nguyên liệu: bình quân GIA QUYỀN theo tồn của mọi kho, kho tồn 0
      // không kéo giá xuống. Không có tồn thì giữ giá gần nhất từng ghi nhận.
      const aggregate = new Map<string, { quantity: number; value: number; lastAverage: number }>();
      for (const balance of balances) {
        const bucket = aggregate.get(balance.itemId) || { quantity: 0, value: 0, lastAverage: 0 };
        if (balance.quantity > 0) {
          bucket.quantity += balance.quantity;
          bucket.value += balance.quantity * balance.averageCost;
        }
        if (balance.averageCost > 0) bucket.lastAverage = balance.averageCost;
        aggregate.set(balance.itemId, bucket);
      }
      const averageCostByItemId = new Map<string, number>();
      for (const [itemId, bucket] of aggregate) {
        averageCostByItemId.set(itemId, bucket.quantity > quantityEpsilon ? bucket.value / bucket.quantity : bucket.lastAverage);
      }

      // Bước 2..n — giá thành theo tầng định lượng.
      const itemTypeByCode = new Map(items.map((item) => [item.code.toUpperCase(), item.itemType]));
      const levels = computeCostingLevels(recipeRows as unknown as ExplosionRecipe[], averageCostByItemId, costingDate, itemTypeByCode);
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
    if (action === "REVERT_EXPLOSION") {
      const runCode = cleanText(body.runCode).toUpperCase();
      if (!runCode) businessError("Thiếu mã lần rã (RA-...)");
      const documents = await prisma.inventoryTransaction.findMany({
        where: { referenceType: "PRODUCTION", referenceCode: runCode, deletedAt: null },
        include: { lines: true },
        orderBy: { createdAt: "desc" },
      });
      if (documents.length === 0) businessError(`Không tìm thấy phiếu nào của lần rã ${runCode}`);
      const branchCode = documents[0]?.branchCode || "";
      assertBranchAccess(auth.session, branchCode);
      if (documents[0] && await isPeriodLocked(documents[0].transactionDate, branchCode)) businessError("Kỳ kế toán đã khóa");

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
        businessError(`Đã có phiếu ${newer.code} phát sinh sau lần rã ${runCode} trên cùng mặt hàng/kho nên không thể hoàn tác chính xác. Xoá phiếu đó trước.`);
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
            const newQuantity = direction === "IN" ? currentQuantity - line.quantity : currentQuantity + line.quantity;
            if (newQuantity < -quantityEpsilon) {
              businessError(`Tồn kho ${doc.warehouseCode} không đủ để hoàn lại phiếu ${doc.code}.`);
            }
            const newValue = direction === "IN" ? currentValue - line.totalCost : currentValue + line.totalCost;
            const averageCost = newQuantity > quantityEpsilon ? Math.max(newValue / newQuantity, 0) : currentAverage;
            await tx.inventoryBalance.upsert({
              where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode: doc.warehouseCode } },
              create: { itemId: line.itemId, warehouseCode: doc.warehouseCode, quantity: Math.max(newQuantity, 0), averageCost },
              update: { quantity: Math.max(newQuantity, 0), averageCost },
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
      }, { timeout: 60000 });

      await writeAuditLog({
        session: auth.session, module: menuHref, action: "REVERT_EXPLOSION",
        entityType: "InventoryTransaction", entityCode: runCode, branchCode,
        metadata: { documents: documents.map((doc) => doc.code) },
      });
      return NextResponse.json({ runCode, revertedDocuments: documents.length });
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
          quantity,
          inputQuantity: quantity,
          unitCode: "",
          inputUnitCode: "",
          unitCost: 0,
          inputUnitCost: 0,
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
      return postInventoryTransaction(tx, {
        code: transactionCode,
        transactionType,
        subType: wasteSubType,
        transactionDate,
        branchCode,
        warehouseCode,
        toWarehouseCode,
        referenceType: action === "RECORD_WASTE" ? "POS_WASTE" : cleanText(body.referenceType) || null,
        referenceCode: cleanText(body.referenceCode) || null,
        note: cleanText(body.note) || null,
        createdBy: auth.session.name,
        lines: inputLines,
      });
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
      if (itemType !== item.itemType) assertItemCodePrefix(itemType, item.code.toUpperCase());

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
      const transaction = await prisma.inventoryTransaction.findUnique({ where: { id: transactionId } });
      if (!transaction) businessError("Không tìm thấy phiếu nhập/xuất kho");
      assertBranchAccess(auth.session, transaction.branchCode);

      if (body.lines !== undefined || body.quantity !== undefined || body.unitCost !== undefined) {
        businessError(`Phiếu ${transaction.code} đã ghi sổ nên không thể sửa số lượng hoặc đơn giá. Hãy xoá phiếu để hoàn kho rồi nhập lại, hoặc lập phiếu điều chỉnh.`);
      }
      if (transaction.importBatchId) {
        businessError(`Phiếu ${transaction.code} thuộc lô import nên chỉ được xử lý ở màn hình Import dữ liệu.`);
      }
      const derivedFrom = transaction.referenceType ? derivedReferenceTypes[transaction.referenceType] : undefined;
      if (derivedFrom) {
        businessError(`Phiếu ${transaction.code} được sinh tự động từ ${derivedFrom} ${transaction.referenceCode || ""}`.trim() + " nên phải sửa ở chứng từ gốc.");
      }
      if (await isPeriodLocked(transaction.transactionDate, transaction.branchCode)) businessError("Kỳ kế toán đã khóa");

      const transactionDate = body.transactionDate !== undefined ? toDate(body.transactionDate) : transaction.transactionDate;
      if (body.transactionDate !== undefined && await isPeriodLocked(transactionDate, transaction.branchCode)) {
        businessError("Kỳ kế toán của ngày chứng từ mới đã khóa");
      }

      const result = await prisma.inventoryTransaction.update({
        where: { id: transactionId },
        data: {
          transactionDate,
          ...(body.referenceCode !== undefined ? { referenceCode: cleanText(body.referenceCode) || null } : {}),
          ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
        },
        include: { lines: { include: { item: true } } },
      });

      await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_TRANSACTION", entityType: "InventoryTransaction", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousDate: transaction.transactionDate, transactionDate } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_STOCKTAKE") {
      const stocktakeId = cleanText(body.stocktakeId) || cleanText(body.id);
      if (!stocktakeId) businessError("Thiếu phiếu kiểm kê cần sửa");
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
      if (stocktake.status === "APPROVED") {
        businessError(`Phiếu kiểm kê ${stocktake.code} đã duyệt và đã điều chỉnh tồn kho nên không thể sửa.`);
      }

      const warehouseCode = body.warehouseCode !== undefined ? cleanText(body.warehouseCode) : stocktake.warehouseCode;
      if (!warehouseCode) businessError("Kho kiểm kê không được để trống");
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
      const recipeId = cleanText(body.recipeId) || cleanText(body.id);
      if (!recipeId) businessError("Thiếu định lượng cần sửa");
      const recipe = await prisma.recipe.findUnique({ where: { id: recipeId } });
      if (!recipe) businessError("Không tìm thấy định lượng");

      const productName = body.productName !== undefined ? cleanText(body.productName) : recipe.productName;
      if (!productName) businessError("Tên món không được để trống");
      const unit = body.unit !== undefined ? cleanText(body.unit) : recipe.unit;
      if (!unit) businessError("Đơn vị tính của món không được để trống");
      const sellingPrice = body.sellingPrice !== undefined ? toNumber(body.sellingPrice) : recipe.sellingPrice;
      if (sellingPrice < 0) businessError("Giá bán không được âm");
      const outputConversionRate = body.outputConversionRate !== undefined ? toNumber(body.outputConversionRate) : recipe.outputConversionRate;
      if (!(outputConversionRate > 0)) businessError("Hệ số quy đổi về ĐVT tồn kho phải lớn hơn 0");

      const nextLines = body.lines !== undefined ? editableRecipeLines(body.lines) : null;
      const resolvedLines: { itemId: string; quantity: number; unitCode: string | null; conversionRate: number; wasteRate: number }[] = [];
      if (nextLines) {
        const productItem = await prisma.inventoryItem.findUnique({ where: { code: recipe.productCode.toUpperCase() } });
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
          resolvedLines.push({ itemId: item.id, quantity: line.quantity, unitCode: line.unitCode || null, conversionRate, wasteRate: line.wasteRate });
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        if (nextLines) {
          await tx.recipeLine.deleteMany({ where: { recipeId } });
          await tx.recipeLine.createMany({ data: resolvedLines.map((line) => ({ recipeId, ...line })) });
        }
        // Bật ACTIVE cho bản này thì hạ các bản ACTIVE khác của cùng món — hai bản cùng ACTIVE
        // là POS chọn theo version cao nhất, chưa chắc bản người dùng vừa duyệt.
        if (body.status !== undefined && cleanText(body.status).toUpperCase() === "ACTIVE") {
          await tx.recipe.updateMany({ where: { productCode: recipe.productCode, status: "ACTIVE", id: { not: recipeId } }, data: { status: "INACTIVE" } });
        }
        return tx.recipe.update({
          where: { id: recipeId },
          data: {
            productName,
            unit,
            sellingPrice,
            outputConversionRate,
            ...(body.effectiveFrom !== undefined ? { effectiveFrom: toDate(body.effectiveFrom) } : {}),
            ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
            ...(body.status !== undefined ? { status: cleanText(body.status).toUpperCase() || "ACTIVE" } : {}),
          },
          include: { lines: { include: { item: true } } },
        });
      });

      await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_RECIPE", entityType: "Recipe", entityId: result.id, entityCode: result.code, metadata: { productCode: result.productCode, lines: result.lines.length } });
      return NextResponse.json(result);
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
  type Reversal = { itemId: string; warehouseCode: string; direction: "IN" | "OUT"; quantity: number; totalCost: number };
  const reversals = new Map<string, Reversal>();
  const addReversal = (itemId: string, warehouseCode: string, direction: "IN" | "OUT", quantity: number, totalCost: number) => {
    const key = `${itemId}|${warehouseCode}|${direction}`;
    const current = reversals.get(key) || { itemId, warehouseCode, direction, quantity: 0, totalCost: 0 };
    current.quantity += quantity;
    current.totalCost += totalCost;
    reversals.set(key, current);
  };

  for (const line of transaction.lines) {
    if (transaction.transactionType.startsWith("NHAP_")) {
      addReversal(line.itemId, transaction.warehouseCode, "IN", line.quantity, line.totalCost);
    } else if (transaction.transactionType.startsWith("XUAT_")) {
      addReversal(line.itemId, transaction.warehouseCode, "OUT", line.quantity, line.totalCost);
    } else {
      addReversal(line.itemId, transaction.warehouseCode, "OUT", line.quantity, line.totalCost);
      addReversal(line.itemId, transaction.toWarehouseCode || "", "IN", line.quantity, line.totalCost);
    }
  }

  await prisma.$transaction(async (tx) => {
    for (const reversal of reversals.values()) {
      const balance = await tx.inventoryBalance.findUnique({
        where: { itemId_warehouseCode: { itemId: reversal.itemId, warehouseCode: reversal.warehouseCode } },
      });
      const currentQuantity = balance?.quantity || 0;
      const currentAverage = balance?.averageCost || 0;
      const currentValue = currentQuantity * currentAverage;
      // Phiếu đã làm tồn TĂNG -> hoàn kho là GIẢM lại, và ngược lại.
      const newQuantity = reversal.direction === "IN" ? currentQuantity - reversal.quantity : currentQuantity + reversal.quantity;
      if (newQuantity < -quantityEpsilon) {
        businessError(`Tồn kho hiện tại của kho ${reversal.warehouseCode} không đủ để hoàn lại phiếu ${transaction.code}. Hãy kiểm tra lại các phiếu phát sinh sau.`);
      }
      const newValue = reversal.direction === "IN" ? currentValue - reversal.totalCost : currentValue + reversal.totalCost;
      const averageCost = newQuantity > quantityEpsilon ? Math.max(newValue / newQuantity, 0) : currentAverage;
      await tx.inventoryBalance.upsert({
        where: { itemId_warehouseCode: { itemId: reversal.itemId, warehouseCode: reversal.warehouseCode } },
        create: { itemId: reversal.itemId, warehouseCode: reversal.warehouseCode, quantity: Math.max(newQuantity, 0), averageCost },
        update: { quantity: Math.max(newQuantity, 0), averageCost },
      });
    }
  });

  return [...reversals.values()];
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

      if (transaction.importBatchId) {
        businessError(`Phiếu ${transaction.code} thuộc lô import nên phải huỷ ở màn hình Import dữ liệu để đảm bảo tồn kho không bị lệch.`);
      }
      const derivedFrom = transaction.referenceType ? derivedReferenceTypes[transaction.referenceType] : undefined;
      if (derivedFrom) {
        businessError(`Phiếu ${transaction.code} được sinh tự động từ ${derivedFrom} ${transaction.referenceCode || ""}`.trim() + " nên phải xử lý ở chứng từ gốc, xoá riêng phiếu này sẽ làm lệch tồn kho.");
      }
      if (await isPeriodLocked(transaction.transactionDate, transaction.branchCode)) {
        businessError(`Kỳ kế toán của phiếu ${transaction.code} đã khóa nên không thể xoá.`);
      }

      // Chỉ hoàn kho chính xác được khi phiếu là chứng từ mới nhất trên các mặt hàng/kho liên quan.
      const warehouseCodes = [transaction.warehouseCode, transaction.toWarehouseCode].filter((value): value is string => !!value);
      const itemIds = [...new Set(transaction.lines.map((line) => line.itemId))];
      const newer = await prisma.inventoryTransaction.findFirst({
        where: {
          id: { not: transaction.id },
          createdAt: { gt: transaction.createdAt },
          lines: { some: { itemId: { in: itemIds } } },
          OR: [
            { warehouseCode: { in: warehouseCodes } },
            { toWarehouseCode: { in: warehouseCodes } },
          ],
        },
        orderBy: { createdAt: "asc" },
      });
      if (newer) {
        businessError(`Đã có phiếu ${newer.code} phát sinh sau phiếu ${transaction.code} trên cùng mặt hàng/kho nên không thể hoàn kho chính xác. Hãy xoá các phiếu phát sinh sau hoặc lập phiếu điều chỉnh kho.`);
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

      const reversals = await reverseTransactionStock(transaction);
      const result = await softDeleteRecord({ model: "InventoryTransaction", id, session: auth.session, reason });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "REVERSE_STOCK", entityType: "InventoryTransaction", entityId: transaction.id, entityCode: transaction.code, branchCode: transaction.branchCode, metadata: { transactionType: transaction.transactionType, reversals, internalDebtCodes } });
      return NextResponse.json(result);
    }

    if (["STOCKTAKE", "STOCKTAKE_SESSION", "STOCKTAKESESSION"].includes(type)) {
      const stocktake = await prisma.stocktakeSession.findUnique({ where: { id } });
      if (!stocktake) businessError("Không tìm thấy phiếu kiểm kê");
      assertBranchAccess(auth.session, stocktake.branchCode);
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
        where: { productCode: recipe.productCode, version: { gt: recipe.version } },
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
