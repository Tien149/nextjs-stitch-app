import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma, prismaRaw, type RawTxClient } from "@/lib/prisma";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { applyVoucherSideEffects } from "@/lib/voucher-side-effects";
import { revertVoucherSideEffects, VoucherRevertError } from "@/lib/voucher-revert";
import { isPeriodLocked } from "@/lib/phase3";
import { buildAuditLogData, writeAuditLog } from "@/lib/audit-log";
import { softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import { canEditPastVoucher, canPerformMenuAction, type DemoSession } from "@/lib/auth-demo";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { isSameCalendarDay, normalizeCashflowCategoryType, normalizeReceiptPurpose, validateReceiptPurpose, voucherEditWindowError } from "@/lib/voucher-rules";

/** Trạng thái không cho sửa/xoá vì chứng từ đã ghi sổ. */

class VoucherConflictError extends Error { }

const VOUCHER_CODE_RETRY_LIMIT = 5;

function isFinancialVoucherCodeUniqueError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const errObj = error as Record<string, unknown>;
  if (errObj.code !== "P2002") return false;

  const meta = errObj.meta && typeof errObj.meta === "object"
    ? errObj.meta as Record<string, unknown>
    : {};
  const target = Array.isArray(meta.target) ? meta.target.map(String) : [String(meta.target || "")];
  const modelName = String(meta.modelName || "");
  const message = typeof errObj.message === "string" ? errObj.message : "";

  return target.includes("code") && (modelName === "FinancialVoucher" || message.includes("FinancialVoucher"));
}

/** Chuẩn hóa thông báo lỗi thân thiện, rõ nghĩa cho người dùng cuối (loại bỏ mã kỹ thuật Prisma/DB thô). */
function formatApiErrorMessage(error: unknown, fallbackMessage = "Hệ thống gặp sự cố khi xử lý dữ liệu. Vui lòng thử lại."): string {
  if (typeof error === "string" && error.trim()) return error;
  if (!error || typeof error !== "object") return fallbackMessage;

  const errObj = error as Record<string, unknown>;

  // Chỉ gọi đúng tên lỗi sinh mã khi unique constraint thuộc FinancialVoucher.code.
  if (isFinancialVoucherCodeUniqueError(error)) {
    return "Không thể cấp mã chứng từ sau nhiều lần thử. Vui lòng tải lại trang và thử lại.";
  }
  if (errObj.code === "P2002") {
    return "Dữ liệu liên quan đã tồn tại trong hệ thống. Vui lòng kiểm tra lại thông tin vừa nhập.";
  }

  // Lỗi tham chiếu không tồn tại (Prisma P2003)
  if (errObj.code === "P2003") {
    return "Thông tin chi nhánh, nguồn tiền hoặc đối tác được chọn không hợp lệ hoặc đã ngưng sử dụng.";
  }

  // Thông báo lỗi nghiệp vụ từ Error object
  if (typeof errObj.message === "string" && errObj.message.trim()) {
    const rawMsg = errObj.message.trim();
    if (rawMsg.includes("PrismaClient") || rawMsg.includes("Invalid `") || rawMsg.includes("Invocation")) {
      return fallbackMessage;
    }
    return rawMsg;
  }

  return fallbackMessage;
}

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

import { formatBranchCode3, formatVoucherPrefix, formatYearMonth, generateFormattedVoucherCode } from "@/lib/voucher-code-generator";
import { isWorkShift } from "@/lib/shifts";

function voucherCodePrefix(voucherType: string, voucherDate: Date, branchCode: string) {
  return `${formatVoucherPrefix(voucherType)}-${formatYearMonth(voucherDate)}-${formatBranchCode3(branchCode)}-`;
}

