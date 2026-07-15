import { NextResponse } from "next/server";
import { isAdmin, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
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
    const auth = requireMenuAccess(request, "/opening-balances");
    if (!auth.ok) return auth.response;

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
    const auth = requireMenuAction(request, "/opening-balances", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const period = cleanText(body.period);
    const branchCode = cleanText(body.branchCode);
    const balanceType = cleanText(body.balanceType);
    const amount = toAmount(body.amount);
    const status = cleanText(body.status) || "DRAFT";

    if (!period || !branchCode || !balanceType) {
      return NextResponse.json({ error: "Kỳ, chi nhánh và loại số dư là bắt buộc" }, { status: 400 });
    }

    if (!["DRAFT", "CONFIRMED"].includes(status)) {
      return NextResponse.json({ error: "Trạng thái số dư không hợp lệ" }, { status: 400 });
    }

    const isSourceType = ["CASH", "BANK", "WALLET_POS"].includes(balanceType);
    const isObjectType = ["AR", "AP", "DEPOSIT"].includes(balanceType);

    const moneySourceCode = cleanText(body.moneySourceCode);
    const objectCode = cleanText(body.objectCode);
    const objectName = cleanText(body.objectName);

    if (isSourceType && !moneySourceCode) {
      return NextResponse.json({ error: "Đối với số dư quỹ/ngân hàng/ví, bắt buộc phải chọn Nguồn tiền" }, { status: 400 });
    }

    if (isObjectType && !objectCode) {
      return NextResponse.json({ error: "Đối với số dư công nợ/tiền cọc, bắt buộc phải chọn Đối tượng" }, { status: 400 });
    }

    // Verify master data status
    const activeBranch = await prisma.masterDataItem.findUnique({
      where: { type_code: { type: "BRANCH", code: branchCode } }
    });
    if (!activeBranch || activeBranch.status !== "ACTIVE") {
      return NextResponse.json({ error: `Chi nhánh [${branchCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
    }

    if (isSourceType && moneySourceCode) {
      const activeSource = await prisma.masterDataItem.findUnique({
        where: { type_code: { type: "MONEY_SOURCE", code: moneySourceCode } }
      });
      if (!activeSource || activeSource.status !== "ACTIVE") {
        return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
      }
    }

    if (isObjectType && objectCode) {
      const activePartner = await prisma.masterDataItem.findUnique({
        where: { type_code: { type: "PARTNER", code: objectCode } }
      });
      if (!activePartner || activePartner.status !== "ACTIVE") {
        return NextResponse.json({ error: `Đối tác [${objectCode}] không tồn tại hoặc ngưng hoạt động` }, { status: 400 });
      }
    }

    const balance = await prisma.openingBalance.create({
      data: {
        period,
        branchCode,
        balanceType,
        objectCode: isObjectType ? objectCode : null,
        objectName: isObjectType ? objectName : null,
        moneySourceCode: isSourceType ? moneySourceCode : null,
        amount,
        note: cleanText(body.note) || null,
        status,
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
    const auth = requireMenuAction(request, "/opening-balances", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);

    if (!id) {
      return NextResponse.json({ error: "Thieu ID so du" }, { status: 400 });
    }

    const current = await prisma.openingBalance.findUnique({
      where: { id },
    });

    if (!current) {
      return NextResponse.json({ error: "Khong tim thay so du dau ky" }, { status: 404 });
    }

    const requestedStatus = body.status !== undefined ? cleanText(body.status) : undefined;
    const isReopenRequest = current.status === "CONFIRMED" && requestedStatus === "DRAFT";

    if (isReopenRequest && !isAdmin(auth.session.role)) {
      return NextResponse.json({ error: "Chi Admin duoc mo lai so du da chot" }, { status: 403 });
    }

    if (current.status === "CONFIRMED" && !isReopenRequest) {
      return NextResponse.json({ error: "Khong the chinh sua so du dau ky da chot" }, { status: 400 });
    }

    if (requestedStatus && !["DRAFT", "CONFIRMED"].includes(requestedStatus)) {
      return NextResponse.json({ error: "Trang thai so du khong hop le" }, { status: 400 });
    }

    const balance = await prisma.openingBalance.update({
      where: { id },
      data: isReopenRequest
        ? { status: "DRAFT" }
        : {
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
            ...(requestedStatus !== undefined ? { status: requestedStatus || "DRAFT" } : {}),
          },
    });

    return NextResponse.json(balance);
  } catch (error) {
    console.error("Error updating opening balance:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
