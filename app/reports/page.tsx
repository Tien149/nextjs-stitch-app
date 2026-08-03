"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput, MonthInput } from "@/components/DateInput";
import { storeLabel, visibleBranchScopeOptions, visibleStoreOptions } from "@/lib/branch-labels";
import { canPerformMenuAction, filterModuleTabs, moduleTabs } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import { filterMoneySources, firstMoneySourceCode, moneySourceDebugLabel, moneySourceDisplayName, type MoneySourceOption } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import { shiftLabel, shiftLabels } from "@/lib/shifts";

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
type BalanceRow = { code: string; name: string; accountType: string; reportGroup: string; amount: number };
type BalanceData = { rows: BalanceRow[]; assets: number; liabilities: number; contributedEquity: number; retainedEarnings: number; equity: number; difference: number; balanced: boolean };
type DashboardData = { pnl: { total: Pnl; byBranch: PnlCut[] }; trend: Array<Pnl & { period: string }>; balance: BalanceData; targets: Array<{ metric: string; targetValue: number }> };
type PnlData = { total: Pnl; byBranch: PnlCut[]; byDepartment: PnlCut[] };
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
  summary: { revenue: DailyCashBucket; posRevenue: DailyCashBucket; manual: DailyCashBucket; receipt: DailyCashBucket; deposit: DailyCashBucket; total: DailyCashBucket; expenseTotal: number; cashExpenseTotal: number; cashToDeposit: number };
  expenses: DailyCashExpense[];
  receipts: DailyCashReceipt[];
  manualEntries: ManualRevenueEntry[];
  duplicateRevenueWarning: boolean;
};
type ManualRevenueForm = { cashAmount: string; transferAmount: string; cardAmount: string; grabAmount: string; otherAmount: string; note: string };
type ActivityLog = { id: string; time: string; module: string; action: string; actor: string; branchCode: string; code: string; note: string };
type AccountingPeriodStatus = { period: string; branchCode: string; status: string; closedBy: string | null; closedAt: string | null; reopenedBy: string | null; reopenedAt: string | null; reason: string | null };
type ActivityData = { accountingPeriod: AccountingPeriodStatus; periods: AccountingPeriodStatus[]; logs: ActivityLog[] };
type ReportData = DashboardData | PnlData | YoyData | CashflowData | BalanceData | OperationsData | BudgetData | DailyCashData | ActivityData;
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
const manualRevenueFields: Array<{ key: keyof Omit<ManualRevenueForm, "note">; label: string; hint: string }> = [
  { key: "cashAmount", label: "Tiền mặt", hint: "Tiền khách trả mặt, còn trong két" },
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
  const [shift, setShift] = useState("FULL");
  const [branchCode, setBranchCode] = useState("ALL");
  const [scenario, setScenario] = useState("BASE");
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
  const canCreateCashDeposit = user ? canPerformMenuAction(user, "/finance-operations", "create") : false;
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
      const response = await fetch(`/api/reports?${params.toString()}`);
      if (response.ok) {
        const result = await response.json();
        setData(result);
      }
    } catch (e) {
      console.error("Error loading reports data:", e);
    } finally {
      setTabLoading(false);
    }
  }, [active, branchCode, period, reportDate, scenario, shift]);

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

  const cashDepositAmount = Math.max(0, Math.round(dailyCash?.summary.cashToDeposit || 0));
  const cashDepositDenominationTotal = cashDepositForm.denominations.reduce((sum, row) => {
    const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
    return sum + row.denomination * quantity;
  }, 0);
  const cashDepositCashSources = dailyCash ? filterMoneySources(moneySources, dailyCash.branchCode, ["CASH"]) : [];
  const cashDepositTargetSources = dailyCash
    ? filterMoneySources(moneySources, dailyCash.branchCode).filter((source) => source.code !== cashDepositForm.fromMoneySourceCode)
    : [];
  const cashDepositDefaultFromSourceCode = cashDepositCashSources[0]?.code || "";
  const cashDepositDefaultTargetSources = dailyCash
    ? filterMoneySources(moneySources, dailyCash.branchCode).filter((source) => source.code !== cashDepositDefaultFromSourceCode)
    : [];
  const cashDepositDisabledReason = !canCreateCashDeposit
    ? "Bạn không có quyền tạo phiếu nộp tiền."
    : !dailyCash
      ? "Chưa có dữ liệu báo cáo thu chi ngày."
      : dailyCash.branchCode === "ALL"
        ? "Chọn một cửa hàng cụ thể để nộp tiền."
        : cashDepositAmount <= 0
          ? "Ngày/ca này chưa có tiền mặt cần nộp."
          : cashDepositCashSources.length === 0
            ? "Chưa cấu hình nguồn tiền mặt cho cửa hàng này."
            : cashDepositDefaultTargetSources.length === 0
              ? "Chưa cấu hình nguồn tiền nhận cho cửa hàng này."
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
    const options = filterMoneySources(moneySources, reportBranchCode).filter((source) => source.code !== fromMoneySourceCode);
    return (
      options.find((source) => `${source.code} ${source.name}`.toUpperCase().includes(targetHint))?.code ||
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
    if (cashDepositAmount <= 0) {
      setMessage("Không có số tiền mặt cần nộp cho ngày/ca này.");
      return;
    }
    const fromMoneySourceCode = firstMoneySourceCode(moneySources, dailyCash.branchCode, ["CASH"]);
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
    if (cashDepositDenominationTotal !== cashDepositAmount) {
      setMessage("Tổng bảng kê mệnh giá phải bằng số tiền cần nộp.");
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
          amount: cashDepositAmount,
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
      setMessage(`Đã tạo phiếu ${payload.code} chờ duyệt.`);
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
      <div className="flex flex-wrap items-end gap-3 mb-4">
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
        {active === "daily-cash" && (
          <>
            <Field label="Ngày thu chi">
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
        <button type="button" className="icon-button" title="Tải lại" onClick={() => void loadData()}>
          <span className="material-symbols-outlined text-lg">refresh</span>
        </button>
      </div>

      <ModuleTabs
        active={active}
        onChange={handleTabChange}
        tabs={visibleTabs}
      />

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

          {dailyCash.duplicateRevenueWarning && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span className="material-symbols-outlined text-lg">warning</span>
              <span>
                Ngày/ca này có <b>cả doanh thu import lẫn doanh thu nhập tay</b>. Hãy kiểm tra để tránh tính trùng — nếu file POS đã lên đủ, xoá dòng nhập tay đi.
              </span>
            </div>
          )}

          <section className="table-panel">
            <PanelHeader title="Tổng hợp thu trong ngày" subtitle="Doanh thu bán hàng gộp file POS đã import, doanh thu nhập tay và phiếu thu đã lập. Tách theo tiền mặt, chuyển khoản, quẹt thẻ/ví và kênh Grab." />
            <Table headers={["Loại", "Tổng thu", "Tiền mặt", "Chuyển khoản", "Quẹt thẻ/Ví", "Grab", "Khác", "Tổng chi tiền mặt", "Nộp tiền"]}>
              <DailyCashSummaryRow label="Doanh thu bán hàng" bucket={dailyCash.summary.revenue} />
              <DailyCashSummaryRow label="Đặt cọc" bucket={dailyCash.summary.deposit} />
              <DailyCashSummaryRow label="TOTAL" bucket={dailyCash.summary.total} expense={dailyCash.summary.cashExpenseTotal} cashToDeposit={dailyCash.summary.cashToDeposit} strong />
            </Table>
          </section>

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
            <PanelHeader title="Các khoản chi chi tiết" subtitle="Lấy từ phiếu chi trong ngày/ca. Cột nguồn tiền cho biết khoản nào là tiền mặt để tính số tiền cần nộp." />
            <div className="max-h-[520px] overflow-auto">
              <Table headers={["STT", "Mã phiếu", "Khoản chi chi tiết", "Tên nhà cung cấp/đối tượng", "Nguồn tiền", "Số tiền"]}>
                {dailyCash.expenses.length === 0 ? (
                  <tr className="border-t border-slate-100">
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-400">Không có phiếu chi trong ngày/ca này.</td>
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
                      className="control text-right"
                      inputMode="numeric"
                      placeholder="0"
                      value={manualRevenueForm[field.key] ? money(toAmountNumber(manualRevenueForm[field.key])) : ""}
                      onChange={(event) => setManualRevenueForm((current) => ({ ...current, [field.key]: digitsOnly(event.target.value) }))}
                    />
                    <span className="mt-1 block text-[11px] text-slate-500">{field.hint}</span>
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
                <h2 className="mt-1 text-xl font-bold text-slate-900">{money(cashDepositAmount)} đ</h2>
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
                      }));
                    }}
                  >
                    {cashDepositCashSources.map((source) => (
                      <option key={source.code} value={source.code} title={moneySourceDebugLabel(source, storeLabel(dailyCash.branchCode))}>
                        {moneySourceDisplayName(source, storeLabel(dailyCash.branchCode))}
                      </option>
                    ))}
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
                </Field>

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
                      <p className="font-semibold text-slate-500">Cần nộp</p>
                      <p className="mt-1 font-bold text-slate-900">{money(cashDepositAmount)} đ</p>
                    </div>
                    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
                      <p className="font-semibold text-slate-500">Đã kê</p>
                      <p className={`mt-1 font-bold ${cashDepositDenominationTotal === cashDepositAmount ? "text-emerald-700" : "text-rose-600"}`}>
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
                {cashDepositDenominationTotal !== cashDepositAmount && (
                  <p className="border-t border-rose-100 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">
                    Tổng bảng kê phải bằng {money(cashDepositAmount)} đ.
                  </p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4">
              <button type="button" className="secondary-button" onClick={() => setCashDepositOpen(false)}>Hủy</button>
              <button
                className="primary-button"
                disabled={cashDepositSubmitting || cashDepositDenominationTotal !== cashDepositAmount || !cashDepositForm.fromMoneySourceCode || !cashDepositForm.toMoneySourceCode}
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

function DailyCashSummaryRow({ label, bucket, expense = 0, cashToDeposit = 0, strong = false }: { label: string; bucket: DailyCashBucket; expense?: number; cashToDeposit?: number; strong?: boolean }) {
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
      <Cell right>{strong ? `${money(expense)} đ` : "-"}</Cell>
      <Cell right>{strong ? <b className={cashToDeposit < 0 ? "text-rose-600" : "text-emerald-700"}>{money(cashToDeposit)} đ</b> : "-"}</Cell>
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
