import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { writeAuditLog } from "@/lib/audit-log";
import {
  duplicatedInTrashMessage,
  findDeletedByUnique,
  softDeleteRecord,
  SoftDeleteError,
} from "@/lib/soft-delete";

const menuHref = "/procurement";

/** PR đã chốt thì không cho sửa/xoá nữa. */
const lockedRequestStatuses = ["APPROVED", "ORDERED", "COMPLETED", "CANCELLED"];
/** PO chỉ còn sửa/xoá được khi đang ở trạng thái nháp. */
const lockedOrderStatuses = ["APPROVED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"];

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

/**
 * Chuẩn hoá dòng hàng khi SỬA: báo lỗi rõ ràng thay vì lặng lẽ bỏ dòng sai như `validLines`.
 */
function editableLines(value: unknown) {
  if (!Array.isArray(value)) businessError("Danh sách mặt hàng không hợp lệ");
  const lines = (value as InputLine[]).map((line) => ({
    itemId: cleanText(line.itemId),
    quantity: toNumber(line.quantity),
    unitCost: toNumber(line.unitCost ?? line.estimatedUnitCost),
    imageUrl: cleanText(line.imageUrl),
    note: cleanText(line.note),
  }));
  if (lines.length === 0) businessError("Cần ít nhất một mặt hàng");
  for (const line of lines) {
    if (!line.itemId) businessError("Mặt hàng là bắt buộc trên từng dòng");
    if (!(line.quantity > 0)) businessError("Số lượng trên từng dòng phải lớn hơn 0");
    if (line.unitCost < 0) businessError("Đơn giá không được âm");
  }
  return lines;
}

