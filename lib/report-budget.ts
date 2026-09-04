import { Prisma } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { createPnlDetailTree, finalizePnl, PNL_STATEMENT_LINES, type PnlBucket, type PnlLineKey, type PnlSeriesGroup, type PnlSeriesItem } from "@/lib/reports";

/* ------------------------------------------------------------------------- *
 * Báo cáo theo feedback chị Bình 26/08/2026 (report_Feedback.pdf):
 *  - getPnlMatrix: bảng P&L đầy đủ hạng mục thu/chi trải 12 tháng, group theo nhóm.
 *  - getPayrollBudgetReport: lương chuẩn theo tỷ trọng bộ phận vs lương thực chi
 *    + biến động số lượng nhân sự.
 *  - getRevenueTrendReport: doanh thu kế hoạch vs thực hiện, cùng kỳ nhiều năm.
 * Tách khỏi lib/reports.ts vì cả ba đều chạy theo NĂM (nhiều kỳ) — không được gọi
 * getPnl 12 lần (mỗi lần kéo toàn bộ bút toán của kỳ), phải gộp bằng một câu SQL.
 * ------------------------------------------------------------------------- */

export type MatrixSeries = { code: string; name: string; months: number[]; total: number };
/** Nút chi tiết (nhóm/hạng mục) kèm kế hoạch 12 tháng — null khi cấp đó không set kế hoạch được. */
export type MatrixPlannedItem = PnlSeriesItem & { plan: number[] | null; planTotal: number | null };
export type MatrixPlannedGroup = MatrixPlannedItem & { items: MatrixPlannedItem[] };
/** Một dòng KQKD trên bảng cả năm: cùng nhãn/thứ tự với bảng một kỳ, mỗi tháng một cột, kèm kế hoạch. */
export type MatrixStatementLine = { key: string; label: string; subtotal: boolean; months: number[]; total: number; plan: number[]; planTotal: number; groups: MatrixPlannedGroup[] };

export const UNASSIGNED_DEPARTMENT = "UNASSIGNED";

function yearMonths(year: string) {
  return Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
}

function emptyBucket(): PnlBucket {
  return { revenue: 0, cogs: 0, payroll: 0, depreciation: 0, otherOpex: 0, otherIncome: 0, otherExpense: 0 };
}

function bumpSeries(map: Map<string, MatrixSeries>, code: string, name: string, monthIndex: number, amount: number) {
  const current = map.get(code) || { code, name, months: Array.from({ length: 12 }, () => 0), total: 0 };
  current.months[monthIndex] += amount;
  current.total += amount;
  map.set(code, current);
}

function sortedSeries(map: Map<string, MatrixSeries>) {
  return Array.from(map.values())
    .filter((row) => Math.abs(row.total) > 0.5)
    .sort((a, b) => (a.code === "UNCLASSIFIED" || a.code === UNASSIGNED_DEPARTMENT ? 1 : b.code === "UNCLASSIFIED" || b.code === UNASSIGNED_DEPARTMENT ? -1 : b.total - a.total));
}

type MatrixLineRow = {
  period: string;
  branchCode: string;
  accountType: string;
  reportGroup: string;
  pnlItemCode: string | null;
  categoryCode: string | null;
  departmentCode: string | null;
  debit: number;
  credit: number;
};

/** Gộp bút toán của cả năm bằng một câu SQL — mỗi dòng là một tổ hợp kỳ × loại TK × hạng mục. */
async function loadYearJournalLines(firstPeriod: string, lastPeriod: string, branchCode: string) {
  return prisma.$queryRaw<MatrixLineRow[]>(Prisma.sql`
    SELECT e."period",
           e."branchCode"     AS "branchCode",
           a."accountType"    AS "accountType",
           a."reportGroup"    AS "reportGroup",
           l."pnlItemCode"    AS "pnlItemCode",
           l."categoryCode"   AS "categoryCode",
           l."departmentCode" AS "departmentCode",
           SUM(l."debit")::float8  AS debit,
           SUM(l."credit")::float8 AS credit
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    JOIN "AccountingAccount" a ON a."id" = l."accountId"
    WHERE e."status" = 'POSTED'
      AND e."deletedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND e."period" >= ${firstPeriod} AND e."period" <= ${lastPeriod}
      AND a."accountType" IN ('REVENUE', 'COGS', 'OPEX', 'OTHER_INCOME', 'OTHER_EXPENSE')
      ${branchCode === "ALL" ? Prisma.empty : Prisma.sql`AND e."branchCode" = ${branchCode}`}
    GROUP BY 1, 2, 3, 4, 5, 6, 7
  `);
}