async function nextVoucherCode(
  tx: RawTxClient,
  voucherType: string,
  voucherDate: Date,
  branchCode: string,
) {
  const d = voucherDate ? new Date(voucherDate) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const codePrefix = voucherCodePrefix(voucherType, validDate, branchCode);

  // Serialize việc cấp số cho cùng loại/tháng/cửa hàng. Lock chỉ tồn tại trong transaction.
  // pg_advisory_xact_lock() trả kiểu PostgreSQL `void`, Prisma 5 không deserialize
  // trực tiếp được. Bọc trong subquery để kết quả bên ngoài chỉ còn cột integer.
  await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1::integer AS "locked"
    FROM (SELECT pg_advisory_xact_lock(hashtext(${codePrefix}))) AS advisory_lock
  `;

  // Dùng client raw để tính cả mã của phiếu đã soft-delete hoặc bản ghi lịch sử bị lệch branch.
  const existingCodes = await tx.financialVoucher.findMany({
    where: { code: { startsWith: codePrefix } },
    select: { code: true },
  });

  const escapedPrefix = codePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codePattern = new RegExp(`^${escapedPrefix}(\\d{5})$`);
  const maxSeq = existingCodes.reduce((currentMax, row) => {
    const match = codePattern.exec(row.code);
    if (!match) return currentMax;
    const sequence = Number(match[1]);
    return Number.isSafeInteger(sequence) ? Math.max(currentMax, sequence) : currentMax;
  }, 0);

  if (maxSeq >= 99999) {
    throw new Error(`Dải số chứng từ ${codePrefix} đã hết. Vui lòng liên hệ quản trị hệ thống.`);
  }

  return generateFormattedVoucherCode({
    voucherType,
    voucherDate: validDate,
    branchCode,
    seqNumber: maxSeq + 1,
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

    // Phiếu tạo thủ công luôn được duyệt ngay. Không tin status do client gửi;
    // quy trình import dùng endpoint riêng nên không bị thay đổi bởi rule này.
    let voucher = null;
    for (let attempt = 1; attempt <= VOUCHER_CODE_RETRY_LIMIT; attempt += 1) {
      try {
        voucher = await prismaRaw.$transaction(async (tx) => {
          const code = await nextVoucherCode(tx, voucherType, voucherDate, branchCode);
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
              status: "APPROVED",
              createdBy: auth.session.name,
              approvedBy: auth.session.name,
            },
          });
          await applyVoucherSideEffects(tx, created, auth.session.name);
          await tx.auditLog.create({
            data: buildAuditLogData({
              session: auth.session,
              module: "VOUCHERS",
              action: "CREATE_AUTO_APPROVED",
              entityType: "FinancialVoucher",
              entityId: created.id,
              entityCode: created.code,
              branchCode: created.branchCode,
              metadata: { voucherType: created.voucherType, amount: created.amount, status: created.status },
            }),
          });
          return created;
        });
        break;
      } catch (error) {
        const canRetry = isFinancialVoucherCodeUniqueError(error) && attempt < VOUCHER_CODE_RETRY_LIMIT;
        if (canRetry) continue;
        throw error;
      }
    }

    if (!voucher) throw new Error("Không thể cấp mã chứng từ. Vui lòng thử lại.");

    return NextResponse.json(voucher, { status: 201 });
  } catch (error) {
    console.error("Error creating voucher:", error);
    const friendlyError = formatApiErrorMessage(error, "Không thể tạo chứng từ do sự cố dữ liệu. Vui lòng thử lại.");
    return NextResponse.json({ error: friendlyError }, { status: isFinancialVoucherCodeUniqueError(error) ? 409 : 500 });
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

  const now = new Date();
  const isOriginalDifferentBusinessDay = !isSameCalendarDay(current.voucherDate, now);
  const requestedVoucherDate = body.voucherDate === undefined ? current.voucherDate : new Date(String(body.voucherDate));
  if (Number.isNaN(requestedVoucherDate.getTime())) {
    return NextResponse.json({ error: "Ngày chứng từ không hợp lệ" }, { status: 400 });
  }
  const requiresPastEditReason = isOriginalDifferentBusinessDay || !isSameCalendarDay(requestedVoucherDate, now);
  const canEditPast = canEditPastVoucher(session);

  // Phiếu duyệt ngay khi tạo, nên sửa trong ngày là chuyện bình thường; qua ngày chỉ
  // Admin/KTTH có edit_past thật trong session mới được sửa.
  const windowError = voucherEditWindowError(
    current.voucherDate,
    canEditPast,
  );
  if (windowError) return NextResponse.json({ error: windowError }, { status: 403 });
  if (!isSameCalendarDay(requestedVoucherDate, now) && !canEditPast) {
    return NextResponse.json(
      { error: "Bạn không có quyền chuyển ngày chứng từ sang ngày khác ngày hiện tại" },
      { status: 403 },
    );
  }

  const editReason = cleanText(body.reason);
  if (requiresPastEditReason && editReason.length < 10) {
    return NextResponse.json(
      { error: "Vui lòng nhập lý do chỉnh sửa phiếu ngày cũ tối thiểu 10 ký tự" },
      { status: 400 },
    );
  }

  const expectedUpdatedAtText = cleanText(body.expectedUpdatedAt);
  const expectedUpdatedAt = new Date(expectedUpdatedAtText);
  if (!expectedUpdatedAtText || Number.isNaN(expectedUpdatedAt.getTime())) {
    return NextResponse.json({ error: "Thiếu phiên bản chứng từ. Vui lòng tải lại và thử lại." }, { status: 400 });
  }
  if (expectedUpdatedAt.getTime() !== current.updatedAt.getTime()) {
    return NextResponse.json(
      { error: "Phiếu đã được người khác cập nhật. Vui lòng tải lại trước khi tiếp tục." },
      { status: 409 },
    );
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
  const pnlItemCode = current.voucherType === "PAYMENT"
    ? (body.pnlItemCode === undefined ? current.pnlItemCode || "" : cleanText(body.pnlItemCode))
    : "";
  const voucherDate = requestedVoucherDate;
  const shiftValue = body.shift === undefined ? current.shift : (cleanText(body.shift).toUpperCase() || null);
  if (shiftValue && !isWorkShift(shiftValue)) {
    return NextResponse.json({ error: "Ca làm việc không hợp lệ" }, { status: 400 });
  }

  const depositAction = current.voucherType !== "RECEIPT"
    ? null
    : (body.depositAction === undefined ? current.depositAction : (normalizeReceiptPurpose(current.voucherType, body.depositAction) || null));
  const purposeError = validateReceiptPurpose(current.voucherType, depositAction, partnerCode);
  if (purposeError) return NextResponse.json({ error: purposeError }, { status: 400 });

  if (branchCode !== current.branchCode) {
    return NextResponse.json(
      { error: "Không thể đổi cửa hàng của chứng từ đã tạo vì mã chứng từ gắn với cửa hàng. Hãy hủy phiếu và lập phiếu mới." },
      { status: 400 },
    );
  }
  if (formatYearMonth(voucherDate) !== formatYearMonth(current.voucherDate)) {
    return NextResponse.json(
      { error: "Không thể chuyển chứng từ sang tháng khác vì mã chứng từ gắn với tháng lập phiếu. Hãy hủy phiếu và lập phiếu mới." },
      { status: 400 },
    );
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
  // Phiếu cũ vẫn được giữ nguồn đã ngừng khi chỉ sửa nội dung khác. Chỉ nguồn được chọn mới
  // (hoặc khi chuyển phiếu sang cửa hàng khác) mới bắt buộc phải đang hoạt động.
  const requiresActiveSource = moneySourceCode !== current.moneySourceCode || branchCode !== current.branchCode;
  const selectedSource = await prisma.masterDataItem.findFirst({
    where: {
      type: "MONEY_SOURCE",
      code: moneySourceCode,
      ...(requiresActiveSource ? { status: "ACTIVE" } : {}),
    },
  });
  if (!selectedSource || !moneySourceMatchesBranch(selectedSource, branchCode)) {
    return NextResponse.json({ error: `Nguồn tiền [${moneySourceCode}] không tồn tại, đã ngừng hoặc không thuộc cửa hàng đã chọn` }, { status: 400 });
  }

  if (normalizeMoneySourceGroup(selectedSource.group) !== "CASH") {
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

  // Khoá dòng chứng từ rồi hoàn tác - cập nhật - áp dụng lại - audit trong đúng một
  // transaction. Bất kỳ bước nào lỗi đều rollback, không để phiếu treo ở DRAFT.
  let voucher;
  try {
    voucher = await prismaRaw.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "FinancialVoucher" WHERE "id" = ${id} FOR UPDATE`;
      const latest = await tx.financialVoucher.findUnique({ where: { id } });
      if (!latest || latest.deletedAt) throw new VoucherConflictError("Không tìm thấy chứng từ hoặc chứng từ đã bị xóa");
      if (latest.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        throw new VoucherConflictError("Phiếu đã được người khác cập nhật. Vui lòng tải lại trước khi tiếp tục.");
      }

      if (latest.status === "APPROVED") await revertVoucherSideEffects(tx, latest);

      const updated = await tx.financialVoucher.update({
        where: { id },
        data: {
          ...data,
          ...(latest.status === "APPROVED" ? { status: "APPROVED", approvedBy: session.name } : {}),
        },
      });

      if (latest.status === "APPROVED") await applyVoucherSideEffects(tx, updated, session.name);

      await tx.auditLog.create({
        data: buildAuditLogData({
          session,
          module: "VOUCHERS",
          action: latest.status === "APPROVED"
            ? (requiresPastEditReason ? "UPDATE_PAST_AUTO_REAPPROVED" : "UPDATE_SAME_DAY_AUTO_REAPPROVED")
            : "UPDATE_DRAFT",
          entityType: "FinancialVoucher",
          entityId: updated.id,
          entityCode: updated.code,
          branchCode: updated.branchCode,
          message: requiresPastEditReason ? editReason : null,
          metadata: {
            reason: requiresPastEditReason ? editReason : null,
            previousApprovedBy: latest.approvedBy,
            autoReapprovedBy: latest.status === "APPROVED" ? session.name : null,
            before: { voucherDate: latest.voucherDate, shift: latest.shift, partnerCode: latest.partnerCode, partnerName: latest.partnerName, branchCode: latest.branchCode, moneySourceCode: latest.moneySourceCode, categoryCode: latest.categoryCode, pnlItemCode: latest.pnlItemCode, amount: latest.amount, description: latest.description },
            after: { voucherDate, shift: shiftValue, partnerCode, partnerName, branchCode, moneySourceCode, categoryCode, pnlItemCode, amount, description },
          },
        }),
      });

      return updated;
    });
  } catch (e) {
    if (e instanceof VoucherRevertError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof VoucherConflictError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }

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

  const voucher = await prismaRaw.$transaction(async (tx) => {
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
