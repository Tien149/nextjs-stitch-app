import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { writeAuditLog } from "@/lib/audit-log";
import { assertAssetCodeAvailable, AssetCodeError, nextAssetCode, normalizeAssetCode } from "@/lib/asset-code-generator";
import {
  softDeleteRecord,
  SoftDeleteError,
} from "@/lib/soft-delete";

const auditModule = "/assets";

/** Các trường không được sửa sau khi tài sản đã trích khấu hao. */
const depreciationLockedFields = [
  "quantity",
  "purchaseDate",
  "originalCost",
  "usefulLifeMonths",
  "depreciationStartDate",
  "residualValue",
] as const;

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function isDisposedAsset(asset: { disposalStatus: string | null; status: string }) {
  return Boolean(asset.disposalStatus) || asset.status === "DISPOSED";
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/assets");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search")?.trim() || searchParams.get("q")?.trim();
    const statusParam = searchParams.get("status") || undefined;
    const assetGroup = searchParams.get("assetGroup") || undefined;
    const departmentCode = searchParams.get("departmentCode") || undefined;
    const warehouseCode = searchParams.get("warehouseCode") || searchParams.get("location") || undefined;
    const branchCode = requestedBranch(auth.session, cleanText(searchParams.get("branchCode")) || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };

    const assets = await prisma.assetRecord.findMany({
      where: {
        ...branchFilter,
        ...(assetGroup && assetGroup !== "ALL" ? { assetGroup } : {}),
        ...(departmentCode && departmentCode !== "ALL" ? { departmentCode } : {}),
        ...(warehouseCode && warehouseCode !== "ALL"
          ? {
              OR: [
                { warehouseCode: warehouseCode },
                { location: warehouseCode },
              ],
            }
          : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { name: { contains: search } },
                { branchCode: { contains: search } },
                { departmentCode: { contains: search } },
                { assetGroup: { contains: search } },
                { supplierName: { contains: search } },
                { supplierCode: { contains: search } },
                { location: { contains: search } },
                { warehouseCode: { contains: search } },
                { note: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        depreciations: {
          select: {
            depreciationAmount: true,
          },
        },
        _count: { select: { maintenances: true, damageReports: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const [journalEntries, openingBalances] = await Promise.all([
      prismaRaw.journalEntry.findMany({
        where: { sourceType: "ASSET_ACQUISITION", sourceId: { in: assets.map((asset) => asset.id) }, deletedAt: null },
        select: { sourceId: true },
      }),
      prismaRaw.openingBalance.findMany({
        where: { balanceType: "ASSET", objectCode: { in: assets.map((asset) => asset.code) }, deletedAt: null },
        select: { objectCode: true },
      }),
    ]);
    const journaledAssetIds = new Set(journalEntries.map((entry) => entry.sourceId));
    const openingBalanceAssetCodes = new Set(openingBalances.map((entry) => entry.objectCode));

    const enriched = assets.map((asset) => {
      const allocatedPeriods = asset.depreciations.length;
      const allocatedAmount = asset.depreciations.reduce((sum, d) => sum + d.depreciationAmount, 0);
      const remainingPeriods = asset.usefulLifeMonths ? Math.max(asset.usefulLifeMonths - allocatedPeriods, 0) : null;
      const computedCurrentValue = Math.max(asset.originalCost - allocatedAmount, asset.residualValue);

      let computedStatus: "IN_USE" | "FULLY_ALLOCATED" | "DISPOSED" = "IN_USE";
      if (asset.disposalStatus || asset.status === "DISPOSED") {
        computedStatus = "DISPOSED";
      } else if (asset.usefulLifeMonths && remainingPeriods === 0) {
        computedStatus = "FULLY_ALLOCATED";
      } else if (asset.usefulLifeMonths && computedCurrentValue <= asset.residualValue) {
        computedStatus = "FULLY_ALLOCATED";
      }

      const { depreciations: _depreciations, _count, ...baseAsset } = asset;
      void _depreciations;
      const codeEditLockReason = isDisposedAsset(asset)
        ? "Tài sản đã thanh lý."
        : allocatedPeriods > 0
          ? `Tài sản đã trích khấu hao ${allocatedPeriods} kỳ.`
          : _count.maintenances > 0
            ? "Tài sản đã phát sinh bảo trì."
            : _count.damageReports > 0
              ? "Tài sản đã phát sinh báo hỏng."
              : asset.sourcePurchaseOrderId || asset.sourceReceiptId
                ? "Tài sản đã liên kết chứng từ mua hàng/nhập hàng."
                : journaledAssetIds.has(asset.id)
                  ? "Tài sản đã phát sinh bút toán kế toán."
                  : openingBalanceAssetCodes.has(asset.code)
                    ? "Tài sản được tạo từ số dư đầu kỳ."
                    : null;
      return {
        ...baseAsset,
        warehouseCode: asset.warehouseCode || asset.location,
        location: asset.location || asset.warehouseCode,
        allocatedPeriods,
        allocatedAmount,
        remainingPeriods,
        computedCurrentValue,
        computedStatus,
        canEditCode: !codeEditLockReason,
        codeEditLockReason,
      };
    });

    const filtered = statusParam && statusParam !== "ALL"
      ? enriched.filter((a) => a.computedStatus === statusParam || a.status === statusParam)
      : enriched;

    return NextResponse.json(filtered);
  } catch (error) {
    console.error("Error fetching assets:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/assets", "create");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const name = cleanText(body.name);
    const branchCode = cleanText(body.branchCode);
    const assetGroup = cleanText(body.assetGroup);
    const originalCost = toAmount(body.originalCost);
    const warehouseCode = cleanText(body.warehouseCode) || cleanText(body.location);
    const quantity = toAmount(body.quantity) || 1;
    const usefulLifeMonths = body.usefulLifeMonths !== undefined && body.usefulLifeMonths !== "" ? Math.floor(toAmount(body.usefulLifeMonths)) : null;

    if (!name || !branchCode || !assetGroup || originalCost <= 0) {
      return NextResponse.json({ error: "Tên tài sản, chi nhánh, nhóm tài sản và nguyên giá (lớn hơn 0) là bắt buộc" }, { status: 400 });
    }

    if (quantity <= 0) {
      return NextResponse.json({ error: "Số lượng phải lớn hơn 0" }, { status: 400 });
    }

    if (usefulLifeMonths !== null && usefulLifeMonths <= 0) {
      return NextResponse.json({ error: "Số kỳ khấu hao phải lớn hơn 0" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
    }

    if (warehouseCode) {
      const warehouse = await prisma.masterDataItem.findFirst({
        where: {
          type: "WAREHOUSE",
          status: "ACTIVE",
          code: warehouseCode,
          OR: [{ branch: branchCode }, { branch: "ALL" }, { branch: null }],
        },
      });
      if (!warehouse) {
        return NextResponse.json({ error: `Vị trí/Kho ${warehouseCode} không hợp lệ hoặc không thuộc chi nhánh ${branchCode}` }, { status: 400 });
      }
    }

    const manualCode = normalizeAssetCode(body.code);
    const asset = await prismaRaw.$transaction(async (tx) => {
      const code = manualCode
        ? await assertAssetCodeAvailable(tx, manualCode)
        : await nextAssetCode(tx, assetGroup);
      return tx.assetRecord.create({ data: {
        code,
        name,
        branchCode,
        departmentCode: cleanText(body.departmentCode) || null,
        assetGroup,
        imageUrl: cleanText(body.imageUrl) || null,
        location: warehouseCode || null,
        warehouseCode: warehouseCode || null,
        quantity,
        purchaseDate: body.purchaseDate ? new Date(String(body.purchaseDate)) : new Date(),
        originalCost,
        currentValue: toAmount(body.currentValue) || originalCost,
        usefulLifeMonths,
        depreciationStartDate: body.depreciationStartDate ? new Date(String(body.depreciationStartDate)) : null,
        residualValue: toAmount(body.residualValue) || 0,
        supplierCode: cleanText(body.supplierCode) || null,
        supplierName: cleanText(body.supplierName) || null,
        status: cleanText(body.status) || "IN_USE",
        note: cleanText(body.note) || null,
      } });
    });

    return NextResponse.json(asset, { status: 201 });
  } catch (error) {
    if (error instanceof AssetCodeError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "Mã tài sản đã tồn tại. Vui lòng dùng mã khác." }, { status: 409 });
    }
    console.error("Error creating asset:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/assets", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);
    if (!id) return NextResponse.json({ error: "Thiếu ID tài sản" }, { status: 400 });

    const current = await prisma.assetRecord.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy tài sản" }, { status: 404 });

    if (isDisposedAsset(current)) {
      return NextResponse.json(
        { error: `Tài sản ${current.code} đã thanh lý nên không thể chỉnh sửa.` },
        { status: 400 },
      );
    }

    const depreciationCount = await prisma.assetDepreciation.count({ where: { assetId: id } });
    if (depreciationCount > 0) {
      const lockedTouched = depreciationLockedFields.filter((field) => body[field] !== undefined);
      if (lockedTouched.length > 0) {
        return NextResponse.json(
          {
            error: `Tài sản ${current.code} đã trích khấu hao ${depreciationCount} kỳ nên không thể sửa số lượng, ngày mua, nguyên giá, số kỳ khấu hao, ngày bắt đầu khấu hao hoặc giá trị thu hồi. Chỉ được cập nhật thông tin quản lý.`,
          },
          { status: 400 },
        );
      }
    }

    if (body.name !== undefined && !cleanText(body.name)) {
      return NextResponse.json({ error: "Tên tài sản không được để trống" }, { status: 400 });
    }
    if (body.assetGroup !== undefined && !cleanText(body.assetGroup)) {
      return NextResponse.json({ error: "Nhóm tài sản không được để trống" }, { status: 400 });
    }
    if (body.branchCode !== undefined && !cleanText(body.branchCode)) {
      return NextResponse.json({ error: "Chi nhánh không được để trống" }, { status: 400 });
    }
    if (body.quantity !== undefined && toAmount(body.quantity) <= 0) {
      return NextResponse.json({ error: "Số lượng phải lớn hơn 0" }, { status: 400 });
    }
    if (body.originalCost !== undefined && toAmount(body.originalCost) <= 0) {
      return NextResponse.json({ error: "Nguyên giá phải lớn hơn 0" }, { status: 400 });
    }
    if (body.currentValue !== undefined && toAmount(body.currentValue) < 0) {
      return NextResponse.json({ error: "Giá trị còn lại không được âm" }, { status: 400 });
    }
    if (body.residualValue !== undefined && toAmount(body.residualValue) < 0) {
      return NextResponse.json({ error: "Giá trị thu hồi ước tính không được âm" }, { status: 400 });
    }
    if (
      body.usefulLifeMonths !== undefined
      && body.usefulLifeMonths !== null
      && body.usefulLifeMonths !== ""
      && Math.floor(toAmount(body.usefulLifeMonths)) <= 0
    ) {
      return NextResponse.json({ error: "Số kỳ khấu hao phải lớn hơn 0" }, { status: 400 });
    }

    const targetBranch = body.branchCode !== undefined ? cleanText(body.branchCode) : current.branchCode;
    const nextCode = body.code !== undefined ? normalizeAssetCode(body.code) : current.code;
    if (body.code !== undefined && !nextCode) {
      return NextResponse.json({ error: "Mã tài sản không được để trống khi chỉnh sửa." }, { status: 400 });
    }
    const codeChanged = Boolean(nextCode && nextCode !== current.code);
    if (codeChanged) {
      const [maintenanceCount, damageCount, journalCount, openingBalanceCount] = await Promise.all([
        prismaRaw.assetMaintenance.count({ where: { assetId: id } }),
        prismaRaw.assetDamageReport.count({ where: { assetId: id } }),
        prismaRaw.journalEntry.count({ where: { sourceType: "ASSET_ACQUISITION", sourceId: id } }),
        prismaRaw.openingBalance.count({ where: { balanceType: "ASSET", objectCode: current.code } }),
      ]);
      const lockReason = depreciationCount > 0
        ? `đã trích khấu hao ${depreciationCount} kỳ`
        : maintenanceCount > 0
          ? "đã phát sinh bảo trì"
          : damageCount > 0
            ? "đã phát sinh báo hỏng"
            : current.sourcePurchaseOrderId || current.sourceReceiptId
              ? "đã liên kết chứng từ mua hàng/nhập hàng"
              : journalCount > 0
                ? "đã phát sinh bút toán kế toán"
                : openingBalanceCount > 0
                  ? "được tạo từ số dư đầu kỳ"
                  : null;
      if (lockReason) {
        return NextResponse.json({ error: `Không thể đổi mã tài sản ${current.code} vì hồ sơ ${lockReason}.` }, { status: 409 });
      }
    }

    try {
      assertBranchAccess(auth.session, current.branchCode);
      if (body.branchCode !== undefined) {
        assertBranchAccess(auth.session, targetBranch);
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
    }

    const warehouseCode = body.warehouseCode !== undefined ? cleanText(body.warehouseCode) : body.location !== undefined ? cleanText(body.location) : undefined;
    if (warehouseCode) {
      const warehouse = await prisma.masterDataItem.findFirst({
        where: {
          type: "WAREHOUSE",
          status: "ACTIVE",
          code: warehouseCode,
          OR: [{ branch: targetBranch }, { branch: "ALL" }, { branch: null }],
        },
      });
      if (!warehouse) {
        return NextResponse.json({ error: `Vị trí/Kho ${warehouseCode} không hợp lệ hoặc không thuộc chi nhánh ${targetBranch}` }, { status: 400 });
      }
    }

    const asset = await prismaRaw.$transaction(async (tx) => {
      const validatedCode = codeChanged ? await assertAssetCodeAvailable(tx, nextCode, id) : current.code;
      return tx.assetRecord.update({ where: { id }, data: {
        ...(codeChanged ? { code: validatedCode } : {}),
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        ...(body.branchCode !== undefined ? { branchCode: targetBranch } : {}),
        ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || null } : {}),
        ...(body.assetGroup !== undefined ? { assetGroup: cleanText(body.assetGroup) } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: cleanText(body.imageUrl) || null } : {}),
        ...(warehouseCode !== undefined ? { location: warehouseCode || null, warehouseCode: warehouseCode || null } : {}),
        ...(body.quantity !== undefined ? { quantity: toAmount(body.quantity) || 1 } : {}),
        ...(body.purchaseDate !== undefined ? { purchaseDate: new Date(String(body.purchaseDate)) } : {}),
        ...(body.originalCost !== undefined ? { originalCost: toAmount(body.originalCost) } : {}),
        ...(body.currentValue !== undefined ? { currentValue: toAmount(body.currentValue) } : {}),
        ...(body.usefulLifeMonths !== undefined ? { usefulLifeMonths: Math.floor(toAmount(body.usefulLifeMonths)) || null } : {}),
        ...(body.depreciationStartDate !== undefined ? { depreciationStartDate: body.depreciationStartDate ? new Date(String(body.depreciationStartDate)) : null } : {}),
        ...(body.residualValue !== undefined ? { residualValue: toAmount(body.residualValue) } : {}),
        ...(body.supplierCode !== undefined ? { supplierCode: cleanText(body.supplierCode) || null } : {}),
        ...(body.supplierName !== undefined ? { supplierName: cleanText(body.supplierName) || null } : {}),
        ...(body.status !== undefined ? { status: cleanText(body.status) || "IN_USE" } : {}),
        ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
      } });
    });

    await writeAuditLog({
      session: auth.session,
      module: auditModule,
      action: "UPDATE_ASSET",
      entityType: "AssetRecord",
      entityId: asset.id,
      entityCode: asset.code,
      branchCode: asset.branchCode,
      metadata: {
        changedFields: Object.keys(body).filter((field) => field !== "id" && field !== "action"),
        depreciationCount,
        ...(codeChanged ? { oldCode: current.code, newCode: asset.code } : {}),
      },
    });

    return NextResponse.json(asset);
  } catch (error) {
    if (error instanceof AssetCodeError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "Mã tài sản đã tồn tại. Vui lòng dùng mã khác." }, { status: 409 });
    }
    console.error("Error updating asset:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Xoá mềm tài sản.
 * query: ?id=<assetId>&type=ASSET&reason=<lý do>
 */
export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/assets", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const type = (cleanText(searchParams.get("type")) || cleanText(searchParams.get("entity")) || "ASSET").toUpperCase();
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason"));

    if (!["ASSET", "ASSETRECORD", "ASSET_RECORD"].includes(type)) {
      return NextResponse.json({ error: `Loại dữ liệu "${type}" không được hỗ trợ ở màn hình tài sản` }, { status: 400 });
    }
    if (!id) return NextResponse.json({ error: "Thiếu ID tài sản cần xoá" }, { status: 400 });

    const current = await prisma.assetRecord.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy tài sản" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi phân quyền chi nhánh" }, { status: 403 });
    }

    if (isDisposedAsset(current)) {
      return NextResponse.json(
        { error: `Tài sản ${current.code} đã thanh lý nên không thể xoá. Hồ sơ thanh lý cần được lưu để đối chiếu sổ sách.` },
        { status: 400 },
      );
    }

    const depreciationCount = await prisma.assetDepreciation.count({ where: { assetId: id } });
    if (depreciationCount > 0) {
      return NextResponse.json(
        { error: `Tài sản ${current.code} đã trích khấu hao ${depreciationCount} kỳ nên không thể xoá. Hãy thanh lý tài sản thay vì xoá.` },
        { status: 400 },
      );
    }

    const result = await softDeleteRecord({
      model: "AssetRecord",
      id,
      session: auth.session,
      reason: reason || null,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting asset:", error);
    return NextResponse.json({ error: "Không xoá được tài sản" }, { status: 500 });
  }
}
