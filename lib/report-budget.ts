import { Prisma } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { finalizePnl, pnlLineKeyOf, type PnlBucket, type PnlItemRef } from "@/lib/reports";
import { comparePnlGroups, comparePnlItems } from "@/lib/pnl-ordering";

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
export type MatrixGroup = MatrixSeries & { items: MatrixSeries[] };

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

/** Hạng mục trong một nhóm chi: abc theo tên, dòng chưa phân loại xuống cuối (feedback 03/09/2026). */
function sortedSeriesByName(map: Map<string, MatrixSeries>) {
  return Array.from(map.values())
    .filter((row) => Math.abs(row.total) > 0.5)
    .sort((a, b) => comparePnlItems({ name: a.name, last: a.code === "UNCLASSIFIED" }, { name: b.name, last: b.code === "UNCLASSIFIED" }));
}

/** Tầng của nhóm chi trên bảng 12 tháng: giá vốn (0) -> OPEX (1) -> nhóm khác (2) -> nhóm gom tạm (3). */
function expenseGroupTier(code: string, kindByCode: Map<string, string>) {
  if (code === "TYPE:COGS") return 0;
  if (code.startsWith("TYPE:")) return 3;
  const kind = kindByCode.get(code);
  if (kind === "COGS") return 0;
  if (kind === "OPEX" || !kind) return 1;
  return 2;
}

