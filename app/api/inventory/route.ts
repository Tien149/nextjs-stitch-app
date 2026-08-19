import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { normalizeStockTransactionType, postInventoryTransaction } from "@/lib/inventory-stock";
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

type InputLine = { itemId?: unknown; itemCode?: unknown; quantity?: unknown; actualQuantity?: unknown; inputQuantity?: unknown; unitCode?: unknown; inputUnitCode?: unknown; unitCost?: unknown; inputUnitCost?: unknown; wasteRate?: unknown; reason?: unknown };
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

/** Dòng định mức khi sửa BOM: báo lỗi rõ ràng thay vì lặng lẽ loại bỏ. */
function editableRecipeLines(value: unknown) {
  if (!Array.isArray(value)) businessError("Danh sách nguyên liệu không hợp lệ");
  const lines = (value as InputLine[]).map((line) => ({
    itemId: cleanText(line.itemId),
    itemCode: cleanText(line.itemCode),
    quantity: toNumber(line.quantity ?? line.inputQuantity),
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

    const [items, balances, transactions, reportTransactions, recipes, warehouses, stocktakes] = await Promise.all([
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
    ]);
    const recipesWithCost = recipes.map((recipe) => ({
      ...recipe,
      estimatedCost: recipe.lines.reduce((sum, line) => {
        // Bình quân CÓ TRỌNG SỐ theo tồn: kho mới lập (tồn 0, giá 0) không được kéo giá vốn
        // món xuống một nửa như phép chia đều trước đây.
        const stocked = line.item.balances.filter((balance) => balance.quantity > 0);
        const totalQuantity = stocked.reduce((quantity, balance) => quantity + balance.quantity, 0);
        const averageCost = totalQuantity > 0
          ? stocked.reduce((cost, balance) => cost + balance.quantity * balance.averageCost, 0) / totalQuantity
          : 0;
        return sum + line.quantity * (1 + line.wasteRate / 100) * averageCost;
      }, 0),
    }));
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
    return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { items, balances, transactions, recipes: recipesWithCost, warehouses, stocktakes, stockSummary, stockMovements }));
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
          category: cleanText(body.category) || null,
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
      const resolvedRecipeLines: { itemId: string; quantity: number; wasteRate: number }[] = [];
      for (const line of inputLines) {
        const item = line.itemId
          ? await prisma.inventoryItem.findUnique({ where: { id: line.itemId } })
          : await prisma.inventoryItem.findUnique({ where: { code: line.itemCode.toUpperCase() } });
        if (!item) businessError(`Không tìm thấy nguyên liệu ${line.itemCode || line.itemId}`);
        if (item.id === productItem.id) businessError("BOM khong duoc tham chieu chinh san pham do");
        resolvedRecipeLines.push({ itemId: item.id, quantity: line.quantity, wasteRate: line.wasteRate });
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
          // Cùng mặc định với import ("phan") — hai luồng ra dữ liệu giống nhau.
          unit: cleanText(body.unit) || "phan",
          sellingPrice: toNumber(body.sellingPrice),
          version: (latest?.version || 0) + 1,
          ...(body.effectiveFrom !== undefined && cleanText(body.effectiveFrom) ? { effectiveFrom: toDate(body.effectiveFrom) } : {}),
          note: cleanText(body.note) || null,
          lines: { create: resolvedRecipeLines },
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
      const [productItem, recipe] = await Promise.all([
        prisma.inventoryItem.findUnique({ where: { code: productCode } }),
        // Công thức đúng là bản có hiệu lực TẠI NGÀY CHẾ BIẾN, không phải bản mới nhất:
        // đổi định lượng hôm nay rồi lập lệnh cho tuần trước phải ăn theo công thức cũ.
        prisma.recipe.findFirst({
          where: { productCode, effectiveFrom: { lte: productionDate } },
          include: { lines: true },
          orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
        }),
      ]);
      if (!productItem) businessError(`Khong tim thay ban thanh pham ${productCode}`);
      if (productItem.itemType !== "SEMI_FINISHED") businessError("Che bien chi ap dung cho mat hang ban thanh pham");
      if (!recipe || recipe.lines.length === 0) businessError(`Chua co BOM active cho ${productCode}`);
      if (await isPeriodLocked(productionDate, branchCode)) businessError("Ky ke toan da khoa");
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
            inputQuantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity,
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
    if (transactionType === "DIEU_CHUYEN") {
      const destinationWarehouse = await prisma.masterDataItem.findFirst({
        where: { type: "WAREHOUSE", code: toWarehouseCode, status: "ACTIVE" }
      });
      if (!destinationWarehouse) businessError(`Kho nhận ${toWarehouseCode} không tồn tại hoặc ngưng hoạt động`);
      if (destinationWarehouse.branch) assertBranchAccess(auth.session, destinationWarehouse.branch);
      // Phiếu chỉ mang MỘT chi nhánh (của kho xuất). Cho điều chuyển sang chi nhánh khác thì
      // báo cáo kho của chi nhánh nhận thấy tồn tăng mà không có phiếu nào giải thích.
      if (destinationWarehouse.branch && destinationWarehouse.branch !== branchCode) {
        businessError(`Kho nhận ${toWarehouseCode} thuộc chi nhánh ${destinationWarehouse.branch}, khác chi nhánh phiếu (${branchCode}). Điều chuyển liên chi nhánh chưa được hỗ trợ — dùng cặp phiếu Xuất khác/Nhập khác có ghi rõ lý do.`);
      }
    }

    if (await isPeriodLocked(transactionDate, branchCode)) businessError("Kỳ kế toán đã khóa");

    let inputLines = linesFrom(body.lines);
    if (action === "RECORD_WASTE" && cleanText(body.recipeId)) {
      const recipe = await prisma.recipe.findUnique({ where: { id: cleanText(body.recipeId) }, include: { lines: true } });
      if (!recipe) businessError("Không tìm thấy định lượng món hủy");
      const productQuantity = toNumber(body.productQuantity);
      if (productQuantity <= 0) businessError("Số lượng món hủy phải lớn hơn 0");
      inputLines = recipe.lines.map((line) => ({
        itemId: line.itemId,
        itemCode: "",
        quantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity,
        inputQuantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity,
        unitCode: "",
        inputUnitCode: "",
        unitCost: 0,
        inputUnitCost: 0,
        wasteRate: 0,
      }));
    }
    if (inputLines.length === 0) businessError("Cần ít nhất một dòng nguyên liệu");

    const requestedTransactionCode = cleanText(body.code);
    if (requestedTransactionCode && await findDeletedByUnique("InventoryTransaction", { code: requestedTransactionCode })) {
      businessError(duplicatedInTrashMessage(requestedTransactionCode, "Phiếu nhập/xuất kho"));
    }

    const result = await prisma.$transaction(async (tx) => {
      const transactionCode = cleanText(body.code) || await nextStockDocCode(tx, stockPrefix(transactionType), transactionDate);
      return postInventoryTransaction(tx, {
        code: transactionCode,
        transactionType,
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
          ...(body.category !== undefined ? { category: cleanText(body.category) || null } : {}),
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

      const nextLines = body.lines !== undefined ? editableRecipeLines(body.lines) : null;
      const resolvedLines: { itemId: string; quantity: number; wasteRate: number }[] = [];
      if (nextLines) {
        const productItem = await prisma.inventoryItem.findUnique({ where: { code: recipe.productCode.toUpperCase() } });
        for (const line of nextLines) {
          const item = line.itemId
            ? await prisma.inventoryItem.findUnique({ where: { id: line.itemId } })
            : await prisma.inventoryItem.findUnique({ where: { code: line.itemCode.toUpperCase() } });
          if (!item) businessError(`Không tìm thấy nguyên liệu ${line.itemCode || line.itemId}`);
          if (productItem && item.id === productItem.id) businessError("BOM không được tham chiếu chính sản phẩm đó");
          resolvedLines.push({ itemId: item.id, quantity: line.quantity, wasteRate: line.wasteRate });
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

      const reversals = await reverseTransactionStock(transaction);
      const result = await softDeleteRecord({ model: "InventoryTransaction", id, session: auth.session, reason });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "REVERSE_STOCK", entityType: "InventoryTransaction", entityId: transaction.id, entityCode: transaction.code, branchCode: transaction.branchCode, metadata: { transactionType: transaction.transactionType, reversals } });
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
