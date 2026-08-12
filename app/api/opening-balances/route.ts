import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/custom-client";
import { isAdmin, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { buildAuditLogData } from "@/lib/audit-log";
import { prisma, prismaRaw } from "@/lib/prisma";
import { applyOpeningDeposit, revertOpeningDeposit } from "@/lib/opening-balance-deposit";
import { normalizeOpeningBalanceInput, validateOpeningBalanceInput, type OpeningBalanceInput } from "@/lib/opening-balance-rules";
import { assertAssetCodeAvailable } from "@/lib/asset-code-generator";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function addPeriod(period: string, monthsToAdd: number): string {
  const [yearStr, monthStr] = period.split("-");
  let year = parseInt(yearStr, 10);
  let month = parseInt(monthStr, 10) + monthsToAdd - 1;
  year += Math.floor(month / 12);
  month = (month % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function assertPeriodOpen(tx: Prisma.TransactionClient, period: string, branchCode: string) {
  const locked = await tx.accountingPeriod.findFirst({
    where: { period, status: "CLOSED", branchCode: { in: [branchCode, "ALL"] } },
    select: { id: true },
  });
  if (locked) throw new Error(`Kỳ ${period} đã khóa, không thể thay đổi số dư đầu kỳ`);
}

function currentAsInput(current: Record<string, unknown>, body: Record<string, unknown>) {
  const merged: Record<string, unknown> = {};
  for (const key of [
    "period", "branchCode", "balanceType", "objectCode", "objectName", "moneySourceCode",
    "warehouseCode", "departmentCode", "quantity", "unitCost", "allocationMonths",
    "allocationStartPeriod", "amount", "note",
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
    const accrual = await tx.accrual.create({ data: {
      code, name: current.objectName || code, branchCode: current.branchCode,
      categoryCode: current.moneySourceCode || "OPEX", totalAmount: current.amount,
      startPeriod: current.allocationStartPeriod || current.period,
      numberOfPeriods: current.allocationMonths || 1, actualAmount: current.amount,
      status: "ACTIVE", note: current.note || "Khởi tạo từ số dư đầu kỳ",
    } });
    await tx.accrualSchedule.createMany({ data: Array.from({ length: current.allocationMonths || 1 }, (_, index) => ({
      accrualId: accrual.id, period: addPeriod(current.allocationStartPeriod || current.period, index),
      amount: current.amount / (current.allocationMonths || 1), status: "PLANNED",
    })) });
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
    const reopen = current.status === "CONFIRMED" && requestedStatus === "DRAFT";
    const confirm = current.status === "DRAFT" && requestedStatus === "CONFIRMED";
    if (reopen && !isAdmin(auth.session.role)) return NextResponse.json({ error: "Chỉ Admin được mở lại số dư đã chốt" }, { status: 403 });
    if (!["DRAFT", "CONFIRMED"].includes(current.status)) return NextResponse.json({ error: "Số dư import đã ghi sổ, không thể sửa tại màn hình này" }, { status: 409 });
    if (current.status === "CONFIRMED" && !reopen) return NextResponse.json({ error: "Số dư đã chốt; hãy mở lại trước khi sửa" }, { status: 409 });
    if (requestedStatus && !["DRAFT", "CONFIRMED"].includes(requestedStatus)) return NextResponse.json({ error: "Trạng thái không hợp lệ" }, { status: 400 });

    const next = currentAsInput(current as unknown as Record<string, unknown>, body);
    assertBranchAccess(auth.session, next.branchCode);
    const balance = await prismaRaw.$transaction(async (tx) => {
      await assertPeriodOpen(tx, current.period, current.branchCode);
      if (next.period !== current.period || next.branchCode !== current.branchCode) await assertPeriodOpen(tx, next.period, next.branchCode);
      await validateOpeningBalanceInput(tx, next);
      if (confirm) await applySideEffects(tx, { id, ...next }, auth.session.name);
      if (reopen) await revertSideEffects(tx, { id, ...next });
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
