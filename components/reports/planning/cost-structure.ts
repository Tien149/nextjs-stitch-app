import { opexGroupRank } from "@/lib/pnl-ordering";
import type { PlanningData, PnlBucket } from "@/components/reports/planning/planning-types";

/**
 * Cơ cấu chi phí dùng chung cho Điểm hòa vốn và Giả định tài chính (khách chốt 04/10/2026):
 *
 *   Định phí (FC) = CAPEX + Chi phí cố định (nhóm OPEX cố định, gồm khấu hao) + Chi phí nhân sự
 *   Biến phí (VC) = Giá vốn + Chi phí biến đổi (nhóm OPEX biến đổi) + Chi phí Marketing
 *   Doanh thu hòa vốn = FC ÷ (1 − VC ÷ Doanh thu)
 *
 * OPEX chia ba theo TÊN nhóm hạng mục P&L (cùng luật sắp xếp bảng P&L — lib/pnl-ordering):
 * "...cố định" / "...marketing, quảng cáo" / "...biến đổi". Nhóm tên khác và phần OPEX chưa gắn
 * nhóm tính vào chi phí cố định. Trước 04/10/2026 Marketing nằm trong định phí và CAPEX không
 * có mặt trong hòa vốn.
 */
export type OpexKind = "fixed" | "marketing" | "variable";

export function opexKindOf(groupName: string | null | undefined): OpexKind {
  const rank = opexGroupRank(groupName);
  return rank === 1 ? "marketing" : rank === 2 ? "variable" : "fixed";
}

export type OpexSplit = {
  /** OPEX cố định theo tháng = tổng OPEX − marketing − biến đổi (gồm nhóm khác & chưa gắn nhóm). */
  fixed: number[];
  marketing: number[];
  variable: number[];
  groups: Array<{ name: string; kind: OpexKind; months: number[] }>;
};

/** Tách OPEX từng tháng của `buckets` (thực tế hoặc kế hoạch) theo nhóm hạng mục trên bảng P&L. */
export function splitOpex(data: PlanningData, buckets: PnlBucket[], usePlan: boolean): OpexSplit {
  const line = data.statement.find((item) => item.key === "otherOpex");
  const size = buckets.length;
  const marketing = Array<number>(size).fill(0);
  const variable = Array<number>(size).fill(0);
  const groups: OpexSplit["groups"] = [];
  for (const group of line?.groups || []) {
    const months = Array.from({ length: size }, (_, index) => (usePlan ? group.plan?.[index] : group.months[index]) || 0);
    const kind = opexKindOf(group.name);
    groups.push({ name: group.name, kind, months });
    if (kind === "marketing") months.forEach((value, index) => { marketing[index] += value; });
    if (kind === "variable") months.forEach((value, index) => { variable[index] += value; });
  }
  const fixed = buckets.map((bucket, index) => bucket.otherOpex - marketing[index] - variable[index]);
  return { fixed, marketing, variable, groups };
}

export type CostTotals = {
  revenue: number;
  cogs: number;
  payroll: number;
  capex: number;
  opexFixed: number;
  opexMarketing: number;
  opexVariable: number;
};

export function breakEvenOf(totals: CostTotals) {
  const fixed = totals.capex + totals.opexFixed + totals.payroll;
  const variable = totals.cogs + totals.opexVariable + totals.opexMarketing;
  const variableRatio = totals.revenue > 0 ? variable / totals.revenue : 0;
  const cmRatio = 1 - variableRatio;
  return { revenue: totals.revenue, fixed, variable, variableRatio, cmRatio, bep: cmRatio > 0 ? fixed / cmRatio : null };
}

const sum = (values: number[]) => values.reduce((total, value) => total + (Number(value) || 0), 0);

export function costTotalsOf(buckets: PnlBucket[], split: OpexSplit): CostTotals {
  return {
    revenue: sum(buckets.map((bucket) => bucket.revenue)),
    cogs: sum(buckets.map((bucket) => bucket.cogs)),
    payroll: sum(buckets.map((bucket) => bucket.payroll)),
    capex: sum(buckets.map((bucket) => bucket.capex)),
    opexFixed: sum(split.fixed),
    opexMarketing: sum(split.marketing),
    opexVariable: sum(split.variable),
  };
}
