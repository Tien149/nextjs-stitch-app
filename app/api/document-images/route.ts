import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/api-auth";
import { canPerformMenuAction, type DemoSession } from "@/lib/auth-demo";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { warehouseAllowed } from "@/lib/warehouse-scope";
import {
  DOC_IMAGE_ENTITY_TYPES,
  DOC_IMAGE_TRANSFER_REQUEST,
  DOC_IMAGE_TX,
  MAX_DOC_IMAGES,
  imageOwnersOfTransactions,
  parseDocImages,
  saveDocImages,
} from "@/lib/document-images";

/**
 * Ảnh chứng từ của phiếu kho (phiếu hủy, điều chuyển — khách 28/11/2026).
 * GET  ?view=counts&entityType=&ids=a,b   số ảnh từng phiếu (danh sách)
 * GET  ?entityType=&entityId=             danh sách ảnh của một phiếu
 * GET  ?id=                               nội dung ảnh
 * POST { entityType, entityId, images }   thêm ảnh (quyền Tạo mới hoặc Sửa của Kho)
 * DELETE ?id=                             xoá ảnh (quyền Sửa) — không xoá được ảnh cuối cùng
 */
const menuHref = "/inventory";

function errorResponse(error: unknown) {
  const { message, status } = apiError(error);
  return NextResponse.json({ error: message }, { status });
}

function entityTypeOf(value: unknown) {
  const type = cleanText(value);
  if (!(DOC_IMAGE_ENTITY_TYPES as readonly string[]).includes(type)) businessError("Loại chứng từ không hợp lệ.");
  return type;
}

function branchVisible(session: DemoSession, codes: Array<string | null | undefined>) {
  const allowed = (session.allowedBranches || []).map((code) => code.toUpperCase());
  if (allowed.length === 0 || allowed.includes("ALL")) return true;
  return codes.some((code) => code && allowed.includes(code.toUpperCase()));
}

/** Người xem phải thấy được phiếu: cửa hàng chuyển HOẶC nhận, và kho (xuất hoặc nhận) nếu bị giới hạn kho. */
async function assertEntityAccess(session: DemoSession, entityType: string, entityId: string) {
  const entity = entityType === DOC_IMAGE_TX
    ? await prisma.inventoryTransaction.findUnique({ where: { id: entityId }, select: { code: true, transactionType: true, branchCode: true, toBranchCode: true, warehouseCode: true, toWarehouseCode: true } })
    : await prisma.inventoryTransferRequest.findUnique({ where: { id: entityId }, select: { code: true, branchCode: true, toBranchCode: true, warehouseCode: true, toWarehouseCode: true } });
  if (!entity) businessError("Không tìm thấy phiếu.");
  if (!branchVisible(session, [entity.branchCode, entity.toBranchCode])) businessError("Phiếu nằm ngoài cửa hàng được phân công.");
  if (!warehouseAllowed(session, entity.warehouseCode) && !warehouseAllowed(session, entity.toWarehouseCode)) businessError("Phiếu nằm ngoài kho được phân công.");
  return entity;
}

