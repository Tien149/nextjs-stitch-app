"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  appMenuItems,
  canAccessMenu,
  canPerformAction,
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

export default function Home() {
  const router = useRouter();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState("Báo cáo & BI");

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
      const dashboardMenu = appMenuItems.find((item) => item.href === "/" && item.name === "Báo cáo & BI");
      if (!dashboardMenu || !canAccessMenu(parsedSession.role, dashboardMenu)) {
        const firstRoute = allowedItems.find((item) => item.href !== "/");
        router.replace(firstRoute?.href || "/login");
        return;
      }
      window.setTimeout(() => {
        setUser(parsedSession);
        setActiveMenu(dashboardMenu.name);
        setIsCheckingAuth(false);
        fetchDocuments();
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login");
    }
  }, [router]);

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY);
    document.cookie = `${SESSION_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
    router.push("/login");
  };

  // Calculate dynamic KPIs based on database content + baseline
  // Baseline matching the hardcoded numbers in code.html
  const baseRevenue = 4285000000;
  const baseExpense = 2910450000;
  
  // Calculate additions from DB
  const dbRevenue = documents
    .filter(doc => doc.code.startsWith("PT") && doc.status === "COMPLETED")
    .reduce((sum, doc) => sum + doc.amount, 0);

  const dbExpense = documents
    .filter(doc => doc.code.startsWith("PC") && doc.status !== "DRAFT")
    .reduce((sum, doc) => sum + doc.amount, 0);

  const totalRevenue = baseRevenue + dbRevenue;
  const totalExpense = baseExpense + dbExpense;
  const ebitda = totalRevenue - totalExpense;
  const totalCash = 8120000000 + dbRevenue - dbExpense;

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
  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("vi-VN").format(val);
  };

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
      <aside className="w-64 h-screen fixed left-0 top-0 bg-[#0f172a] flex flex-col py-6 shadow-xl z-50">
        <div className="px-6 mb-8">
          <h1 className="text-xl font-bold text-white tracking-tight">FIN-ERP</h1>
          <p className="text-white/60 text-[10px] uppercase tracking-widest mt-1">Executive Suite</p>
        </div>
        <nav className="flex-1 space-y-1">
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
        <div className="mt-auto pt-6 border-t border-slate-800 space-y-1">
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
            <h2 className="text-lg font-bold text-slate-800">Bảng điều hành Module H.8</h2>
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
            <div className="relative hidden sm:block">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
                search
              </span>
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-4 py-1.5 bg-slate-100 rounded-lg border-none focus:ring-2 focus:ring-[#2563eb] text-xs w-64 outline-none transition-all"
                placeholder="Tìm mã chứng từ, tài khoản..."
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
                    {user?.role} - {user?.branch}
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
              <h1 className="text-2xl font-bold text-slate-950">Tổng quan Điều hành</h1>
              <p className="text-slate-500 text-sm mt-0.5">Dữ liệu cập nhật theo thời gian thực</p>
            </div>
            <div className="flex items-center gap-3">
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
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">TỔNG DOANH THU</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(totalRevenue)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-[#059669] bg-[#ecfdf5] px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">arrow_upward</span> 12.5%
                </span>
                <span className="text-slate-400 text-[10px]">so với tháng trước</span>
              </div>
            </div>

            {/* Expenses KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-rose-600">payments</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">TỔNG CHI PHÍ</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(totalExpense)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">arrow_downward</span> 4.2%
                </span>
                <span className="text-slate-400 text-[10px]">kiểm soát tốt</span>
              </div>
            </div>

            {/* EBITDA Profit KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-[#059669]">analytics</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">LỢI NHUẬN EBITDA</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(ebitda)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-[#059669] bg-[#ecfdf5] px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">arrow_upward</span> 18.2%
                </span>
                <span className="text-slate-400 text-[10px]">biên LN {((ebitda / totalRevenue) * 100).toFixed(0)}%</span>
              </div>
            </div>

            {/* Total Cash KPI */}
            <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 hover:shadow-md transition-shadow relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                <span className="material-symbols-outlined text-4xl text-amber-600">account_balance</span>
              </div>
              <p className="text-slate-500 text-[10px] font-bold uppercase tracking-wider mb-1">TIỀN MẶT & TƯƠNG ĐƯƠNG</p>
              <h3 className="text-xl font-bold text-slate-900">
                {formatCurrency(totalCash)} <span className="text-xs font-normal">₫</span>
              </h3>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex items-center text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded text-[10px] font-bold">
                  <span className="material-symbols-outlined text-[12px] mr-0.5">history</span> Ổn định
                </span>
                <span className="text-slate-400 text-[10px]">dòng tiền lưu động</span>
              </div>
            </div>
          </div>

          {/* Main Chart + Health Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Chart YoY */}
            <div className="lg:col-span-8 bg-white p-6 rounded-xl shadow-sm border border-slate-100">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h4 className="text-base font-bold text-slate-900">Phân tích Tăng trưởng YoY</h4>
                  <p className="text-slate-500 text-xs">So sánh Doanh thu và Chi phí theo tháng (đơn vị: Tỷ VNĐ)</p>
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

                {[
                  { month: "T1", expense: "40%", revenue: "55%" },
                  { month: "T2", expense: "45%", revenue: "50%" },
                  { month: "T3", expense: "35%", revenue: "60%" },
                  { month: "T4", expense: "50%", revenue: "75%" },
                  { month: "T5", expense: "45%", revenue: "85%", highlight: true },
                  { month: "T6", expense: "40%", revenue: "45%", future: true },
                  { month: "T7", expense: "40%", revenue: "45%", future: true },
                  { month: "T8", expense: "40%", revenue: "45%", future: true },
                ].map((item, idx) => (
                  <div key={idx} className={`flex-1 flex flex-col items-center group relative h-full justify-end ${item.future ? 'opacity-40' : ''}`}>
                    <div className="flex items-end gap-1 w-full justify-center">
                      <div className="w-3.5 bg-slate-200 rounded-t" style={{ height: item.expense }}></div>
                      <div className={`w-3.5 rounded-t ${item.highlight ? 'bg-[#2563eb] border-x-2 border-blue-300' : 'bg-[#2563eb]'}`} style={{ height: item.revenue }}></div>
                    </div>
                    <span className={`absolute -bottom-6 text-[10px] font-semibold ${item.highlight ? 'text-[#2563eb] font-bold' : 'text-slate-400'}`}>
                      {item.month}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Sidebar widgets */}
            <div className="lg:col-span-4 flex flex-col gap-5">
              {/* Warnings */}
              <div className="bg-white p-5 rounded-xl shadow-sm border border-slate-100 flex-1">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="text-sm font-bold text-slate-900">Cảnh báo hệ thống</h4>
                  <span className="bg-rose-100 text-rose-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                    {filteredDocuments.filter(d => d.status === "PENDING").length} MỚI
                  </span>
                </div>
                <div className="space-y-3">
                  <div className="p-3 bg-amber-50 border-l-4 border-amber-400 rounded-r-lg">
                    <div className="flex items-start gap-2.5">
                      <span className="material-symbols-outlined text-amber-600 text-[18px]">engineering</span>
                      <div>
                        <p className="text-xs font-bold text-slate-950">Lịch bảo trì định kỳ</p>
                        <p className="text-[11px] text-slate-600 mt-0.5">Hệ thống máy chủ sẽ bảo trì vào 22:00 tối nay.</p>
                      </div>
                    </div>
                  </div>
                  <div className="p-3 bg-rose-50 border-l-4 border-rose-400 rounded-r-lg">
                    <div className="flex items-start gap-2.5">
                      <span className="material-symbols-outlined text-rose-600 text-[18px]">error_outline</span>
                      <div>
                        <p className="text-xs font-bold text-slate-950">Vượt ngân sách dự phòng</p>
                        <p className="text-[11px] text-slate-600 mt-0.5">Chi phí Marketing tháng 5 đã vượt 15% so với kế hoạch.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Health Score */}
              <div className="bg-[#0f172a] p-5 rounded-xl shadow-lg text-white">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">CHỈ SỐ SỨC KHỎE DN</span>
                  <span className="material-symbols-outlined text-[#059669]">verified</span>
                </div>
                <div className="flex items-end gap-1.5 mb-2">
                  <span className="text-2xl font-bold">8.5</span>
                  <span className="text-xs text-slate-400 mb-1">/ 10</span>
                </div>
                <p className="text-[11px] text-slate-300 mb-4">Mức độ an toàn tài chính đang ở mức Cao. Không có rủi ro nợ xấu ngắn hạn.</p>
                <div className="w-full bg-slate-700 h-1 rounded-full overflow-hidden">
                  <div className="bg-[#059669] h-full w-[85%]"></div>
                </div>
              </div>
            </div>
          </div>

          {/* Transactions List */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h4 className="text-base font-bold text-slate-900">Chứng từ điều hành (Module H.8.4)</h4>
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
