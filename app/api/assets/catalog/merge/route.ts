import { NextResponse } from "next/server";
import { requireMenuAction } from "@/lib/api-auth";
import { prismaRaw } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit-log";
import { AssetMergeError, mergeAssetCodes } from "@/lib/asset-catalog";

/**
 * Gộp mã Tài sản / CCDC: hồ sơ của mã bỏ thành đợt của mã giữ lại — xem mergeAssetCodes.
 * Cần cả quyền sửa lẫn xoá (mã bỏ vào Thùng rác).
 */
const menuHref = "/assets";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function POST(request: Request) {
  const auth = requireMenuAction(request, menuHref, "edit");
  if (!auth.ok) return auth.response;
  const canDelete = requireMenuAction(request, menuHref, "delete");
  if (!canDelete.ok) return canDelete.response;
  try {
    const body = await request.json();
    const sourceCode = text(body.sourceCode).toUpperCase();
    const targetCode = text(body.targetCode).toUpperCase();
    const result = await prismaRaw.$transaction((tx) => mergeAssetCodes(tx, { sourceCode, targetCode }), { timeout: 60_000 });
    await writeAuditLog({
      session: auth.session, module: menuHref, action: "MERGE_ASSET_CATALOG", entityType: "AssetCatalogItem", entityCode: targetCode,
      metadata: { sourceCode, targetCode, ...result },
    });
    return NextResponse.json({ ok: true, sourceCode, targetCode, ...result });
  } catch (error) {
    if (error instanceof AssetMergeError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("Error merging asset codes:", error);
    return NextResponse.json({ error: "Không gộp được mã tài sản/CCDC" }, { status: 500 });
  }
}
