import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, type TxClient } from "@/lib/prisma";
import { apiError, assertPeriodOpen, businessError, cleanText, isPeriodLocked, toDate, toNumber } from "@/lib/phase3";
import { assertBranchAccess, requestedBranch } from "@/lib/accounting";
import { allowedWarehousesOf, assertWarehouseAccess } from "@/lib/warehouse-scope";
import { nextStocktakeCode } from "@/lib/inventory-stock";
import { STOCKTAKE_PENDING, isStocktakeEditable } from "@/lib/stocktake-status";
import { isLocationStocktakeItemType, resolveUnitInputs } from "@/lib/stocktake-consolidate";
import { approveStocktakeBatch, buildBatchPreview, formatVnDateTime, reopenStocktakeBatch } from "@/lib/stocktake-batch";
import { writeAuditLog } from "@/lib/audit-log";

/**
 * Kiểm kê THEO VỊ TRÍ + duyệt GỘP (khách chốt 28/09/2026) — vị trí & form mẫu, phiếu đếm từng vị
 * trí, bảng tổng hợp và duyệt / mở lại đợt. Luật nằm ở lib/stocktake-batch.ts.
 * Trả lại / xoá phiếu đếm chưa duyệt dùng chung RETURN_STOCKTAKE / DELETE của /api/inventory.
 */
const menuHref = "/inventory";

const itemSelect = {
  id: true, code: true, name: true, unit: true, itemType: true,
  unitConversions: { select: { unitCode: true, unitName: true, conversionRate: true, isDefaultPurchase: true }, orderBy: [{ isDefaultPurchase: "desc" as const }, { conversionRate: "desc" as const }] },
};

async function warehouseOfBranch(warehouseCode: string, branchCode: string) {
  const warehouse = await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: warehouseCode, branch: branchCode } });
  if (!warehouse) businessError(`Kho ${warehouseCode} không thuộc cửa hàng ${branchCode}.`);
  return warehouse;
}

function unitCostMap(value: unknown) {
  const result: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const [itemId, cost] of Object.entries(value as Record<string, unknown>)) {
      const parsed = toNumber(cost);
      if (parsed > 0) result[itemId] = parsed;
    }
  }
  return result;
}

