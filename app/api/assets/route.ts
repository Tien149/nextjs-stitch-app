import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

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

    const assets = await prisma.assetRecord.findMany({
      where: {
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

    const code = cleanText(body.code) || (await nextAssetCode());
    const asset = await prisma.assetRecord.create({
      data: {
        code,
        name,
        branchCode,
        departmentCode: cleanText(body.departmentCode) || null,
        assetGroup,
        purchaseDate: body.purchaseDate ? new Date(String(body.purchaseDate)) : new Date(),
        originalCost,
        currentValue: toAmount(body.currentValue) || originalCost,
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

    const asset = await prisma.assetRecord.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: cleanText(body.name) } : {}),
        ...(body.branchCode !== undefined ? { branchCode: cleanText(body.branchCode) } : {}),
        ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || null } : {}),
        ...(body.assetGroup !== undefined ? { assetGroup: cleanText(body.assetGroup) } : {}),
        ...(body.purchaseDate !== undefined ? { purchaseDate: new Date(String(body.purchaseDate)) } : {}),
        ...(body.originalCost !== undefined ? { originalCost: toAmount(body.originalCost) } : {}),
        ...(body.currentValue !== undefined ? { currentValue: toAmount(body.currentValue) } : {}),
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
