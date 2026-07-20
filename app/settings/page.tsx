"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { branchScopeOptions, displayRoleName, storeLabel, storeOptions } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type MasterDataItem = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  partnerType: string | null;
  partnerGroup: string | null;
  branch: string | null;
  taxCode: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  accountNo: string | null;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

type MasterDataForm = {
  id?: string;
  type: string;
  code: string;
  name: string;
  group: string;
  partnerType: string;
  partnerGroup: string;
  branch: string;
  taxCode: string;
  contactName: string;
  phone: string;
  email: string;
  accountNo: string;
  note: string;
  status: string;
};

const tabs = [
  { type: "BRANCH", label: "Cửa hàng", icon: "storefront", hint: "1.1 - Đơn vị vận hành" },
  { type: "DEPARTMENT", label: "Phòng ban", icon: "groups", hint: "1.1 - Bộ phận nội bộ" },
  { type: "WAREHOUSE", label: "Kho hàng", icon: "warehouse", hint: "1.1 - Địa điểm lưu kho" },
  { type: "PARTNER", label: "Đối tác", icon: "handshake", hint: "1.1 - Khách hàng, NCC, Đối tác" },
  { type: "MONEY_SOURCE", label: "Nguồn tiền", icon: "account_balance_wallet", hint: "1.1 - Quỹ/Ngân hàng/Ví" },
  { type: "REVENUE_EXPENSE_CATEGORY", label: "Thu / Chi", icon: "category", hint: "1.2 - OPEX/CAPEX/Giá vốn/Doanh thu" },
  { type: "ACCOUNTING_PERIOD", label: "Kỳ kế toán", icon: "calendar_month", hint: "1.4 - Mở/khóa kỳ ghi sổ" },
  { type: "DOCUMENT_TYPE", label: "Loại chứng từ", icon: "receipt_long", hint: "1.4 - Phiếu thu/chi/cọc" },
  { type: "DOCUMENT_NUMBER_RULE", label: "Quy tắc mã", icon: "tag", hint: "1.4 - Thiết lập số chứng tự tự sinh" },
  { type: "SYSTEM_PARAM", label: "Tham số hệ thống", icon: "tune", hint: "1.4 - Thuế VAT/trạng thái nghiệp vụ" },
];

const emptyForm: MasterDataForm = {
  type: "BRANCH",
  code: "",
  name: "",
  group: "",
  partnerType: "",
  partnerGroup: "EXTERNAL",
  branch: "",
  taxCode: "",
  contactName: "",
  phone: "",
  email: "",
  accountNo: "",
  note: "",
  status: "ACTIVE",
};

const groupPlaceholders: Record<string, string> = {
  BRANCH: "VD: Branch / Head Office",
  DEPARTMENT: "VD: Back office / Operation",
  WAREHOUSE: "VD: Nguyen vat lieu / Thanh pham",
  PARTNER: "VD: Khach hang / Nha cung cap / Doi tac",
  MONEY_SOURCE: "VD: Tien mat / Ngan hang / Vi/POS",
  REVENUE_EXPENSE_CATEGORY: "VD: OPEX / CAPEX / Gia von / Nguon doanh thu",
  ACCOUNTING_PERIOD: "VD: OPEN / CLOSED",
  DOCUMENT_TYPE: "VD: Thu / Chi / Tien coc",
  DOCUMENT_NUMBER_RULE: "VD: PT / PC / COC",
  SYSTEM_PARAM: "VD: Thue / Trang thai nghiep vu",
};

const notePlaceholders: Record<string, string> = {
  REVENUE_EXPENSE_CATEGORY: "VD: dung cho import doanh thu, phan loai chi phi hoac P&L",
  ACCOUNTING_PERIOD: "VD: ngay bat dau/ket thuc ky, ghi chu khoa so",
  DOCUMENT_TYPE: "VD: chung tu thu tien, chi tien, ghi nhan tien coc",
  DOCUMENT_NUMBER_RULE: "VD: PT-{YYYYMM}-{SEQ3}",
  SYSTEM_PARAM: "VD: VAT 8%, trang thai nghiep vu...",
};

