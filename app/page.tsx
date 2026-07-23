"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AppBrand } from "@/components/AppBrand";
import { MonthInput } from "@/components/DateInput";
import { branchScopeOptions, displayRoleName } from "@/lib/branch-labels";
import {
  appMenuItems,
  canAccessMenu,
  canPerformAction,
  canViewFinancialDashboard,
  getDefaultRouteForRole,
  type DemoSession,
  SESSION_KEY,
} from "@/lib/auth-demo";

interface DocumentItem {
  id: string;
  code: string;
  date: string;
  partner: string;
  description: string;
  amount: number;
  status: string;
}

interface DashboardPnl {
  revenue: number;
  cogs: number;
  payroll: number;
  depreciation: number;
  otherOpex: number;
  otherIncome: number;
  otherExpense: number;
  grossProfit: number;
  ebitda: number;
  netProfit: number;
}

interface DashboardData {
  period: string;
  branchCode: string;
  pnl: {
    total: DashboardPnl;
  };
  trend: Array<DashboardPnl & { period: string }>;
  balance: {
    rows: Array<{ reportGroup: string; amount: number }>;
    difference: number;
    balanced: boolean;
  };
}

const DEFAULT_DASHBOARD_PERIOD = new Date().toISOString().slice(0, 7);

export default function Home() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState("Dashboard");
  const [dashboardPeriod, setDashboardPeriod] = useState(DEFAULT_DASHBOARD_PERIOD);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState("");
  const [globalBranch, setGlobalBranch] = useState("ALL");
  const [isBranchLocked, setIsBranchLocked] = useState(false);

  // Auth states
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Form states
  const [partner, setPartner] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("PENDING");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load documents
  const fetchDocuments = async () => {
    try {
      const res = await fetch("/api/documents");
      if (res.ok) {
        const data = await res.json();
        setDocuments(data);
      }
    } catch (error) {
      console.error("Failed to fetch documents", error);
    }
  };

  const fetchDashboard = useCallback(async (period: string, branch: string) => {
    try {
      setDashboardError("");
      const response = await fetch(`/api/reports?type=dashboard&period=${period}&branchCode=${branch}`);
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Không tải được dữ liệu Dashboard");
      }
      setDashboard(await response.json() as DashboardData);
    } catch (error) {
      setDashboard(null);
      setDashboardError(error instanceof Error ? error.message : "Không tải được dữ liệu Dashboard");
    }
  }, []);

  useEffect(() => {
    const session = localStorage.getItem(SESSION_KEY);
    if (!session) {
      router.push("/login");
      return;
    }

    try {
      const parsedSession = JSON.parse(session) as DemoSession;
      const allowedItems = appMenuItems.filter((item) => canAccessMenu(parsedSession.role, item));
      const hasAllowedMenu = allowedItems.length > 0;
      if (!parsedSession.role || !parsedSession.email || !hasAllowedMenu) {
        throw new Error("Invalid session");
      }
      const dashboardMenu = appMenuItems.find((item) => item.href === "/" && item.name === "Dashboard");
      if (!dashboardMenu || !canAccessMenu(parsedSession.role, dashboardMenu) || !canViewFinancialDashboard(parsedSession.role)) {
        router.replace(getDefaultRouteForRole(parsedSession.role));
        return;
      }

      let initialBranch = "ALL";
      let locked = false;
      if (parsedSession.allowedBranches?.length === 1 && !parsedSession.allowedBranches.includes("ALL")) {
        initialBranch = parsedSession.allowedBranches[0];
        locked = true;
      } else {
        initialBranch = localStorage.getItem("global_branch_code") || "ALL";
      }

      window.setTimeout(() => {
        setUser(parsedSession);
        setActiveMenu(dashboardMenu.name);
        setGlobalBranch(initialBranch);
        setIsBranchLocked(locked);
        setIsCheckingAuth(false);
        fetchDocuments();
        fetchDashboard(DEFAULT_DASHBOARD_PERIOD, initialBranch);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login");
    }
  }, [fetchDashboard, router]);

  const handleBranchChange = (code: string) => {
    setGlobalBranch(code);
    localStorage.setItem("global_branch_code", code);
    fetchDashboard(dashboardPeriod, code);
  };

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY);
    document.cookie = `${SESSION_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
    router.push("/login");
  };

  const expenseOf = (value: DashboardPnl) => value.cogs + value.payroll + value.depreciation + value.otherOpex + value.otherExpense;
  const currentPnl = dashboard?.pnl.total;
  const totalRevenue = currentPnl?.revenue || 0;
  const totalExpense = currentPnl ? expenseOf(currentPnl) : 0;
  const ebitda = currentPnl?.ebitda || 0;
  const totalCash = dashboard?.balance.rows
    .filter((row) => row.reportGroup === "CASH")
    .reduce((sum, row) => sum + row.amount, 0) || 0;
  const trend = dashboard?.trend || [];
  const currentTrend = trend.at(-1);
  const previousTrend = trend.at(-2);
  const percentageChange = (current: number, previous?: number) => previous ? (current - previous) / Math.abs(previous) * 100 : null;
  const revenueGrowth = percentageChange(currentTrend?.revenue || 0, previousTrend?.revenue);
  const expenseGrowth = percentageChange(currentTrend ? expenseOf(currentTrend) : 0, previousTrend ? expenseOf(previousTrend) : undefined);
  const chartMax = Math.max(...trend.map((row) => Math.max(row.revenue, expenseOf(row))), 1);
  const hasAccountingData = trend.some((row) => row.revenue !== 0 || expenseOf(row) !== 0) || totalCash !== 0;
  const healthScore = hasAccountingData
    ? Math.max(0, 10 - (ebitda < 0 ? 3 : 0) - (totalCash < 0 ? 3 : 0) - (dashboard?.balance.balanced === false ? 4 : 0))
    : 0;
  const financialWarnings: Array<{ title: string; detail: string; tone: "amber" | "rose" | "emerald"; icon: string }> = [];
  if (dashboardError) financialWarnings.push({ title: "Không tải được dữ liệu", detail: dashboardError, tone: "rose", icon: "error_outline" });
  else if (!hasAccountingData) financialWarnings.push({ title: "Chưa có dữ liệu ghi sổ", detail: `Hãy nhập dữ liệu và đồng bộ sổ cái cho kỳ ${dashboardPeriod}.`, tone: "amber", icon: "database" });
  else {
    if (dashboard?.balance.balanced === false) financialWarnings.push({ title: "Bảng cân đối đang lệch", detail: `Chênh lệch ${formatCurrency(Math.abs(dashboard.balance.difference))} đ.`, tone: "rose", icon: "balance" });
    if (ebitda < 0) financialWarnings.push({ title: "EBITDA đang âm", detail: `Kỳ ${dashboardPeriod} đang âm ${formatCurrency(Math.abs(ebitda))} đ.`, tone: "rose", icon: "trending_down" });
    if (totalCash < 0) financialWarnings.push({ title: "Số dư tiền đang âm", detail: `Số dư cuối kỳ ${formatCurrency(totalCash)} đ.`, tone: "rose", icon: "account_balance_wallet" });
  }
  const pendingDocuments = documents.filter((document) => document.status === "PENDING").length;
  if (pendingDocuments > 0) financialWarnings.push({ title: "Chứng từ chờ xử lý", detail: `${pendingDocuments} chứng từ vận hành đang chờ duyệt.`, tone: "amber", icon: "pending_actions" });
  if (financialWarnings.length === 0) financialWarnings.push({ title: "Không có cảnh báo", detail: `Dữ liệu kỳ ${dashboardPeriod} đang cân đối.`, tone: "emerald", icon: "verified" });
  const healthLabel = !hasAccountingData ? "Chưa đủ dữ liệu để đánh giá." : healthScore >= 8 ? "Các chỉ số tài chính chính đang ổn định." : healthScore >= 5 ? "Có chỉ số cần được theo dõi." : "Có rủi ro tài chính cần xử lý.";

  // Handle Form Submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !canPerformAction(user.role, "create")) {
      alert("Bạn không có quyền tạo chứng từ");
      return;
    }
    if (!partner || !description || !amount) {
      alert("Vui lòng điền đầy đủ thông tin");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner,
          description,
          amount: parseFloat(amount),
          status,
        }),
      });

      if (res.ok) {
        setPartner("");
        setDescription("");
        setAmount("");
        setStatus("PENDING");
        setIsCreateOpen(false);
        fetchDocuments();
      } else {
        const err = await res.json();
        alert("Lỗi: " + (err.error || "Không thể tạo chứng từ"));
      }
    } catch (err) {
      console.error(err);
      alert("Đã xảy ra lỗi kết nối");
    } finally {
      setIsSubmitting(false);
    }
  };

  // Format currency in VND
  function formatCurrency(val: number) {
    return new Intl.NumberFormat("vi-VN").format(val);
  }

  // Filter documents based on search query and status filter dropdown
  const filteredDocuments = documents.filter((doc) => {
    const matchesSearch =
      doc.partner.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.code.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (filterStatus === "ALL") return matchesSearch;
    return matchesSearch && doc.status === filterStatus;
  });

  const allowedMenuItems = user
    ? appMenuItems.filter((item) => canAccessMenu(user.role, item))
    : [];
  const canCreateDocuments = user ? canPerformAction(user.role, "create") : false;
  const canExportDocuments = user ? canPerformAction(user.role, "export") : false;

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#f1f5f9]">
        <div className="flex flex-col items-center gap-2">
          <div className="w-10 h-10 border-4 border-[#2563eb] border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest mt-2">Đang tải...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[#f1f5f9]">
      {/* Sidebar */}
      <aside className="w-64 h-screen fixed left-0 top-0 bg-[#0f172a] flex flex-col py-6 shadow-xl z-50 overflow-hidden">
        <div className="px-6 mb-8 shrink-0">
          <AppBrand compact />
        </div>
        <nav className="sidebar-scroll flex-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
          {allowedMenuItems.map((item) => (
            <button
              key={item.name}
              onClick={() => {
                if (item.href !== "/") {
                  router.push(item.href);
                  return;
                }
                setActiveMenu(item.name);
              }}
              className={`w-full flex items-center px-6 py-3 text-left transition-all active:scale-[0.98] duration-150 ${
                activeMenu === item.name
                  ? "bg-[#1e293b] text-white border-l-4 border-[#2563eb]"
                  : "text-white/70 hover:bg-[#1e293b] hover:text-white"
              }`}
            >
              <span className="material-symbols-outlined mr-3 text-[20px]">{item.icon}</span>
              <span className="text-sm font-medium">{item.name}</span>
            </button>
          ))}
        </nav>
        <div className="shrink-0 pt-4 border-t border-slate-800 space-y-1 bg-[#0f172a]">
          <button className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left">
            <span className="material-symbols-outlined mr-3 text-[20px]">help</span>
            <span className="text-sm font-medium">Trợ giúp</span>
          </button>
          <button 
            onClick={handleLogout}
            className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left"
          >
            <span className="material-symbols-outlined mr-3 text-[20px]">logout</span>
            <span className="text-sm font-medium">Đăng xuất</span>
          </button>
        </div>
      </aside>

      {/* Main Content Body */}
      <div className="flex-1 pl-64 flex flex-col min-h-screen">
        {/* Header */}
        <header className="h-16 sticky top-0 bg-white flex justify-between items-center px-6 border-b border-slate-200 z-45 shadow-sm">
          <div className="flex items-center gap-6">
            <h2 className="text-lg font-bold text-slate-800">Bảng điều hành</h2>
            <div className="hidden lg:flex items-center gap-4 ml-4">
              <span className="text-[#2563eb] font-bold border-b-2 border-[#2563eb] pb-1 text-xs uppercase tracking-wider cursor-pointer">
                Dashboard
              </span>
              <span className="text-slate-500 hover:text-[#2563eb] transition-colors cursor-pointer text-xs uppercase tracking-wider">
                Báo cáo chi tiết
              </span>
              <span className="text-slate-500 hover:text-[#2563eb] transition-colors cursor-pointer text-xs uppercase tracking-wider">
                Cấu hình tham số
              </span>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {/* Global Branch Selector */}
            <div className="relative">
              <select
                value={globalBranch}
                onChange={(e) => handleBranchChange(e.target.value)}
                disabled={isBranchLocked}
                className="pl-3 pr-8 py-1.5 bg-slate-100 border border-slate-200 rounded-lg focus:ring-2 focus:ring-[#2563eb]/20 focus:border-[#2563eb] text-xs font-semibold outline-none cursor-pointer appearance-none transition-all disabled:opacity-75 disabled:cursor-not-allowed"
              >
                {branchScopeOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-base">
                unfold_more
              </span>
            </div>

            <div className="relative hidden sm:block">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
                search
              </span>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-1.5 bg-slate-100 rounded-lg border-none focus:ring-2 focus:ring-[#2563eb] text-xs w-64 outline-none transition-all"
                placeholder="Tìm chứng từ, đối tác, nguồn tiền..."
                type="text"
              />
            </div>
            {canCreateDocuments && (
              <button
                onClick={() => setIsCreateOpen(true)}
                className="bg-[#2563eb] text-white px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-2 hover:bg-[#1d4ed8] active:scale-95 transition-all shadow-md"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                Tạo chứng từ
              </button>
            )}
            <div className="flex items-center gap-3 ml-2 border-l pl-4 border-slate-200">
              <span className="material-symbols-outlined text-slate-600 bg-slate-100 p-2 rounded-full cursor-pointer hover:bg-slate-200 transition-colors relative">
                notifications
                <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-rose-500 rounded-full border-2 border-white"></span>
              </span>
              <div className="flex items-center gap-2.5">
                <div className="text-right hidden md:block">
                  <div className="text-xs font-bold text-slate-800">{user?.name}</div>
                  <div className="text-[10px] text-slate-500 font-medium">
                    {displayRoleName(user?.role)} - {user?.branch}
                  </div>
                </div>
                <div className="w-9 h-9 rounded-full bg-[#004ac6] text-white flex items-center justify-center font-bold text-sm shadow-sm border border-slate-200">
                  {user?.name?.charAt(0).toUpperCase()}
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* Content Canvas */}
        <main className="p-6 flex-1 max-w-7xl w-full mx-auto space-y-6">
          {/* Header Area */}
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-950">Tổng quan vận hành</h1>
              <p className="text-slate-500 text-sm mt-0.5">Theo dõi doanh thu POS, chi phí, tiền mặt và công nợ</p>
            </div>
            <div className="flex items-center gap-3">
              <MonthInput
                value={dashboardPeriod}
                onChange={(value) => {
                  setDashboardPeriod(value);
                  if (value) void fetchDashboard(value, globalBranch);
                }}
                className="w-40 shadow-sm"
                ariaLabel="Kỳ báo cáo"
              />
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-xs outline-none focus:ring-2 focus:ring-[#2563eb] shadow-sm font-semibold"
              >
                <option value="ALL">Tất cả trạng thái</option>
                <option value="PENDING">Chờ Duyệt</option>
                <option value="COMPLETED">Hoàn tất</option>
                <option value="DRAFT">Lưu nháp</option>
              </select>
              {canExportDocuments && (
                <button className="bg-white border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-2 hover:bg-slate-50 transition-colors shadow-sm">
                  <span className="material-symbols-outlined text-[16px]">download</span>
                  Xuất Excel
                </button>
              )}
            </div>
          </div>

          {/* KPI Bento Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Revenue KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-[#059669]">trending_up</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">DOANH THU</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(totalRevenue)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-[#059669] bg-[#ecfdf5] px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">{revenueGrowth !== null && revenueGrowth < 0 ? "arrow_downward" : "arrow_upward"}</span>
                  {revenueGrowth === null ? "Chưa có kỳ trước" : `${revenueGrowth >= 0 ? "+" : ""}${revenueGrowth.toFixed(1)}%`}
                </span>
                <span className="text-slate-400 text-[10px]">so với kỳ trước</span>
              </div>
            </div>

            {/* Expenses KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-rose-600">payments</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">CHI PHÍ VẬN HÀNH</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(totalExpense)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">{expenseGrowth !== null && expenseGrowth > 0 ? "arrow_upward" : "arrow_downward"}</span>
                  {expenseGrowth === null ? "Chưa có kỳ trước" : `${expenseGrowth >= 0 ? "+" : ""}${expenseGrowth.toFixed(1)}%`}
                </span>
                <span className="text-slate-400 text-[10px]">so với kỳ trước</span>
              </div>
            </div>

            {/* EBITDA Profit KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-[#059669]">analytics</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">LỢI NHUẬN VẬN HÀNH</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(ebitda)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-[#059669] bg-[#ecfdf5] px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">monitoring</span>
                  {totalRevenue ? `${(ebitda / totalRevenue * 100).toFixed(1)}%` : "0%"}
                </span>
                <span className="text-slate-400 text-[10px]">biên EBITDA</span>
              </div>
            </div>

            {/* Total Cash KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-amber-600">account_balance</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">TIỀN MẶT & ĐỐI SOÁT</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(totalCash)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">account_balance</span> {dashboard?.balance.balanced ? "Đã cân đối" : "Cần kiểm tra"}
                </span>
                <span className="text-slate-400 text-[10px]">theo sổ cái đến cuối kỳ</span>
              </div>
            </div>
          </div>

          {/* Main Chart + Health Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Chart YoY */}
            <div className="lg:col-span-8 bg-white p-6 rounded-xl shadow-sm border border-slate-100">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h4 className="text-base font-bold text-slate-900">Phân tích doanh thu</h4>
                  <p className="text-slate-500 text-xs">So sánh doanh thu POS và chi phí vận hành theo tháng</p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#2563eb]"></span>
                    <span className="text-xs font-medium text-slate-600">Doanh thu</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-slate-300"></span>
                    <span className="text-xs font-medium text-slate-600">Chi phí</span>
                  </div>
                </div>
              </div>
              {/* Custom Chart */}
              <div className="h-64 w-full flex items-end justify-between gap-4 px-4 pb-8 relative">
                <div className="absolute inset-x-0 bottom-8 h-[1px] bg-slate-100"></div>
                <div className="absolute inset-x-0 bottom-24 h-[1px] bg-slate-100"></div>
                <div className="absolute inset-x-0 bottom-40 h-[1px] bg-slate-100"></div>
                <div className="absolute inset-x-0 bottom-56 h-[1px] bg-slate-100"></div>

                {trend.map((item) => {
                  const expense = expenseOf(item);
                  const expenseHeight = expense ? `${Math.max(4, expense / chartMax * 100)}%` : "0%";
                  const revenueHeight = item.revenue ? `${Math.max(4, item.revenue / chartMax * 100)}%` : "0%";
                  const highlight = item.period === dashboardPeriod;
                  return (
                  <div key={item.period} className="flex-1 flex flex-col items-center group relative h-full justify-end">
                    <div className="flex items-end gap-1 w-full justify-center">
                      <div className="w-3.5 bg-slate-300 rounded-t" style={{ height: expenseHeight }} title={`Chi phí ${formatCurrency(expense)} đ`}></div>
                      <div className={`w-3.5 rounded-t ${highlight ? "bg-[#2563eb] ring-2 ring-blue-200" : "bg-[#2563eb]"}`} style={{ height: revenueHeight }} title={`Doanh thu ${formatCurrency(item.revenue)} đ`}></div>
                    </div>
                    <span className={`absolute -bottom-6 text-[10px] font-semibold ${highlight ? "text-[#2563eb] font-bold" : "text-slate-400"}`}>
                      {item.period.slice(5)}
                    </span>
                  </div>
                );})}
                {trend.length === 0 && <p className="m-auto text-xs text-slate-400">Chưa có dữ liệu ghi sổ.</p>}
              </div>
            </div>

            {/* Sidebar widgets */}
            <div className="lg:col-span-4 flex flex-col gap-5">
              {/* Warnings */}
              <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 flex-1">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-bold text-slate-900">Cảnh báo hệ thống</h4>
                  <span className="bg-rose-100 text-rose-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                    {financialWarnings.filter((item) => item.tone !== "emerald").length} MỚI
                  </span>
                </div>
                <div className="space-y-3">
                  {financialWarnings.map((item) => (
                    <div key={`${item.title}-${item.detail}`} className={`p-3 border-l-4 rounded-r-lg ${item.tone === "rose" ? "bg-rose-50 border-rose-400" : item.tone === "emerald" ? "bg-emerald-50 border-emerald-400" : "bg-amber-50 border-amber-400"}`}>
                      <div className="flex items-start gap-2.5">
                        <span className={`material-symbols-outlined text-[18px] ${item.tone === "rose" ? "text-rose-600" : item.tone === "emerald" ? "text-emerald-600" : "text-amber-600"}`}>{item.icon}</span>
                        <div>
                          <p className="text-xs font-bold text-slate-950">{item.title}</p>
                          <p className="text-[11px] text-slate-600 mt-0.5">{item.detail}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Health Score */}
              <div className="bg-[#0f172a] p-5 rounded-xl shadow-lg text-white">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">CHỈ SỐ SỨC KHỎE DN</span>
                  <span className={`material-symbols-outlined ${healthScore >= 8 ? "text-[#059669]" : healthScore >= 5 ? "text-amber-400" : "text-rose-400"}`}>{healthScore >= 8 ? "verified" : "monitor_heart"}</span>
                </div>
                <div className="flex items-end gap-1.5 mb-2">
                  <span className="text-2xl font-bold">{healthScore.toFixed(1)}</span>
                  <span className="text-xs text-slate-400 mb-1">/ 10</span>
                </div>
                <p className="text-[11px] text-slate-300 mb-4">{healthLabel}</p>
                <div className="w-full bg-slate-700 h-1 rounded-full overflow-hidden">
                  <div className={`h-full ${healthScore >= 8 ? "bg-[#059669]" : healthScore >= 5 ? "bg-amber-400" : "bg-rose-500"}`} style={{ width: `${healthScore * 10}%` }}></div>
                </div>
              </div>
            </div>
          </div>

          {/* Transactions List */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h4 className="text-base font-bold text-slate-900">Chứng từ vận hành</h4>
              {canCreateDocuments && (
                <button 
                  onClick={() => setIsCreateOpen(true)}
                  className="text-[#2563eb] text-xs font-bold hover:underline"
                >
                  + Thêm chứng từ
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    <th className="px-6 py-3 text-[10px] font-bold tracking-wider text-slate-500 uppercase">MÃ CHỨNG TỪ</th>
                    <th className="px-6 py-3 text-[10px] font-bold tracking-wider text-slate-500 uppercase">NGÀY TẠO</th>
                    <th className="px-6 py-3 text-[10px] font-bold tracking-wider text-slate-500 uppercase">ĐỐI TÁC / NỘI DUNG</th>
                    <th className="px-6 py-3 text-[10px] font-bold tracking-wider text-slate-500 uppercase text-right">SỐ TIỀN (VNĐ)</th>
                    <th className="px-6 py-3 text-[10px] font-bold tracking-wider text-slate-500 uppercase">TRẠNG THÁI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDocuments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-6 py-10 text-center text-xs text-slate-400 font-medium">
                        Không tìm thấy chứng từ nào trùng khớp.
                      </td>
                    </tr>
                  ) : (
                    filteredDocuments.map((doc) => (
                      <tr key={doc.id} className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 text-xs font-mono font-bold text-slate-900">{doc.code}</td>
                        <td className="px-6 py-4 text-xs text-slate-500">
                          {new Date(doc.date).toLocaleDateString("vi-VN")}
                        </td>
                        <td className="px-6 py-4 text-xs">
                          <div className="font-bold text-slate-900">{doc.partner}</div>
                          <div className="text-slate-500 text-[11px] mt-0.5">{doc.description}</div>
                        </td>
                        <td className="px-6 py-4 text-right text-xs font-mono font-bold text-slate-900">
                          {formatCurrency(doc.amount)}
                        </td>
                        <td className="px-6 py-4">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              doc.status === "COMPLETED"
                                ? "bg-emerald-50 text-[#059669]"
                                : doc.status === "PENDING"
                                ? "bg-amber-50 text-amber-800"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {doc.status === "COMPLETED"
                              ? "Hoàn tất"
                              : doc.status === "PENDING"
                              ? "Đang chờ Duyệt"
                              : "Lưu nháp"}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>

      {/* Slide-out Panel / Modal for Create Document */}
      {isCreateOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-[100] transition-opacity">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-sm">Lập chứng từ mới</h3>
              <button
                onClick={() => setIsCreateOpen(false)}
                className="text-slate-400 hover:text-slate-600 material-symbols-outlined text-[20px]"
              >
                close
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                  Đối tác
                </label>
                <input
                  type="text"
                  required
                  value={partner}
                  onChange={(e) => setPartner(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-[#2563eb] focus:bg-white outline-none transition-all"
                  placeholder="Ví dụ: Công ty TNHH Giải pháp số X"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                  Nội dung thanh toán
                </label>
                <textarea
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-[#2563eb] focus:bg-white outline-none transition-all h-20 resize-none"
                  placeholder="Ví dụ: Thanh toán phí Server Q2/2024"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                    Số tiền (VNĐ)
                  </label>
                  <input
                    type="number"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-[#2563eb] focus:bg-white outline-none transition-all font-mono"
                    placeholder="Ví dụ: 125000000"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5 uppercase tracking-wider">
                    Trạng thái
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-[#2563eb] focus:bg-white outline-none transition-all font-semibold text-slate-700"
                  >
                    <option value="PENDING">Chờ Duyệt</option>
                    <option value="COMPLETED">Hoàn tất</option>
                    <option value="DRAFT">Lưu nháp</option>
                  </select>
                </div>
              </div>
              <div className="pt-4 border-t border-slate-100 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg text-xs font-bold hover:bg-slate-50 active:scale-95 transition-all"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 bg-[#2563eb] text-white rounded-lg text-xs font-bold hover:bg-[#1d4ed8] active:scale-95 transition-all shadow-md flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isSubmitting ? "Đang xử lý..." : "Lập chứng từ"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
