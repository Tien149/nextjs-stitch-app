import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { applyVoucherSideEffects } from "@/lib/voucher-side-effects";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

import { generateFormattedVoucherCode, formatVoucherPrefix } from "@/lib/voucher-code-generator";

async function nextVoucherCode(voucherType: string, voucherDate?: Date | string | null, branchCode?: string | null) {
  const d = voucherDate ? new Date(voucherDate) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const startOfMonth = new Date(validDate.getFullYear(), validDate.getMonth(), 1);
  const endOfMonth = new Date(validDate.getFullYear(), validDate.getMonth() + 1, 1);
  const prefix = formatVoucherPrefix(voucherType);

  const count = await prisma.financialVoucher.count({
    where: {
      voucherType,
      ...(branchCode ? { branchCode } : {}),
      voucherDate: { gte: startOfMonth, lt: endOfMonth },
      code: { startsWith: prefix },
    },
  });

  return generateFormattedVoucherCode({
    voucherType,
    voucherDate: validDate,
    branchCode,
    seqNumber: count + 1,
  });
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/vouchers");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id") || undefined;
    if (id) {
      const voucher = await prisma.financialVoucher.findUnique({ where: { id } });
      if (!voucher) return NextResponse.json({ error: "Không tìm thấy chứng từ" }, { status: 404 });
      try {
        assertBranchAccess(auth.session, voucher.branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }
      return NextResponse.json(voucher);
    }

    const branchCode = requestedBranch(auth.session, cleanText(searchParams.get("branchCode")) || "ALL");
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };

    const vouchers = await prisma.financialVoucher.findMany({
      where: { ...branchFilter },
      orderBy: { voucherDate: "desc" },
      take: 100,
    });
    return NextResponse.json(vouchers);
  } catch (error) {
    console.error("Error fetching vouchers:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/vouchers", "create");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const voucherType = cleanText(body.voucherType) || "RECEIPT";
    const partnerName = cleanText(body.partnerName);
    const branchCode = cleanText(body.branchCode);
    const moneySourceCode = cleanText(body.moneySourceCode);
    const amount = toAmount(body.amount);
    const description = cleanText(body.description);

    if (!["RECEIPT", "PAYMENT"].includes(voucherType)) {
      return NextResponse.json({ error: "Loại chứng từ không hợp lệ" }, { status: 400 });
    }
    if (!partnerName || !branchCode || !moneySourceCode || amount <= 0 || !description) {
      return NextResponse.json({ error: "Thiếu đối tác, chi nhánh, nguồn tiền, số tiền hoặc nội dung" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
    }

    const voucherDate = body.voucherDate ? new Date(String(body.voucherDate)) : new Date();

    const voucher = await prisma.financialVoucher.create({
      data: {
        code: await nextVoucherCode(voucherType, voucherDate, branchCode),
        voucherType,
        voucherDate,
        partnerCode: cleanText(body.partnerCode) || null,
        partnerName,
        branchCode,
        moneySourceCode,
        categoryCode: cleanText(body.categoryCode) || null,
        amount,
        description,
        status: cleanText(body.status) || "DRAFT",
        createdBy: auth.session.name,
      },
    });

    return NextResponse.json(voucher, { status: 201 });
  } catch (error) {
    console.error("Error creating voucher:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/vouchers", "approve");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const id = cleanText(body.id);
    const status = cleanText(body.status) || "APPROVED";
    if (!id) return NextResponse.json({ error: "Thiếu ID chứng từ" }, { status: 400 });
    if (!["APPROVED", "CANCELLED"].includes(status)) {
      return NextResponse.json({ error: "Trạng thái chứng từ không hợp lệ" }, { status: 400 });
    }

    const current = await prisma.financialVoucher.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy chứng từ" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
    }

    if (current.status === "APPROVED" && status === "APPROVED") {
      return NextResponse.json({ error: "Chứng từ đã được duyệt" }, { status: 400 });
    }
    if (current.status === "CANCELLED") {
      return NextResponse.json({ error: "Chứng từ đã hủy, không thể đổi trạng thái" }, { status: 400 });
    }

    const voucher = await prisma.$transaction(async (tx) => {
      if (status === "APPROVED") await applyVoucherSideEffects(tx, current, auth.session.name);
      return tx.financialVoucher.update({
        where: { id },
        data: {
          status,
          approvedBy: status === "APPROVED" ? auth.session.name : null,
        },
      });
    });

    return NextResponse.json(voucher);
  } catch (error) {
    console.error("Error updating voucher:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
