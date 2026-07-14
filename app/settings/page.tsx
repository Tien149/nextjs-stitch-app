"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type MasterDataItem = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
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
  { type: "BRANCH", label: "Chi nhanh", icon: "apartment", hint: "1.1 - Don vi van hanh" },
  { type: "DEPARTMENT", label: "Phong ban", icon: "groups", hint: "1.1 - Bo phan noi bo" },
  { type: "WAREHOUSE", label: "Kho", icon: "warehouse", hint: "1.1 - Kho hang" },
  { type: "PARTNER", label: "Doi tac", icon: "handshake", hint: "1.1 - KH/NCC/Doi tac" },
  { type: "MONEY_SOURCE", label: "Nguon tien", icon: "account_balance_wallet", hint: "1.1 - Quy/Ngan hang/Vi" },
  { type: "REVENUE_EXPENSE_CATEGORY", label: "Thu / Chi", icon: "category", hint: "1.2 - OPEX/CAPEX/Gia von/Doanh thu" },
  { type: "ACCOUNTING_PERIOD", label: "Ky ke toan", icon: "calendar_month", hint: "1.4 - Mo/khoa ky" },
  { type: "DOCUMENT_TYPE", label: "Loai chung tu", icon: "receipt_long", hint: "1.4 - Phieu thu/chi/coc" },
  { type: "DOCUMENT_NUMBER_RULE", label: "Quy tac ma", icon: "tag", hint: "1.4 - Ma chung tu tu dong" },
  { type: "SYSTEM_PARAM", label: "Tham so", icon: "tune", hint: "1.4 - VAT/trang thai" },
];

