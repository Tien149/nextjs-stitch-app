import { NextResponse } from "next/server";
import { isAdmin, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { addPeriod, apiError, businessError, cleanText, isPeriodLocked, normalizePeriod, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { writeAuditLog } from "@/lib/audit-log";

const menuHref = "/finance-operations";

function periodBounds(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(`${addPeriod(period, 1)}-01T00:00:00`);
  return { start, end };
}

async function closingChecklist(period: string, branchCode: string) {
  const { start, end } = periodBounds(period);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [draftVouchers, pendingOrders, unmatchedBankRows, negativeStock, assets, depreciationRuns, pendingAccruals, importErrors] = await Promise.all([
    prisma.financialVoucher.count({ where: { ...branchFilter, voucherDate: { gte: start, lt: end }, status: { in: ["DRAFT", "PENDING_REVIEW"] } } }),
    prisma.purchaseOrder.count({ where: { ...branchFilter, status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } } }),
    prisma.bankStatementTransaction.count({ where: { ...(branchCode === "ALL" ? {} : { branchCode }), transactionDate: { gte: start, lt: end }, reconcileStatus: "UNMATCHED" } }),
    prisma.inventoryBalance.count({ where: { quantity: { lt: 0 } } }),
    prisma.assetRecord.count({ where: { ...branchFilter, status: "IN_USE", usefulLifeMonths: { gt: 0 }, depreciationStartDate: { lte: end } } }),
    prisma.assetDepreciation.count({ where: { period, ...(branchCode === "ALL" ? {} : { asset: { branchCode } }) } }),
    prisma.accrualSchedule.count({ where: { period, status: "PLANNED", ...(branchCode === "ALL" ? {} : { accrual: { branchCode } }) } }),
    prisma.importBatch.count({ where: { status: "ERROR", createdAt: { gte: start, lt: end } } }),
  ]);
  return [
    { key: "draftVouchers", label: "Không còn phiếu thu/chi nháp", passed: draftVouchers === 0, count: draftVouchers },
    { key: "pendingOrders", label: "PO trong kỳ đã nhận hàng xong", passed: pendingOrders === 0, count: pendingOrders },
    { key: "unmatchedBankRows", label: "Sao kê đã đối soát", passed: unmatchedBankRows === 0, count: unmatchedBankRows },
    { key: "depreciation", label: "Đã chạy khấu hao", passed: assets === 0 || depreciationRuns >= assets, count: Math.max(assets - depreciationRuns, 0) },
    { key: "accruals", label: "Đã ghi nhận phân bổ kỳ", passed: pendingAccruals === 0, count: pendingAccruals },
    { key: "negativeStock", label: "Không có tồn kho âm", passed: negativeStock === 0, count: negativeStock },
    { key: "importErrors", label: "Không còn batch import lỗi", passed: importErrors === 0, count: importErrors },
  ];
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const { searchParams } = new URL(request.url);
    const period = normalizePeriod(searchParams.get("period")) || new Date().toISOString().slice(0, 7);
    const branchCode = requestedBranch(auth.session, cleanText(searchParams.get("branchCode")) || "ALL");
    const { start, end } = periodBounds(period);
    const branchFilter = branchCode === "ALL" ? {} : { branchCode };

    const [openingBalances, vouchers, adjustments, accruals, accountingPeriod, checklist, moneyTransfers] = await Promise.all([
      prisma.openingBalance.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { branchCode }), status: "POSTED" } }),
      prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherDate: { gte: start, lt: end }, status: "APPROVED" }, orderBy: { voucherDate: "asc" } }),
      prisma.cashbookAdjustment.findMany({ where: { ...branchFilter, entryDate: { gte: start, lt: end } }, orderBy: { entryDate: "asc" } }),
      prisma.accrual.findMany({ where: { ...(branchCode === "ALL" ? {} : { branchCode }) }, include: { schedules: { orderBy: { period: "asc" } } }, orderBy: { createdAt: "desc" } }),
      prisma.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode } } }),
      closingChecklist(period, branchCode),
      prisma.moneyTransfer.findMany({ where: { ...branchFilter, transferDate: { gte: start, lt: end } }, orderBy: { transferDate: "asc" } }),
    ]);

    const openingAmount = openingBalances.reduce((sum, row) => sum + row.amount, 0);
    const entries = [
      ...vouchers.map((row) => ({ id: row.id, date: row.voucherDate, code: row.code, type: row.voucherType, moneySourceCode: row.moneySourceCode, description: row.description, receipt: row.voucherType === "RECEIPT" ? row.amount : 0, payment: row.voucherType === "PAYMENT" ? row.amount : 0 })),
      ...adjustments.map((row) => ({ id: row.id, date: row.entryDate, code: row.code, type: "ADJUSTMENT", moneySourceCode: row.moneySourceCode, description: row.description, receipt: entryTypeToReceipt(row.entryType, row.amount), payment: entryTypeToPayment(row.entryType, row.amount) })),
      ...moneyTransfers.filter((row) => row.status === "APPROVED").flatMap((row) => [
        { id: `${row.id}-out`, date: row.transferDate, code: row.code, type: "TRANSFER_OUT", moneySourceCode: row.fromMoneySourceCode, description: row.description, receipt: 0, payment: row.amount },
        { id: `${row.id}-in`, date: row.transferDate, code: row.code, type: "TRANSFER_IN", moneySourceCode: row.toMoneySourceCode, description: row.description, receipt: row.amount, payment: 0 },
      ]),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let runningBalance = openingAmount;
    const cashbook = entries.map((entry) => {
      runningBalance += entry.receipt - entry.payment;
      return { ...entry, balance: runningBalance };
    });

    return NextResponse.json({ period, branchCode, openingAmount, closingBalance: runningBalance, cashbook, accruals, moneyTransfers, accountingPeriod: accountingPeriod || { status: "OPEN" }, checklist });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

function entryTypeToReceipt(entryType: string, amount: number) {
  return entryType === "RECEIPT" ? amount : 0;
}

function entryTypeToPayment(entryType: string, amount: number) {
  return entryType === "PAYMENT" ? amount : 0;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);

    if (action === "APPROVE_TRANSFER") {
      const auth = requireMenuAction(request, menuHref, "approve");
      if (!auth.ok) return auth.response;
      const id = cleanText(body.id);
      const transfer = await prisma.moneyTransfer.findUnique({ where: { id } });
      if (!transfer) businessError("Không tìm thấy giao dịch điều tiền");
      assertBranchAccess(auth.session, transfer.branchCode);
      if (transfer.status !== "PENDING_REVIEW") businessError("Giao dịch điều tiền không ở trạng thái chờ duyệt");
      const result = await prisma.moneyTransfer.update({
        where: { id },
        data: { status: "APPROVED", approvedBy: auth.session.name },
      });
      await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "APPROVE_TRANSFER", entityType: "MoneyTransfer", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { amount: result.amount, from: result.fromMoneySourceCode, to: result.toMoneySourceCode } });
      return NextResponse.json(result);
    }

    if (["CLOSE_PERIOD", "REOPEN_PERIOD"].includes(action)) {
      const auth = requireMenuAction(request, menuHref, "config");
      if (!auth.ok) return auth.response;
      if (!isAdmin(auth.session.role)) return NextResponse.json({ error: "Chỉ Admin được khóa hoặc mở lại kỳ" }, { status: 403 });
      const period = normalizePeriod(body.period);
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode) || "ALL");
      if (!period) businessError("Kỳ kế toán phải có dạng YYYY-MM");
      if (action === "CLOSE_PERIOD") {
        const checklist = await closingChecklist(period, branchCode);
        if (checklist.some((item) => !item.passed)) businessError("Chưa thể khóa kỳ vì checklist còn mục chưa hoàn tất");
        const result = await prisma.accountingPeriod.upsert({
          where: { period_branchCode: { period, branchCode } },
          create: { period, branchCode, status: "CLOSED", closedBy: auth.session.name, closedAt: new Date() },
          update: { status: "CLOSED", closedBy: auth.session.name, closedAt: new Date(), reopenedBy: null, reopenedAt: null, reason: null },
        });
        await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "CLOSE_PERIOD", entityType: "AccountingPeriod", entityId: result.id, entityCode: `${period}-${branchCode}`, branchCode, metadata: { checklist } });
        return NextResponse.json(result);
      }
      const reason = cleanText(body.reason);
      if (!reason) businessError("Mở lại kỳ bắt buộc nhập lý do");
      const result = await prisma.accountingPeriod.upsert({
        where: { period_branchCode: { period, branchCode } },
        create: { period, branchCode, status: "OPEN", reopenedBy: auth.session.name, reopenedAt: new Date(), reason },
        update: { status: "OPEN", reopenedBy: auth.session.name, reopenedAt: new Date(), reason },
      });
      await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "REOPEN_PERIOD", entityType: "AccountingPeriod", entityId: result.id, entityCode: `${period}-${branchCode}`, branchCode, message: reason });
      return NextResponse.json(result);
    }

    const auth = requireMenuAction(request, menuHref, action === "POST_ACCRUAL" ? "edit" : "create");
    if (!auth.ok) return auth.response;

    if (action === "CREATE_ADJUSTMENT") {
      const entryDate = toDate(body.entryDate);
      const branchCode = cleanText(body.branchCode);
      if (!branchCode || !cleanText(body.moneySourceCode) || toNumber(body.amount) <= 0 || !cleanText(body.description)) businessError("Bút toán điều chỉnh thiếu thông tin bắt buộc");

      try {
        assertBranchAccess(auth.session, branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }

      if (await isPeriodLocked(entryDate, branchCode)) businessError("Kỳ kế toán đã khóa");
      const result = await prisma.cashbookAdjustment.create({
        data: {
          code: `DCQ-${new Date().getFullYear()}-${String(await prisma.cashbookAdjustment.count() + 1).padStart(4, "0")}`,
          entryDate,
          entryType: cleanText(body.entryType) || "RECEIPT",
          branchCode,
          moneySourceCode: cleanText(body.moneySourceCode),
          amount: toNumber(body.amount),
          description: cleanText(body.description),
          createdBy: auth.session.name,
        },
      });
      await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "CREATE_ADJUSTMENT", entityType: "CashbookAdjustment", entityId: result.id, entityCode: result.code, branchCode, metadata: { amount: result.amount, entryType: result.entryType, moneySourceCode: result.moneySourceCode } });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "CREATE_ACCRUAL") {
      const startPeriod = normalizePeriod(body.startPeriod);
      const numberOfPeriods = Math.floor(toNumber(body.numberOfPeriods));
      const totalAmount = toNumber(body.totalAmount);
      const branchCode = cleanText(body.branchCode);
      if (!startPeriod || numberOfPeriods <= 0 || totalAmount <= 0 || !cleanText(body.name) || !branchCode) businessError("Khoản trích trước thiếu thông tin bắt buộc");

      try {
        assertBranchAccess(auth.session, branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }

      const amount = totalAmount / numberOfPeriods;
      const result = await prisma.accrual.create({
        data: {
          code: `PB-${new Date().getFullYear()}-${String(await prisma.accrual.count() + 1).padStart(4, "0")}`,
          name: cleanText(body.name),
          branchCode,
          categoryCode: cleanText(body.categoryCode) || "OPEX",
          totalAmount,
          startPeriod,
          numberOfPeriods,
          note: cleanText(body.note) || null,
          createdBy: auth.session.name,
          schedules: { create: Array.from({ length: numberOfPeriods }, (_, index) => ({ period: addPeriod(startPeriod, index), amount })) },
        },
        include: { schedules: true },
      });
      await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "CREATE_ACCRUAL", entityType: "Accrual", entityId: result.id, entityCode: result.code, branchCode, metadata: { totalAmount, startPeriod, numberOfPeriods } });
      return NextResponse.json(result, { status: 201 });
    }

    if (action === "POST_ACCRUAL") {
      const scheduleId = cleanText(body.scheduleId);
      const schedule = await prisma.accrualSchedule.findUnique({ where: { id: scheduleId }, include: { accrual: true } });
      if (!schedule) businessError("Không tìm thấy kỳ phân bổ");

      try {
        assertBranchAccess(auth.session, schedule.accrual.branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }

      if (await isPeriodLocked(new Date(`${schedule.period}-01T00:00:00`), schedule.accrual.branchCode)) businessError("Kỳ kế toán đã khóa");
      const result = await prisma.accrualSchedule.update({ where: { id: scheduleId }, data: { status: "POSTED", postedAt: new Date() } });
      const remaining = await prisma.accrualSchedule.count({ where: { accrualId: schedule.accrualId, status: "PLANNED" } });
      if (remaining === 0) await prisma.accrual.update({ where: { id: schedule.accrualId }, data: { status: "COMPLETED" } });
      await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "POST_ACCRUAL", entityType: "AccrualSchedule", entityId: result.id, entityCode: `${schedule.accrual.code}-${schedule.period}`, branchCode: schedule.accrual.branchCode, metadata: { period: schedule.period, amount: schedule.amount } });
      return NextResponse.json(result);
    }

    businessError("Thao tác tài chính không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
