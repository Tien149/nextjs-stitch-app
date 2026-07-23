import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { canViewFinancialDashboard } from "@/lib/auth-demo";
import { requestedBranch } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { getBalanceSheet, getCashflowForecast, getPnl, getTrend } from "@/lib/reports";
import { apiError, businessError, cleanText, normalizePeriod, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";

const menuHref = "/reports";

function monthRange(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
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
    if (type === "operations") return NextResponse.json(await getOperationsReport(period, branchCode));
    if (type === "budget") return NextResponse.json(await getBudgetReport(period, branchCode));
    if (type === "activity") return NextResponse.json(await getActivityReport(period, branchCode));
    if (type === "pnl") return NextResponse.json({ period, branchCode, ...(await getPnl(period, branchCode)) });
    if (type === "yoy") {
      const previousPeriod = `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
      const [current, previous] = await Promise.all([getPnl(period, branchCode), getPnl(previousPeriod, branchCode)]);
      const metrics = ["revenue", "cogs", "grossProfit", "opexBeforeDepreciation", "ebitda", "netProfit"] as const;
      return NextResponse.json({ period, previousPeriod, branchCode, rows: metrics.map((metric) => { const currentValue = current.total[metric]; const previousValue = previous.total[metric]; return { metric, currentValue, previousValue, variance: currentValue - previousValue, varianceRate: previousValue ? (currentValue - previousValue) / Math.abs(previousValue) : null }; }) });
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
    if (!canViewFinancialDashboard(auth.session.role)) {
      return NextResponse.json({ error: "Bạn không có quyền cấu hình báo cáo tài chính" }, { status: 403 });
    }
    const body = await request.json();
    const action = cleanText(body.action);
    const period = normalizePeriod(body.period);
    const branchCode = requestedBranch(auth.session, cleanText(body.branchCode));
    if (!period || !branchCode) businessError("Thiếu kỳ hoặc chi nhánh");
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
