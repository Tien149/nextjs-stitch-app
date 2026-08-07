import { NextResponse } from "next/server";
import { isAdmin, requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { addPeriod, apiError, businessError, cleanText, isPeriodLocked, normalizePeriod, toDate, toNumber } from "@/lib/phase3";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { writeAuditLog } from "@/lib/audit-log";
import { generateFormattedVoucherCode } from "@/lib/voucher-code-generator";
import { moneySourceDisplayName, moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { scopePayloadByTab } from "@/lib/tab-scope";

const menuHref = "/finance-operations";
const cashDepositDenominations = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];
// Số thực nộp đếm theo tờ; phần lẻ dưới 1.000 đ đi thẳng vào chi phí để clear nguồn thu ngân.
const cashDepositUnit = 1000;
const cashDepositTargetLabels: Record<string, string> = { PKT: "Nộp Tiền PKT", CO: "Nộp Tiền Cô" };
type CashDepositDenominationInput = { denomination?: unknown; quantity?: unknown; note?: unknown };
type CashDepositDenominationRow = { denomination: number; quantity: number; amount: number; note: string | null };

function periodBounds(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(`${addPeriod(period, 1)}-01T00:00:00`);
  return { start, end };
}

function dayBounds(date: Date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function normalizeCashDepositShift(value: unknown) {
  const shift = cleanText(value).toUpperCase();
  return ["FULL", "MORNING", "EVENING"].includes(shift) ? shift : "FULL";
}

function normalizeCashDepositTarget(value: unknown) {
  const target = cleanText(value).toUpperCase();
  return target === "CO" ? "CO" : "PKT";
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
      prisma.moneyTransfer.findMany({
        where: { ...branchFilter, transferDate: { gte: start, lt: end } },
        include: { denominations: { orderBy: { denomination: "desc" } } },
        orderBy: { transferDate: "asc" },
      }),
    ]);

    const openingAmount = openingBalances.reduce((sum, row) => sum + row.amount, 0);
    const entries = [
      ...vouchers.map((row) => ({ id: row.id, date: row.voucherDate, code: row.code, type: row.voucherType, moneySourceCode: row.moneySourceCode, description: row.description, receipt: row.voucherType === "RECEIPT" ? row.amount : 0, payment: row.voucherType === "PAYMENT" ? row.amount : 0 })),
      ...adjustments.map((row) => ({ id: row.id, date: row.entryDate, code: row.code, type: "ADJUSTMENT", moneySourceCode: row.moneySourceCode, description: row.description, receipt: entryTypeToReceipt(row.entryType, row.amount), payment: entryTypeToPayment(row.entryType, row.amount) })),
      // Quyết toán ví: tiền rời ví = số về ngân hàng + phí, nên số dư ví mới về đúng 0.
      ...moneyTransfers.filter((row) => row.status === "APPROVED").flatMap((row) => [
        { id: `${row.id}-out`, date: row.transferDate, code: row.code, type: "TRANSFER_OUT", moneySourceCode: row.fromMoneySourceCode, description: row.description, receipt: 0, payment: row.amount + row.feeAmount },
        { id: `${row.id}-in`, date: row.transferDate, code: row.code, type: "TRANSFER_IN", moneySourceCode: row.toMoneySourceCode, description: row.description, receipt: row.amount, payment: 0 },
      ]),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    let runningBalance = openingAmount;
    const cashbook = entries.map((entry) => {
      runningBalance += entry.receipt - entry.payment;
      return { ...entry, balance: runningBalance };
    });

    return NextResponse.json(scopePayloadByTab(auth.session, menuHref, { period, branchCode, openingAmount, closingBalance: runningBalance, cashbook, accruals, moneyTransfers, accountingPeriod: accountingPeriod || { status: "OPEN" }, checklist }));
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
      await writeAuditLog({ session: auth.session, module: "FINANCE_OPERATIONS", action: "APPROVE_TRANSFER", entityType: "MoneyTransfer", entityId: result.id, entityCode: result.code, branchCode: result.branchCode, metadata: { amount: result.amount, feeAmount: result.feeAmount, clearedAmount: result.amount + result.feeAmount, from: result.fromMoneySourceCode, to: result.toMoneySourceCode } });
      return NextResponse.json(result);
    }

    if (action === "CREATE_CASH_DEPOSIT_TRANSFER") {
      const auth = requireMenuAction(request, menuHref, "create");
      if (!auth.ok) return auth.response;

      const transferDate = toDate(body.transferDate || body.sourceReportDate);
      const sourceReportDate = toDate(body.sourceReportDate || body.transferDate, transferDate);
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode));
      const sourceShift = normalizeCashDepositShift(body.sourceShift);
      const depositTargetType = normalizeCashDepositTarget(body.depositTargetType);
      const fromMoneySourceCode = cleanText(body.fromMoneySourceCode);
      const toMoneySourceCode = cleanText(body.toMoneySourceCode);
      const amount = Math.round(toNumber(body.amount));
      const grossAmount = Math.round(toNumber(body.grossAmount ?? body.amount));
      const feeAmount = grossAmount - amount;
      const denominationRows: CashDepositDenominationInput[] = Array.isArray(body.denominations) ? body.denominations : [];

      if (!branchCode || branchCode === "ALL") businessError("Nộp tiền bắt buộc chọn một cửa hàng cụ thể.");
      if (grossAmount <= 0) businessError("Số tiền cần clear phải lớn hơn 0.");
      if (amount < 0) businessError("Số tiền thực nộp không được âm.");
      if (amount % cashDepositUnit !== 0) businessError(`Số tiền thực nộp phải là bội số của ${cashDepositUnit.toLocaleString("vi-VN")} đ.`);
      if (amount !== Math.floor(grossAmount / cashDepositUnit) * cashDepositUnit || feeAmount < 0 || feeAmount >= cashDepositUnit) {
        businessError(`Số thực nộp phải được làm tròn xuống từ số cần clear; phần chênh lệch phải nhỏ hơn ${cashDepositUnit.toLocaleString("vi-VN")} đ.`);
      }
      if (!fromMoneySourceCode || !toMoneySourceCode) businessError("Nguồn tiền đi và nguồn tiền nhận là bắt buộc.");
      if (fromMoneySourceCode === toMoneySourceCode) businessError("Nguồn tiền đi và nguồn tiền nhận không được trùng nhau.");

      try {
        assertBranchAccess(auth.session, branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }

      if (await isPeriodLocked(transferDate, branchCode)) businessError("Kỳ kế toán đã khóa");

      const [fromMoneySource, toMoneySource] = await Promise.all([
        prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: fromMoneySourceCode, status: "ACTIVE", deletedAt: null } }),
        prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: toMoneySourceCode, status: "ACTIVE", deletedAt: null } }),
      ]);
      if (!fromMoneySource || !moneySourceMatchesBranch(fromMoneySource, branchCode)) businessError(`Nguồn tiền đi [${fromMoneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn.`);
      if (!toMoneySource || !moneySourceMatchesBranch(toMoneySource, branchCode)) businessError(`Nguồn tiền nhận [${toMoneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn.`);
      if (normalizeMoneySourceGroup(fromMoneySource.group) !== "CASH") businessError("Nộp tiền trong ngày bắt buộc đi từ nguồn tiền mặt.");

      const denominations: CashDepositDenominationRow[] = denominationRows
        .map((row) => {
          const denomination = Math.floor(toNumber(row?.denomination));
          const quantity = Math.floor(toNumber(row?.quantity));
          return { denomination, quantity, amount: denomination * quantity, note: cleanText(row?.note) || null };
        })
        .filter((row) => row.denomination > 0 && row.quantity > 0);

      if (amount > 0 && denominations.length === 0) businessError("Bảng kê mệnh giá là bắt buộc khi có tiền thực nộp.");
      if (denominations.some((row) => !cashDepositDenominations.includes(row.denomination))) businessError("Bảng kê có mệnh giá không hợp lệ.");
      const denominationTotal = denominations.reduce((sum: number, row: CashDepositDenominationRow) => sum + row.amount, 0);
      if (denominationTotal !== amount) businessError(`Tổng bảng kê mệnh giá (${denominationTotal.toLocaleString("vi-VN")} đ) phải bằng số tiền nộp (${amount.toLocaleString("vi-VN")} đ).`);

      const { start, end } = dayBounds(sourceReportDate);
      const existing = await prisma.moneyTransfer.findFirst({
        where: {
          branchCode,
          transferPurpose: "CASH_DEPOSIT",
          depositTargetType,
          sourceShift,
          sourceReportDate: { gte: start, lt: end },
          status: { in: ["PENDING_REVIEW", "APPROVED"] },
          deletedAt: null,
        },
      });
      if (existing) businessError(`Ngày/ca này đã có phiếu nộp tiền ${cashDepositTargetLabels[depositTargetType]} (${existing.code}) đang xử lý.`);

      const transferCount = await prisma.moneyTransfer.count();
      const reportDateCode = sourceReportDate.toISOString().slice(0, 10);
      const result = await prisma.moneyTransfer.create({
        data: {
          code: generateFormattedVoucherCode({ voucherType: "NOPT", voucherDate: transferDate, branchCode, seqNumber: transferCount + 1 }),
          transferDate,
          branchCode,
          fromMoneySourceCode,
          toMoneySourceCode,
          amount,
          feeAmount,
          externalRef: `NOPT-${reportDateCode}-${branchCode}-${sourceShift}-${depositTargetType}`,
          description: `${cashDepositTargetLabels[depositTargetType]} ngày ${reportDateCode} (${sourceShift})${feeAmount > 0 ? ` - chi phí làm tròn ${feeAmount.toLocaleString("vi-VN")} đ` : ""}`,
          transferPurpose: "CASH_DEPOSIT",
          depositTargetType,
          sourceReportDate: new Date(`${reportDateCode}T00:00:00`),
          sourceShift,
          status: "PENDING_REVIEW",
          createdBy: auth.session.name,
          denominations: { create: denominations },
        },
        include: { denominations: { orderBy: { denomination: "desc" } } },
      });

      await writeAuditLog({
        session: auth.session,
        module: "FINANCE_OPERATIONS",
        action: "CREATE_CASH_DEPOSIT_TRANSFER",
        entityType: "MoneyTransfer",
        entityId: result.id,
        entityCode: result.code,
        branchCode,
        metadata: { grossAmount, amount, feeAmount, from: fromMoneySourceCode, to: toMoneySourceCode, depositTargetType, sourceReportDate: reportDateCode, sourceShift, denominations },
      });
      return NextResponse.json(result, { status: 201 });
    }

    /**
     * Quyết toán ví/POS về ngân hàng.
     *
     * Doanh thu quẹt thẻ đã ghi nhận đủ ở nguồn ví (VD 50tr) ngay khi import doanh thu.
     * Vài ngày sau cổng thanh toán trả tiền về ngân hàng sau khi trừ phí (49tr). Một
     * phiếu quyết toán ghi cả ba việc cùng lúc: cộng tiền vào ngân hàng, giảm hết số
     * đang treo ở ví, và đẩy phần chênh lệch sang chi phí trên P&L.
     */
    if (action === "CREATE_WALLET_SETTLEMENT") {
      const auth = requireMenuAction(request, menuHref, "create");
      if (!auth.ok) return auth.response;

      const transferDate = toDate(body.transferDate);
      const branchCode = requestedBranch(auth.session, cleanText(body.branchCode));
      const fromMoneySourceCode = cleanText(body.fromMoneySourceCode);
      const toMoneySourceCode = cleanText(body.toMoneySourceCode);
      // grossAmount: số doanh thu đang treo ở ví. amount: số thực nhận trên sao kê.
      const grossAmount = Math.round(toNumber(body.grossAmount));
      const amount = Math.round(toNumber(body.amount));
      const feeAmount = grossAmount - amount;
      const feeCategoryCode = cleanText(body.feeCategoryCode);
      const externalRef = cleanText(body.externalRef) || null;

      if (!branchCode || branchCode === "ALL") businessError("Quyết toán ví bắt buộc chọn một cửa hàng cụ thể.");
      if (amount <= 0) businessError("Số tiền thực nhận về ngân hàng phải lớn hơn 0.");
      if (grossAmount < amount) businessError("Số tiền gốc ở ví không được nhỏ hơn số thực nhận về ngân hàng.");
      if (!fromMoneySourceCode || !toMoneySourceCode) businessError("Nguồn ví và tài khoản ngân hàng là bắt buộc.");
      if (fromMoneySourceCode === toMoneySourceCode) businessError("Nguồn ví và tài khoản nhận không được trùng nhau.");
      if (feeAmount > 0 && !feeCategoryCode) businessError("Có chênh lệch phí thì bắt buộc chọn khoản mục chi phí để đưa lên P&L.");

      try {
        assertBranchAccess(auth.session, branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }
      if (await isPeriodLocked(transferDate, branchCode)) businessError("Kỳ kế toán đã khóa");

      const [fromMoneySource, toMoneySource, feeCategory] = await Promise.all([
        prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: fromMoneySourceCode, status: "ACTIVE" } }),
        prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: toMoneySourceCode, status: "ACTIVE" } }),
        feeCategoryCode
          ? prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: feeCategoryCode, status: "ACTIVE" } })
          : Promise.resolve(null),
      ]);
      if (!fromMoneySource || !moneySourceMatchesBranch(fromMoneySource, branchCode)) businessError(`Nguồn ví [${fromMoneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn.`);
      if (!toMoneySource || !moneySourceMatchesBranch(toMoneySource, branchCode)) businessError(`Tài khoản nhận [${toMoneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn.`);
      if (normalizeMoneySourceGroup(fromMoneySource.group) !== "WALLET") businessError("Quyết toán phải đi từ nguồn ví/cổng POS.");
      if (normalizeMoneySourceGroup(toMoneySource.group) !== "BANK") businessError("Quyết toán phải về tài khoản ngân hàng.");
      if (feeCategoryCode && !feeCategory) businessError(`Khoản mục phí [${feeCategoryCode}] không tồn tại hoặc đã ngưng hoạt động.`);

      const transferCount = await prisma.moneyTransfer.count();
      const result = await prisma.moneyTransfer.create({
        data: {
          code: generateFormattedVoucherCode({ voucherType: "QTVI", voucherDate: transferDate, branchCode, seqNumber: transferCount + 1 }),
          transferDate,
          branchCode,
          fromMoneySourceCode,
          toMoneySourceCode,
          amount,
          feeAmount,
          feeCategoryCode: feeAmount > 0 ? feeCategoryCode : null,
          externalRef,
          description: cleanText(body.description)
            || `Quyết toán ${moneySourceDisplayName(fromMoneySource)} về ${moneySourceDisplayName(toMoneySource)}${feeAmount > 0 ? ` (phí ${feeAmount.toLocaleString("vi-VN")} đ)` : ""}`,
          transferPurpose: "WALLET_SETTLEMENT",
          // Sao kê đã là bằng chứng tiền về nên ghi nhận luôn, không bắt duyệt thêm một vòng.
          status: "APPROVED",
          createdBy: auth.session.name,
          approvedBy: auth.session.name,
        },
      });

      await writeAuditLog({
        session: auth.session,
        module: "FINANCE_OPERATIONS",
        action: "CREATE_WALLET_SETTLEMENT",
        entityType: "MoneyTransfer",
        entityId: result.id,
        entityCode: result.code,
        branchCode,
        metadata: { grossAmount, amount, feeAmount, feeCategoryCode, from: fromMoneySourceCode, to: toMoneySourceCode, externalRef },
      });
      return NextResponse.json(result, { status: 201 });
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
      const moneySourceCode = cleanText(body.moneySourceCode);
      if (!branchCode || !moneySourceCode || toNumber(body.amount) <= 0 || !cleanText(body.description)) businessError("Bút toán điều chỉnh thiếu thông tin bắt buộc");

      try {
        assertBranchAccess(auth.session, branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi" }, { status: 403 });
      }

      const moneySource = await prisma.masterDataItem.findFirst({
        where: { type: "MONEY_SOURCE", code: moneySourceCode, status: "ACTIVE" },
      });
      if (!moneySource || !moneySourceMatchesBranch(moneySource, branchCode)) {
        businessError(`Nguồn tiền [${moneySourceCode}] không tồn tại hoặc không thuộc cửa hàng đã chọn`);
      }
      if (normalizeMoneySourceGroup(moneySource.group) !== "CASH") {
        businessError("Sổ quỹ chỉ được điều chỉnh các nguồn tiền mặt.");
      }

      if (await isPeriodLocked(entryDate, branchCode)) businessError("Kỳ kế toán đã khóa");
      const adjCount = await prisma.cashbookAdjustment.count();
      const result = await prisma.cashbookAdjustment.create({
        data: {
          code: generateFormattedVoucherCode({ voucherType: "DCQ1", voucherDate: entryDate, branchCode, seqNumber: adjCount + 1 }),
          entryDate,
          entryType: cleanText(body.entryType) || "RECEIPT",
          branchCode,
          moneySourceCode,
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
      const accrualCount = await prisma.accrual.count();
      const result = await prisma.accrual.create({
        data: {
          code: generateFormattedVoucherCode({ voucherType: "PBOU", voucherDate: `${startPeriod}-01`, branchCode, seqNumber: accrualCount + 1 }),
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
