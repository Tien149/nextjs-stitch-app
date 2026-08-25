"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput, MonthInput } from "@/components/DateInput";
import { storeLabel, visibleBranchScopeOptions, visibleStoreOptions } from "@/lib/branch-labels";
import { canCreateCashDeposit as canCreateCashDepositSlip, canPerformMenuAction, filterModuleTabs, moduleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import { filterCashierCashSources, filterMoneySources, moneySourceDebugLabel, moneySourceDisplayName, stripMoneySourceLabel, type MoneySourceOption } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";
import { shiftLabel, shiftLabels } from "@/lib/shifts";
import { cashDepositRoundingExpense, roundCashDepositAmount } from "@/lib/cash-deposit";

type Pnl = {
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

type PnlCut = Pnl & { code: string };
type PnlItemBreakdown = { code: string; name: string; group: string | null; amount: number };
type BalanceRow = { code: string; name: string; accountType: string; reportGroup: string; amount: number };
type BalanceData = { rows: BalanceRow[]; assets: number; liabilities: number; contributedEquity: number; retainedEarnings: number; equity: number; difference: number; balanced: boolean };
type DashboardData = { pnl: { total: Pnl; byBranch: PnlCut[] }; trend: Array<Pnl & { period: string }>; balance: BalanceData; targets: Array<{ metric: string; targetValue: number }> };
type PnlData = { total: Pnl; byBranch: PnlCut[]; byDepartment: PnlCut[]; byPnlItem: PnlItemBreakdown[] };
type YoyData = { previousPeriod: string; rows: Array<{ metric: string; currentValue: number; previousValue: number; variance: number; varianceRate: number | null }> };
type CashflowData = { scenario: string; startingCash: number; schedule: Array<{ period: string; inflow: number; outflow: number; closingCash: number; risk: boolean }> };
type OperationGroup = { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number };
type OperationDetail = { id: string; code: string; date: string; branchCode: string; departmentCode: string; departmentName: string; status: string; amount: number; owner: string; note: string; overdue?: boolean };
type OperationKey = "purchaseRequests" | "purchaseOrders" | "receipts" | "workItems" | "assets";
type OperationsData = {
  summary: {
    purchaseRequests: { count: number; amount: number };
    purchaseOrders: { count: number; amount: number };
    receipts: { count: number; amount: number };
    workItems: { count: number; overdue: number };
    assets: { count: number; amount: number };
  };
  groups: Record<OperationKey, OperationGroup[]>;
  details: Record<OperationKey, OperationDetail[]>;
};
type BudgetRow = { metric: string; label: string; kind: "REVENUE" | "EXPENSE" | "PROFIT"; actual: number; target: number; variance: number; usageRate: number | null; isGood: boolean };
type BudgetData = { summary: { expenseActual: number; expenseTarget: number; revenueActual: number; revenueTarget: number }; rows: BudgetRow[] };
type DailyCashBucket = { total: number; cash: number; transfer: number; card: number; grab: number; other: number };
type DailyCashExpense = { id: string; code: string; date: string; shift: string | null; description: string; partnerName: string; moneySourceCode: string; moneySourceName: string; moneySourceGroup: string | null; amount: number; isCash: boolean };
type DailyCashReceipt = DailyCashExpense & { status: string };
type ManualRevenueEntry = {
  id: string;
  shift: string;
  branchCode: string;
  cashAmount: number;
  transferAmount: number;
  cardAmount: number;
  grabAmount: number;
  otherAmount: number;
  totalAmount: number;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string;
};
type DailyCashData = {
  period: string;
  branchCode: string;
  reportDate: string;
  shift: string;
  summary: { revenue: DailyCashBucket; posRevenue: DailyCashBucket; manual: DailyCashBucket; receipt: DailyCashBucket; receiptRevenue: DailyCashBucket; deposit: DailyCashBucket; total: DailyCashBucket; expenseTotal: number; cashExpenseTotal: number; cashToDeposit: number };
  /** Tiền mặt cần nộp tách theo từng quỹ; mã rỗng là phần chưa xác định được nguồn. */
  cashToDepositSources: Array<{ code: string; name: string; amount: number }>;
  /** Quỹ tiền mặt không phải của thu ngân đã bị loại khỏi báo cáo, để màn hình nói rõ tiền nằm đâu. */
  excludedCashSources: Array<{ code: string; name: string; inflow: number; outflow: number }>;
  cashDeposits: Array<{ id: string; code: string; status: string; sourceShift: string | null; depositTargetType: string | null; fromMoneySourceCode: string; toMoneySourceCode: string; amount: number; feeAmount: number }>;
  expenses: DailyCashExpense[];
  receipts: DailyCashReceipt[];
  manualEntries: ManualRevenueEntry[];
  duplicateRevenueWarning: boolean;
  moneyInReconciliation: {
    rows: Array<{ key: string; label: string; declared: number; received: number; difference: number; status: "MATCHED" | "PENDING_CLEAR" | "SHORT" | "OVER"; note: string }>;
    needsFix?: Array<{ id: string; transactionCode: string; date: string; revenueDate: string | null; description: string; amount: number; reason: string }>;
    needsFixTotal?: number;
    walletFee: number;
    walletGrabExpense: number;
    walletCardFee: number;
    walletMissingGross?: number;
    bankRowCount: number;
    unclassifiedBankRows: number;
  };
};
type ManualRevenueForm = { cashAmount: string; transferAmount: string; cardAmount: string; grabAmount: string; otherAmount: string; note: string };
type CashCategoryRow = {
  key: string;
  name: string;
  group: string | null;
  total: number;
  count: number;
  months: number[];
  ratio: number;
};
type CashPartnerRow = { code: string; name: string; partnerType: string | null; total: number; count: number };
type CashSourceFlow = { code: string; name: string; group: string | null; branchCode: string; opening: number; in: number; out: number; transferIn: number; transferOut: number; closing: number; closingByMonth: number[]; expectedIn: number; expectedOut: number; expectedClosing: number };
type CashSourceData = {
  period: string;
  view: "month" | "year";
  year: string;
  months: string[];
  branchCode: string;
  totals: { in: number; out: number; net: number; netRatio: number; byMonth: Array<{ period: string; in: number; out: number; net: number }> };
  cashRemainingTarget: { byMonth: number[]; total: number };
  income: CashCategoryRow[];
  expense: CashCategoryRow[];
  expenseByPartner: CashPartnerRow[];
  expensePartnerCount: number;
  supplierExpense: { total: number; count: number };
  unclassified: { income: number; expense: number };
  pending: { receiptAmount: number; receiptCount: number; paymentAmount: number; paymentCount: number };
  internalTransfer: { total: number; count: number };
  sources: CashSourceFlow[];
  deposits: Array<{ code: string; name: string; opening: number; increase: number; used: number; closing: number }>;
};
type RevenueSettlementRow = {
  date: string;
  moneySourceCode: string;
  moneySourceName: string;
  group: string;
  revenue: number;
  received: number;
  remaining: number;
  feeCategoryCode: string | null;
  feeCategoryName: string | null;
  status: "MATCHED" | "FEE" | "WAITING" | "OVER";
};
type RevenueSettlementData = {
  period: string;
  branchCode: string;
  rows: RevenueSettlementRow[];
  totals: { revenue: number; received: number; remaining: number; waiting: number; fee: number; over: number };
};
type ActivityLog = { id: string; time: string; module: string; action: string; actor: string; branchCode: string; code: string; note: string };
type AccountingPeriodStatus = { period: string; branchCode: string; status: string; closedBy: string | null; closedAt: string | null; reopenedBy: string | null; reopenedAt: string | null; reason: string | null };
type ActivityData = { accountingPeriod: AccountingPeriodStatus; periods: AccountingPeriodStatus[]; logs: ActivityLog[] };
type ReportData = DashboardData | PnlData | YoyData | CashflowData | BalanceData | OperationsData | BudgetData | DailyCashData | ActivityData | CashSourceData | RevenueSettlementData;
type DrilldownRow = { id: string; date: string; code: string; accountCode: string; accountName: string; description: string; amount: number };
type CashDepositDenomination = { denomination: number; quantity: string };
type CashDepositForm = { depositTargetType: "PKT" | "CO"; fromMoneySourceCode: string; toMoneySourceCode: string; denominations: CashDepositDenomination[] };

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);
const metricLabels: Record<string, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn",
  grossProfit: "Lợi nhuận gộp",
  payroll: "Chi phí nhân sự",
  otherOpex: "OPEX khác",
  depreciation: "Khấu hao",
  opexBeforeDepreciation: "OPEX trước khấu hao",
  ebitda: "EBITDA",
  netProfit: "Lợi nhuận ròng",
};
const reportTabs = moduleTabs["/reports"];
const cashDepositTargetLabels: Record<"PKT" | "CO", string> = { PKT: "Nộp Tiền PKT", CO: "Nộp Tiền Cô" };
const cashDepositDenominations = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];
const emptyManualRevenueForm: ManualRevenueForm = { cashAmount: "", transferAmount: "", cardAmount: "", grabAmount: "", otherAmount: "", note: "" };
// Tiền mặt khoá lại (chỉ đọc): số này lấy từ phiếu thu tiền mặt của ca, không nhập tay.
const manualRevenueFields: Array<{ key: keyof Omit<ManualRevenueForm, "note">; label: string; hint: string; locked?: boolean }> = [
  { key: "cashAmount", label: "Tiền mặt", hint: "Lấy theo phiếu thu tiền mặt của ca, không nhập tay ở đây", locked: true },
  { key: "transferAmount", label: "Chuyển khoản", hint: "Khách chuyển vào tài khoản ngân hàng" },
  { key: "cardAmount", label: "Quẹt thẻ / Ví", hint: "Máy POS, ví điện tử, QR" },
  { key: "grabAmount", label: "Grab", hint: "Đơn qua GrabFood và các kênh Grab" },
  { key: "otherAmount", label: "Khác", hint: "Hình thức còn lại" },
];
const digitsOnly = (value: string) => value.replace(/\D/g, "");
const toAmountNumber = (value: string) => Number(digitsOnly(value) || "0");

