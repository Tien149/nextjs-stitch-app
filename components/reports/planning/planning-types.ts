/**
 * Kiểu dữ liệu phía client của báo cáo type=pnl-matrix (lib/report-budget.ts getPnlMatrix) —
 * dùng chung cho cụm màn "Hoạch định tài chính" (Dự báo P&L, Dashboard P&L, Định mức, Điểm hòa
 * vốn, Giả định tài chính). Giữ đúng tên trường với server để không phải map lại.
 */

export type PnlBucket = {
  revenue: number;
  cogs: number;
  payroll: number;
  depreciation: number;
  otherOpex: number;
  otherIncome: number;
  otherExpense: number;
  grossProfit: number;
  opexBeforeDepreciation: number;
  ebitda: number;
  operatingProfit: number;
  netProfit: number;
  grossMargin: number;
  ebitdaMargin: number;
};

export type Series = { code: string; name: string; months: number[]; total: number };
export type PlannedItem = Series & { plan: number[] | null; planTotal: number | null };
export type PlannedGroup = PlannedItem & { items: PlannedItem[] };
export type StatementLine = { key: string; label: string; subtotal: boolean; months: number[]; total: number; plan: number[]; planTotal: number; groups: PlannedGroup[] };
export type BranchPlanning = { code: string; actual: PnlBucket[]; plan: PnlBucket[] };

export type PlanningData = {
  year: string;
  branchCode: string;
  months: string[];
  totals: PnlBucket[];
  plans: PnlBucket[];
  hasPlan: boolean;
  byBranch: BranchPlanning[];
  revenueSplit: { byDepartment: Series[]; byChannel: Series[]; svc: number[]; vat: number[] };
  payrollSplit: { bonus: number[]; insurance: number[] };
  budgets: { revenue: number[]; cogs: number[]; payroll: number[] };
  statement: StatementLine[];
  revenueByDepartment: Series[];
  payrollByDepartment: Series[];
  cogsByDepartment: Series[];
};

/** Các dòng chi phí trên KQKD (không tính chi phí khác — không set kế hoạch được). */
export const EXPENSE_LINE_KEYS = ["cogs", "payroll", "otherOpex", "depreciation"] as const;
export type ExpenseLineKey = (typeof EXPENSE_LINE_KEYS)[number];

export const LINE_SHORT_LABEL: Record<string, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn hàng bán",
  grossProfit: "Lợi nhuận gộp",
  payroll: "Chi phí nhân sự",
  otherOpex: "Chi phí hoạt động khác (OPEX)",
  depreciation: "Khấu hao tài sản/CCDC",
  ebitda: "EBITDA",
  otherIncome: "Thu nhập khác",
  otherExpense: "Chi phí khác",
  netProfit: "Lợi nhuận ròng",
};

/** Chi phí hoạt động = nhân sự + OPEX khác + khấu hao (mọi thứ giữa LN gộp và LN hoạt động). */
export const operatingCostOf = (bucket: PnlBucket) => bucket.payroll + bucket.otherOpex + bucket.depreciation;

export const sumRange = (values: number[], upTo: number) => values.slice(0, upTo + 1).reduce((total, value) => total + value, 0);
export const sumAll = (values: number[]) => values.reduce((total, value) => total + value, 0);
export const cumulative = (values: number[]) => values.reduce<number[]>((acc, value) => [...acc, (acc[acc.length - 1] || 0) + value], []);

/** Cộng dồn một trường của bucket tới tháng `upTo` (0-based). */
export const bucketSum = (buckets: PnlBucket[], key: keyof PnlBucket, upTo: number) => sumRange(buckets.map((bucket) => bucket[key]), upTo);
export const bucketOperatingCost = (buckets: PnlBucket[], upTo: number) => sumRange(buckets.map(operatingCostOf), upTo);

/** Bản client của finalizePnl (lib/reports.ts) — dùng cho kịch bản giả định tính ngay trên trình duyệt. */
export function finalizeBucket(base: Pick<PnlBucket, "revenue" | "cogs" | "payroll" | "depreciation" | "otherOpex" | "otherIncome" | "otherExpense">): PnlBucket {
  const grossProfit = base.revenue - base.cogs;
  const opexBeforeDepreciation = base.payroll + base.otherOpex;
  const ebitda = grossProfit - opexBeforeDepreciation;
  const operatingProfit = ebitda - base.depreciation;
  const netProfit = operatingProfit + base.otherIncome - base.otherExpense;
  return { ...base, grossProfit, opexBeforeDepreciation, ebitda, operatingProfit, netProfit, grossMargin: base.revenue ? grossProfit / base.revenue : 0, ebitdaMargin: base.revenue ? ebitda / base.revenue : 0 };
}

export const emptyBucket = (): PnlBucket => finalizeBucket({ revenue: 0, cogs: 0, payroll: 0, depreciation: 0, otherOpex: 0, otherIncome: 0, otherExpense: 0 });

/** Tổng của một nhóm/hạng mục tới tháng upTo, theo chế độ kế hoạch hay thực tế. */
export const nodeValue = (node: { months: number[]; plan: number[] | null }, upTo: number, mode: "plan" | "actual") =>
  mode === "plan" ? (node.plan ? sumRange(node.plan, upTo) : 0) : sumRange(node.months, upTo);
