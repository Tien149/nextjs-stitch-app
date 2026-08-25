import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import type { DemoSession } from "@/lib/auth-demo";
import { writeAuditLog } from "@/lib/audit-log";
import {
  duplicatedInTrashMessage,
  findDeletedByUnique,
  softDeleteRecord,
  SoftDeleteError,
} from "@/lib/soft-delete";
import { scopePayloadByTab } from "@/lib/tab-scope";
import { nextAssetCode } from "@/lib/asset-code-generator";
import { postInventoryTransaction, nextStockDocCode } from "@/lib/inventory-stock";
import { defaultPurchaseUnit } from "@/lib/unit-conversion";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";

const menuHref = "/procurement";

/**
 * Yêu cầu mua KHÔNG còn bước duyệt (chốt với khách 26/08): bộ phận gửi phiếu là mua hàng
 * báo giá được ngay. Vì vậy phiếu chỉ khoá khi đã đi tiếp trong luồng — đã sinh PO, đã
 * hoàn tất hoặc đã bị từ chối; còn "đang chờ mua hàng xử lý" thì vẫn sửa/xoá được.
 * Bước duyệt vẫn giữ ở PO, vì đó mới là lúc chốt tiền với nhà cung cấp.
 */
const lockedRequestStatuses = ["ORDERED", "COMPLETED", "CANCELLED", "REJECTED"];
/**
 * Trạng thái yêu cầu mua mà mua hàng được phép báo giá / lập PO.
 *
 * Bỏ bước duyệt nhưng vẫn GIỮ NGUYÊN mã trạng thái "APPROVED" cho phiếu mới: mọi báo cáo,
 * màn kho và tài liệu sẵn có đều đang lọc theo mã này, đặt thêm mã mới là phải sửa hết và
 * chỉ cần sót một chỗ là phiếu biến mất khỏi báo cáo. Nay "APPROVED" đọc là "đã gửi, chờ
 * mua hàng xử lý" (approvedBy để trống vì không còn ai duyệt) — giao diện hiển thị đúng
 * nghĩa đó. PENDING_APPROVAL là phiếu cũ còn treo từ thời có bước duyệt, vẫn xử lý bình thường.
 */
const quotableRequestStatuses = ["APPROVED", "PENDING_APPROVAL", "ORDERED"];
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

/**
 * Mã chứng từ mua hàng: max + 1 trong chuỗi `PREFIX-YYYY-`, KHÔNG đếm COUNT — xoá mềm làm
 * COUNT tụt và mã cấp lại đâm chứng từ đang sống. Tra bằng SQL thô để thấy cả bản ghi đã xoá.
 */
async function generatedCode(prefix: "PR" | "PO", table: "PurchaseRequest" | "PurchaseOrder") {
  const head = `${prefix}-${new Date().getFullYear()}-`;
  const rows = table === "PurchaseRequest"
    ? await prisma.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "PurchaseRequest" WHERE "code" LIKE ${head + "%"}`
    : await prisma.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "PurchaseOrder" WHERE "code" LIKE ${head + "%"}`;
  return head + String(nextSeqFromCodes(rows.map((row) => row.code), head)).padStart(4, "0");
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

/**
 * Quyền trên mẫu yêu cầu mua hàng. Mẫu có `branchCode = null` là mẫu DÙNG CHUNG mọi cửa hàng
 * nên sửa/xoá nó ảnh hưởng toàn hệ thống — chỉ người có quyền toàn bộ cửa hàng được đụng vào.
 */
function assertTemplateBranchAccess(session: DemoSession, branchCode: string | null) {
  if (branchCode) {
    assertBranchAccess(session, branchCode);
    return;
  }
  if (!session.allowedBranches?.includes("ALL")) {
    businessError("Mẫu dùng chung cho mọi cửa hàng chỉ người quản trị toàn hệ thống mới được tạo/sửa/xoá.");
  }
}

/** Mặt hàng đưa vào mẫu phải mua được: đang hoạt động và không phải thành phẩm bán tại POS. */
async function assertTemplateItems(itemIds: string[]) {
  for (const itemId of itemIds) {
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) businessError("Mặt hàng trên mẫu không tồn tại");
    if (item.status !== "ACTIVE") businessError(`Mặt hàng ${item.code} đang ngưng hoạt động, không đưa vào mẫu mua hàng.`);
    if (item.itemType === "FINISHED") businessError(`Mặt hàng ${item.name} là Thành phẩm (FINISHED), không đưa vào mẫu mua hàng.`);
  }
}

