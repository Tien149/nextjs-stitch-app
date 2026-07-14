import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

async function nextDepositCode() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const count = await prisma.deposit.count();
  return `COC-${year}${month}-${String(count + 1).padStart(3, "0")}`;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;
    const search = searchParams.get("search")?.trim();

    const deposits = await prisma.deposit.findMany({
      where: {
        ...(status && status !== "ALL" ? { status } : {}),
        ...(search
          ? {
              OR: [
                { code: { contains: search } },
                { partnerCode: { contains: search } },
                { partnerName: { contains: search } },
                { purpose: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        histories: {
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { receivedDate: "desc" },
    });

    return NextResponse.json(deposits);
  } catch (error) {
    console.error("Error fetching deposits:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const partnerCode = cleanText(body.partnerCode);
    const partnerName = cleanText(body.partnerName);
    const branchCode = cleanText(body.branchCode);
    const moneySourceCode = cleanText(body.moneySourceCode);
    const purpose = cleanText(body.purpose);
    const amount = toAmount(body.amount);

    if (!partnerCode || !partnerName || !branchCode || !moneySourceCode || !purpose || amount <= 0) {
      return NextResponse.json(
        { error: "Thiếu khách hàng, chi nhánh, nguồn tiền, nội dung hoặc số tiền không hợp lệ" },
        { status: 400 },
      );
    }

    const code = await nextDepositCode();
    const deposit = await prisma.deposit.create({
      data: {
        code,
        partnerCode,
        partnerName,
        branchCode,
        moneySourceCode,
        amount,
        remainingAmount: amount,
        purpose,
        note: cleanText(body.note) || null,
        histories: {
          create: {
            action: "CREATE",
            amount,
            actor: cleanText(body.actor) || "Demo user",
            note: "Ghi nhận tiền cọc",
          },
        },
      },
      include: { histories: true },
    });

    return NextResponse.json(deposit, { status: 201 });
  } catch (error) {
    console.error("Error creating deposit:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const id = cleanText(body.id);
    const action = cleanText(body.action);
    const actionAmount = toAmount(body.amount);
    const actor = cleanText(body.actor) || "Demo user";
    const note = cleanText(body.note) || null;

    if (!id || !action) {
      return NextResponse.json({ error: "Thiếu ID hoặc thao tác xử lý" }, { status: 400 });
    }

    const current = await prisma.deposit.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Không tìm thấy phiếu cọc" }, { status: 404 });
    }

    let status = current.status;
    let remainingAmount = current.remainingAmount;
    let historyAmount: number | null = null;

    if (action === "OFFSET") {
      if (actionAmount <= 0 || actionAmount > current.remainingAmount) {
        return NextResponse.json({ error: "Số tiền cấn trừ không hợp lệ" }, { status: 400 });
      }
      remainingAmount = current.remainingAmount - actionAmount;
      status = remainingAmount === 0 ? "OFFSET" : "HOLDING";
      historyAmount = actionAmount;
    } else if (action === "REFUND") {
      if (current.remainingAmount <= 0) {
        return NextResponse.json({ error: "Phiếu cọc không còn số dư để hoàn" }, { status: 400 });
      }
      historyAmount = current.remainingAmount;
      remainingAmount = 0;
      status = "REFUNDED";
    } else if (action === "CANCEL") {
      historyAmount = current.remainingAmount;
      remainingAmount = 0;
      status = "CANCELLED";
    } else if (action === "TRANSFER_REVENUE") {
      historyAmount = current.remainingAmount;
      remainingAmount = 0;
      status = "REVENUE";
    } else {
      return NextResponse.json({ error: "Thao tác không hỗ trợ" }, { status: 400 });
    }

    const deposit = await prisma.deposit.update({
      where: { id },
      data: {
        status,
        remainingAmount,
        histories: {
          create: {
            action,
            amount: historyAmount,
            actor,
            note,
          },
        },
      },
      include: {
        histories: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return NextResponse.json(deposit);
  } catch (error) {
    console.error("Error updating deposit:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