function getSessionFromStorage(): DemoSession | null {
  const rawSession = localStorage.getItem(SESSION_KEY);
  if (!rawSession) return null;
  try {
    return JSON.parse(rawSession) as DemoSession;
  } catch {
    return null;
  }
}

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [items, setItems] = useState<MasterDataItem[]>([]);
  const [allItems, setAllItems] = useState<MasterDataItem[]>([]);
  const [activeType, setActiveType] = useState("BRANCH");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<MasterDataForm>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [showDrawer, setShowDrawer] = useState(false);

  const activeTab = tabs.find((tab) => tab.type === activeType) || tabs[0];

  useEffect(() => {
    const session = getSessionFromStorage();
    const menu = appMenuItems.find((item) => item.href === "/settings");
    if (!session) {
      router.push("/login?next=/settings");
      return;
    }
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setIsCheckingAuth(false);
    }, 0);
  }, [router]);

  const loadItems = async () => {
    setIsLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams();
      params.set("type", activeType);
      if (search.trim()) params.set("search", search.trim());

      const [activeResponse, allResponse] = await Promise.all([
        fetch(`/api/master-data?${params.toString()}`),
        fetch("/api/master-data"),
      ]);

      if (!activeResponse.ok || !allResponse.ok) {
        throw new Error("Không tải được danh mục");
      }

      setItems((await activeResponse.json()) as MasterDataItem[]);
      setAllItems((await allResponse.json()) as MasterDataItem[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi tải danh mục");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        void loadItems();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, isCheckingAuth]);

  const stats = useMemo(() => {
    return tabs.map((tab) => {
      const tabItems = allItems.filter((item) => item.type === tab.type);
      return {
        ...tab,
        count: tabItems.length,
        active: tabItems.filter((item) => item.status === "ACTIVE").length,
      };
    });
  }, [allItems]);

  const canManageSettings = user ? canPerformAction(user.role, "config") : false;

  const resetForm = (type = activeType) => {
    setForm({ ...emptyForm, type, partnerGroup: "EXTERNAL" });
    setMessage("");
  };

  const selectTab = (type: string) => {
    setActiveType(type);
    resetForm(type);
  };

  const editItem = (item: MasterDataItem) => {
    if (!canManageSettings) {
      setMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setForm({
      id: item.id,
      type: item.type,
      code: item.code,
      name: item.name,
      group: item.group || "",
      partnerType: item.partnerType || item.group || "",
      partnerGroup: item.partnerGroup || "EXTERNAL",
      branch: item.branch || "",
      taxCode: item.taxCode || "",
      contactName: item.contactName || "",
      phone: item.phone || "",
      email: item.email || "",
      accountNo: item.accountNo || "",
      note: item.note || "",
      status: item.status,
    });
    setShowDrawer(true);
  };

  const saveItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManageSettings) {
      setMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/master-data", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Không lưu được danh mục");
      }
      resetForm(form.type);
      setShowDrawer(false);
      setMessage(form.id ? "Đã cập nhật danh mục thành công." : "Đã thêm danh mục mới thành công.");
      await loadItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi lưu danh mục");
    } finally {
      setIsSaving(false);
    }
  };

  const toggleStatus = async (item: MasterDataItem) => {
    if (!canManageSettings) {
      setMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    const nextStatus = item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setMessage("");
    try {
      const response = await fetch("/api/master-data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: nextStatus }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Không đổi được trạng thái");
      }
      await loadItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi đổi trạng thái");
    }
  };

  const exportToCSV = () => {
    if (items.length === 0) {
      alert("Không có dữ liệu để xuất");
      return;
    }

    const headers = ["Mã danh mục", "Tên hiển thị", "Phân loại/Nhóm", "Cửa hàng", "MST/STK/Ghi chú", "Trạng thái"];
    const rows = items.map((item) => [
      item.code,
      item.name,
      item.type === "PARTNER"
        ? `${item.partnerType || item.group || ""} (${item.partnerGroup || "EXTERNAL"})`
        : item.group || "-",
      storeLabel(item.branch),
      item.contactName || item.accountNo || item.note || "-",
      item.status === "ACTIVE" ? "Hoạt động" : "Ngừng hoạt động",
    ]);

    const csvContent = "\uFEFF" + [
      headers.join(","),
      ...rows.map(e => e.map(val => `"${val.replace(/"/g, '""')}"`).join(","))
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `danh_muc_${activeType.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY);
    document.cookie = `${SESSION_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT;`;
    router.push("/login");
  };

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 font-sans">
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>

      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-700 transition"
            title="Về dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Cấu hình Danh mục & Tham số</h1>
            <p className="text-xs text-slate-500">
              Nhóm A 1.1 - 1.4: dữ liệu nền cho thu/chi, tiền cọc, số dư đầu kỳ và cung ứng.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:block text-right">
            <p className="text-xs font-bold text-slate-900">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{displayRoleName(user?.role)}</p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold hover:bg-slate-50 transition"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
          {/* Left Excel-sheet Sidebar */}
          <aside className="bg-white border border-slate-200 rounded-xl shadow-sm p-3 grid gap-1 sticky top-24">
            <p className="text-[11px] font-bold text-slate-400 px-3 py-1 uppercase tracking-wider">Danh mục Excel</p>
            {stats.map((tab) => (
              <button
                key={tab.type}
                onClick={() => selectTab(tab.type)}
                className={`text-left rounded-lg px-3 py-2.5 transition flex items-center gap-3 border ${
                  activeType === tab.type
                    ? "border-blue-200 bg-blue-50 text-blue-700 font-semibold shadow-sm"
                    : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <span className="material-symbols-outlined text-lg">{tab.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{tab.label}</p>
                </div>
                <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${
                  activeType === tab.type ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600"
                }`}>
                  {tab.active}/{tab.count}
                </span>
              </button>
            ))}
          </aside>

          {/* Right Workspace Content */}
          <div className="space-y-6">
            {message && (
              <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-4 py-3 shadow-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg">info</span>
                {message}
              </p>
            )}

            <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              {/* Toolbar */}
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/50">
                <div>
                  <h2 className="font-bold text-lg text-slate-900">{activeTab.label}</h2>
                  <p className="text-xs text-slate-500 mt-0.5">{activeTab.hint}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Search Box */}
                  <div className="flex border border-slate-300 rounded-lg overflow-hidden bg-white shadow-sm focus-within:ring-2 focus-within:ring-blue-500 transition">
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="px-3 py-1.5 text-xs outline-none w-40 sm:w-48 text-slate-700"
                      placeholder="Tìm mã/tên/nhóm..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void loadItems();
                      }}
                    />
                    <button
                      onClick={loadItems}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 text-xs font-bold transition border-l border-slate-200 flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[15px]">search</span>
                      Tìm
                    </button>
                  </div>

                  {canManageSettings && (
                    <button
                      onClick={() => {
                        resetForm();
                        setShowDrawer(true);
                      }}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
                    >
                      <span className="material-symbols-outlined text-[16px]">add</span>
                      Thêm mới
                    </button>
                  )}

                  <button
                    onClick={() => router.push("/imports")}
                    className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">upload_file</span>
                    Import
                  </button>

                  <button
                    onClick={exportToCSV}
                    className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">download</span>
                    Xuất Excel
                  </button>
                </div>
              </div>

              {/* Data Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold border-b border-slate-200">
                    <tr>
                      <th className="px-4 py-3">Mã / Tên</th>
                      <th className="px-4 py-3">Phân loại</th>
                      <th className="px-4 py-3">Cửa hàng</th>
                      <th className="px-4 py-3">Chi tiết / Ghi chú</th>
                      <th className="px-4 py-3">Trạng thái</th>
                      {canManageSettings && <th className="px-4 py-3 text-right">Thao tác</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {isLoading ? (
                      <tr>
                        <td colSpan={canManageSettings ? 6 : 5} className="px-4 py-12 text-center text-slate-400">
                          Đang tải dữ liệu danh mục...
                        </td>
                      </tr>
                    ) : items.length === 0 ? (
                      <tr>
                        <td colSpan={canManageSettings ? 6 : 5} className="px-4 py-12 text-center text-slate-400">
                          Chưa có dữ liệu cho danh mục này.
                        </td>
                      </tr>
                    ) : (
                      items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50 transition">
                          <td className="px-4 py-3">
                            <p className="font-bold text-slate-900">{item.code}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{item.name}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded w-fit">
                              {item.type === "PARTNER" ? item.partnerType || item.group || "-" : item.group || "-"}
                            </p>
                            {item.type === "PARTNER" && (
                              <p className="text-[10px] text-slate-500 mt-0.5 font-bold uppercase">{item.partnerGroup || "EXTERNAL"}</p>
                            )}
                          </td>
                          <td className="px-4 py-3 font-medium">{storeLabel(item.branch)}</td>
                          <td className="px-4 py-3 max-w-xs truncate">
                            <p className="font-medium text-xs text-slate-800">{item.contactName || item.accountNo || "-"}</p>
                            <p className="text-[11px] text-slate-500 mt-0.5 italic">{item.phone || item.email || item.taxCode || item.note || ""}</p>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                                item.status === "ACTIVE"
                                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                  : "bg-slate-100 text-slate-500"
                              }`}
                            >
                              {item.status === "ACTIVE" ? "Hoạt động" : "Ngừng dùng"}
                            </span>
                          </td>
                          {canManageSettings && (
                            <td className="px-4 py-3 text-right">
                              <button
                                onClick={() => editItem(item)}
                                className="text-xs font-bold text-blue-600 hover:text-blue-800 mr-4 transition"
                              >
                                Sửa
                              </button>
                              <button
                                onClick={() => toggleStatus(item)}
                                className={`text-xs font-bold transition ${
                                  item.status === "ACTIVE" ? "text-slate-500 hover:text-slate-700" : "text-emerald-600 hover:text-emerald-800"
                                }`}
                              >
                                {item.status === "ACTIVE" ? "Ngừng" : "Kích hoạt"}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* Slide-out Drawer Panel for Add/Edit form */}
      {showDrawer && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Overlay mask */}
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity cursor-pointer"
            onClick={() => setShowDrawer(false)}
          />
          {/* Drawer content */}
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col animate-slide-in border-l border-slate-200">
            {/* Drawer Header */}
            <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{activeTab.hint}</p>
                <h2 className="font-bold text-lg text-slate-900 mt-0.5">
                  {form.id ? "Cập nhật" : "Thêm mới"} {activeTab.label.toLowerCase()}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowDrawer(false)}
                className="h-8 w-8 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            {/* Form */}
            <form onSubmit={saveItem} className="flex-1 overflow-y-auto p-6 space-y-5">
              <input type="hidden" value={form.type} />

              <div className="grid grid-cols-2 gap-4">
                <label className="text-xs font-bold text-slate-700 block">
                  Mã danh mục *
                  <input
                    data-input-kind="code"
                    value={form.code}
                    onChange={(event) => setForm((value) => ({ ...value, code: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm uppercase outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                    placeholder="VD: STORE_01"
                    required
                  />
                </label>
                <label className="text-xs font-bold text-slate-700 block">
                  Trạng thái
                  <select
                    value={form.status}
                    onChange={(event) => setForm((value) => ({ ...value, status: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                  >
                    <option value="ACTIVE">Hoạt động</option>
                    <option value="INACTIVE">Ngừng dùng</option>
                  </select>
                </label>
              </div>

              <label className="text-xs font-bold text-slate-700 block">
                Tên danh mục *
                <input
                  value={form.name}
                  onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
                  className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  placeholder="Tên hiển thị trực quan"
                  required
                />
              </label>

              <div className="grid grid-cols-2 gap-4">
                <label className="text-xs font-bold text-slate-700 block">
                  Nhóm / Loại
                  {activeType === "PARTNER" ? (
                    <select
                      value={form.partnerType || form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value, partnerType: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn loại đối tác --</option>
                      <option value="CUSTOMER">CUSTOMER (Khách hàng)</option>
                      <option value="SUPPLIER">SUPPLIER (Nhà cung cấp)</option>
                      <option value="BOTH">BOTH (Khách hàng & NCC)</option>
                      <option value="EMPLOYEE">EMPLOYEE (Nhân viên)</option>
                      <option value="OTHER_PARTNER">OTHER_PARTNER (Đối tác khác)</option>
                    </select>
                  ) : activeType === "MONEY_SOURCE" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn nhóm nguồn tiền --</option>
                      <option value="CASH">CASH (Tiền mặt)</option>
                      <option value="BANK">BANK (Tài khoản ngân hàng)</option>
                      <option value="WALLET">WALLET (Ví điện tử / Cổng POS)</option>
                    </select>
                  ) : activeType === "REVENUE_EXPENSE_CATEGORY" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn nhóm thu/chi --</option>
                      <option value="OPEX">OPEX (Chi phí vận hành)</option>
                      <option value="CAPEX">CAPEX (Chi phí đầu tư)</option>
                      <option value="COGS">COGS (Giá vốn)</option>
                      <option value="REVENUE_SOURCE">REVENUE_SOURCE (Nguồn doanh thu)</option>
                    </select>
                  ) : activeType === "ACCOUNTING_PERIOD" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn trạng thái kỳ --</option>
                      <option value="OPEN">OPEN (Đang mở)</option>
                      <option value="LOCKED">LOCKED (Khóa nhập liệu)</option>
                      <option value="CLOSED">CLOSED (Đã chốt sổ)</option>
                    </select>
                  ) : activeType === "DOCUMENT_TYPE" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn nhóm chứng từ --</option>
                      <option value="RECEIPT">RECEIPT (Phiếu thu)</option>
                      <option value="PAYMENT">PAYMENT (Phiếu chi)</option>
                      <option value="DEPOSIT">DEPOSIT (Tiền cọc)</option>
                      <option value="TRANSFER">TRANSFER (Điều tiền)</option>
                    </select>
                  ) : (
                    <input
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder={groupPlaceholders[activeType] || "VD: Nhóm"}
                    />
                  )}
                </label>

                {activeType === "PARTNER" && (
                  <label className="text-xs font-bold text-slate-700 block">
                    Nhóm đối tượng
                    <select
                      value={form.partnerGroup}
                      onChange={(event) => setForm((value) => ({ ...value, partnerGroup: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="EXTERNAL">EXTERNAL (Bên ngoài)</option>
                      <option value="INTERNAL">INTERNAL (Nội bộ)</option>
                    </select>
                  </label>
                )}

                <label className="text-xs font-bold text-slate-700 block">
                  Cửa hàng liên kết
                  {activeType === "WAREHOUSE" ? (
                    <select
                      value={form.branch}
                      onChange={(event) => setForm((value) => ({ ...value, branch: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn cửa hàng --</option>
                      {storeOptions.map((option) => (
                        <option key={option.code} value={option.code}>
                          {storeLabel(option.code)}
                        </option>
                      ))}
                    </select>
                  ) : activeType === "MONEY_SOURCE" ? (
                    <select
                      value={form.branch}
                      onChange={(event) => setForm((value) => ({ ...value, branch: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">-- Chọn cửa hàng --</option>
                      {branchScopeOptions.map((option) => (
                        <option key={option.code} value={option.code}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      data-input-kind="code"
                      value={form.branch}
                      onChange={(event) => setForm((value) => ({ ...value, branch: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder="VD: STORE_01"
                    />
                  )}
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <label className="text-xs font-bold text-slate-700">
                  Mã số thuế (MST)
                  <input
                    data-input-kind="tax-code"
                    value={form.taxCode}
                    onChange={(event) => setForm((value) => ({ ...value, taxCode: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  />
                </label>
                <label className="text-xs font-bold text-slate-700">
                  Số tài khoản ngân hàng
                  <input
                    data-input-kind="account-number"
                    value={form.accountNo}
                    onChange={(event) => setForm((value) => ({ ...value, accountNo: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <label className="text-xs font-bold text-slate-700">
                  Người liên hệ chính
                  <input
                    value={form.contactName}
                    onChange={(event) => setForm((value) => ({ ...value, contactName: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  />
                </label>
                <label className="text-xs font-bold text-slate-700">
                  Số điện thoại
                  <input
                    data-input-kind="phone"
                    value={form.phone}
                    onChange={(event) => setForm((value) => ({ ...value, phone: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  />
                </label>
              </div>

              <label className="text-xs font-bold text-slate-700 block">
                Địa chỉ email
                <input
                  data-input-kind="email"
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))}
                  className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                />
              </label>

              <label className="text-xs font-bold text-slate-700 block">
                Ghi chú / Giá trị cấu hình
                <textarea
                  value={form.note}
                  onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
                  className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-24 resize-none outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  placeholder={notePlaceholders[activeType] || "Thông tin bổ sung..."}
                />
              </label>
            </form>

            {/* Footer actions of drawer */}
            <div className="px-6 py-4 border-t border-slate-200 flex gap-3 bg-slate-50">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowDrawer(false);
                }}
                className="flex-1 border border-slate-300 rounded-lg py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-100 transition"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={saveItem}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold transition shadow-sm"
              >
                {isSaving ? "Đang lưu..." : form.id ? "Lưu cập nhật" : "Thêm mới"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