async function assertImageRequirement(lines: { itemId: string; imageUrl: string }[]) {
  for (const line of lines) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: line.itemId } });
    if (!item) businessError("Mặt hàng trên chứng từ không tồn tại");
    if (item.requiresImage && !line.imageUrl) {
      businessError(`Mặt hàng ${item.name} yêu cầu phải có hình ảnh khi mua.`);
    }
  }
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
      if (await findDeletedByUnique("PurchaseRequest", { code })) {
        businessError(duplicatedInTrashMessage(code, "Đề nghị mua hàng"));
      }
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
      if (await findDeletedByUnique("SupplierQuote", { requestId, supplierCode })) {
        businessError(duplicatedInTrashMessage(supplierCode, `Báo giá của ${supplierName} trên ${pr.code}`));
      }
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
          lines: {
            create: lines.map((line) => ({
              itemId: line.itemId,
              quantity: line.quantity,
              unitCost: line.unitCost,
              totalCost: line.quantity * line.unitCost,
            })),
          },
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
      if (await findDeletedByUnique("PurchaseOrder", { code })) {
        businessError(duplicatedInTrashMessage(code, "Đơn mua hàng"));
      }
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

    if (action === "UPDATE_REQUEST") {
      const requestId = cleanText(body.requestId) || cleanText(body.id);
      if (!requestId) businessError("Thiếu PR cần sửa");
      const pr = await prisma.purchaseRequest.findUnique({
        where: { id: requestId },
        include: { orders: true },
      });
      if (!pr) businessError("Không tìm thấy yêu cầu mua hàng");
      assertBranchAccess(auth.session, pr.branchCode);
      if (pr.approvedAt || lockedRequestStatuses.includes(pr.status)) {
        businessError(`Đề nghị mua hàng ${pr.code} đã được duyệt/chốt nên không thể sửa.`);
      }
      if (pr.orders.length > 0) {
        businessError(`Đề nghị mua hàng ${pr.code} đã sinh đơn mua hàng nên không thể sửa.`);
      }

      const branchCode = body.branchCode !== undefined ? cleanText(body.branchCode) : pr.branchCode;
      if (!branchCode) businessError("Chi nhánh không được để trống");
      if (branchCode !== pr.branchCode) assertBranchAccess(auth.session, branchCode);
      const reason = body.reason !== undefined ? cleanText(body.reason) : pr.reason;
      if (!reason) businessError("Lý do đề nghị không được để trống");

      const nextLines = body.lines !== undefined ? editableLines(body.lines) : null;
      if (nextLines) await assertImageRequirement(nextLines);

      const result = await prisma.$transaction(async (tx) => {
        if (nextLines) {
          await tx.purchaseRequestLine.deleteMany({ where: { requestId } });
          await tx.purchaseRequestLine.createMany({
            data: nextLines.map((line) => ({
              requestId,
              itemId: line.itemId,
              quantity: line.quantity,
              estimatedUnitCost: line.unitCost,
              imageUrl: line.imageUrl || null,
              note: line.note || null,
            })),
          });
        }
        return tx.purchaseRequest.update({
          where: { id: requestId },
          data: {
            branchCode,
            reason,
            ...(body.departmentCode !== undefined || body.department !== undefined
              ? { departmentCode: cleanText(body.departmentCode) || cleanText(body.department) || null }
              : {}),
            ...(body.requestDate !== undefined ? { requestDate: toDate(body.requestDate) } : {}),
            ...(body.neededDate !== undefined ? { neededDate: body.neededDate ? toDate(body.neededDate) : null } : {}),
            ...(body.status !== undefined && !lockedRequestStatuses.includes(cleanText(body.status))
              ? { status: cleanText(body.status) }
              : {}),
            ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
          },
          include: { lines: { include: { item: true } } },
        });
      });

      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "UPDATE_REQUEST", entityType: "PurchaseRequest", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { changedFields: Object.keys(body).filter((field) => field !== "action" && field !== "requestId"), lines: result.lines.length } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_ORDER") {
      const orderId = cleanText(body.orderId) || cleanText(body.id);
      if (!orderId) businessError("Thiếu PO cần sửa");
      const order = await prisma.purchaseOrder.findUnique({
        where: { id: orderId },
        include: { lines: true, payable: true },
      });
      if (!order) businessError("Không tìm thấy PO");
      assertBranchAccess(auth.session, order.branchCode);
      if (order.approvedAt || lockedOrderStatuses.includes(order.status)) {
        businessError(`Đơn mua hàng ${order.code} đã được duyệt nên không thể sửa. Hãy tạo đơn điều chỉnh mới.`);
      }
      if (order.lines.some((line) => line.receivedQuantity > 0)) {
        businessError(`Đơn mua hàng ${order.code} đã nhận hàng nên không thể sửa.`);
      }
      if (order.payable) {
        businessError(`Đơn mua hàng ${order.code} đã sinh công nợ phải trả nhà cung cấp nên không thể sửa.`);
      }

      const branchCode = body.branchCode !== undefined ? cleanText(body.branchCode) : order.branchCode;
      if (!branchCode) businessError("Chi nhánh không được để trống");
      if (branchCode !== order.branchCode) assertBranchAccess(auth.session, branchCode);
      const supplierCode = body.supplierCode !== undefined ? cleanText(body.supplierCode) : order.supplierCode;
      const supplierName = body.supplierName !== undefined ? cleanText(body.supplierName) : order.supplierName;
      if (!supplierCode || !supplierName) businessError("Nhà cung cấp không được để trống");
      const warehouseCode = body.warehouseCode !== undefined ? cleanText(body.warehouseCode) : order.warehouseCode;
      if (!warehouseCode) businessError("Kho nhận không được để trống");
      if (warehouseCode !== order.warehouseCode || branchCode !== order.branchCode) {
        const warehouse = await prisma.masterDataItem.findFirst({
          where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode },
        });
        if (!warehouse) businessError(`Kho ${warehouseCode} không thuộc chi nhánh ${branchCode}.`);
      }

      const nextLines = body.lines !== undefined ? editableLines(body.lines) : null;
      if (nextLines) await assertImageRequirement(nextLines);
      const totalAmount = nextLines
        ? nextLines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0)
        : order.totalAmount;

      const result = await prisma.$transaction(async (tx) => {
        if (nextLines) {
          await tx.purchaseOrderLine.deleteMany({ where: { orderId } });
          await tx.purchaseOrderLine.createMany({
            data: nextLines.map((line) => ({
              orderId,
              itemId: line.itemId,
              orderedQuantity: line.quantity,
              unitCost: line.unitCost,
              totalCost: line.quantity * line.unitCost,
              imageUrl: line.imageUrl || null,
            })),
          });
        }
        return tx.purchaseOrder.update({
          where: { id: orderId },
          data: {
            branchCode,
            supplierCode,
            supplierName,
            warehouseCode,
            totalAmount,
            ...(body.departmentCode !== undefined || body.department !== undefined
              ? { departmentCode: cleanText(body.departmentCode) || cleanText(body.department) || null }
              : {}),
            ...(body.orderDate !== undefined ? { orderDate: toDate(body.orderDate) } : {}),
            ...(body.expectedDate !== undefined ? { expectedDate: body.expectedDate ? toDate(body.expectedDate) : null } : {}),
            ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
          },
          include: { lines: { include: { item: true } } },
        });
      });

      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "UPDATE_ORDER", entityType: "PurchaseOrder", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { changedFields: Object.keys(body).filter((field) => field !== "action" && field !== "orderId"), totalAmount, lines: result.lines.length } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_QUOTE") {
      const quoteId = cleanText(body.quoteId) || cleanText(body.id);
      if (!quoteId) businessError("Thiếu báo giá cần sửa");
      const quote = await prisma.supplierQuote.findUnique({
        where: { id: quoteId },
        include: { request: { include: { orders: true } } },
      });
      if (!quote) businessError("Không tìm thấy báo giá");
      assertBranchAccess(auth.session, quote.request.branchCode);
      if (quote.isSelected) {
        businessError(`Báo giá của ${quote.supplierName} đã được chọn nên không thể sửa. Hãy bỏ chọn trước khi cập nhật.`);
      }
      if (quote.request.orders.length > 0 || lockedRequestStatuses.includes(quote.request.status)) {
        businessError(`Đề nghị mua hàng ${quote.request.code} đã chốt nên không thể sửa báo giá.`);
      }

      const supplierName = body.supplierName !== undefined ? cleanText(body.supplierName) : quote.supplierName;
      if (!supplierName) businessError("Tên nhà cung cấp không được để trống");
      const deliveryDays = body.deliveryDays !== undefined ? toNumber(body.deliveryDays) : null;
      if (body.deliveryDays !== undefined && deliveryDays !== null && deliveryDays < 0) {
        businessError("Số ngày giao hàng không được âm");
      }

      const nextLines = body.lines !== undefined ? editableLines(body.lines) : null;
      const totalAmount = nextLines
        ? nextLines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0)
        : quote.totalAmount;

      const result = await prisma.$transaction(async (tx) => {
        if (nextLines) {
          await tx.supplierQuoteLine.deleteMany({ where: { quoteId } });
          await tx.supplierQuoteLine.createMany({
            data: nextLines.map((line) => ({
              quoteId,
              itemId: line.itemId,
              quantity: line.quantity,
              unitCost: line.unitCost,
              totalCost: line.quantity * line.unitCost,
            })),
          });
        }
        return tx.supplierQuote.update({
          where: { id: quoteId },
          data: {
            supplierName,
            totalAmount,
            ...(body.quotationDate !== undefined ? { quotationDate: toDate(body.quotationDate) } : {}),
            ...(body.deliveryDays !== undefined ? { deliveryDays: deliveryDays || null } : {}),
            ...(body.paymentTerms !== undefined ? { paymentTerms: cleanText(body.paymentTerms) || null } : {}),
            ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
          },
          include: { lines: { include: { item: true } } },
        });
      });

      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "UPDATE_QUOTE", entityType: "SupplierQuote", entityId: result.id, entityCode: result.supplierCode, branchCode: quote.request.branchCode, metadata: { requestId: quote.requestId, totalAmount, lines: result.lines.length } });
      return NextResponse.json(result);
    }

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

