import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { applyVoucherSideEffects } from "@/lib/voucher-side-effects";
import { revertVoucherSideEffects, VoucherRevertError } from "@/lib/voucher-revert";
import { isPeriodLocked } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { duplicatedInTrashMessage, findDeletedByUnique, softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import type { DemoSession } from "@/lib/auth-demo";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";

/** Trạng thái không cho sửa/xoá vì chứng từ đã ghi sổ. */
const lockedVoucherStatuses = ["APPROVED", "POSTED"];

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function normalizeVoucherCategoryGroup(group: string | null | undefined) {
  const raw = (group || "").toUpperCase();
  if (raw.includes("REVENUE") || raw.includes("DOANH") || raw.includes("NGUON")) return "REVENUE_SOURCE";
  if (raw.includes("COGS") || raw.includes("GIA")) return "COGS";
  if (raw.includes("CAPEX")) return "CAPEX";
  if (raw.includes("OPEX")) return "OPEX";
  return raw;
}

function categoryAllowedForVoucher(voucherType: string, group: string | null | undefined) {
  const normalizedGroup = normalizeVoucherCategoryGroup(group);
  return voucherType === "RECEIPT"
    ? normalizedGroup === "REVENUE_SOURCE"
    : ["OPEX", "CAPEX", "COGS"].includes(normalizedGroup);
}

async function validateVoucherCategory(voucherType: string, categoryCode: string) {
  const category = await prisma.masterDataItem.findFirst({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: categoryCode, status: "ACTIVE" },
  });
  if (!category) return `Khoản mục thu/chi [${categoryCode}] không tồn tại hoặc đã ngưng hoạt động`;
  if (!categoryAllowedForVoucher(voucherType, category.group)) {
    return voucherType === "RECEIPT"
      ? "Phiếu thu chỉ được chọn khoản mục nhóm nguồn doanh thu"
      : "Phiếu chi chỉ được chọn khoản mục nhóm OPEX, CAPEX hoặc giá vốn";
  }
  return null;
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
    const categoryCode = cleanText(body.categoryCode);
    const amount = toAmount(body.amount);
    const description = cleanText(body.description);

    if (!["RECEIPT", "PAYMENT"].includes(voucherType)) {
      return NextResponse.json({ error: "Loại chứng từ không hợp lệ" }, { status: 400 });
    }
    if (!partnerName || !branchCode || !moneySourceCode || !categoryCode || amount <= 0 || !description) {
      return NextResponse.json({ error: "Thiếu đối tác, chi nhánh, nguồn tiền, số tiền hoặc nội dung" }, { status: 400 });
    }

    try {
      assertBranchAccess(auth.session, branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
    }

    const activeSource = await prisma.masterDataItem.findFirst({
      where: { type: "MONEY_SOURCE", code: moneySourceCode, status: "ACTIVE" },
    });
    if (!activeSource || !moneySourceMatchesBranch(activeSource, branchCode)) {
      return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn` }, { status: 400 });
    }

    if (normalizeMoneySourceGroup(activeSource.group) !== "CASH") {
      return NextResponse.json({ error: "Phiếu thu/chi chỉ được chọn nguồn tiền mặt" }, { status: 400 });
    }

    const categoryError = await validateVoucherCategory(voucherType, categoryCode);
    if (categoryError) return NextResponse.json({ error: categoryError }, { status: 400 });

    const voucherDate = body.voucherDate ? new Date(String(body.voucherDate)) : new Date();
    const code = await nextVoucherCode(voucherType, voucherDate, branchCode);

    // Mã sinh tự động có thể trùng với chứng từ đang nằm trong thùng rác -> báo rõ để xử lý.
    const trashedVoucher = await findDeletedByUnique("FinancialVoucher", { code });
    if (trashedVoucher) {
      return NextResponse.json({ error: duplicatedInTrashMessage(code, "Chứng từ") }, { status: 400 });
    }

    const voucher = await prisma.financialVoucher.create({
      data: {
        code,
        voucherType,
        voucherDate,
        partnerCode: cleanText(body.partnerCode) || null,
        partnerName,
        branchCode,
        moneySourceCode,
        categoryCode,
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

/**
 * Sửa thông tin nghiệp vụ của chứng từ chưa ghi sổ.
 * Trường nào không gửi lên thì giữ nguyên giá trị cũ.
 */
async function updateVoucher(session: DemoSession, id: string, body: Record<string, unknown>) {
  const current = await prisma.financialVoucher.findUnique({ where: { id } });
  if (!current) return NextResponse.json({ error: "Không tìm thấy chứng từ" }, { status: 404 });

  try {
    assertBranchAccess(session, current.branchCode);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
  }

  if (lockedVoucherStatuses.includes(current.status)) {
    return NextResponse.json(
      { error: "Chứng từ đã duyệt/ghi sổ, không thể sửa. Hãy hủy chứng từ và lập chứng từ mới." },
      { status: 400 },
    );
  }
  if (current.status === "CANCELLED") {
    return NextResponse.json({ error: "Chứng từ đã hủy, không thể sửa" }, { status: 400 });
  }

  const voucherType = cleanText(body.voucherType);
  if (voucherType && voucherType !== current.voucherType) {
    return NextResponse.json(
      { error: "Không thể đổi loại chứng từ thu/chi vì mã chứng từ đã sinh theo loại. Hãy hủy chứng từ và lập chứng từ mới." },
      { status: 400 },
    );
  }

  const partnerName = body.partnerName === undefined ? current.partnerName : cleanText(body.partnerName);
  const branchCode = body.branchCode === undefined ? current.branchCode : cleanText(body.branchCode);
  const moneySourceCode = body.moneySourceCode === undefined ? current.moneySourceCode : cleanText(body.moneySourceCode);
  const description = body.description === undefined ? current.description : cleanText(body.description);
  const amount = body.amount === undefined ? current.amount : toAmount(body.amount);
  const partnerCode = body.partnerCode === undefined ? current.partnerCode : cleanText(body.partnerCode) || null;
  const categoryCode = body.categoryCode === undefined ? current.categoryCode || "" : cleanText(body.categoryCode);
  const voucherDate = body.voucherDate === undefined ? current.voucherDate : new Date(String(body.voucherDate));

  if (Number.isNaN(voucherDate.getTime())) {
    return NextResponse.json({ error: "Ngày chứng từ không hợp lệ" }, { status: 400 });
  }
  if (!partnerName || !branchCode || !moneySourceCode || !categoryCode || amount <= 0 || !description) {
    return NextResponse.json({ error: "Thiếu đối tác, chi nhánh, nguồn tiền, số tiền hoặc nội dung" }, { status: 400 });
  }

  try {
    assertBranchAccess(session, branchCode);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
  }

  // Chứng từ đã sinh xử lý cọc/công nợ thì sửa lại sẽ làm lệch số liệu -> chặn hẳn.
  const activeSource = await prisma.masterDataItem.findFirst({
    where: { type: "MONEY_SOURCE", code: moneySourceCode, status: "ACTIVE" },
  });
  if (!activeSource || !moneySourceMatchesBranch(activeSource, branchCode)) {
    return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn` }, { status: 400 });
  }

  if (normalizeMoneySourceGroup(activeSource.group) !== "CASH") {
    return NextResponse.json({ error: "Phiếu thu/chi chỉ được chọn nguồn tiền mặt" }, { status: 400 });
  }

  const categoryError = await validateVoucherCategory(current.voucherType, categoryCode);
  if (categoryError) return NextResponse.json({ error: categoryError }, { status: 400 });

  const [depositHistoryCount, debtSettlement] = await Promise.all([
    prisma.depositHistory.count({ where: { voucherId: id } }),
    prisma.debtSettlement.findUnique({ where: { voucherId: id } }),
  ]);
  if (depositHistoryCount > 0 || debtSettlement) {
    return NextResponse.json(
      { error: "Chứng từ đã phát sinh xử lý tiền cọc hoặc thanh toán công nợ, không thể sửa. Hãy hủy chứng từ và lập chứng từ mới." },
      { status: 400 },
    );
  }

  const [currentPeriodLocked, nextPeriodLocked] = await Promise.all([
    isPeriodLocked(current.voucherDate, current.branchCode),
    isPeriodLocked(voucherDate, branchCode),
  ]);
  if (currentPeriodLocked || nextPeriodLocked) {
    return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể sửa chứng từ" }, { status: 400 });
  }

  const voucher = await prisma.financialVoucher.update({
    where: { id },
    data: {
      voucherDate,
      partnerCode,
      partnerName,
      branchCode,
      moneySourceCode,
      categoryCode,
      amount,
      description,
    },
  });

  await writeAuditLog({
    session,
    module: "VOUCHERS",
    action: "UPDATE",
    entityType: "FinancialVoucher",
    entityId: voucher.id,
    entityCode: voucher.code,
    branchCode: voucher.branchCode,
    metadata: {
      before: { voucherDate: current.voucherDate, partnerCode: current.partnerCode, partnerName: current.partnerName, branchCode: current.branchCode, moneySourceCode: current.moneySourceCode, categoryCode: current.categoryCode, amount: current.amount, description: current.description },
      after: { voucherDate, partnerCode, partnerName, branchCode, moneySourceCode, categoryCode, amount, description },
    },
  });

  return NextResponse.json(voucher);
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    // Không truyền action thì giữ nguyên hành vi cũ: duyệt/hủy chứng từ.
    const action = cleanText(body.action) || "STATUS_CHANGE";
    const auth = requireMenuAction(request, "/vouchers", action === "UPDATE" ? "edit" : "approve");
    if (!auth.ok) return auth.response;

    const id = cleanText(body.id);
    if (!id) return NextResponse.json({ error: "Thiếu ID chứng từ" }, { status: 400 });

    if (action === "UPDATE") return await updateVoucher(auth.session, id, body);

    const status = cleanText(body.status) || "APPROVED";
    if (!["APPROVED", "CANCELLED", "DRAFT"].includes(status)) {
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

    // Bỏ duyệt: đưa chứng từ về bản nháp để sửa lại, đồng thời trả lại mọi hệ quả
    // mà lần duyệt trước đã sinh ra (tiền cọc, công nợ, khoản phân bổ).
    if (status === "DRAFT") {
      if (current.status !== "APPROVED") {
        return NextResponse.json({ error: "Chỉ bỏ duyệt được chứng từ đang ở trạng thái đã duyệt" }, { status: 400 });
      }
      if (await isPeriodLocked(current.voucherDate, current.branchCode)) {
        return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể bỏ duyệt chứng từ" }, { status: 400 });
      }

      try {
        const reverted = await prismaRaw.$transaction(async (tx) => {
          await revertVoucherSideEffects(tx, current);
          return tx.financialVoucher.update({
            where: { id },
            data: { status: "DRAFT", approvedBy: null },
          });
        });

        await writeAuditLog({
          session: auth.session,
          module: "VOUCHERS",
          action: "UNAPPROVE_VOUCHER",
          entityType: "FinancialVoucher",
          entityId: reverted.id,
          entityCode: reverted.code,
          branchCode: reverted.branchCode,
          metadata: {
            amount: reverted.amount,
            previousApprovedBy: current.approvedBy,
            depositAction: current.depositAction,
            debtAction: current.debtAction,
            allocationMonths: current.allocationMonths,
            reason: cleanText(body.reason) || null,
          },
        });
        return NextResponse.json(reverted);
      } catch (e) {
        if (e instanceof VoucherRevertError) {
          return NextResponse.json({ error: e.message }, { status: 400 });
        }
        throw e;
      }
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

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/vouchers", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id) return NextResponse.json({ error: "Thiếu ID chứng từ" }, { status: 400 });

    const current = await prisma.financialVoucher.findUnique({ where: { id } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy chứng từ" }, { status: 404 });

    try {
      assertBranchAccess(auth.session, current.branchCode);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
    }

    if (lockedVoucherStatuses.includes(current.status)) {
      return NextResponse.json(
        { error: "Chứng từ đã duyệt/ghi sổ, không thể xóa. Hãy hủy chứng từ trước khi xóa." },
        { status: 400 },
      );
    }

    if (await isPeriodLocked(current.voucherDate, current.branchCode)) {
      return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể xóa chứng từ" }, { status: 400 });
    }

    // Giữ lại chứng từ đã sinh xử lý cọc/công nợ để không làm lệch số dư.
    const [depositHistoryCount, debtSettlement] = await Promise.all([
      prisma.depositHistory.count({ where: { voucherId: id } }),
      prisma.debtSettlement.findUnique({ where: { voucherId: id } }),
    ]);
    if (depositHistoryCount > 0 || debtSettlement) {
      return NextResponse.json(
        { error: "Chứng từ đã phát sinh xử lý tiền cọc hoặc thanh toán công nợ, không thể xóa." },
        { status: 400 },
      );
    }

    await softDeleteRecord({ model: "FinancialVoucher", id, session: auth.session, reason });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting voucher:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
