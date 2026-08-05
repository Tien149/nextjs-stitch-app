import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { allowedMenuTabs, canViewFinancialDashboard } from "@/lib/auth-demo";
import { requestedBranch } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { getBalanceSheet, getCashSourceReport, getCashflowForecast, getPnl, getTrend } from "@/lib/reports";
import { apiError, businessError, cleanText, isPeriodLocked, normalizePeriod, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { moneySourceDisplayName, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { voucherMatchesShift } from "@/lib/shifts";

const menuHref = "/reports";

type DailyCashBucket = { total: number; cash: number; transfer: number; card: number; grab: number; other: number };

function monthRange(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
}

function dayRange(dateText: string, shift: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : new Date().toISOString().slice(0, 10);
  const startHour = shift === "EVENING" ? 15 : 0;
  const endHour = shift === "MORNING" ? 15 : 24;
  return {
    date,
    start: new Date(`${date}T${String(startHour).padStart(2, "0")}:00:00`),
    end: new Date(`${date}T${String(endHour).padStart(2, "0")}:00:00`),
  };
}

function addAmount(bucket: DailyCashBucket, key: keyof Omit<DailyCashBucket, "total">, amount: number) {
  bucket.total += amount;
  bucket[key] += amount;
}

function classifyPayment(paymentMethod: string | null | undefined, channel?: string | null) {
  const method = (paymentMethod || "").toUpperCase();
  const saleChannel = (channel || "").toUpperCase();
  if (saleChannel.includes("GRAB") || method.includes("GRAB")) return "grab" as const;
  if (method.includes("CASH") || method.includes("TIEN MAT") || method.includes("TIỀN MẶT")) return "cash" as const;
  if (method.includes("CARD") || method.includes("POS") || method.includes("QUET") || method.includes("QUẸT")) return "card" as const;
  if (method.includes("BANK") || method.includes("TRANSFER") || method.includes("CHUYEN") || method.includes("CHUYỂN")) return "transfer" as const;
  return "other" as const;
}

function classifyMoneySource(group: string | null | undefined) {
  const normalized = normalizeMoneySourceGroup(group);
  if (normalized === "CASH") return "cash" as const;
  if (normalized === "BANK") return "transfer" as const;
  if (normalized === "WALLET") return "card" as const;
  return "other" as const;
}

function addStatus(statusCounts: Record<string, number>, status: string) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
}

function departmentLabel(code: string, departments: Map<string, string>) {
  if (!code || code === "UNASSIGNED") return "Chưa gán phòng ban";
  return departments.get(code) || code;
}

function addGroup(
  groups: Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>,
  departmentCode: string,
  departments: Map<string, string>,
  amount: number,
  status: string,
  overdue = false,
) {
  const code = departmentCode || "UNASSIGNED";
  const current = groups.get(code) || {
    departmentCode: code,
    departmentName: departmentLabel(code, departments),
    count: 0,
    amount: 0,
    statusCounts: {},
    overdue: 0,
  };
  current.count += 1;
  current.amount += amount;
  if (overdue) current.overdue = (current.overdue || 0) + 1;
  addStatus(current.statusCounts, status);
  groups.set(code, current);
}

async function getOperationsReport(period: string, branchCode: string) {
  const { start, end } = monthRange(period);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };
  const departments = await prisma.masterDataItem.findMany({ where: { type: "DEPARTMENT", status: "ACTIVE" } });
  const departmentMap = new Map(departments.map((item) => [item.code, item.name]));

  const [purchaseRequests, purchaseOrders, receipts, workItems, assets] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where: { ...branchWhere, requestDate: { gte: start, lte: end } },
      include: { lines: true },
      orderBy: { requestDate: "desc" },
      take: 200,
    }),
    prisma.purchaseOrder.findMany({
      where: { ...branchWhere, orderDate: { gte: start, lte: end } },
      include: { lines: true, request: true },
      orderBy: { orderDate: "desc" },
      take: 200,
    }),
    prisma.inventoryTransaction.findMany({
      where: { ...branchWhere, transactionType: "RECEIPT", transactionDate: { gte: start, lte: end } },
      include: { lines: true },
      orderBy: { transactionDate: "desc" },
      take: 200,
    }),
    prisma.workItem.findMany({
      where: { ...branchWhere, dueDate: { gte: start, lte: end } },
      orderBy: { dueDate: "asc" },
      take: 200,
    }),
    prisma.assetRecord.findMany({
      where: { ...branchWhere, purchaseDate: { lte: end } },
      orderBy: { purchaseDate: "desc" },
      take: 200,
    }),
  ]);

  const orderDepartmentMap = new Map(purchaseOrders.map((order) => [order.id, order.departmentCode || order.request?.departmentCode || "UNASSIGNED"]));
  const prGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const poGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const receiptGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const workGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const assetGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();

  const now = new Date();
  const prDetails = purchaseRequests.map((row) => {
    const amount = row.lines.reduce((sum, line) => sum + line.quantity * line.estimatedUnitCost, 0);
    addGroup(prGroups, row.departmentCode || "UNASSIGNED", departmentMap, amount, row.status, !!row.neededDate && row.neededDate < now && !["APPROVED", "ORDERED", "REJECTED"].includes(row.status));
    return { id: row.id, code: row.code, date: row.requestDate, branchCode: row.branchCode, departmentCode: row.departmentCode || "UNASSIGNED", departmentName: departmentLabel(row.departmentCode || "UNASSIGNED", departmentMap), status: row.status, amount, owner: row.requestedBy, note: row.reason };
  });

  const poDetails = purchaseOrders.map((row) => {
    const departmentCode = row.departmentCode || row.request?.departmentCode || "UNASSIGNED";
    addGroup(poGroups, departmentCode, departmentMap, row.totalAmount, row.status, !!row.expectedDate && row.expectedDate < now && !["COMPLETED", "CANCELLED"].includes(row.status));
    return { id: row.id, code: row.code, date: row.orderDate, branchCode: row.branchCode, departmentCode, departmentName: departmentLabel(departmentCode, departmentMap), status: row.status, amount: row.totalAmount, owner: row.supplierName, note: row.warehouseCode };
  });

  const receiptDetails = receipts.map((row) => {
    const amount = row.lines.reduce((sum, line) => sum + line.totalCost, 0);
    const departmentCode = row.referenceType === "PURCHASE_ORDER" && row.referenceId ? orderDepartmentMap.get(row.referenceId) || "UNASSIGNED" : "UNASSIGNED";
    addGroup(receiptGroups, departmentCode, departmentMap, amount, row.status);
    return { id: row.id, code: row.code, date: row.transactionDate, branchCode: row.branchCode, departmentCode, departmentName: departmentLabel(departmentCode, departmentMap), status: row.status, amount, owner: row.warehouseCode, note: row.referenceCode || row.note || "" };
  });

  const workDetails = workItems.map((row) => {
    const overdue = !["COMPLETED", "CANCELLED"].includes(row.status) && row.dueDate < now;
    addGroup(workGroups, row.departmentCode || "UNASSIGNED", departmentMap, 0, row.status, overdue);
    return { id: row.id, code: row.code, date: row.dueDate, branchCode: row.branchCode, departmentCode: row.departmentCode || "UNASSIGNED", departmentName: departmentLabel(row.departmentCode || "UNASSIGNED", departmentMap), status: row.status, amount: 0, owner: row.assigneeName, note: row.title, overdue };
  });

  const assetDetails = assets.map((row) => {
    addGroup(assetGroups, row.departmentCode || "UNASSIGNED", departmentMap, row.currentValue, row.status);
    return { id: row.id, code: row.code, date: row.purchaseDate, branchCode: row.branchCode, departmentCode: row.departmentCode || "UNASSIGNED", departmentName: departmentLabel(row.departmentCode || "UNASSIGNED", departmentMap), status: row.status, amount: row.currentValue, owner: row.supplierName || "", note: row.name };
  });

  const toRows = (groups: typeof prGroups) => Array.from(groups.values()).sort((a, b) => b.count - a.count || b.amount - a.amount);
  const amountOf = (items: Array<{ amount: number }>) => items.reduce((sum, item) => sum + item.amount, 0);

  return {
    period,
    branchCode,
    summary: {
      purchaseRequests: { count: prDetails.length, amount: amountOf(prDetails) },
      purchaseOrders: { count: poDetails.length, amount: amountOf(poDetails) },
      receipts: { count: receiptDetails.length, amount: amountOf(receiptDetails) },
      workItems: { count: workDetails.length, overdue: workDetails.filter((item) => item.overdue).length },
      assets: { count: assetDetails.length, amount: amountOf(assetDetails) },
    },
    groups: {
      purchaseRequests: toRows(prGroups),
      purchaseOrders: toRows(poGroups),
      receipts: toRows(receiptGroups),
      workItems: toRows(workGroups),
      assets: toRows(assetGroups),
    },
    details: {
      purchaseRequests: prDetails,
      purchaseOrders: poDetails,
      receipts: receiptDetails,
      workItems: workDetails,
      assets: assetDetails,
    },
  };
}

