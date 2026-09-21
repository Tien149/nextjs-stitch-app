"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput, MonthInput } from "@/components/DateInput";
import { storeLabel, visibleBranchScopeOptions, visibleStoreOptions } from "@/lib/branch-labels";
import { canCreateCashDeposit as canCreateCashDepositSlip, canPerformMenuAction, filterModuleTabs, moduleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import { filterCashierCashSources, filterMoneySources, moneySourceDebugLabel, moneySourceDisplayName, stripMoneySourceLabel, type MoneySourceOption } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import ExportExcelButton from "@/components/ExportExcelButton";
import { toFileSlug } from "@/lib/export-table-excel";
import StickyFilterBar from "@/components/StickyFilterBar";
import { shiftLabel, shiftLabels } from "@/lib/shifts";
import { cashDepositRoundingExpense, roundCashDepositAmount } from "@/lib/cash-deposit";
import { buildDailyCashSummaryRows } from "@/lib/daily-cash-receipts";
import PayrollBudgetTab, { type PayrollBudgetData } from "@/components/reports/PayrollBudgetTab";
import BudgetTab, { type BudgetData } from "@/components/reports/BudgetTab";
import FinancialPlanningWorkspace from "@/components/reports/planning/FinancialPlanningWorkspace";
import RevenueTrendTab from "@/components/reports/RevenueTrendTab";
import { statValueTextClass } from "@/components/reports/report-ui";
import { isRevenueGroupCategory } from "@/lib/voucher-rules";

type Pnl = {
  revenue: number;
  cogs: number;
  payroll: number;
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
type PnlDetailItem = { code: string; name: string; amount: number };
type PnlDetailGroup = PnlDetailItem & { items: PnlDetailItem[] };
type PnlStatementLine = {
  key: string; label: string; amount: number; subtotal: boolean; groups: PnlDetailGroup[];
  /** Chứng từ chưa gắn hạng mục P&L — đứng NGOÀI `amount`, chỉ hiện làm dòng thông tin. */
  unclassified?: number;
};
type PnlData = { total: Pnl; statement: PnlStatementLine[]; byBranch: PnlCut[]; byDepartment: PnlCut[]; byPnlItem: PnlItemBreakdown[] };
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
  summary: { revenue: DailyCashBucket; unshiftedRevenue?: DailyCashBucket; posRevenue: DailyCashBucket; manual: DailyCashBucket; receipt: DailyCashBucket; receiptRevenue: DailyCashBucket; receiptSalesRevenue?: DailyCashBucket; receiptOther?: DailyCashBucket; deposit: DailyCashBucket; total: DailyCashBucket; expenseTotal: number; cashExpenseTotal: number; cashToDeposit: number };
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
type UnclassifiedOrigin = "voucher" | "bankStatement" | "adjustment" | "transferFee";

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
  unclassified: {
    income: number;
    expense: number;
    /** Số dòng "Chưa phân loại" tách theo màn đang giữ dữ liệu, để chỉ hiện link tới đúng chỗ. */
    origins?: Record<"RECEIPT" | "PAYMENT", Record<UnclassifiedOrigin, { count: number; amount: number }>>;
  };
  pending: { receiptAmount: number; receiptCount: number; paymentAmount: number; paymentCount: number };
  internalTransfer: { total: number; count: number };
  sources: CashSourceFlow[];
  deposits: Array<{ code: string; name: string; opening: number; increase: number; used: number; closing: number }>;
};
type RevenueSettlementRow = {
  date: string;
  moneySourceCode: string;
  moneySourceName: string;
  branchCode?: string;
  group: string;
  /** Phần chênh đã được đưa vào chi phí ngay trên bảng — đã trừ khỏi `remaining`. */
  writtenOff?: number;
  revenue: number;
  received: number;
  /** Phần trong `received` là cọc cấn trừ / chuyển doanh thu đúng ngày — không có trên sao kê. */
  depositApplied: number;
  remaining: number;
  feeCategoryCode: string | null;
  feeCategoryName: string | null;
  status: "MATCHED" | "FEE" | "WAITING" | "OVER";
};
/** Phiếu thu bán hàng lập tay chưa có dòng sao kê nào đối chiếu — xem khối cảnh báo dưới bảng. */
type RevenueSettlementLooseVoucher = {
  id: string;
  code: string;
  date: string;
  moneySourceCode: string;
  moneySourceName: string;
  partnerName: string;
  amount: number;
  /** Dòng sao kê chưa có chứng từ nào, cùng số tiền — nối được ngay tại đây. */
  candidates: Array<{ id: string; transactionCode: string; transactionDate: string; bankAccount: string; dayGap: number; sourceMismatch: boolean; exact: boolean }>;
  /** Dòng sao kê cùng số tiền nhưng đã có chứng từ riêng — phiếu tay là bản trùng. */
  takenLines?: Array<{ transactionCode: string; transactionDate: string; voucherCode: string }>;
};
type RevenueSettlementData = {
  period: string;
  branchCode: string;
  rows: RevenueSettlementRow[];
  looseVouchers?: RevenueSettlementLooseVoucher[];
  expensePnlItems?: Array<{ code: string; name: string }>;
  totals: { revenue: number; received: number; remaining: number; waiting: number; fee: number; over: number; looseVoucherAmount?: number };
};
type MasterDataOption = { id: string; type: string; code: string; name: string; group: string | null; branch: string | null };
type RevenueLedgerRow = {
  date: string;
  channel: string;
  orderCount: number;
  grossAmount: number;
  discountAmount: number;
  vatAmount: number;
  serviceAmount: number;
  cardFeeAmount: number;
  appFeeAmount: number;
  netAmount: number;
  lineCount: number;
  previousNetAmount: number;
  noteCount: number;
};
type RevenueLedgerDetailRow = {
  id: string;
  saleDate: string;
  branchCode: string;
  channel: string;
  revenueSource: string;
  paymentMethod: string;
  externalRef: string;
  productCode: string | null;
  productQuantity: number | null;
  departmentCode: string | null;
  note: string | null;
  orderCount: number | null;
  grossAmount: number;
  discountAmount: number;
  vatAmount: number;
  serviceAmount: number;
  cardFeeAmount: number;
  appFeeAmount: number;
  netAmount: number;
};
type RevenueLedgerData = {
  period: string;
  branchCode: string;
  dateFrom: string;
  dateTo: string;
  channel: string;
  channels: string[];
  rows: RevenueLedgerRow[];
  totals: Omit<RevenueLedgerRow, "date" | "channel">;
};
type ActivityLog = { id: string; time: string; module: string; action: string; actor: string; branchCode: string; code: string; note: string };
type AccountingPeriodStatus = { period: string; branchCode: string; status: string; closedBy: string | null; closedAt: string | null; reopenedBy: string | null; reopenedAt: string | null; reason: string | null };
type ActivityData = { accountingPeriod: AccountingPeriodStatus; periods: AccountingPeriodStatus[]; logs: ActivityLog[] };
type ReportData = DashboardData | PnlData | YoyData | CashflowData | BalanceData | OperationsData | BudgetData | DailyCashData | ActivityData | CashSourceData | RevenueSettlementData | RevenueLedgerData;
type CashDepositDenomination = { denomination: number; quantity: string };
type CashDepositForm = { depositTargetType: "PKT" | "CO"; fromMoneySourceCode: string; toMoneySourceCode: string; denominations: CashDepositDenomination[] };

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);
const metricLabels: Record<string, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn",
  grossProfit: "Lợi nhuận gộp",
  payroll: "Chi phí nhân sự",
  otherOpex: "Chi phí hoạt động (OPEX)",
  opexBeforeDepreciation: "Chi phí hoạt động (nhân sự + OPEX)",
  ebitda: "Lợi nhuận hoạt động",
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
  // Sổ doanh thu: để trống khoảng ngày = lấy trọn tháng đang chọn, giống mọi tab khác.
  const [ledgerFrom, setLedgerFrom] = useState("");
  const [ledgerTo, setLedgerTo] = useState("");
  const [ledgerChannel, setLedgerChannel] = useState("");
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
  const [reopenReason, setReopenReason] = useState("Bổ sung hoặc điều chỉnh dữ liệu kỳ trước");

  // Vai trò được gán riêng một tab (ví dụ thu ngân chỉ có "Thu chi ngày") thì chỉ thấy tab đó.
  const visibleTabs = useMemo(() => filterModuleTabs(user, href), [user]);
  const canConfigure = user ? canPerformMenuAction(user, href, "create") : false;
  const canCreateCashDeposit = user ? canCreateCashDepositSlip(user) : false;
  const canEnterManualRevenue = user ? canPerformMenuAction(user, href, "create") : false;
  // Sửa phân loại dòng doanh thu đã import (Sổ doanh thu) — sửa số cũ nên đi theo quyền edit.
  const canEditRevenueRow = user ? canPerformMenuAction(user, href, "edit") : false;
  /** Nối phiếu tay vào dòng sao kê là thao tác của màn Sổ sao kê, nên xin quyền của màn đó. */
  const canEditReconciliation = user ? canPerformMenuAction(user, "/reconciliations", "edit") : false;
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

  /**
   * Sổ doanh thu đứng chờ: mở tab ra chưa gọi số liệu, phải bấm "Tải dữ liệu" mới chạy.
   *
   * Tab này quét toàn bộ dòng doanh thu POS của kỳ (hàng nghìn dòng mỗi tháng) nên ai lỡ bấm
   * qua cũng kéo theo một lượt tính nặng, trong khi phần lớn thời gian người xem chỉ đi ngang.
   * Rời tab là trở lại trạng thái chờ, quay lại thì tự bấm (yêu cầu 18/09/2026).
   */
  const [ledgerArmed, setLedgerArmed] = useState(false);

  const loadData = useCallback(async () => {
    if (active === "revenue-ledger" && !ledgerArmed) {
      setTabLoading(false);
      return;
    }
    try {
      setTabLoading(true);
      const params = new URLSearchParams({ type: active, period, branchCode, scenario });
      if (active === "daily-cash") {
        params.set("reportDate", reportDate);
        params.set("shift", shift);
      }
      if (active === "cash-source") params.set("view", cashSourceView);
      if (active === "revenue-ledger") {
        if (ledgerFrom) params.set("dateFrom", ledgerFrom);
        if (ledgerTo) params.set("dateTo", ledgerTo);
        if (ledgerChannel) params.set("channel", ledgerChannel);
      }
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
  }, [active, branchCode, cashSourceView, ledgerArmed, ledgerChannel, ledgerFrom, ledgerTo, period, reportDate, scenario, shift]);

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
      setLedgerArmed(false);
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
  const ledger = active === "revenue-ledger" && data && typeof data === "object" && "rows" in data && "channels" in data ? (data as RevenueLedgerData) : null;
  const payrollBudget = active === "payroll-budget" && data && typeof data === "object" && "standard" in data && "headcount" in data ? (data as unknown as PayrollBudgetData) : null;

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
  const dailyCashSummaryRows = useMemo(
    () => (dailyCash ? buildDailyCashSummaryRows(dailyCash.summary) : []),
    [dailyCash],
  );
  // Doanh thu POS chưa tách được ca đứng SAU dòng TOTAL: nó là số của cả ngày, không thuộc ca
  // đang xem, nên không được cộng vào tổng lẫn số nộp của ca.
  const dailyCashShiftRows = dailyCashSummaryRows.filter((row) => !row.outsideTotal);
  const dailyCashOutsideRows = dailyCashSummaryRows.filter((row) => row.outsideTotal);
  const dailyCashExpenseSum = dailyCashShiftRows.reduce((sum, row) => sum + (row.expense || 0), 0);
  const dailyCashDepositSum = dailyCashShiftRows.reduce((sum, row) => sum + (row.cashToDeposit || 0), 0);

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
    // Màn báo cáo toàn bảng nhiều cột và thẻ KPI số tiền hàng tỷ; khung 7xl (1280px) để thừa
    // hai dải trắng hai bên mà số vẫn bị bóp. Nới bằng các màn Kho / Chứng từ đang dùng.
    <ModuleFrame title="Báo cáo & BI" subtitle="GĐ4 - Dashboard, báo cáo vận hành, ngân sách, kỳ kế toán và nhật ký" role={user?.role} contentClassName="max-w-[1680px]">
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
              <DateInput className="mt-1.5 w-40" value={reportDate} onChange={setReportDate} ariaLabel={active === "daily-cash" ? "Ngày thu chi" : "Ngày đối chiếu"} />
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
        {active === "revenue-ledger" && (
          <>
            <Field label="Từ ngày">
              <DateInput className="mt-1.5 w-40" value={ledgerFrom} onChange={setLedgerFrom} ariaLabel="Doanh thu từ ngày" />
            </Field>
            <Field label="Đến ngày">
              <DateInput className="mt-1.5 w-40" value={ledgerTo} onChange={setLedgerTo} ariaLabel="Doanh thu đến ngày" />
            </Field>
            <Field label="Kênh bán">
              <select className="control w-44" value={ledgerChannel} onChange={(event) => setLedgerChannel(event.target.value)}>
                <option value="">Tất cả kênh</option>
                {ledger?.channels.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </Field>
            {(ledgerFrom || ledgerTo || ledgerChannel) && (
              <button
                type="button"
                className="self-end rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
                onClick={() => { setLedgerFrom(""); setLedgerTo(""); setLedgerChannel(""); }}
              >
                Bỏ lọc
              </button>
            )}
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
        <BudgetTab key={`${period}-${branchCode}`} data={budget} period={period} branchCode={branchCode} branchLabel={branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(branchCode)} canConfigure={canConfigure} onSaved={loadData} setMessage={setMessage} />
      )}

      {!tabLoading && payrollBudget && (
        <PayrollBudgetTab data={payrollBudget} period={period} branchCode={branchCode} canConfigure={canConfigure} onSaved={loadData} setMessage={setMessage} />
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
              const range = `branchCode=${encodeURIComponent(branchCode)}&from=${firstMonth}-01&to=${lastMonth}-${String(lastDay).padStart(2, "0")}`;
              // Kỳ một tháng thì mở Sổ quỹ đúng tháng đó; báo cáo năm để Sổ quỹ giữ kỳ mặc định.
              const cashbookQuery = `branchCode=${encodeURIComponent(branchCode)}${cashSource.months.length === 1 ? `&period=${firstMonth}` : ""}`;
              // Chỉ hiện link tới màn ĐANG THỰC SỰ có dòng chưa phân loại. Số tiền ở dòng này
              // gom từ bốn nơi khác nhau (phiếu tiền mặt, sổ sao kê, điều chỉnh quỹ, phí điều
              // tiền) nên hiện đủ mọi link như trước là bấm vào ra danh sách rỗng.
              const linksFor = (voucherType: "RECEIPT" | "PAYMENT") => {
                const origins = cashSource.unclassified.origins?.[voucherType];
                if (!origins) return [];
                const links: Array<{ label: string; href: string }> = [];
                if (origins.voucher.count > 0) {
                  links.push({
                    label: `Xem ${origins.voucher.count} phiếu tiền mặt chưa phân loại`,
                    href: `/vouchers?missingCategory=1&${range}&voucherType=${voucherType}`,
                  });
                }
                if (origins.bankStatement.count > 0) {
                  // Tiền "không phải tiền mặt" của bảng này đọc từ SỔ SAO KÊ, không phải từ
                  // chứng từ ngân hàng — link cũ trỏ sang /bank-vouchers nên luôn rỗng.
                  links.push({
                    label: `Xem ${origins.bankStatement.count} dòng sao kê chưa gán loại thu/chi`,
                    href: `/reconciliations?missingCategory=1&dateType=SOURCE&${range}`,
                  });
                }
                if (origins.adjustment.count > 0) {
                  links.push({
                    label: `Xem ${origins.adjustment.count} bút toán điều chỉnh quỹ trên Sổ quỹ`,
                    href: `/finance-operations?${cashbookQuery}`,
                  });
                }
                if (origins.transferFee.count > 0) {
                  links.push({
                    label: `Xem ${origins.transferFee.count} phí điều tiền chưa gán loại chi`,
                    href: `/finance-operations?${cashbookQuery}`,
                  });
                }
                return links;
              };
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
          {reconDailyCash && <MoneyInReconciliationPanel dailyCash={reconDailyCash} showContextLine />}
          <RevenueSettlementPanel data={settlement} canLink={canEditReconciliation} onLinked={() => void loadData()} />
        </div>
      )}

      {active === "revenue-ledger" && !ledgerArmed && (
        <section className="rounded-xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-slate-300">point_of_sale</span>
          <h3 className="mt-2 font-bold text-slate-700">Sổ doanh thu đang chờ</h3>
          <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">
            Báo cáo này quét toàn bộ dòng doanh thu POS của kỳ nên không tự chạy. Chọn kỳ, cửa hàng và khoảng ngày ở thanh lọc phía trên rồi bấm nút dưới đây.
          </p>
          <button
            type="button"
            onClick={() => setLedgerArmed(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
          >
            <span className="material-symbols-outlined text-base">play_arrow</span>
            Tải dữ liệu
          </button>
        </section>
      )}

      {!tabLoading && ledger && ledgerArmed && <RevenueLedgerPanel data={ledger} branchCode={branchCode} moneySources={moneySources} canEdit={canEditRevenueRow} onSaved={() => void loadData()} />}

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
            <PanelHeader title="Tổng hợp thu trong ngày" subtitle="Doanh thu bán hàng gồm số liệu POS (hoặc nhập tay khi chưa có POS) và phiếu thu loại Thu bán hàng; các khoản thu khác (hoàn tiền NCC, thu ngoài bán hàng) và tiền cọc tách dòng riêng nhưng phần tiền mặt vẫn tính vào số nộp. Xem theo ca thì doanh thu POS đứng riêng một dòng dưới TOTAL vì file POS chỉ khai ngày, không khai ca." />
            <Table headers={["Loại", "Tổng thu", "Tiền mặt", "Chuyển khoản", "Quẹt thẻ/Ví", "Grab", "Khác", "Tổng chi tiền mặt", "Nộp tiền"]}>
              {dailyCashShiftRows.map((row) => (
                <DailyCashSummaryRow key={row.label} label={row.label} bucket={row.bucket} expense={row.expense} cashToDeposit={row.cashToDeposit} />
              ))}
              <DailyCashSummaryRow
                label="TOTAL"
                bucket={dailyCash.summary.total}
                expense={dailyCashExpenseSum}
                cashToDeposit={dailyCashDepositSum}
                strong
              />
              {dailyCashOutsideRows.map((row) => (
                <DailyCashSummaryRow key={row.label} label={row.label} bucket={row.bucket} note={row.note} muted />
              ))}
            </Table>
          </section>

          {/* Bảng "Đối chiếu tiền vào đã đủ chưa" và danh sách "Chưa vào sổ" đã chuyển sang
              đầu tab Tiền về đủ chưa (yêu cầu 05/09/2026): đối soát tiền về là việc của kế
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

          <section className="table-panel daily-cash-detail">
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

          <section className="table-panel daily-cash-detail">
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

          <section className="daily-cash-signature grid grid-cols-2 gap-8 bg-white border border-slate-200 rounded-lg p-6 text-center text-sm font-bold text-slate-700">
            <div className="pt-8 border-t border-dashed border-slate-300">Thu ngân</div>
            <div className="pt-8 border-t border-dashed border-slate-300">Quản lý</div>
          </section>
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
          <form onSubmit={submitCashDeposit} className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
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

            <div className="grid gap-4 overflow-y-auto p-4 lg:grid-cols-[0.85fr_1.35fr]">
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

              {/* self-start bắt buộc: ô lưới mặc định bị kéo giãn bằng chiều cao hàng, mà khung
                  này lại overflow-hidden (để bo góc) nên phần bảng vượt ra bị CẮT THẲNG, không
                  sinh thanh cuộn nào — đó là lý do dòng 1.000 đ coi như biến mất. Cho khung cao
                  đúng nội dung thì phần thân hộp thoại mới cuộn được tới dòng cuối. */}
              <div className="self-start overflow-hidden rounded-lg border border-slate-200 bg-white">
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
                {/* Không giới hạn chiều cao ở đây nữa. Khung cũ cao 440px trong khi 9 mệnh giá
                    cần ~520px, nên hai dòng đầu (500.000 / 200.000) và dòng cuối (1.000) nằm
                    ngoài tầm nhìn sau một thanh cuộn lồng bên trong hộp thoại — người dùng
                    không thấy là còn cuộn được. Giờ liệt kê đủ 9 dòng, hộp thoại chỉ còn MỘT
                    thanh cuộn duy nhất khi màn hình quá thấp. */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-white text-xs uppercase text-slate-500 shadow-[inset_0_-1px_0_#e2e8f0]">
                      <tr>
                        <th className="px-4 py-2.5">Mệnh giá</th>
                        <th className="px-4 py-2.5">Số tờ</th>
                        <th className="px-4 py-2.5 text-right">Thành tiền</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {cashDepositForm.denominations.map((row) => {
                        const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
                        return (
                          <tr key={row.denomination}>
                            <td className="px-4 py-1 font-bold tabular-nums whitespace-nowrap">{money(row.denomination)} đ</td>
                            <td className="px-4 py-1">
                              <input
                                className="control mt-0 h-8 w-28 py-1 text-right tabular-nums"
                                inputMode="numeric"
                                placeholder="0"
                                value={row.quantity}
                                onChange={(event) => updateCashDepositDenomination(row.denomination, event.target.value)}
                              />
                            </td>
                            <td className="px-4 py-1 text-right font-bold tabular-nums whitespace-nowrap">{money(row.denomination * quantity)} đ</td>
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
            <Kpi label="LN hoạt động" value={dashboard.pnl?.total?.ebitda || 0} icon="monitoring" tone="blue" />
            <Kpi label="Tiền hiện có" value={dashboard.balance?.rows?.filter((row) => row.reportGroup === "CASH")?.reduce((sum, row) => sum + row.amount, 0) || 0} icon="account_balance_wallet" tone="amber" />
          </div>
          <div className="grid xl:grid-cols-[1.4fr_1fr] gap-5">
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="font-bold">Xu hướng 6 tháng</h2>
              <p className="text-xs text-slate-500 mt-1">Doanh thu lấy từ file import doanh thu; chi phí và lợi nhuận hoạt động từ dữ liệu đã ghi sổ.</p>
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
                    <div className="text-right"><b>{money(row.revenue)} đ</b><p className={`text-xs mt-1 ${row.ebitda >= 0 ? "text-emerald-600" : "text-rose-600"}`}>LN hoạt động {money(row.ebitda)} đ</p></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {!tabLoading && pnl && (
        /* Cụm Hoạch định tài chính (học theo Omni Plan, 09/2026): Kỳ tháng như cũ + Dự báo P&L,
           Dashboard P&L, Định mức, Điểm hòa vốn, Giả định tài chính chạy theo năm của kỳ. */
        <FinancialPlanningWorkspace
          period={period}
          branchCode={branchCode}
          onOpenBudget={visibleTabs.some((tab) => tab.id === "budget") ? () => handleTabChange("budget") : undefined}
          periodView={(
            <div className="space-y-5">
              <PnlStatementTable period={period} branchCode={branchCode} lines={pnl.statement} value={pnl.total} />
              <div className="grid xl:grid-cols-2 gap-5">
                <CutTable title="Theo cửa hàng" rows={pnl.byBranch} />
                <CutTable title="Theo phòng ban" rows={pnl.byDepartment} />
              </div>
            </div>
          )}
        />
      )}

      {!tabLoading && yoy && (
        <div className="space-y-5">
          {/* Chart kế hoạch/thực hiện + cùng kỳ nhiều năm (feedback 26/08/2026 mục 5). */}
          <RevenueTrendTab period={period} branchCode={branchCode} />
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
        </div>
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
function DailyCashSummaryRow({ label, bucket, expense, cashToDeposit, strong = false, muted = false, note }: { label: string; bucket: DailyCashBucket; expense?: number; cashToDeposit?: number; strong?: boolean; muted?: boolean; note?: string }) {
  const contentClass = strong ? "font-bold text-slate-900 bg-slate-50" : muted ? "text-slate-500 bg-slate-50/60" : "";
  return (
    <tr className={`border-t border-slate-100 ${contentClass}`}>
      <Cell>
        <b>{label}</b>
        {note && <small className="block font-normal text-slate-500">{note}</small>}
      </Cell>
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
      <p className={`font-bold mt-2 leading-tight tabular-nums whitespace-nowrap ${statValueTextClass(`${money(value)} đ`)} ${toneClasses}`}>{money(value)} đ</p>
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
        {amount !== undefined && <span className="text-xs font-bold text-blue-600 tabular-nums whitespace-nowrap">{money(amount)} đ</span>}
        {extra && <span className="text-xs font-bold text-rose-600">{extra}</span>}
      </div>
    </div>
  );
}

/**
 * Mọi bảng báo cáo đều xuất được Excel: nút nằm sẵn trên tiêu đề panel, tên file suy từ tiêu đề.
 * Truyền exportFileName khi muốn đặt tên khác, hoặc exportable={false} cho panel không có bảng.
 */
function PanelHeader({ title, subtitle, exportFileName, exportable = true }: { title: string; subtitle: string; exportFileName?: string; exportable?: boolean }) {
  return (
    <div className="p-4 border-b border-slate-200 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-bold">{title}</h2>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      {exportable && <ExportExcelButton fileName={exportFileName || toFileSlug(title)} sheetName={title.slice(0, 31)} />}
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  // Bọc khung cuộn ngang ngay tại đây: số ghi đủ chữ số nên bảng nhiều cột dễ vượt bề ngang,
  // để bảng tự cuộn còn hơn bóp cột lại rồi cắt số. Nút Xuất Excel tìm <table> theo
  // querySelector nên thêm một lớp div không ảnh hưởng.
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold border-b border-slate-200">
          <tr>
            {headers.map((h, i) => (
              <th key={h} className={`px-4 py-3 whitespace-nowrap ${i === headers.length - 1 ? "text-right" : i === 0 ? "text-left" : "text-left"}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// Cột canh phải là cột số: cấm ngắt dòng giữa số và thêm tabular-nums cho chữ số thẳng hàng.
// Cột canh trái vẫn được xuống dòng vì chứa diễn giải dài.
function Cell({ children, right, center }: { children: React.ReactNode; right?: boolean; center?: boolean }) {
  return <td className={`px-4 py-3 ${right ? "text-right tabular-nums whitespace-nowrap" : center ? "text-center" : "text-left"}`}>{children}</td>;
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
  const byGroup = new Map<string, { group: string; count: number; revenue: number; received: number; writtenOff: number }>();
  for (const row of rows) {
    const key = row.group || "OTHER";
    const current = byGroup.get(key) || { group: key, count: 0, revenue: 0, received: 0, writtenOff: 0 };
    current.count += 1;
    current.revenue += row.revenue;
    current.received += row.received;
    current.writtenOff += row.writtenOff || 0;
    byGroup.set(key, current);
  }
  // Nhóm chỉ có một dòng thì dòng cộng lặp lại y hệt dòng chi tiết — bỏ cho đỡ nhiễu.
  return [...byGroup.values()]
    .filter((row) => row.count > 1)
    .map((row) => {
      const remaining = Math.round(row.revenue - row.received - row.writtenOff);
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
 * Nằm ở đầu tab Tiền về đủ chưa (chuyển từ tab Thu chi ngày theo yêu cầu 05/09/2026):
 * đối soát tiền về là việc của kế toán; thu ngân kết ca không cần lăn tăn các con số này.
 * Dữ liệu vẫn lấy từ báo cáo thu chi ngày nên `showContextLine` nói rõ đang xem ngày/ca nào —
 * tab đối soát lọc theo tháng, không có dòng này thì người xem tưởng bảng cũng theo tháng.
 */
function MoneyInReconciliationPanel({ dailyCash, showContextLine }: { dailyCash: DailyCashData; showContextLine?: boolean }) {
  return (
    <>
      {showContextLine && (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-semibold text-slate-600">
          Đối chiếu ngày {new Date(dailyCash.reportDate).toLocaleDateString("vi-VN")} · {shiftLabels[dailyCash.shift] || dailyCash.shift} · {dailyCash.branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(dailyCash.branchCode)} — đổi ngày/ca ở thanh lọc phía trên.
        </p>
      )}
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
            subtitle="Tiền đã vào ngân hàng và đã ghi nhận trên sao kê, nhưng chưa lập được chứng từ nên chưa lên Sổ quỹ. Không mất dòng nào. Bấm “Vào sổ” ở cột cuối để mở đúng dòng đó trên Sổ sao kê và ghi nhận."
          />
          <Table headers={["Ngày giao dịch", "Mã giao dịch", "Diễn giải", "Số tiền", "Vì sao chưa vào sổ", ""]}>
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
                <Cell>
                  {/* Mở Sổ sao kê lọc đúng mã giao dịch: nút "Vào sổ" nằm ngay trên dòng đó. */}
                  <a
                    href={`/reconciliations?q=${encodeURIComponent(row.transactionCode)}`}
                    className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-bold text-amber-800 hover:bg-amber-50"
                  >
                    Vào sổ →
                  </a>
                </Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </>
  );
}

/**
 * Ô nhập Ghi chú của một dòng doanh thu.
 *
 * Giữ chữ đang gõ trong state riêng và chỉ gọi máy chủ khi rời ô (hoặc bấm Enter) — gọi theo
 * từng phím gõ thì mỗi chữ cái là một lần lưu kèm một lần tải lại cả bảng.
 *
 * Ghi chú từ bên ngoài đổi (tải lại bảng) thì đồng bộ ngay trong lúc render thay vì qua
 * useEffect: chỉnh state theo prop bằng effect sẽ render hai lượt, và React khuyến nghị đúng
 * cách so-với-lượt-trước này.
 */
function NoteInput({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (note: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(value);
  }

  const commit = () => {
    if (draft.trim() === value.trim()) return;
    onCommit(draft.trim());
  };

  return (
    <input
      className="w-40 rounded border border-slate-300 bg-white px-1.5 py-1 text-xs disabled:opacity-50"
      value={draft}
      disabled={disabled}
      placeholder="Ghi chú..."
      maxLength={500}
      title="Ghi chú tự do cho dòng này — lưu khi bấm ra ngoài hoặc nhấn Enter"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { setDraft(value); event.currentTarget.blur(); }
      }}
    />
  );
}

/**
 * Ô so sánh với cùng kỳ tháng trước: số của tháng trước ở trên, mức tăng giảm ở dưới.
 *
 * Tháng trước bằng 0 thì KHÔNG hiện "+100%" — chia cho 0 ra một con số vô nghĩa, mà ngày đó
 * có thể chỉ là chưa import hoặc nghỉ bán chứ không phải tăng trưởng thật. Hiện "chưa có số"
 * để người đọc tự hiểu là không so được.
 */
function RevenueComparison({ current, previous }: { current: number; previous: number }) {
  if (previous <= 0) {
    return (
      <span className="text-slate-300" title="Cùng ngày tháng trước không có doanh thu nào được import">
        —
      </span>
    );
  }
  const delta = current - previous;
  const percent = Math.round((delta / previous) * 100);
  const tone = delta > 0 ? "text-emerald-700" : delta < 0 ? "text-rose-600" : "text-slate-400";
  return (
    <span className="inline-block whitespace-nowrap text-right">
      <span className="text-slate-500">{money(previous)}</span>
      <span className={`mt-0.5 block text-xs font-bold ${tone}`}>
        {delta > 0 ? "▲" : delta < 0 ? "▼" : "="} {delta === 0 ? "0%" : `${percent > 0 ? "+" : ""}${percent}%`}
      </span>
    </span>
  );
}

/**
 * Sổ doanh thu: mỗi ngày bán tách sẵn theo từng kênh, bấm vào dòng thì xoè ra từng dòng hoá đơn.
 *
 * Chi tiết nạp riêng lúc bấm chứ không gửi kèm bảng tổng — doanh thu POS có thể tới hàng chục
 * nghìn dòng mỗi năm. Đã nạp rồi thì giữ lại, bấm đóng mở lại không gọi mạng lần nữa.
 */
function RevenueLedgerPanel({ data, branchCode, moneySources, canEdit, onSaved }: {
  data: RevenueLedgerData;
  branchCode: string;
  moneySources: MoneySourceOption[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RevenueLedgerDetailRow[]>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [revenueCategories, setRevenueCategories] = useState<MasterDataOption[]>([]);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  // Danh mục Nguồn doanh thu chỉ cần cho ô sửa nên nạp ngay trong panel, không kéo thêm một
  // lượt tải vào những tab không dùng tới.
  useEffect(() => {
    if (!canEdit) return;
    let alive = true;
    void (async () => {
      const response = await fetch("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE");
      if (!response.ok || !alive) return;
      const payload = (await response.json()) as MasterDataOption[];
      if (alive) setRevenueCategories(payload.filter((item) => isRevenueGroupCategory(item.group)));
    })();
    return () => { alive = false; };
  }, [canEdit]);

  /**
   * Lưu lại phân loại của một dòng hoá đơn rồi tải lại cả bảng: đổi Nguồn doanh thu hay Nguồn
   * tiền là đổi luôn số tổng của ngày đó, giữ nguyên bảng cũ sẽ cho người dùng nhìn số sai.
   */
  const saveRow = async (detail: RevenueLedgerDetailRow, patch: { revenueSource?: string; paymentMethod?: string; note?: string }) => {
    setSavingRowId(detail.id);
    setRowError(null);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "UPDATE_REVENUE_ROW", id: detail.id, ...patch }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setRowError(payload.error || "Không sửa được dòng doanh thu");
        return;
      }
      setDetails((current) => {
        const next: Record<string, RevenueLedgerDetailRow[]> = {};
        for (const [key, rows] of Object.entries(current)) {
          next[key] = rows.map((row) => (row.id === detail.id ? { ...row, ...patch } : row));
        }
        return next;
      });
      onSaved();
    } finally {
      setSavingRowId(null);
    }
  };

  const dayLabel = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("vi-VN", { timeZone: "UTC" });

  const toggleRow = async (row: RevenueLedgerRow) => {
    const key = `${row.date}|${row.channel}`;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);
    if (details[key]) return;
    setLoadingKey(key);
    try {
      const params = new URLSearchParams({ type: "revenue-ledger-detail", date: row.date, branchCode, channel: row.channel });
      const response = await fetch(`/api/reports?${params.toString()}`);
      if (response.ok) {
        const payload = (await response.json()) as { rows: RevenueLedgerDetailRow[] };
        setDetails((current) => ({ ...current, [key]: payload.rows }));
      }
    } finally {
      setLoadingKey(null);
    }
  };

  // Cột tổng cuối bảng và nhóm ngày: mỗi ngày hiện tên ngày ở dòng kênh đầu tiên rồi thôi,
  // đọc dọc xuống không bị lặp lại ngày ở từng dòng như bảng thô.
  const byDay = new Map<string, RevenueLedgerRow[]>();
  for (const row of data.rows) byDay.set(row.date, [...(byDay.get(row.date) || []), row]);

  return (
    <div className="space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Doanh thu thuần" value={data.totals.netAmount} icon="point_of_sale" tone="green" />
        <Kpi label="Doanh thu gộp" value={data.totals.grossAmount} icon="receipt_long" />
        <Kpi label="Giảm giá" value={data.totals.discountAmount} icon="sell" tone="amber" />
        <Kpi label="Cùng kỳ tháng trước" value={data.totals.previousNetAmount} icon="calendar_month" />
      </section>

      <section className="table-panel">
        <PanelHeader
          title="Sổ doanh thu"
          subtitle={`Từ ${dayLabel(data.dateFrom)} đến ${dayLabel(data.dateTo)}. Mỗi ngày bán tách sẵn theo từng kênh bán, lấy thẳng từ file import POS — cùng nguồn với dòng Doanh thu của P&L. Bấm vào một dòng để xem từng hoá đơn của ngày đó${canEdit ? ", sửa lại Nguồn doanh thu / Nguồn tiền nếu file khai nhầm, và ghi chú lại dòng nào đã soát" : ""}. Cột Ghi chú đếm số dòng đã có ghi chú trong ô đó.`}
          exportFileName="so_doanh_thu"
        />
        <Table headers={["Ngày", "Kênh bán", "Ghi chú", "Hoá đơn", "Doanh thu gộp", "Giảm giá", "VAT", "Phụ thu SVC", "Phí thẻ", "Phí app", "Doanh thu thuần", "Cùng kỳ tháng trước"]}>
          {data.rows.length === 0 && (
            <tr className="border-t border-slate-100">
              <Cell>Chưa có doanh thu nào trong khoảng ngày này.</Cell>
              <Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell right>-</Cell>
            </tr>
          )}
          {[...byDay.entries()].flatMap(([day, rows]) => rows.flatMap((row, index) => {
            const key = `${row.date}|${row.channel}`;
            const isOpen = expanded === key;
            const detailRows = details[key] || [];
            return [
              <tr
                key={key}
                onClick={() => void toggleRow(row)}
                className={`cursor-pointer border-t hover:bg-slate-50 ${index === 0 ? "border-t-slate-200" : "border-t-slate-100"} ${isOpen ? "bg-blue-50/60" : ""}`}
              >
                <Cell>{index === 0 ? <b>{dayLabel(day)}</b> : <span className="text-slate-300">·</span>}</Cell>
                <Cell>
                  <span className="inline-flex items-center gap-1">
                    <span className={`material-symbols-outlined text-sm text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}>chevron_right</span>
                    <b>{row.channel}</b>
                  </span>
                </Cell>
                <Cell>
                  {row.noteCount > 0 ? (
                    <span className="inline-flex items-center gap-0.5 text-xs font-bold text-amber-700" title={`${row.noteCount} dòng trong ô này đã có ghi chú`}>
                      <span className="material-symbols-outlined text-sm">sticky_note_2</span>
                      {row.noteCount}
                    </span>
                  ) : <span className="text-slate-300">—</span>}
                </Cell>
                <Cell right>{row.orderCount > 0 ? money(row.orderCount) : <span className="text-slate-300">—</span>}</Cell>
                <Cell right>{money(row.grossAmount)}</Cell>
                <Cell right>{row.discountAmount ? <span className="text-amber-700">{money(row.discountAmount)}</span> : <span className="text-slate-300">—</span>}</Cell>
                <Cell right>{row.vatAmount ? money(row.vatAmount) : <span className="text-slate-300">—</span>}</Cell>
                <Cell right>{row.serviceAmount ? money(row.serviceAmount) : <span className="text-slate-300">—</span>}</Cell>
                <Cell right>{row.cardFeeAmount ? <span className="text-rose-600">{money(row.cardFeeAmount)}</span> : <span className="text-slate-300">—</span>}</Cell>
                <Cell right>{row.appFeeAmount ? <span className="text-rose-600">{money(row.appFeeAmount)}</span> : <span className="text-slate-300">—</span>}</Cell>
                <Cell right><b className="text-emerald-700">{money(row.netAmount)}</b></Cell>
                <Cell right><RevenueComparison current={row.netAmount} previous={row.previousNetAmount} /></Cell>
              </tr>,
              ...(isOpen ? [(
                // data-no-export: Xuất Excel đọc thẳng DOM, mà cả bảng chi tiết nằm gọn trong
                // một ô colSpan nên sẽ bị dồn thành một chuỗi chữ dài vô nghĩa. Bỏ dòng xoè ra
                // khỏi file xuất để bản Excel đúng bằng bảng tổng người dùng đang nhìn.
                <tr key={`${key}-detail`} data-no-export className="border-t border-slate-100 bg-slate-50/60">
                  <td colSpan={12} className="px-4 py-3">
                    {rowError && <p className="mb-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs font-bold text-rose-700">{rowError}</p>}
                    {loadingKey === key ? (
                      <p className="text-xs text-slate-500">Đang tải chi tiết...</p>
                    ) : detailRows.length === 0 ? (
                      <p className="text-xs text-slate-500">Không có dòng chi tiết nào.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="text-slate-500 uppercase">
                            <tr>
                              {["Mã hoá đơn", "Nguồn doanh thu", "Phương thức", "Bộ phận", "Mặt hàng", "Ghi chú", "SL", "Gộp", "Giảm giá", "VAT", "SVC", "Phí thẻ", "Phí app", "Thuần"].map((label, columnIndex) => (
                                <th key={label} className={`px-2 py-1.5 whitespace-nowrap ${columnIndex >= 6 ? "text-right" : ""}`}>{label}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {detailRows.map((detail) => (
                              <tr key={detail.id} className="border-t border-slate-200/70">
                                <td className="px-2 py-1.5 font-bold whitespace-nowrap">{detail.externalRef}</td>
                                <td className="px-2 py-1.5 whitespace-nowrap">
                                  {canEdit ? (
                                    <select
                                      className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs disabled:opacity-50"
                                      value={detail.revenueSource}
                                      disabled={savingRowId === detail.id}
                                      onChange={(event) => void saveRow(detail, { revenueSource: event.target.value })}
                                      title="Chọn lại nhóm doanh thu nếu file import khai nhầm"
                                    >
                                      {/* Giá trị cũ do file để lại có thể không nằm trong danh mục — giữ lại
                                          làm một lựa chọn để ô không tự nhảy sang mã khác khi mở ra. */}
                                      {!revenueCategories.some((item) => item.code === detail.revenueSource) && (
                                        <option value={detail.revenueSource}>{detail.revenueSource} (ngoài danh mục)</option>
                                      )}
                                      {revenueCategories.map((item) => (
                                        <option key={item.id} value={item.code}>[{item.code}] {item.name}</option>
                                      ))}
                                    </select>
                                  ) : detail.revenueSource}
                                </td>
                                <td className="px-2 py-1.5 whitespace-nowrap">
                                  {canEdit ? (
                                    <select
                                      className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs disabled:opacity-50"
                                      value={detail.paymentMethod}
                                      disabled={savingRowId === detail.id}
                                      onChange={(event) => void saveRow(detail, { paymentMethod: event.target.value })}
                                      title="Chọn lại nguồn tiền chi tiết nếu file import khai nhầm"
                                    >
                                      {!filterMoneySources(moneySources, detail.branchCode).some((item) => item.code === detail.paymentMethod) && (
                                        <option value={detail.paymentMethod}>{detail.paymentMethod} (ngoài danh mục)</option>
                                      )}
                                      {filterMoneySources(moneySources, detail.branchCode).map((item) => (
                                        <option key={item.id} value={item.code}>{moneySourceDisplayName(item, storeLabel(detail.branchCode))}</option>
                                      ))}
                                    </select>
                                  ) : detail.paymentMethod}
                                </td>
                                <td className="px-2 py-1.5 whitespace-nowrap">{detail.departmentCode || "—"}</td>
                                <td className="px-2 py-1.5 whitespace-nowrap">{detail.productCode || "—"}</td>
                                <td className="px-2 py-1.5">
                                  {canEdit ? (
                                    <NoteInput
                                      value={detail.note || ""}
                                      disabled={savingRowId === detail.id}
                                      onCommit={(note) => void saveRow(detail, { note })}
                                    />
                                  ) : (detail.note || <span className="text-slate-300">—</span>)}
                                </td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{detail.productQuantity ? money(detail.productQuantity) : "—"}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{money(detail.grossAmount)}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{detail.discountAmount ? money(detail.discountAmount) : "—"}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{detail.vatAmount ? money(detail.vatAmount) : "—"}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{detail.serviceAmount ? money(detail.serviceAmount) : "—"}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{detail.cardFeeAmount ? money(detail.cardFeeAmount) : "—"}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap">{detail.appFeeAmount ? money(detail.appFeeAmount) : "—"}</td>
                                <td className="px-2 py-1.5 text-right whitespace-nowrap font-bold text-emerald-700">{money(detail.netAmount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </td>
                </tr>
              )] : []),
            ];
          }))}
          {data.rows.length > 0 && (
            <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
              <Cell><b>Tổng cộng</b></Cell>
              <Cell><span className="text-slate-500">{byDay.size} ngày</span></Cell>
              <Cell>{data.totals.noteCount > 0 ? <span className="text-amber-700">{data.totals.noteCount} ghi chú</span> : "—"}</Cell>
              <Cell right>{data.totals.orderCount > 0 ? money(data.totals.orderCount) : "—"}</Cell>
              <Cell right>{money(data.totals.grossAmount)}</Cell>
              <Cell right>{money(data.totals.discountAmount)}</Cell>
              <Cell right>{money(data.totals.vatAmount)}</Cell>
              <Cell right>{money(data.totals.serviceAmount)}</Cell>
              <Cell right>{money(data.totals.cardFeeAmount)}</Cell>
              <Cell right>{money(data.totals.appFeeAmount)}</Cell>
              <Cell right><b className="text-emerald-700">{money(data.totals.netAmount)}</b></Cell>
              <Cell right><RevenueComparison current={data.totals.netAmount} previous={data.totals.previousNetAmount} /></Cell>
            </tr>
          )}
        </Table>
      </section>
    </div>
  );
}

function RevenueSettlementPanel({ data, canLink, onLinked }: { data: RevenueSettlementData; canLink: boolean; onLinked: () => void }) {
  const dayLabel = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("vi-VN", { timeZone: "UTC" });
  /**
   * Bấm vào số "Tiền đã vô" là mở đúng những dòng sổ sao kê đã cộng thành số đó.
   *
   * Ngày báo VỀ DƯ thường là một lần quẹt gộp cả tiền bán hàng lẫn tiền thu hộ, hoặc ngân hàng
   * trả gộp nhiều ngày — cả hai đều sửa ngay trên dòng sao kê (nút "Tách / sửa dòng"), chứ mở
   * chứng từ ra sửa thì bảng này không đổi số: nó đọc sổ sao kê, không đọc chứng từ.
   */
  const looseVouchers = data.looseVouchers || [];
  // Chỉ tự nối hàng loạt những phiếu có đúng MỘT dòng khớp chắc (đúng nguồn tiền, lệch ≤ 3
  // ngày). Dòng lệch xa hay khác nguồn vẫn hiện nút Nối riêng để kế toán tự quyết từng cái.
  const linkableVouchers = looseVouchers.filter((voucher) => voucher.candidates.length === 1 && voucher.candidates[0].exact);
  const [linking, setLinking] = useState("");
  const [linkError, setLinkError] = useState("");
  // Phiếu được tick để dựng dòng sao kê hàng loạt. Chỉ tick được phiếu CHƯA tìm ra dòng sao kê
  // nào: phiếu đã có ứng viên thì bấm Nối là đúng hơn, dựng thêm dòng là tự tạo dữ liệu thừa.
  const [pickedVouchers, setPickedVouchers] = useState<string[]>([]);
  const [drafting, setDrafting] = useState(false);
  const draftableVouchers = looseVouchers.filter((voucher) => voucher.candidates.length === 0 && (voucher.takenLines || []).length === 0);
  const pickedDraftables = draftableVouchers.filter((voucher) => pickedVouchers.includes(voucher.id));

  /**
   * MỌI dòng còn thiếu tiền được đẩy lên khung phía trên để kế toán soát, không chỉ khoản
   * chênh vài đồng.
   *
   * Bản đầu chỉ gom chênh dưới 1.000 đ, nhưng khách chốt 21/09/2026: người xem cần thấy hết
   * các dòng VỀ THIẾU ở một chỗ rồi tự phán — đúng là thiếu thật thì tick đưa vào chi phí,
   * không phải thì đi dò lại phiếu tiền mặt / chứng từ ngân hàng / doanh thu của ngày đó.
   * Chặn cứng ở 1.000 đ khiến dòng thiếu 1.603 đ (VỀ THIẾU, đúng thứ cần soát nhất) lại không
   * lọt vào khung.
   *
   * Vẫn chỉ nhận chênh DƯƠNG và đã có tiền về: dòng chưa về đồng nào là tiền chưa thu chứ
   * không phải khoản chênh, ghi thẳng vào chi phí ở đây là xoá sổ một khoản phải đòi.
   */
  const writeOffRows = data.rows.filter((row) => row.remaining > 0 && row.received > 0 && row.branchCode);
  const writeOffKey = (row: RevenueSettlementRow) => `${row.date}|${row.moneySourceCode}`;
  const [pickedWriteOffs, setPickedWriteOffs] = useState<string[]>([]);
  const [writeOffCategory, setWriteOffCategory] = useState("");
  const [writingOff, setWritingOff] = useState(false);
  const pickedWriteOffRows = writeOffRows.filter((row) => pickedWriteOffs.includes(writeOffKey(row)));
  const pickedWriteOffTotal = pickedWriteOffRows.reduce((sum, row) => sum + row.remaining, 0);

  const writeOffDifferences = async () => {
    if (pickedWriteOffRows.length === 0 || !writeOffCategory) return;
    if (!window.confirm(`Đưa ${money(pickedWriteOffTotal)} đ của ${pickedWriteOffRows.length} dòng vào chi phí? Khoản này chỉ lên Tổng hợp chi phí và P&L, không trừ vào số dư nguồn tiền.`)) return;
    setWritingOff(true);
    setLinkError("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_SETTLEMENT_ADJUSTMENTS",
          pnlItemCode: writeOffCategory,
          entries: pickedWriteOffRows.map((row) => ({
            entryDate: row.date,
            branchCode: row.branchCode,
            moneySourceCode: row.moneySourceCode,
            amount: row.remaining,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Không ghi được khoản chênh vào chi phí");
      setPickedWriteOffs([]);
      onLinked();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Không ghi được khoản chênh vào chi phí");
    } finally {
      setWritingOff(false);
    }
  };

  /**
   * Gỡ khoản chênh đã đưa vào chi phí của MỘT dòng, trả nó về đúng trạng thái VỀ THIẾU.
   *
   * Cần thiết vì khung phía trên giờ gom mọi dòng còn thiếu tiền, nên sẽ có lúc tick nhầm một
   * dòng thật ra là tiền chưa về. Gỡ xoá cả bút toán nên Tổng hợp chi phí và P&L tụt lại ngay,
   * không phải chờ Đồng bộ ghi sổ.
   */
  const [removingWriteOff, setRemovingWriteOff] = useState("");
  const removeWriteOff = async (row: RevenueSettlementRow) => {
    const amount = row.writtenOff || 0;
    if (amount <= 0) return;
    if (!window.confirm(`Gỡ ${money(amount)} đ khỏi chi phí? Dòng ${row.moneySourceName} ngày ${row.date} sẽ quay lại trạng thái còn thiếu tiền.`)) return;
    setRemovingWriteOff(writeOffKey(row));
    setLinkError("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "REMOVE_SETTLEMENT_ADJUSTMENTS",
          entries: [{ entryDate: row.date, branchCode: row.branchCode, moneySourceCode: row.moneySourceCode }],
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Không gỡ được khoản chênh khỏi chi phí");
      onLinked();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Không gỡ được khoản chênh khỏi chi phí");
    } finally {
      setRemovingWriteOff("");
    }
  };

  /**
   * Dựng dòng sao kê từ chính các phiếu đã tick rồi nối luôn — lối thoát khi sao kê của tài
   * khoản đó chưa import mà kế toán không muốn đi làm file Excel cho vài dòng.
   *
   * Dòng dựng ra mang nhãn "Dựng tay", vẫn là lời khai chứ không phải sao kê thật; khi file sao
   * kê thật được import sau thì dòng thật thay chỗ nó nên tiền không bị đếm hai lần.
   */
  const draftStatementRows = async () => {
    if (pickedDraftables.length === 0) return;
    if (!window.confirm(`Dựng ${pickedDraftables.length} dòng sao kê từ các phiếu đã chọn? Dòng dựng tay là lời khai, sẽ được sao kê thật thay thế khi bạn import file sau này.`)) return;
    setDrafting(true);
    setLinkError("");
    try {
      const response = await fetch("/api/reconciliations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "CREATE_STATEMENT_FROM_VOUCHERS", voucherIds: pickedDraftables.map((voucher) => voucher.id) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Không dựng được dòng sao kê");
      setPickedVouchers([]);
      onLinked();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Không dựng được dòng sao kê");
    } finally {
      setDrafting(false);
    }
  };

  /**
   * Nối phiếu lập tay vào một dòng sao kê: dùng đúng API đối soát của màn Sổ sao kê, nên luật
   * quyền và luật khớp số tiền vẫn do bên đó giữ. Nối xong tải lại báo cáo để số cập nhật ngay.
   */
  const linkVoucher = async (voucher: RevenueSettlementLooseVoucher, bankTransactionId: string) => {
    setLinking(voucher.code);
    setLinkError("");
    try {
      const response = await fetch("/api/reconciliations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankTransactionId,
          targetType: "VOUCHER",
          targetId: voucher.id,
          targetCode: voucher.code,
          targetAmount: voucher.amount,
          note: "Nối phiếu lập tay từ báo cáo Tiền về đủ chưa",
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Không nối được phiếu với dòng sao kê");
      onLinked();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Không nối được phiếu với dòng sao kê");
    } finally {
      setLinking("");
    }
  };

  /** Nối một lượt mọi phiếu chỉ có đúng một dòng sao kê khớp — phần việc tay lặp đi lặp lại. */
  const linkAllObvious = async () => {
    for (const voucher of linkableVouchers) {
      await linkVoucher(voucher, voucher.candidates[0].id);
    }
  };
  const ledgerHref = (row: RevenueSettlementRow) => `/reconciliations?${new URLSearchParams({
    dateType: "REVENUE",
    from: row.date,
    to: row.date,
    moneySource: row.moneySourceCode,
    branchCode: data.branchCode || "ALL",
  })}`;
  const byDay = new Map<string, RevenueSettlementRow[]>();
  for (const row of data.rows) byDay.set(row.date, [...(byDay.get(row.date) || []), row]);

  return (
    <div className="space-y-5">
      {looseVouchers.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-amber-700">report</span>
            <div className="min-w-0 flex-1">
              <h3 className="font-bold text-amber-900">
                {looseVouchers.length} phiếu thu bán hàng chưa có dòng sao kê đối chiếu · {money(data.totals.looseVoucherAmount || 0)} đ
              </h3>
              <p className="mt-1 text-xs leading-5 text-amber-900">
                Bảng này đọc <b>sổ sao kê ngân hàng</b>, không đọc chứng từ — sao kê mới là bằng chứng tiền đã về, còn phiếu lập tay là lời khai;
                đếm cả hai thì hôm import sao kê là cùng một khoản vào hai lần. Nên số tiền dưới đây <b>chưa</b>{" "}nằm trong cột &quot;Tiền đã vô&quot;.
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-900">
                Dòng nào tìm được dòng sao kê khớp thì bấm <b>Nối</b>: hệ thống lấy luôn <b>ngày tiền về làm Ngày doanh thu</b>{" "}(kèm Loại thu/chi và
                Trừ nguồn tiền theo phiếu), nên tiền hiện ra ngay ở đúng ngày đó — bán hàng ngày khác thì sửa lại bằng nút &quot;Tách / sửa dòng&quot; trên Sổ sao kê.
                Không có nút Nối nghĩa là chưa tìm thấy dòng sao kê nào cùng số tiền còn trống chứng từ — cột <b>&quot;Dòng sao kê khớp&quot;</b> nói rõ từng phiếu
                là do <b>sao kê chưa import</b> hay do <b>phiếu bị trùng</b> (dòng sao kê đã có chứng từ riêng, khi đó xoá phiếu lập tay đi).
              </p>
              {canLink && linkableVouchers.length > 0 && (
                <button
                  type="button"
                  disabled={Boolean(linking)}
                  onClick={() => void linkAllObvious()}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-[16px]">link</span>
                  {linking ? "Đang nối..." : `Nối tất cả ${linkableVouchers.length} phiếu có đúng một dòng khớp`}
                </button>
              )}
              {canLink && draftableVouchers.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={drafting || pickedDraftables.length === 0}
                    onClick={() => void draftStatementRows()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[16px]">playlist_add</span>
                    {drafting ? "Đang dựng..." : `Dựng dòng sao kê cho ${pickedDraftables.length || 0} phiếu đã chọn`}
                  </button>
                  <button
                    type="button"
                    className="text-xs font-bold text-blue-700 hover:underline"
                    onClick={() => setPickedVouchers(pickedDraftables.length === draftableVouchers.length ? [] : draftableVouchers.map((voucher) => voucher.id))}
                  >
                    {pickedDraftables.length === draftableVouchers.length ? "Bỏ chọn tất cả" : `Chọn tất cả ${draftableVouchers.length} phiếu chưa có sao kê`}
                  </button>
                  <span className="text-[11px] text-amber-900">
                    Dùng khi sao kê của tài khoản đó chưa import: dòng dựng ra mang nhãn <b>Dựng tay</b> (vẫn là lời khai), và sẽ được
                    <b> sao kê thật thay thế</b> khi bạn import file sau này — không đếm hai lần.
                  </span>
                </div>
              )}
              {linkError && <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{linkError}</p>}

              <div className="mt-3 overflow-x-auto rounded-lg border border-amber-200 bg-white">
                <table className="w-full text-left text-xs">
                  <thead className="bg-amber-100/60 uppercase text-amber-900">
                    <tr><th className="px-3 py-2 w-8">{canLink && draftableVouchers.length > 0 ? "Chọn" : ""}</th><th className="px-3 py-2">Ngày</th><th className="px-3 py-2">Chứng từ</th><th className="px-3 py-2">Nguồn tiền</th><th className="px-3 py-2">Đối tác</th><th className="px-3 py-2 text-right">Số tiền</th><th className="px-3 py-2">Dòng sao kê khớp</th></tr>
                  </thead>
                  <tbody>
                    {looseVouchers.map((voucher) => (
                      <tr key={voucher.code} className="border-t border-amber-100">
                        <td className="px-3 py-2">
                          {canLink && voucher.candidates.length === 0 && (voucher.takenLines || []).length === 0 && (
                            <input
                              type="checkbox"
                              checked={pickedVouchers.includes(voucher.id)}
                              onChange={(e) => setPickedVouchers(e.target.checked
                                ? [...pickedVouchers, voucher.id]
                                : pickedVouchers.filter((id) => id !== voucher.id))}
                            />
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2">{dayLabel(voucher.date)}</td>
                        <td className="px-3 py-2"><a href="/bank-vouchers" className="font-bold text-blue-700 hover:underline">{voucher.code}</a></td>
                        <td className="px-3 py-2">{voucher.moneySourceName}<span className="ml-1 text-slate-400">{voucher.moneySourceCode}</span></td>
                        <td className="px-3 py-2">{voucher.partnerName || "—"}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-right font-bold tabular-nums">{money(voucher.amount)} đ</td>
                        <td className="px-3 py-2">
                          {voucher.candidates.length > 0
                            ? voucher.candidates.map((candidate) => (
                                <span key={candidate.id} className="mr-2 inline-flex items-center gap-1.5">
                                  <span className="font-semibold">{candidate.transactionCode}</span>
                                  <span className="text-slate-400">{dayLabel(candidate.transactionDate)} · {candidate.bankAccount}</span>
                                  {!candidate.exact && (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">
                                      {candidate.dayGap > 0 ? `lệch ${candidate.dayGap} ngày` : ""}
                                      {candidate.dayGap > 0 && candidate.sourceMismatch ? " · " : ""}
                                      {candidate.sourceMismatch ? "khác nguồn tiền" : ""}
                                    </span>
                                  )}
                                  {canLink && (
                                    <button
                                      type="button"
                                      disabled={Boolean(linking)}
                                      onClick={() => void linkVoucher(voucher, candidate.id)}
                                      className="rounded border border-emerald-300 bg-white px-2 py-0.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                                    >
                                      {linking === voucher.code ? "Đang nối..." : "Nối"}
                                    </button>
                                  )}
                                </span>
                              ))
                            : (voucher.takenLines || []).length > 0
                              ? (
                                <span className="text-slate-500">
                                  Dòng {(voucher.takenLines || []).map((line) => line.transactionCode).join(", ")} cùng số tiền nhưng <b>đã có chứng từ</b>
                                  {(voucher.takenLines || [])[0]?.voucherCode ? ` ${(voucher.takenLines || [])[0].voucherCode}` : ""} — phiếu này là bản trùng,{" "}
                                  <a href="/bank-vouchers" className="font-bold text-blue-700 hover:underline">xoá phiếu lập tay</a>.
                                </span>
                              )
                              : <span className="text-slate-400">Không có dòng sao kê nào cùng số tiền ở cửa hàng này — <b>sao kê của tài khoản đó chưa import</b>. Import xong hệ thống tự nối.</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      )}

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
          subtitle="Mỗi ngày, mỗi phương thức thanh toán: doanh thu ghi nhận bao nhiêu, tiền thực về bao nhiêu, phần chênh là phí thu hộ hay tiền chưa về. Doanh thu lấy từ import POS, tiền về lấy từ sổ sao kê — hai luồng độc lập. Bill trả bằng tiền cọc (cấn trừ / chuyển doanh thu) được cộng vào tiền đã vô của ngày cấn trừ, vì khách đã chuyển tiền từ ngày đặt cọc. Dòng “Cộng theo Nhóm/Loại” gộp các nguồn chi tiết lại để biết cả nhóm đã thu đủ tiền chưa, kể cả khi ngân hàng trả gộp nhiều nguồn trong một lần chuyển."
        />
        {writeOffRows.length > 0 && (
          <div className="mx-5 mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[260px]">
                <b className="text-sm text-amber-900">
                  {writeOffRows.length} dòng còn thiếu tiền ({money(writeOffRows.reduce((sum, row) => sum + row.remaining, 0))} đ)
                </b>
                <p className="mt-0.5 text-xs text-amber-800">
                  Soát từng dòng trước khi tick: <b>đúng là khách trả thiếu</b> thì tick rồi chọn hạng mục P&L để ghi
                  thẳng vào chi phí; <b>chưa chắc</b> thì dò lại phiếu tiền mặt, chứng từ ngân hàng và doanh thu của
                  ngày đó — có thể là tiền chưa về hoặc chứng từ còn thiếu.
                </p>
                <p className="mt-0.5 text-xs text-amber-700">
                  Khoản đưa vào chi phí chỉ lên Tổng hợp chi phí và P&L, <b>không sinh phiếu ở Sổ quỹ</b>: tiền về đã
                  ghi theo số thực nhận trên sao kê nên không có gì để trừ ra nữa.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPickedWriteOffs(pickedWriteOffs.length === writeOffRows.length ? [] : writeOffRows.map(writeOffKey))}
                className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100"
              >
                {pickedWriteOffs.length === writeOffRows.length ? "Bỏ chọn tất cả" : "Chọn tất cả"}
              </button>
              <select
                value={writeOffCategory}
                onChange={(event) => setWriteOffCategory(event.target.value)}
                className="rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-900"
                aria-label="Hạng mục P&L cho khoản chênh"
              >
                <option value="">-- Chọn hạng mục P&L --</option>
                {(data.expensePnlItems || []).map((item) => (
                  <option key={item.code} value={item.code}>{item.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void writeOffDifferences()}
                disabled={writingOff || pickedWriteOffRows.length === 0 || !writeOffCategory}
                title={!writeOffCategory ? "Chọn hạng mục P&L trước" : pickedWriteOffRows.length === 0 ? "Tick ít nhất một dòng" : undefined}
                className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-bold text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {writingOff ? "Đang ghi..." : `Đưa vào chi phí (${pickedWriteOffRows.length})`}
              </button>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          <Table headers={[writeOffRows.length > 0 ? "" : "·", "Ngày", "Phương thức thanh toán", "Loại nguồn", "Doanh thu trong ngày", "Tiền đã vô", "Còn lại", "Tên chi phí", "Trạng thái"]}>
            {data.rows.length === 0 && (
              <tr className="border-t border-slate-100">
                <Cell>-</Cell>
                <Cell>Chưa có doanh thu hoặc tiền về trong kỳ.</Cell>
                <Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell>-</Cell><Cell right>-</Cell>
              </tr>
            )}
            {[...byDay.entries()].map(([day, rows]) => [
              ...rows.map((row, index) => (
                <tr key={`${row.date}-${row.moneySourceCode}`} className={`border-t border-slate-100 hover:bg-slate-50 ${index === 0 ? "border-t-slate-200" : ""}`}>
                  <Cell>
                    {writeOffRows.some((candidate) => writeOffKey(candidate) === writeOffKey(row)) ? (
                      <input
                        type="checkbox"
                        checked={pickedWriteOffs.includes(writeOffKey(row))}
                        onChange={(event) => setPickedWriteOffs(event.target.checked
                          ? [...pickedWriteOffs, writeOffKey(row)]
                          : pickedWriteOffs.filter((key) => key !== writeOffKey(row)))}
                        aria-label={`Chọn khoản chênh ${row.moneySourceName} ngày ${dayLabel(row.date)}`}
                      />
                    ) : <span className="text-slate-200">·</span>}
                  </Cell>
                  <Cell>{index === 0 ? <b>{dayLabel(day)}</b> : <span className="text-slate-300">·</span>}</Cell>
                  <Cell><b>{row.moneySourceName}</b><p className="mt-0.5 text-xs text-slate-500">{row.moneySourceCode}</p></Cell>
                  <Cell><SourceGroupTag group={row.group} /></Cell>
                  <Cell right>{money(row.revenue)} đ</Cell>
                  <Cell right>
                    <a href={ledgerHref(row)} title="Mở sổ sao kê đúng ngày doanh thu và nguồn tiền này để soát/tách lại dòng tiền về" className="font-semibold text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-800">
                      {money(row.received)} đ
                    </a>
                    {row.depositApplied > 0 && (
                      <p className="mt-0.5 text-xs text-slate-500">gồm {money(row.depositApplied)} đ cọc cấn trừ</p>
                    )}
                  </Cell>
                  <Cell right>
                    <b className={row.remaining > 0 ? "text-amber-700" : row.remaining < 0 ? "text-rose-600" : "text-slate-400"}>
                      {money(row.remaining)} đ
                    </b>
                    {(row.writtenOff || 0) > 0 && (
                      <p className="mt-0.5 text-xs text-slate-500">
                        đã đưa {money(row.writtenOff || 0)} đ vào chi phí
                        <button
                          type="button"
                          onClick={() => void removeWriteOff(row)}
                          disabled={removingWriteOff === writeOffKey(row)}
                          title="Gỡ khoản này khỏi chi phí, trả dòng về trạng thái còn thiếu tiền"
                          className="ml-1.5 rounded border border-slate-300 px-1.5 py-0.5 text-[11px] font-bold text-slate-600 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                        >
                          {removingWriteOff === writeOffKey(row) ? "Đang gỡ..." : "Gỡ"}
                        </button>
                      </p>
                    )}
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
                  <Cell><span className="text-slate-200">·</span></Cell>
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
                <Cell><span className="text-slate-200">·</span></Cell>
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
  // Khách dùng dòng TỔNG để soi ngược lên hai bảng Tổng quan thu/chi. Hai con số nay bằng nhau
  // theo cấu trúc (mọi khoản đi qua cùng một cửa ghi nhận), nên còn lệch là dấu hiệu dữ liệu
  // hỏng chứ không phải chuyện bình thường — phải nói rõ thay vì giấu đi.
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
        subtitle="Cột Thu/Chi là chính hai bảng Tổng quan thu/chi ở trên tách theo từng nguồn tiền, nên dòng TỔNG luôn bằng Tổng thu/Tổng chi. Điều tiền nội bộ KHÔNG nằm trong Thu/Chi mà ở dòng ghi chú riêng của từng nguồn. Ví/cổng thanh toán chỉ hiện khi có phát sinh trong kỳ. Dự thu là doanh thu ví chưa quyết toán về ngân hàng, dự chi là phiếu chi còn nháp/chờ duyệt — cả hai chưa vào số dư Cuối kỳ."
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
                  <> Hai bảng lấy chung một nguồn ghi nhận nên bình thường phải khớp tuyệt đối.
                  Còn lệch nghĩa là có khoản thu/chi chưa gắn được nguồn tiền — kiểm tra lại
                  nguồn tiền khai trên chứng từ và trên sổ sao kê của kỳ này.</>
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

/**
 * Báo cáo KQKD một kỳ, group cha - con như file Excel: mỗi dòng chỉ tiêu bung ra nhóm
 * hạng mục P&L (PNL_GROUP) rồi tới từng hạng mục (PNL_ITEM). Danh mục được nạp đủ nên
 * hạng mục chưa phát sinh trong kỳ vẫn hiện ở số 0 — bấm "Ẩn dòng bằng 0" để gọn lại.
 */
function PnlStatementTable({ period, branchCode, lines, value }: { period: string; branchCode: string; lines?: PnlStatementLine[]; value?: Pnl }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hideEmpty, setHideEmpty] = useState(false);
  if (!value) return null;
  const rows = lines || [];
  const revenue = value.revenue;
  const percent = (amount: number) => (revenue ? `${((amount / revenue) * 100).toFixed(1)}%` : "-");
  const isEmpty = (amount: number) => Math.abs(amount) <= 0.5;
  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  const setAll = (nextCollapsed: boolean) => {
    const next: Record<string, boolean> = {};
    if (nextCollapsed) {
      for (const line of rows) {
        if (line.groups.length > 0) next[line.key] = true;
        for (const group of line.groups) if (group.items.length > 0) next[`${line.key}:${group.code}`] = true;
      }
    }
    setCollapsed(next);
  };

  const exportExcel = async () => {
    // xlsx chỉ nạp khi bấm xuất — giống tab P&L 12 tháng, tránh cộng vào bundle trang báo cáo.
    const XLSX = await import("xlsx");
    const data: Array<Array<string | number>> = [["Chỉ tiêu", "Số tiền (VND)", "% doanh thu"]];
    const push = (prefix: string, label: string, amount: number) => data.push([`${prefix}${label}`, Math.round(amount), revenue ? Number(((amount / revenue) * 100).toFixed(2)) : 0]);
    for (const line of rows) {
      push("", line.label, line.amount);
      for (const group of line.groups) {
        if (hideEmpty && isEmpty(group.amount)) continue;
        push("    ", group.name, group.amount);
        for (const item of group.items) {
          if (hideEmpty && isEmpty(item.amount)) continue;
          push("        ", `${item.code} - ${item.name}`, item.amount);
        }
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, `KQKD ${period}`);
    XLSX.writeFile(workbook, `kqkd_${period}_${branchCode}.xlsx`);
  };

  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold">Báo cáo Kết quả Kinh doanh</h2>
          <p className="text-xs text-slate-500 mt-0.5">Đơn vị: VND. Bấm tên chỉ tiêu hoặc tên nhóm để mở/thu gọn hạng mục P&L bên dưới.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />
            Ẩn dòng bằng 0
          </label>
          <button type="button" onClick={() => setAll(false)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50">Mở tất cả</button>
          <button type="button" onClick={() => setAll(true)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50">Thu gọn tất cả</button>
          <button type="button" onClick={() => void exportExcel()} className="flex items-center gap-1 text-xs font-bold text-blue-700 border border-blue-200 rounded px-3 py-1.5 hover:bg-blue-50">
            <span className="material-symbols-outlined text-base">download</span>Xuất Excel
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table headers={["Chỉ tiêu", "Số tiền (VND)", "% doanh thu"]}>
          {rows.map((line) => {
            const lineCollapsed = collapsed[line.key];
            const groups = hideEmpty ? line.groups.filter((group) => !isEmpty(group.amount)) : line.groups;
            return (
              <React.Fragment key={line.key}>
                <tr
                  className={`border-t border-slate-200 ${line.subtotal ? "bg-blue-50/60 font-bold" : "bg-slate-50 font-bold"} ${groups.length > 0 ? "cursor-pointer hover:bg-slate-100" : ""}`}
                  onClick={groups.length > 0 ? () => toggle(line.key) : undefined}
                >
                  <Cell>
                    <span className="flex items-center gap-1">
                      {groups.length === 0
                        ? <span className="w-4" />
                        : <span className="material-symbols-outlined text-base text-slate-400">{lineCollapsed ? "chevron_right" : "expand_more"}</span>}
                      {line.label}
                    </span>
                  </Cell>
                  <Cell right><span className={line.subtotal ? (line.amount < 0 ? "text-rose-600" : "text-blue-700") : ""}>{money(line.amount)} đ</span></Cell>
                  <Cell right>{percent(line.amount)}</Cell>
                </tr>
                {!lineCollapsed && groups.map((group) => {
                  const groupKey = `${line.key}:${group.code}`;
                  const groupCollapsed = collapsed[groupKey];
                  const items = hideEmpty ? group.items.filter((item) => !isEmpty(item.amount)) : group.items;
                  return (
                    <React.Fragment key={groupKey}>
                      <tr
                        className={`border-t border-slate-100 ${group.code === "UNGROUPED" ? "bg-amber-50/60" : "bg-white"} ${items.length > 0 ? "cursor-pointer hover:bg-slate-50" : ""}`}
                        onClick={items.length > 0 ? () => toggle(groupKey) : undefined}
                      >
                        <Cell>
                          <span className="flex items-center gap-1 pl-6">
                            {items.length === 0
                              ? <span className="w-4" />
                              : <span className="material-symbols-outlined text-base text-slate-300">{groupCollapsed ? "chevron_right" : "expand_more"}</span>}
                            <b className="text-slate-700">{group.name}</b>
                          </span>
                        </Cell>
                        <Cell right><b>{money(group.amount)} đ</b></Cell>
                        <Cell right>{percent(group.amount)}</Cell>
                      </tr>
                      {!groupCollapsed && items.map((item) => (
                        <tr key={`${groupKey}:${item.code}`} className="border-t border-slate-100">
                          <Cell>
                            <span className="pl-16 text-slate-600">
                              {item.code !== "UNCLASSIFIED" && <span className="text-[11px] text-slate-400 mr-1.5">{item.code}</span>}
                              {item.name}
                            </span>
                          </Cell>
                          <Cell right>{money(item.amount)} đ</Cell>
                          <Cell right>{percent(item.amount)}</Cell>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </Table>
      </div>
    </section>
  );
}

function CutTable({ title, rows }: { title: string; rows?: PnlCut[] }) {
  if (!rows || rows.length === 0) return null;
  return (
    <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <PanelHeader title={title} subtitle="Chi tiết doanh thu, chi phí và lợi nhuận hoạt động" />
      <Table headers={["Đơn vị", "Doanh thu", "Giá vốn", "Lợi nhuận gộp", "LN hoạt động"]}>
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