export async function GET(request: Request) {
  const auth = requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth.response;
  try {
    const params = new URL(request.url).searchParams;

    const imageId = cleanText(params.get("id"));
    if (imageId) {
      const image = await prisma.documentImage.findUnique({ where: { id: imageId } });
      if (!image) businessError("Không tìm thấy ảnh.");
      await assertEntityAccess(auth.session, image.entityType, image.entityId);
      return new Response(Buffer.from(image.content), {
        headers: { "Content-Type": image.mimeType, "Cache-Control": "private, max-age=86400, immutable" },
      });
    }

    if (params.get("view") === "counts") {
      const entityType = entityTypeOf(params.get("entityType"));
      const ids = (params.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 500);
      const counts: Record<string, number> = {};
      if (ids.length === 0) return NextResponse.json({ counts });
      const owners = entityType === DOC_IMAGE_TX
        ? await imageOwnersOfTransactions(ids)
        : new Map(ids.map((id) => [id, [{ entityType, entityId: id }]]));
      const pairs = [...owners.values()].flat();
      const grouped = await prisma.documentImage.groupBy({
        by: ["entityType", "entityId"],
        where: { OR: pairs.map((pair) => ({ entityType: pair.entityType, entityId: pair.entityId })) },
        _count: { _all: true },
      });
      const byKey = new Map(grouped.map((row) => [`${row.entityType}|${row.entityId}`, row._count._all]));
      for (const [id, list] of owners) counts[id] = list.reduce((sum, pair) => sum + (byKey.get(`${pair.entityType}|${pair.entityId}`) || 0), 0);
      return NextResponse.json({ counts });
    }

    const entityType = entityTypeOf(params.get("entityType"));
    const entityId = cleanText(params.get("entityId"));
    const entity = await assertEntityAccess(auth.session, entityType, entityId);
    const owners = entityType === DOC_IMAGE_TX ? (await imageOwnersOfTransactions([entityId])).get(entityId) || [] : [{ entityType, entityId }];
    const images = await prisma.documentImage.findMany({
      where: { OR: owners.map((pair) => ({ entityType: pair.entityType, entityId: pair.entityId })) },
      orderBy: { createdAt: "asc" },
      select: { id: true, entityType: true, entityId: true, fileName: true, width: true, height: true, fileSize: true, uploadedBy: true, createdAt: true },
    });
    return NextResponse.json({ code: entity.code, images });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth.response;
  try {
    if (!canPerformMenuAction(auth.session, menuHref, "create") && !canPerformMenuAction(auth.session, menuHref, "edit")) {
      return NextResponse.json({ error: "Bạn không có quyền thêm ảnh chứng từ" }, { status: 403 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    let entityType = entityTypeOf(body.entityType);
    let entityId = cleanText(body.entityId);
    const entity = await assertEntityAccess(auth.session, entityType, entityId);
    // Phiếu kho sinh từ điều chuyển chờ duyệt: ảnh gắn vào phiếu chờ duyệt để hai bên cùng thấy.
    if (entityType === DOC_IMAGE_TX) {
      const owner = (await imageOwnersOfTransactions([entityId])).get(entityId)?.find((pair) => pair.entityType === DOC_IMAGE_TRANSFER_REQUEST);
      if (owner) {
        entityType = owner.entityType;
        entityId = owner.entityId;
      }
    }
    const images = parseDocImages(body.images);
    if (images.length === 0) businessError("Chưa chọn ảnh.");
    const existing = await prisma.documentImage.count({ where: { entityType, entityId } });
    if (existing + images.length > MAX_DOC_IMAGES) businessError(`Mỗi phiếu tối đa ${MAX_DOC_IMAGES} ảnh (đang có ${existing}).`);
    await saveDocImages(prisma, entityType, entityId, images, auth.session.name);
    await writeAuditLog({ session: auth.session, module: menuHref, action: "ADD_DOCUMENT_IMAGE", entityType, entityId, entityCode: entity.code, branchCode: entity.branchCode, metadata: { added: images.length } });
    return NextResponse.json({ added: images.length }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const auth = requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth.response;
  try {
    if (!canPerformMenuAction(auth.session, menuHref, "edit")) {
      return NextResponse.json({ error: "Bạn không có quyền xoá ảnh chứng từ" }, { status: 403 });
    }
    const id = cleanText(new URL(request.url).searchParams.get("id"));
    const image = await prisma.documentImage.findUnique({ where: { id }, select: { id: true, entityType: true, entityId: true, fileName: true } });
    if (!image) businessError("Không tìm thấy ảnh.");
    const entity = await assertEntityAccess(auth.session, image.entityType, image.entityId);
    // Ảnh bắt buộc: phiếu hủy, và điều chuyển KHÁC nhà hàng (nội bộ một nhà hàng xoá hết được).
    const isWaste = "transactionType" in entity && entity.transactionType === "XUAT_HUY";
    const crossBranch = Boolean(entity.toBranchCode) && entity.toBranchCode!.toUpperCase() !== entity.branchCode.toUpperCase();
    const remaining = await prisma.documentImage.count({ where: { entityType: image.entityType, entityId: image.entityId } });
    if ((isWaste || crossBranch) && remaining <= 1) businessError("Phiếu bắt buộc có hình ảnh — thêm ảnh khác trước rồi mới xoá ảnh này.");
    await prisma.documentImage.delete({ where: { id } });
    await writeAuditLog({ session: auth.session, module: menuHref, action: "DELETE_DOCUMENT_IMAGE", entityType: image.entityType, entityId: image.entityId, entityCode: entity.code, branchCode: entity.branchCode, metadata: { fileName: image.fileName } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