const emptyForm: MasterDataForm = {
  type: "BRANCH",
  code: "",
  name: "",
  group: "",
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
        throw new Error("Khong tai duoc danh muc");
      }

      setItems((await activeResponse.json()) as MasterDataItem[]);
      setAllItems((await allResponse.json()) as MasterDataItem[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Co loi khi tai danh muc");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        loadItems();
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
    setForm({ ...emptyForm, type });
    setMessage("");
  };

  const selectTab = (type: string) => {
    setActiveType(type);
    resetForm(type);
  };

  const editItem = (item: MasterDataItem) => {
    if (!canManageSettings) {
      setMessage("Ban chi co quyen xem danh muc.");
      return;
    }
    setForm({
      id: item.id,
      type: item.type,
      code: item.code,
      name: item.name,
      group: item.group || "",
      branch: item.branch || "",
      taxCode: item.taxCode || "",
      contactName: item.contactName || "",
      phone: item.phone || "",
      email: item.email || "",
      accountNo: item.accountNo || "",
      note: item.note || "",
      status: item.status,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManageSettings) {
      setMessage("Ban chi co quyen xem danh muc.");
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
        throw new Error(payload.error || "Khong luu duoc danh muc");
      }
      resetForm(form.type);
      setMessage(form.id ? "Da cap nhat danh muc." : "Da them danh muc moi.");
      await loadItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Co loi khi luu danh muc");
    } finally {
      setIsSaving(false);
    }
  };

  const toggleStatus = async (item: MasterDataItem) => {
    if (!canManageSettings) {
      setMessage("Ban chi co quyen xem danh muc.");
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
        throw new Error(payload.error || "Khong doi duoc trang thai");
      }
      await loadItems();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Co loi khi doi trang thai");
    }
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
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center"
            title="Ve dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">Cau hinh Danh muc & Tham so</h1>
            <p className="text-xs text-slate-500">
              Nhom A 1.1 - 1.4: du lieu nen cho thu/chi, tien coc, so du dau ky va import.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:block text-right">
            <p className="text-xs font-bold">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{user?.role}</p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold hover:bg-slate-50"
          >
            Dang xuat
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {stats.map((tab) => (
            <button
              key={tab.type}
              onClick={() => selectTab(tab.type)}
              className={`text-left bg-white border rounded-xl p-4 shadow-sm transition ${
                activeType === tab.type ? "border-blue-500 ring-2 ring-blue-100" : "border-slate-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="material-symbols-outlined text-blue-600">{tab.icon}</span>
                <span className="text-xs font-bold bg-slate-100 rounded-full px-2 py-1">
                  {tab.active}/{tab.count}
                </span>
              </div>
              <p className="font-bold mt-3">{tab.label}</p>
              <p className="text-xs text-slate-500 mt-1">{tab.hint}</p>
            </button>
          ))}
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
          {!canManageSettings && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 h-fit">
              <p className="text-xs font-bold text-blue-600 uppercase">Quyen truy cap</p>
              <h2 className="font-bold text-lg mt-1">Chi xem danh muc</h2>
              <p className="text-sm text-slate-500 mt-2">
                Vai tro hien tai duoc xem danh muc nen, khong duoc them/sua/ngung dung cau hinh.
              </p>
            </div>
          )}

          <form onSubmit={saveItem} className={`bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 ${canManageSettings ? "" : "hidden"}`}>
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">{activeTab.hint}</p>
              <h2 className="font-bold text-lg mt-1">
                {form.id ? "Cap nhat" : "Them moi"} {activeTab.label.toLowerCase()}
              </h2>
            </div>

            <input type="hidden" value={form.type} />

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                Ma danh muc *
                <input
                  value={form.code}
                  onChange={(event) => setForm((value) => ({ ...value, code: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm uppercase"
                  placeholder="VD: HCM"
                  required
                />
              </label>
              <label className="text-xs font-bold text-slate-600">
                Trang thai
                <select
                  value={form.status}
                  onChange={(event) => setForm((value) => ({ ...value, status: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="ACTIVE">Hoat dong</option>
                  <option value="INACTIVE">Ngung dung</option>
                </select>
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Ten danh muc *
              <input
                value={form.name}
                onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                placeholder="Ten hien thi"
                required
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                Nhom/Loai
                <input
                  value={form.group}
                  onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  placeholder={groupPlaceholders[activeType] || "VD: Khach hang"}
                />
              </label>
              <label className="text-xs font-bold text-slate-600">
                Chi nhanh
                <input
                  value={form.branch}
                  onChange={(event) => setForm((value) => ({ ...value, branch: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="VD: HCM"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                MST
                <input
                  value={form.taxCode}
                  onChange={(event) => setForm((value) => ({ ...value, taxCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-bold text-slate-600">
                So tai khoan
                <input
                  value={form.accountNo}
                  onChange={(event) => setForm((value) => ({ ...value, accountNo: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                Nguoi lien he
                <input
                  value={form.contactName}
                  onChange={(event) => setForm((value) => ({ ...value, contactName: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="text-xs font-bold text-slate-600">
                Dien thoai
                <input
                  value={form.phone}
                  onChange={(event) => setForm((value) => ({ ...value, phone: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Email
              <input
                value={form.email}
                onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>

            <label className="text-xs font-bold text-slate-600 block">
              Ghi chu/gia tri cau hinh
              <textarea
                value={form.note}
                onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none"
                placeholder={notePlaceholders[activeType] || "Thong tin bo sung"}
              />
            </label>

            {message && (
              <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">
                {message}
              </p>
            )}

            <div className="flex gap-2">
              <button
                disabled={isSaving}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold"
              >
                {isSaving ? "Dang luu..." : form.id ? "Luu cap nhat" : "Them danh muc"}
              </button>
              <button
                type="button"
                onClick={() => resetForm()}
                className="px-4 rounded-lg border border-slate-200 text-sm font-bold hover:bg-slate-50"
              >
                Moi
              </button>
            </div>
          </form>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h2 className="font-bold">Danh sach {activeTab.label.toLowerCase()}</h2>
                <p className="text-xs text-slate-500 mt-1">Kiem tra trung ma, ngung dung thay vi xoa cung.</p>
              </div>
              <div className="flex gap-2">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="Tim ma/ten/nhom..."
                />
                <button
                  onClick={loadItems}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50"
                >
                  Tim
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3">Ma/Ten</th>
                    <th className="px-4 py-3">Nhom</th>
                    <th className="px-4 py-3">Chi nhanh</th>
                    <th className="px-4 py-3">Lien he/Ghi chu</th>
                    <th className="px-4 py-3">Trang thai</th>
                    {canManageSettings && <th className="px-4 py-3 text-right">Thao tac</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr>
                      <td colSpan={canManageSettings ? 6 : 5} className="px-4 py-10 text-center text-slate-400">
                        Dang tai danh muc...
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={canManageSettings ? 6 : 5} className="px-4 py-10 text-center text-slate-400">
                        Chua co du lieu.
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <p className="font-bold text-slate-900">{item.code}</p>
                          <p className="text-xs text-slate-500">{item.name}</p>
                        </td>
                        <td className="px-4 py-3">{item.group || "-"}</td>
                        <td className="px-4 py-3">{item.branch || "-"}</td>
                        <td className="px-4 py-3">
                          <p>{item.contactName || item.accountNo || item.note || "-"}</p>
                          <p className="text-xs text-slate-500">{item.phone || item.email || item.taxCode || ""}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs font-bold px-2 py-1 rounded ${
                              item.status === "ACTIVE"
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {item.status === "ACTIVE" ? "Hoat dong" : "Ngung dung"}
                          </span>
                        </td>
                        {canManageSettings && (
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => editItem(item)}
                              className="text-xs font-bold text-blue-600 hover:underline mr-3"
                            >
                              Sua
                            </button>
                            <button
                              onClick={() => toggleStatus(item)}
                              className="text-xs font-bold text-slate-600 hover:underline"
                            >
                              {item.status === "ACTIVE" ? "Ngung" : "Kich hoat"}
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
        </section>
      </main>
    </div>
  );
}