type MatrixLineRow = {
  period: string;
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
    GROUP BY 1, 2, 3, 4, 5, 6
  `);
}

export async function getPnlMatrix(year: string, branchCode: string) {
  const months = yearMonths(year);
  const yearStart = new Date(`${year}-01-01T00:00:00`);
  const yearEnd = new Date(`${Number(year) + 1}-01-01T00:00:00`);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [rows, pnlItems, pnlGroups, categories, departments, revenueRows, payrollRows, targets] = await Promise.all([
    loadYearJournalLines(months[0], months[11], branchCode),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true, subGroup: true } }),
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
      where: { period: { startsWith: `${year}-` }, metric: { in: ["revenue", "cogs", "payroll"] }, ...branchFilter },
    }),
  ]);
  const pnlItemByCode = new Map(pnlItems.map((item) => [item.code, item]));
  const pnlGroupNameByCode = new Map(pnlGroups.map((item) => [item.code, item.name]));
  const pnlGroupKindByCode = new Map(pnlGroups.map((item) => [item.code, (item.group || "").toUpperCase()]));
  // Hạng mục lương/nhân sự khai dưới nhóm OPEX vẫn tính vào dòng Chi phí nhân sự (cùng luật với getPnl).
  const pnlItemRefOf = (pnlItemCode: string | null): PnlItemRef => {
    const item = pnlItemCode ? pnlItemByCode.get(pnlItemCode) : null;
    if (!item) return null;
    return { name: item.name, groupName: item.subGroup ? pnlGroupNameByCode.get(item.subGroup) || null : null };
  };
  const categoryName = new Map(categories.map((item) => [item.code, item.name]));
  const departmentName = new Map(departments.map((item) => [item.code, item.name]));
  const deptLabel = (code: string) => (code === UNASSIGNED_DEPARTMENT ? "Chưa gán bộ phận" : departmentName.get(code) || code);

  const totals = months.map(() => emptyBucket());
  const revenueByCategory = new Map<string, MatrixSeries>();
  const otherIncomeByCategory = new Map<string, MatrixSeries>();
  const revenueByDepartment = new Map<string, MatrixSeries>();
  const payrollByDepartment = new Map<string, MatrixSeries>();
  const cogsByDepartment = new Map<string, MatrixSeries>();
  // Hạng mục chi gom hai tầng: nhóm PNL_GROUP -> hạng mục PNL_ITEM.
  const expenseGroups = new Map<string, MatrixGroup & { itemMap: Map<string, MatrixSeries> }>();
  const expenseGroupOf = (accountType: string, pnlItemCode: string | null) => {
    const item = pnlItemCode ? pnlItemByCode.get(pnlItemCode) : null;
    if (item?.subGroup) return { code: item.subGroup, name: pnlGroupNameByCode.get(item.subGroup) || item.subGroup };
    if (accountType === "COGS") return { code: "TYPE:COGS", name: "Giá vốn hàng bán" };
    if (accountType === "OTHER_EXPENSE") return { code: "TYPE:OTHER", name: "Chi phí khác" };
    return { code: "TYPE:OPEX", name: "Chi phí vận hành" };
  };

  for (const row of rows) {
    const monthIndex = months.indexOf(row.period);
    if (monthIndex < 0) continue;
    const bucket = totals[monthIndex];
    const expense = row.debit - row.credit;
    const income = row.credit - row.debit;
    const lineKey = pnlLineKeyOf(row, pnlItemRefOf(row.pnlItemCode));
    if (lineKey === "revenue") bucket.revenue += income;
    else if (lineKey === "cogs") bucket.cogs += expense;
    else if (lineKey === "payroll") bucket.payroll += expense;
    else if (lineKey === "depreciation") bucket.depreciation += expense;
    else if (lineKey === "otherOpex") bucket.otherOpex += expense;
    else if (lineKey === "otherIncome") bucket.otherIncome += income;
    else if (lineKey === "otherExpense") bucket.otherExpense += expense;

    if (row.accountType === "REVENUE") {
      const code = row.categoryCode || "UNCLASSIFIED";
      bumpSeries(revenueByCategory, code, categoryName.get(code) || (row.categoryCode ? row.categoryCode : "Chưa phân loại nguồn"), monthIndex, income);
      const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
      bumpSeries(revenueByDepartment, dept, deptLabel(dept), monthIndex, income);
    } else if (row.accountType === "OTHER_INCOME") {
      const code = row.categoryCode || "UNCLASSIFIED";
      bumpSeries(otherIncomeByCategory, code, categoryName.get(code) || (row.categoryCode ? row.categoryCode : "Chưa phân loại nguồn"), monthIndex, income);
    } else {
      const itemCode = row.pnlItemCode || "UNCLASSIFIED";
      const item = row.pnlItemCode ? pnlItemByCode.get(row.pnlItemCode) : null;
      const groupInfo = expenseGroupOf(row.accountType, row.pnlItemCode);
      const group = expenseGroups.get(groupInfo.code) || {
        code: groupInfo.code,
        name: groupInfo.name,
        months: Array.from({ length: 12 }, () => 0),
        total: 0,
        items: [],
        itemMap: new Map<string, MatrixSeries>(),
      };
      group.months[monthIndex] += expense;
      group.total += expense;
      bumpSeries(group.itemMap, itemCode, item?.name || (row.pnlItemCode ? `Hạng mục P&L [${row.pnlItemCode}]` : "Chưa phân loại P&L"), monthIndex, expense);
      expenseGroups.set(groupInfo.code, group);
      if (lineKey === "payroll") {
        const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
        bumpSeries(payrollByDepartment, dept, deptLabel(dept), monthIndex, expense);
      }
      if (row.accountType === "COGS") {
        const dept = row.departmentCode || UNASSIGNED_DEPARTMENT;
        bumpSeries(cogsByDepartment, dept, deptLabel(dept), monthIndex, expense);
      }
    }
  }

  const incomeGroups: MatrixGroup[] = [];
  const revenueItems = sortedSeries(revenueByCategory);
  if (revenueItems.length > 0) {
    incomeGroups.push({
      code: "REVENUE",
      name: "Doanh thu bán hàng",
      months: months.map((_, index) => totals[index].revenue),
      total: totals.reduce((sum, bucket) => sum + bucket.revenue, 0),
      items: revenueItems,
    });
  }
  const otherIncomeItems = sortedSeries(otherIncomeByCategory);
  if (otherIncomeItems.length > 0) {
    incomeGroups.push({
      code: "OTHER_INCOME",
      name: "Thu nhập khác",
      months: months.map((_, index) => totals[index].otherIncome),
      total: totals.reduce((sum, bucket) => sum + bucket.otherIncome, 0),
      items: otherIncomeItems,
    });
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

  // Ngân sách tháng: cộng target các cửa hàng; target % doanh thu quy theo target doanh thu
  // của cùng kỳ + cùng cửa hàng (chưa set target doanh thu thì phần % chưa quy được — để 0).
  const budgets = { revenue: Array.from({ length: 12 }, () => 0), cogs: Array.from({ length: 12 }, () => 0), payroll: Array.from({ length: 12 }, () => 0) };
  const revenueTargetByPeriodBranch = new Map<string, number>();
  for (const target of targets) {
    if (target.metric === "revenue") {
      revenueTargetByPeriodBranch.set(`${target.period}|${target.branchCode}`, target.targetValue);
    }
  }
  for (const target of targets) {
    const monthIndex = months.indexOf(target.period);
    if (monthIndex < 0) continue;
    const bucket = budgets[target.metric as keyof typeof budgets];
    if (!bucket) continue;
    if (target.targetMode === "PERCENT_REVENUE" && target.targetPercent) {
      bucket[monthIndex] += (revenueTargetByPeriodBranch.get(`${target.period}|${target.branchCode}`) || 0) * target.targetPercent;
    } else {
      bucket[monthIndex] += target.targetValue;
    }
  }

  return {
    year,
    branchCode,
    months,
    totals: totals.map((bucket) => finalizePnl(bucket)),
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
    incomeGroups,
    // Nhóm chi: giá vốn trước, rồi OPEX theo cố định -> marketing -> biến đổi -> nhóm khác,
    // nhóm gom tạm (TYPE:*) và chi phí khác đứng cuối; hạng mục trong nhóm xếp abc.
    expenseGroups: Array.from(expenseGroups.values())
      .map(({ itemMap, ...group }) => ({ ...group, items: sortedSeriesByName(itemMap) }))
      .filter((group) => Math.abs(group.total) > 0.5)
      .sort((a, b) => expenseGroupTier(a.code, pnlGroupKindByCode) - expenseGroupTier(b.code, pnlGroupKindByCode) || comparePnlGroups(a, b)),
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
