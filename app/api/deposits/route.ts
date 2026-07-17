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

async function nextDepositCode() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const count = await prisma.deposit.count();
  return `COC-${year}${month}-${String(count + 1).padStart(3, "0")}`;
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/deposits");
    if (!auth.ok) return auth.response;

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
    const auth = requireMenuAction(request, "/deposits", "create");
    if (!auth.ok) return auth.response;

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

    // Verify master data status
    const activeBranch = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "BRANCH", code: branchCode } }
    });
    if (!activeBranch || activeBranch.status !== "ACTIVE") {
      return NextResponse.json({ error: `Chi nhánh [${branchCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    const activePartner = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "PARTNER", code: partnerCode } }
    });
    if (!activePartner || activePartner.status !== "ACTIVE") {
      return NextResponse.json({ error: `Khách hàng [${partnerCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    const activeSource = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "MONEY_SOURCE", code: moneySourceCode } }
    });
    if (!activeSource || activeSource.status !== "ACTIVE") {
      return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    const code = await nextDepositCode();
    const deposit = await prisma.deposit.create({
      data: {
        code,
        receivedDate: body.receivedDate ? new Date(String(body.receivedDate)) : new Date(),
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
            actor: auth.session.name,
            note: "Ghi nhan tien coc",
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
    const auth = requireMenuAction(request, "/deposits", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);
    const action = cleanText(body.action);
    const actionAmount = toAmount(body.amount);
    const note = cleanText(body.note) || null;

    if (!id || !action) {
      return NextResponse.json({ error: "Thieu ID hoac thao tac xu ly" }, { status: 400 });
    }

    const current = await prisma.deposit.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ error: "Khong tim thay phieu coc" }, { status: 404 });
    }

    if (current.remainingAmount <= 0) {
      return NextResponse.json({ error: "Phieu coc da het so du xu ly" }, { status: 400 });
    }

    let status = current.status;
    let remainingAmount = current.remainingAmount;
    let historyAmount: number | null = null;

    if (action === "OFFSET") {
      if (actionAmount <= 0 || actionAmount > current.remainingAmount) {
        return NextResponse.json({ error: "So tien can tru khong hop le" }, { status: 400 });
      }
      remainingAmount = current.remainingAmount - actionAmount;
      status = remainingAmount === 0 ? "OFFSET" : "HOLDING";
      historyAmount = actionAmount;
    } else if (action === "REFUND") {
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
      return NextResponse.json({ error: "Thao tac khong ho tro" }, { status: 400 });
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
            actor: auth.session.name,
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
