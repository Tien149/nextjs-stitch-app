import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit-log";
import { AssetCodeError, nextAssetCode, validateManualAssetCode } from "@/lib/asset-code-generator";
import { loadCatalogUsage, renameAssetCode, syncAssetCatalog } from "@/lib/asset-catalog";

/**
 * Danh mục mã Tài sản / CCDC (master list) — xem lib/asset-catalog.ts.
 * GET danh sách kèm hồ sơ đang dùng mã · POST tạo mã · PATCH sửa (tên áp mọi đợt) · DELETE xoá mã chưa dùng.
 */
const menuHref = "/assets";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim());

function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function activeAssetGroup(code: string) {
  return prisma.masterDataItem.findFirst({ where: { type: "ASSET_GROUP", status: "ACTIVE", code } });
}

export async function GET(request: Request) {
  const auth = requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth.response;
  try {
    await syncAssetCatalog(prismaRaw, auth.session.name);
    const [items, usage] = await Promise.all([
      prisma.assetCatalogItem.findMany({ orderBy: [{ name: "asc" }, { code: "asc" }] }),
      loadCatalogUsage(prismaRaw),
    ]);
    return NextResponse.json({
      items: items.map((item) => ({ ...item, usage: usage.get(item.code) || { lotCount: 0, branchCodes: [], departmentCodes: [], quantity: 0, originalCost: 0, inUse: 0 } })),
    });
  } catch (error) {
    console.error("Error loading asset catalog:", error);
    return fail("Không tải được danh mục mã tài sản/CCDC", 500);
  }
}

export async function POST(request: Request) {
  const auth = requireMenuAction(request, menuHref, "create");
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const name = text(body.name);
    const assetGroup = text(body.assetGroup);
    const departmentCode = text(body.departmentCode);
    const manual = text(body.code);
    if (!name || !assetGroup) return fail("Tên và nhóm tài sản/CCDC là bắt buộc");
    if (!manual && !departmentCode) return fail("Chọn phòng ban để hệ thống tự sinh mã (4 ký tự nhóm + 3 ký tự phòng ban + 4 số), hoặc nhập mã thủ công");
    if (!(await activeAssetGroup(assetGroup))) return fail(`Nhóm tài sản ${assetGroup} không tồn tại hoặc đã ngưng dùng`);

    const item = await prismaRaw.$transaction(async (tx) => {
      let code: string;
      if (manual) {
        code = validateManualAssetCode(manual);
        const [catalog, record] = await Promise.all([
          tx.assetCatalogItem.findUnique({ where: { code }, select: { deletedAt: true } }),
          tx.assetRecord.findFirst({ where: { code }, select: { id: true } }),
        ]);
        if (catalog?.deletedAt) throw new AssetCodeError(`Mã ${code} đang nằm trong Thùng rác. Khôi phục mã cũ hoặc dùng mã khác.`);
        if (catalog || record) throw new AssetCodeError(`Mã ${code} đã có trong danh mục.`);
      } else {
        code = await nextAssetCode(tx, assetGroup, departmentCode);
      }
      return tx.assetCatalogItem.create({
        data: {
          code, name, assetGroup,
          departmentCode: departmentCode || null,
          unit: text(body.unit) || null,
          note: text(body.note) || null,
          createdBy: auth.session.name,
        },
      });
    });
    await writeAuditLog({ session: auth.session, module: menuHref, action: "CREATE_ASSET_CATALOG", entityType: "AssetCatalogItem", entityId: item.id, entityCode: item.code, metadata: { name, assetGroup, departmentCode } });
    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    if (error instanceof AssetCodeError) return fail(error.message, 409);
    console.error("Error creating asset catalog item:", error);
    return fail("Không tạo được mã tài sản/CCDC", 500);
  }
}

export async function PATCH(request: Request) {
  const auth = requireMenuAction(request, menuHref, "edit");
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const current = await prisma.assetCatalogItem.findUnique({ where: { id: text(body.id) } });
    if (!current || current.deletedAt) return fail("Không tìm thấy mã trong danh mục", 404);

    const name = body.name !== undefined ? text(body.name) : current.name;
    const assetGroup = body.assetGroup !== undefined ? text(body.assetGroup) : current.assetGroup;
    const status = body.status !== undefined ? text(body.status).toUpperCase() : current.status;
    if (!name) return fail("Tên không được để trống");
    if (!["ACTIVE", "INACTIVE"].includes(status)) return fail("Trạng thái chỉ nhận ACTIVE hoặc INACTIVE");
    if (assetGroup !== current.assetGroup) {
      if (!(await activeAssetGroup(assetGroup))) return fail(`Nhóm tài sản ${assetGroup} không tồn tại hoặc đã ngưng dùng`);
      // Nhóm quyết định tài khoản ghi tăng (CCDC 242 / TSCĐ 211) và cách phân bổ — đổi khi đã có
      // hồ sơ là lệch sổ các đợt đã ghi.
      const records = await prisma.assetRecord.count({ where: { code: current.code } });
      if (records > 0) return fail(`Mã ${current.code} đã có ${records} hồ sơ nên không đổi nhóm được (nhóm quyết định tài khoản 242/211). Tạo mã mới đúng nhóm thay vì sửa.`, 409);
    }

    const result = await prismaRaw.$transaction(async (tx) => {
      const updated = await tx.assetCatalogItem.update({
        where: { id: current.id },
        data: {
          name,
          assetGroup,
          status,
          ...(body.departmentCode !== undefined ? { departmentCode: text(body.departmentCode) || null } : {}),
          ...(body.unit !== undefined ? { unit: text(body.unit) || null } : {}),
          ...(body.note !== undefined ? { note: text(body.note) || null } : {}),
        },
      });
      const renamedRecords = name !== current.name ? await renameAssetCode(tx, current.code, name) : 0;
      return { updated, renamedRecords };
    });
    await writeAuditLog({
      session: auth.session, module: menuHref, action: "UPDATE_ASSET_CATALOG", entityType: "AssetCatalogItem", entityId: current.id, entityCode: current.code,
      metadata: { before: { name: current.name, assetGroup: current.assetGroup, status: current.status }, after: { name, assetGroup, status }, renamedRecords: result.renamedRecords },
    });
    return NextResponse.json({ ...result.updated, renamedRecords: result.renamedRecords });
  } catch (error) {
    console.error("Error updating asset catalog item:", error);
    return fail("Không sửa được mã tài sản/CCDC", 500);
  }
}

export async function DELETE(request: Request) {
  const auth = requireMenuAction(request, menuHref, "delete");
  if (!auth.ok) return auth.response;
  try {
    const id = text(new URL(request.url).searchParams.get("id"));
    const current = await prisma.assetCatalogItem.findUnique({ where: { id } });
    if (!current || current.deletedAt) return fail("Không tìm thấy mã trong danh mục", 404);
    const records = await prisma.assetRecord.count({ where: { code: current.code } });
    if (records > 0) return fail(`Mã ${current.code} đang có ${records} hồ sơ nên không xoá được. Muốn thôi dùng thì chuyển sang Ngưng.`, 409);
    await prisma.assetCatalogItem.delete({ where: { id } });
    await writeAuditLog({ session: auth.session, module: menuHref, action: "DELETE_ASSET_CATALOG", entityType: "AssetCatalogItem", entityId: id, entityCode: current.code, metadata: { name: current.name } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting asset catalog item:", error);
    return fail("Không xoá được mã tài sản/CCDC", 500);
  }
}