/** Mã mẫu yêu cầu mua hàng: MAU-0001, max + 1 (đếm cả bản ghi trong thùng rác). */
async function generatedTemplateCode() {
  const head = "MAU-";
  const rows = await prisma.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "PurchaseRequestTemplate" WHERE "code" LIKE ${head + "%"}`;
  return head + String(nextSeqFromCodes(rows.map((row) => row.code), head)).padStart(4, "0");
}

type PriceSuggestion = { price: number; source: string; supplierName?: string };

/**
 * Giá đề xuất theo thứ tự ưu tiên: báo giá đang chọn -> báo giá mới nhất -> PO gần nhất
 * -> giá vốn bình quân. Dùng cho cả màn hình (GET) lẫn tạo PR từ mẫu (giá dự kiến tự điền).
 */
async function buildPriceSuggestions(itemIds?: string[]) {
  const itemFilter = itemIds && itemIds.length > 0 ? { itemId: { in: itemIds } } : {};
  const [quoteLines, orderLines, balances] = await Promise.all([
    // Quan hệ lồng không được lọc xoá mềm tự động nên lọc tay qua quote/order.
    prisma.supplierQuoteLine.findMany({
      where: { ...itemFilter, quote: { deletedAt: null } },
      select: { itemId: true, unitCost: true, quote: { select: { isSelected: true, supplierName: true } } },
      orderBy: { quote: { createdAt: "desc" } },
      take: 500,
    }),
    prisma.purchaseOrderLine.findMany({
      where: { ...itemFilter, order: { deletedAt: null } },
      select: { itemId: true, unitCost: true, order: { select: { supplierName: true } } },
      orderBy: { order: { createdAt: "desc" } },
      take: 500,
    }),
    prisma.inventoryBalance.findMany({ where: { ...itemFilter }, select: { itemId: true, averageCost: true } }),
  ]);

  const priceSuggestions: Record<string, PriceSuggestion> = {};
  for (const line of quoteLines) {
    if (line.quote.isSelected && line.unitCost > 0 && !priceSuggestions[line.itemId]) {
      priceSuggestions[line.itemId] = { price: line.unitCost, source: "SELECTED_QUOTE", supplierName: line.quote.supplierName };
    }
  }
  for (const line of quoteLines) {
    if (line.unitCost > 0 && !priceSuggestions[line.itemId]) {
      priceSuggestions[line.itemId] = { price: line.unitCost, source: "QUOTE", supplierName: line.quote.supplierName };
    }
  }
  for (const line of orderLines) {
    if (line.unitCost > 0 && !priceSuggestions[line.itemId]) {
      priceSuggestions[line.itemId] = { price: line.unitCost, source: "ORDER", supplierName: line.order.supplierName };
    }
  }
  for (const balance of balances) {
    if (balance.averageCost > 0 && !priceSuggestions[balance.itemId]) {
      priceSuggestions[balance.itemId] = { price: Math.round(balance.averageCost), source: "AVG_COST" };
    }
  }
  return priceSuggestions;
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const [items, requests, orders, departments, itemGroups, warehouses, templates, suppliers, priceSuggestions] = await Promise.all([
      // Thành phẩm (FINISHED) bán tại POS, không mua vào nên không đưa vào danh sách chọn của PR/PO.
      prisma.inventoryItem.findMany({ where: { status: "ACTIVE", itemType: { not: "FINISHED" } }, include: { unitConversions: { where: { deletedAt: null } } }, orderBy: { name: "asc" } }),
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
      prisma.masterDataItem.findMany({
        where: { type: "INVENTORY_ITEM_GROUP", status: "ACTIVE" },
        orderBy: { name: "asc" },
      }),
      prisma.masterDataItem.findMany({
        where: { type: "WAREHOUSE", status: "ACTIVE" },
        orderBy: [{ branch: "asc" }, { name: "asc" }],
      }),
      // Mẫu yêu cầu mua hàng: kèm dòng hàng + ĐVT quy đổi để màn "Đặt theo mẫu" hiển thị đúng ĐVT.
      // Chỉ trả mẫu dùng chung + mẫu của cửa hàng người dùng được phép: mẫu riêng của cửa hàng
      // khác vừa lộ danh mục hàng vừa là ngõ cụt (bấm đặt là bị chặn quyền).
      prisma.purchaseRequestTemplate.findMany({
        where: {
          status: "ACTIVE",
          ...("branchCode" in branchFilter ? { OR: [{ branchCode: null }, branchFilter] } : {}),
        },
        include: {
          lines: {
            include: { item: { include: { unitConversions: { where: { deletedAt: null }, orderBy: { conversionRate: "desc" } } } } },
            orderBy: { sortOrder: "asc" },
          },
        },
        orderBy: { name: "asc" },
      }),
      // Nhà cung cấp từ danh mục đối tác — thay cho danh sách NCC hard-code cũ trên form báo giá.
      prisma.masterDataItem.findMany({
        where: {
          type: "PARTNER",
          status: "ACTIVE",
          OR: [
            { partnerType: { in: ["SUPPLIER", "BOTH"] } },
            { partnerGroup: { in: ["SUPPLIER", "BOTH"] } },
            { group: { in: ["SUPPLIER", "BOTH"] } },
          ],
        },
        orderBy: { name: "asc" },
      }),
      buildPriceSuggestions(),
    ]);

    return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { items, requests, orders, departments, itemGroups, warehouses, templates, suppliers, priceSuggestions }));
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

      // Validate requiresImage cho từng dòng; chặn thành phẩm (FINISHED) vì không thuộc luồng mua hàng.
      for (const line of lines) {
        const item = await prisma.inventoryItem.findUnique({ where: { id: line.itemId } });
        if (item?.itemType === "FINISHED") {
          businessError(`Mặt hàng ${item.name} là Thành phẩm (FINISHED) bán tại POS, không đưa vào yêu cầu mua.`);
        }
        if (item?.requiresImage && !line.imageUrl) {
          businessError(`Mặt hàng ${item.name} yêu cầu phải có hình ảnh khi mua.`);
        }
      }

      // Mã và trạng thái do MÁY CHỦ quyết định. Nhận từ client thì người chỉ có quyền tạo có thể
      // gửi kèm status/code tuỳ ý để nhảy cóc trạng thái hoặc phá dãy mã chứng từ.
      const code = await generatedCode("PR", "PurchaseRequest");
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
          // Không còn bước duyệt: phiếu gửi lên là mua hàng báo giá được ngay.
          status: "APPROVED",
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
      // Mỗi NCC chỉ một báo giá trên một PR. Không chặn ở đây thì ràng buộc unique của database
      // ném lỗi thô và người dùng nhận "Internal Server Error" không hiểu vì sao.
      const existingQuote = await prisma.supplierQuote.findFirst({ where: { requestId, supplierCode } });
      if (existingQuote) {
        businessError(`${supplierName} đã có báo giá trên ${pr.code}. Hãy sửa báo giá đó thay vì thêm mới.`);
      }
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
        if (item.itemType === "FINISHED") {
          businessError(`Mặt hàng ${item.name} là Thành phẩm (FINISHED) bán tại POS, không đưa vào đơn mua hàng.`);
        }
        const imageUrl = line.imageUrl || sourceLine?.imageUrl || "";
        if (item.requiresImage && !imageUrl) {
          businessError(`Mặt hàng ${item.name} yêu cầu phải có hình ảnh khi tạo đơn mua hàng.`);
        }
        return { ...line, imageUrl };
      }));

      if (requestId) {
        const source = await prisma.purchaseRequest.findUnique({ where: { id: requestId } });
        if (!source) businessError("Không tìm thấy yêu cầu mua hàng nguồn");
        // Phải có quyền trên chính chi nhánh của PR nguồn, và PO không được đặt hộ chi nhánh khác:
        // thiếu hai chốt này thì người ở cửa hàng A lập PO từ PR của cửa hàng B và khoá cứng PR đó.
        assertBranchAccess(auth.session, source.branchCode);
        if (source.branchCode !== branchCode) {
          businessError(`Yêu cầu mua ${source.code} thuộc cửa hàng ${source.branchCode}, không lập được đơn mua hàng cho ${branchCode}.`);
        }
        if (!quotableRequestStatuses.includes(source.status)) {
          businessError(`Yêu cầu mua ${source.code} đang ở trạng thái ${source.status} nên không lập được đơn mua hàng.`);
        }
      }
      const sourceRequest = requestId ? await prisma.purchaseRequest.findUnique({ where: { id: requestId } }) : null;
      const departmentCode = bodyDepartmentCode || sourceRequest?.departmentCode || null;
      // Mã do máy chủ cấp, không nhận từ client (xem chú thích ở CREATE_REQUEST).
      const code = await generatedCode("PO", "PurchaseOrder");
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
            // Luôn ra bản nháp — duyệt PO là quyền riêng, không cho client tự đặt "APPROVED"
            // rồi gửi thẳng cho nhà cung cấp.
            status: "DRAFT",
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

    if (action === "CREATE_TEMPLATE") {
      const name = cleanText(body.name);
      const rawLines = Array.isArray(body.lines) ? (body.lines as Array<{ itemId?: unknown; unitCode?: unknown; note?: unknown }>) : [];
      const lines = rawLines
        .map((line) => ({ itemId: cleanText(line.itemId), unitCode: cleanText(line.unitCode) || null, note: cleanText(line.note) || null }))
        .filter((line) => line.itemId);
      if (!name || lines.length === 0) businessError("Mẫu cần tên và ít nhất một mặt hàng");
      await assertTemplateItems(lines.map((line) => line.itemId));
      const branchCode = cleanText(body.branchCode) || null;
      assertTemplateBranchAccess(auth.session, branchCode);
      const result = await prisma.purchaseRequestTemplate.create({
        data: {
          code: await generatedTemplateCode(),
          name,
          branchCode,
          departmentCode: cleanText(body.departmentCode) || null,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          lines: { create: lines.map((line, index) => ({ itemId: line.itemId, unitCode: line.unitCode, sortOrder: index, note: line.note })) },
        },
        include: { lines: { include: { item: true } }, },
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "CREATE_TEMPLATE", entityType: "PurchaseRequestTemplate", entityId: result.id, entityCode: result.code, branchCode, metadata: { name, lines: result.lines.length } });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "CREATE_REQUEST_FROM_TEMPLATE") {
      const templateId = cleanText(body.templateId);
      const branchCode = cleanText(body.branchCode);
      if (!templateId || !branchCode) businessError("Thiếu mẫu hoặc cửa hàng đặt hàng");
      assertBranchAccess(auth.session, branchCode);

      const template = await prisma.purchaseRequestTemplate.findUnique({
        where: { id: templateId },
        include: { lines: { include: { item: { include: { unitConversions: { where: { deletedAt: null } } } } }, orderBy: { sortOrder: "asc" } } },
      });
      if (!template) businessError("Không tìm thấy mẫu yêu cầu mua hàng");
      if (template.status !== "ACTIVE") businessError(`Mẫu ${template.name} đang ngưng sử dụng`);
      if (template.branchCode && template.branchCode !== branchCode) {
        businessError(`Mẫu ${template.name} chỉ dùng cho cửa hàng ${template.branchCode}`);
      }

      // Người đặt chỉ gửi (dòng mẫu, số lượng); dòng bỏ trống/0 nghĩa là không đặt.
      const requested = Array.isArray(body.lines) ? (body.lines as Array<{ lineId?: unknown; quantity?: unknown }>) : [];
      const quantities = new Map<string, number>();
      for (const row of requested) {
        const lineId = cleanText(row.lineId);
        const quantity = toNumber(row.quantity);
        if (lineId && quantity > 0) quantities.set(lineId, quantity);
      }
      if (quantities.size === 0) businessError("Chưa điền số lượng cho dòng nào của mẫu");

      const pickedLines = template.lines.filter((line) => quantities.has(line.id));
      // Số lượng gửi lên nhưng không khớp dòng nào của mẫu (mẫu vừa bị sửa/xoá dòng ở tab khác,
      // hoặc dữ liệu gửi sai) — không được tạo yêu cầu mua rỗng dòng hàng.
      if (pickedLines.length === 0) {
        businessError(`Các dòng gửi lên không còn thuộc mẫu ${template.name}. Hãy mở lại mẫu và điền số lượng.`);
      }
      // Mất một phần dòng = mẫu vừa bị sửa trong lúc người kia đang điền. Báo rõ thay vì lặng lẽ
      // tạo phiếu thiếu hàng — người đặt tưởng đã gửi đủ, đến lúc nhận mới phát hiện thiếu.
      if (pickedLines.length !== quantities.size) {
        businessError(`Mẫu ${template.name} vừa được cập nhật nên ${quantities.size - pickedLines.length} dòng bạn điền không còn tồn tại. Hãy mở lại mẫu và nhập lại để không gửi thiếu hàng.`);
      }
      const priceSuggestions = await buildPriceSuggestions(pickedLines.map((line) => line.itemId));

      const prLines = pickedLines.map((line) => {
        const orderedQuantity = quantities.get(line.id) || 0;
        // ĐVT trên mẫu (hoặc ĐVT mua mặc định) quy về ĐVT tồn kho của mặt hàng.
        // Tỷ lệ lấy qua defaultPurchaseUnit: danh mục còn nhiều dòng khai sai "1 LIT = 1000 LIT",
        // tin thẳng conversionRate là người đặt gõ 1 lít mà PR ghi 1.000 lít.
        const { unitLabel, conversionRate: rate } = defaultPurchaseUnit(line.item.unit, line.item.unitConversions, line.unitCode);
        const baseQuantity = orderedQuantity * rate;
        const suggestion = priceSuggestions[line.itemId];
        return {
          itemId: line.itemId,
          quantity: baseQuantity,
          estimatedUnitCost: suggestion?.price || 0,
          note: rate !== 1 ? `Đặt ${orderedQuantity} ${unitLabel}` : null,
        };
      });

      const departmentCode = cleanText(body.departmentCode) || template.departmentCode || null;
      const code = await generatedCode("PR", "PurchaseRequest");
      const result = await prisma.purchaseRequest.create({
        data: {
          code,
          branchCode,
          departmentCode,
          requestedBy: auth.session.name,
          requestDate: new Date(),
          neededDate: body.neededDate ? toDate(body.neededDate) : null,
          reason: cleanText(body.reason) || `Đặt hàng theo mẫu ${template.name}`,
          // Không còn bước duyệt: nhà hàng gửi mẫu là mua hàng so sánh giá được ngay.
          status: "APPROVED",
          note: cleanText(body.note) || `Theo mẫu ${template.code}`,
          lines: { create: prLines },
        },
        include: { lines: { include: { item: true } } },
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "CREATE_REQUEST_FROM_TEMPLATE", entityType: "PurchaseRequest", entityId: result.id, entityCode: result.code, branchCode, metadata: { templateId, templateCode: template.code, departmentCode, lines: result.lines.length } });
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
      // Không cho từ chối/duyệt ngược phiếu đã đi tiếp: từ chối một PR đã có PO và đã nhận hàng
      // sẽ để lại hàng trong kho + công nợ trong khi phiếu ghi "đã từ chối".
      if (lockedRequestStatuses.includes(pr.status)) {
        businessError(`Yêu cầu mua ${pr.code} đang ở trạng thái ${pr.status} nên không đổi được nữa.`);
      }
      const status = action === "APPROVE_REQUEST" ? "APPROVED" : "REJECTED";
      const result = await prisma.purchaseRequest.update({
        where: { id: requestId },
        data: { status, approvedBy: auth.session.name, approvedAt: new Date(), note: cleanText(body.note) || undefined },
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action, entityType: "PurchaseRequest", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousStatus: pr.status, status } });
      return NextResponse.json(result);
    }

    if (["CREATE_SHARE_LINK", "REVOKE_SHARE_LINK"].includes(action)) {
      // Gửi PO cho NCC là việc của người đặt hàng (Quản lý/KTTH) nên gác bằng quyền create,
      // không đòi edit — Quản lý không có edit nhưng vẫn phải gửi được phiếu.
      const auth = requireMenuAction(request, menuHref, "create");
      if (!auth.ok) return auth.response;
      const orderId = cleanText(body.orderId);
      const order = await prisma.purchaseOrder.findUnique({ where: { id: orderId } });
      if (!order) businessError("Không tìm thấy PO");
      assertBranchAccess(auth.session, order.branchCode);

      if (action === "REVOKE_SHARE_LINK") {
        const result = await prisma.purchaseOrder.update({ where: { id: orderId }, data: { shareToken: null } });
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "REVOKE_SHARE_LINK", entityType: "PurchaseOrder", entityId: order.id, entityCode: order.code, branchCode: order.branchCode });
        return NextResponse.json({ ok: true, shareToken: result.shareToken });
      }

      if (order.status === "DRAFT") businessError("PO còn nháp — duyệt PO trước khi gửi nhà cung cấp");
      // Đã có link thì trả lại link cũ để mã QR/link đã gửi NCC không bị vô hiệu.
      const shareToken = order.shareToken || randomBytes(24).toString("base64url");
      if (!order.shareToken) {
        await prisma.purchaseOrder.update({ where: { id: orderId }, data: { shareToken } });
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "CREATE_SHARE_LINK", entityType: "PurchaseOrder", entityId: order.id, entityCode: order.code, branchCode: order.branchCode });
      }
      return NextResponse.json({ ok: true, shareToken });
    }

    const auth = requireMenuAction(request, menuHref, "edit");
    if (!auth.ok) return auth.response;

    if (action === "UPDATE_TEMPLATE") {
      const templateId = cleanText(body.templateId) || cleanText(body.id);
      if (!templateId) businessError("Thiếu mẫu cần sửa");
      const template = await prisma.purchaseRequestTemplate.findUnique({ where: { id: templateId } });
      if (!template) businessError("Không tìm thấy mẫu yêu cầu mua hàng");
      // Phải có quyền trên chi nhánh HIỆN TẠI của mẫu trước đã: chỉ kiểm chi nhánh mới thì gửi
      // branchCode rỗng là sửa được mẫu của cửa hàng khác mà không qua kiểm tra nào.
      assertTemplateBranchAccess(auth.session, template.branchCode);

      const name = body.name !== undefined ? cleanText(body.name) : template.name;
      if (!name) businessError("Tên mẫu không được để trống");
      const branchCode = body.branchCode !== undefined ? (cleanText(body.branchCode) || null) : template.branchCode;
      if (branchCode !== template.branchCode) assertTemplateBranchAccess(auth.session, branchCode);

      const rawLines = body.lines !== undefined
        ? (Array.isArray(body.lines) ? (body.lines as Array<{ itemId?: unknown; unitCode?: unknown; note?: unknown }>) : [])
        : null;
      const nextLines = rawLines
        ? rawLines
            .map((line) => ({ itemId: cleanText(line.itemId), unitCode: cleanText(line.unitCode) || null, note: cleanText(line.note) || null }))
            .filter((line) => line.itemId)
        : null;
      if (nextLines && nextLines.length === 0) businessError("Mẫu cần ít nhất một mặt hàng");
      if (nextLines) await assertTemplateItems(nextLines.map((line) => line.itemId));

      const result = await prisma.$transaction(async (tx) => {
        if (nextLines) {
          await tx.purchaseRequestTemplateLine.deleteMany({ where: { templateId } });
          await tx.purchaseRequestTemplateLine.createMany({
            data: nextLines.map((line, index) => ({ templateId, itemId: line.itemId, unitCode: line.unitCode, sortOrder: index, note: line.note })),
          });
        }
        return tx.purchaseRequestTemplate.update({
          where: { id: templateId },
          data: {
            name,
            branchCode,
            ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || null } : {}),
            ...(body.status !== undefined ? { status: cleanText(body.status) || "ACTIVE" } : {}),
            ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
          },
          include: { lines: { include: { item: true } } },
        });
      });
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "UPDATE_TEMPLATE", entityType: "PurchaseRequestTemplate", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { changedFields: Object.keys(body).filter((field) => field !== "action" && field !== "templateId"), lines: result.lines.length } });
      return NextResponse.json(result);
    }

    if (action === "UPDATE_REQUEST") {
      const requestId = cleanText(body.requestId) || cleanText(body.id);
      if (!requestId) businessError("Thiếu PR cần sửa");
      const pr = await prisma.purchaseRequest.findUnique({
        where: { id: requestId },
        include: { orders: true, quotes: true },
      });
      if (!pr) businessError("Không tìm thấy yêu cầu mua hàng");
      assertBranchAccess(auth.session, pr.branchCode);
      if (lockedRequestStatuses.includes(pr.status)) {
        businessError(`Đề nghị mua hàng ${pr.code} đang ở trạng thái ${pr.status} nên không thể sửa.`);
      }
      if (pr.orders.length > 0) {
        businessError(`Đề nghị mua hàng ${pr.code} đã sinh đơn mua hàng nên không thể sửa.`);
      }
      // Sửa dòng hàng sau khi đã có báo giá sẽ làm báo giá treo theo mặt hàng không còn được
      // yêu cầu nữa (so sánh giá lệch, tạo PO ra sai). Bỏ báo giá trước rồi hãy sửa.
      if (pr.quotes.length > 0) {
        businessError(`Đề nghị mua hàng ${pr.code} đã có ${pr.quotes.length} báo giá nhà cung cấp nên không thể sửa. Hãy xoá báo giá ở tab So sánh giá trước.`);
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
            // Chỉ nhận đúng những trạng thái hợp lệ của luồng, không nhận chuỗi tuỳ ý từ client
            // (gán "XYZ" là phiếu rơi ra ngoài mọi bộ lọc, hiện trên màn hình mà không xử lý được).
            ...(body.status !== undefined && quotableRequestStatuses.includes(cleanText(body.status))
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

    /**
     * Khớp số lượng nhận theo ID DÒNG PO, không theo mặt hàng: một PO có thể có hai dòng cùng
     * mặt hàng (hai mức giá), khớp theo itemId là cả hai dòng cùng nhận -> tồn kho và công nợ
     * gấp đôi. Dòng người dùng cố tình để 0 (giao thiếu) phải hiểu là KHÔNG nhận, chứ không
     * được rơi vào nhánh mặc định "nhận hết phần còn lại".
     */
    const hasLinePayload = Array.isArray(body.lines) && body.lines.length > 0;
    const requestedByLineId = new Map<string, number>();
    const requestedByItemId = new Map<string, number>();
    if (hasLinePayload) {
      for (const row of body.lines as Array<{ lineId?: unknown; id?: unknown; itemId?: unknown; quantity?: unknown }>) {
        const quantity = toNumber(row.quantity);
        if (!(quantity >= 0)) continue;
        const lineId = cleanText(row.lineId) || cleanText(row.id);
        if (lineId) requestedByLineId.set(lineId, quantity);
        else {
          const itemId = cleanText(row.itemId);
          // Payload cũ chỉ có itemId: cộng dồn để hai dòng cùng mặt hàng không nhân đôi.
          if (itemId) requestedByItemId.set(itemId, (requestedByItemId.get(itemId) || 0) + quantity);
        }
      }
    }

    // Dòng cuối cùng của mỗi mặt hàng nhận nốt phần dư, để số gửi vượt vẫn chạm được chốt chặn
    // "nhận vượt số đã đặt" bên dưới thay vì bị âm thầm cắt bớt.
    const lastLineIdOfItem = new Map<string, string>();
    for (const line of order.lines) lastLineIdOfItem.set(line.itemId, line.id);

    const receiveLines = order.lines.map((line) => {
      const remaining = line.orderedQuantity - line.receivedQuantity;
      if (!hasLinePayload) return { ...line, receiveQuantity: remaining };
      if (requestedByLineId.has(line.id)) return { ...line, receiveQuantity: requestedByLineId.get(line.id) as number };
      if (requestedByItemId.has(line.itemId)) {
        const left = requestedByItemId.get(line.itemId) as number;
        const take = lastLineIdOfItem.get(line.itemId) === line.id ? left : Math.min(remaining, left);
        requestedByItemId.set(line.itemId, left - take);
        return { ...line, receiveQuantity: take };
      }
      // Có gửi danh sách dòng mà dòng này không nằm trong đó = không nhận dòng này.
      return { ...line, receiveQuantity: 0 };
    }).filter((line) => line.receiveQuantity > 0);
    if (receiveLines.length === 0) businessError("Không có số lượng cần nhận");
    for (const line of receiveLines) {
      if (line.receiveQuantity > line.orderedQuantity - line.receivedQuantity) businessError("Số lượng nhận vượt số lượng còn lại của PO");
    }
    if (receiveLines.some((line) => ["TOOL", "ASSET"].includes(line.item.itemType)) && !order.departmentCode) {
      businessError("PO có Tài sản/CCDC phải chọn Phòng ban để hệ thống tự sinh mã");
    }

    // CCDC/Tài sản KHÔNG vào tồn kho — trước đây vừa cộng tồn vừa tạo hồ sơ tài sản, cùng một
    // cái máy nằm ở hai sổ và giá trị bị đếm đôi; kiểm kê kho lại từ chối loại này nên phần tồn
    // đó vĩnh viễn không điều chỉnh được. Sổ tài sản là sổ gốc duy nhất cho TOOL/ASSET.
    const stockLines = receiveLines.filter((line) => !["TOOL", "ASSET"].includes(line.item.itemType));
    const assetLines = receiveLines.filter((line) => ["TOOL", "ASSET"].includes(line.item.itemType));
    const freeStockLine = stockLines.find((line) => line.unitCost <= 0);
    if (freeStockLine) {
      // Nhập mua giá 0 kéo giá vốn bình quân về sai — hàng tặng kèm thì sửa đơn giá PO
      // thành giá trị hợp lý hoặc nhận bằng phiếu "Nhập khác" có ghi chú.
      businessError(`Dòng ${freeStockLine.item.code} có đơn giá 0. Nhập mua bắt buộc có đơn giá; hàng tặng kèm hãy nhận bằng phiếu Nhập khác.`);
    }

    const result = await prisma.$transaction(async (tx) => {
      // Đi qua đúng engine kho (postInventoryTransaction): mã loại chuẩn NHAP_MUA để lên báo cáo
      // thẻ kho (báo cáo lọc NHAP_*/XUAT_* — mã "RECEIPT" cũ làm phiếu nhận PO vô hình và tồn
      // đầu kỳ bị tính ngược sai), kèm khoá dòng tồn và kiểm tra mặt hàng ngưng hoạt động.
      const stockTransaction = stockLines.length > 0
        ? await postInventoryTransaction(tx, {
            code: await nextStockDocCode(tx, "NM", receivedDate),
            transactionType: "NHAP_MUA",
            transactionDate: receivedDate,
            branchCode: order.branchCode,
            warehouseCode: order.warehouseCode,
            referenceType: "PURCHASE_ORDER",
            referenceId: order.id,
            referenceCode: order.code,
            partnerCode: order.supplierCode || null,
            note: cleanText(body.note) || `Nhận hàng từ ${order.code}`,
            createdBy: auth.session.name,
            lines: stockLines.map((line) => ({ itemId: line.itemId, inputQuantity: line.receiveQuantity, inputUnitCost: line.unitCost })),
          })
        : null;

      let receivedValue = 0;
      for (const line of receiveLines) {
        await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQuantity: { increment: line.receiveQuantity } } });
        // Công nợ phải trả tính trên MỌI dòng đã nhận — tài sản vẫn là tiền phải trả NCC.
        receivedValue += line.receiveQuantity * line.unitCost;
      }
      for (const line of assetLines) {
        const receivedLineValue = line.receiveQuantity * line.unitCost;
        const assetGroup = assetGroupFromItemType(line.item.itemType);
        await tx.assetRecord.create({
          data: {
            code: await nextAssetCode(tx, assetGroup, order.departmentCode || ""),
            name: line.item.name,
            branchCode: order.branchCode,
            departmentCode: order.departmentCode || null,
            assetGroup,
            imageUrl: line.imageUrl || null,
            location: order.warehouseCode,
            quantity: line.receiveQuantity,
            purchaseDate: receivedDate,
            originalCost: receivedLineValue,
            currentValue: receivedLineValue,
            supplierCode: order.supplierCode,
            supplierName: order.supplierName,
            sourcePurchaseOrderId: order.id,
            sourceReceiptId: stockTransaction?.id || null,
            status: "IN_USE",
            note: `Tự tạo từ nhận hàng ${order.code}`,
          },
        });
      }

      const remainingLines = await tx.purchaseOrderLine.findMany({ where: { orderId: order.id } });
      const completed = remainingLines.every((line) => line.receivedQuantity >= line.orderedQuantity);
      await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: completed ? "COMPLETED" : "PARTIALLY_RECEIVED" } });
      // Cộng dồn bằng `increment` chứ không đọc-rồi-ghi: hai lần nhận hàng chạy song song mà
      // đọc cùng số cũ thì một khoản công nợ bị nuốt mất (lost update).
      await tx.supplierPayable.upsert({
        where: { purchaseOrderId: order.id },
        create: { purchaseOrderId: order.id, supplierCode: order.supplierCode, supplierName: order.supplierName, recognizedDate: receivedDate, originalAmount: receivedValue, outstandingAmount: receivedValue },
        update: { originalAmount: { increment: receivedValue }, outstandingAmount: { increment: receivedValue } },
      });
      return { stockTransaction, assetsCreated: assetLines.length };
    });

    await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "RECEIVE_ORDER", entityType: "PurchaseOrder", entityId: order.id, entityCode: order.code, branchCode: order.branchCode, metadata: { receiptId: result.stockTransaction?.id || null, receiptCode: result.stockTransaction?.code || null, assetsCreated: result.assetsCreated, lines: receiveLines.length } });
    // Trả cả phiếu kho lẫn số tài sản/CCDC đã tạo để màn hình báo đúng "hàng đi đâu".
    return NextResponse.json({
      stockTransaction: result.stockTransaction,
      receiptCode: result.stockTransaction?.code || null,
      assetsCreated: result.assetsCreated,
    });
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
      if (lockedRequestStatuses.includes(pr.status)) {
        businessError(`Đề nghị mua hàng ${pr.code} đang ở trạng thái ${pr.status} nên không thể xoá.`);
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
      const deleted = await softDeleteRecord({ model: "PurchaseOrder", id, session: auth.session, reason });
      // Trả yêu cầu mua nguồn về trạng thái chờ mua hàng: lập PO đã đẩy nó sang ORDERED (khoá
      // sửa/xoá), xoá PO mà không trả lại thì phiếu kẹt vĩnh viễn dù không còn đơn nào.
      if (order.requestId) {
        const siblings = await prisma.purchaseOrder.count({ where: { requestId: order.requestId } });
        if (siblings === 0) {
          await prisma.purchaseRequest.updateMany({ where: { id: order.requestId, status: "ORDERED" }, data: { status: "APPROVED" } });
        }
      }
      return NextResponse.json(deleted);
    }

    if (["TEMPLATE", "PURCHASE_REQUEST_TEMPLATE", "PURCHASEREQUESTTEMPLATE"].includes(type)) {
      const template = await prisma.purchaseRequestTemplate.findUnique({ where: { id } });
      if (!template) businessError("Không tìm thấy mẫu yêu cầu mua hàng");
      assertTemplateBranchAccess(auth.session, template.branchCode);
      return NextResponse.json(await softDeleteRecord({ model: "PurchaseRequestTemplate", id, session: auth.session, reason }));
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

    return businessError(`Loại chứng từ "${type || "(trống)"}" không được hỗ trợ. Dùng type=REQUEST, ORDER, QUOTE hoặc TEMPLATE.`);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