export async function getPnlMatrix(year: string, branchCode: string) {
  const months = yearMonths(year);
  const yearStart = new Date(`${year}-01-01T00:00:00`);
  const yearEnd = new Date(`${Number(year) + 1}-01-01T00:00:00`);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [rows, pnlItems, pnlGroups, categories, departments, revenueRows, payrollRows, targets] = await Promise.all([
    loadYearJournalLines(months[0], months[11], branchCode),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true, group: true, subGroup: true } }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_GROUP" }, select: { code: true, name: true, group: true } }),
    prisma.masterDataItem.findMany({ where: { type: "REVENUE_EXPENSE_CATEGORY" }, select: { code: true, name: true } }),
    prisma.masterDataItem.findMany({ where: { type: "DEPARTMENT" }, select: { code: true, name: true } }),
    // Pie tỷ trọng phải tách được SVC và thuế GTGT thành lát riêng (đúng ảnh feedback:
    // DT bếp + DT bar + SVC + Thuế GTGT = 100%). Bút toán 511 chỉ ghi netAmount đã gộp cả
    // ba phần nên không tách được — phải đọc thẳng dòng doanh thu import.
    prisma.revenueImportRow.findMany({
      where: { saleDate: { gte: yearStart, lt: yearEnd }, ...branchFilter },
      select: { saleDate: true, departmentCode: true, channel: true, grossAmount: true, discountAmount: true, feeAmount: true, vatAmount: true },
    }),
    prisma.payrollImportRow.findMany({
      where: { period: { startsWith: `${year}-` }, ...branchFilter },
      select: { period: true, insuranceAmount: true, bonusAmount: true },
    }),
    // Ngân sách từng tháng để chart COGS/LƯƠNG vẽ đường so sánh ("so sánh dựa vào ngân
    // sách đã được setup" — feedback mục 4). Target % doanh thu quy ra tiền theo target
    // doanh thu của chính kỳ đó.
    prisma.reportTarget.findMany({
      where: { period: { startsWith: `${year}-` }, deletedAt: null, ...branchFilter },
    }),
  ]);
  const departmentName = new Map(departments.map((item) => [item.code, item.name]));
  const deptLabel = (code: string) => (code === UNASSIGNED_DEPARTMENT ? "Chưa gán bộ phận" : departmentName.get(code) || code);
  // Cây dòng KQKD -> nhóm -> hạng mục với 12 cột tháng, đi qua cùng builder với bảng một kỳ
  // nên lương lên dòng nhân sự, nhóm OPEX và hạng mục xếp cùng một thứ tự.
  const tree = createPnlDetailTree({ pnlItems, pnlGroups, categories }, 12);

  const totals = months.map(() => emptyBucket());
  /** Thực tế từng cửa hàng × 12 tháng — cho bảng "hiệu quả theo cửa hàng" và so hòa vốn theo cửa hàng. */
  const branchTotals = new Map<string, PnlBucket[]>();
  const revenueByDepartment = new Map<string, MatrixSeries>();
  const payrollByDepartment = new Map<string, MatrixSeries>();
  const cogsByDepartment = new Map<string, MatrixSeries>();

  for (const row of rows) {
    const monthIndex = months.indexOf(row.period);
    if (monthIndex < 0) continue;
    const expense = row.debit - row.credit;
    const income = row.credit - row.debit;
    const lineKey = tree.add({ account: row, pnlItemCode: row.pnlItemCode, categoryCode: row.categoryCode, debit: row.debit, credit: row.credit }, monthIndex);
    if (!lineKey) continue;
    const signed = lineKey === "revenue" || lineKey === "otherIncome" ? income : expense;
    totals[monthIndex][lineKey] += signed;
    const branchBuckets = branchTotals.get(row.branchCode) || months.map(() => emptyBucket());
    branchBuckets[monthIndex][lineKey] += signed;
    branchTotals.set(row.branchCode, branchBuckets);
    const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
    if (lineKey === "revenue") bumpSeries(revenueByDepartment, dept, deptLabel(dept), monthIndex, income);
    if (lineKey === "payroll") bumpSeries(payrollByDepartment, dept, deptLabel(dept), monthIndex, expense);
    if (lineKey === "cogs") bumpSeries(cogsByDepartment, dept, deptLabel(dept), monthIndex, expense);
  }

  // Tách doanh thu thu được thành: phần thuần theo bộ phận / theo kênh bán, cộng SVC và thuế
  // GTGT đứng riêng — ba nhóm này cộng lại đúng bằng tổng tiền khách trả (netAmount).
  const netRevenueByDepartment = new Map<string, MatrixSeries>();
  const netRevenueByChannel = new Map<string, MatrixSeries>();
  const svcMonths = Array.from({ length: 12 }, () => 0);
  const vatMonths = Array.from({ length: 12 }, () => 0);
  for (const row of revenueRows) {
    const date = new Date(row.saleDate);
    if (date.getFullYear() !== Number(year)) continue;
    const monthIndex = date.getMonth();
    const net = row.grossAmount - row.discountAmount;
    const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
    bumpSeries(netRevenueByDepartment, dept, dept === UNASSIGNED_DEPARTMENT ? "Chưa gán bộ phận" : `DT ${departmentName.get(dept) || dept}`, monthIndex, net);
    const channel = (row.channel || "").trim() || "Chưa rõ kênh";
    bumpSeries(netRevenueByChannel, channel.toUpperCase(), `DT ${channel}`, monthIndex, net);
    svcMonths[monthIndex] += row.feeAmount;
    vatMonths[monthIndex] += row.vatAmount;
  }
  const payrollBonusMonths = Array.from({ length: 12 }, () => 0);
  const payrollInsuranceMonths = Array.from({ length: 12 }, () => 0);
  for (const row of payrollRows) {
    const monthIndex = months.indexOf(row.period);
    if (monthIndex < 0) continue;
    payrollBonusMonths[monthIndex] += row.bonusAmount;
    payrollInsuranceMonths[monthIndex] += row.insuranceAmount;
  }

  // Kế hoạch (ngân sách) từng tháng, quy về tiền: target % doanh thu nhân với target doanh
  // thu của cùng kỳ + cùng cửa hàng (chưa set target doanh thu thì phần % chưa quy được — để 0).
  // Hạng mục P&L set riêng (metric "pnlItem:<code>") cộng lên dòng chứa nó; dòng OPEX ưu tiên
  // tổng các hạng mục, chỉ dùng target set thẳng vào dòng khi chưa có hạng mục nào (dữ liệu cũ).
  const revenueTargetByPeriodBranch = new Map<string, number>();
  for (const target of targets) {
    if (target.metric === "revenue") revenueTargetByPeriodBranch.set(`${target.period}|${target.branchCode}`, target.targetValue);
  }
  const resolveTargetAmount = (target: { period: string; branchCode: string; targetMode: string; targetPercent: number | null; targetValue: number }) =>
    target.targetMode === "PERCENT_REVENUE" && target.targetPercent
      ? (revenueTargetByPeriodBranch.get(`${target.period}|${target.branchCode}`) || 0) * target.targetPercent
      : target.targetValue;
  const zeros12 = () => Array.from({ length: 12 }, () => 0);
  /** Target hạng mục theo "<phạm vi>|<mã hạng mục>" — gộp lại sau theo cùng luật ALL-trước. */
  const planItemByScope = new Map<string, number[]>();
  const itemLineByCode = new Map<string, PnlLineKey>();
  for (const line of PNL_STATEMENT_LINES) {
    if (line.subtotal) continue;
    for (const group of tree.groupsOf(line.key as PnlLineKey)) for (const item of group.items) itemLineByCode.set(item.code, line.key as PnlLineKey);
  }
  type PlanBucket = Record<PnlLineKey, number[]>;
  const emptyPlanBucket = (): PlanBucket => ({ revenue: zeros12(), cogs: zeros12(), payroll: zeros12(), depreciation: zeros12(), otherOpex: zeros12(), otherIncome: zeros12(), otherExpense: zeros12() });
  /** Target set thẳng vào dòng, theo cửa hàng. */
  const linePlanByBranch = new Map<string, PlanBucket>();
  /** Tổng target hạng mục theo dòng, theo cửa hàng. */
  const itemPlanByBranch = new Map<string, PlanBucket>();
  const touchPlan = (map: Map<string, PlanBucket>, branch: string) => {
    const current = map.get(branch) || emptyPlanBucket();
    map.set(branch, current);
    return current;
  };
  let hasPlan = false;
  for (const target of targets) {
    const monthIndex = months.indexOf(target.period);
    if (monthIndex < 0) continue;
    const amount = resolveTargetAmount(target);
    if (target.metric.startsWith("pnlItem:")) {
      const code = target.metric.slice("pnlItem:".length);
      const lineKey = itemLineByCode.get(code);
      if (!lineKey) continue;
      const scopeKey = `${target.branchCode}|${code}`;
      const series = planItemByScope.get(scopeKey) || zeros12();
      series[monthIndex] += amount;
      planItemByScope.set(scopeKey, series);
      touchPlan(itemPlanByBranch, target.branchCode)[lineKey][monthIndex] += amount;
      hasPlan = true;
      continue;
    }
    const lineKey = target.metric as PnlLineKey;
    if (!(lineKey in emptyBucket())) continue;
    touchPlan(linePlanByBranch, target.branchCode)[lineKey][monthIndex] += amount;
    hasPlan = true;
  }
  /**
   * Kế hoạch của một phạm vi (cửa hàng hoặc "ALL"): dòng OPEX ưu tiên tổng hạng mục, dòng khác
   * lấy target set thẳng. Trả về 7 dòng gốc chưa suy ra để còn gộp nhiều phạm vi.
   */
  const rawPlan = (branch: string): PlanBucket => {
    const lines = linePlanByBranch.get(branch) || emptyPlanBucket();
    const items = itemPlanByBranch.get(branch) || emptyPlanBucket();
    const result = emptyPlanBucket();
    for (const key of Object.keys(result) as PnlLineKey[]) {
      result[key] = months.map((_, monthIndex) => (key === "otherOpex" && items.otherOpex.some((value) => value > 0) ? items.otherOpex[monthIndex] : lines[key][monthIndex]));
    }
    return result;
  };
  const finalizeRaw = (raw: PlanBucket) => months.map((_, monthIndex) => finalizePnl({
    revenue: raw.revenue[monthIndex], cogs: raw.cogs[monthIndex], payroll: raw.payroll[monthIndex], depreciation: raw.depreciation[monthIndex],
    otherOpex: raw.otherOpex[monthIndex], otherIncome: raw.otherIncome[monthIndex], otherExpense: raw.otherExpense[monthIndex],
  }));
  // Ngân sách có thể set ở cấp "ALL" (toàn hệ thống) lẫn từng cửa hàng (tab Ngân sách xem theo
  // phạm vi nào thì set ở phạm vi đó). Xem toàn hệ thống: tháng nào có số ở cấp ALL thì lấy số
  // đó, không thì cộng các cửa hàng — tránh cộng trùng hai cấp.
  const realBranches = Array.from(new Set<string>([...linePlanByBranch.keys(), ...itemPlanByBranch.keys()])).filter((code) => code !== "ALL");
  const planByBranch = new Map<string, ReturnType<typeof finalizeRaw>>();
  for (const branch of realBranches) planByBranch.set(branch, finalizeRaw(rawPlan(branch)));
  const allLevel = rawPlan("ALL");
  const branchRaws = realBranches.map((branch) => rawPlan(branch));
  const mergedRaw = emptyPlanBucket();
  for (const key of Object.keys(mergedRaw) as PnlLineKey[]) {
    mergedRaw[key] = months.map((_, monthIndex) => (allLevel[key][monthIndex] > 0 ? allLevel[key][monthIndex] : branchRaws.reduce((sum, raw) => sum + raw[key][monthIndex], 0)));
  }
  const plans = finalizeRaw(mergedRaw);
  const planBranches = new Set<string>(realBranches);
  const planLine = (key: string) => plans.map((bucket) => (bucket as unknown as Record<string, number>)[key] || 0);
  // Đường ngân sách trên chart COGS/LƯƠNG (giữ nguyên hợp đồng cũ).
  const budgets = { revenue: planLine("revenue"), cogs: planLine("cogs"), payroll: planLine("payroll") };

  const planItemByCode = new Map<string, number[]>();
  for (const [scopeKey, series] of planItemByScope) {
    const [scope, code] = scopeKey.split("|");
    const merged = planItemByCode.get(code) || zeros12();
    const allSeries = planItemByScope.get(`ALL|${code}`);
    for (let monthIndex = 0; monthIndex < 12; monthIndex += 1) {
      if (allSeries && allSeries[monthIndex] > 0) merged[monthIndex] = allSeries[monthIndex];
      else if (scope !== "ALL") merged[monthIndex] += series[monthIndex];
    }
    planItemByCode.set(code, merged);
  }

  /** Kế hoạch đính kèm từng nhóm/hạng mục: dòng OPEX set theo hạng mục nên nhóm = tổng hạng mục; dòng khác chỉ có kế hoạch ở cấp dòng. */
  const withPlan = (lineKey: PnlLineKey, groups: PnlSeriesGroup[]) => groups.map((group) => {
    const items = group.items.map((item) => {
      const plan = planItemByCode.get(item.code) || null;
      return { ...item, plan, planTotal: plan ? plan.reduce((sum, value) => sum + value, 0) : null };
    });
    const detailLine = lineKey === "otherOpex";
    const plan = detailLine ? months.map((_, monthIndex) => items.reduce((sum, item) => sum + (item.plan?.[monthIndex] || 0), 0)) : null;
    return { ...group, items, plan, planTotal: plan ? plan.reduce((sum, value) => sum + value, 0) : null };
  });

  // Thực tế + kế hoạch theo cửa hàng (xếp theo doanh thu thực tế giảm dần, cửa hàng chỉ có kế hoạch đứng sau).
  const branchCodes = new Set<string>([...branchTotals.keys(), ...planBranches]);
  const byBranch = Array.from(branchCodes, (code) => {
    const actual = (branchTotals.get(code) || months.map(() => emptyBucket())).map((bucket) => finalizePnl(bucket));
    const plan = planByBranch.get(code) || months.map(() => finalizePnl(emptyBucket()));
    return { code, actual, plan };
  }).sort((a, b) => b.actual.reduce((sum, bucket) => sum + bucket.revenue, 0) - a.actual.reduce((sum, bucket) => sum + bucket.revenue, 0));

  const finalizedTotals = totals.map((bucket) => finalizePnl(bucket));
  const statement: MatrixStatementLine[] = PNL_STATEMENT_LINES.map((line) => {
    const monthValues = finalizedTotals.map((total) => (total as unknown as Record<string, number>)[line.key] || 0);
    const plan = planLine(line.key);
    return {
      key: line.key,
      label: line.label,
      subtotal: line.subtotal,
      months: monthValues,
      total: monthValues.reduce((sum, value) => sum + value, 0),
      plan,
      planTotal: plan.reduce((sum, value) => sum + value, 0),
      groups: line.subtotal ? [] : withPlan(line.key as PnlLineKey, tree.groupsOf(line.key as PnlLineKey)),
    };
  });

  return {
    year,
    branchCode,
    months,
    totals: finalizedTotals,
    /** Cấu thành doanh thu cho pie tỷ trọng và các đường DT bếp/DT bar trên chart COGS. */
    revenueSplit: {
      byDepartment: sortedSeries(netRevenueByDepartment),
      byChannel: sortedSeries(netRevenueByChannel),
      svc: svcMonths,
      vat: vatMonths,
    },
    /** Cấu phần chi phí nhân sự cho chart LƯƠNG (SVC & KPI, bảo hiểm). */
    payrollSplit: { bonus: payrollBonusMonths, insurance: payrollInsuranceMonths },
    /** Ngân sách tháng đã quy đổi % — đường so sánh trên chart COGS/LƯƠNG. */
    budgets,
    /** Có set kế hoạch nào trong năm chưa — chưa có thì các màn Dự báo/Định mức nhắc set ở tab Ngân sách. */
    hasPlan,
    /** Kế hoạch 12 tháng đã cộng mọi cửa hàng, đủ các dòng suy ra (LN gộp, EBITDA, LN ròng). */
    plans,
    /** Thực tế + kế hoạch từng cửa hàng — bảng hiệu quả theo cửa hàng và hòa vốn theo cửa hàng. */
    byBranch,
    /** Bảng KQKD cả năm: 10 dòng -> nhóm -> hạng mục, mỗi tháng một cột. */
    statement,
    revenueByDepartment: sortedSeries(revenueByDepartment),
    payrollByDepartment: sortedSeries(payrollByDepartment),
    cogsByDepartment: sortedSeries(cogsByDepartment),
  };
}

