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
    const search = searchParams.get("search")?.trim();
    const status = searchParams.get("status") || undefined;
    const branchCode = requestedBranch(auth.session, cleanText(searchParams.get("branchCode")) || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };

    const assets = await prisma.assetRecord.findMany({
      where: {
        ...branchFilter,
        ...(status && status !== "ALL" ? { status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { name: { contains: search } },
                { branchCode: { contains: search } },
                { assetGroup: { contains: search } },
                { supplierName: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(assets);
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

    if (!name || !branchCode || !assetGroup || originalCost <= 0) {
      return NextResponse.json({ error: "Tên tài sản, chi nhánh, nhóm tài sản và nguyên giá là bắt buộc" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
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
        location: cleanText(body.location) || null,
        quantity: toAmount(body.quantity) || 1,
        purchaseDate: body.purchaseDate ? new Date(String(body.purchaseDate)) : new Date(),
        originalCost,
        currentValue: toAmount(body.currentValue) || originalCost,
        usefulLifeMonths: body.usefulLifeMonths !== undefined ? Math.floor(toAmount(body.usefulLifeMonths)) || null : null,
        depreciationStartDate: body.depreciationStartDate ? new Date(String(body.depreciationStartDate)) : null,
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

    try {
      assertBranchAccess(auth.session, current.branchCode);
      if (body.branchCode !== undefined) {
        assertBranchAccess(auth.session, cleanText(body.branchCode));
      }
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
    }

    const asset = await prisma.assetRecord.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        ...(body.branchCode !== undefined ? { branchCode: cleanText(body.branchCode) } : {}),
        ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || null } : {}),
        ...(body.assetGroup !== undefined ? { assetGroup: cleanText(body.assetGroup) } : {}),
        ...(body.imageUrl !== undefined ? { imageUrl: cleanText(body.imageUrl) || null } : {}),
        ...(body.location !== undefined ? { location: cleanText(body.location) || null } : {}),
        ...(body.quantity !== undefined ? { quantity: toAmount(body.quantity) || 1 } : {}),
        ...(body.purchaseDate !== undefined ? { purchaseDate: new Date(String(body.purchaseDate)) } : {}),
        ...(body.originalCost !== undefined ? { originalCost: toAmount(body.originalCost) } : {}),
        ...(body.currentValue !== undefined ? { currentValue: toAmount(body.currentValue) } : {}),
        ...(body.usefulLifeMonths !== undefined ? { usefulLifeMonths: Math.floor(toAmount(body.usefulLifeMonths)) || null } : {}),
        ...(body.depreciationStartDate !== undefined ? { depreciationStartDate: body.depreciationStartDate ? new Date(String(body.depreciationStartDate)) : null } : {}),
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
