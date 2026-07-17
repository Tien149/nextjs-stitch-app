import { prisma } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";
import { periodBounds } from "@/lib/accounting";

type PnlBucket = {
  revenue: number;
  cogs: number;
  payroll: number;
  depreciation: number;
  otherOpex: number;
  otherIncome: number;
  otherExpense: number;
};

function emptyPnl(): PnlBucket {
  return { revenue: 0, cogs: 0, payroll: 0, depreciation: 0, otherOpex: 0, otherIncome: 0, otherExpense: 0 };
}

function addLine(bucket: PnlBucket, line: { debit: number; credit: number; account: { accountType: string; reportGroup: string } }) {
  const expense = line.debit - line.credit;
  const income = line.credit - line.debit;
  if (line.account.accountType === "REVENUE") bucket.revenue += income;
  else if (line.account.accountType === "COGS") bucket.cogs += expense;
  else if (line.account.accountType === "OPEX" && line.account.reportGroup === "PAYROLL") bucket.payroll += expense;
  else if (line.account.accountType === "OPEX" && line.account.reportGroup === "DEPRECIATION") bucket.depreciation += expense;
  else if (line.account.accountType === "OPEX") bucket.otherOpex += expense;
  else if (line.account.accountType === "OTHER_INCOME") bucket.otherIncome += income;
  else if (line.account.accountType === "OTHER_EXPENSE") bucket.otherExpense += expense;
}

export function finalizePnl(bucket: PnlBucket) {
  const grossProfit = bucket.revenue - bucket.cogs;
  const opexBeforeDepreciation = bucket.payroll + bucket.otherOpex;
  const ebitda = grossProfit - opexBeforeDepreciation;
  const operatingProfit = ebitda - bucket.depreciation;
  const netProfit = operatingProfit + bucket.otherIncome - bucket.otherExpense;
  return { ...bucket, grossProfit, opexBeforeDepreciation, ebitda, operatingProfit, netProfit, grossMargin: bucket.revenue ? grossProfit / bucket.revenue : 0, ebitdaMargin: bucket.revenue ? ebitda / bucket.revenue : 0 };
}

export async function getPnl(period: string, branchCode: string) {
  const { start, end } = periodBounds(period);
  const entries = await prisma.journalEntry.findMany({
    where: { entryDate: { gte: start, lt: end }, status: "POSTED", ...(branchCode === "ALL" ? {} : { branchCode }) },
    include: { lines: { include: { account: true } } },
  });
  const total = emptyPnl();
  const branches = new Map<string, PnlBucket>();
  const departments = new Map<string, PnlBucket>();
  for (const entry of entries) {
    const branch = branches.get(entry.branchCode) || emptyPnl();
    for (const line of entry.lines) {
      addLine(total, line);
      addLine(branch, line);
      const departmentCode = line.departmentCode || "UNALLOCATED";
      const department = departments.get(departmentCode) || emptyPnl();
      addLine(department, line);
      departments.set(departmentCode, department);
    }
    branches.set(entry.branchCode, branch);
  }
  return {
    total: finalizePnl(total),
    byBranch: Array.from(branches, ([code, bucket]) => ({ code, ...finalizePnl(bucket) })).sort((a, b) => b.revenue - a.revenue),
    byDepartment: Array.from(departments, ([code, bucket]) => ({ code, ...finalizePnl(bucket) })).sort((a, b) => b.payroll + b.otherOpex - (a.payroll + a.otherOpex)),
  };
}