function stocktakeIdsFrom(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map((id) => cleanText(id)).filter(Boolean))] : [];
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const branchCode = requestedBranch(auth.session, searchParams.get("branchCode") || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };
    const allowed = allowedWarehousesOf(auth.session);
    const warehouseFilter = allowed ? { warehouseCode: { in: allowed } } : {};
    const since = new Date(Date.now() - 90 * 86_400_000);

    const [locations, sheets, batches] = await Promise.all([
      prisma.stocktakeLocation.findMany({
        where: { ...branchFilter, ...warehouseFilter },
        include: { items: { orderBy: { sortOrder: "asc" }, include: { item: { select: itemSelect } } } },
        orderBy: [{ warehouseCode: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
      }),
      prisma.stocktakeSession.findMany({
        where: {
          ...branchFilter, ...warehouseFilter,
          locationCode: { not: null },
          OR: [{ status: { not: "APPROVED" } }, { updatedAt: { gte: since } }],
        },
        include: { lines: { include: { item: { select: itemSelect } } }, batch: { select: { code: true, cutoffAt: true } } },
        orderBy: { updatedAt: "desc" },
        take: 200,
      }),
      prisma.stocktakeBatch.findMany({
        where: { ...branchFilter, ...warehouseFilter, createdAt: { gte: since } },
        include: {
          lines: { include: { item: { select: { id: true, code: true, name: true, unit: true, itemType: true } } } },
          sessions: { select: { id: true, code: true, locationCode: true } },
        },
        orderBy: [{ cutoffAt: "desc" }, { createdAt: "desc" }],
        take: 30,
      }),
    ]);
    return NextResponse.json({ locations, sheets, batches });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);
    const permission = ["PREVIEW_BATCH", "APPROVE_BATCH", "REOPEN_BATCH"].includes(action)
      ? "approve"
      : action === "SAVE_SHEET" ? "create" : action === "DELETE_LOCATION" ? "delete" : "edit";
    const auth = requireMenuAction(request, menuHref, permission);
    if (!auth.ok) return auth.response;

    /**
     * Xoá vị trí + form mẫu CHƯA dùng (khách 29/10/2026). Vị trí đã có phiếu đếm thì chặn — phiếu đếm,
     * đợt duyệt, giải trình cũ còn tra theo mã vị trí; chuyển Ngưng thay vì xoá.
     */
    if (action === "DELETE_LOCATION") {
      const location = await prisma.stocktakeLocation.findUnique({ where: { id: cleanText(body.id) } });
      if (!location) businessError("Không tìm thấy vị trí kiểm kê");
      assertBranchAccess(auth.session, location!.branchCode);
      assertWarehouseAccess(auth.session, location!.warehouseCode);
      const used = await prisma.stocktakeSession.count({ where: { warehouseCode: location!.warehouseCode, locationCode: location!.code } });
      if (used > 0) businessError(`Vị trí ${location!.code} đã có ${used} phiếu đếm nên không xoá được — chuyển Trạng thái sang Ngưng để không dùng nữa.`);
      await prisma.stocktakeLocation.delete({ where: { id: location!.id } });
      await writeAuditLog({ session: auth.session, module: menuHref, action, entityType: "StocktakeLocation", entityId: location!.id, entityCode: `${location!.warehouseCode}/${location!.code}`, branchCode: location!.branchCode, metadata: { name: location!.name } });
      return NextResponse.json({ ok: true });
    }

    /** Tạo / sửa vị trí + form mẫu (danh sách mã theo thứ tự đếm). */
    if (action === "SAVE_LOCATION") {
      const id = cleanText(body.id);
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const code = cleanText(body.code).toUpperCase().replace(/\s+/g, "_");
      const name = cleanText(body.name);
      if (!branchCode || !warehouseCode || !code || !name) businessError("Vị trí cần cửa hàng, kho, mã và tên");
      assertBranchAccess(auth.session, branchCode);
      assertWarehouseAccess(auth.session, warehouseCode);
      await warehouseOfBranch(warehouseCode, branchCode);
      const itemIds = stocktakeIdsFrom(body.itemIds);
      const items = await prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, itemType: true } });
      const wrong = items.find((item) => !isLocationStocktakeItemType(item.itemType));
      if (wrong) businessError(`${wrong.code} không thuộc nhóm nguyên liệu / bao bì / hàng hóa / bán thành phẩm nên không đưa vào form mẫu kiểm kê.`);
      const known = new Set(items.map((item) => item.id));
      const duplicate = await prisma.stocktakeLocation.findFirst({ where: { warehouseCode, code, ...(id ? { id: { not: id } } : {}) } });
      if (duplicate) businessError(`Kho ${warehouseCode} đã có vị trí mã ${code}.`);
      const location = await prisma.$transaction(async (tx) => {
        const data = { branchCode, warehouseCode, code, name, sortOrder: Math.trunc(toNumber(body.sortOrder)), status: cleanText(body.status).toUpperCase() === "INACTIVE" ? "INACTIVE" : "ACTIVE", note: cleanText(body.note) || null };
        const saved = id ? await tx.stocktakeLocation.update({ where: { id }, data }) : await tx.stocktakeLocation.create({ data });
        await tx.stocktakeLocationItem.deleteMany({ where: { locationId: saved.id } });
        const ordered = itemIds.filter((itemId) => known.has(itemId));
        if (ordered.length > 0) {
          await tx.stocktakeLocationItem.createMany({ data: ordered.map((itemId, index) => ({ locationId: saved.id, itemId, sortOrder: index })) });
        }
        return saved;
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: id ? "UPDATE_STOCKTAKE_LOCATION" : "CREATE_STOCKTAKE_LOCATION", entityType: "StocktakeLocation", entityId: location.id, entityCode: `${warehouseCode}/${code}`, branchCode, metadata: { items: itemIds.length } });
      return NextResponse.json(location, { status: id ? 200 : 201 });
    }

    /**
     * Import vị trí + form mẫu của MỘT kho từ file (khách 24/10/2026: mỗi kho nhiều vị trí). Mỗi dòng
     * file = một mặt hàng của một vị trí, thứ tự dòng = thứ tự đếm. Vị trí có trong file thì GHI ĐÈ
     * danh sách mặt hàng (chưa có thì tạo mới); vị trí không có trong file giữ nguyên. Sai một dòng
     * thì không ghi gì, trả danh sách lỗi theo số dòng.
     */
    if (action === "IMPORT_LOCATIONS") {
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      if (!branchCode || !warehouseCode) businessError("Chọn cửa hàng và kho trước khi import");
      assertBranchAccess(auth.session, branchCode);
      assertWarehouseAccess(auth.session, warehouseCode);
      await warehouseOfBranch(warehouseCode, branchCode);
      const rows = (Array.isArray(body.rows) ? body.rows : []) as Array<{ row?: unknown; locationCode?: unknown; locationName?: unknown; itemCode?: unknown; sortOrder?: unknown }>;
      if (rows.length === 0) businessError("File không có dòng nào");
      if (rows.length > 10000) businessError("Tối đa 10.000 dòng mỗi lần import");
      const codes = [...new Set(rows.map((row) => cleanText(row.itemCode).toUpperCase()).filter(Boolean))];
      const items = await prisma.inventoryItem.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, itemType: true, status: true } });
      const itemByCode = new Map(items.map((item) => [item.code.toUpperCase(), item]));
      const errors: Array<{ row: number; message: string }> = [];
      const groups = new Map<string, { code: string; name: string; sortOrder: number | null; itemIds: string[] }>();
      for (const [index, row] of rows.entries()) {
        const rowNumber = Math.trunc(toNumber(row.row)) || index + 2;
        const locationCode = cleanText(row.locationCode).toUpperCase().replace(/\s+/g, "_");
        const itemCode = cleanText(row.itemCode).toUpperCase();
        if (!locationCode && !itemCode) continue;
        if (!locationCode) { errors.push({ row: rowNumber, message: "Thiếu Mã vị trí" }); continue; }
        const group = groups.get(locationCode) || { code: locationCode, name: "", sortOrder: null, itemIds: [] };
        const name = cleanText(row.locationName);
        if (name && group.name && name !== group.name) errors.push({ row: rowNumber, message: `Vị trí ${locationCode} ghi hai tên khác nhau` });
        group.name ||= name;
        if (group.sortOrder === null && cleanText(row.sortOrder)) group.sortOrder = Math.trunc(toNumber(row.sortOrder));
        groups.set(locationCode, group);
        if (!itemCode) continue;
        const item = itemByCode.get(itemCode);
        if (!item) { errors.push({ row: rowNumber, message: `Mã hàng ${itemCode} không có trong danh mục` }); continue; }
        if (!isLocationStocktakeItemType(item.itemType)) { errors.push({ row: rowNumber, message: `${itemCode} không thuộc nhóm nguyên liệu / bao bì / hàng hóa / bán thành phẩm nên không đưa vào form kiểm kê` }); continue; }
        if (group.itemIds.includes(item.id)) { errors.push({ row: rowNumber, message: `${itemCode} lặp trong vị trí ${locationCode}` }); continue; }
        group.itemIds.push(item.id);
      }
      const existing = await prisma.stocktakeLocation.findMany({ where: { warehouseCode, code: { in: [...groups.keys()] } } });
      const existingByCode = new Map(existing.map((location) => [location.code, location]));
      for (const group of groups.values()) {
        if (!group.name && !existingByCode.has(group.code)) errors.push({ row: 0, message: `Vị trí mới ${group.code} cần Tên vị trí` });
      }
      if (errors.length > 0) {
        return NextResponse.json({ error: `File có ${errors.length} lỗi — chưa ghi gì.`, errors: errors.slice(0, 200) }, { status: 400 });
      }
      let created = 0;
      await prisma.$transaction(async (tx) => {
        for (const group of groups.values()) {
          const current = existingByCode.get(group.code);
          const data = { branchCode, warehouseCode, code: group.code, name: group.name || current?.name || group.code, ...(group.sortOrder !== null ? { sortOrder: group.sortOrder } : {}) };
          const saved = current ? await tx.stocktakeLocation.update({ where: { id: current.id }, data }) : await tx.stocktakeLocation.create({ data });
          if (!current) created += 1;
          await tx.stocktakeLocationItem.deleteMany({ where: { locationId: saved.id } });
          if (group.itemIds.length > 0) {
            await tx.stocktakeLocationItem.createMany({ data: group.itemIds.map((itemId, index) => ({ locationId: saved.id, itemId, sortOrder: index })) });
          }
        }
      }, { timeout: 60000 });
      await writeAuditLog({ session: auth.session, module: menuHref, action: "IMPORT_STOCKTAKE_LOCATIONS", entityType: "StocktakeLocation", entityId: warehouseCode, entityCode: warehouseCode, branchCode, metadata: { locations: groups.size, created, rows: rows.length } });
      return NextResponse.json({ locations: groups.size, created, items: [...groups.values()].reduce((sum, group) => sum + group.itemIds.length, 0) });
    }

    /**
     * Phiếu đếm một vị trí: chỉ số đếm (nhiều ĐVT cùng lúc), không so sổ sách — việc đó làm lúc
     * kế toán duyệt gộp. Gửi là Chờ duyệt; phiếu Chờ duyệt / Bị trả lại sửa lại được.
     */
    if (action === "SAVE_SHEET") {
      const stocktakeId = cleanText(body.stocktakeId);
      const branchCode = cleanText(body.branchCode);
      const warehouseCode = cleanText(body.warehouseCode);
      const locationCode = cleanText(body.locationCode).toUpperCase();
      const stocktakeDate = toDate(body.stocktakeDate);
      if (!branchCode || !warehouseCode || !locationCode) businessError("Phiếu đếm cần cửa hàng, kho và vị trí");
      assertBranchAccess(auth.session, branchCode);
      assertWarehouseAccess(auth.session, warehouseCode);
      await warehouseOfBranch(warehouseCode, branchCode);
      const location = await prisma.stocktakeLocation.findFirst({ where: { warehouseCode, code: locationCode } });
      if (!location) businessError(`Kho ${warehouseCode} chưa có vị trí ${locationCode}.`);
      if (await isPeriodLocked(stocktakeDate, branchCode)) businessError("Kỳ kế toán đã khoá");
      const existing = stocktakeId ? await prisma.stocktakeSession.findUnique({ where: { id: stocktakeId } }) : null;
      if (stocktakeId) {
        if (!existing) businessError("Không tìm thấy phiếu đếm cần sửa");
        assertWarehouseAccess(auth.session, existing.warehouseCode);
        if (!existing.locationCode) businessError(`Phiếu ${existing.code} là phiếu kiểm cả kho — sửa ở form kiểm kê cả kho.`);
        if (!isStocktakeEditable(existing.status)) businessError(`Phiếu ${existing.code} đã được kế toán duyệt. Nhờ kế toán mở lại đợt kiểm kê trước.`);
      }

      const rawLines = Array.isArray(body.lines) ? body.lines as Array<{ itemId?: unknown; inputs?: unknown; unitCost?: unknown; reason?: unknown }> : [];
      const itemIds = [...new Set(rawLines.map((line) => cleanText(line.itemId)).filter(Boolean))];
      const items = await prisma.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: itemSelect });
      const itemById = new Map(items.map((item) => [item.id, item]));
      const merged = new Map<string, { itemId: string; actualQuantity: number; inputs: Array<{ unitCode: string; quantity: number; conversionRate: number }>; unitCost: number; reason: string }>();
      for (const line of rawLines) {
        const itemId = cleanText(line.itemId);
        const item = itemById.get(itemId);
        if (!item) continue;
        if (!isLocationStocktakeItemType(item.itemType)) businessError(`${item.code} không thuộc nhóm đếm theo vị trí — kiểm ở form kiểm kê cả kho.`);
        const resolved = resolveUnitInputs(item.unit, item.unitConversions, Array.isArray(line.inputs) ? line.inputs : []);
        if (resolved.error) businessError(`${item.code}: ${resolved.error}`);
        if (resolved.inputs.length === 0) continue; // ô để trống = chưa đếm, không ghi dòng
        const current = merged.get(itemId) || { itemId, actualQuantity: 0, inputs: [], unitCost: 0, reason: "" };
        current.actualQuantity += resolved.baseQuantity;
        current.inputs.push(...resolved.inputs);
        current.unitCost = Math.max(current.unitCost, toNumber(line.unitCost));
        current.reason = cleanText(line.reason) || current.reason;
        merged.set(itemId, current);
      }
      if (merged.size === 0) businessError("Chưa nhập số đếm cho mặt hàng nào");

      const result = await prisma.$transaction(async (tx) => {
        const header = { stocktakeDate, branchCode, warehouseCode, locationCode, status: STOCKTAKE_PENDING, note: cleanText(body.note) || null };
        const sheet = existing
          ? await tx.stocktakeSession.update({ where: { id: existing.id }, data: header })
          : await tx.stocktakeSession.create({ data: { ...header, code: await nextStocktakeCode(tx as unknown as TxClient, stocktakeDate), createdBy: auth.session.name } });
        await tx.stocktakeLine.deleteMany({ where: { stocktakeId: sheet.id } });
        await tx.stocktakeLine.createMany({
          data: [...merged.values()].map((line) => ({
            stocktakeId: sheet.id,
            itemId: line.itemId,
            // Phiếu theo vị trí không so sổ sách từng phiếu: sổ sách lấy lúc duyệt gộp tại giờ chốt.
            systemQuantity: 0,
            actualQuantity: Math.round(line.actualQuantity * 1e6) / 1e6,
            varianceQuantity: 0,
            unitCost: line.unitCost > 0 ? line.unitCost : null,
            unitInputs: JSON.stringify(line.inputs),
            reason: line.reason || null,
          })),
        });
        return tx.stocktakeSession.findUnique({ where: { id: sheet.id }, include: { lines: true } });
      });
      await writeAuditLog({ session: auth.session, module: menuHref, action: existing ? "RESUBMIT_STOCKTAKE" : "SUBMIT_STOCKTAKE", entityType: "StocktakeSession", entityId: result?.id || null, entityCode: result?.code || null, branchCode, metadata: { warehouseCode, locationCode, lines: merged.size } });
      return NextResponse.json(result, { status: existing ? 200 : 201 });
    }

    if (action === "PREVIEW_BATCH" || action === "APPROVE_BATCH") {
      const stocktakeIds = stocktakeIdsFrom(body.stocktakeIds);
      const cutoffAt = body.cutoffAt ? toDate(body.cutoffAt, new Date(Number.NaN)) : new Date();
      if (cutoffAt.getTime() > Date.now() + 60_000) businessError("Giờ chốt không được ở tương lai — chưa tới giờ đó thì chưa có số bán để so.");
      const first = stocktakeIds.length > 0 ? await prisma.stocktakeSession.findUnique({ where: { id: stocktakeIds[0] } }) : null;
      if (first) {
        assertBranchAccess(auth.session, first.branchCode);
        assertWarehouseAccess(auth.session, first.warehouseCode);
        await assertPeriodOpen({ date: cutoffAt, branchCode: first.branchCode }, "duyệt kiểm kê");
      }
      const unitCosts = unitCostMap(body.unitCosts);
      if (action === "PREVIEW_BATCH") {
        const preview = await prisma.$transaction((tx) => buildBatchPreview(tx as unknown as TxClient, { stocktakeIds, cutoffAt, unitCosts }), { timeout: 120000 });
        return NextResponse.json(preview);
      }
      const outcome = await prisma.$transaction(
        (tx) => approveStocktakeBatch(tx as unknown as TxClient, { stocktakeIds, cutoffAt, unitCosts, approvedBy: auth.session.name, note: cleanText(body.note) || null }),
        { timeout: 300000, maxWait: 20000 },
      );
      await writeAuditLog({
        session: auth.session, module: menuHref, action: "APPROVE_STOCKTAKE_BATCH",
        entityType: "StocktakeBatch", entityId: outcome.batch.id, entityCode: outcome.batch.code, branchCode: outcome.batch.branchCode,
        metadata: { cutoffAt: formatVnDateTime(outcome.batch.cutoffAt), sheets: outcome.preview.sheets.map((sheet) => sheet.code), documents: outcome.documents, shortageValue: outcome.batch.shortageValue, surplusValue: outcome.batch.surplusValue },
      });
      return NextResponse.json({ batch: outcome.batch, documents: outcome.documents }, { status: 201 });
    }

    if (action === "REOPEN_BATCH") {
      const batchId = cleanText(body.batchId);
      const batch = batchId ? await prisma.stocktakeBatch.findUnique({ where: { id: batchId } }) : null;
      if (!batch) businessError("Không tìm thấy đợt kiểm kê");
      assertBranchAccess(auth.session, batch.branchCode);
      assertWarehouseAccess(auth.session, batch.warehouseCode);
      await assertPeriodOpen({ date: batch.cutoffAt, branchCode: batch.branchCode }, "mở lại đợt kiểm kê");
      const outcome = await prisma.$transaction(
        (tx) => reopenStocktakeBatch(tx as unknown as TxClient, { batchId: batch.id, reopenedBy: auth.session.name }),
        { timeout: 120000, maxWait: 20000 },
      );
      await writeAuditLog({ session: auth.session, module: menuHref, action: "REOPEN_STOCKTAKE_BATCH", entityType: "StocktakeBatch", entityId: batch.id, entityCode: batch.code, branchCode: batch.branchCode, metadata: { reversedDocuments: outcome.documents } });
      return NextResponse.json(outcome);
    }

    return businessError("Thao tác kiểm kê theo vị trí không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
