import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { applyVoucherSideEffects } from "@/lib/voucher-side-effects";
import { revertVoucherSideEffects, VoucherRevertError } from "@/lib/voucher-revert";
import { isPeriodLocked } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { duplicatedInTrashMessage, findDeletedByUnique, softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import { canPerformMenuAction, type DemoSession } from "@/lib/auth-demo";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { normalizeCashflowCategoryType, normalizeReceiptPurpose, validateReceiptPurpose, voucherEditWindowError } from "@/lib/voucher-rules";

/** Trạng thái không cho sửa/xoá vì chứng từ đã ghi sổ. */

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function categoryAllowedForVoucher(voucherType: string, group: string | null | undefined) {
  return normalizeCashflowCategoryType(group) === voucherType;
}

async function validateVoucherCategory(voucherType: string, categoryCode: string) {
  const category = await prisma.masterDataItem.findFirst({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: categoryCode, status: "ACTIVE" },
  });
  if (!category) return `Khoản mục thu/chi [${categoryCode}] không tồn tại hoặc đã ngưng hoạt động`;
  if (!categoryAllowedForVoucher(voucherType, category.group)) {
    return voucherType === "RECEIPT"
      ? "Phiếu thu chỉ được chọn danh mục loại Thu"
      : "Phiếu chi chỉ được chọn danh mục loại Chi";
  }
  return null;
}

async function validateVoucherPnlItem(voucherType: string, pnlItemCode: string, requireActive = true) {
  if (voucherType !== "PAYMENT") return "Chỉ phiếu chi mới được chọn hạng mục P&L chi phí";
  const pnlItem = await prisma.masterDataItem.findFirst({
    where: {
      type: "PNL_ITEM",
      code: pnlItemCode,
      ...(requireActive ? { status: "ACTIVE" } : {}),
    },
  });
  if (!pnlItem) return `Hạng mục P&L [${pnlItemCode}] không tồn tại hoặc đã ngừng hoạt động`;
  const group = (pnlItem.group || "").toUpperCase();
  if (!["OPEX", "COGS"].includes(group)) {
    return "Phiếu chi chỉ được chọn hạng mục P&L thuộc nhóm OPEX hoặc Giá vốn";
  }
  return null;
}