const budgetMetrics = [
  { metric: "revenue", label: "Doanh thu", kind: "REVENUE" },
  { metric: "cogs", label: "Giá vốn", kind: "EXPENSE" },
  { metric: "payroll", label: "Chi phí nhân sự", kind: "EXPENSE" },
  { metric: "otherOpex", label: "OPEX khác", kind: "EXPENSE" },
  { metric: "depreciation", label: "Khấu hao", kind: "EXPENSE" },
  { metric: "opexBeforeDepreciation", label: "OPEX trước khấu hao", kind: "EXPENSE" },
  { metric: "ebitda", label: "EBITDA", kind: "PROFIT" },
] as const;

async function getBudgetReport(period: string, branchCode: string) {
  const pnl = await getPnl(period, branchCode);
  const targets = await prisma.reportTarget.findMany({
    where: { period, branchCode },
  });
  const targetMap = new Map(targets.map((target) => [target.metric, target.targetValue]));

  const rows = budgetMetrics.map((item) => {
    const actual = pnl.total[item.metric];
    const target = targetMap.get(item.metric) || 0;
    const variance = actual - target;
    const usageRate = target ? actual / target : null;
    const isGood = item.kind === "REVENUE" || item.kind === "PROFIT" ? variance >= 0 : variance <= 0;
    return { ...item, actual, target, variance, usageRate, isGood };
  });

  return {
    period,
    branchCode,
    rows,
    summary: {
      expenseActual: pnl.total.cogs + pnl.total.payroll + pnl.total.otherOpex + pnl.total.depreciation,
      expenseTarget: rows.filter((row) => row.kind === "EXPENSE").reduce((sum, row) => sum + row.target, 0),
      revenueActual: pnl.total.revenue,
      revenueTarget: targetMap.get("revenue") || 0,
    },
  };
}

