import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { requestedBranch } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { getBalanceSheet, getCashflowForecast, getPnl, getTrend } from "@/lib/reports";
import { apiError, businessError, cleanText, normalizePeriod, toNumber } from "@/lib/phase3";

const menuHref = "/reports";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const params = new URL(request.url).searchParams;
    const type = cleanText(params.get("type")) || "dashboard";
    const period = normalizePeriod(params.get("period")) || new Date().toISOString().slice(0, 7);
    const branchCode = requestedBranch(auth.session, cleanText(params.get("branchCode")) || "ALL");
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
      return NextResponse.json(result);
    }
    if (action === "UPSERT_TARGET") {
      const metric = cleanText(body.metric);
      if (!metric) businessError("Thiếu chỉ tiêu KPI");
      const result = await prisma.reportTarget.upsert({ where: { period_branchCode_metric: { period, branchCode, metric } }, create: { period, branchCode, metric, targetValue: toNumber(body.targetValue) }, update: { targetValue: toNumber(body.targetValue) } });
      return NextResponse.json(result);
    }
    businessError("Thao tác báo cáo không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
