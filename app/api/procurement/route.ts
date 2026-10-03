import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import type { DemoSession } from "@/lib/auth-demo";
import { writeAuditLog } from "@/lib/audit-log";
import { resolveAssetGroupForReceive } from "@/lib/asset-group-rules";
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
import { parseVatRate } from "@/lib/inventory-vat";
import { buildPriceImport, type PriceImportItem } from "@/lib/supplier-price-list";
import { findPriceDeviations, loadActivePrices, loadPriceLists, savePriceList } from "@/lib/supplier-price-list-db";
import { buildTemplateImport, templateDayToDate, templateWindow, templateWindowStatus, type TemplateImportItem } from "@/lib/purchase-template";
import { vnDay } from "@/lib/recipe-validity";

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
/**
 * Đơn mua hàng CÒN HIỆU LỰC của một yêu cầu mua. `include` quan hệ không tự lọc xoá mềm
 * (xem lib/prisma.ts), nên trước đây PO đã xoá vào Thùng rác vẫn bị đếm và khoá cứng báo giá
 * lẫn yêu cầu mua. PO đã huỷ cũng không còn giữ PR.
 */
const liveOrdersWhere = { deletedAt: null, status: { not: "CANCELLED" } };

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
/**
 * Bảng giá riêng một cửa hàng: người lập phải có quyền cửa hàng đó. Bảng giá chung (để trống
 * cửa hàng) áp cho mọi nơi nên chỉ người có quyền tất cả cửa hàng mới lập được.
 */
function assertPriceListBranch(session: DemoSession, branchCode: string | null) {
  if (branchCode) {
    assertBranchAccess(session, branchCode);
    return;
  }
  if (!session.allowedBranches?.includes("ALL")) {
    businessError("Bảng giá chung (mọi cửa hàng) cần quyền tất cả cửa hàng — hãy chọn cửa hàng cụ thể.");
  }
}

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
 * Thuế suất từng dòng báo giá (khách yêu cầu 03/10/2026), khoá itemId. Ô trống = KKKNT (null);
 * gõ sai thì báo lỗi thay vì lặng lẽ coi là không thuế.
 */
