import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;
    const balanceType = searchParams.get("balanceType") || undefined;

    const balances = await prisma.openingBalance.findMany({
      where: {
        ...(status && status !== "ALL" ? { status } : {}),
        ...(balanceType && balanceType !== "ALL" ? { balanceType } : {}),
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json(balances);
  } catch (error) {
    console.error("Error fetching opening balances:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const period = cleanText(body.period);
    const branchCode = cleanText(body.branchCode);
    const balanceType = cleanText(body.balanceType);
    const amount = toAmount(body.amount);

    if (!period || !branchCode || !balanceType) {
      return NextResponse.json({ error: "Kỳ, chi nhánh và loại số dư là bắt buộc" }, { status: 400 });
    }

    const balance = await prisma.openingBalance.create({
      data: {
        period,
        branchCode,
        balanceType,
        objectCode: cleanText(body.objectCode) || null,
        objectName: cleanText(body.objectName) || null,
        moneySourceCode: cleanText(body.moneySourceCode) || null,
        amount,
        note: cleanText(body.note) || null,
        status: cleanText(body.status) || "DRAFT",
      },
    });

    return NextResponse.json(balance, { status: 201 });
  } catch (error) {
    console.error("Error creating opening balance:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = cleanText(body.id);

    if (!id) {
      return NextResponse.json({ error: "Thiếu ID số dư" }, { status: 400 });
    }

    const current = await prisma.openingBalance.findUnique({
      where: { id },
    });

    if (!current) {
      return NextResponse.json({ error: "Không tìm thấy số dư đầu kỳ" }, { status: 404 });
    }

    if (current.status === "CONFIRMED" && body.status !== "DRAFT") {
      return NextResponse.json({ error: "Không thể chỉnh sửa số dư đầu kỳ đã chốt" }, { status: 400 });
    }

    const balance = await prisma.openingBalance.update({
      where: { id },
      data: {
        ...(body.period !== undefined ? { period: cleanText(body.period) } : {}),
        ...(body.branchCode !== undefined ? { branchCode: cleanText(body.branchCode) } : {}),
        ...(body.balanceType !== undefined ? { balanceType: cleanText(body.balanceType) } : {}),
        ...(body.objectCode !== undefined ? { objectCode: cleanText(body.objectCode) || null } : {}),
        ...(body.objectName !== undefined ? { objectName: cleanText(body.objectName) || null } : {}),
        ...(body.moneySourceCode !== undefined
          ? { moneySourceCode: cleanText(body.moneySourceCode) || null }
          : {}),
        ...(body.amount !== undefined ? { amount: toAmount(body.amount) } : {}),
        ...(body.note !== undefined ? { note: cleanText(body.note) || null } : {}),
        ...(body.status !== undefined ? { status: cleanText(body.status) || "DRAFT" } : {}),
      },
    });

    return NextResponse.json(balance);
  } catch (error) {
    console.error("Error updating opening balance:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
