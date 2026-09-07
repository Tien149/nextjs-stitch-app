/**
 * Kiểu dữ liệu phía client của báo cáo type=pnl-matrix (lib/report-budget.ts getPnlMatrix) —
 * dùng chung cho cụm màn "Hoạch định tài chính" (Dự báo P&L, Dashboard P&L, Định mức, Điểm hòa
 * vốn, Giả định tài chính). Giữ đúng tên trường với server để không phải map lại.
 */

export type PnlBucket = {
  revenue: number;
  cogs: number;
  payroll: number;
  /** OPEX đã gồm cả khấu hao (khấu hao là hạng mục trong Chi phí cố định, không còn dòng riêng). */
  otherOpex: number;
  otherIncome: number;
  otherExpense: number;
  /** Tiền mua tài sản/CCDC trong tháng — dòng thông tin, KHÔNG trừ vào EBITDA hay lợi nhuận ròng. */
  capex: number;
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
  /** Kỳ "YYYY-MM" đã import doanh thu nhưng chưa "Đồng bộ ghi sổ" ở màn Kế toán -> P&L còn trống. */
  unpostedMonths?: string[];
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
export const EXPENSE_LINE_KEYS = ["cogs", "payroll", "otherOpex"] as const;
export type ExpenseLineKey = (typeof EXPENSE_LINE_KEYS)[number];

export const LINE_SHORT_LABEL: Record<string, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn hàng bán",
  grossProfit: "Lợi nhuận gộp",
  payroll: "Chi phí nhân sự",
  otherOpex: "Chi phí hoạt động (OPEX)",
  ebitda: "Lợi nhuận hoạt động",
  otherIncome: "Thu nhập khác",
  otherExpense: "Chi phí khác",
  capex: "Chi phí đầu tư tài sản/CCDC (CAPEX)",
  netProfit: "Lợi nhuận ròng",
};

/** Chi phí hoạt động = nhân sự + OPEX (OPEX đã gồm khấu hao) — mọi thứ giữa LN gộp và LN hoạt động. */
export const operatingCostOf = (bucket: PnlBucket) => bucket.payroll + bucket.otherOpex;

/**
 * Các tháng (0-based) đang được tick trên chip "Lũy kế tháng". Trước đây chỉ có một số `upTo`
 * nên bấm T8 luôn kéo theo T1..T8; khách muốn tick tự do từng tháng (feedback 06/09/2026),
 * ví dụ chỉ xem riêng T8 hoặc T3 + T7 + T9. Mảng rỗng nghĩa là chưa chọn tháng nào.
 */
export type MonthPick = number[];

export const sumMonths = (values: number[], picked: MonthPick) => picked.reduce((total, index) => total + (values[index] || 0), 0);
export const sumAll = (values: number[]) => values.reduce((total, value) => total + value, 0);
export const cumulative = (values: number[]) => values.reduce<number[]>((acc, value) => [...acc, (acc[acc.length - 1] || 0) + value], []);

/** Tháng lớn nhất đang tick — mốc "đã biết số thực tế" của các bảng/chart lũy kế. */
export const lastPicked = (picked: MonthPick) => (picked.length === 0 ? -1 : Math.max(...picked));

/** Nhãn gọn của vùng tháng đang tick: "T8", "T1–T8" khi liền mạch, "T2, T5, T9" khi rời rạc. */
export function monthPickLabel(picked: MonthPick) {
  const sorted = [...picked].sort((a, b) => a - b);
  if (sorted.length === 0) return "chưa chọn tháng";
  if (sorted.length === 1) return `T${sorted[0] + 1}`;
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
  if (contiguous) return `T${sorted[0] + 1}–T${sorted[sorted.length - 1] + 1}`;
  return sorted.map((index) => `T${index + 1}`).join(", ");
}

/** "8 tháng (T1–T8)" — dùng cho subtitle của thẻ và bảng. */
export const monthPickSummary = (picked: MonthPick) => (picked.length === 0 ? "chưa chọn tháng" : `${picked.length} tháng (${monthPickLabel(picked)})`);

/** Cộng một trường của bucket trên đúng các tháng đang tick. */
export const bucketSum = (buckets: PnlBucket[], key: keyof PnlBucket, picked: MonthPick) => sumMonths(buckets.map((bucket) => bucket[key]), picked);
export const bucketOperatingCost = (buckets: PnlBucket[], picked: MonthPick) => sumMonths(buckets.map(operatingCostOf), picked);

/** Bản client của finalizePnl (lib/reports.ts) — dùng cho kịch bản giả định tính ngay trên trình duyệt. */
export function finalizeBucket(base: Pick<PnlBucket, "revenue" | "cogs" | "payroll" | "otherOpex" | "otherIncome" | "otherExpense" | "capex">): PnlBucket {
  const grossProfit = base.revenue - base.cogs;
  // Khấu hao đã nằm trong OPEX nên "ebitda" ở đây chính là lợi nhuận hoạt động; giữ tên trường
  // để không phải đổi hợp đồng API, nhãn hiển thị là "Lợi nhuận hoạt động".
  const opexBeforeDepreciation = base.payroll + base.otherOpex;
  const ebitda = grossProfit - opexBeforeDepreciation;
  const operatingProfit = ebitda;
  const netProfit = operatingProfit + base.otherIncome - base.otherExpense;
  return { ...base, grossProfit, opexBeforeDepreciation, ebitda, operatingProfit, netProfit, grossMargin: base.revenue ? grossProfit / base.revenue : 0, ebitdaMargin: base.revenue ? ebitda / base.revenue : 0 };
}

export const emptyBucket = (): PnlBucket => finalizeBucket({ revenue: 0, cogs: 0, payroll: 0, otherOpex: 0, otherIncome: 0, otherExpense: 0, capex: 0 });

/** Tổng của một nhóm/hạng mục trên các tháng đang tick, theo chế độ kế hoạch hay thực tế. */
export const nodeValue = (node: { months: number[]; plan: number[] | null }, picked: MonthPick, mode: "plan" | "actual") =>
  mode === "plan" ? (node.plan ? sumMonths(node.plan, picked) : 0) : sumMonths(node.months, picked);