/* ------------------------------------------------------------------------- *
 * Ngân sách nhân sự theo tỷ trọng bộ phận
 * ------------------------------------------------------------------------- */

export type DepartmentRatioRow = {
  branchCode: string;
  departmentCode: string;
  ratio: number;
  industryMin: number | null;
  industryMax: number | null;
  note: string | null;
};

/**
 * Lương chuẩn của một bộ phận = tỷ trọng bộ phận × TỔNG doanh thu (gồm SVC) của cửa hàng
 * trong tháng — đúng bảng "Tỷ trọng ngành F&B đối với các bộ phận" trong feedback: Bếp
 * 12.8% nghĩa là 12.8% doanh thu toàn nhà hàng, không phải 12.8% doanh thu món bếp.
 */
export async function getPayrollBudgetReport(year: string, branchCode: string) {
  const months = yearMonths(year);
  const start = new Date(`${year}-01-01T00:00:00`);
  const end = new Date(`${Number(year) + 1}-01-01T00:00:00`);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [departments, ratios, revenueRows, payrollRows] = await Promise.all([
    prisma.masterDataItem.findMany({ where: { type: "DEPARTMENT", status: "ACTIVE" }, select: { code: true, name: true }, orderBy: { code: "asc" } }),
    prisma.departmentCostRatio.findMany({ where: { year, metric: "payroll", ...branchFilter } }),
    prisma.revenueImportRow.findMany({
      where: { saleDate: { gte: start, lt: end }, ...branchFilter },
      select: { saleDate: true, branchCode: true, departmentCode: true, grossAmount: true, feeAmount: true },
    }),
    prisma.payrollImportRow.findMany({
      where: { period: { startsWith: `${year}-` }, ...branchFilter },
      select: { period: true, branchCode: true, departmentCode: true, employeeCode: true, baseSalary: true, allowanceAmount: true, bonusAmount: true, insuranceAmount: true, netAmount: true },
    }),
  ]);
  const departmentName = new Map(departments.map((item) => [item.code, item.name]));
  const deptLabel = (code: string) => (code === UNASSIGNED_DEPARTMENT ? "Chưa gán bộ phận" : departmentName.get(code) || code);

  // Doanh thu theo tháng: tổng từng cửa hàng (nền tính lương chuẩn) + cắt theo bộ phận (dòng tham chiếu).
  const revenueTotalByBranch = new Map<string, number[]>();
  const svcTotalByBranch = new Map<string, number[]>();
  const revenueByDepartment = new Map<string, MatrixSeries>();
  const svcByDepartment = new Map<string, MatrixSeries>();
  const monthArray = () => Array.from({ length: 12 }, () => 0);
  for (const row of revenueRows) {
    const date = new Date(row.saleDate);
    if (date.getFullYear() !== Number(year)) continue;
    const monthIndex = date.getMonth();
    const gross = revenueTotalByBranch.get(row.branchCode) || monthArray();
    gross[monthIndex] += row.grossAmount;
    revenueTotalByBranch.set(row.branchCode, gross);
    const svc = svcTotalByBranch.get(row.branchCode) || monthArray();
    svc[monthIndex] += row.feeAmount;
    svcTotalByBranch.set(row.branchCode, svc);
    const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
    bumpSeries(revenueByDepartment, dept, deptLabel(dept), monthIndex, row.grossAmount);
    bumpSeries(svcByDepartment, dept, deptLabel(dept), monthIndex, row.feeAmount);
  }
  const revenueTotal = monthArray();
  const svcTotal = monthArray();
  for (const values of revenueTotalByBranch.values()) values.forEach((value, index) => { revenueTotal[index] += value; });
  for (const values of svcTotalByBranch.values()) values.forEach((value, index) => { svcTotal[index] += value; });

  // Lương chuẩn: cộng theo từng cửa hàng vì mỗi cửa hàng có bộ tỷ trọng riêng.
  const standardByDepartment = new Map<string, MatrixSeries>();
  for (const ratio of ratios) {
    if (!ratio.ratio) continue;
    const gross = revenueTotalByBranch.get(ratio.branchCode);
    const svc = svcTotalByBranch.get(ratio.branchCode);
    if (!gross && !svc) continue;
    for (let index = 0; index < 12; index += 1) {
      const base = (gross?.[index] || 0) + (svc?.[index] || 0);
      if (base) bumpSeries(standardByDepartment, ratio.departmentCode, deptLabel(ratio.departmentCode), index, base * ratio.ratio);
    }
  }

  // Lương thực chi + đầu người từ import bảng lương (gross khớp bút toán 6421: lương + phụ cấp + thưởng).
  const actualByDepartment = new Map<string, MatrixSeries>();
  const insuranceTotal = monthArray();
  const headcountSets = new Map<string, Set<string>>();
  const totalHeadcountSets = months.map(() => new Set<string>());
  for (const row of payrollRows) {
    const monthIndex = months.indexOf(row.period);
    if (monthIndex < 0) continue;
    const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
    const gross = row.baseSalary + row.allowanceAmount + row.bonusAmount;
    bumpSeries(actualByDepartment, dept, deptLabel(dept), monthIndex, gross);
    insuranceTotal[monthIndex] += row.insuranceAmount;
    const key = `${dept}|${monthIndex}`;
    const set = headcountSets.get(key) || new Set<string>();
    set.add(row.employeeCode);
    headcountSets.set(key, set);
    totalHeadcountSets[monthIndex].add(row.employeeCode);
  }
  const headcountByDepartment: MatrixSeries[] = [];
  const headcountDeptCodes = [...new Set([...headcountSets.keys()].map((key) => key.split("|")[0]))];
  for (const dept of headcountDeptCodes) {
    const series = { code: dept, name: deptLabel(dept), months: monthArray(), total: 0 };
    for (let index = 0; index < 12; index += 1) {
      const count = headcountSets.get(`${dept}|${index}`)?.size || 0;
      series.months[index] = count;
      series.total += count;
    }
    headcountByDepartment.push(series);
  }
  headcountByDepartment.sort((a, b) => b.total - a.total);

  return {
    year,
    branchCode,
    months,
    departments,
    ratios: ratios.map((row): DepartmentRatioRow => ({
      branchCode: row.branchCode,
      departmentCode: row.departmentCode,
      ratio: row.ratio,
      industryMin: row.industryMin,
      industryMax: row.industryMax,
      note: row.note,
    })),
    revenue: {
      totalGross: revenueTotal,
      totalSvc: svcTotal,
      byDepartment: sortedSeries(revenueByDepartment),
      svcByDepartment: sortedSeries(svcByDepartment),
    },
    standard: {
      byDepartment: sortedSeries(standardByDepartment),
      total: months.map((_, index) => [...standardByDepartment.values()].reduce((sum, row) => sum + row.months[index], 0)),
    },
    actual: {
      byDepartment: sortedSeries(actualByDepartment),
      total: months.map((_, index) => [...actualByDepartment.values()].reduce((sum, row) => sum + row.months[index], 0)),
      insurance: insuranceTotal,
    },
    headcount: {
      byDepartment: headcountByDepartment,
      total: totalHeadcountSets.map((set) => set.size),
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Doanh thu kế hoạch vs thực hiện + cùng kỳ nhiều năm
 * ------------------------------------------------------------------------- */

export async function getRevenueTrendReport(period: string, branchCode: string, years = 3) {
  const currentYear = Number(period.slice(0, 4));
  const firstYear = currentYear - Math.max(1, years) + 1;
  const [rows, targets] = await Promise.all([
    loadYearJournalLines(`${firstYear}-01`, `${currentYear}-12`, branchCode),
    prisma.reportTarget.findMany({ where: { metric: "revenue", period: { startsWith: `${currentYear}-` }, ...(branchCode === "ALL" ? {} : { branchCode }) } }),
  ]);
  const series = new Map<number, number[]>();
  for (let yearValue = firstYear; yearValue <= currentYear; yearValue += 1) series.set(yearValue, Array.from({ length: 12 }, () => 0));
  for (const row of rows) {
    if (row.accountType !== "REVENUE") continue;
    const yearValue = Number(row.period.slice(0, 4));
    const monthIndex = Number(row.period.slice(5, 7)) - 1;
    const values = series.get(yearValue);
    if (values && monthIndex >= 0) values[monthIndex] += row.credit - row.debit;
  }
  const plan = Array.from({ length: 12 }, () => 0);
  for (const target of targets) {
    const monthIndex = Number(target.period.slice(5, 7)) - 1;
    if (monthIndex >= 0) plan[monthIndex] += target.targetValue;
  }
  return {
    period,
    branchCode,
    year: String(currentYear),
    plan,
    series: [...series.entries()]
      .map(([yearValue, values]) => ({ year: String(yearValue), months: values, total: values.reduce((sum, value) => sum + value, 0) }))
      .sort((a, b) => Number(a.year) - Number(b.year)),
  };
}
