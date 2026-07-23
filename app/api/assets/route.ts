import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

async function nextAssetCode() {
  const count = await prisma.assetRecord.count();
  return `TS-${String(count + 1).padStart(4, "0")}`;
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
      },
      orderBy: { createdAt: "desc" },
    });

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

      const { depreciations: _depreciations, ...baseAsset } = asset;
      return {
        ...baseAsset,
        warehouseCode: asset.warehouseCode || asset.location,
        location: asset.location || asset.warehouseCode,
        allocatedPeriods,
        allocatedAmount,
        remainingPeriods,
        computedCurrentValue,
        computedStatus,
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

    const code = cleanText(body.code) || (await nextAssetCode());
    const asset = await prisma.assetRecord.create({
      data: {
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
      },
    });

    return NextResponse.json(asset, { status: 201 });
  } catch (error) {
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

    const targetBranch = body.branchCode !== undefined ? cleanText(body.branchCode) : current.branchCode;

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

    const asset = await prisma.assetRecord.update({
      where: { id },
      data: {
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
      },
    });

    return NextResponse.json(asset);
  } catch (error) {
    console.error("Error updating asset:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