/**
 * Xoá mềm chứng từ mua hàng.
 * query: ?type=REQUEST|ORDER|QUOTE&id=<id>&reason=<lý do>
 */
export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const type = (cleanText(searchParams.get("type")) || cleanText(searchParams.get("entity"))).toUpperCase();
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id) businessError("Thiếu ID chứng từ cần xoá");

    if (["REQUEST", "PR", "PURCHASE_REQUEST", "PURCHASEREQUEST"].includes(type)) {
      const pr = await prisma.purchaseRequest.findUnique({
        where: { id },
        include: { orders: true },
      });
      if (!pr) businessError("Không tìm thấy đề nghị mua hàng");
      assertBranchAccess(auth.session, pr.branchCode);
      if (pr.approvedAt || lockedRequestStatuses.includes(pr.status)) {
        businessError(`Đề nghị mua hàng ${pr.code} đã được duyệt/chốt nên không thể xoá.`);
      }
      if (pr.orders.length > 0) {
        businessError(`Đề nghị mua hàng ${pr.code} đã sinh ${pr.orders.length} đơn mua hàng nên không thể xoá. Hãy xoá đơn mua hàng trước.`);
      }
      return NextResponse.json(await softDeleteRecord({ model: "PurchaseRequest", id, session: auth.session, reason }));
    }

    if (["ORDER", "PO", "PURCHASE_ORDER", "PURCHASEORDER"].includes(type)) {
      const order = await prisma.purchaseOrder.findUnique({
        where: { id },
        include: { lines: true, payable: true },
      });
      if (!order) businessError("Không tìm thấy đơn mua hàng");
      assertBranchAccess(auth.session, order.branchCode);
      if (order.approvedAt || lockedOrderStatuses.includes(order.status)) {
        businessError(`Đơn mua hàng ${order.code} đã được duyệt nên không thể xoá.`);
      }
      const receivedQuantity = order.lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
      if (receivedQuantity > 0) {
        businessError(`Đơn mua hàng ${order.code} đã nhận hàng vào kho nên không thể xoá. Hãy lập phiếu xuất trả hàng thay vì xoá.`);
      }
      if (order.payable) {
        businessError(`Đơn mua hàng ${order.code} đã sinh công nợ phải trả nhà cung cấp nên không thể xoá. Hãy tất toán công nợ trước.`);
      }
      return NextResponse.json(await softDeleteRecord({ model: "PurchaseOrder", id, session: auth.session, reason }));
    }

    if (["QUOTE", "SUPPLIER_QUOTE", "SUPPLIERQUOTE"].includes(type)) {
      const quote = await prisma.supplierQuote.findUnique({
        where: { id },
        include: { request: { include: { orders: true } } },
      });
      if (!quote) businessError("Không tìm thấy báo giá nhà cung cấp");
      assertBranchAccess(auth.session, quote.request.branchCode);
      if (quote.isSelected) {
        businessError(`Báo giá của ${quote.supplierName} đang được chọn cho ${quote.request.code} nên không thể xoá. Hãy chọn báo giá khác trước.`);
      }
      if (quote.request.orders.length > 0 || lockedRequestStatuses.includes(quote.request.status)) {
        businessError(`Đề nghị mua hàng ${quote.request.code} đã chốt nên không thể xoá báo giá kèm theo.`);
      }
      return NextResponse.json(await softDeleteRecord({ model: "SupplierQuote", id, session: auth.session, reason }));
    }

    return businessError(`Loại chứng từ "${type || "(trống)"}" không được hỗ trợ. Dùng type=REQUEST, ORDER hoặc QUOTE.`);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
