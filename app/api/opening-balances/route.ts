import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/custom-client";
import { isAdmin, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { buildAuditLogData } from "@/lib/audit-log";
import { prisma, prismaRaw } from "@/lib/prisma";
import { applyOpeningDeposit, revertOpeningDeposit } from "@/lib/opening-balance-deposit";
import { normalizeOpeningBalanceInput, validateOpeningBalanceInput, type OpeningBalanceInput } from "@/lib/opening-balance-rules";
import { assertAssetCodeAvailable } from "@/lib/asset-code-generator";
import { assertPeriodOpen as assertAccountingPeriodOpen, buildAllocationSchedules } from "@/lib/phase3";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Luật khoá sổ dùng chung (lib/phase3). Màn này trả thẳng `error.message` cho người dùng nên
 * phải bóc tiền tố BUSINESS: kẻo câu báo lỗi lộ ra ở dạng thô.
 */
async function assertPeriodOpen(tx: Prisma.TransactionClient, period: string, branchCode: string) {
  try {
    await assertAccountingPeriodOpen({ period, branchCode }, "thay đổi số dư đầu kỳ", tx);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message.replace(/^BUSINESS:/, "") : String(error));
  }
}

function currentAsInput(current: Record<string, unknown>, body: Record<string, unknown>) {
  const merged: Record<string, unknown> = {};
  for (const key of [
    "period", "branchCode", "balanceType", "objectCode", "objectName", "moneySourceCode",
    "warehouseCode", "departmentCode", "quantity", "unitCost", "allocationMonths",
    "allocationStartPeriod", "pnlItemCode", "amount", "note",
  ]) merged[key] = body[key] !== undefined ? body[key] : current[key];
  return normalizeOpeningBalanceInput(merged);
}

async function applySideEffects(tx: Prisma.TransactionClient, current: OpeningBalanceInput & { id: string }, actor?: string | null) {
  if (current.balanceType === "DEPOSIT") {
    await applyOpeningDeposit(tx, current, actor);
    return;
  }
  if (current.balanceType === "INVENTORY") {
    const item = await tx.inventoryItem.findUnique({ where: { code: current.objectCode || "" } });
    if (!item) throw new Error(`Mặt hàng ${current.objectCode} không tồn tại`);
    await tx.inventoryBalance.upsert({
      where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: current.warehouseCode || "" } },
      update: { quantity: current.quantity || 0, averageCost: current.unitCost || 0 },
      create: { itemId: item.id, warehouseCode: current.warehouseCode || "", quantity: current.quantity || 0, averageCost: current.unitCost || 0 },
    });
    return;
  }
  if (current.balanceType === "ASSET") {
    const assetCode = await assertAssetCodeAvailable(tx, current.objectCode || "");
    await tx.assetRecord.create({ data: {
      code: assetCode, name: current.objectName || "", branchCode: current.branchCode,
      departmentCode: current.departmentCode, assetGroup: current.moneySourceCode || "ASSET",
      location: current.warehouseCode ? `Kho ${current.warehouseCode}` : "Văn phòng",
      quantity: current.quantity || 1,
      purchaseDate: new Date(`${current.allocationStartPeriod || current.period}-01T00:00:00Z`),
      originalCost: current.unitCost || current.amount, currentValue: current.amount,
      usefulLifeMonths: current.allocationMonths || 12,
      depreciationStartDate: current.allocationStartPeriod ? new Date(`${current.allocationStartPeriod}-01T00:00:00Z`) : null,
      residualValue: 0, supplierName: "Nhà cung cấp số dư đầu kỳ", status: "IN_USE",
      note: current.note || "Khởi tạo từ số dư đầu kỳ",
    } });
    return;
  }
  if (current.balanceType === "PREPAID_EXPENSE") {
    const code = `PB-DK-${(current.objectCode || "").toUpperCase()}`;
    if (await tx.accrual.findUnique({ where: { code } })) throw new Error(`Chi phí phân bổ mã ${current.objectCode} đã tồn tại`);
    // sourceType quyết định vế Có của bút toán phân bổ hàng kỳ: khoản đầu kỳ là tiền đã chi
    // từ trước, số dư đầu kỳ treo Nợ 242 nên mỗi kỳ phải rút 242 xuống, không phải ghi Có 335.
    const accrual = await tx.accrual.create({ data: {
      code, name: current.objectName || code, branchCode: current.branchCode,
      categoryCode: current.moneySourceCode || "OPEX", totalAmount: current.amount,
      // Hạng mục P&L khai sẵn ở số dư đầu kỳ đi thẳng sang khoản phân bổ, nên bút toán phân bổ
      // hàng kỳ đứng đúng dòng P&L mà không phải mở tab Trích trước gán lại từng khoản.
      pnlItemCode: current.pnlItemCode || null,
      startPeriod: current.allocationStartPeriod || current.period,
      numberOfPeriods: current.allocationMonths || 1, actualAmount: current.amount,
      sourceType: "OPENING_BALANCE", sourceId: current.id,
      status: "ACTIVE", note: current.note || "Khởi tạo từ số dư đầu kỳ",
    } });
    await tx.accrualSchedule.createMany({
      data: buildAllocationSchedules(current.allocationStartPeriod || current.period, current.amount, current.allocationMonths || 1)
        .map((schedule) => ({ accrualId: accrual.id, ...schedule, status: "PLANNED" })),
    });
  }
}

