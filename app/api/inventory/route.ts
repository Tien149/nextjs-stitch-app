import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";

const menuHref = "/inventory";

type InputLine = { itemId?: unknown; quantity?: unknown; unitCost?: unknown; wasteRate?: unknown };

function linesFrom(value: unknown) {
  if (!Array.isArray(value)) return [];
  return (value as InputLine[]).map((line) => ({
    itemId: cleanText(line.itemId),
    quantity: toNumber(line.quantity),
    unitCost: toNumber(line.unitCost),
    wasteRate: toNumber(line.wasteRate),
  })).filter((line) => line.itemId && line.quantity > 0);
}

async function code(prefix: string, count: number) {
  return `${prefix}-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;
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

    const [items, balances, transactions, recipes] = await Promise.all([
      prisma.inventoryItem.findMany({ orderBy: { name: "asc" } }),
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
      prisma.recipe.findMany({ include: { lines: { include: { item: { include: { balances: true } } } } }, orderBy: { updatedAt: "desc" } }),
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
    return NextResponse.json({ items, balances, transactions, recipes: recipesWithCost });
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
      const itemType = cleanText(body.itemType) || "MATERIAL";

      if (!itemCode || !name || !unit) businessError("Mã, tên và đơn vị tính là bắt buộc");

      const uppercaseCode = itemCode.toUpperCase();
      if (itemType === "MATERIAL" && !uppercaseCode.startsWith("NVL_")) {
        businessError("Mã nguyên vật liệu bắt buộc phải bắt đầu bằng 'NVL_' (ví dụ: NVL_SUADAC).");
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
      return NextResponse.json(item, { status: 201 });
    }

    if (action === "CREATE_RECIPE") {
      const inputLines = linesFrom(body.lines);
      const productCode = cleanText(body.productCode);
      const productName = cleanText(body.productName);
      if (!productCode || !productName || inputLines.length === 0) businessError("Định lượng cần mã món, tên món và nguyên liệu");
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

    const transactionType = action === "RECORD_WASTE" ? "WASTE" : cleanText(body.transactionType);
    if (!["RECEIPT", "ISSUE", "ADJUSTMENT", "WASTE"].includes(transactionType)) businessError("Loại giao dịch kho không hợp lệ");
    const transactionDate = toDate(body.transactionDate);
    const branchCode = cleanText(body.branchCode);
    const warehouseCode = cleanText(body.warehouseCode);
    if (!branchCode || !warehouseCode) businessError("Cửa hàng và kho là bắt buộc");
    assertBranchAccess(auth.session, branchCode);

    // Validate that the warehouse belongs to the branch
    const warehouse = await prisma.masterDataItem.findFirst({
      where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode }
    });
    if (!warehouse) {
      businessError(`Kho ${warehouseCode} không thuộc chi nhánh ${branchCode}.`);
    }

    if (await isPeriodLocked(transactionDate, branchCode)) businessError("Kỳ kế toán đã khóa");

    let inputLines = linesFrom(body.lines);
    if (action === "RECORD_WASTE" && cleanText(body.recipeId)) {
      const recipe = await prisma.recipe.findUnique({ where: { id: cleanText(body.recipeId) }, include: { lines: true } });
      if (!recipe) businessError("Không tìm thấy định lượng món hủy");
      const productQuantity = toNumber(body.productQuantity);
      if (productQuantity <= 0) businessError("Số lượng món hủy phải lớn hơn 0");
      inputLines = recipe.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity, unitCost: 0, wasteRate: 0 }));
    }
    if (inputLines.length === 0) businessError("Cần ít nhất một dòng nguyên liệu");

    const result = await prisma.$transaction(async (tx) => {
      const prefix = transactionType === "RECEIPT" ? "NK" : transactionType === "WASTE" ? "HH" : "XK";
      const transactionCode = cleanText(body.code) || await code(prefix, await tx.inventoryTransaction.count());
      const valuedLines: Array<{ itemId: string; quantity: number; unitCost: number; totalCost: number }> = [];

      for (const line of inputLines) {
        const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode } } });
        const currentQuantity = balance?.quantity || 0;
        const currentAverage = balance?.averageCost || 0;
        const isInbound = transactionType === "RECEIPT" || (transactionType === "ADJUSTMENT" && line.unitCost > 0);
        const unitCost = line.unitCost || currentAverage;
        const newQuantity = isInbound ? currentQuantity + line.quantity : currentQuantity - line.quantity;
        if (newQuantity < 0) businessError("Không thể xuất vượt tồn kho");
        const averageCost = isInbound && newQuantity > 0
          ? (currentQuantity * currentAverage + line.quantity * unitCost) / newQuantity
          : currentAverage;
        await tx.inventoryBalance.upsert({
          where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode } },
          create: { itemId: line.itemId, warehouseCode, quantity: newQuantity, averageCost },
          update: { quantity: newQuantity, averageCost },
        });
        valuedLines.push({ itemId: line.itemId, quantity: line.quantity, unitCost, totalCost: line.quantity * unitCost });
      }

      return tx.inventoryTransaction.create({
        data: {
          code: transactionCode,
          transactionType,
          transactionDate,
          branchCode,
          warehouseCode,
          referenceType: action === "RECORD_WASTE" ? "POS_WASTE" : cleanText(body.referenceType) || null,
          referenceCode: cleanText(body.referenceCode) || null,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          lines: { create: valuedLines },
        },
        include: { lines: { include: { item: true } } },
      });
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
