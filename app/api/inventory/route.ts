import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { normalizeStockTransactionType, postInventoryTransaction } from "@/lib/inventory-stock";

const menuHref = "/inventory";

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
  return (value as InputLine[]).map((line) => ({
    itemId: cleanText(line.itemId),
    itemCode: cleanText(line.itemCode),
    actualQuantity: toNumber(line.actualQuantity ?? line.quantity),
    reason: cleanText(line.reason),
  })).filter((line) => (line.itemId || line.itemCode) && Number.isFinite(line.actualQuantity) && line.actualQuantity >= 0);
}

async function code(prefix: string, count: number) {
  return `${prefix}-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;
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
        const averageCost = line.item.balances.length
          ? line.item.balances.reduce((cost, balance) => cost + balance.averageCost, 0) / line.item.balances.length
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
    return NextResponse.json({ items, balances, transactions, recipes: recipesWithCost, warehouses, stocktakes, stockSummary, stockMovements });
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
      if (itemType === "RAW_MATERIAL" && !uppercaseCode.startsWith("NVL_")) {
        businessError("Mã nguyên vật liệu bắt buộc phải bắt đầu bằng 'NVL_' (ví dụ: NVL_SUADAC).");
      }
      if (itemType === "SEMI_FINISHED" && !uppercaseCode.startsWith("BTP_")) {
        businessError("Mã bán thành phẩm bắt buộc phải bắt đầu bằng 'BTP_' (ví dụ: BTP_SOTCACHUA).");
      }
      if (itemType === "FINISHED" && !uppercaseCode.startsWith("SP_")) {
        businessError("Mã thành phẩm bắt buộc phải bắt đầu bằng 'SP_' (ví dụ: SP_COMBO01).");
      }
      if (itemType === "PACKAGING" && !uppercaseCode.startsWith("BB_")) {
        businessError("Mã bao bì bắt buộc phải bắt đầu bằng 'BB_' (ví dụ: BB_LYGIAY).");
      }
      if (itemType === "TOOL" && !uppercaseCode.startsWith("CCDC_")) {
        businessError("Mã công cụ dụng cụ bắt buộc phải bắt đầu bằng 'CCDC_' (ví dụ: CCDC_MAYPHA).");
      }
      if (itemType === "ASSET" && !uppercaseCode.startsWith("TS_")) {
        businessError("Mã tài sản bắt buộc phải bắt đầu bằng 'TS_' (ví dụ: TS_MAYPHA).");
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
      const inputLines = linesFrom(body.lines);
      const productCode = cleanText(body.productCode);
      const productName = cleanText(body.productName);
      if (!productCode || !productName || inputLines.length === 0) businessError("Định lượng cần mã món, tên món và nguyên liệu");
      const productItem = await prisma.inventoryItem.findUnique({ where: { code: productCode.toUpperCase() } });
      if (!productItem) businessError(`Khong tim thay san pham ${productCode}`);
      if (inputLines.some((line) => line.itemId === productItem.id || line.itemCode.toUpperCase() === productItem.code)) {
        businessError("BOM khong duoc tham chieu chinh san pham do");
      }
      const latest = await prisma.recipe.findFirst({ where: { productCode }, orderBy: { version: "desc" } });
      if (latest) await prisma.recipe.updateMany({ where: { productCode, status: "ACTIVE" }, data: { status: "INACTIVE" } });
      const recipe = await prisma.recipe.create({
        data: {
          code: `${productCode}-V${(latest?.version || 0) + 1}`,
          productCode,
          productName,
          unit: cleanText(body.unit) || "Ly",
          sellingPrice: toNumber(body.sellingPrice),
          version: (latest?.version || 0) + 1,
          lines: { create: inputLines.map((line) => ({ itemId: line.itemId, quantity: line.quantity, wasteRate: line.wasteRate })) },
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
        prisma.recipe.findFirst({ where: { productCode, status: "ACTIVE" }, include: { lines: true }, orderBy: { version: "desc" } }),
      ]);
      if (!productItem) businessError(`Khong tim thay ban thanh pham ${productCode}`);
      if (productItem.itemType !== "SEMI_FINISHED") businessError("Che bien chi ap dung cho mat hang ban thanh pham");
      if (!recipe || recipe.lines.length === 0) businessError(`Chua co BOM active cho ${productCode}`);
      if (await isPeriodLocked(productionDate, branchCode)) businessError("Ky ke toan da khoa");
      const result = await prisma.$transaction(async (tx) => {
        const sequence = await tx.inventoryTransaction.count();
        const referenceCode = cleanText(body.referenceCode) || `CB-${new Date().getFullYear()}-${String(sequence + 1).padStart(4, "0")}`;
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
      const result = await prisma.$transaction(async (tx) => {
        const sequence = await tx.stocktakeSession.count();
        const stocktake = await tx.stocktakeSession.create({
          data: {
            code: cleanText(body.code) || `KK-${stocktakeDate.getFullYear()}-${String(sequence + 1).padStart(4, "0")}`,
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
          const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode } } });
          const systemQuantity = balance?.quantity || 0;
          const varianceQuantity = row.actualQuantity - systemQuantity;
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
          if (varianceQuantity > 0) inboundLines.push({ itemId: item.id, inputQuantity: varianceQuantity, inputUnitCode: item.unit, inputUnitCost: balance?.averageCost || 0 });
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

    const result = await prisma.$transaction(async (tx) => {
      const transactionCode = cleanText(body.code) || await code(stockPrefix(transactionType), await tx.inventoryTransaction.count());
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