function quoteVatRates(value: unknown) {
  const rates = new Map<string, number | null>();
  if (!Array.isArray(value)) return rates;
  for (const line of value as Array<Record<string, unknown>>) {
    const itemId = cleanText(line.itemId);
    if (!itemId) continue;
    const vat = parseVatRate(line.vatRate);
    if (!vat.ok) businessError(`Thuế suất "${String(line.vatRate)}" không hợp lệ (KKKNT, 0%, 5%, 8%, 10%)`);
    rates.set(itemId, vat.rate);
  }
  return rates;
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

/** Ngày áp dụng / kết thúc của mẫu từ body ("" = để trống); kiểm kết thúc không trước áp dụng. */
function templateEffectiveDates(body: Record<string, unknown>) {
  const effectiveFrom = templateDayToDate(cleanText(body.effectiveFrom));
  const effectiveTo = templateDayToDate(cleanText(body.effectiveTo));
  if (cleanText(body.effectiveFrom) && !effectiveFrom) businessError("Ngày áp dụng không hợp lệ");
  if (cleanText(body.effectiveTo) && !effectiveTo) businessError("Ngày kết thúc không hợp lệ");
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) businessError("Ngày kết thúc phải sau Ngày áp dụng");
  return { effectiveFrom, effectiveTo };
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

    // ---- Bảng giá NCC (khách yêu cầu 03/10/2026) ----
    const view = searchParams.get("view");
    // Danh sách yêu cầu mua có lọc (khách yêu cầu 03/10/2026): cửa hàng, phòng ban, trạng thái,
    // khoảng ngày yêu cầu. Lọc ở máy chủ vì payload chung chỉ mang 100 PR mới nhất.
    if (view === "requests") {
      const parseDay = (value: string | null, endOfDay: boolean) => {
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const start = new Date(`${value}T00:00:00+07:00`);
        return endOfDay ? new Date(start.getTime() + 86_400_000) : start;
      };
      const from = parseDay(searchParams.get("from"), false);
      const toExclusive = parseDay(searchParams.get("to"), true);
      const statusGroups: Record<string, string[]> = {
        WAITING: ["APPROVED", "PENDING_APPROVAL"],
        ORDERED: ["ORDERED"],
        COMPLETED: ["COMPLETED"],
        REJECTED: ["REJECTED"],
        CANCELLED: ["CANCELLED"],
        DRAFT: ["DRAFT"],
      };
      const statuses = statusGroups[cleanText(searchParams.get("status")).toUpperCase()];
      const departmentCode = cleanText(searchParams.get("departmentCode"));
      const requests = await prisma.purchaseRequest.findMany({
        where: {
          ...branchFilter,
          ...(departmentCode && departmentCode !== "ALL" ? (departmentCode === "NONE" ? { departmentCode: null } : { departmentCode }) : {}),
          ...(statuses ? { status: { in: statuses } } : {}),
          ...(from || toExclusive ? { requestDate: { ...(from ? { gte: from } : {}), ...(toExclusive ? { lt: toExclusive } : {}) } } : {}),
        },
        include: {
          lines: { include: { item: true } },
          quotes: { where: { deletedAt: null }, include: { lines: { include: { item: true } } }, orderBy: { totalAmount: "asc" } },
          orders: { where: liveOrdersWhere, select: { id: true, code: true, status: true } },
        },
        orderBy: { requestDate: "desc" },
        take: 2000,
      });
      return NextResponse.json({ requests, truncated: requests.length >= 2000 });
    }
    if (view === "price-lists") {
      return NextResponse.json({ priceLists: await loadPriceLists() });
    }
    // Giá đang hiệu lực của một NCC tại một ngày — form báo giá tự điền đơn giá + thuế suất.
    if (view === "active-prices") {
      const day = cleanText(searchParams.get("day")) || new Date().toISOString().slice(0, 10);
      const prices = await loadActivePrices({ day, branchCode: cleanText(searchParams.get("branchCode")) || null, supplierCode: cleanText(searchParams.get("supplierCode")) || null });
      return NextResponse.json({ prices: [...prices.values()] });
    }
    // Phiếu nhập mua trong tháng lệch bảng giá.
    if (view === "price-deviations") {
      const month = cleanText(searchParams.get("month"));
      if (!/^\d{4}-\d{2}$/.test(month)) businessError("Chọn tháng cần đối chiếu");
      const scoped = branchFilterForSession(auth.session, cleanText(searchParams.get("branchCode")) || "ALL") as { branchCode?: string | { in: string[] } };
      const branchCodes = !scoped.branchCode ? null : typeof scoped.branchCode === "string" ? [scoped.branchCode] : scoped.branchCode.in;
      return NextResponse.json(await findPriceDeviations({ month, supplierCode: cleanText(searchParams.get("supplierCode")) || null, branchCodes }));
    }

    const [items, requests, orders, departments, itemGroups, warehouses, assetGroups, templates, suppliers, priceSuggestions] = await Promise.all([
      // Thành phẩm (FINISHED) bán tại POS, không mua vào nên không đưa vào danh sách chọn của PR/PO.
      prisma.inventoryItem.findMany({ where: { status: "ACTIVE", itemType: { not: "FINISHED" } }, include: { unitConversions: { where: { deletedAt: null } } }, orderBy: { name: "asc" } }),
      prisma.purchaseRequest.findMany({
        where: { ...branchFilter },
        include: {
          lines: { include: { item: true } },
          quotes: { where: { deletedAt: null }, include: { lines: { include: { item: true } } }, orderBy: { totalAmount: "asc" } },
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
      // Nhóm tài sản: form nhận hàng phải cho chọn nhóm cho dòng Tài sản/CCDC.
      prisma.masterDataItem.findMany({
        where: { type: "ASSET_GROUP", status: "ACTIVE" },
        orderBy: { name: "asc" },
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

    return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { items, requests, orders, departments, itemGroups, warehouses, assetGroups, templates, suppliers, priceSuggestions }));
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
      const vatRates = quoteVatRates(body.lines);
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
              vatRate: vatRates.get(line.itemId) ?? null,
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

    // ---- Bảng giá NCC ----
    if (action === "SAVE_PRICE_LIST") {
      const supplierCode = cleanText(body.supplierCode).toUpperCase();
      const branchCode = cleanText(body.branchCode).toUpperCase() || null;
      const from = cleanText(body.from);
      const to = cleanText(body.to) || null;
      if (!supplierCode || !/^\d{4}-\d{2}-\d{2}$/.test(from)) businessError("Bảng giá cần nhà cung cấp và ngày bắt đầu áp dụng");
      assertPriceListBranch(auth.session, branchCode);
      const supplier = await prisma.masterDataItem.findFirst({ where: { type: "PARTNER", code: { equals: supplierCode, mode: "insensitive" } }, select: { code: true, name: true } });
      if (!supplier) businessError(`Không tìm thấy nhà cung cấp ${supplierCode}`);
      const rawLines = Array.isArray(body.lines) ? (body.lines as Array<Record<string, unknown>>) : [];
      const items = await prisma.inventoryItem.findMany({
        where: { id: { in: rawLines.map((line) => cleanText(line.itemId)).filter(Boolean) } },
        include: { unitConversions: { where: { deletedAt: null } } },
      });
      const itemById = new Map(items.map((item) => [item.id, item]));
      const lines = rawLines.filter((line) => cleanText(line.itemId)).map((line, index) => {
        const item = itemById.get(cleanText(line.itemId));
        if (!item) businessError(`Dòng ${index + 1}: mặt hàng không tồn tại`);
        const unitCode = (cleanText(line.unitCode) || item.unit).toUpperCase();
        const conversion = unitCode === item.unit.toUpperCase() ? null : item.unitConversions.find((candidate) => candidate.unitCode.toUpperCase() === unitCode);
        if (unitCode !== item.unit.toUpperCase() && !conversion) businessError(`Dòng ${index + 1}: ${item.code} chưa khai ĐVT ${unitCode}`);
        const unitPrice = toNumber(line.unitPrice);
        if (!(unitPrice >= 0)) businessError(`Dòng ${index + 1}: đơn giá không hợp lệ`);
        const vat = parseVatRate(line.vatRate);
        if (!vat.ok) businessError(`Dòng ${index + 1}: thuế suất không hợp lệ`);
        return { itemId: item.id, unitCode, conversionRate: conversion?.conversionRate || 1, unitPrice, vatRate: vat.rate, note: cleanText(line.note) || null };
      });
      const duplicate = lines.find((line, index) => lines.findIndex((other) => other.itemId === line.itemId && other.unitCode === line.unitCode) !== index);
      if (duplicate) businessError(`Mặt hàng ${itemById.get(duplicate.itemId)?.code} (${duplicate.unitCode}) bị lặp trong bảng giá`);
      const saved = await savePriceList({
        id: cleanText(body.id) || null,
        supplierCode: supplier.code,
        supplierName: supplier.name,
        branchCode,
        from,
        to,
        note: cleanText(body.note) || null,
        lines,
      }, auth.session.name);
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "SAVE_PRICE_LIST", entityType: "SupplierPriceList", entityId: saved.id, entityCode: saved.code, branchCode: branchCode || "ALL", metadata: { supplierCode, from, to, lines: lines.length } });
      return NextResponse.json(saved, { status: 201 });
    }

    // Import Excel: commit=false chỉ kiểm tra (xem trước), commit=true ghi khi không còn lỗi.
    if (action === "IMPORT_PRICE_LISTS") {
      const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
      if (rows.length === 0) businessError("File không có dòng dữ liệu");
      if (rows.length > 20000) businessError("File quá lớn (tối đa 20.000 dòng)");
      const [suppliers, items, branches] = await Promise.all([
        prisma.masterDataItem.findMany({ where: { type: "PARTNER" }, select: { code: true, name: true } }),
        prisma.inventoryItem.findMany({ select: { id: true, code: true, name: true, unit: true, unitConversions: { where: { deletedAt: null }, select: { unitCode: true, conversionRate: true } } } }),
        prisma.masterDataItem.findMany({ where: { type: "BRANCH" }, select: { code: true } }),
      ]);
      const result = buildPriceImport(rows, {
        suppliers: new Map(suppliers.map((row) => [row.code.toUpperCase(), row.name])),
        items: new Map(items.map((item) => [item.code.toUpperCase(), item as PriceImportItem])),
        branches: new Set(branches.map((row) => row.code.toUpperCase())),
      });
      for (const group of result.groups) {
        try {
          assertPriceListBranch(auth.session, group.branchCode);
        } catch (error) {
          result.errors.push({ row: group.lines[0]?.row || 0, message: error instanceof Error ? error.message.replace(/^BUSINESS:/, "") : String(error) });
        }
      }
      const summary = result.groups.map((group) => ({ supplierCode: group.supplierCode, supplierName: group.supplierName, branchCode: group.branchCode, from: group.from, to: group.to, lineCount: group.lines.length }));
      if (!body.commit || result.errors.length > 0) {
        return NextResponse.json({ committed: false, groups: summary, errors: result.errors.sort((a, b) => a.row - b.row).slice(0, 500), errorCount: result.errors.length });
      }
      const saved = [];
      for (const group of result.groups) {
        saved.push(await savePriceList({ ...group, source: "IMPORT", lines: group.lines }, auth.session.name));
      }
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "IMPORT_PRICE_LISTS", entityType: "SupplierPriceList", entityId: saved[0]?.id || "", entityCode: saved.map((row) => row.code).join(", ").slice(0, 180), branchCode: "ALL", metadata: { groups: saved.length, rows: rows.length } });
      return NextResponse.json({ committed: true, groups: summary, codes: saved.map((row) => row.code), errors: [], errorCount: 0 });
    }

    // Import mẫu đặt hàng từ Excel (khách yêu cầu 03/10/2026): commit=false chỉ xem trước.
    if (action === "IMPORT_TEMPLATES") {
      const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
      if (rows.length === 0) businessError("File không có dòng dữ liệu");
      if (rows.length > 20000) businessError("File quá lớn (tối đa 20.000 dòng)");
      const [items, branches, departments, templates] = await Promise.all([
        prisma.inventoryItem.findMany({ select: { id: true, code: true, name: true, unit: true, status: true, itemType: true, unitConversions: { where: { deletedAt: null }, select: { unitCode: true } } } }),
        prisma.masterDataItem.findMany({ where: { type: "BRANCH" }, select: { code: true } }),
        prisma.masterDataItem.findMany({ where: { type: "DEPARTMENT" }, select: { code: true } }),
        prisma.purchaseRequestTemplate.findMany({ select: { id: true, code: true, name: true, branchCode: true } }),
      ]);
      const result = buildTemplateImport(rows, {
        items: new Map(items.map((item) => [item.code.toUpperCase(), item as TemplateImportItem])),
        branches: new Set(branches.map((row) => row.code.toUpperCase())),
        departments: new Set(departments.map((row) => row.code.toUpperCase())),
        templates: new Map(templates.map((row) => [row.code.toUpperCase(), row.name])),
      });
      const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
      // Mẫu mới trùng tên + cửa hàng với mẫu đang có thì ghi đè mẫu đó, không đẻ mẫu trùng.
      const resolved = result.groups.map((group) => {
        const existing = group.code
          ? templates.find((row) => row.code.toUpperCase() === group.code)
          : templates.find((row) => fold(row.name) === fold(group.name) && (row.branchCode || null) === group.branchCode);
        return { group, existing: existing || null };
      });
      for (const { group, existing } of resolved) {
        try {
          if (existing) assertTemplateBranchAccess(auth.session, existing.branchCode);
          assertTemplateBranchAccess(auth.session, group.branchCode);
        } catch (error) {
          result.errors.push({ row: group.lines[0]?.row || 0, message: error instanceof Error ? error.message.replace(/^BUSINESS:/, "") : String(error) });
        }
      }
      const summary = resolved.map(({ group, existing }) => ({ code: existing?.code || null, name: group.name, branchCode: group.branchCode, departmentCode: group.departmentCode, from: group.from, to: group.to, lineCount: group.lines.length }));
      if (!body.commit || result.errors.length > 0) {
        return NextResponse.json({ committed: false, groups: summary, errors: result.errors.sort((a, b) => a.row - b.row).slice(0, 500), errorCount: result.errors.length });
      }
      const codes: string[] = [];
      for (const { group, existing } of resolved) {
        const data = {
          name: group.name,
          branchCode: group.branchCode,
          departmentCode: group.departmentCode,
          effectiveFrom: templateDayToDate(group.from),
          effectiveTo: templateDayToDate(group.to),
        };
        const lineData = group.lines.map((line, index) => ({ itemId: line.itemId, unitCode: line.unitCode, sortOrder: index, note: line.note }));
        if (existing) {
          await prisma.$transaction(async (tx) => {
            await tx.purchaseRequestTemplateLine.deleteMany({ where: { templateId: existing.id } });
            await tx.purchaseRequestTemplate.update({ where: { id: existing.id }, data: { ...data, lines: { create: lineData } } });
          });
          codes.push(existing.code);
        } else {
          const created = await prisma.purchaseRequestTemplate.create({
            data: { ...data, code: await generatedTemplateCode(), createdBy: auth.session.name, lines: { create: lineData } },
          });
          codes.push(created.code);
        }
      }
      await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "IMPORT_TEMPLATES", entityType: "PurchaseRequestTemplate", entityId: "", entityCode: codes.join(", ").slice(0, 180), branchCode: "ALL", metadata: { templates: codes.length, rows: rows.length } });
      return NextResponse.json({ committed: true, groups: summary, codes, errors: [], errorCount: 0 });
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
          ...templateEffectiveDates(body),
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
      // Ngày áp dụng / kết thúc của mẫu tính theo ngày đặt (hôm nay, giờ VN).
      const windowStatus = templateWindowStatus(template, vnDay(new Date()));
      if (windowStatus !== "ACTIVE") {
        const window = templateWindow(template);
        businessError(windowStatus === "UPCOMING"
          ? `Mẫu ${template.name} áp dụng từ ${window.from?.split("-").reverse().join("/")} — chưa dùng để đặt hàng được.`
          : `Mẫu ${template.name} đã kết thúc ngày ${window.to?.split("-").reverse().join("/")} — chọn mẫu khác hoặc nhờ quản lý gia hạn.`);
      }
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

    if (["APPROVE_REQUEST", "REJECT_REQUEST", "SELECT_QUOTE", "UNSELECT_QUOTE", "APPROVE_ORDER", "UNAPPROVE_ORDER", "CANCEL_ORDER"].includes(action)) {
      const auth = requireMenuAction(request, menuHref, "approve");
      if (!auth.ok) return auth.response;
      /**
       * Bỏ duyệt đơn mua hàng để sửa lại.
       *
       * Duyệt PO là chốt tiền với nhà cung cấp, và UPDATE_ORDER chặn mọi đơn đã có `approvedAt`
       * — nên duyệt nhầm số lượng hay đơn giá là hết đường sửa, chỉ còn cách lập đơn mới. Bỏ
       * duyệt đưa đơn về Nháp để sửa rồi duyệt lại.
       *
       * Chỉ bỏ được khi đơn chưa đi tiếp: đã nhận hàng hay đã sinh công nợ thì con số đã lan
       * sang kho và sổ công nợ, kéo ngược về nháp sẽ để lại hàng trong kho của một đơn "chưa
       * duyệt". Link đã gửi NCC bị thu hồi vì số sắp đổi, không để họ xem bản cũ.
       */
      if (action === "UNAPPROVE_ORDER") {
        const orderId = cleanText(body.orderId) || cleanText(body.id);
        if (!orderId) businessError("Thiếu PO cần bỏ duyệt");
        const order = await prisma.purchaseOrder.findUnique({ where: { id: orderId }, include: { lines: true, payable: true } });
        if (!order) businessError("Không tìm thấy PO");
        assertBranchAccess(auth.session, order.branchCode);
        if (order.status !== "APPROVED") businessError(`Đơn mua hàng ${order.code} đang ở trạng thái ${order.status}, không phải đơn vừa duyệt nên không bỏ duyệt được.`);
        if (order.lines.some((line) => line.receivedQuantity > 0)) {
          businessError(`Đơn mua hàng ${order.code} đã nhận hàng vào kho nên không bỏ duyệt được. Hãy xoá phiếu nhập kho của đơn này trước, hoặc lập phiếu xuất trả hàng.`);
        }
        if (order.payable) {
          businessError(`Đơn mua hàng ${order.code} đã sinh công nợ phải trả nhà cung cấp nên không bỏ duyệt được. Hãy tất toán hoặc xoá công nợ trước.`);
        }
        const result = await prisma.purchaseOrder.update({
          where: { id: orderId },
          data: { status: "DRAFT", approvedBy: null, approvedAt: null, shareToken: null, note: cleanText(body.note) || undefined },
        });
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "UNAPPROVE_ORDER", entityType: "PurchaseOrder", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousStatus: order.status, approvedBy: order.approvedBy, approvedAt: order.approvedAt, shareLinkRevoked: Boolean(order.shareToken) } });
        return NextResponse.json(result);
      }
      /**
       * Huỷ đơn mua hàng (kể cả đơn đã duyệt, đã gửi NCC) khi hàng chưa về và chưa có công nợ.
       *
       * Khác xoá: đơn đã gửi nhà cung cấp thì phải còn dấu vết "đã huỷ" — link/QR đã gửi vẫn mở
       * được và hiện rõ ĐƠN ĐÃ HUỶ, để NCC không giao hàng theo phiếu cũ. Yêu cầu mua nguồn trả
       * về "chờ mua hàng" để báo giá sửa/xoá được và lập PO khác.
       */
      if (action === "CANCEL_ORDER") {
        const orderId = cleanText(body.orderId) || cleanText(body.id);
        if (!orderId) businessError("Thiếu PO cần huỷ");
        const order = await prisma.purchaseOrder.findUnique({ where: { id: orderId }, include: { lines: true, payable: true } });
        if (!order) businessError("Không tìm thấy PO");
        assertBranchAccess(auth.session, order.branchCode);
        if (!["DRAFT", "APPROVED"].includes(order.status)) {
          businessError(`Đơn mua hàng ${order.code} đang ở trạng thái ${order.status} nên không huỷ được.`);
        }
        if (order.lines.some((line) => line.receivedQuantity > 0)) {
          businessError(`Đơn mua hàng ${order.code} đã nhận hàng vào kho nên không huỷ được. Hãy xoá phiếu nhập kho của đơn này trước, hoặc lập phiếu xuất trả hàng.`);
        }
        if (order.payable) {
          businessError(`Đơn mua hàng ${order.code} đã sinh công nợ phải trả nhà cung cấp nên không huỷ được. Hãy tất toán hoặc xoá công nợ trước.`);
        }
        const reason = cleanText(body.reason);
        const result = await prisma.$transaction(async (tx) => {
          // Lý do huỷ chỉ vào nhật ký, không ghi vào ghi chú đơn: ghi chú in lên phiếu gửi NCC.
          const cancelled = await tx.purchaseOrder.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
          if (order.requestId) {
            const siblings = await tx.purchaseOrder.count({ where: { requestId: order.requestId, ...liveOrdersWhere } });
            if (siblings === 0) {
              await tx.purchaseRequest.updateMany({ where: { id: order.requestId, status: "ORDERED" }, data: { status: "APPROVED" } });
            }
          }
          return cancelled;
        });
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "CANCEL_ORDER", entityType: "PurchaseOrder", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { previousStatus: order.status, reason, sharedWithSupplier: Boolean(order.shareToken) } });
        return NextResponse.json(result);
      }
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
      /** Bỏ chốt giá — trước đây chỉ đổi được sang báo giá khác, PR một báo giá thì kẹt luôn. */
      if (action === "UNSELECT_QUOTE") {
        const quoteId = cleanText(body.quoteId);
        const quote = await prisma.supplierQuote.findUnique({ where: { id: quoteId }, include: { request: true } });
        if (!quote) businessError("Không tìm thấy báo giá");
        assertBranchAccess(auth.session, quote.request.branchCode);
        await prisma.supplierQuote.update({ where: { id: quoteId }, data: { isSelected: false } });
        await writeAuditLog({ session: auth.session, module: "PROCUREMENT", action: "UNSELECT_QUOTE", entityType: "SupplierQuote", entityId: quote.id, entityCode: quote.supplierCode, branchCode: quote.request.branchCode, metadata: { requestId: quote.requestId, supplierName: quote.supplierName } });
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
      if (order.status === "CANCELLED" && !order.shareToken) businessError(`Đơn mua hàng ${order.code} đã huỷ nên không gửi nhà cung cấp được nữa.`);
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
            ...(body.effectiveFrom !== undefined || body.effectiveTo !== undefined ? templateEffectiveDates(body) : {}),
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
        include: { orders: { where: liveOrdersWhere }, quotes: { where: { deletedAt: null } } },
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
        include: { request: { include: { orders: { where: liveOrdersWhere } } } },
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
      const vatRates = quoteVatRates(body.lines);
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
              vatRate: vatRates.get(line.itemId) ?? null,
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
    // Nhóm tài sản người nhận hàng chọn cho từng dòng Tài sản/CCDC (chỉ khớp được theo lineId).
    const requestedAssetGroupByLineId = new Map<string, string>();
    if (hasLinePayload) {
      for (const row of body.lines as Array<{ lineId?: unknown; id?: unknown; itemId?: unknown; quantity?: unknown; assetGroup?: unknown }>) {
        const quantity = toNumber(row.quantity);
        if (!(quantity >= 0)) continue;
        const lineId = cleanText(row.lineId) || cleanText(row.id);
        if (lineId && cleanText(row.assetGroup)) requestedAssetGroupByLineId.set(lineId, cleanText(row.assetGroup).toUpperCase());
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
    // Chốt Nhóm tài sản của từng dòng TRƯỚC khi vào transaction: thiếu thì dừng ngay với thông
    // báo chọn nhóm nào, chứ không cấp mã rồi mới phát hiện nhóm không có trong danh mục.
    const assetGroupCatalog = assetLines.length > 0
      ? await prisma.masterDataItem.findMany({
          where: { type: "ASSET_GROUP", status: "ACTIVE" },
          select: { code: true, name: true, group: true },
          orderBy: { code: "asc" },
        })
      : [];
    const assetGroupByLineId = new Map<string, string>();
    for (const line of assetLines) {
      const resolved = resolveAssetGroupForReceive({
        itemType: line.item.itemType,
        itemCode: line.item.code,
        requestedCode: requestedAssetGroupByLineId.get(line.id),
        catalog: assetGroupCatalog,
      });
      if (!resolved.ok) businessError(resolved.error);
      assetGroupByLineId.set(line.id, resolved.code);
    }

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
        const assetGroup = assetGroupByLineId.get(line.id) as string;
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
        include: { orders: { where: liveOrdersWhere } },
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
        const siblings = await prisma.purchaseOrder.count({ where: { requestId: order.requestId, ...liveOrdersWhere } });
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
        include: { request: { include: { orders: { where: liveOrdersWhere } } } },
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

    if (["PRICE_LIST", "SUPPLIER_PRICE_LIST", "SUPPLIERPRICELIST"].includes(type)) {
      const list = await prisma.supplierPriceList.findUnique({ where: { id } });
      if (!list) businessError("Không tìm thấy bảng giá");
      assertPriceListBranch(auth.session, list.branchCode);
      return NextResponse.json(await softDeleteRecord({ model: "SupplierPriceList", id, session: auth.session, reason }));
    }

    return businessError(`Loại chứng từ "${type || "(trống)"}" không được hỗ trợ. Dùng type=REQUEST, ORDER, QUOTE, TEMPLATE hoặc PRICE_LIST.`);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