// Xem "Cả ngày" phải gộp cả bản ghi ca sáng lẫn ca tối; xem một ca thì chỉ lấy đúng ca đó.
function manualShiftFilter(shift: string) {
  return shift === "FULL" ? {} : { shift };
}

async function getDailyCashReport(period: string, branchCode: string, reportDate: string, shift: string) {
  const { date, start, end } = dayRange(reportDate || `${period}-01`, shift);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T24:00:00`);

  const [revenues, deposits, allPaymentVouchers, allReceiptVouchers, moneySources, manualEntries] = await Promise.all([
    prisma.revenueImportRow.findMany({
      where: { ...branchWhere, saleDate: { gte: start, lt: end } },
      orderBy: [{ saleDate: "asc" }, { externalRef: "asc" }],
      take: 1000,
    }),
    prisma.deposit.findMany({
      where: { ...branchWhere, receivedDate: { gte: start, lt: end }, status: { not: "CANCELLED" } },
      orderBy: [{ receivedDate: "asc" }, { code: "asc" }],
      take: 500,
    }),
    prisma.financialVoucher.findMany({
      where: { ...branchWhere, voucherType: "PAYMENT", voucherDate: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELLED" } },
      orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
      take: 500,
    }),
    prisma.financialVoucher.findMany({
      where: { ...branchWhere, voucherType: "RECEIPT", voucherDate: { gte: dayStart, lt: dayEnd }, status: { not: "CANCELLED" } },
      orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
      take: 500,
    }),
    prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", status: "ACTIVE" } }),
    prisma.manualRevenueEntry.findMany({
      where: { ...branchWhere, reportDate: { gte: dayStart, lt: dayEnd }, ...manualShiftFilter(shift) },
      orderBy: [{ reportDate: "asc" }, { shift: "asc" }],
    }),
  ]);

  // Phiếu khai ca nào thì thuộc ca đó; phiếu cũ chưa khai vẫn xét theo giờ lập như trước.
  const vouchers = allPaymentVouchers.filter((row) => voucherMatchesShift(row.shift, row.voucherDate, shift));
  const receiptVouchers = allReceiptVouchers.filter((row) => voucherMatchesShift(row.shift, row.voucherDate, shift));

  const sourceByCode = new Map(moneySources.map((source) => [source.code, source]));
  // Ba nguồn doanh thu đổ chung vào một dòng "Doanh thu bán hàng"; vẫn giữ tổng riêng
  // từng nguồn để cảnh báo trùng và để các bảng chi tiết đối chiếu.
  const revenue = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const posRevenue = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const manual = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const receipt = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const deposit = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };

  for (const row of revenues) {
    const bucketKey = classifyPayment(row.paymentMethod, row.channel);
    addAmount(posRevenue, bucketKey, row.netAmount);
    addAmount(revenue, bucketKey, row.netAmount);
  }

  for (const row of manualEntries) {
    for (const [key, value] of [
      ["cash", row.cashAmount],
      ["transfer", row.transferAmount],
      ["card", row.cardAmount],
      ["grab", row.grabAmount],
      ["other", row.otherAmount],
    ] as const) {
      addAmount(manual, key, value);
      addAmount(revenue, key, value);
    }
  }

  // Phiếu thu là chứng từ thu tiền thật trên hệ thống -> xếp theo nhóm nguồn tiền của phiếu.
  const receipts = receiptVouchers.map((row) => {
    const source = sourceByCode.get(row.moneySourceCode);
    return {
      id: row.id,
      code: row.code,
      date: row.voucherDate,
      shift: row.shift,
      description: row.description,
      partnerName: row.partnerName,
      status: row.status,
      moneySourceCode: row.moneySourceCode,
      moneySourceName: source ? moneySourceDisplayName(source) : row.moneySourceCode,
      moneySourceGroup: source?.group || null,
      amount: row.amount,
      isCash: normalizeMoneySourceGroup(source?.group) === "CASH",
    };
  });

  // Phiếu thu có khoản mục thuộc nhóm doanh thu nên cộng thẳng vào dòng "Doanh thu bán hàng";
  // vẫn giữ tổng riêng để bảng "Các khoản thu chi tiết" đối chiếu được.
  for (const row of receiptVouchers) {
    const source = sourceByCode.get(row.moneySourceCode);
    const bucketKey = classifyMoneySource(source?.group);
    addAmount(receipt, bucketKey, row.amount);
    addAmount(revenue, bucketKey, row.amount);
  }

  for (const row of deposits) {
    const source = sourceByCode.get(row.moneySourceCode);
    addAmount(deposit, classifyMoneySource(source?.group), row.amount);
  }

  const expenses = vouchers.map((row) => {
    const source = sourceByCode.get(row.moneySourceCode);
    return {
      id: row.id,
      code: row.code,
      date: row.voucherDate,
      shift: row.shift,
      description: row.description,
      partnerName: row.partnerName,
      moneySourceCode: row.moneySourceCode,
      moneySourceName: source ? moneySourceDisplayName(source) : row.moneySourceCode,
      moneySourceGroup: source?.group || null,
      amount: row.amount,
      isCash: normalizeMoneySourceGroup(source?.group) === "CASH",
    };
  });

  const expenseTotal = expenses.reduce((sum, row) => sum + row.amount, 0);
  const cashExpenseTotal = expenses.filter((row) => row.isCash).reduce((sum, row) => sum + row.amount, 0);
  // revenue đã gộp cả doanh thu import, nhập tay và phiếu thu.
  const total = {
    total: revenue.total + deposit.total,
    cash: revenue.cash + deposit.cash,
    transfer: revenue.transfer + deposit.transfer,
    card: revenue.card + deposit.card,
    grab: revenue.grab + deposit.grab,
    other: revenue.other + deposit.other,
  };

  return {
    period,
    branchCode,
    reportDate: date,
    shift,
    summary: { revenue, posRevenue, manual, receipt, deposit, total, expenseTotal, cashExpenseTotal, cashToDeposit: total.cash - cashExpenseTotal },
    expenses,
    receipts,
    manualEntries: manualEntries.map((row) => ({
      id: row.id,
      shift: row.shift,
      branchCode: row.branchCode,
      cashAmount: row.cashAmount,
      transferAmount: row.transferAmount,
      cardAmount: row.cardAmount,
      grabAmount: row.grabAmount,
      otherAmount: row.otherAmount,
      totalAmount: row.totalAmount,
      note: row.note,
      updatedBy: row.updatedBy || row.createdBy,
      updatedAt: row.updatedAt,
    })),
    // Cùng một ngày/ca mà có cả doanh thu import lẫn doanh thu nhập tay thì rất dễ tính trùng.
    duplicateRevenueWarning: posRevenue.total > 0 && manual.total > 0,
    moneyInReconciliation: await buildMoneyInReconciliation(revenue, branchCode, dayStart, dayEnd),
  };
}

/**
 * Đối chiếu "tiền vô đã đủ chưa" cho kế toán.
 *
 * Thu ngân khai doanh thu theo hình thức thanh toán; kế toán chỉ biết tiền thật khi
 * sao kê ngân hàng về. Bảng này đặt hai con số cạnh nhau cho từng hình thức:
 * - Chuyển khoản: khai bao nhiêu vs sao kê ngân hàng ghi có bấy nhiêu trong ngày.
 * - Quẹt thẻ/ví: khai bao nhiêu vs số đã quyết toán từ ví về ngân hàng (gồm cả phí),
 *   vì cổng thanh toán thường trả tiền sau vài ngày nên phần chưa về vẫn nằm ở ví.
 * - Tiền mặt: khai bao nhiêu vs phiếu nộp tiền đã lập cho ngày đó.
 */
async function buildMoneyInReconciliation(
  declared: DailyCashBucket,
  branchCode: string,
  dayStart: Date,
  dayEnd: Date,
) {
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };
  const [bankRows, walletSettlements, cashDeposits] = await Promise.all([
    prisma.bankStatementTransaction.findMany({
      where: { ...branchWhere, transactionDate: { gte: dayStart, lt: dayEnd }, creditAmount: { gt: 0 } },
      select: { creditAmount: true, bankAccount: true, transactionCode: true, description: true, categoryCode: true },
    }),
    prisma.moneyTransfer.findMany({
      where: { ...branchWhere, transferPurpose: "WALLET_SETTLEMENT", status: "APPROVED", sourceReportDate: { gte: dayStart, lt: dayEnd } },
      select: { amount: true, feeAmount: true },
    }),
    prisma.moneyTransfer.findMany({
      where: { ...branchWhere, transferPurpose: "CASH_DEPOSIT", status: { in: ["PENDING_REVIEW", "APPROVED"] }, sourceReportDate: { gte: dayStart, lt: dayEnd } },
      select: { amount: true, status: true },
    }),
  ]);

  const bankReceived = bankRows.reduce((sum, row) => sum + row.creditAmount, 0);
  const walletSettled = walletSettlements.reduce((sum, row) => sum + row.amount + row.feeAmount, 0);
  const walletFee = walletSettlements.reduce((sum, row) => sum + row.feeAmount, 0);
  const cashDeposited = cashDeposits.reduce((sum, row) => sum + row.amount, 0);

  const rows = [
    { key: "cash", label: "Tiền mặt", declared: declared.cash, received: cashDeposited, note: "Đối chiếu với phiếu nộp tiền đã lập cho ngày này." },
    { key: "transfer", label: "Chuyển khoản", declared: declared.transfer, received: bankReceived, note: "Đối chiếu với các dòng ghi có trên sao kê ngân hàng trong ngày." },
    { key: "card", label: "Quẹt thẻ / Ví", declared: declared.card + declared.grab, received: walletSettled, note: "Cổng thanh toán trả tiền sau, phần chưa quyết toán vẫn nằm ở nguồn ví." },
  ].map((row) => {
    const difference = row.received - row.declared;
    return {
      ...row,
      difference,
      // Lệch dưới 1.000 đ coi như khớp: chênh lẻ do làm tròn phí, không phải thiếu tiền.
      status: Math.abs(difference) < 1000 ? "MATCHED" : difference < 0 ? "SHORT" : "OVER",
    };
  });

  return {
    rows,
    walletFee,
    bankRowCount: bankRows.length,
    unclassifiedBankRows: bankRows.filter((row) => !row.categoryCode).length,
  };
}

async function getActivityReport(period: string, branchCode: string) {
  const { start, end } = monthRange(period);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };

  const [accountingPeriod, periods, auditLogs, importBatches, journalEntries, workHistories] = await Promise.all([
    prisma.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode } } }),
    prisma.accountingPeriod.findMany({
      where: { period, ...(branchCode === "ALL" ? {} : { branchCode }) },
      orderBy: [{ branchCode: "asc" }, { updatedAt: "desc" }],
    }),
    prisma.auditLog.findMany({
      where: {
        occurredAt: { gte: start, lte: end },
        ...(branchCode === "ALL" ? {} : { OR: [{ branchCode }, { branchCode: null }] }),
      },
      orderBy: { occurredAt: "desc" },
      take: 200,
    }),
    prisma.importBatch.findMany({
      where: { createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
    prisma.journalEntry.findMany({
      where: { ...branchWhere, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
    prisma.workItemHistory.findMany({
      where: { createdAt: { gte: start, lte: end }, ...(branchCode === "ALL" ? {} : { workItem: { branchCode } }) },
      include: { workItem: true },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
  ]);

  const logs = [
    ...auditLogs.map((row) => ({
      id: row.id,
      time: row.occurredAt,
      module: row.module,
      action: row.action,
      actor: row.actorName || "-",
      branchCode: row.branchCode || "ALL",
      code: row.entityCode || row.entityId || row.entityType,
      note: row.message || row.entityType,
    })),
    ...importBatches.map((row) => ({
      id: row.id,
      time: row.createdAt,
      module: "IMPORT",
      action: row.status,
      actor: row.uploadedBy,
      branchCode: "ALL",
      code: row.fileName,
      note: `${row.importType} - ${row.totalRows} dòng`,
    })),
    ...journalEntries.map((row) => ({
      id: row.id,
      time: row.createdAt,
      module: "ACCOUNTING",
      action: row.status,
      actor: row.createdBy || "-",
      branchCode: row.branchCode,
      code: row.code,
      note: `${row.sourceType} - ${row.description}`,
    })),
    ...workHistories.map((row) => ({
      id: row.id,
      time: row.createdAt,
      module: "WORKFLOW",
      action: row.action,
      actor: row.actor || "-",
      branchCode: row.workItem.branchCode,
      code: row.workItem.code,
      note: `${row.fromStatus || "-"} -> ${row.toStatus || "-"} ${row.note || ""}`.trim(),
    })),
    ...periods.flatMap((row) => [
      row.closedAt ? {
        id: `${row.id}-closed`,
        time: row.closedAt,
        module: "PERIOD",
        action: "CLOSED",
        actor: row.closedBy || "-",
        branchCode: row.branchCode,
        code: row.period,
        note: "Khóa kỳ kế toán",
      } : null,
      row.reopenedAt ? {
        id: `${row.id}-reopened`,
        time: row.reopenedAt,
        module: "PERIOD",
        action: "REOPENED",
        actor: row.reopenedBy || "-",
        branchCode: row.branchCode,
        code: row.period,
        note: row.reason || "Mở lại kỳ kế toán",
      } : null,
    ]).filter((row): row is { id: string; time: Date; module: string; action: string; actor: string; branchCode: string; code: string; note: string } => row !== null),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 160);

  return {
    period,
    branchCode,
    accountingPeriod: accountingPeriod || { period, branchCode, status: "OPEN", reason: null, closedBy: null, closedAt: null, reopenedBy: null, reopenedAt: null },
    periods,
    logs,
  };
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    if (!canViewFinancialDashboard(auth.session.role)) {
      return NextResponse.json({ error: "Bạn không có quyền xem Dashboard/Báo cáo tài chính" }, { status: 403 });
    }
    const params = new URL(request.url).searchParams;
    const type = cleanText(params.get("type")) || "dashboard";
    const period = normalizePeriod(params.get("period")) || new Date().toISOString().slice(0, 7);
    const branchCode = requestedBranch(auth.session, cleanText(params.get("branchCode")) || "ALL");

    // Ẩn tab ở giao diện là chưa đủ: gõ thẳng URL vẫn lấy được số liệu nếu API không chặn.
    const permittedTabs = allowedMenuTabs(auth.session, menuHref);
    if (permittedTabs && !permittedTabs.includes(type)) {
      return NextResponse.json({ error: "Bạn không có quyền xem báo cáo này" }, { status: 403 });
    }
    if (type === "operations") return NextResponse.json(await getOperationsReport(period, branchCode));
    if (type === "budget") return NextResponse.json(await getBudgetReport(period, branchCode));
    if (type === "daily-cash") return NextResponse.json(await getDailyCashReport(period, branchCode, cleanText(params.get("reportDate")) || `${period}-01`, cleanText(params.get("shift")) || "FULL"));
    if (type === "activity") return NextResponse.json(await getActivityReport(period, branchCode));
    if (type === "pnl") return NextResponse.json({ period, branchCode, ...(await getPnl(period, branchCode)) });
    if (type === "yoy") {
      const previousPeriod = `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
      const [current, previous] = await Promise.all([getPnl(period, branchCode), getPnl(previousPeriod, branchCode)]);
      const metrics = ["revenue", "cogs", "grossProfit", "opexBeforeDepreciation", "ebitda", "netProfit"] as const;
      return NextResponse.json({ period, previousPeriod, branchCode, rows: metrics.map((metric) => { const currentValue = current.total[metric]; const previousValue = previous.total[metric]; return { metric, currentValue, previousValue, variance: currentValue - previousValue, varianceRate: previousValue ? (currentValue - previousValue) / Math.abs(previousValue) : null }; }) });
    }
    if (type === "cash-source") {
      // Xem theo năm thì trải 12 tháng của năm đang chọn, xem theo tháng thì chỉ một kỳ.
      const view = cleanText(params.get("view")) === "year" ? "year" : "month";
      const year = period.slice(0, 4);
      const months = view === "year"
        ? Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`)
        : [period];
      return NextResponse.json({ period, view, year, ...(await getCashSourceReport(months, branchCode)) });
    }
    if (type === "cashflow") return NextResponse.json({ period, branchCode, ...(await getCashflowForecast(period, branchCode, cleanText(params.get("scenario")) || "BASE")) });
    if (type === "balance") return NextResponse.json({ period, branchCode, ...(await getBalanceSheet(period, branchCode)) });
    const [pnl, trend, balance, targets] = await Promise.all([getPnl(period, branchCode), getTrend(period, branchCode), getBalanceSheet(period, branchCode), prisma.reportTarget.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { branchCode }) } })]);
    return NextResponse.json({ period, branchCode, pnl, trend, balance, targets });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const action = cleanText(body.action);
    const period = normalizePeriod(body.period);
    const branchCode = requestedBranch(auth.session, cleanText(body.branchCode));
    if (!period || !branchCode) businessError("Thiếu kỳ hoặc chi nhánh");

    // Thu ngân kết ca tự nhập doanh thu khi chưa kịp import file POS.
    if (action === "UPSERT_MANUAL_REVENUE") {
      const reportDateText = cleanText(body.reportDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDateText)) businessError("Ngày báo cáo không hợp lệ.");
      const shift = (cleanText(body.shift) || "FULL").toUpperCase();
      if (!["FULL", "MORNING", "EVENING"].includes(shift)) businessError("Ca làm việc không hợp lệ.");
      if (branchCode === "ALL") businessError("Chọn một cửa hàng cụ thể trước khi nhập doanh thu.");

      const reportDate = new Date(`${reportDateText}T00:00:00`);
      if (await isPeriodLocked(reportDate, branchCode)) {
        businessError(`Kỳ kế toán của ngày ${reportDateText} đã chốt sổ, không nhập thêm doanh thu được.`);
      }

      const amounts = {
        cashAmount: toNumber(body.cashAmount),
        transferAmount: toNumber(body.transferAmount),
        cardAmount: toNumber(body.cardAmount),
        grabAmount: toNumber(body.grabAmount),
        otherAmount: toNumber(body.otherAmount),
      };
      if (Object.values(amounts).some((value) => value < 0)) businessError("Số tiền không được âm.");
      const totalAmount = Object.values(amounts).reduce((sum, value) => sum + value, 0);
      if (totalAmount <= 0) businessError("Phải nhập ít nhất một khoản tiền lớn hơn 0.");

      // Nhập "Cả ngày" rồi lại nhập từng ca (hoặc ngược lại) sẽ cộng trùng khi xem báo cáo.
      const conflictShifts = shift === "FULL" ? ["MORNING", "EVENING"] : ["FULL"];
      const conflict = await prisma.manualRevenueEntry.findFirst({
        where: { branchCode, reportDate, shift: { in: conflictShifts } },
      });
      if (conflict) {
        const conflictLabel = conflict.shift === "FULL" ? "Cả ngày" : conflict.shift === "MORNING" ? "Ca sáng" : "Ca tối";
        businessError(
          shift === "FULL"
            ? `Ngày này đã có doanh thu nhập tay cho ${conflictLabel}. Hãy sửa bản ghi theo ca thay vì nhập thêm cho cả ngày.`
            : `Ngày này đã có doanh thu nhập tay cho ${conflictLabel}. Hãy sửa bản ghi đó thay vì nhập thêm theo ca.`
        );
      }

      const result = await prisma.manualRevenueEntry.upsert({
        where: { branchCode_reportDate_shift: { branchCode, reportDate, shift } },
        create: { branchCode, reportDate, shift, ...amounts, totalAmount, note: cleanText(body.note) || null, createdBy: auth.session.name, updatedBy: auth.session.name },
        update: { ...amounts, totalAmount, note: cleanText(body.note) || null, updatedBy: auth.session.name },
      });

      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "UPSERT_MANUAL_REVENUE",
        entityType: "ManualRevenueEntry",
        entityId: result.id,
        entityCode: `${reportDateText}-${branchCode}-${shift}`,
        branchCode,
        metadata: { reportDate: reportDateText, shift, ...amounts, totalAmount },
      });
      return NextResponse.json(result);
    }

    if (action === "DELETE_MANUAL_REVENUE") {
      const entryId = cleanText(body.entryId);
      if (!entryId) businessError("Thiếu bản ghi cần xoá.");
      const existing = await prisma.manualRevenueEntry.findUnique({ where: { id: entryId } });
      if (!existing) businessError("Không tìm thấy bản ghi doanh thu nhập tay.");
      if (branchCode !== "ALL" && existing.branchCode !== branchCode) businessError("Bản ghi không thuộc cửa hàng đã chọn.");
      if (await isPeriodLocked(existing.reportDate, existing.branchCode)) {
        businessError("Kỳ kế toán của bản ghi này đã chốt sổ, không xoá được.");
      }

      await prisma.manualRevenueEntry.delete({ where: { id: entryId } });
      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "DELETE_MANUAL_REVENUE",
        entityType: "ManualRevenueEntry",
        entityId: existing.id,
        entityCode: `${existing.reportDate.toISOString().slice(0, 10)}-${existing.branchCode}-${existing.shift}`,
        branchCode: existing.branchCode,
        metadata: { totalAmount: existing.totalAmount },
      });
      return NextResponse.json({ ok: true });
    }

    if (!canViewFinancialDashboard(auth.session.role)) {
      return NextResponse.json({ error: "Bạn không có quyền cấu hình báo cáo tài chính" }, { status: 403 });
    }
    if (action === "UPSERT_FORECAST") {
      const result = await prisma.forecastAssumption.upsert({
        where: { period_branchCode_scenario_assumptionType: { period, branchCode, scenario: cleanText(body.scenario) || "BASE", assumptionType: cleanText(body.assumptionType) || "INFLOW" } },
        create: { period, branchCode, scenario: cleanText(body.scenario) || "BASE", assumptionType: cleanText(body.assumptionType) || "INFLOW", amount: toNumber(body.amount), note: cleanText(body.note) || null, createdBy: auth.session.name },
        update: { amount: toNumber(body.amount), note: cleanText(body.note) || null, createdBy: auth.session.name },
      });
      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "UPSERT_FORECAST",
        entityType: "ForecastAssumption",
        entityId: result.id,
        entityCode: `${result.period}-${result.scenario}-${result.assumptionType}`,
        branchCode,
        metadata: { period, scenario: result.scenario, assumptionType: result.assumptionType, amount: result.amount },
      });
      return NextResponse.json(result);
    }
    if (action === "UPSERT_TARGET") {
      const metric = cleanText(body.metric);
      if (!metric) businessError("Thiếu chỉ tiêu KPI");
      const result = await prisma.reportTarget.upsert({ where: { period_branchCode_metric: { period, branchCode, metric } }, create: { period, branchCode, metric, targetValue: toNumber(body.targetValue) }, update: { targetValue: toNumber(body.targetValue) } });
      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "UPSERT_TARGET",
        entityType: "ReportTarget",
        entityId: result.id,
        entityCode: `${result.period}-${result.metric}`,
        branchCode,
        metadata: { period, metric, targetValue: result.targetValue },
      });
      return NextResponse.json(result);
    }
    businessError("Thao tác báo cáo không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