/**
 * Chặn mở lại khi số dư đầu kỳ đã đẻ ra nghiệp vụ ở nơi khác.
 *
 * `revertSideEffects` xoá thẳng khoản phân bổ / tài sản / tồn kho mà số dư này sinh ra. Nếu
 * chúng đã chạy tiếp — phân bổ đã ghi nhận vài kỳ, tài sản đã trích khấu hao, kho đã có phiếu
 * nhập xuất — thì xoá đi sẽ để lại bút toán mồ côi và số tồn nhảy sai. Bắt gỡ ở chứng từ con
 * trước, rồi mới mở lại số dư gốc; đúng thứ tự thì không mất dấu vết nào.
 */
async function assertSideEffectsRevertible(tx: Prisma.TransactionClient, current: OpeningBalanceInput & { id: string }) {
  if (current.balanceType === "PREPAID_EXPENSE") {
    const accrual = await tx.accrual.findFirst({
      where: { code: `PB-DK-${(current.objectCode || "").toUpperCase()}`, branchCode: current.branchCode },
      include: { schedules: true },
    });
    const posted = (accrual?.schedules || []).filter((schedule) => schedule.status === "POSTED");
    if (posted.length > 0) {
      throw new Error(`Khoản phân bổ ${accrual?.code} đã ghi nhận ${posted.length} kỳ (${posted.map((schedule) => schedule.period).join(", ")}). Vào Sổ quỹ > Trích trước & Phân bổ bỏ ghi nhận các kỳ đó rồi mới mở lại số dư đầu kỳ này.`);
    }
    return;
  }
  if (current.balanceType === "ASSET") {
    const asset = await tx.assetRecord.findFirst({ where: { code: current.objectCode || "", branchCode: current.branchCode } });
    if (!asset) return;
    const runs = await tx.assetDepreciation.count({ where: { assetId: asset.id } });
    if (runs > 0) {
      throw new Error(`Tài sản ${asset.code} đã trích khấu hao ${runs} kỳ. Vào Tài sản & Khấu hao mở lại các kỳ đó rồi mới mở lại số dư đầu kỳ này.`);
    }
    if (asset.status === "DISPOSED") {
      throw new Error(`Tài sản ${asset.code} đã thanh lý. Mở lại thanh lý ở tab Thanh lý rồi mới mở lại số dư đầu kỳ này.`);
    }
    return;
  }
  if (current.balanceType === "INVENTORY") {
    const item = await tx.inventoryItem.findUnique({ where: { code: current.objectCode || "" } });
    if (!item) return;
    // Mở lại là ép tồn kho về 0. Đã có phiếu nhập/xuất sau đó thì số 0 đó sai ngay lập tức.
    const movements = await tx.inventoryTransactionLine.count({
      where: { itemId: item.id, transaction: { is: { deletedAt: null, branchCode: current.branchCode } } },
    });
    if (movements > 0) {
      throw new Error(`Mặt hàng ${item.code} đã có ${movements} dòng phiếu nhập/xuất kho sau số dư đầu kỳ. Mở lại sẽ ép tồn về 0 và làm lệch kho, hãy lập phiếu điều chỉnh kho thay vì mở lại số dư này.`);
    }
  }
}