export async function getBalanceSheet(period: string, branchCode: string) {
  const { end } = periodBounds(period);
  const entries = await prisma.journalEntry.findMany({
    where: { entryDate: { lt: end }, status: "POSTED", ...(branchCode === "ALL" ? {} : { branchCode }) },
    include: { lines: { include: { account: true } } },
  });
  const groups = new Map<string, { code: string; name: string; accountType: string; reportGroup: string; amount: number }>();
  let cumulativeProfit = 0;
  for (const entry of entries) for (const line of entry.lines) {
    const account = line.account;
    const amount = account.normalBalance === "DEBIT" ? line.debit - line.credit : line.credit - line.debit;
    const current = groups.get(account.code) || { code: account.code, name: account.name, accountType: account.accountType, reportGroup: account.reportGroup, amount: 0 };
    current.amount += amount;
    groups.set(account.code, current);
    if (["REVENUE", "OTHER_INCOME"].includes(account.accountType)) cumulativeProfit += line.credit - line.debit;
    if (["COGS", "OPEX", "OTHER_EXPENSE"].includes(account.accountType)) cumulativeProfit -= line.debit - line.credit;
  }
  const rows = Array.from(groups.values()).filter((row) => Math.abs(row.amount) > 0.5).sort((a, b) => a.code.localeCompare(b.code));
  const assets = rows.filter((row) => row.accountType === "ASSET").reduce((sum, row) => sum + (row.reportGroup === "ACCUMULATED_DEPRECIATION" ? -row.amount : row.amount), 0);
  const liabilities = rows.filter((row) => row.accountType === "LIABILITY").reduce((sum, row) => sum + row.amount, 0);
  const contributedEquity = rows.filter((row) => row.accountType === "EQUITY").reduce((sum, row) => sum + row.amount, 0);
  const equity = contributedEquity + cumulativeProfit;
  return { rows, assets, liabilities, contributedEquity, retainedEarnings: cumulativeProfit, equity, difference: assets - liabilities - equity, balanced: Math.abs(assets - liabilities - equity) <= 1 };
}

export async function getTrend(period: string, branchCode: string, months = 6) {
  const periods = Array.from({ length: months }, (_, index) => addPeriod(period, index - months + 1));
  return Promise.all(periods.map(async (item) => ({ period: item, ...(await getPnl(item, branchCode)).total })));
}

export async function getCashflowForecast(period: string, branchCode: string, scenario: string) {
  const balance = await getBalanceSheet(period, branchCode);
  const cash = balance.rows.filter((row) => row.reportGroup === "CASH").reduce((sum, row) => sum + row.amount, 0);
  const futurePeriods = Array.from({ length: 3 }, (_, index) => addPeriod(period, index + 1));
  const [payables, accruals, assumptions] = await Promise.all([
    prisma.supplierPayable.aggregate({ where: { status: "OPEN", ...(branchCode === "ALL" ? {} : { purchaseOrder: { branchCode } }) }, _sum: { outstandingAmount: true } }),
    prisma.accrualSchedule.findMany({ where: { period: { in: futurePeriods }, status: "PLANNED", ...(branchCode === "ALL" ? {} : { accrual: { branchCode } }) }, include: { accrual: true } }),
    prisma.forecastAssumption.findMany({ where: { period: { in: futurePeriods }, scenario, ...(branchCode === "ALL" ? {} : { branchCode }) } }),
  ]);
  let runningCash = cash;
  const schedule = futurePeriods.map((futurePeriod, index) => {
    const planned = assumptions.filter((row) => row.period === futurePeriod);
    const inflow = planned.filter((row) => row.assumptionType === "INFLOW").reduce((sum, row) => sum + row.amount, 0);
    const manualOutflow = planned.filter((row) => row.assumptionType === "OUTFLOW").reduce((sum, row) => sum + row.amount, 0);
    const accrualOutflow = accruals.filter((row) => row.period === futurePeriod).reduce((sum, row) => sum + row.amount, 0);
    const payableOutflow = index === 0 ? payables._sum.outstandingAmount || 0 : 0;
    const outflow = manualOutflow + accrualOutflow + payableOutflow;
    runningCash += inflow - outflow;
    return { period: futurePeriod, openingCash: index === 0 ? cash : 0, inflow, outflow, closingCash: runningCash, risk: runningCash < 0 };
  });
  return { scenario, startingCash: cash, schedule };
}
