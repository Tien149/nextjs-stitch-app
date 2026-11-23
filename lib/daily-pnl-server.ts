import { prisma } from "@/lib/prisma";
import { getPnl } from "@/lib/reports";
import { opexGroupRank } from "@/lib/pnl-ordering";
import { vietnamBusinessDayKey } from "@/lib/revenue-date";

/**
 * Báo cáo theo từng ngày của tháng (khách 23/11/2026): mỗi ngày một dòng gồm Doanh thu, COGS,
 * Chi phí lương NLĐ, CAPEX, Chi phí cố định, Chi phí biến đổi và Số lượng nhân sự.
 *
 * - Doanh thu: Sổ doanh thu, cột Tổng tiền (đã gồm SVC + thuế) — cùng số Doanh thu P&L.
 * - COGS: phiếu Xuất bán (XUAT_BAN) do Rã BOM sinh ra, theo ngày của phiếu. Ngày chưa rã thì 0.
 * - Lương NLĐ, CAPEX, CP cố định, CP biến đổi: số CẢ THÁNG trên P&L (getPnl) chia đều số ngày
 *   của tháng. Cố định / biến đổi chia theo tên nhóm hạng mục OPEX giống Điểm hòa vốn
 *   (components/reports/planning/cost-structure): nhóm "...biến đổi" và nhóm Marketing vào biến
 *   đổi, phần còn lại (gồm khấu hao, nhóm khác, chưa gắn nhóm) vào cố định.
 * - Số lượng nhân sự: cột Số nhân sự của bảng lương theo bộ phận đã import cho tháng đó.
 */

export type DailyPnlRow = {
  date: string;
  revenue: number;
  cogs: number;
  payroll: number;
  capex: number;
  fixedCost: number;
  variableCost: number;
  headcount: number;
};

export type DailyPnlData = {
  period: string;
  branchCode: string;
  days: number;
  rows: DailyPnlRow[];
  /** Số cả tháng đem chia — hiện ở chú thích để đối chiếu với P&L. */
  month: { payroll: number; capex: number; fixedCost: number; variableCost: number; marketing: number; headcount: number; pnlCogs: number };
};

const HOUR = 60 * 60 * 1000;

export async function getDailyPnl(period: string, branchCode: string): Promise<DailyPnlData> {
  const [year, month] = period.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Ngày lưu có thể là nửa đêm UTC (file mới) hoặc nửa đêm giờ VN (file cũ): lùi 7 tiếng để
  // gồm cả hai kiểu rồi quy về ngày nghiệp vụ VN bằng vietnamBusinessDayKey.
  const start = new Date(Date.UTC(year, month - 1, 1) - 7 * HOUR);
  const end = new Date(Date.UTC(year, month, 1) - 7 * HOUR);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };

  const [pnl, revenueGroups, sales, payrollRows] = await Promise.all([
    getPnl(period, branchCode),
    prisma.revenueImportRow.groupBy({
      by: ["saleDate"],
      where: { saleDate: { gte: start, lt: end }, deletedAt: null, ...branchWhere },
      _sum: { netAmount: true },
    }),
    prisma.inventoryTransactionLine.findMany({
      where: {
        transaction: {
          transactionType: "XUAT_BAN",
          status: "POSTED",
          deletedAt: null,
          transactionDate: { gte: start, lt: end },
          ...branchWhere,
        },
      },
      select: { totalCost: true, transaction: { select: { transactionDate: true } } },
    }),
    prisma.payrollDepartmentRow.findMany({ where: { period, ...branchWhere }, select: { headcount: true } }),
  ]);

  const revenueByDay = new Map<string, number>();
  for (const group of revenueGroups) {
    const key = vietnamBusinessDayKey(group.saleDate);
    revenueByDay.set(key, (revenueByDay.get(key) || 0) + (group._sum.netAmount || 0));
  }
  const cogsByDay = new Map<string, number>();
  for (const line of sales) {
    const key = vietnamBusinessDayKey(line.transaction.transactionDate);
    cogsByDay.set(key, (cogsByDay.get(key) || 0) + (line.totalCost || 0));
  }

  const total = pnl.total as unknown as Record<string, number>;
  const opexLine = pnl.statement.find((line) => line.key === "otherOpex");
  let variable = 0;
  let marketing = 0;
  for (const group of opexLine?.groups || []) {
    const rank = opexGroupRank(group.name);
    if (rank === 1) marketing += group.amount;
    if (rank === 2) variable += group.amount;
  }
  const otherOpex = total.otherOpex || 0;
  const monthTotals = {
    payroll: total.payroll || 0,
    capex: total.capex || 0,
    fixedCost: otherOpex - variable - marketing,
    variableCost: variable + marketing,
    marketing,
    headcount: Math.round(payrollRows.reduce((sum, row) => sum + (row.headcount || 0), 0) * 100) / 100,
    pnlCogs: total.cogs || 0,
  };

  const rows: DailyPnlRow[] = Array.from({ length: days }, (_, index) => {
    const date = `${period}-${String(index + 1).padStart(2, "0")}`;
    return {
      date,
      revenue: revenueByDay.get(date) || 0,
      cogs: cogsByDay.get(date) || 0,
      payroll: monthTotals.payroll / days,
      capex: monthTotals.capex / days,
      fixedCost: monthTotals.fixedCost / days,
      variableCost: monthTotals.variableCost / days,
      headcount: monthTotals.headcount,
    };
  });
  return { period, branchCode, days, rows, month: monthTotals };
}