async function revertSideEffects(tx: Prisma.TransactionClient, current: OpeningBalanceInput & { id: string }) {
  if (current.balanceType === "DEPOSIT") return revertOpeningDeposit(tx, current.id);
  if (current.balanceType === "INVENTORY") {
    const item = await tx.inventoryItem.findUnique({ where: { code: current.objectCode || "" } });
    if (item) await tx.inventoryBalance.updateMany({ where: { itemId: item.id, warehouseCode: current.warehouseCode || "" }, data: { quantity: 0, averageCost: 0 } });
  } else if (current.balanceType === "ASSET") {
    await tx.assetRecord.deleteMany({ where: { code: current.objectCode || "", branchCode: current.branchCode } });
  } else if (current.balanceType === "PREPAID_EXPENSE") {
    await tx.accrual.deleteMany({ where: { code: `PB-DK-${(current.objectCode || "").toUpperCase()}`, branchCode: current.branchCode } });
  }
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/opening-balances");
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || undefined;
    const balanceType = searchParams.get("balanceType") || undefined;
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");
    const balances = await prisma.openingBalance.findMany({
      where: { ...branchFilter, ...(status && status !== "ALL" ? { status } : {}), ...(balanceType && balanceType !== "ALL" ? { balanceType } : {}) },
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
    const input = normalizeOpeningBalanceInput(await request.json());
    assertBranchAccess(auth.session, input.branchCode);
    const balance = await prismaRaw.$transaction(async (tx) => {
      await assertPeriodOpen(tx, input.period, input.branchCode);
      await validateOpeningBalanceInput(tx, input);
      const created = await tx.openingBalance.create({ data: { ...input, status: "DRAFT" } });
      await tx.auditLog.create({ data: buildAuditLogData({ session: auth.session, module: "OPENING_BALANCE", action: "CREATE", entityType: "OpeningBalance", entityId: created.id, branchCode: created.branchCode, metadata: input }) });
      return created;
    });
    return NextResponse.json(balance, { status: 201 });
  } catch (error) {
    console.error("Error creating opening balance:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: message === "Internal Server Error" ? 500 : 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/opening-balances", "config");
    if (!auth.ok) return auth.response;
    const body = await request.json() as Record<string, unknown>;
    const id = cleanText(body.id);
    if (!id) return NextResponse.json({ error: "Thiếu ID số dư" }, { status: 400 });
    const current = await prismaRaw.openingBalance.findFirst({ where: { id, deletedAt: null } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy số dư đầu kỳ" }, { status: 404 });
    assertBranchAccess(auth.session, current.branchCode);
    const requestedStatus = body.status === undefined ? undefined : cleanText(body.status).toUpperCase();
    // POSTED là số dư nạp bằng file import. Trước đây trạng thái này bị chặn sửa hoàn toàn, mà
    // phần lớn số dư đầu kỳ thật lại vào bằng import — khai nhầm loại số dư, sai số tiền hay
    // sai số tháng phân bổ là hết đường sửa trên giao diện. Nay mở lại được y như số dư chốt
    // tay: gỡ tác động, về Nháp, sửa, chốt lại.
    const reopenableStatuses = ["CONFIRMED", "POSTED"];
    const reopen = reopenableStatuses.includes(current.status) && requestedStatus === "DRAFT";
    const confirm = current.status === "DRAFT" && requestedStatus === "CONFIRMED";
    if (reopen && !isAdmin(auth.session.role)) return NextResponse.json({ error: "Chỉ Admin được mở lại số dư đã chốt" }, { status: 403 });
    if (!["DRAFT", ...reopenableStatuses].includes(current.status)) {
      return NextResponse.json({ error: `Số dư đang ở trạng thái ${current.status}, không sửa được tại màn hình này` }, { status: 409 });
    }
    if (reopenableStatuses.includes(current.status) && !reopen) {
      return NextResponse.json({ error: "Số dư đã chốt; hãy bấm Mở lại trước khi sửa" }, { status: 409 });
    }
    if (requestedStatus && !["DRAFT", "CONFIRMED"].includes(requestedStatus)) return NextResponse.json({ error: "Trạng thái không hợp lệ" }, { status: 400 });

    const next = currentAsInput(current as unknown as Record<string, unknown>, body);
    assertBranchAccess(auth.session, next.branchCode);
    const balance = await prismaRaw.$transaction(async (tx) => {
      await assertPeriodOpen(tx, current.period, current.branchCode);
      if (next.period !== current.period || next.branchCode !== current.branchCode) await assertPeriodOpen(tx, next.period, next.branchCode);
      await validateOpeningBalanceInput(tx, next);
      if (confirm) await applySideEffects(tx, { id, ...next }, auth.session.name);
      if (reopen) {
        // Gỡ theo dữ liệu ĐANG lưu, không phải theo `next`: người mở lại có thể gửi kèm thay
        // đổi, mà thứ cần gỡ là tác động mà bản cũ đã sinh ra.
        const stored = currentAsInput(current as unknown as Record<string, unknown>, {});
        await assertSideEffectsRevertible(tx, { id, ...stored });
        await revertSideEffects(tx, { id, ...stored });
      }
      const updated = await tx.openingBalance.update({ where: { id }, data: reopen ? { status: "DRAFT" } : { ...next, status: confirm ? "CONFIRMED" : "DRAFT" } });
      await tx.auditLog.create({ data: buildAuditLogData({ session: auth.session, module: "OPENING_BALANCE", action: confirm ? "CONFIRM" : reopen ? "REOPEN" : "UPDATE", entityType: "OpeningBalance", entityId: id, branchCode: updated.branchCode, metadata: { before: current, after: updated } }) });
      return updated;
    });
    return NextResponse.json(balance);
  } catch (error) {
    console.error("Error updating opening balance:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: message === "Internal Server Error" ? 500 : 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/opening-balances", "config");
    if (!auth.ok) return auth.response;
    const id = cleanText(new URL(request.url).searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "Thiếu ID số dư" }, { status: 400 });
    const current = await prismaRaw.openingBalance.findFirst({ where: { id, deletedAt: null } });
    if (!current) return NextResponse.json({ error: "Không tìm thấy số dư đầu kỳ" }, { status: 404 });
    assertBranchAccess(auth.session, current.branchCode);
    if (current.status !== "DRAFT") return NextResponse.json({ error: "Chỉ được xóa số dư đang ở trạng thái Nháp" }, { status: 409 });
    await prismaRaw.$transaction(async (tx) => {
      await assertPeriodOpen(tx, current.period, current.branchCode);
      await tx.openingBalance.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.session.name || auth.session.email } });
      await tx.auditLog.create({ data: buildAuditLogData({ session: auth.session, module: "OPENING_BALANCE", action: "SOFT_DELETE", entityType: "OpeningBalance", entityId: id, branchCode: current.branchCode, metadata: current }) });
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting opening balance:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: message === "Internal Server Error" ? 500 : 400 });
  }
}