export default function ReportsPage() {
  const href = "/reports";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("dashboard");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  /** Báo cáo thu chi ngày nạp kèm tab Tiền về đủ chưa, cho bảng "Đối chiếu tiền vào đã đủ chưa". */
  const [reconDailyCash, setReconDailyCash] = useState<DailyCashData | null>(null);
  const [shift, setShift] = useState("FULL");
  const [branchCode, setBranchCode] = useState("ALL");
  const [scenario, setScenario] = useState("BASE");
  const [cashSourceView, setCashSourceView] = useState<"month" | "year">("month");
  const [data, setData] = useState<ReportData | null>(null);
  const [tabLoading, setTabLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [moneySources, setMoneySources] = useState<MoneySourceOption[]>([]);
  const [cashDepositOpen, setCashDepositOpen] = useState(false);
  const [cashDepositSubmitting, setCashDepositSubmitting] = useState(false);
  const [cashDepositForm, setCashDepositForm] = useState<CashDepositForm>({
    depositTargetType: "PKT",
    fromMoneySourceCode: "",
    toMoneySourceCode: "",
    denominations: cashDepositDenominations.map((denomination) => ({ denomination, quantity: "" })),
  });
  const [manualRevenueOpen, setManualRevenueOpen] = useState(false);
  const [manualRevenueSubmitting, setManualRevenueSubmitting] = useState(false);
  const [manualRevenueForm, setManualRevenueForm] = useState<ManualRevenueForm>(emptyManualRevenueForm);
  const [forecast, setForecast] = useState({ period: new Date().toISOString().slice(0, 7), branchCode: "HCM", scenario: "BASE", assumptionType: "INFLOW", amount: "100000000", note: "Kế hoạch dòng tiền" });
  const [targetForm, setTargetForm] = useState({ metric: "otherOpex", targetValue: "50000000" });
  const [reopenReason, setReopenReason] = useState("Bổ sung hoặc điều chỉnh dữ liệu kỳ trước");

  const [expandedMetric, setExpandedMetric] = useState<string | null>(null);
  const [drilldownData, setDrilldownData] = useState<DrilldownRow[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const handleToggleExpand = async (metric: string) => {
    if (expandedMetric === metric) {
      setExpandedMetric(null);
      setDrilldownData([]);
      return;
    }

    setExpandedMetric(metric);
    setDrilldownData([]);
    setDrilldownLoading(true);

    try {
      const res = await fetch(`/api/reports/drilldown?period=${period}&branchCode=${branchCode}&metric=${metric}`);
      if (res.ok) {
        const payload = await res.json();
        setDrilldownData(payload);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setDrilldownLoading(false);
    }
  };

  // Vai trò được gán riêng một tab (ví dụ thu ngân chỉ có "Thu chi ngày") thì chỉ thấy tab đó.
  const visibleTabs = useMemo(() => filterModuleTabs(user, href), [user]);
  const canConfigure = user ? canPerformMenuAction(user, href, "create") : false;
  const canCreateCashDeposit = user ? canCreateCashDepositSlip(user) : false;
  const canEnterManualRevenue = user ? canPerformMenuAction(user, href, "create") : false;
  const canAdminPeriod = user?.role === "Admin";

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab && reportTabs.some((item) => item.id === tab)) {
      window.setTimeout(() => setActive(tab), 0);
    }
  }, []);

  // Tab mặc định có thể nằm ngoài quyền -> chuyển về tab đầu tiên được phép.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (visibleTabs.some((tab) => tab.id === active)) return;
    const fallback = visibleTabs[0].id;
    window.setTimeout(() => {
      setData(null);
      setActive(fallback);
    }, 0);
  }, [active, visibleTabs]);

  const loadData = useCallback(async () => {
    try {
      setTabLoading(true);
      const params = new URLSearchParams({ type: active, period, branchCode, scenario });
      if (active === "daily-cash") {
        params.set("reportDate", reportDate);
        params.set("shift", shift);
      }
      if (active === "cash-source") params.set("view", cashSourceView);
      // Tab Tiền về đủ chưa mang thêm bảng "Đối chiếu tiền vào đã đủ chưa" (chuyển từ tab
      // Thu chi ngày sang) — bảng đó tính theo ngày/ca nên nạp kèm báo cáo thu chi ngày.
      const reconPromise = active === "revenue-settlement"
        ? fetch(`/api/reports?${new URLSearchParams({ type: "daily-cash", period, branchCode, scenario, reportDate, shift }).toString()}`)
        : null;
      const response = await fetch(`/api/reports?${params.toString()}`);
      if (response.ok) {
        const result = await response.json();
        setData(result);
      }
      if (reconPromise) {
        const reconResponse = await reconPromise;
        setReconDailyCash(reconResponse.ok ? ((await reconResponse.json()) as DailyCashData) : null);
      }
    } catch (e) {
      console.error("Error loading reports data:", e);
    } finally {
      setTabLoading(false);
    }
  }, [active, branchCode, cashSourceView, period, reportDate, scenario, shift]);

  const loadMoneySources = useCallback(async () => {
    const response = await fetch("/api/master-data?type=MONEY_SOURCE&status=ACTIVE");
    if (!response.ok) return;
    setMoneySources((await response.json()) as MoneySourceOption[]);
  }, []);

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadData();
        void loadMoneySources();
      }, 0);
    }
  }, [loading, loadData, loadMoneySources]);

  const handleTabChange = (newTab: string) => {
    if (newTab !== active) {
      setData(null);
      setReconDailyCash(null);
      setActive(newTab);
    }
  };

  const printDailyCashReport = () => {
    const originalTitle = document.title;
    const restoreTitle = () => {
      document.title = originalTitle;
      window.removeEventListener("afterprint", restoreTitle);
    };

    document.title = "\u200B";
    window.addEventListener("afterprint", restoreTitle);
    window.setTimeout(() => {
      window.print();
    }, 0);
  };

  const saveForecast = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "UPSERT_FORECAST", ...forecast }) });
    const payload = await response.json();
    setMessage(response.ok ? "Đã lưu giả định dự báo." : payload.error || "Không lưu được giả định");
    if (response.ok) await loadData();
  };

  const saveTarget = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "UPSERT_TARGET", period, branchCode, metric: targetForm.metric, targetValue: targetForm.targetValue }),
    });
    const payload = await response.json();
    setMessage(response.ok ? "Đã lưu ngân sách/target báo cáo." : payload.error || "Không lưu được ngân sách");
    if (response.ok) await loadData();
  };

  const updatePeriodStatus = async (action: "CLOSE_PERIOD" | "REOPEN_PERIOD") => {
    const response = await fetch("/api/finance-operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, period, branchCode, reason: reopenReason }),
    });
    const payload = await response.json();
    setMessage(response.ok ? (action === "CLOSE_PERIOD" ? "Đã khóa kỳ kế toán." : "Đã mở lại kỳ kế toán.") : payload.error || "Không cập nhật được kỳ");
    if (response.ok) await loadData();
  };

  const dashboard = active === "dashboard" && data && typeof data === "object" && "pnl" in data && data.pnl ? (data as DashboardData) : null;
  const pnl = active === "pnl" && data && typeof data === "object" && "total" in data && data.total ? (data as PnlData) : null;
  const yoy = active === "yoy" && data && typeof data === "object" && "rows" in data && Array.isArray(data.rows) ? (data as YoyData) : null;
  const cashflow = active === "cashflow" && data && typeof data === "object" && "forecast" in data ? (data as CashflowData) : null;
  const balance = active === "balance" && data && typeof data === "object" && "rows" in data ? (data as BalanceData) : null;
  const operations = active === "operations" && data && typeof data === "object" && "details" in data ? (data as OperationsData) : null;
  const budget = active === "budget" && data && typeof data === "object" && "rows" in data ? (data as BudgetData) : null;
  const dailyCash = active === "daily-cash" && data && typeof data === "object" && "summary" in data && "expenses" in data ? (data as DailyCashData) : null;
  const activity = active === "activity" && data && typeof data === "object" && "periods" in data ? (data as ActivityData) : null;
  const cashSource = active === "cash-source" && data && typeof data === "object" && "totals" in data && "income" in data ? (data as CashSourceData) : null;
  const settlement = active === "revenue-settlement" && data && typeof data === "object" && "rows" in data && "totals" in data && !("income" in data) ? (data as RevenueSettlementData) : null;

  const operationRows = useMemo(() => {
    if (!operations) return [] as Array<OperationDetail & { module: string }>;
    return [
      ...operations.details.purchaseRequests.map((row) => ({ ...row, module: "PR" })),
      ...operations.details.purchaseOrders.map((row) => ({ ...row, module: "PO" })),
      ...operations.details.receipts.map((row) => ({ ...row, module: "Nhập hàng" })),
      ...operations.details.workItems.map((row) => ({ ...row, module: "Công việc" })),
      ...operations.details.assets.map((row) => ({ ...row, module: "Tài sản/CCDC" })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [operations]);

  /**
   * Bảng "Tổng hợp thu trong ngày": mỗi dòng tự tính số nộp = tiền mặt của dòng đó
   * trừ chi tiền mặt phân bổ cho dòng đó. Dòng TOTAL chỉ cộng dồn hai cột này lại.
   */
  const dailyCashSummaryRows = useMemo(() => {
    if (!dailyCash) return [] as Array<{ label: string; bucket: DailyCashBucket; expense?: number; cashToDeposit?: number }>;
    // Phiếu thu tiền mặt chi tiết là số tiền bán hàng thực thu của ca/ngày.
    // Gộp vào dòng doanh thu để bảng tổng hợp khớp với phần chi tiết bên dưới,
    // nhưng vẫn giữ summary.receipt riêng cho bảng chứng từ.
    // Dùng receiptRevenue, không dùng receipt: khi file POS đã ghi doanh thu tiền mặt của ngày
    // thì phiếu thu bán hàng bằng tiền mặt là chứng từ của chính khoản đó, đã được trừ ra ở API.
    const cashReceipts = dailyCash.summary.receiptRevenue || dailyCash.summary.receipt;
    const revenueWithCashReceipts: DailyCashBucket = {
      total: dailyCash.summary.revenue.total + cashReceipts.total,
      cash: dailyCash.summary.revenue.cash + cashReceipts.cash,
      transfer: dailyCash.summary.revenue.transfer + cashReceipts.transfer,
      card: dailyCash.summary.revenue.card + cashReceipts.card,
      grab: dailyCash.summary.revenue.grab + cashReceipts.grab,
      other: dailyCash.summary.revenue.other + cashReceipts.other,
    };
    return [
      {
        label: "Doanh thu bán hàng",
        bucket: revenueWithCashReceipts,
        expense: dailyCash.summary.cashExpenseTotal,
        cashToDeposit: revenueWithCashReceipts.cash - dailyCash.summary.cashExpenseTotal,
      },
      // Đặt cọc không gánh chi tiền mặt nên số nộp đúng bằng phần tiền mặt của nó.
      { label: "Đặt cọc", bucket: dailyCash.summary.deposit, cashToDeposit: dailyCash.summary.deposit.cash },
    ];
  }, [dailyCash]);
  const dailyCashExpenseSum = dailyCashSummaryRows.reduce((sum, row) => sum + (row.expense || 0), 0);
  const dailyCashDepositSum = dailyCashSummaryRows.reduce((sum, row) => sum + (row.cashToDeposit || 0), 0);

  /**
   * Tiền mặt cần nộp của ĐÚNG quỹ đang chọn, không phải tổng cả cửa hàng.
   *
   * Một ngày có thể bán qua nhiều quỹ tiền mặt (thu ngân giữ, quản lý giữ); mỗi quỹ là một số dư
   * riêng nên phải nộp một phiếu riêng. Lấy tổng rồi trừ hết vào một quỹ sẽ làm quỹ đó âm và quỹ
   * còn lại không bao giờ được clear. Cửa hàng chỉ có một quỹ thì hai số này bằng nhau.
   */
  const cashToDepositSources = dailyCash?.cashToDepositSources || [];
  const cashDepositTotalAmount = Math.max(0, Math.round(dailyCash?.summary.cashToDeposit || 0));
  const cashDepositSelectedSource = cashToDepositSources.find((row) => row.code === cashDepositForm.fromMoneySourceCode);
  /** Phần tiền chưa nối được về quỹ nào: doanh thu nhập tay, hoặc PTTT lạ chưa khai trong danh mục. */
  const cashDepositUnassignedAmount = Math.round(cashToDepositSources.find((row) => !row.code)?.amount || 0);
  const cashDepositIdentifiedTotal = cashToDepositSources
    .filter((row) => row.code)
    .reduce((sum, row) => sum + row.amount, 0);
  // Không nối được quỹ nào (ngày chỉ có doanh thu nhập tay) thì cả cục thuộc quỹ đang chọn —
  // giữ đúng cách chạy cũ. Còn khi đã nối được ít nhất một quỹ thì không đoán phần lẻ thuộc
  // quỹ nào, vì cộng nó vào mọi quỹ sẽ nộp thừa; người dùng khai lại nguồn tiền cho đúng.
  const cashDepositAmount = cashToDepositSources.length === 0
    ? cashDepositTotalAmount
    : Math.max(0, Math.round(cashDepositSelectedSource?.amount || 0) + (cashDepositIdentifiedTotal > 0 ? 0 : cashDepositUnassignedAmount));
  /** Phiếu đã lập cho đúng ca đang xem, để biết quỹ nào nộp rồi và quỹ nào còn treo. */
  const cashDepositExistingSlips = (dailyCash?.cashDeposits || []).filter((row) => row.sourceShift === dailyCash?.shift);
  const cashDepositedSourceCodes = new Set(
    cashDepositExistingSlips
      .filter((row) => row.depositTargetType === cashDepositForm.depositTargetType)
      .map((row) => row.fromMoneySourceCode),
  );
  /**
   * Số thực nộp làm tròn tới nghìn gần nhất theo quy tắc 5 lên, dưới 5 xuống.
   * Chênh lệch dương là chi phí; làm tròn lên tạo chi phí âm.
   */
  const cashDepositRoundedAmount = roundCashDepositAmount(cashDepositAmount);
  const cashDepositRoundingDifference = cashDepositRoundingExpense(cashDepositAmount);
  const cashDepositDenominationTotal = cashDepositForm.denominations.reduce((sum, row) => {
    const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
    return sum + row.denomination * quantity;
  }, 0);
  const cashDepositAllCashSources = dailyCash ? filterMoneySources(moneySources, dailyCash.branchCode, ["CASH"]) : [];
  // Thu ngân chỉ nộp được quỹ của chính mình; các quỹ tiền mặt khác không nằm trong báo cáo này.
  const cashDepositCashSources = dailyCash ? filterCashierCashSources(moneySources, dailyCash.branchCode) : [];
  // Nộp tiền trong ngày chỉ đổi người giữ tiền mặt (nộp Cô / nộp PKT) nên nguồn nhận cũng phải
  // là quỹ tiền mặt — và thường chính là quỹ ngoài thu ngân, nên nguồn nhận vẫn liệt kê đủ.
  const cashDepositTargetSources = cashDepositAllCashSources.filter((source) => source.code !== cashDepositForm.fromMoneySourceCode);
  const cashDepositDefaultFromSourceCode = cashDepositCashSources[0]?.code || "";
  const cashDepositDefaultTargetSources = cashDepositAllCashSources.filter((source) => source.code !== cashDepositDefaultFromSourceCode);
  const cashDepositDisabledReason = !canCreateCashDeposit
    ? "Bạn không có quyền tạo phiếu nộp tiền."
    : !dailyCash
      ? "Chưa có dữ liệu báo cáo thu chi ngày."
      : dailyCash.branchCode === "ALL"
        ? "Chọn một cửa hàng cụ thể để nộp tiền."
        : cashDepositTotalAmount <= 0
          ? "Ngày/ca này chưa có tiền mặt cần nộp."
          : cashDepositCashSources.length === 0
              ? "Chưa cấu hình nguồn tiền mặt cho cửa hàng này."
              : cashDepositDefaultTargetSources.length === 0
                ? "Cửa hàng này mới có một nguồn tiền mặt; cần thêm nguồn tiền mặt nhận (nộp Cô / nộp PKT) trong Cấu hình danh mục."
                : "";

  // Bản ghi nhập tay của đúng ca đang xem; xem "Cả ngày" mà đã nhập theo ca thì không sửa trực tiếp ở đây được.
  const editableManualEntry = dailyCash?.manualEntries.find((entry) => entry.shift === dailyCash.shift) || null;
  const manualRevenueTotal = manualRevenueFields.reduce((sum, field) => sum + toAmountNumber(manualRevenueForm[field.key]), 0);
  const manualRevenueDisabledReason = !canEnterManualRevenue
    ? "Bạn không có quyền nhập doanh thu tay."
    : !dailyCash
      ? "Chưa có dữ liệu báo cáo thu chi ngày."
      : dailyCash.branchCode === "ALL"
        ? "Chọn một cửa hàng cụ thể để nhập doanh thu."
        : "";

  const openManualRevenueModal = () => {
    if (!dailyCash) return;
    if (dailyCash.branchCode === "ALL") {
      setMessage("Vui lòng chọn một cửa hàng cụ thể trước khi nhập doanh thu.");
      return;
    }
    setManualRevenueForm(editableManualEntry
      ? {
          cashAmount: String(Math.round(editableManualEntry.cashAmount) || ""),
          transferAmount: String(Math.round(editableManualEntry.transferAmount) || ""),
          cardAmount: String(Math.round(editableManualEntry.cardAmount) || ""),
          grabAmount: String(Math.round(editableManualEntry.grabAmount) || ""),
          otherAmount: String(Math.round(editableManualEntry.otherAmount) || ""),
          note: editableManualEntry.note || "",
        }
      : emptyManualRevenueForm);
    setManualRevenueOpen(true);
    setMessage("");
  };

  const submitManualRevenue = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dailyCash || manualRevenueSubmitting) return;
    if (manualRevenueTotal <= 0) {
      setMessage("Phải nhập ít nhất một khoản tiền lớn hơn 0.");
      return;
    }
    setManualRevenueSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "UPSERT_MANUAL_REVENUE",
          period,
          branchCode: dailyCash.branchCode,
          reportDate: dailyCash.reportDate,
          shift: dailyCash.shift,
          cashAmount: toAmountNumber(manualRevenueForm.cashAmount),
          transferAmount: toAmountNumber(manualRevenueForm.transferAmount),
          cardAmount: toAmountNumber(manualRevenueForm.cardAmount),
          grabAmount: toAmountNumber(manualRevenueForm.grabAmount),
          otherAmount: toAmountNumber(manualRevenueForm.otherAmount),
          note: manualRevenueForm.note,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không lưu được doanh thu nhập tay.");
        return;
      }
      setManualRevenueOpen(false);
      setMessage(`Đã lưu doanh thu ${shiftLabels[dailyCash.shift] || dailyCash.shift}: ${money(manualRevenueTotal)} đ.`);
      await loadData();
    } catch {
      setMessage("Không kết nối được máy chủ để lưu doanh thu.");
    } finally {
      setManualRevenueSubmitting(false);
    }
  };

  const deleteManualRevenue = async (entry: ManualRevenueEntry) => {
    if (!dailyCash || manualRevenueSubmitting) return;
    if (!window.confirm(`Xoá doanh thu nhập tay ${money(entry.totalAmount)} đ của ${shiftLabels[entry.shift] || entry.shift}?`)) return;
    setManualRevenueSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "DELETE_MANUAL_REVENUE", period, branchCode: dailyCash.branchCode, entryId: entry.id }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không xoá được doanh thu nhập tay.");
        return;
      }
      setMessage("Đã xoá doanh thu nhập tay.");
      await loadData();
    } catch {
      setMessage("Không kết nối được máy chủ để xoá doanh thu.");
    } finally {
      setManualRevenueSubmitting(false);
    }
  };

  const pickCashDepositTarget = (targetType: "PKT" | "CO", fromMoneySourceCode: string, reportBranchCode: string) => {
    const targetHint = targetType === "PKT" ? "PKT" : "CO";
    // Nguồn nhận chỉ lấy trong nhóm tiền mặt. Bỏ dấu trước khi dò chữ: nguồn "Tiền Mặt Cô Giữ"
    // có chữ "CÔ" chứ không phải "CO", so chuỗi thẳng thì không khớp và rơi về nguồn đầu danh sách.
    const normalize = (value: string) => value.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/Đ/g, "D");
    const options = filterMoneySources(moneySources, reportBranchCode, ["CASH"]).filter((source) => source.code !== fromMoneySourceCode);
    return (
      options.find((source) => normalize(`${source.code} ${source.name}`).split(/[^A-Z0-9]+/).includes(targetHint))?.code ||
      options[0]?.code ||
      ""
    );
  };

  const openCashDepositModal = () => {
    if (!dailyCash) return;
    if (dailyCash.branchCode === "ALL") {
      setMessage("Vui lòng chọn một cửa hàng cụ thể trước khi tạo phiếu nộp tiền.");
      return;
    }
    if (cashDepositTotalAmount <= 0) {
      setMessage(
        "Không có số tiền mặt cần nộp cho ngày/ca này.",
      );
      return;
    }
    // Mở lên là chọn sẵn quỹ còn nhiều tiền chưa nộp nhất, không phải quỹ đầu danh sách:
    // ngày có hai quỹ thì lần mở thứ hai người dùng cần đúng quỹ còn lại.
    const depositedCodes = new Set(
      (dailyCash.cashDeposits || [])
        .filter((row) => row.sourceShift === dailyCash.shift && row.depositTargetType === "PKT")
        .map((row) => row.fromMoneySourceCode),
    );
    const pendingSource = cashToDepositSources
      .filter((row) => row.code && row.amount > 0 && !depositedCodes.has(row.code))
      .sort((left, right) => right.amount - left.amount)[0];
    const fromMoneySourceCode = pendingSource?.code
      || cashToDepositSources.find((row) => row.code && row.amount > 0)?.code
      || filterCashierCashSources(moneySources, dailyCash.branchCode)[0]?.code
      || "";
    const toMoneySourceCode = pickCashDepositTarget("PKT", fromMoneySourceCode, dailyCash.branchCode);
    if (!fromMoneySourceCode) {
      setMessage("Chưa cấu hình nguồn tiền mặt cho cửa hàng này.");
      return;
    }
    if (!toMoneySourceCode) {
      setMessage("Chưa cấu hình nguồn tiền nhận cho cửa hàng này.");
      return;
    }
    setCashDepositForm({
      depositTargetType: "PKT",
      fromMoneySourceCode,
      toMoneySourceCode,
      denominations: cashDepositDenominations.map((denomination) => ({ denomination, quantity: "" })),
    });
    setCashDepositOpen(true);
    setMessage("");
  };

  const updateCashDepositDenomination = (denomination: number, quantity: string) => {
    const cleanQuantity = quantity.replace(/\D/g, "");
    setCashDepositForm((current) => ({
      ...current,
      denominations: current.denominations.map((row) => row.denomination === denomination ? { ...row, quantity: cleanQuantity } : row),
    }));
  };

  const submitCashDeposit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dailyCash || cashDepositSubmitting) return;
    if (cashDepositDenominationTotal !== cashDepositRoundedAmount) {
      setMessage(`Tổng bảng kê mệnh giá phải bằng số tiền cần nộp (${money(cashDepositRoundedAmount)} đ).`);
      return;
    }
    setCashDepositSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_CASH_DEPOSIT_TRANSFER",
          transferDate: dailyCash.reportDate,
          sourceReportDate: dailyCash.reportDate,
          sourceShift: dailyCash.shift,
          branchCode: dailyCash.branchCode,
          depositTargetType: cashDepositForm.depositTargetType,
          fromMoneySourceCode: cashDepositForm.fromMoneySourceCode,
          toMoneySourceCode: cashDepositForm.toMoneySourceCode,
          amount: cashDepositRoundedAmount,
          grossAmount: cashDepositAmount,
          denominations: cashDepositForm.denominations.map((row) => ({
            denomination: row.denomination,
            quantity: Math.max(0, Math.floor(Number(row.quantity) || 0)),
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không tạo được phiếu nộp tiền.");
        return;
      }
      const fromSourceLabel = cashDepositSelectedSource?.name
        || cashDepositCashSources.find((source) => source.code === cashDepositForm.fromMoneySourceCode)?.name
        || cashDepositForm.fromMoneySourceCode;
      const remainingSources = cashToDepositSources.filter((row) => row.code
        && row.code !== cashDepositForm.fromMoneySourceCode
        && row.amount > 0
        && !cashDepositedSourceCodes.has(row.code));
      setMessage(
        `Đã tạo phiếu ${payload.code} chờ duyệt: thực nộp ${money(cashDepositRoundedAmount)} đ`
        + `${cashDepositRoundingDifference !== 0 ? `, chi phí làm tròn ${money(cashDepositRoundingDifference)} đ` : ""}`
        + `, clear ${money(cashDepositAmount)} đ khỏi ${fromSourceLabel}.`
        + `${remainingSources.length > 0 ? ` Còn ${remainingSources.length} quỹ tiền mặt chưa nộp: ${remainingSources.map((row) => `${row.name} (${money(row.amount)} đ)`).join(", ")}.` : ""}`,
      );
      setCashDepositOpen(false);
      await loadData();
    } catch {
      setMessage("Lỗi kết nối máy chủ khi tạo phiếu nộp tiền.");
    } finally {
      setCashDepositSubmitting(false);
    }
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame title="Báo cáo & BI" subtitle="GĐ4 - Dashboard, báo cáo vận hành, ngân sách, kỳ kế toán và nhật ký" role={user?.role}>
      <StickyFilterBar>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Kỳ báo cáo">
          <MonthInput className="mt-1.5 w-40" value={period} onChange={setPeriod} ariaLabel="Kỳ báo cáo" />
        </Field>
        <Field label="Phạm vi cửa hàng">
          <select className="control w-56" value={branchCode} onChange={(event) => setBranchCode(event.target.value)}>
            {visibleBranchScopeOptions(user).map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
          </select>
        </Field>
        {active === "cashflow" && (
          <Field label="Kịch bản">
            <select className="control w-40" value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="BASE">Cơ sở</option>
              <option value="UPSIDE">Tích cực</option>
              <option value="DOWNSIDE">Thận trọng</option>
            </select>
          </Field>
        )}
        {active === "cash-source" && (
          <Field label="Xem theo">
            <select className="control w-40" value={cashSourceView} onChange={(event) => setCashSourceView(event.target.value === "year" ? "year" : "month")}>
              <option value="month">Tháng</option>
              <option value="year">Cả năm</option>
            </select>
          </Field>
        )}
        {/* Tiền về đủ chưa cũng cần Ngày + Ca cho bảng "Đối chiếu tiền vào đã đủ chưa" ở đầu tab. */}
        {["daily-cash", "revenue-settlement"].includes(active) && (
          <>
            <Field label={active === "daily-cash" ? "Ngày thu chi" : "Ngày đối chiếu"}>
              <DateInput className="mt-1.5 w-40" value={reportDate} onChange={setReportDate} ariaLabel="Ngày thu chi" />
            </Field>
            <Field label="Ca">
              <select className="control w-36" value={shift} onChange={(event) => setShift(event.target.value)}>
                <option value="FULL">Cả ngày</option>
                <option value="MORNING">Ca sáng</option>
                <option value="EVENING">Ca tối</option>
              </select>
            </Field>
          </>
        )}
        <button type="button" className="icon-button" title="Tải lại số liệu và danh mục nguồn tiền — sửa Nguồn tiền tổng bên Cấu hình xong bấm nút này là thấy ngay, không cần đăng nhập lại" onClick={() => { void loadData(); void loadMoneySources(); }}>
          <span className="material-symbols-outlined text-lg">refresh</span>
        </button>
      </div>
      <div className="mb-3" />
      <ModuleTabs
        active={active}
        onChange={handleTabChange}
        tabs={visibleTabs}
      />
      </StickyFilterBar>

      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {tabLoading && (
        <div className="py-16 text-center text-slate-500 font-medium">
          <span className="material-symbols-outlined animate-spin text-3xl text-blue-600 block mb-2">progress_activity</span>
          Đang tải dữ liệu báo cáo...
        </div>
      )}

      {!tabLoading && operations && (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <OpsKpi label="PR" count={operations.summary.purchaseRequests.count} amount={operations.summary.purchaseRequests.amount} icon="assignment" />
            <OpsKpi label="PO" count={operations.summary.purchaseOrders.count} amount={operations.summary.purchaseOrders.amount} icon="shopping_cart" />
            <OpsKpi label="Nhập hàng" count={operations.summary.receipts.count} amount={operations.summary.receipts.amount} icon="inventory" />
            <OpsKpi label="Công việc" count={operations.summary.workItems.count} extra={`${operations.summary.workItems.overdue} quá hạn`} icon="task_alt" />
            <OpsKpi label="Tài sản/CCDC" count={operations.summary.assets.count} amount={operations.summary.assets.amount} icon="precision_manufacturing" />
          </div>
          <div className="grid xl:grid-cols-2 gap-5">
            <OperationGroupTable title="PR theo phòng ban" rows={operations.groups.purchaseRequests} />
            <OperationGroupTable title="PO theo phòng ban" rows={operations.groups.purchaseOrders} />
            <OperationGroupTable title="Nhập hàng theo phòng ban" rows={operations.groups.receipts} />
            <OperationGroupTable title="Công việc theo phòng ban" rows={operations.groups.workItems} />
            <OperationGroupTable title="Tài sản/CCDC theo phòng ban" rows={operations.groups.assets} />
          </div>
          <section className="table-panel">
            <PanelHeader title="Danh sách chi tiết vận hành" subtitle="Scroll để xem PR, PO, nhập hàng, công việc và tài sản/CCDC trong kỳ." />
            <div className="max-h-[520px] overflow-auto">
              <Table headers={["Phần hành", "Mã", "Ngày", "Cửa hàng", "Phòng ban", "Trạng thái", "Giá trị/Phụ trách"]}>
                {operationRows.map((row) => (
                  <tr key={`${row.module}-${row.id}`} className="border-t border-slate-100">
                    <Cell><b>{row.module}</b></Cell>
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small className="block text-slate-500">{row.note}</small></Cell>
                    <Cell>{new Date(row.date).toLocaleDateString("vi-VN")}</Cell>
                    <Cell>{storeLabel(row.branchCode)}</Cell>
                    <Cell>{row.departmentName}</Cell>
                    <Cell><span className={`status ${row.overdue ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-700"}`}>{row.status}</span></Cell>
                    <Cell right>{row.amount ? `${money(row.amount)} đ` : row.owner || "-"}</Cell>
                  </tr>
                ))}
              </Table>
            </div>
          </section>
        </div>
      )}

      {!tabLoading && budget && (
        <div className="space-y-5">
          <div className="grid md:grid-cols-4 gap-4">
            <Kpi label="Doanh thu thực tế" value={budget.summary.revenueActual} icon="payments" tone="blue" />
            <Kpi label="Target doanh thu" value={budget.summary.revenueTarget} icon="flag" />
            <Kpi label="Chi phí thực tế" value={budget.summary.expenseActual} icon="receipt_long" tone="amber" />
            <Kpi label="Ngân sách chi phí" value={budget.summary.expenseTarget} icon="price_check" tone="green" />
          </div>

          <div className="grid xl:grid-cols-[360px_1fr] gap-5">
            {canConfigure && (
              <form onSubmit={saveTarget} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit">
                <h2 className="font-bold">Thiết lập ngân sách/target</h2>
                <Field label="Chỉ tiêu">
                  <select className="control" value={targetForm.metric} onChange={(event) => setTargetForm({ ...targetForm, metric: event.target.value })}>
                    <option value="revenue">Doanh thu</option>
                    <option value="cogs">Giá vốn</option>
                    <option value="payroll">Chi phí nhân sự</option>
                    <option value="otherOpex">OPEX khác</option>
                    <option value="depreciation">Khấu hao</option>
                    <option value="opexBeforeDepreciation">OPEX trước khấu hao</option>
                    <option value="ebitda">EBITDA</option>
                    <option value="cashRemaining">Nguồn tiền còn lại (báo cáo nguồn tiền)</option>
                  </select>
                </Field>
                <Field label="Giá trị ngân sách/target">
                  <input type="number" min="0" className="control" value={targetForm.targetValue} onChange={(event) => setTargetForm({ ...targetForm, targetValue: event.target.value })} />
                </Field>
                <button className="primary-button w-full">
                  <span className="material-symbols-outlined text-lg">save</span>Lưu ngân sách
                </button>
              </form>
            )}
            <section className="table-panel">
              <PanelHeader title="So sánh thực tế với ngân sách" subtitle="Bấm vào từng chỉ tiêu để xem chi tiết đối chiếu chứng từ gốc phát sinh chi phí thực tế." />
              <div className="max-h-[560px] overflow-auto">
                <Table headers={["Chỉ tiêu", "Thực tế", "Ngân sách/Target", "Chênh lệch", "Tỷ lệ dùng & Tiến trình", "Đối chiếu"]}>
                  {budget.rows.map((row) => {
                    const hasTarget = !!row.target;
                    const rateVal = row.usageRate !== null ? Math.round(row.usageRate * 100) : 0;

                    let barColor = "bg-slate-300";

                    if (row.kind === "EXPENSE") {
                      if (rateVal <= 80) {
                        barColor = "bg-emerald-500";
                      } else if (rateVal <= 100) {
                        barColor = "bg-amber-500";
                      } else {
                        barColor = "bg-rose-500";
                      }
                    } else {
                      if (rateVal >= 100) {
                        barColor = "bg-emerald-500";
                      } else if (rateVal >= 80) {
                        barColor = "bg-amber-500";
                      } else {
                        barColor = "bg-rose-500";
                      }
                    }

                    const isExpanded = expandedMetric === row.metric;

                    return (
                      <React.Fragment key={row.metric}>
                        <tr
                          className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                          onClick={() => void handleToggleExpand(row.metric)}
                        >
                          <Cell>
                            <div className="flex flex-col">
                              <span className="font-bold text-slate-800">{row.label}</span>
                              <span className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider mt-0.5">
                                {row.kind === "EXPENSE" ? "Chi phí" : row.kind === "REVENUE" ? "Doanh thu" : "Lợi nhuận"}
                              </span>
                            </div>
                          </Cell>
                          <Cell right><b>{money(row.actual)} đ</b></Cell>
                          <Cell right>{hasTarget ? `${money(row.target)} đ` : <span className="text-slate-400 font-normal">Chưa gán</span>}</Cell>
                          <Cell right>
                            {hasTarget ? (
                              <span className={`font-bold ${row.isGood ? "text-emerald-600" : "text-rose-600"}`}>
                                {row.variance > 0 ? "+" : ""}{money(row.variance)} đ
                              </span>
                            ) : (
                              "-"
                            )}
                          </Cell>
                          <Cell>
                            {hasTarget ? (
                              <div className="flex items-center gap-3">
                                <div className="flex-1 bg-slate-100 h-2.5 rounded-full overflow-hidden">
                                  <div className={`h-full ${barColor} transition-all duration-500 rounded-full`} style={{ width: `${Math.min(100, Math.max(0, rateVal))}%` }} />
                                </div>
                                <span className={`text-xs font-bold w-12 text-right ${row.isGood ? "text-emerald-600" : "text-rose-600"}`}>
                                  {rateVal}%
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400 text-xs">Chưa lập target</span>
                            )}
                          </Cell>
                          <Cell center>
                            <button
                              type="button"
                              className="text-xs text-blue-600 font-bold hover:underline flex items-center justify-center gap-1 mx-auto"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleToggleExpand(row.metric);
                              }}
                            >
                              <span>{isExpanded ? "Thu gọn" : "Xem phát sinh"}</span>
                              <span className="material-symbols-outlined text-sm">
                                {isExpanded ? "expand_less" : "expand_more"}
                              </span>
                            </button>
                          </Cell>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-slate-50 border-t border-b border-slate-200">
                            <td colSpan={6} className="p-4">
                              <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
                                <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                                    <span className="material-symbols-outlined text-blue-600 text-base">receipt_long</span>
                                    Bảng kê chi tiết phát sinh chứng từ cho chỉ tiêu: <span className="text-blue-600 font-extrabold">{row.label}</span>
                                  </h4>
                                  <span className="text-xs text-slate-500">
                                    Kỳ {period} - {branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(branchCode)}
                                  </span>
                                </div>

                                {drilldownLoading ? (
                                  <p className="py-6 text-center text-xs text-slate-500 animate-pulse">Đang truy xuất bảng kê sổ cái phát sinh...</p>
                                ) : drilldownData.length === 0 ? (
                                  <p className="py-6 text-center text-xs text-slate-400">Không có chứng từ nào ghi nhận chi phí thực tế cho chỉ tiêu này trong kỳ.</p>
                                ) : (
                                  <div className="overflow-x-auto">
                                    <Table headers={["Ngày ghi sổ", "Mã chứng từ", "Mã tài khoản", "Tên tài khoản kế toán", "Diễn giải nghiệp vụ", "Số tiền (đ)"]}>
                                      {drilldownData.map((item) => (
                                        <tr key={item.id} className="border-t border-slate-100 text-xs hover:bg-slate-50">
                                          <Cell>{item.date}</Cell>
                                          <Cell><CopyableText value={item.code}><b>{item.code}</b></CopyableText></Cell>
                                          <Cell><span className="bg-blue-50 text-blue-700 font-bold px-2 py-0.5 rounded">{item.accountCode}</span></Cell>
                                          <Cell>{item.accountName}</Cell>
                                          <Cell>{item.description}</Cell>
                                          <Cell right><b>{money(item.amount)} đ</b></Cell>
                                        </tr>
                                      ))}
                                    </Table>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </Table>
              </div>
            </section>
          </div>
        </div>
      )}

      {!tabLoading && cashSource && (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Báo cáo nguồn tiền {cashSource.view === "year" ? `năm ${cashSource.year}` : `tháng ${cashSource.period.slice(5)}/${cashSource.year}`}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {cashSource.branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(cashSource.branchCode)} · Tiền thực thu/thực chi theo từng khoản mục thu và chi.
            </p>
          </div>

          <div className="grid md:grid-cols-4 gap-4">
            <Kpi label="Tổng thu" value={cashSource.totals.in} icon="payments" tone="blue" />
            <Kpi label="Tổng chi" value={cashSource.totals.out} icon="receipt_long" tone="amber" />
            <Kpi label="Nguồn tiền còn lại (Thu - Chi)" value={cashSource.totals.net} icon="savings" tone={cashSource.totals.net < 0 ? "rose" : "green"} />
            {cashSource.cashRemainingTarget.total > 0
              ? <Kpi label="Nguồn tiền còn lại mục tiêu" value={cashSource.cashRemainingTarget.total} icon="flag" tone={cashSource.totals.net < cashSource.cashRemainingTarget.total ? "rose" : "green"} />
              : <Kpi label="Chi cho nhà cung cấp" value={cashSource.supplierExpense.total} icon="local_shipping" tone="rose" />}
          </div>

          <div className="flex flex-wrap gap-3 text-xs">
            <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-600">
              Tỷ suất nguồn tiền còn lại / tổng thu: <b className="text-slate-900">{(cashSource.totals.netRatio * 100).toFixed(2)}%</b>
            </span>
            <span className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-600">
              Điều tiền nội bộ (không tính vào thu/chi): <b className="text-slate-900">{money(cashSource.internalTransfer.total)} đ</b> · {cashSource.internalTransfer.count} phiếu
            </span>
          </div>

          {(cashSource.unclassified.income > 0 || cashSource.unclassified.expense > 0) && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="material-symbols-outlined text-lg">warning</span>
              <span>
                Có <b>{money(cashSource.unclassified.income + cashSource.unclassified.expense)} đ</b> dữ liệu chưa xác định được danh mục thu/chi
                (thu {money(cashSource.unclassified.income)} đ, chi {money(cashSource.unclassified.expense)} đ) nên đang nằm ở dòng
                <b> &quot;Chưa phân loại&quot;</b>. Cần bổ sung danh mục hoặc quy tắc phân loại để báo cáo tách đủ theo danh mục.
              </span>
            </div>
          )}

          {(cashSource.pending.receiptCount > 0 || cashSource.pending.paymentCount > 0) && (
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <span className="material-symbols-outlined text-lg">pending_actions</span>
              <span>
                Chưa tính vào báo cáo: <b>{cashSource.pending.receiptCount}</b> phiếu thu ({money(cashSource.pending.receiptAmount)} đ) và
                <b> {cashSource.pending.paymentCount}</b> phiếu chi ({money(cashSource.pending.paymentAmount)} đ) còn ở trạng thái nháp/chờ duyệt.
              </span>
            </div>
          )}

          <div className="grid xl:grid-cols-2 gap-5">
            {(() => {
              // Khoảng ngày của kỳ đang xem, để link "Chưa phân loại" mở đúng các phiếu cần sửa.
              const firstMonth = cashSource.months[0];
              const lastMonth = cashSource.months[cashSource.months.length - 1];
              const lastDay = new Date(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5)), 0).getDate();
              // Mang theo cửa hàng đang xem: trang phiếu mở tab mới sẽ lấy cửa hàng từ
              // localStorage, khác cửa hàng của báo cáo là danh sách rỗng khó hiểu.
              const range = `missingCategory=1&branchCode=${encodeURIComponent(branchCode)}&from=${firstMonth}-01&to=${lastMonth}-${String(lastDay).padStart(2, "0")}`;
              const linksFor = (voucherType: "RECEIPT" | "PAYMENT") => [
                { label: "Xem phiếu tiền mặt chưa phân loại", href: `/vouchers?${range}&voucherType=${voucherType}` },
                { label: "Xem chứng từ ngân hàng chưa phân loại", href: `/bank-vouchers?${range}&voucherType=${voucherType}` },
              ];
              return (
                <>
                  <CashCategoryTable
                    title="Tổng quan thu theo danh mục"
                    subtitle="Tiền thực thu theo danh mục: tiền mặt lấy từ phiếu thu đã duyệt, còn lại lấy từ sổ sao kê ngân hàng theo Loại thu/chi khai trên file. Doanh thu POS/nhập tay chưa về tiền không nằm ở đây — phần ví chưa quyết toán xem ở cột Dự thu."
                    amountHeader="Tổng thu"
                    rows={cashSource.income}
                    total={cashSource.totals.in}
                    tone="blue"
                    unclassifiedLinks={linksFor("RECEIPT")}
                  />
                  <CashCategoryTable
                    title="Tổng quan chi theo danh mục"
                    subtitle="Tiền thực chi theo danh mục: tiền mặt lấy từ phiếu chi đã duyệt, còn lại lấy từ sổ sao kê ngân hàng theo Loại thu/chi khai trên file; dữ liệu chưa có danh mục được đưa vào Chưa phân loại."
                    amountHeader="Tổng chi"
                    rows={cashSource.expense}
                    total={cashSource.totals.out}
                    tone="amber"
                    unclassifiedLinks={linksFor("PAYMENT")}
                  />
                </>
              );
            })()}
          </div>

          <section className="table-panel">
            <PanelHeader
              title="Chi theo đối tác"
              subtitle={`Xếp theo số tiền đã chi trong kỳ. Dòng có nhãn NCC là nhà cung cấp, cộng lại chính là số chi cho nhà cung cấp ở thẻ trên.${
                cashSource.expensePartnerCount > cashSource.expenseByPartner.length
                  ? ` Đang hiện ${cashSource.expenseByPartner.length}/${cashSource.expensePartnerCount} đối tác có phát sinh chi.`
                  : ""
              }`}
            />
            <div className="overflow-x-auto">
              {(() => {
                // Link danh sách phiếu chi của từng đối tác (chốt meeting 22/08/2026): mở tab
                // mới, mang sẵn kỳ + cửa hàng + mã đối tác; tách hai kênh vì phiếu tiền mặt và
                // chứng từ ngân hàng nằm ở hai màn khác nhau.
                const firstMonth = cashSource.months[0];
                const lastMonth = cashSource.months[cashSource.months.length - 1];
                const lastDay = new Date(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5)), 0).getDate();
                const partnerQuery = (partnerCode: string) => `voucherType=PAYMENT&partnerCode=${encodeURIComponent(partnerCode)}&branchCode=${encodeURIComponent(branchCode)}&from=${firstMonth}-01&to=${lastMonth}-${String(lastDay).padStart(2, "0")}`;
                return (
                  <Table headers={["Đối tác", "Mã", "Loại", "Số phiếu chi", "Tổng chi", "% trên tổng chi", "Danh sách phiếu"]}>
                    {cashSource.expenseByPartner.length === 0 && (
                      <tr className="border-t border-slate-100"><Cell>Chưa có phiếu chi nào trong kỳ.</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell right>-</Cell></tr>
                    )}
                    {cashSource.expenseByPartner.map((row) => (
                      <tr key={`${row.code}-${row.name}`} className="border-t border-slate-100 hover:bg-slate-50">
                        <Cell><b>{row.name}</b></Cell>
                        <Cell>{row.code || "-"}</Cell>
                        <Cell>{partnerTypeLabel(row.partnerType)}</Cell>
                        <Cell>{row.count}</Cell>
                        <Cell><b>{money(row.total)} đ</b></Cell>
                        <Cell>{cashSource.totals.out ? ((row.total / cashSource.totals.out) * 100).toFixed(2) : "0,00"} %</Cell>
                        <Cell right>
                          {row.code ? (
                            <span className="flex justify-end gap-2 whitespace-nowrap text-xs font-bold">
                              <a href={`/vouchers?${partnerQuery(row.code)}`} target="_blank" rel="noreferrer" className="text-blue-700 underline-offset-2 hover:underline">Tiền mặt ↗</a>
                              <a href={`/bank-vouchers?${partnerQuery(row.code)}`} target="_blank" rel="noreferrer" className="text-blue-700 underline-offset-2 hover:underline">Ngân hàng ↗</a>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">Bổ sung mã đối tác để link</span>
                          )}
                        </Cell>
                      </tr>
                    ))}
                  </Table>
                );
              })()}
            </div>
          </section>

          {cashSource.view === "year" && (
            <>
              <CashMonthMatrix title="Tổng quan nguồn thu theo tháng" months={cashSource.months} rows={cashSource.income} />
              <CashMonthMatrix title="Tổng quan nguồn chi theo tháng" months={cashSource.months} rows={cashSource.expense} />
              <section className="table-panel">
                <PanelHeader title="Thu - chi từng tháng" subtitle="Tổng hợp lại theo tháng để nhìn nhanh tháng nào âm dòng tiền; kèm mục tiêu Nguồn tiền còn lại khai ở màn Ngân sách." />
                <div className="overflow-x-auto">
                  <Table headers={["Chỉ tiêu", ...cashSource.months.map((item) => `T${Number(item.slice(5))}`), "Tổng"]}>
                    {([
                      { label: "Tổng thu", pick: (row: { in: number; out: number; net: number }, index: number) => row.in, total: cashSource.totals.in },
                      { label: "Tổng chi", pick: (row: { in: number; out: number; net: number }, index: number) => row.out, total: cashSource.totals.out },
                      { label: "Nguồn tiền còn lại", pick: (row: { in: number; out: number; net: number }, index: number) => row.net, total: cashSource.totals.net },
                      ...(cashSource.cashRemainingTarget.total > 0 ? [
                        { label: "Nguồn tiền còn lại mục tiêu", pick: (row: { in: number; out: number; net: number }, index: number) => cashSource.cashRemainingTarget.byMonth[index] || 0, total: cashSource.cashRemainingTarget.total },
                        { label: "So sánh với mục tiêu", pick: (row: { in: number; out: number; net: number }, index: number) => row.net - (cashSource.cashRemainingTarget.byMonth[index] || 0), total: cashSource.totals.net - cashSource.cashRemainingTarget.total },
                      ] : []),
                    ]).map((line) => (
                      <tr key={line.label} className="border-t border-slate-100">
                        <Cell><b>{line.label}</b></Cell>
                        {cashSource.totals.byMonth.map((month, index) => (
                          <Cell key={month.period} right>
                            <span className={["Nguồn tiền còn lại", "So sánh với mục tiêu"].includes(line.label) && line.pick(month, index) < 0 ? "text-rose-600 font-bold" : ""}>
                              {line.pick(month, index) ? `${money(line.pick(month, index))}` : "-"}
                            </span>
                          </Cell>
                        ))}
                        <Cell right><b>{money(line.total)} đ</b></Cell>
                      </tr>
                    ))}
                    <tr className="border-t border-slate-200 bg-slate-50">
                      <Cell><b>% Nguồn tiền còn lại / Tổng thu</b></Cell>
                      {cashSource.totals.byMonth.map((month) => (
                        <Cell key={month.period} right>
                          <b className={month.net < 0 ? "text-rose-600" : "text-slate-700"}>
                            {month.in ? `${((month.net / month.in) * 100).toFixed(2)}%` : "-"}
                          </b>
                        </Cell>
                      ))}
                      <Cell right><b>{(cashSource.totals.netRatio * 100).toFixed(2)}%</b></Cell>
                    </tr>
                  </Table>
                </div>
              </section>
              <section className="table-panel">
                <PanelHeader
                  title="Tổng quan nguồn tiền cuối mỗi tháng"
                  subtitle="Số dư từng nguồn tiền mặt/ngân hàng tại thời điểm cuối mỗi tháng: đầu kỳ cộng dồn biến động của các tháng trước đó."
                />
                <div className="overflow-x-auto">
                  <Table headers={["Nguồn tiền", "Đầu kỳ", ...cashSource.months.map((item) => `T${Number(item.slice(5))}`)]}>
                    {cashSource.sources.map((row) => (
                      <tr key={row.code} className="border-t border-slate-100 hover:bg-slate-50">
                        <Cell><b>{cashSourceLabel(row.name)}</b><p className="mt-0.5 text-xs text-slate-500">{row.code}</p></Cell>
                        <Cell right>{row.opening ? `${money(row.opening)}` : "-"}</Cell>
                        {row.closingByMonth.map((closing, index) => (
                          <Cell key={cashSource.months[index]} right>
                            <span className={closing < 0 ? "text-rose-600 font-bold" : ""}>{closing ? money(closing) : "-"}</span>
                          </Cell>
                        ))}
                      </tr>
                    ))}
                    <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                      <Cell><b>CỘNG</b></Cell>
                      <Cell right><b>{money(cashSource.sources.reduce((sum, row) => sum + row.opening, 0))}</b></Cell>
                      {cashSource.months.map((month, index) => (
                        <Cell key={month} right>
                          <b>{money(cashSource.sources.reduce((sum, row) => sum + (row.closingByMonth[index] || 0), 0))}</b>
                        </Cell>
                      ))}
                    </tr>
                  </Table>
                </div>
              </section>
            </>
          )}

          <section className="table-panel">
            <PanelHeader
              title={`Tổng quan các khoản tiền cọc của khách ${cashSource.view === "year" ? `năm ${cashSource.year}` : `tháng ${cashSource.period.slice(5)}/${cashSource.year}`}`}
              subtitle="Nhận cọc chưa phải doanh thu — chỉ là khoản khách ứng trước. Khi cấn trừ vào bill, số cọc đó mới thành doanh thu của đúng ngày cấn trừ và bị trừ khỏi số còn lại."
            />
            <div className="overflow-x-auto">
              <Table headers={["Tài khoản", "Cọc chưa dùng kỳ trước chuyển sang", "Cọc phát sinh thêm trong kỳ", "Cọc đã sử dụng trong kỳ", "Cuối kỳ còn lại chưa sử dụng"]}>
                {cashSource.deposits.length === 0 && (
                  <tr className="border-t border-slate-100"><Cell>Chưa có phiếu cọc nào.</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell right>-</Cell></tr>
                )}
                {cashSource.deposits.map((row) => (
                  <tr key={row.code} className="border-t border-slate-100 hover:bg-slate-50">
                    <Cell><b>{cashSourceLabel(row.name)}</b><p className="text-xs text-slate-500 mt-0.5">{row.code}</p></Cell>
                    <Cell>{row.opening ? `${money(row.opening)} đ` : "-"}</Cell>
                    <Cell>{row.increase ? `${money(row.increase)} đ` : "-"}</Cell>
                    <Cell>{row.used ? `${money(row.used)} đ` : "-"}</Cell>
                    <Cell right><b className={row.closing < 0 ? "text-rose-600" : "text-slate-900"}>{row.closing ? `${money(row.closing)} đ` : "-"}</b></Cell>
                  </tr>
                ))}
                <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                  <Cell><b>CỘNG</b></Cell>
                  <Cell><b>{money(cashSource.deposits.reduce((sum, row) => sum + row.opening, 0))} đ</b></Cell>
                  <Cell><b>{money(cashSource.deposits.reduce((sum, row) => sum + row.increase, 0))} đ</b></Cell>
                  <Cell><b>{money(cashSource.deposits.reduce((sum, row) => sum + row.used, 0))} đ</b></Cell>
                  <Cell right><b>{money(cashSource.deposits.reduce((sum, row) => sum + row.closing, 0))} đ</b></Cell>
                </tr>
              </Table>
            </div>
          </section>

          <CashSourceFlowTable cashSource={cashSource} />
        </div>
      )}

      {!tabLoading && settlement && (
        <div className="space-y-5">
          {reconDailyCash && <MoneyInReconciliationPanel dailyCash={reconDailyCash} />}
          <RevenueSettlementPanel data={settlement} />
        </div>
      )}

      {!tabLoading && dailyCash && (
        <div className="space-y-5 report-print-area" id="daily-cash-report">
          <div className="print-only text-center border-b border-slate-300 pb-3">
            <h1 className="text-xl font-bold uppercase">Báo cáo thu chi ngày</h1>
            <p className="mt-1 text-sm text-slate-600">
              {new Date(dailyCash.reportDate).toLocaleDateString("vi-VN")} · {shiftLabels[dailyCash.shift] || dailyCash.shift} · {dailyCash.branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(dailyCash.branchCode)}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 no-print">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Báo cáo thu chi ngày</h2>
              <p className="text-xs text-slate-500 mt-1">
                {new Date(dailyCash.reportDate).toLocaleDateString("vi-VN")} · {shiftLabels[dailyCash.shift] || dailyCash.shift} · {dailyCash.branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(dailyCash.branchCode)}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  className={manualRevenueDisabledReason ? "accent-button no-print button-disabled" : "accent-button no-print"}
                  onClick={openManualRevenueModal}
                  disabled={!!manualRevenueDisabledReason}
                  title={manualRevenueDisabledReason || undefined}
                >
                  <span className="material-symbols-outlined text-lg">edit_note</span>
                  {editableManualEntry ? "Sửa thu tay" : "Nhập thu tay"}
                </button>
                <button
                  type="button"
                  className={cashDepositDisabledReason ? "accent-button no-print button-disabled" : "primary-button no-print"}
                  onClick={openCashDepositModal}
                  disabled={!!cashDepositDisabledReason}
                  title={cashDepositDisabledReason || undefined}
                >
                  <span className="material-symbols-outlined text-lg">savings</span>
                  Nộp tiền
                </button>
                <button type="button" className="secondary-button no-print" onClick={printDailyCashReport}>
                  <span className="material-symbols-outlined text-lg">print</span>
                  In báo cáo
                </button>
              </div>
              {cashDepositDisabledReason && (
                <p className="max-w-sm text-right text-xs font-medium text-slate-500 no-print">{cashDepositDisabledReason}</p>
              )}
            </div>
          </div>

          <div className="grid md:grid-cols-4 gap-4 no-print">
            <Kpi label="Tổng thu" value={dailyCash.summary.total.total} icon="payments" tone="blue" />
            <Kpi label="Tiền mặt thu được" value={dailyCash.summary.total.cash} icon="account_balance_wallet" tone="green" />
            <Kpi label="Chi tiền mặt" value={dailyCash.summary.cashExpenseTotal} icon="receipt_long" tone="amber" />
            <Kpi label="Tiền mặt cần nộp" value={dailyCash.summary.cashToDeposit} icon="savings" tone={dailyCash.summary.cashToDeposit < 0 ? "rose" : "green"} />
          </div>

          {(dailyCash.excludedCashSources?.length || 0) > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <span className="material-symbols-outlined text-lg text-slate-500">info</span>
              <span>
                Báo cáo này chỉ tính <b>tiền mặt của thu ngân</b>. Đã bỏ qua{" "}
                {dailyCash.excludedCashSources.map((row, index) => (
                  <span key={row.code || index}>
                    {index > 0 ? ", " : ""}
                    <b>{row.name || "Quỹ tiền mặt khác"}</b> (thu {money(row.inflow)} đ · chi {money(row.outflow)} đ)
                  </span>
                ))}
                {" "}— xem các quỹ này ở báo cáo Nguồn tiền.
              </span>
            </div>
          )}

          {dailyCash.duplicateRevenueWarning && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="material-symbols-outlined text-lg">warning</span>
              <span>
                Ngày/ca này có <b>cả doanh thu import lẫn doanh thu nhập tay</b>. Hãy kiểm tra để tránh tính trùng — nếu file POS đã lên đủ, xoá dòng nhập tay đi.
              </span>
            </div>
          )}

          <section className="table-panel">
            <PanelHeader title="Tổng hợp thu trong ngày" subtitle="Doanh thu bán hàng gồm số liệu POS (hoặc nhập tay khi chưa có POS) và các phiếu thu tiền mặt chi tiết trong ngày/ca; tiền cọc được theo dõi riêng." />
            <Table headers={["Loại", "Tổng thu", "Tiền mặt", "Chuyển khoản", "Quẹt thẻ/Ví", "Grab", "Khác", "Tổng chi tiền mặt", "Nộp tiền"]}>
              {dailyCashSummaryRows.map((row) => (
                <DailyCashSummaryRow key={row.label} label={row.label} bucket={row.bucket} expense={row.expense} cashToDeposit={row.cashToDeposit} />
              ))}
              <DailyCashSummaryRow
                label="TOTAL"
                bucket={dailyCash.summary.total}
                expense={dailyCashExpenseSum}
                cashToDeposit={dailyCashDepositSum}
                strong
              />
            </Table>
          </section>

          {/* Bảng "Đối chiếu tiền vào đã đủ chưa" và danh sách "Chưa vào sổ" đã chuyển sang
              đầu tab Tiền về đủ chưa (yêu cầu 22/08/2026): đối soát tiền về là việc của kế
              toán, để trên màn kết ca làm thu ngân lăn tăn những con số ngoài phần việc của họ. */}

          {dailyCash.manualEntries.length > 0 && (
            <section className="table-panel no-print">
              <PanelHeader title="Doanh thu nhập tay đã ghi nhận" subtitle="Số thu ngân tự nhập khi kết ca. Xoá dòng này nếu sau đó đã import file doanh thu POS cho cùng ngày." />
              <Table headers={["Ca", "Tiền mặt", "Chuyển khoản", "Quẹt thẻ/Ví", "Grab", "Khác", "Tổng thu", "Người nhập", ""]}>
                {dailyCash.manualEntries.map((entry) => (
                  <tr key={entry.id} className="border-t border-slate-100">
                    <Cell><b>{shiftLabels[entry.shift] || entry.shift}</b>{entry.note && <small className="block text-slate-500">{entry.note}</small>}</Cell>
                    <Cell right>{money(entry.cashAmount)} đ</Cell>
                    <Cell right>{money(entry.transferAmount)} đ</Cell>
                    <Cell right>{money(entry.cardAmount)} đ</Cell>
                    <Cell right>{money(entry.grabAmount)} đ</Cell>
                    <Cell right>{money(entry.otherAmount)} đ</Cell>
                    <Cell right><b>{money(entry.totalAmount)} đ</b></Cell>
                    <Cell>
                      {entry.updatedBy || "-"}
                      <small className="block text-slate-500">{new Date(entry.updatedAt).toLocaleString("vi-VN")}</small>
                    </Cell>
                    <Cell right>
                      {canEnterManualRevenue && (
                        <button
                          type="button"
                          className="action-link text-rose-600 no-print"
                          onClick={() => void deleteManualRevenue(entry)}
                          disabled={manualRevenueSubmitting}
                        >
                          Xoá
                        </button>
                      )}
                    </Cell>
                  </tr>
                ))}
              </Table>
            </section>
          )}

          <section className="table-panel">
            <PanelHeader title="Các khoản thu chi tiết" subtitle="Lấy từ phiếu thu trong ngày/ca. Cột nguồn tiền cho biết khoản nào là tiền mặt, cộng vào số tiền cần nộp." />
            <div className="max-h-[520px] overflow-auto">
              <Table headers={["STT", "Mã phiếu", "Nội dung thu", "Tên khách hàng/đối tượng", "Nguồn tiền", "Trạng thái", "Số tiền"]}>
                {dailyCash.receipts.length === 0 ? (
                  <tr className="border-t border-slate-100">
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-400">Không có phiếu thu trong ngày/ca này.</td>
                  </tr>
                ) : dailyCash.receipts.map((row, index) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell>{index + 1}</Cell>
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small className="block text-slate-500">{new Date(row.date).toLocaleDateString("vi-VN")}{row.shift ? ` · ${shiftLabel(row.shift)}` : ""}</small></Cell>
                    <Cell>{row.description}</Cell>
                    <Cell>{row.partnerName || "-"}</Cell>
                    <Cell>
                      <span className={`status ${row.isCash ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>
                        {row.moneySourceName} · {row.moneySourceGroup || "-"}
                      </span>
                    </Cell>
                    <Cell>
                      <span className={`status ${row.status === "APPROVED" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                        {row.status === "APPROVED" ? "Đã duyệt" : row.status === "DRAFT" ? "Bản nháp" : row.status}
                      </span>
                    </Cell>
                    <Cell right><b>{money(row.amount)} đ</b></Cell>
                  </tr>
                ))}
                {dailyCash.receipts.length > 0 && (
                  <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                    <Cell> </Cell>
                    <Cell> </Cell>
                    <Cell>CỘNG</Cell>
                    <Cell> </Cell>
                    <Cell>Tiền mặt: {money(dailyCash.summary.receipt.cash)} đ</Cell>
                    <Cell> </Cell>
                    <Cell right>{money(dailyCash.summary.receipt.total)} đ</Cell>
                  </tr>
                )}
              </Table>
            </div>
          </section>

          <section className="table-panel">
            <PanelHeader title="Các khoản chi/tiền ra chi tiết" subtitle="Lấy từ phiếu chi và khoản hoàn cọc trong ngày/ca. Hoàn cọc là tiền ra để tính số tiền cần nộp nhưng không phải chi phí P&L." />
            <div className="max-h-[520px] overflow-auto">
              <Table headers={["STT", "Mã phiếu", "Khoản chi chi tiết", "Tên nhà cung cấp/đối tượng", "Nguồn tiền", "Số tiền"]}>
                {dailyCash.expenses.length === 0 ? (
                  <tr className="border-t border-slate-100">
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">Không có phiếu chi hoặc khoản hoàn cọc trong ngày/ca này.</td>
                  </tr>
                ) : dailyCash.expenses.map((expense, index) => (
                  <tr key={expense.id} className="border-t border-slate-100">
                    <Cell>{index + 1}</Cell>
                    <Cell><CopyableText value={expense.code}><b>{expense.code}</b></CopyableText><small className="block text-slate-500">{new Date(expense.date).toLocaleDateString("vi-VN")}{expense.shift ? ` · ${shiftLabel(expense.shift)}` : ""}</small></Cell>
                    <Cell>{expense.description}</Cell>
                    <Cell>{expense.partnerName || "-"}</Cell>
                    <Cell>
                      <span className={`status ${expense.isCash ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-700"}`}>
                        {expense.moneySourceName} · {expense.moneySourceGroup || "-"}
                      </span>
                    </Cell>
                    <Cell right><b>{money(expense.amount)} đ</b></Cell>
                  </tr>
                ))}
                {dailyCash.expenses.length > 0 && (
                  <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                    <Cell> </Cell>
                    <Cell> </Cell>
                    <Cell>CỘNG</Cell>
                    <Cell> </Cell>
                    <Cell>Tiền mặt: {money(dailyCash.summary.cashExpenseTotal)} đ</Cell>
                    <Cell right>{money(dailyCash.summary.expenseTotal)} đ</Cell>
                  </tr>
                )}
              </Table>
            </div>
          </section>

          <section className="grid grid-cols-2 gap-8 bg-white border border-slate-200 rounded-lg p-6 text-center text-sm font-bold text-slate-700">
            <div className="pt-8 border-t border-dashed border-slate-300">Thu ngân</div>
            <div className="pt-8 border-t border-dashed border-slate-300">Quản lý</div>
          </section>

          <section className="daily-cash-print-space print-only" aria-hidden="true" />
        </div>
      )}

      {manualRevenueOpen && dailyCash && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4 no-print">
          <form onSubmit={submitManualRevenue} className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-blue-600">
                  {editableManualEntry ? "Sửa doanh thu nhập tay" : "Nhập doanh thu kết ca"}
                </p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">{money(manualRevenueTotal)} đ</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {new Date(dailyCash.reportDate).toLocaleDateString("vi-VN")} · {shiftLabels[dailyCash.shift] || dailyCash.shift} · {storeLabel(dailyCash.branchCode)}
                </p>
              </div>
              <button type="button" className="icon-button" onClick={() => setManualRevenueOpen(false)} title="Đóng">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto p-5">
              <p className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                Ngày, ca và cửa hàng lấy theo bộ lọc đang chọn ở trên. Muốn ghi cho ngày/ca khác thì đóng lại và đổi bộ lọc trước.
              </p>

              <div className="grid gap-3 sm:grid-cols-2">
                {manualRevenueFields.map((field) => (
                  <Field key={field.key} label={field.label}>
                    <input
                      className={field.locked ? "control text-right cursor-not-allowed bg-slate-100 text-slate-400" : "control text-right"}
                      inputMode="numeric"
                      placeholder="0"
                      disabled={field.locked}
                      title={field.locked ? field.hint : undefined}
                      value={manualRevenueForm[field.key] ? money(toAmountNumber(manualRevenueForm[field.key])) : ""}
                      onChange={(event) => setManualRevenueForm((current) => ({ ...current, [field.key]: digitsOnly(event.target.value) }))}
                    />
                    <span className={`mt-1 block text-[11px] ${field.locked ? "text-slate-400" : "text-slate-500"}`}>{field.hint}</span>
                  </Field>
                ))}
                <Field label="Ghi chú">
                  <input
                    className="control"
                    placeholder="VD: máy POS lỗi, đối soát sau"
                    value={manualRevenueForm.note}
                    onChange={(event) => setManualRevenueForm((current) => ({ ...current, note: event.target.value }))}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <span className="text-sm font-bold text-slate-700">Tổng thu ca này</span>
                <span className="text-lg font-bold text-slate-900">{money(manualRevenueTotal)} đ</span>
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 p-5">
              <button type="button" className="secondary-button" onClick={() => setManualRevenueOpen(false)}>Huỷ bỏ</button>
              <button type="submit" className="primary-button" disabled={manualRevenueSubmitting || manualRevenueTotal <= 0}>
                {manualRevenueSubmitting ? "Đang lưu..." : "Lưu doanh thu"}
              </button>
            </div>
          </form>
        </div>
      )}

      {cashDepositOpen && dailyCash && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4 no-print">
          <form onSubmit={submitCashDeposit} className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 p-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-blue-600">Nộp tiền trong ngày</p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">{money(cashDepositRoundedAmount)} đ</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {new Date(dailyCash.reportDate).toLocaleDateString("vi-VN")} · {shiftLabels[dailyCash.shift] || dailyCash.shift} · {storeLabel(dailyCash.branchCode)}
                </p>
              </div>
              <button type="button" className="icon-button" onClick={() => setCashDepositOpen(false)} title="Đóng">
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>

            <div className="grid gap-5 overflow-y-auto p-5 lg:grid-cols-[0.85fr_1.35fr]">
              <div className="space-y-4">
                <Field label="Loại nộp tiền">
                  <select
                    className="control"
                    value={cashDepositForm.depositTargetType}
                    onChange={(event) => {
                      const nextTarget = event.target.value === "CO" ? "CO" : "PKT";
                      setCashDepositForm((current) => ({
                        ...current,
                        depositTargetType: nextTarget,
                        toMoneySourceCode: pickCashDepositTarget(nextTarget, current.fromMoneySourceCode, dailyCash.branchCode),
                      }));
                    }}
                  >
                    <option value="PKT">{cashDepositTargetLabels.PKT}</option>
                    <option value="CO">{cashDepositTargetLabels.CO}</option>
                  </select>
                </Field>

                <Field label="Nguồn tiền mặt đi">
                  <select
                    className="control"
                    value={cashDepositForm.fromMoneySourceCode}
                    onChange={(event) => {
                      const nextFrom = event.target.value;
                      setCashDepositForm((current) => ({
                        ...current,
                        fromMoneySourceCode: nextFrom,
                        toMoneySourceCode: current.toMoneySourceCode === nextFrom
                          ? pickCashDepositTarget(current.depositTargetType, nextFrom, dailyCash.branchCode)
                          : current.toMoneySourceCode,
                        // Đổi quỹ là đổi số phải nộp, nên bảng kê mệnh giá cũ không còn đúng nữa.
                        denominations: cashDepositDenominations.map((denomination) => ({ denomination, quantity: "" })),
                      }));
                    }}
                  >
                    {cashDepositCashSources.map((source) => {
                      const pending = cashToDepositSources.find((row) => row.code === source.code)?.amount || 0;
                      return (
                        <option key={source.code} value={source.code} title={moneySourceDebugLabel(source, storeLabel(dailyCash.branchCode))}>
                          {moneySourceDisplayName(source, storeLabel(dailyCash.branchCode))}
                          {cashToDepositSources.length > 0 ? ` · cần nộp ${money(pending)} đ` : ""}
                          {cashDepositedSourceCodes.has(source.code) ? " · đã có phiếu" : ""}
                        </option>
                      );
                    })}
                  </select>
                </Field>

                <Field label="Nguồn tiền nhận">
                  <select className="control" value={cashDepositForm.toMoneySourceCode} onChange={(event) => setCashDepositForm((current) => ({ ...current, toMoneySourceCode: event.target.value }))}>
                    {cashDepositTargetSources.map((source) => (
                      <option key={source.code} value={source.code} title={moneySourceDebugLabel(source, storeLabel(dailyCash.branchCode))}>
                        {moneySourceDisplayName(source, storeLabel(dailyCash.branchCode))}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">Chỉ liệt kê quỹ tiền mặt: nộp tiền là đổi người giữ tiền mặt. Nộp tiền mặt vào ngân hàng thì dùng phiếu Điều tiền nội bộ.</p>
                </Field>

                {cashToDepositSources.length > 1 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
                    <p className="font-bold text-amber-900">Ngày/ca này có {cashToDepositSources.length} quỹ tiền mặt</p>
                    <p className="mt-1 text-xs text-amber-800">Mỗi quỹ nộp một phiếu riêng. Tạo xong phiếu này thì mở lại để nộp tiếp quỹ còn lại.</p>
                    <ul className="mt-2 space-y-1 text-xs">
                      {cashToDepositSources.map((row) => (
                        <li key={row.code || "UNASSIGNED"} className="flex items-center justify-between gap-3">
                          <span className={row.code === cashDepositForm.fromMoneySourceCode ? "font-bold text-amber-900" : "text-amber-800"}>
                            {row.name}
                            {cashDepositedSourceCodes.has(row.code) ? " · đã có phiếu" : ""}
                          </span>
                          <b className="shrink-0 text-amber-900">{money(row.amount)} đ</b>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 border-t border-amber-200 pt-2 text-xs text-amber-800">
                      Tổng cả ngày/ca: <b>{money(cashDepositTotalAmount)} đ</b>
                    </p>
                    {cashDepositUnassignedAmount !== 0 && cashDepositIdentifiedTotal > 0 && (
                      <p className="mt-2 text-xs font-semibold text-rose-700">
                        Còn {money(cashDepositUnassignedAmount)} đ chưa biết thuộc quỹ nào nên không nộp được. Khai nguồn tiền cho phương thức thanh toán đó trong Cấu hình danh mục rồi tải lại báo cáo.
                      </p>
                    )}
                  </div>
                )}

                <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm">
                  <p className="font-bold text-blue-900">Trạng thái sau khi tạo</p>
                  <p className="mt-1 text-xs text-blue-700">Hệ thống sinh phiếu điều chuyển trạng thái chờ duyệt. Khi Admin/Kế toán duyệt, sổ quỹ mới ghi giảm tiền mặt và ghi tăng nguồn nhận.</p>
                </div>
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="grid gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Bảng kê mệnh giá</h3>
                    <p className="text-xs text-slate-500">Nhập số tờ, hệ thống tự tính thành tiền.</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-right text-xs sm:min-w-64">
                    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                      <p className="font-semibold text-slate-500">Thực nộp</p>
                      <p className="mt-1 font-bold text-slate-900">{money(cashDepositRoundedAmount)} đ</p>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                      <p className="font-semibold text-slate-500">Đã kê</p>
                      <p className={`mt-1 font-bold ${cashDepositDenominationTotal === cashDepositRoundedAmount ? "text-emerald-700" : "text-rose-600"}`}>
                        {money(cashDepositDenominationTotal)} đ
                      </p>
                    </div>
                  </div>
                </div>
                <div className="max-h-[440px] overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-white text-xs uppercase text-slate-500 shadow-[inset_0_-1px_0_#e2e8f0]">
                      <tr>
                        <th className="px-4 py-3">Mệnh giá</th>
                        <th className="px-4 py-3">Số tờ</th>
                        <th className="px-4 py-3 text-right">Thành tiền</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {cashDepositForm.denominations.map((row) => {
                        const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
                        return (
                          <tr key={row.denomination}>
                            <td className="px-4 py-2.5 font-bold">{money(row.denomination)} đ</td>
                            <td className="px-4 py-2.5">
                              <input
                                className="control mt-0 h-9 w-28 py-1.5 text-right"
                                inputMode="numeric"
                                placeholder="0"
                                value={row.quantity}
                                onChange={(event) => updateCashDepositDenomination(row.denomination, event.target.value)}
                              />
                            </td>
                            <td className="px-4 py-2.5 text-right font-bold">{money(row.denomination * quantity)} đ</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {cashDepositRoundingDifference !== 0 && (
                  <p className={`border-t px-4 py-3 text-xs font-medium ${cashDepositRoundingDifference > 0 ? "border-amber-100 bg-amber-50 text-amber-800" : "border-emerald-100 bg-emerald-50 text-emerald-800"}`}>
                    Tiền mặt cần clear là <b>{money(cashDepositAmount)} đ</b>, số thực nộp theo mệnh giá là <b>{money(cashDepositRoundedAmount)} đ</b>.
                    Chi phí làm tròn là <b>{money(cashDepositRoundingDifference)} đ</b>; nguồn tiền mặt được giảm đúng <b>{money(cashDepositAmount)} đ</b>.
                  </p>
                )}
                {cashDepositAmount <= 0 ? (
                  <p className="border-t border-rose-100 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">
                    Quỹ đang chọn không còn tiền mặt cần nộp trong ngày/ca này. Chọn quỹ khác trong ô &quot;Nguồn tiền mặt đi&quot;.
                  </p>
                ) : cashDepositDenominationTotal !== cashDepositRoundedAmount && (
                  <p className="border-t border-rose-100 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">
                    Tổng bảng kê phải bằng {money(cashDepositRoundedAmount)} đ.
                  </p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4">
              <button type="button" className="secondary-button" onClick={() => setCashDepositOpen(false)}>Hủy</button>
              <button
                className="primary-button"
                disabled={cashDepositSubmitting || cashDepositAmount <= 0 || cashDepositDenominationTotal !== cashDepositRoundedAmount || !cashDepositForm.fromMoneySourceCode || !cashDepositForm.toMoneySourceCode}
              >
                <span className="material-symbols-outlined text-lg">send</span>
                {cashDepositSubmitting ? "Đang tạo..." : "Tạo phiếu chờ duyệt"}
              </button>
            </div>
          </form>
        </div>
      )}

      {!tabLoading && activity && (
        <div className="space-y-5">
          <section className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Kỳ kế toán {period}</span>
                <h2 className="text-lg font-bold text-slate-900 mt-1">
                  Trạng thái: <span className={activity.accountingPeriod.status === "CLOSED" ? "text-rose-600" : "text-emerald-600"}>{activity.accountingPeriod.status === "CLOSED" ? "Đã khóa sổ" : "Đang mở"}</span>
                </h2>
                <p className="text-xs text-slate-500 mt-1">Khóa kỳ giúp bảo vệ sổ cái không bị ghi đè hay chèn thêm chứng từ quá hạn.</p>
              </div>

              {canAdminPeriod && (
                <div className="flex items-center gap-3">
                  {activity.accountingPeriod.status === "OPEN" ? (
                    <button type="button" className="danger-button" onClick={() => void updatePeriodStatus("CLOSE_PERIOD")}>
                      <span className="material-symbols-outlined text-lg">lock</span>Khóa sổ kỳ này
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input type="text" className="control w-64 text-xs" placeholder="Lý do mở lại..." value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
                      <button type="button" className="secondary-button" onClick={() => void updatePeriodStatus("REOPEN_PERIOD")}>
                        <span className="material-symbols-outlined text-lg">lock_open</span>Mở lại kỳ
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className="table-panel">
            <PanelHeader title="Nhật ký thao tác hệ thống" subtitle="Truy vết toàn bộ hoạt động tạo chứng từ, điều chỉnh, khóa sổ và import dữ liệu." />
            <div className="max-h-[500px] overflow-auto">
              <Table headers={["Thời gian", "Tài khoản", "Phần hành", "Hành động", "Mã", "Ghi chú/Thông số"]}>
                {activity.logs.map((log) => (
                  <tr key={log.id} className="border-t border-slate-100 text-xs">
                    <Cell>{new Date(log.time).toLocaleString("vi-VN")}</Cell>
                    <Cell><b>{log.actor}</b></Cell>
                    <Cell><span className="font-semibold text-slate-600">{log.module}</span></Cell>
                    <Cell><span className="status bg-blue-50 text-blue-700 font-bold">{log.action}</span></Cell>
                    <Cell><CopyableText value={log.code}><b>{log.code}</b></CopyableText></Cell>
                    <Cell>{log.note}</Cell>
                  </tr>
                ))}
              </Table>
            </div>
          </section>
        </div>
      )}

      {!tabLoading && dashboard && (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Kpi label="Doanh thu" value={dashboard.pnl?.total?.revenue || 0} icon="payments" />
            <Kpi label="Lợi nhuận gộp" value={dashboard.pnl?.total?.grossProfit || 0} icon="trending_up" tone="green" />
            <Kpi label="EBITDA" value={dashboard.pnl?.total?.ebitda || 0} icon="monitoring" tone="blue" />
            <Kpi label="Tiền hiện có" value={dashboard.balance?.rows?.filter((row) => row.reportGroup === "CASH")?.reduce((sum, row) => sum + row.amount, 0) || 0} icon="account_balance_wallet" tone="amber" />
          </div>
          <div className="grid xl:grid-cols-[1.4fr_1fr] gap-5">
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="font-bold">Xu hướng 6 tháng</h2>
              <p className="text-xs text-slate-500 mt-1">Doanh thu và EBITDA từ dữ liệu đã ghi sổ.</p>
              <div className="mt-6 space-y-4">
                {(dashboard.trend || []).map((row) => {
                  const max = Math.max(...(dashboard.trend || []).map((item) => Math.abs(item.revenue)), 1);
                  return (
                    <div key={row.period} className="grid grid-cols-[70px_1fr_120px] gap-3 items-center text-sm">
                      <b>{row.period}</b>
                      <div className="h-6 bg-slate-100 rounded overflow-hidden"><div className="h-full bg-blue-600" style={{ width: `${Math.max(2, Math.abs(row.revenue) / max * 100)}%` }} /></div>
                      <span className="text-right font-bold">{money(row.revenue)} đ</span>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="font-bold">Hiệu quả theo cửa hàng</h2>
              <div className="mt-4 divide-y divide-slate-100">
                {(!dashboard.pnl?.byBranch || dashboard.pnl.byBranch.length === 0) ? <p className="py-8 text-center text-sm text-slate-400">Chưa có dữ liệu ghi sổ.</p> : dashboard.pnl.byBranch.map((row) => (
                  <div key={row.code} className="py-3 flex justify-between gap-3">
                    <div><b>{storeLabel(row.code)}</b><p className="text-xs text-slate-500 mt-1">Biên gộp {(row.grossMargin * 100).toFixed(1)}%</p></div>
                    <div className="text-right"><b>{money(row.revenue)} đ</b><p className={`text-xs mt-1 ${row.ebitda >= 0 ? "text-emerald-600" : "text-rose-600"}`}>EBITDA {money(row.ebitda)} đ</p></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {!tabLoading && pnl && (
        <div className="space-y-5">
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <PanelHeader title="Báo cáo Kết quả Kinh doanh" subtitle="Đơn vị: VND" />
            <PnlTable value={pnl.total} />
          </section>
          <PnlItemTable rows={pnl.byPnlItem} />
          <div className="grid xl:grid-cols-2 gap-5">
            <CutTable title="Theo cửa hàng" rows={pnl.byBranch} />
            <CutTable title="Theo phòng ban" rows={pnl.byDepartment} />
          </div>
        </div>
      )}

      {!tabLoading && yoy && (
        <section className="table-panel">
          <PanelHeader title={`So sánh ${period} với ${yoy.previousPeriod}`} subtitle="Chỉ hiển thị tỷ lệ khi kỳ trước có dữ liệu." />
          <Table headers={["Chỉ tiêu", period, yoy.previousPeriod, "Chênh lệch", "Tỷ lệ"]}>
            {(yoy.rows || []).map((row) => (
              <tr key={row.metric} className="border-t border-slate-100">
                <Cell><b>{metricLabels[row.metric] || row.metric}</b></Cell>
                <Cell right>{money(row.currentValue)} đ</Cell>
                <Cell right>{money(row.previousValue)} đ</Cell>
                <Cell right><span className={`font-bold ${row.variance >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{row.variance > 0 ? "+" : ""}{money(row.variance)} đ</span></Cell>
                <Cell right>{row.varianceRate !== null ? `${(row.varianceRate * 100).toFixed(1)}%` : "-"}</Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {!tabLoading && cashflow && (
        <div className="grid xl:grid-cols-[360px_1fr] gap-5">
          {canConfigure && (
            <form onSubmit={saveForecast} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit">
              <h2 className="font-bold">Giả định dòng tiền</h2>
              <Field label="Kỳ dự kiến">
                <MonthInput className="mt-1.5 w-full" value={forecast.period} onChange={(period) => setForecast({ ...forecast, period })} ariaLabel="Kỳ dự kiến" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cửa hàng">
                  <select className="control" value={forecast.branchCode} onChange={(event) => setForecast({ ...forecast, branchCode: event.target.value })}>
                    {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </Field>
                <Field label="Kịch bản">
                  <select className="control" value={forecast.scenario} onChange={(event) => setForecast({ ...forecast, scenario: event.target.value })}>
                    <option value="BASE">Cơ sở</option>
                    <option value="UPSIDE">Tích cực</option>
                    <option value="DOWNSIDE">Thận trọng</option>
                  </select>
                </Field>
              </div>
              <Field label="Loại">
                <select className="control" value={forecast.assumptionType} onChange={(event) => setForecast({ ...forecast, assumptionType: event.target.value })}>
                  <option value="INFLOW">Dòng tiền vào</option>
                  <option value="OUTFLOW">Dòng tiền ra</option>
                </select>
              </Field>
              <Field label="Số tiền">
                <input type="number" className="control" value={forecast.amount} onChange={(event) => setForecast({ ...forecast, amount: event.target.value })} />
              </Field>
              <Field label="Ghi chú">
                <textarea className="control h-20 resize-none" value={forecast.note} onChange={(event) => setForecast({ ...forecast, note: event.target.value })} />
              </Field>
              <button className="primary-button w-full">Lưu giả định</button>
            </form>
          )}
          <section className="table-panel">
            <PanelHeader title={`Dự báo 3 tháng - ${cashflow.scenario}`} subtitle={`Số dư bắt đầu: ${money(cashflow.startingCash)} đ`} />
            <Table headers={["Kỳ", "Dòng tiền vào", "Dòng tiền ra", "Số dư dự kiến", "Cảnh báo"]}>
              {(cashflow.schedule || []).map((row) => (
                <tr key={row.period} className="border-t border-slate-100">
                  <Cell><b>{row.period}</b></Cell>
                  <Cell right>{money(row.inflow)} đ</Cell>
                  <Cell right>{money(row.outflow)} đ</Cell>
                  <Cell right><b>{money(row.closingCash)} đ</b></Cell>
                  <Cell center><span className={`status ${row.risk ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{row.risk ? "Cảnh báo âm" : "An toàn"}</span></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {!tabLoading && balance && (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Kpi label="Tổng tài sản" value={balance.assets} icon="account_balance" tone="blue" />
            <Kpi label="Nợ phải trả" value={balance.liabilities} icon="credit_card" tone="rose" />
            <Kpi label="Vốn chủ sở hữu" value={balance.equity} icon="account_balance_wallet" tone="green" />
            <Kpi label="Cân đối (Khớp)" value={balance.difference} icon={balance.balanced ? "check_circle" : "warning"} tone={balance.balanced ? "green" : "rose"} />
          </div>
          <section className="table-panel">
            <PanelHeader title="Bảng Cân đối Kế toán" subtitle="Cơ cấu tài sản và nguồn vốn từ dữ liệu ghi sổ." />
            <Table headers={["Mã chỉ tiêu", "Tên chỉ tiêu", "Nhóm báo cáo", "Số tiền"]}>
              {(balance.rows || []).map((row) => (
                <tr key={row.code} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText></Cell>
                  <Cell>{row.name}</Cell>
                  <Cell><span className="status bg-slate-100 text-slate-700">{row.reportGroup}</span></Cell>
                  <Cell right><b>{money(row.amount)} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}
    </ModuleFrame>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-bold text-slate-600">
      {label}
      {children}
    </label>
  );
}

/**
 * Hai cột cuối chỉ hiện ở dòng được truyền giá trị: dòng doanh thu có tổng chi
 * tiền mặt và số nộp (tiền mặt - tổng chi), dòng TOTAL là tổng của hai cột đó.
 * Dòng không nhận giá trị thì để dấu "-".
 */
function DailyCashSummaryRow({ label, bucket, expense, cashToDeposit, strong = false }: { label: string; bucket: DailyCashBucket; expense?: number; cashToDeposit?: number; strong?: boolean }) {
  const contentClass = strong ? "font-bold text-slate-900 bg-slate-50" : "";
  return (
    <tr className={`border-t border-slate-100 ${contentClass}`}>
      <Cell><b>{label}</b></Cell>
      <Cell right>{money(bucket.total)} đ</Cell>
      <Cell right>{money(bucket.cash)} đ</Cell>
      <Cell right>{money(bucket.transfer)} đ</Cell>
      <Cell right>{money(bucket.card)} đ</Cell>
      <Cell right>{money(bucket.grab)} đ</Cell>
      <Cell right>{money(bucket.other)} đ</Cell>
      <Cell right>{expense === undefined ? "-" : `${money(expense)} đ`}</Cell>
      <Cell right>
        {cashToDeposit === undefined
          ? "-"
          : <b className={cashToDeposit < 0 ? "text-rose-600" : "text-emerald-700"}>{money(cashToDeposit)} đ</b>}
      </Cell>
    </tr>
  );
}

function Kpi({ label, value, icon, tone = "default" }: { label: string; value: number; icon: string; tone?: "default" | "green" | "blue" | "rose" | "amber" }) {
  const toneClasses = {
    default: "text-slate-800",
    green: "text-emerald-600",
    blue: "text-blue-600",
    rose: "text-rose-600",
    amber: "text-amber-600",
  }[tone];

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between text-slate-400">
        <span className="text-xs font-semibold text-slate-500">{label}</span>
        <span className="material-symbols-outlined text-xl">{icon}</span>
      </div>
      <p className={`text-xl font-bold mt-2 ${toneClasses}`}>{money(value)} đ</p>
    </div>
  );
}

function OpsKpi({ label, count, amount, extra, icon }: { label: string; count: number; amount?: number; extra?: string; icon: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between text-slate-400">
        <span className="text-xs font-semibold text-slate-500">{label}</span>
        <span className="material-symbols-outlined text-xl">{icon}</span>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <p className="text-xl font-bold text-slate-800">{count}</p>
        {amount !== undefined && <span className="text-xs font-bold text-blue-600">{money(amount)} đ</span>}
        {extra && <span className="text-xs font-bold text-rose-600">{extra}</span>}
      </div>
    </div>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="p-4 border-b border-slate-200">
      <h2 className="font-bold">{title}</h2>
      <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold border-b border-slate-200">
        <tr>
          {headers.map((h, i) => (
            <th key={h} className={`px-4 py-3 ${i === headers.length - 1 ? "text-right" : i === 0 ? "text-left" : "text-left"}`}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Cell({ children, right, center }: { children: React.ReactNode; right?: boolean; center?: boolean }) {
  return <td className={`px-4 py-3 ${right ? "text-right" : center ? "text-center" : "text-left"}`}>{children}</td>;
}

function partnerTypeLabel(partnerType: string | null) {
  const value = (partnerType || "").toUpperCase();
  if (value === "SUPPLIER") return "NCC";
  if (value === "BOTH") return "NCC & Khách";
  if (value === "CUSTOMER") return "Khách hàng";
  if (value === "EMPLOYEE") return "Nhân viên";
  if (value === "OTHER_PARTNER") return "Đối tác khác";
  return "-";
}

/** Bảng thu (hoặc chi) theo khoản mục kèm thanh tỷ trọng, dùng chung cho hai cột. */
/**
 * Biến động nguồn tiền, kèm hai cột dự kiến theo yêu cầu của khách.
 *
 * Dự thu/dự chi là tiền chưa thực sự vào/ra nên KHÔNG cộng vào Cuối kỳ; chúng dựng thêm
 * cột "Dự kiến cuối kỳ" để nhìn trước dòng tiền. Dòng TỔNG ở cuối để đối chiếu nhanh với
 * dòng total của hai bảng Tổng quan thu/chi phía trên.
 */
/**
 * Nhóm nguồn tiền của dòng đối soát. Hiện đúng mã CASH/BANK/WALLET như màn Thu chi ngày,
 * vì hai bảng cùng lọc theo loại thu THU_BAN_HANG — đọc song song mới đối chiếu được.
 */
function SourceGroupTag({ group }: { group: string }) {
  const style = {
    CASH: { label: "Tiền mặt", className: "bg-emerald-50 text-emerald-700" },
    BANK: { label: "Ngân hàng", className: "bg-sky-50 text-sky-700" },
    WALLET: { label: "Ví / POS", className: "bg-violet-50 text-violet-700" },
  }[group];
  return (
    <>
      <span className={`rounded-full px-2 py-1 text-xs font-bold ${style?.className || "bg-slate-100 text-slate-600"}`}>
        {group || "—"}
      </span>
      {style && <p className="mt-0.5 text-xs text-slate-500">{style.label}</p>}
    </>
  );
}

/**
 * Đối chiếu doanh thu với tiền thực về, theo từng Ngày và từng Nguồn tiền.
 *
 * Dựng đúng bảng khách đang theo dõi tay: doanh thu trong ngày, tiền đã vô, còn lại, và phần
 * chênh thuộc chi phí nào. Hai vế lấy từ hai luồng độc lập nên bên nào chưa có dữ liệu thì
 * hiện đúng là chưa có.
 */
const settlementGroupNames: Record<string, string> = { CASH: "Tiền mặt", BANK: "Ngân hàng", WALLET: "Ví / POS" };

/**
 * Gộp các dòng chi tiết của một ngày về Nhóm/Loại nguồn tiền. Import khai chi tiết từng nguồn,
 * nhưng muốn biết "thu đủ tiền chưa" thì phải so ở mức nhóm: ngân hàng hay trả gộp nhiều nguồn
 * trong một lần chuyển, so từng nguồn chi tiết sẽ thấy Chưa về / Về dư giả trong khi cộng cả
 * nhóm lại thì tiền không thiếu đồng nào.
 */
function settlementGroupSubtotals(rows: RevenueSettlementRow[]) {
  const byGroup = new Map<string, { group: string; count: number; revenue: number; received: number }>();
  for (const row of rows) {
    const key = row.group || "OTHER";
    const current = byGroup.get(key) || { group: key, count: 0, revenue: 0, received: 0 };
    current.count += 1;
    current.revenue += row.revenue;
    current.received += row.received;
    byGroup.set(key, current);
  }
  // Nhóm chỉ có một dòng thì dòng cộng lặp lại y hệt dòng chi tiết — bỏ cho đỡ nhiễu.
  return [...byGroup.values()]
    .filter((row) => row.count > 1)
    .map((row) => {
      const remaining = Math.round(row.revenue - row.received);
      const status = Math.abs(remaining) < 1000
        ? ("MATCHED" as const)
        : remaining < 0
          ? ("OVER" as const)
          : row.received === 0
            ? ("WAITING" as const)
            : ("FEE" as const);
      return { ...row, remaining, status };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

/**
 * Bảng "Đối chiếu tiền vào đã đủ chưa" + danh sách "Chưa vào sổ" kèm theo.
 *
 * Nằm ở đầu tab Tiền về đủ chưa (chuyển từ tab Thu chi ngày theo yêu cầu 22/08/2026):
 * đối soát tiền về là việc của kế toán; thu ngân kết ca không cần lăn tăn các con số này.
 * Dữ liệu vẫn lấy từ báo cáo thu chi ngày nên cần chọn Ngày + Ca ở thanh lọc phía trên.
 */
function MoneyInReconciliationPanel({ dailyCash }: { dailyCash: DailyCashData }) {
  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-600">
        Đối chiếu ngày {new Date(dailyCash.reportDate).toLocaleDateString("vi-VN")} · {shiftLabels[dailyCash.shift] || dailyCash.shift} · {dailyCash.branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(dailyCash.branchCode)} — đổi ngày/ca ở thanh lọc phía trên.
      </p>
      <section className="table-panel no-print">
        <PanelHeader
          title="Đối chiếu tiền vào đã đủ chưa"
          subtitle="Tiền mặt lấy tổng phiếu thu chi tiết phía dưới; Chuyển khoản và Ví lấy theo SUMIFS sao kê đúng Ngày doanh thu, Loại thu và Trừ nguồn tiền. Grab vẫn thuộc Ví; chênh lệch gross/net được tách vào chi phí trong kỳ."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[52%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
              <col className="w-[12%]" />
            </colgroup>
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-bold uppercase text-slate-500">
              <tr>
                <th className="px-4 py-3 text-left">Hình thức</th>
                {["Thu ngân khai", "Đã về", "Chênh lệch", "Trạng thái"].map((header) => (
                  <th key={header} className="whitespace-nowrap px-4 py-3 text-right">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
            {dailyCash.moneyInReconciliation.rows.map((row) => (
              <tr key={row.key} className="border-t border-slate-100">
                <td className="px-4 py-4 align-middle text-left">
                  <b>{row.label}</b>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">{row.note}</p>
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-right align-middle tabular-nums">{money(row.declared)} đ</td>
                <td className="whitespace-nowrap px-4 py-4 text-right align-middle tabular-nums">{money(row.received)} đ</td>
                <td className="whitespace-nowrap px-4 py-4 text-right align-middle tabular-nums">
                  <b className={row.status === "MATCHED" ? "text-slate-500" : row.status === "SHORT" ? "text-rose-600" : row.status === "OVER" ? "text-blue-600" : "text-amber-600"}>
                    {row.difference > 0 ? "+" : ""}{money(row.difference)} đ
                  </b>
                </td>
                <td className="whitespace-nowrap px-4 py-4 text-right align-middle">
                  <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${
                    row.status === "MATCHED"
                      ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                      : row.status === "PENDING_CLEAR"
                        ? "border border-violet-200 bg-violet-50 text-violet-700"
                        : row.status === "SHORT"
                          ? "border border-rose-200 bg-rose-50 text-rose-700"
                          : "border border-blue-200 bg-blue-50 text-blue-700"
                  }`}>
                    {/* Chỉ ví mới bị trừ phí thu hộ. Tiền mặt và chuyển khoản thiếu là thiếu thật. */}
                    {row.status === "MATCHED" ? "Đủ" : row.status === "PENDING_CLEAR" ? "Ví chưa về" : row.status === "SHORT" ? (row.key === "card" ? "Chênh phí" : "Thiếu") : "Thừa"}
                  </span>
                </td>
              </tr>
            ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
          <span>Chi phí bán hàng Grab: <b className="text-slate-900">{money(dailyCash.moneyInReconciliation.walletGrabExpense)} đ</b></span>
          <span>Phí cà thẻ: <b className="text-slate-900">{money(dailyCash.moneyInReconciliation.walletCardFee)} đ</b></span>
          <span>Tổng phí Ví trong kỳ: <b className="text-slate-900">{money(dailyCash.moneyInReconciliation.walletFee)} đ</b></span>
          <span>Dòng sao kê ghi có trong ngày: <b className="text-slate-900">{dailyCash.moneyInReconciliation.bankRowCount}</b></span>
          {/* Thay cho cột "Chưa đối soát" đã bỏ: số này nói thẳng phải đi xin file POS ngày nào. */}
          {(dailyCash.moneyInReconciliation.walletMissingGross || 0) > 0 && (
            <span className="text-amber-700">
              Chưa tính được phí ví: <b>{money(dailyCash.moneyInReconciliation.walletMissingGross || 0)} đ</b> — thiếu doanh thu POS của ngày này
            </span>
          )}
          {dailyCash.moneyInReconciliation.unclassifiedBankRows > 0 && (
            <span className="text-amber-700">
              {dailyCash.moneyInReconciliation.unclassifiedBankRows} dòng sao kê chưa gán loại thu/chi
            </span>
          )}
        </div>
      </section>

      {(dailyCash.moneyInReconciliation.needsFix?.length || 0) > 0 && (
        <section className="table-panel no-print border-amber-300">
          <PanelHeader
            title={`Chưa vào sổ — ${dailyCash.moneyInReconciliation.needsFix?.length} dòng, ${money(dailyCash.moneyInReconciliation.needsFixTotal || 0)} đ`}
            subtitle="Tiền đã ghi nhận trên sao kê nhưng chưa lập được chứng từ, nên chưa vào sổ kế toán. File vẫn import bình thường, không mất dòng nào. Sửa theo cột Cần làm gì rồi import lại đúng dòng đó, hoặc chạy lệnh xử lý lại."
          />
          <Table headers={["Ngày giao dịch", "Mã giao dịch", "Diễn giải", "Số tiền", "Cần làm gì"]}>
            {dailyCash.moneyInReconciliation.needsFix?.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <Cell>
                  {new Date(row.date).toLocaleDateString("vi-VN")}
                  {/* Ví trả tiền của ngày hôm trước, nên phải nói rõ khoản này thuộc doanh thu ngày nào. */}
                  {row.revenueDate && (
                    <small className="block text-slate-500">DT {new Date(row.revenueDate).toLocaleDateString("vi-VN")}</small>
                  )}
                </Cell>
                <Cell><span className="font-mono text-xs">{row.transactionCode}</span></Cell>
                <Cell><span className="line-clamp-2 text-xs text-slate-600">{row.description}</span></Cell>
                <Cell right><b>{money(row.amount)} đ</b></Cell>
                <Cell><span className="text-xs text-amber-800">{row.reason}</span></Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </div>
  );
}

function RevenueSettlementPanel({ data }: { data: RevenueSettlementData }) {
  const dayLabel = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("vi-VN", { timeZone: "UTC" });
  const byDay = new Map<string, RevenueSettlementRow[]>();
  for (const row of data.rows) byDay.set(row.date, [...(byDay.get(row.date) || []), row]);

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Doanh thu trong kỳ" value={data.totals.revenue} icon="point_of_sale" />
        <Kpi label="Tiền đã về" value={data.totals.received} icon="account_balance" tone="green" />
        <Kpi label="Phí thu hộ" value={data.totals.fee} icon="percent" tone="amber" />
        <Kpi label="Chưa về" value={data.totals.waiting} icon="hourglass_top" tone="rose" />
        <Kpi label="Về dư, chưa có doanh thu" value={data.totals.over} icon="priority_high" tone="rose" />
      </section>

      <section className="table-panel">
        <PanelHeader
          title="Tiền về đủ chưa"
          subtitle="Mỗi ngày, mỗi phương thức thanh toán: doanh thu ghi nhận bao nhiêu, tiền thực về bao nhiêu, phần chênh là phí thu hộ hay tiền chưa về. Doanh thu lấy từ import POS, tiền về lấy từ sổ sao kê — hai luồng độc lập. Dòng “Cộng theo Nhóm/Loại” gộp các nguồn chi tiết lại để biết cả nhóm đã thu đủ tiền chưa, kể cả khi ngân hàng trả gộp nhiều nguồn trong một lần chuyển."
        />
        <div className="overflow-x-auto">
          <Table headers={["Ngày", "Phương thức thanh toán", "Loại nguồn", "Doanh thu trong ngày", "Tiền đã vô", "Còn lại", "Tên chi phí", "Trạng thái"]}>
            {data.rows.length === 0 && (
              <tr className="border-t border-slate-100">
                <Cell>Chưa có doanh thu hoặc tiền về trong kỳ.</Cell>
                <Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell right>-</Cell>
              </tr>
            )}
            {[...byDay.entries()].map(([day, rows]) => [
              ...rows.map((row, index) => (
                <tr key={`${row.date}-${row.moneySourceCode}`} className={`border-t border-slate-100 hover:bg-slate-50 ${index === 0 ? "border-t-slate-200" : ""}`}>
                  <Cell>{index === 0 ? <b>{dayLabel(day)}</b> : <span className="text-slate-300">·</span>}</Cell>
                  <Cell><b>{row.moneySourceName}</b><p className="mt-0.5 text-xs text-slate-500">{row.moneySourceCode}</p></Cell>
                  <Cell><SourceGroupTag group={row.group} /></Cell>
                  <Cell right>{money(row.revenue)} đ</Cell>
                  <Cell right><span className="text-emerald-700">{money(row.received)} đ</span></Cell>
                  <Cell right>
                    <b className={row.remaining > 0 ? "text-amber-700" : row.remaining < 0 ? "text-rose-600" : "text-slate-400"}>
                      {money(row.remaining)} đ
                    </b>
                  </Cell>
                  <Cell>{row.feeCategoryName || <span className="text-slate-300">—</span>}</Cell>
                  <Cell right>
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${
                      row.status === "MATCHED" ? "bg-emerald-50 text-emerald-700"
                        : row.status === "FEE" ? "bg-amber-50 text-amber-800"
                          : row.status === "OVER" ? "bg-sky-50 text-sky-700"
                            : "bg-rose-50 text-rose-700"}`}
                    >
                      {row.status === "MATCHED"
                        ? "VỀ ĐỦ"
                        : row.status === "OVER"
                          ? "VỀ DƯ"
                          : row.status === "FEE"
                            ? (row.feeCategoryName ? "CHÊNH PHÍ" : "VỀ THIẾU")
                            : "CHƯA VỀ"}
                    </span>
                  </Cell>
                </tr>
              )),
              ...settlementGroupSubtotals(rows).map((subtotal) => (
                <tr key={`${day}-group-${subtotal.group}`} className="border-t border-slate-100 bg-slate-50/70">
                  <Cell><span className="text-slate-300">·</span></Cell>
                  <Cell>
                    <b className="text-slate-700">Cộng {settlementGroupNames[subtotal.group] || subtotal.group}</b>
                    <p className="mt-0.5 text-xs text-slate-500">{subtotal.count} nguồn chi tiết gộp theo Nhóm/Loại</p>
                  </Cell>
                  <Cell><SourceGroupTag group={subtotal.group} /></Cell>
                  <Cell right><b>{money(Math.round(subtotal.revenue))} đ</b></Cell>
                  <Cell right><b className="text-emerald-700">{money(Math.round(subtotal.received))} đ</b></Cell>
                  <Cell right>
                    <b className={subtotal.remaining > 0 ? "text-amber-700" : subtotal.remaining < 0 ? "text-rose-600" : "text-slate-400"}>
                      {money(subtotal.remaining)} đ
                    </b>
                  </Cell>
                  <Cell><span className="text-slate-300">—</span></Cell>
                  <Cell right>
                    <span className={`rounded-full px-2 py-1 text-xs font-bold ${
                      subtotal.status === "MATCHED" ? "bg-emerald-50 text-emerald-700"
                        : subtotal.status === "FEE" ? "bg-amber-50 text-amber-800"
                          : subtotal.status === "OVER" ? "bg-sky-50 text-sky-700"
                            : "bg-rose-50 text-rose-700"}`}
                    >
                      {subtotal.status === "MATCHED"
                        ? "VỀ ĐỦ"
                        : subtotal.status === "OVER"
                          ? "VỀ DƯ"
                          : subtotal.status === "FEE"
                            ? (subtotal.group === "WALLET" ? "CHÊNH PHÍ" : "VỀ THIẾU")
                            : "CHƯA VỀ"}
                    </span>
                  </Cell>
                </tr>
              )),
            ])}
            {data.rows.length > 0 && (
              <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                <Cell><b>TỔNG</b></Cell>
                <Cell><span className="text-xs font-normal text-slate-500">{data.rows.length} dòng</span></Cell>
                <Cell>-</Cell>
                <Cell right><b>{money(data.totals.revenue)} đ</b></Cell>
                <Cell right><b className="text-emerald-700">{money(data.totals.received)} đ</b></Cell>
                <Cell right><b className="text-amber-700">{money(data.totals.remaining)} đ</b></Cell>
                <Cell>-</Cell>
                <Cell right>-</Cell>
              </tr>
            )}
          </Table>
        </div>
      </section>
    </div>
  );
}

/**
 * Tên nguồn tiền cũ lưu kèm hình thức thanh toán ("ASA - Chuyển Khoản Sacombank (HKD)"), nhưng ở
 * các bảng nguồn tiền thì hình thức đã hiểu ngầm nên bỏ đi cho tên gọn lại.
 *
 * Danh mục nay đã cắt cụm này ngay lúc lưu; lớp cắt khi hiển thị chỉ còn để đỡ cho dữ liệu cũ
 * chưa chạy `npm run clean:money-source-names`. Dữ liệu gốc giữ nguyên.
 */
function cashSourceLabel(name: string) {
  return stripMoneySourceLabel(name);
}

function CashSourceFlowTable({ cashSource }: { cashSource: CashSourceData }) {
  const showBranch = cashSource.branchCode === "ALL";
  const rows = cashSource.sources;
  const totals = rows.reduce(
    (sum, row) => ({
      opening: sum.opening + row.opening,
      in: sum.in + row.in,
      out: sum.out + row.out,
      closing: sum.closing + row.closing,
      expectedIn: sum.expectedIn + row.expectedIn,
      expectedOut: sum.expectedOut + row.expectedOut,
      expectedClosing: sum.expectedClosing + row.expectedClosing,
    }),
    { opening: 0, in: 0, out: 0, closing: 0, expectedIn: 0, expectedOut: 0, expectedClosing: 0 },
  );
  // Khách dùng dòng TỔNG để soi ngược lên hai bảng Tổng quan thu/chi. Hai con số chỉ bằng nhau
  // khi mọi khoản thu/chi đều đã gắn nguồn tiền, nên chênh lệch phải được nói rõ thay vì giấu đi.
  const incomeGap = Math.round(cashSource.totals.in - totals.in);
  const expenseGap = Math.round(cashSource.totals.out - totals.out);
  const headers = [
    ...(showBranch ? ["Nhà hàng"] : []),
    "Nguồn tiền", "Đầu kỳ", "Thu", "Chi", "Cuối kỳ", "Dự thu trong kỳ", "Dự chi trong kỳ", "Dự kiến cuối kỳ",
  ];

  return (
    <section className="table-panel">
      <PanelHeader
        title="Biến động nguồn tiền (sổ quỹ)"
        subtitle="Thu/Chi gồm phiếu thu/chi, điều chỉnh quỹ, điều tiền nội bộ và tiền cọc nhận/hoàn trực tiếp. Dự thu là doanh thu ví chưa quyết toán về ngân hàng, dự chi là phiếu chi còn nháp/chờ duyệt — cả hai chưa vào số dư Cuối kỳ."
      />
      <div className="overflow-x-auto">
        <Table headers={headers}>
          {rows.length === 0 && (
            <tr className="border-t border-slate-100">
              {showBranch && <Cell>-</Cell>}
              <Cell>Chưa khai báo nguồn tiền mặt hoặc ngân hàng.</Cell>
              <Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell right>-</Cell>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={`${row.branchCode}-${row.code}`} className="border-t border-slate-100 hover:bg-slate-50">
              {showBranch && <Cell>{storeLabel(row.branchCode)}</Cell>}
              <Cell>
                <b>{cashSourceLabel(row.name)}</b>
                <p className="text-xs text-slate-500 mt-0.5">{row.code}</p>
                {(row.transferIn !== 0 || row.transferOut !== 0) && (
                  <p className="text-xs text-slate-400 mt-0.5">
                    gồm điều tiền vào {money(row.transferIn)} đ / ra {money(row.transferOut)} đ
                  </p>
                )}
              </Cell>
              <Cell right>{money(row.opening)} đ</Cell>
              <Cell right><span className="text-emerald-700">{money(row.in)} đ</span></Cell>
              <Cell right>{money(row.out)} đ</Cell>
              <Cell right><b className={row.closing < 0 ? "text-rose-600" : "text-slate-900"}>{money(row.closing)} đ</b></Cell>
              <Cell right>{row.expectedIn ? <span className="text-sky-700">{money(row.expectedIn)} đ</span> : <span className="text-slate-300">—</span>}</Cell>
              <Cell right>{row.expectedOut ? <span className="text-amber-700">{money(row.expectedOut)} đ</span> : <span className="text-slate-300">—</span>}</Cell>
              <Cell right><b className={row.expectedClosing < 0 ? "text-rose-600" : "text-slate-900"}>{money(row.expectedClosing)} đ</b></Cell>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="border-t border-slate-200 bg-slate-50 font-bold">
              {showBranch && <Cell><b>TỔNG</b></Cell>}
              <Cell>{showBranch ? <span className="text-xs font-normal text-slate-500">{rows.length} nguồn tiền</span> : <b>TỔNG</b>}</Cell>
              <Cell right><b>{money(totals.opening)} đ</b></Cell>
              <Cell right><b className="text-emerald-700">{money(totals.in)} đ</b></Cell>
              <Cell right><b>{money(totals.out)} đ</b></Cell>
              <Cell right><b className={totals.closing < 0 ? "text-rose-600" : "text-slate-900"}>{money(totals.closing)} đ</b></Cell>
              <Cell right><b className="text-sky-700">{money(totals.expectedIn)} đ</b></Cell>
              <Cell right><b className="text-amber-700">{money(totals.expectedOut)} đ</b></Cell>
              <Cell right><b className={totals.expectedClosing < 0 ? "text-rose-600" : "text-slate-900"}>{money(totals.expectedClosing)} đ</b></Cell>
            </tr>
          )}
          {rows.length > 0 && (
            <tr className={`border-t border-slate-100 ${incomeGap !== 0 || expenseGap !== 0 ? "bg-amber-50/60" : "bg-emerald-50/60"}`}>
              <td colSpan={headers.length} className={`px-4 py-3 text-xs ${incomeGap !== 0 || expenseGap !== 0 ? "text-amber-900" : "text-emerald-800"}`}>
                <b>Đối chiếu với Tổng quan thu/chi theo danh mục:</b>{" "}
                thu {money(cashSource.totals.in)} đ{incomeGap !== 0 ? ` (lệch ${money(incomeGap)} đ)` : " — khớp"} ·
                chi {money(cashSource.totals.out)} đ{expenseGap !== 0 ? ` (lệch ${money(expenseGap)} đ)` : " — khớp"}.
                {(incomeGap !== 0 || expenseGap !== 0) && (
                  <> Phần lệch có chủ đích: Tổng quan thu tính doanh thu ví GROSS trước phí và cả dòng sao kê
                  chưa lập được chứng từ, còn sổ quỹ ghi số tiền THỰC vào/ra tài khoản (net sau phí);
                  tiền ví về ngân hàng nằm ở nhóm điều tiền nên không lặp lại ở cột Thu.</>
                )}
              </td>
            </tr>
          )}
        </Table>
      </div>
    </section>
  );
}

function CashCategoryTable({
  title,
  subtitle,
  amountHeader,
  rows,
  total,
  tone,
  unclassifiedLinks,
}: {
  title: string;
  subtitle: string;
  amountHeader: string;
  rows: CashCategoryRow[];
  total: number;
  tone: "blue" | "amber";
  /** Link mang sẵn bộ lọc "phiếu chưa có danh mục" để bấm từ dòng Chưa phân loại đi sửa luôn. */
  unclassifiedLinks?: Array<{ label: string; href: string }>;
}) {
  const barClass = tone === "blue" ? "bg-blue-500" : "bg-amber-500";
  return (
    <section className="table-panel">
      <PanelHeader title={title} subtitle={subtitle} />
      <div className="overflow-x-auto">
        <Table headers={["Danh mục", amountHeader, "% tỷ lệ"]}>
          {rows.length === 0 && (
            <tr className="border-t border-slate-100"><Cell>Chưa có phát sinh trong kỳ.</Cell><Cell>-</Cell><Cell right>-</Cell></tr>
          )}
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-100 hover:bg-slate-50">
              <Cell>
                <b>{row.name}</b>
                {row.key === "UNCLASSIFIED" && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-800">cần bổ sung</span>}
                <p className="mt-0.5 text-xs font-normal text-slate-500">{row.count} dòng</p>
                {row.key === "UNCLASSIFIED" && (unclassifiedLinks?.length || 0) > 0 && (
                  <p className="mt-1 flex flex-wrap gap-2 text-xs font-bold">
                    {/* Mở tab mới (chốt meeting 22/08/2026): trang báo cáo đứng yên, sửa phiếu xong quay lại không mất bộ lọc. */}
                    {unclassifiedLinks?.map((link) => (
                      <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="text-blue-700 underline-offset-2 hover:underline">
                        {link.label} ↗
                      </a>
                    ))}
                  </p>
                )}
              </Cell>
              <Cell><b>{money(row.total)} đ</b></Cell>
              <Cell right>
                <div className="flex items-center justify-end gap-2">
                  <span className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-slate-100 sm:block">
                    <span className={`block h-full ${barClass}`} style={{ width: `${Math.min(100, Math.max(0, row.ratio * 100))}%` }} />
                  </span>
                  <b>{(row.ratio * 100).toFixed(2)} %</b>
                </div>
              </Cell>
            </tr>
          ))}
          <tr className="border-t border-slate-200 bg-slate-50 font-bold">
            <Cell><b>TỔNG</b></Cell>
            <Cell><b>{money(total)} đ</b></Cell>
            <Cell right><b>100,00 %</b></Cell>
          </tr>
        </Table>
      </div>
    </section>
  );
}

/** Ma trận khoản mục x 12 tháng cho báo cáo năm. */
function CashMonthMatrix({ title, months, rows }: { title: string; months: string[]; rows: CashCategoryRow[] }) {
  const monthTotals = months.map((_, index) => rows.reduce((sum, row) => sum + row.months[index], 0));
  const grandTotal = rows.reduce((sum, row) => sum + row.total, 0);
  return (
    <section className="table-panel">
      <PanelHeader title={title} subtitle="Cuộn ngang để xem đủ 12 tháng. Ô trống là tháng không phát sinh." />
      <div className="overflow-x-auto">
        <Table headers={["Danh mục", ...months.map((item) => `T${Number(item.slice(5))}`), "Tổng"]}>
          {rows.length === 0 && (
            <tr className="border-t border-slate-100"><Cell>Chưa có phát sinh trong năm.</Cell>{months.map((item) => <Cell key={item}>-</Cell>)}<Cell right>-</Cell></tr>
          )}
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-slate-100 hover:bg-slate-50">
              <Cell><b>{row.name}</b></Cell>
              {row.months.map((value, index) => (
                <Cell key={months[index]} right>{value ? money(value) : "-"}</Cell>
              ))}
              <Cell right><b>{money(row.total)} đ</b></Cell>
            </tr>
          ))}
          <tr className="border-t border-slate-200 bg-slate-50 font-bold">
            <Cell><b>TỔNG</b></Cell>
            {monthTotals.map((value, index) => (
              <Cell key={months[index]} right><b>{value ? money(value) : "-"}</b></Cell>
            ))}
            <Cell right><b>{money(grandTotal)} đ</b></Cell>
          </tr>
        </Table>
      </div>
    </section>
  );
}

function PnlTable({ value }: { value?: Pnl }) {
  if (!value) return null;
  const rows = [
    { label: "1. Doanh thu bán hàng và cung cấp dịch vụ", val: value.revenue },
    { label: "2. Giá vốn hàng bán", val: value.cogs },
    { label: "3. Lợi nhuận gộp", val: value.grossProfit, bold: true },
    { label: "4. Chi phí nhân sự", val: value.payroll },
    { label: "5. Chi phí hoạt động khác (OPEX)", val: value.otherOpex },
    { label: "6. Khấu hao tài sản/CCDC", val: value.depreciation },
    { label: "7. EBITDA", val: value.ebitda, bold: true },
    { label: "8. Thu nhập khác", val: value.otherIncome },
    { label: "9. Chi phí khác", val: value.otherExpense },
    { label: "10. Lợi nhuận ròng", val: value.netProfit, bold: true },
  ];

  return (
    <div className="overflow-x-auto">
      <Table headers={["Chỉ tiêu", "Số tiền (VND)"]}>
        {rows.map((r) => (
          <tr key={r.label} className={`border-t border-slate-100 ${r.bold ? "bg-slate-50 font-bold" : ""}`}>
            <Cell>{r.label}</Cell>
            <Cell right><span className={r.bold ? "text-blue-700" : ""}>{money(r.val)} đ</span></Cell>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function PnlItemTable({ rows }: { rows?: PnlItemBreakdown[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <PanelHeader title="Chi phí theo hạng mục P&L" subtitle="Khoản chưa chọn hạng mục được giữ ở dòng Chưa phân loại P&L." />
      <Table headers={["Mã", "Hạng mục P&L", "Nhóm", "Số tiền (VND)"]}>
        {rows.map((row) => (
          <tr key={row.code} className={`border-t border-slate-100 ${row.code === "UNCLASSIFIED" ? "bg-amber-50" : ""}`}>
            <Cell><b>{row.code === "UNCLASSIFIED" ? "-" : row.code}</b></Cell>
            <Cell>{row.name}</Cell>
            <Cell>{row.group || "-"}</Cell>
            <Cell right><b>{money(row.amount)} đ</b></Cell>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function CutTable({ title, rows }: { title: string; rows?: PnlCut[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <PanelHeader title={title} subtitle="Chi tiết doanh thu, chi phí và EBITDA" />
      <Table headers={["Đơn vị", "Doanh thu", "Giá vốn", "Lợi nhuận gộp", "EBITDA"]}>
        {rows.map((r) => (
          <tr key={r.code} className="border-t border-slate-100">
            <Cell><b>{storeLabel(r.code)}</b></Cell>
            <Cell right>{money(r.revenue)} đ</Cell>
            <Cell right>{money(r.cogs)} đ</Cell>
            <Cell right><b>{money(r.grossProfit)} đ</b></Cell>
            <Cell right><b className={r.ebitda >= 0 ? "text-emerald-600" : "text-rose-600"}>{money(r.ebitda)} đ</b></Cell>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function OperationGroupTable({ title, rows }: { title: string; rows?: OperationGroup[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <PanelHeader title={title} subtitle="Chi tiết theo phòng ban" />
      <Table headers={["Phòng ban", "Số lượng", "Giá trị"]}>
        {rows.map((r) => (
          <tr key={r.departmentCode} className="border-t border-slate-100">
            <Cell><b>{r.departmentName}</b></Cell>
            <Cell><b>{r.count}</b></Cell>
            <Cell right><b>{money(r.amount)} đ</b></Cell>
          </tr>
        ))}
      </Table>
    </section>
  );
}