import { generateFormattedVoucherCode, formatVoucherPrefix } from "@/lib/voucher-code-generator";
import { isWorkShift } from "@/lib/shifts";

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
    const pnlItemCode = voucherType === "PAYMENT" ? cleanText(body.pnlItemCode) : "";
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

    const activeSource = await prisma.masterDataItem.findFirst({
      where: { type: "MONEY_SOURCE", code: moneySourceCode, status: "ACTIVE" },
    });
    if (!activeSource || !moneySourceMatchesBranch(activeSource, branchCode)) {
      return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn` }, { status: 400 });
    }

    if (normalizeMoneySourceGroup(activeSource.group) !== "CASH") {
      return NextResponse.json({ error: "Phiếu thu/chi chỉ được chọn nguồn tiền mặt" }, { status: 400 });
    }

    if (categoryCode) {
      const categoryError = await validateVoucherCategory(voucherType, categoryCode);
      if (categoryError) return NextResponse.json({ error: categoryError }, { status: 400 });
    }
    if (pnlItemCode) {
      const pnlItemError = await validateVoucherPnlItem(voucherType, pnlItemCode);
      if (pnlItemError) return NextResponse.json({ error: pnlItemError }, { status: 400 });
    }

    const voucherDate = body.voucherDate ? new Date(String(body.voucherDate)) : new Date();
    const shiftValue = cleanText(body.shift).toUpperCase();
    if (shiftValue && !isWorkShift(shiftValue)) {
      return NextResponse.json({ error: "Ca làm việc không hợp lệ" }, { status: 400 });
    }

    const depositAction = normalizeReceiptPurpose(voucherType, body.depositAction);
    const purposeError = validateReceiptPurpose(voucherType, body.depositAction, cleanText(body.partnerCode));
    if (purposeError) return NextResponse.json({ error: purposeError }, { status: 400 });
    const code = await nextVoucherCode(voucherType, voucherDate, branchCode);

    // Mã sinh tự động có thể trùng với chứng từ đang nằm trong thùng rác -> báo rõ để xử lý.
    const trashedVoucher = await findDeletedByUnique("FinancialVoucher", { code });
    if (trashedVoucher) {
      return NextResponse.json({ error: duplicatedInTrashMessage(code, "Chứng từ") }, { status: 400 });
    }

    // Lập phiếu là duyệt luôn: thu ngân không phải chờ ai bấm duyệt mới lên sổ.
    // Muốn sửa thì bỏ duyệt rồi sửa, theo cửa sổ sửa trong ngày ở updateVoucher.
    const requestedStatus = cleanText(body.status).toUpperCase();
    const status = requestedStatus === "DRAFT" ? "DRAFT" : "APPROVED";

    const voucher = await prisma.$transaction(async (tx) => {
      const created = await tx.financialVoucher.create({
        data: {
          code,
          voucherType,
          voucherDate,
          shift: shiftValue || null,
          depositAction: depositAction || null,
          depositCode: depositAction ? (cleanText(body.depositCode) || null) : null,
          partnerCode: cleanText(body.partnerCode) || null,
          partnerName,
          branchCode,
          moneySourceCode,
          categoryCode: categoryCode || null,
          pnlItemCode: pnlItemCode || null,
          amount,
          description,
          status,
          createdBy: auth.session.name,
          approvedBy: status === "APPROVED" ? auth.session.name : null,
        },
      });
      if (status === "APPROVED") await applyVoucherSideEffects(tx, created, auth.session.name);
      return created;
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

  if (current.status === "POSTED") {
    return NextResponse.json({ error: "Chứng từ đã ghi sổ, không thể sửa." }, { status: 400 });
  }
  if (current.status === "CANCELLED") {
    return NextResponse.json({ error: "Chứng từ đã hủy, không thể sửa" }, { status: 400 });
  }

  // Phiếu duyệt ngay khi tạo, nên sửa trong ngày là chuyện bình thường; qua ngày thì phải
  // có quyền edit_past. Chặn ở đây thay vì chặn cứng theo trạng thái "đã duyệt".
  const windowError = voucherEditWindowError(
    current.voucherDate,
    canPerformMenuAction(session, "/vouchers", "edit_past"),
  );
  if (windowError) return NextResponse.json({ error: windowError }, { status: 403 });

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
  const pnlItemCode = current.voucherType === "PAYMENT"
    ? (body.pnlItemCode === undefined ? current.pnlItemCode || "" : cleanText(body.pnlItemCode))
    : "";
  const voucherDate = body.voucherDate === undefined ? current.voucherDate : new Date(String(body.voucherDate));
  const shiftValue = body.shift === undefined ? current.shift : (cleanText(body.shift).toUpperCase() || null);
  if (shiftValue && !isWorkShift(shiftValue)) {
    return NextResponse.json({ error: "Ca làm việc không hợp lệ" }, { status: 400 });
  }

  const depositAction = current.voucherType !== "RECEIPT"
    ? null
    : (body.depositAction === undefined ? current.depositAction : (normalizeReceiptPurpose(current.voucherType, body.depositAction) || null));
  const purposeError = validateReceiptPurpose(current.voucherType, depositAction, partnerCode);
  if (purposeError) return NextResponse.json({ error: purposeError }, { status: 400 });

  if (Number.isNaN(voucherDate.getTime())) {
    return NextResponse.json({ error: "Ngày chứng từ không hợp lệ" }, { status: 400 });
  }
  if (!partnerName || !branchCode || !moneySourceCode || amount <= 0 || !description) {
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

  if (categoryCode) {
    const categoryError = await validateVoucherCategory(current.voucherType, categoryCode);
    if (categoryError) return NextResponse.json({ error: categoryError }, { status: 400 });
  }
  if (pnlItemCode) {
    const pnlItemError = await validateVoucherPnlItem(
      current.voucherType,
      pnlItemCode,
      pnlItemCode !== current.pnlItemCode,
    );
    if (pnlItemError) return NextResponse.json({ error: pnlItemError }, { status: 400 });
  }

  const [currentPeriodLocked, nextPeriodLocked] = await Promise.all([
    isPeriodLocked(current.voucherDate, current.branchCode),
    isPeriodLocked(voucherDate, branchCode),
  ]);
  if (currentPeriodLocked || nextPeriodLocked) {
    return NextResponse.json({ error: "Kỳ kế toán đã khóa, không thể sửa chứng từ" }, { status: 400 });
  }

  const data = {
    voucherDate,
    shift: shiftValue,
    depositAction,
    depositCode: depositAction ? (body.depositCode === undefined ? current.depositCode : (cleanText(body.depositCode) || null)) : null,
    partnerCode,
    partnerName,
    branchCode,
    moneySourceCode,
    categoryCode: categoryCode || null,
    pnlItemCode: pnlItemCode || null,
    amount,
    description,
  };

  /**
   * Chứng từ đã duyệt được sửa theo đúng trình tự thủ công: bỏ duyệt (trả lại cọc/công
   * nợ/phân bổ đã sinh) - sửa - duyệt lại.
   *
   * Hai bước dùng hai transaction vì hoàn tác phải chạy trên client thô (xoá hẳn bản ghi
   * hệ quả) còn ghi nhận lại chạy trên client thường. Nếu bước duyệt lại hỏng, chứng từ
   * nằm lại ở bản nháp với số liệu mới và người dùng thấy lỗi để duyệt lại — trạng thái
   * nhìn thấy được, không phải hỏng ngầm.
   */
  let voucher;
  try {
    if (current.status === "APPROVED") {
      await prismaRaw.$transaction(async (tx) => {
        await revertVoucherSideEffects(tx, current);
        await tx.financialVoucher.update({ where: { id }, data: { ...data, status: "DRAFT", approvedBy: null } });
      });
      voucher = await prisma.$transaction(async (tx) => {
        const reapproved = await tx.financialVoucher.findUniqueOrThrow({ where: { id } });
        await applyVoucherSideEffects(tx, reapproved, session.name);
        return tx.financialVoucher.update({
          where: { id },
          data: { status: "APPROVED", approvedBy: current.approvedBy || session.name },
        });
      });
    } else {
      voucher = await prisma.financialVoucher.update({ where: { id }, data });
    }
  } catch (e) {
    if (e instanceof VoucherRevertError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  await writeAuditLog({
    session,
    module: "VOUCHERS",
    action: "UPDATE",
    entityType: "FinancialVoucher",
    entityId: voucher.id,
    entityCode: voucher.code,
    branchCode: voucher.branchCode,
    metadata: {
      before: { voucherDate: current.voucherDate, shift: current.shift, partnerCode: current.partnerCode, partnerName: current.partnerName, branchCode: current.branchCode, moneySourceCode: current.moneySourceCode, categoryCode: current.categoryCode, pnlItemCode: current.pnlItemCode, amount: current.amount, description: current.description },
      after: { voucherDate, shift: shiftValue, partnerCode, partnerName, branchCode, moneySourceCode, categoryCode, pnlItemCode, amount, description },
    },
  });

  return NextResponse.json(voucher);
}

type StatusChangeResult = { ok: boolean; code?: string; error?: string };

/**
 * Đổi trạng thái một chứng từ. Tách riêng để nút đơn lẻ và thao tác hàng loạt dùng
 * chung đúng một bộ quy tắc, và để hàng loạt báo được lỗi của từng phiếu.
 */
async function changeVoucherStatus(
  session: DemoSession,
  id: string,
  status: string,
  reason: string | null,
): Promise<StatusChangeResult> {
  const current = await prisma.financialVoucher.findUnique({ where: { id } });
  if (!current) return { ok: false, error: "Không tìm thấy chứng từ" };

  try {
    assertBranchAccess(session, current.branchCode);
  } catch (e) {
    return { ok: false, code: current.code, error: e instanceof Error ? e.message : "Không có quyền chi nhánh" };
  }

  if (current.status === "APPROVED" && status === "APPROVED") {
    return { ok: false, code: current.code, error: "Chứng từ đã được duyệt" };
  }
  if (current.status === "CANCELLED") {
    return { ok: false, code: current.code, error: "Chứng từ đã hủy, không thể đổi trạng thái" };
  }

  // Bỏ duyệt/hủy chứng từ của ngày trước cũng nằm trong cửa sổ sửa như thao tác sửa.
  if (status !== "APPROVED") {
    const windowError = voucherEditWindowError(
      current.voucherDate,
      canPerformMenuAction(session, "/vouchers", "edit_past"),
      new Date(),
      status === "DRAFT" ? "bỏ duyệt" : "hủy",
    );
    if (windowError) return { ok: false, code: current.code, error: windowError };
  }

  // Bỏ duyệt: đưa chứng từ về bản nháp để sửa lại, đồng thời trả lại mọi hệ quả
  // mà lần duyệt trước đã sinh ra (tiền cọc, công nợ, khoản phân bổ).
  if (status === "DRAFT") {
    if (current.status !== "APPROVED") {
      return { ok: false, code: current.code, error: "Chỉ bỏ duyệt được chứng từ đang ở trạng thái đã duyệt" };
    }
    if (await isPeriodLocked(current.voucherDate, current.branchCode)) {
      return { ok: false, code: current.code, error: "Kỳ kế toán đã khóa, không thể bỏ duyệt chứng từ" };
    }

    try {
      const reverted = await prismaRaw.$transaction(async (tx) => {
        await revertVoucherSideEffects(tx, current);
        return tx.financialVoucher.update({ where: { id }, data: { status: "DRAFT", approvedBy: null } });
      });

      await writeAuditLog({
        session,
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
          reason,
        },
      });
      return { ok: true, code: reverted.code };
    } catch (e) {
      if (e instanceof VoucherRevertError) return { ok: false, code: current.code, error: e.message };
      throw e;
    }
  }

  const voucher = await prisma.$transaction(async (tx) => {
    if (status === "APPROVED") await applyVoucherSideEffects(tx, current, session.name);
    return tx.financialVoucher.update({
      where: { id },
      data: { status, approvedBy: status === "APPROVED" ? session.name : null },
    });
  });
  return { ok: true, code: voucher.code };
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    // Không truyền action thì giữ nguyên hành vi cũ: duyệt/hủy chứng từ.
    const action = cleanText(body.action) || "STATUS_CHANGE";
    const auth = requireMenuAction(request, "/vouchers", action === "UPDATE" ? "edit" : "approve");
    if (!auth.ok) return auth.response;

    const id = cleanText(body.id);
    if (action === "UPDATE") {
      if (!id) return NextResponse.json({ error: "Thiếu ID chứng từ" }, { status: 400 });
      return await updateVoucher(auth.session, id, body);
    }

    const status = cleanText(body.status) || "APPROVED";
    if (!["APPROVED", "CANCELLED", "DRAFT"].includes(status)) {
      return NextResponse.json({ error: "Trạng thái chứng từ không hợp lệ" }, { status: 400 });
    }
    const reason = cleanText(body.reason) || null;

    // Thao tác hàng loạt: chạy từng phiếu và trả về phiếu nào hỏng vì lý do gì,
    // thay vì bỏ dở cả lô khi gặp phiếu đầu tiên không hợp lệ.
    const ids = Array.isArray(body.ids) ? body.ids.map((value: unknown) => cleanText(value)).filter(Boolean) : [];
    if (ids.length > 0) {
      const results: Array<StatusChangeResult & { id: string }> = [];
      for (const itemId of ids) {
        results.push({ id: itemId, ...(await changeVoucherStatus(auth.session, itemId, status, reason)) });
      }
      return NextResponse.json({
        total: results.length,
        succeeded: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok),
      });
    }

    if (!id) return NextResponse.json({ error: "Thiếu ID chứng từ" }, { status: 400 });
    const result = await changeVoucherStatus(auth.session, id, status, reason);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json(await prisma.financialVoucher.findUnique({ where: { id } }));
  } catch (error) {
    console.error("Error updating voucher:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/** Xoá một chứng từ, dùng chung cho nút xoá đơn lẻ và xoá hàng loạt. */
async function deleteVoucherById(session: DemoSession, id: string, reason: string | null): Promise<StatusChangeResult> {
  const current = await prisma.financialVoucher.findUnique({ where: { id } });
  if (!current) return { ok: false, error: "Không tìm thấy chứng từ" };

  try {
    assertBranchAccess(session, current.branchCode);
  } catch (e) {
    return { ok: false, code: current.code, error: e instanceof Error ? e.message : "Không có quyền chi nhánh" };
  }

  if (current.status === "POSTED") {
    return { ok: false, code: current.code, error: "Chứng từ đã ghi sổ, không thể xóa." };
  }
  const windowError = voucherEditWindowError(
    current.voucherDate,
    canPerformMenuAction(session, "/vouchers", "edit_past"),
    new Date(),
    "xoá",
  );
  if (windowError) return { ok: false, code: current.code, error: windowError };

  if (await isPeriodLocked(current.voucherDate, current.branchCode)) {
    return { ok: false, code: current.code, error: "Kỳ kế toán đã khóa, không thể xóa chứng từ" };
  }

  // Chứng từ duyệt ngay khi tạo nên hầu hết phiếu xoá đều đang ở trạng thái đã duyệt:
  // phải trả lại hệ quả (cọc, công nợ, phân bổ) rồi mới xoá, nếu không số dư sẽ lệch.
  if (current.status === "APPROVED") {
    try {
      await prismaRaw.$transaction(async (tx) => {
        await revertVoucherSideEffects(tx, current);
        await tx.financialVoucher.update({ where: { id }, data: { status: "DRAFT", approvedBy: null } });
      });
    } catch (e) {
      if (e instanceof VoucherRevertError) return { ok: false, code: current.code, error: e.message };
      throw e;
    }
  }

  try {
    await softDeleteRecord({ model: "FinancialVoucher", id, session, reason });
  } catch (e) {
    if (e instanceof SoftDeleteError) return { ok: false, code: current.code, error: e.message };
    throw e;
  }
  return { ok: true, code: current.code };
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/vouchers", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const reason = cleanText(searchParams.get("reason")) || null;
    const ids = cleanText(searchParams.get("ids")).split(",").map((value) => value.trim()).filter(Boolean);

    if (ids.length > 0) {
      const results: Array<StatusChangeResult & { id: string }> = [];
      for (const itemId of ids) {
        results.push({ id: itemId, ...(await deleteVoucherById(auth.session, itemId, reason)) });
      }
      return NextResponse.json({
        total: results.length,
        succeeded: results.filter((row) => row.ok).length,
        failed: results.filter((row) => !row.ok),
      });
    }

    const id = cleanText(searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "Thiếu ID chứng từ" }, { status: 400 });
    const result = await deleteVoucherById(auth.session, id, reason);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting voucher:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
