import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { writeAuditLog } from "@/lib/audit-log";

const menuHref = "/procurement";

type InputLine = {
  itemId?: unknown;
  quantity?: unknown;
  unitCost?: unknown;
  estimatedUnitCost?: unknown;
  imageUrl?: unknown;
  note?: unknown;
};

async function generatedCode(prefix: string, count: number) {
  return `${prefix}-${new Date().getFullYear()}-${String(count + 1).padStart(4, "0")}`;
}

function validLines(value: unknown) {
  if (!Array.isArray(value)) return [];
  return (value as InputLine[])
    .map((line) => ({
      itemId: cleanText(line.itemId),
      quantity: toNumber(line.quantity),
      unitCost: toNumber(line.unitCost ?? line.estimatedUnitCost),
      imageUrl: cleanText(line.imageUrl),
      note: cleanText(line.note),
    }))
    .filter((line) => line.itemId && line.quantity > 0);
}

function assetGroupFromItemType(itemType: string) {
  if (itemType === "TOOL") return "CCDC";
  if (itemType === "ASSET") return "ASSET";
  return itemType || "ASSET";
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const [items, requests, orders, departments] = await Promise.all([
      prisma.inventoryItem.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
      prisma.purchaseRequest.findMany({
        where: { ...branchFilter },
        include: {
          lines: { include: { item: true } },
          quotes: { include: { lines: { include: { item: true } } }, orderBy: { totalAmount: "asc" } },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.purchaseOrder.findMany({
        where: { ...branchFilter },
        include: { lines: { include: { item: true } }, payable: true, request: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.masterDataItem.findMany({
        where: { type: "DEPARTMENT", status: "ACTIVE" },
        orderBy: [{ branch: "asc" }, { name: "asc" }],
      }),
    ]);

    return NextResponse.json({ items, requests, orders, departments });
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
    const action = cleanText(body.action) || "CREATE_REQUEST";

    if (action === "CREATE_REQUEST") {
      const lines = validLines(body.lines);
      const branchCode = cleanText(body.branchCode);
      const departmentCode = cleanText(body.departmentCode) || cleanText(body.department) || null;
      const reason = cleanText(body.reason);
      if (!branchCode || !reason || lines.length === 0) businessError("Cần chi nhánh, lý do và ít nhất một mặt hàng");
      assertBranchAccess(auth.session, branchCode);

      // Validate requiresImage for each line
      for (const line of lines) {
        const item = await prisma.inventoryItem.findUnique({ where: { id: line.itemId } });
        if (item?.requiresImage && !line.imageUrl) {
          businessError(`Mặt hàng ${item.name} yêu cầu phải có hình ảnh khi mua.`);
        }
      }

      const code = cleanText(body.code) || await generatedCode("PR", await prisma.purchaseRequest.count());
      const result = await prisma.purchaseRequest.create({
        data: {
          code,
          branchCode,
          departmentCode,
          requestedBy: auth.session.name,
          requestDate: toDate(body.requestDate),
          neededDate: body.neededDate ? toDate(body.neededDate) : null,
          reason,
          status: cleanText(body.status) || "PENDING_APPROVAL",
          note: cleanText(body.note) || null,
          lines: {
            create: lines.map((line) => ({
              itemId: line.itemId,
              quantity: line.quantity,
              estimatedUnitCost: line.unitCost,
              imageUrl: line.imageUrl || null,
              note: line.note || null,
            })),
          },
        },
        include: { lines: { include: { item: true } } },
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "CREATE_REQUEST", entityType: "PurchaseRequest", entityId: result.id, entityCode: result.code, branchCode, metadata: { departmentCode, lines: result.lines.length } });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "ADD_QUOTE") {
      const requestId = cleanText(body.requestId);
      const supplierCode = cleanText(body.supplierCode);
      const supplierName = cleanText(body.supplierName);
      const lines = validLines(body.lines);
      if (!requestId || !supplierCode || !supplierName || lines.length === 0) businessError("Báo giá thiếu PR, nhà cung cấp hoặc dòng hàng");

      const pr = await prisma.purchaseRequest.findUnique({ where: { id: requestId } });
      if (!pr) businessError("Không tìm thấy yêu cầu mua hàng");
      assertBranchAccess(auth.session, pr.branchCode);
      const totalAmount = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
      const result = await prisma.supplierQuote.create({
        data: {
          requestId,
          supplierCode,
          supplierName,
          deliveryDays: toNumber(body.deliveryDays) || null,
          paymentTerms: cleanText(body.paymentTerms) || null,
          totalAmount,
          note: cleanText(body.note) || null,
          lines: { create: lines.map((line) => ({ ...line, totalCost: line.quantity * line.unitCost })) },
        },
        include: { lines: { include: { item: true } } },
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "ADD_QUOTE", entityType: "SupplierQuote", entityId: result.id, entityCode: result.supplierCode, branchCode: pr.branchCode, metadata: { requestId, supplierName, totalAmount } });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "CREATE_ORDER") {
      const requestId = cleanText(body.requestId) || null;
      const lines = validLines(body.lines);
      const supplierCode = cleanText(body.supplierCode);
      const supplierName = cleanText(body.supplierName);
      const branchCode = cleanText(body.branchCode);
      const bodyDepartmentCode = cleanText(body.departmentCode) || cleanText(body.department) || null;
      const warehouseCode = cleanText(body.warehouseCode);
      if (!supplierCode || !supplierName || !branchCode || !warehouseCode || lines.length === 0) {
        businessError("PO thiếu nhà cung cấp, chi nhánh, kho nhận hoặc dòng hàng");
      }
      assertBranchAccess(auth.session, branchCode);

      // Validate that the warehouse belongs to the branch
      const warehouse = await prisma.masterDataItem.findFirst({
        where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode }
      });
      if (!warehouse) {
        businessError(`Kho ${warehouseCode} không thuộc chi nhánh ${branchCode}.`);
      }

      const sourceLines = requestId
        ? await prisma.purchaseRequestLine.findMany({ where: { requestId }, include: { item: true } })
        : [];
      const normalizedLines = await Promise.all(lines.map(async (line) => {
        const sourceLine = sourceLines.find((item) => item.itemId === line.itemId);
        const item = sourceLine?.item || await prisma.inventoryItem.findUnique({ where: { id: line.itemId } });
        if (!item) businessError("Mặt hàng trên PO không tồn tại");
        const imageUrl = line.imageUrl || sourceLine?.imageUrl || "";
        if (item.requiresImage && !imageUrl) {
          businessError(`Mặt hàng ${item.name} yêu cầu phải có hình ảnh khi tạo đơn mua hàng.`);
        }
        return { ...line, imageUrl };
      }));

      if (requestId) {
        const source = await prisma.purchaseRequest.findUnique({ where: { id: requestId } });
        if (!source || !["APPROVED", "ORDERED"].includes(source.status)) businessError("PR phải được duyệt trước khi tạo PO");
      }
      const sourceRequest = requestId ? await prisma.purchaseRequest.findUnique({ where: { id: requestId } }) : null;
      const departmentCode = bodyDepartmentCode || sourceRequest?.departmentCode || null;
      const code = cleanText(body.code) || await generatedCode("PO", await prisma.purchaseOrder.count());
      const totalAmount = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
      const result = await prisma.$transaction(async (tx) => {
        const order = await tx.purchaseOrder.create({
          data: {
            code,
            requestId,
            supplierCode,
            supplierName,
            branchCode,
            departmentCode,
            warehouseCode,
            expectedDate: body.expectedDate ? toDate(body.expectedDate) : null,
            totalAmount,
            status: cleanText(body.status) || "DRAFT",
            createdBy: auth.session.name,
            note: cleanText(body.note) || null,
            lines: {
              create: normalizedLines.map((line) => ({
                itemId: line.itemId,
                orderedQuantity: line.quantity,
                unitCost: line.unitCost,
                totalCost: line.quantity * line.unitCost,
                imageUrl: line.imageUrl || null,
              })),
            },
          },
          include: { lines: { include: { item: true } } },
        });
        if (requestId) await tx.purchaseRequest.update({ where: { id: requestId }, data: { status: "ORDERED" } });
        return order;
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "CREATE_ORDER", entityType: "PurchaseOrder", entityId: result.id, entityCode: result.code, branchCode, metadata: { requestId, supplierCode, supplierName, departmentCode, warehouseCode, totalAmount } });
      return NextResponse.json(result, { status: 201 });
    }

    businessError("Thao tác mua hàng không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);

    if (["APPROVE_REQUEST", "REJECT_REQUEST", "SELECT_QUOTE", "APPROVE_ORDER"].includes(action)) {
      const auth = requireMenuAction(request, menuHref, "approve");
      if (!auth.ok) return auth.response;
      if (action === "APPROVE_ORDER") {
        const orderId = cleanText(body.orderId);
        const order = await prisma.purchaseOrder.findUnique({ where: { id: orderId } });
        if (!order) businessError("Không tìm thấy PO");
        assertBranchAccess(auth.session, order.branchCode);
        if (order.status !== "DRAFT") businessError("Chỉ PO nháp mới được duyệt");
        const result = await prisma.purchaseOrder.update({
          where: { id: orderId },
          data: { status: "APPROVED", approvedBy: auth.session.name, approvedAt: new Date(), note: cleanText(body.note) || undefined },
        });
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "APPROVE_ORDER", entityType: "PurchaseOrder", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousStatus: order.status, status: result.status } });
        return NextResponse.json(result);
      }
      if (action === "SELECT_QUOTE") {
        const quoteId = cleanText(body.quoteId);
        const quote = await prisma.supplierQuote.findUnique({ where: { id: quoteId }, include: { request: true } });
        if (!quote) businessError("Không tìm thấy báo giá");
        assertBranchAccess(auth.session, quote.request.branchCode);
        await prisma.$transaction([
          prisma.supplierQuote.updateMany({ where: { requestId: quote.requestId }, data: { isSelected: false } }),
          prisma.supplierQuote.update({ where: { id: quoteId }, data: { isSelected: true } }),
        ]);
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "SELECT_QUOTE", entityType: "SupplierQuote", entityId: quote.id, entityCode: quote.supplierCode, branchCode: quote.request.branchCode, metadata: { requestId: quote.requestId, supplierName: quote.supplierName, totalAmount: quote.totalAmount } });
        return NextResponse.json({ ok: true });
      }
      const requestId = cleanText(body.requestId);
      if (!requestId) businessError("Thiếu PR cần xử lý");
      const pr = await prisma.purchaseRequest.findUnique({ where: { id: requestId } });
      if (!pr) businessError("Không tìm thấy yêu cầu mua hàng");
      assertBranchAccess(auth.session, pr.branchCode);
      const status = action === "APPROVE_REQUEST" ? "APPROVED" : "REJECTED";
      const result = await prisma.purchaseRequest.update({
        where: { id: requestId },
        data: { status, approvedBy: auth.session.name, approvedAt: new Date(), note: cleanText(body.note) || undefined },
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action, entityType: "PurchaseRequest", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousStatus: pr.status, status } });
      return NextResponse.json(result);
    }

    const auth = requireMenuAction(request, menuHref, "edit");
    if (!auth.ok) return auth.response;
    if (action !== "RECEIVE_ORDER") businessError("Thao tác cập nhật không hợp lệ");

    const orderId = cleanText(body.orderId);
    const order = await prisma.purchaseOrder.findUnique({ where: { id: orderId }, include: { lines: { include: { item: true } } } });
    if (!order) businessError("Không tìm thấy PO");
    assertBranchAccess(auth.session, order.branchCode);
    if (!["APPROVED", "PARTIALLY_RECEIVED"].includes(order.status)) businessError("PO không ở trạng thái có thể nhận hàng");
    const receivedDate = toDate(body.receivedDate);
    if (await isPeriodLocked(receivedDate, order.branchCode)) businessError("Kỳ kế toán đã khóa");

    const requestedLines = validLines(body.lines);
    const receiveLines = order.lines.map((line) => {
      const requested = requestedLines.find((item) => item.itemId === line.itemId);
      const remaining = line.orderedQuantity - line.receivedQuantity;
      return { ...line, receiveQuantity: requested ? requested.quantity : remaining };
    }).filter((line) => line.receiveQuantity > 0);
    if (receiveLines.length === 0) businessError("Không có số lượng cần nhận");
    for (const line of receiveLines) {
      if (line.receiveQuantity > line.orderedQuantity - line.receivedQuantity) businessError("Số lượng nhận vượt số lượng còn lại của PO");
    }

    const result = await prisma.$transaction(async (tx) => {
      const transactionCode = await generatedCode("NK", await tx.inventoryTransaction.count());
      const stockTransaction = await tx.inventoryTransaction.create({
        data: {
          code: transactionCode,
          transactionType: "RECEIPT",
          transactionDate: receivedDate,
          branchCode: order.branchCode,
          warehouseCode: order.warehouseCode,
          referenceType: "PURCHASE_ORDER",
          referenceId: order.id,
          referenceCode: order.code,
          createdBy: auth.session.name,
          note: cleanText(body.note) || `Nhận hàng từ ${order.code}`,
          lines: { create: receiveLines.map((line) => ({ itemId: line.itemId, quantity: line.receiveQuantity, unitCost: line.unitCost, totalCost: line.receiveQuantity * line.unitCost })) },
        },
      });

      let receivedValue = 0;
      for (const line of receiveLines) {
        const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode: order.warehouseCode } } });
        const oldQuantity = balance?.quantity || 0;
        const oldValue = oldQuantity * (balance?.averageCost || 0);
        const receivedLineValue = line.receiveQuantity * line.unitCost;
        const newQuantity = oldQuantity + line.receiveQuantity;
        const averageCost = newQuantity > 0 ? (oldValue + receivedLineValue) / newQuantity : 0;
        await tx.inventoryBalance.upsert({
          where: { itemId_warehouseCode: { itemId: line.itemId, warehouseCode: order.warehouseCode } },
          create: { itemId: line.itemId, warehouseCode: order.warehouseCode, quantity: newQuantity, averageCost },
          update: { quantity: newQuantity, averageCost },
        });
        await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQuantity: { increment: line.receiveQuantity } } });
        receivedValue += receivedLineValue;
        if (["TOOL", "ASSET"].includes(line.item.itemType)) {
          const assetSequence = await tx.assetRecord.count();
          await tx.assetRecord.create({
            data: {
              code: `TS-${order.code}-${String(assetSequence + 1).padStart(4, "0")}`,
              name: line.item.name,
              branchCode: order.branchCode,
              departmentCode: order.departmentCode || null,
              assetGroup: assetGroupFromItemType(line.item.itemType),
              imageUrl: line.imageUrl || null,
              location: order.warehouseCode,
              quantity: line.receiveQuantity,
              purchaseDate: receivedDate,
              originalCost: receivedLineValue,
              currentValue: receivedLineValue,
              supplierCode: order.supplierCode,
              supplierName: order.supplierName,
              sourcePurchaseOrderId: order.id,
              sourceReceiptId: stockTransaction.id,
              status: "IN_USE",
              note: `Tự tạo từ nhận hàng ${order.code}`,
            },
          });
        }
      }

      const remainingLines = await tx.purchaseOrderLine.findMany({ where: { orderId: order.id } });
      const completed = remainingLines.every((line) => line.receivedQuantity >= line.orderedQuantity);
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: completed ? "COMPLETED" : "PARTIALLY_RECEIVED" } });
      const payable = await tx.supplierPayable.findUnique({ where: { purchaseOrderId: order.id } });
      await tx.supplierPayable.upsert({
        where: { purchaseOrderId: order.id },
        create: { purchaseOrderId: order.id, supplierCode: order.supplierCode, supplierName: order.supplierName, recognizedDate: receivedDate, originalAmount: receivedValue, outstandingAmount: receivedValue },
        update: { originalAmount: (payable?.originalAmount || 0) + receivedValue, outstandingAmount: (payable?.outstandingAmount || 0) + receivedValue },
      });
      return stockTransaction;
    });

    await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "RECEIVE_ORDER", entityType: "PurchaseOrder", entityId: order.id, entityCode: order.code, branchCode: order.branchCode, metadata: { receiptId: result.id, receiptCode: result.code, lines: receiveLines.length } });
    return NextResponse.json(result);
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
