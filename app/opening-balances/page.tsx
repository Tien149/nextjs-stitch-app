"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type OpeningBalance = {
  id: string;
  period: string;
  branchCode: string;
  balanceType: string;
  objectCode: string | null;
  objectName: string | null;
  moneySourceCode: string | null;
  amount: number;
  note: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

type OpeningBalanceForm = {
  period: string;
  branchCode: string;
  balanceType: string;
  objectCode: string;
  objectName: string;
  moneySourceCode: string;
  amount: string;
  note: string;
  status: string;
};

const balanceTypes = [
  { value: "CASH", label: "Tiền mặt", icon: "payments" },
  { value: "BANK", label: "Ngân hàng", icon: "account_balance" },
  { value: "WALLET_POS", label: "Ví/POS", icon: "point_of_sale" },
  { value: "AR", label: "Phải thu", icon: "call_received" },
  { value: "AP", label: "Phải trả", icon: "call_made" },
  { value: "DEPOSIT", label: "Tiền cọc", icon: "savings" },
];

const emptyForm: OpeningBalanceForm = {
  period: "2026-07",
  branchCode: "HCM",
  balanceType: "CASH",
  objectCode: "",
  objectName: "",
  moneySourceCode: "VCB_HCM",
  amount: "10000000",
  note: "",
  status: "DRAFT",
};

const statusLabels: Record<string, string> = {
  DRAFT: "Nháp",
  CONFIRMED: "Đã chốt",
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

export default function OpeningBalancesPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [balances, setBalances] = useState<OpeningBalance[]>([]);
  const [form, setForm] = useState<OpeningBalanceForm>(emptyForm);
  const [balanceTypeFilter, setBalanceTypeFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [branches, setBranches] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [moneySources, setMoneySources] = useState<any[]>([]);

  useEffect(() => {
    const session = getSessionFromStorage();
    const menu = appMenuItems.find((item) => item.href === "/opening-balances");
    if (!session) {
      router.push("/login?next=/opening-balances");
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

  const formatCurrency = (amount: number) => new Intl.NumberFormat("vi-VN").format(amount);

  const loadBalances = async () => {
    setIsLoading(true);
    setMessage("");
    try {
      const params = new URLSearchParams();
      if (balanceTypeFilter !== "ALL") params.set("balanceType", balanceTypeFilter);
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      const response = await fetch(`/api/opening-balances?${params.toString()}`);
      if (!response.ok) throw new Error("Không tải được số dư đầu kỳ");
      setBalances((await response.json()) as OpeningBalance[]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi tải số dư đầu kỳ");
    } finally {
      setIsLoading(false);
    }
  };

  const loadMasterData = async () => {
    try {
      const response = await fetch("/api/master-data?status=ACTIVE");
      if (response.ok) {
        const data = await response.json();
        const activeBranches = data.filter((item: any) => item.type === "BRANCH");
        const activePartners = data.filter((item: any) => item.type === "PARTNER");
        const activeMoneySources = data.filter((item: any) => item.type === "MONEY_SOURCE");
        setBranches(activeBranches);
        setPartners(activePartners);
        setMoneySources(activeMoneySources);
        
        // Update form with default values if they are empty
        setForm(prev => {
          const firstBranch = activeBranches[0]?.code || "";
          const firstPartner = activePartners[0] || null;
          const firstMoneySource = activeMoneySources.find((item: any) => !firstBranch || item.branch === firstBranch)?.code || activeMoneySources[0]?.code || "";
          return {
            ...prev,
            branchCode: prev.branchCode || firstBranch,
            objectCode: prev.objectCode || (firstPartner ? firstPartner.code : ""),
            objectName: prev.objectName || (firstPartner ? firstPartner.name : ""),
            moneySourceCode: prev.moneySourceCode || firstMoneySource,
          };
        });
      }
    } catch (error) {
      console.error("Failed to load master data", error);
    }
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        loadBalances();
        loadMasterData();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingAuth, balanceTypeFilter, statusFilter]);

  const handlePartnerChange = (code: string) => {
    const p = partners.find(item => item.code === code);
    setForm(value => ({
      ...value,
      objectCode: code,
      objectName: p ? p.name : "",
    }));
  };

  const totals = useMemo(() => {
    return balances.reduce(
      (result, item) => {
        result.count += 1;
        result.amount += item.amount;
        if (item.status === "CONFIRMED") result.confirmed += item.amount;
        return result;
      },
      { count: 0, amount: 0, confirmed: 0 },
    );
  }, [balances]);
  const canManageOpeningBalances = user ? canPerformAction(user.role, "config") : false;
  const canReopenOpeningBalances = user?.role === "Admin";

  const createBalance = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManageOpeningBalances) {
      setMessage("Bạn chỉ có quyền xem số dư đầu kỳ.");
      return;
    }

    const isSourceType = ["CASH", "BANK", "WALLET_POS"].includes(form.balanceType);
    const isObjectType = ["AR", "AP", "DEPOSIT"].includes(form.balanceType);

    if (isSourceType && !form.moneySourceCode) {
      setMessage("Đối với số dư quỹ/ngân hàng/ví, bắt buộc phải chọn Nguồn tiền.");
      return;
    }

    if (isObjectType && !form.objectCode) {
      setMessage("Đối với số dư công nợ/tiền cọc, bắt buộc phải chọn Đối tượng.");
      return;
    }

    setIsSaving(true);
    setMessage("");
    try {
      const payload = {
        ...form,
        objectCode: isObjectType ? form.objectCode : "",
        objectName: isObjectType ? form.objectName : "",
        moneySourceCode: isSourceType ? form.moneySourceCode : "",
      };

      const response = await fetch("/api/opening-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const resData = await response.json();
      if (!response.ok) throw new Error(resData.error || "Không tạo được số dư đầu kỳ");
      setForm({
        ...emptyForm,
        branchCode: branches[0]?.code || "",
        objectCode: partners[0]?.code || "",
        objectName: partners[0]?.name || "",
        moneySourceCode: moneySources[0]?.code || "",
      });
      setMessage("Đã thêm số dư đầu kỳ.");
      await loadBalances();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi lưu số dư đầu kỳ");
    } finally {
      setIsSaving(false);
    }
  };

  const updateStatus = async (balance: OpeningBalance, status: string) => {
    if (!canManageOpeningBalances) {
      setMessage("Bạn chỉ có quyền xem số dư đầu kỳ.");
      return;
    }
    setMessage("");
    const response = await fetch("/api/opening-balances", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: balance.id, status }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không cập nhật được trạng thái");
      return;
    }
    setMessage(status === "CONFIRMED" ? "Đã chốt số dư đầu kỳ." : "Đã mở lại bản nháp.");
    await loadBalances();
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
            title="Về dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">Cấu hình Số dư Đầu kỳ</h1>
            <p className="text-xs text-slate-500">Nhóm F 6.1: nhập số dư tiền, công nợ và tiền cọc trước khi go-live.</p>
          </div>
        </div>
        <div className="hidden sm:block text-right">
          <p className="text-xs font-bold">{user?.name}</p>
          <p className="text-[11px] text-slate-500">{user?.role}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
            <p className="text-xs font-bold text-slate-500 uppercase">Dòng số dư</p>
            <p className="text-2xl font-bold mt-2">{totals.count}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
            <p className="text-xs font-bold text-slate-500 uppercase">Tổng đang xem</p>
            <p className="text-2xl font-bold mt-2">{formatCurrency(totals.amount)} đ</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
            <p className="text-xs font-bold text-slate-500 uppercase">Đã chốt</p>
            <p className="text-2xl font-bold mt-2 text-emerald-700">{formatCurrency(totals.confirmed)} đ</p>
          </div>
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
          {!canManageOpeningBalances && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 h-fit">
              <p className="text-xs font-bold text-blue-600 uppercase">Quyền truy cập</p>
              <h2 className="font-bold text-lg mt-1">Chỉ xem số dư đầu kỳ</h2>
              <p className="text-sm text-slate-500 mt-2">
                Vai trò hiện tại được xem và lọc số dư, không được nhập mới, chốt hoặc mở lại số dư.
              </p>
            </div>
          )}

          <form onSubmit={createBalance} className={`bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 ${canManageOpeningBalances ? "" : "hidden"}`}>
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">6.1 Số dư đầu kỳ</p>
              <h2 className="font-bold text-lg mt-1">Nhập số dư</h2>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                Kỳ *
                <input
                  value={form.period}
                  onChange={(event) => setForm((value) => ({ ...value, period: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  placeholder="2026-07"
                  required
                />
              </label>
              <label className="text-xs font-bold text-slate-600">
                Chi nhánh *
                <select
                  value={form.branchCode}
                  onChange={(event) => setForm((value) => ({ ...value, branchCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  required
                >
                  <option value="">-- Chon chi nhanh --</option>
                  {branches.map(item => (
                    <option key={item.id} value={item.code}>
                      [{item.code}] {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Loại số dư *
              <select
                value={form.balanceType}
                onChange={(event) => setForm((value) => ({ ...value, balanceType: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                required
              >
                {balanceTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                Ma doi tuong (Cong no/Coc)
                <select
                  value={form.objectCode}
                  onChange={(event) => handlePartnerChange(event.target.value)}
                  disabled={["CASH", "BANK", "WALLET_POS"].includes(form.balanceType)}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  <option value="">-- Chon doi tac --</option>
                  {partners.map(item => (
                    <option key={item.id} value={item.code}>
                      [{item.code}] {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-bold text-slate-600">
                Nguon tien (Quy/Ngan hang)
                <select
                  value={form.moneySourceCode}
                  onChange={(event) => setForm((value) => ({ ...value, moneySourceCode: event.target.value }))}
                  disabled={["AR", "AP", "DEPOSIT"].includes(form.balanceType)}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                >
                  <option value="">-- Chon nguon tien --</option>
                  {moneySources
                    .filter(item => !form.branchCode || item.branch === form.branchCode)
                    .map(item => (
                      <option key={item.id} value={item.code}>
                        [{item.code}] {item.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Ten doi tuong
              <input
                value={form.objectName}
                readOnly
                className="mt-1 w-full border border-slate-200 bg-slate-50 text-slate-500 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed"
                placeholder="Ten khach hang/nha cung cap tu dong dien"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600">
                Số tiền *
                <input
                  value={form.amount}
                  onChange={(event) => setForm((value) => ({ ...value, amount: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                  inputMode="numeric"
                  required
                />
              </label>
              <label className="text-xs font-bold text-slate-600">
                Trạng thái
                <select
                  value={form.status}
                  onChange={(event) => setForm((value) => ({ ...value, status: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="DRAFT">Nháp</option>
                  <option value="CONFIRMED">Đã chốt</option>
                </select>
              </label>
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Ghi chú
              <textarea
                value={form.note}
                onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none"
              />
            </label>

            {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}

            <button disabled={isSaving} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold">
              {isSaving ? "Đang lưu..." : "Thêm số dư đầu kỳ"}
            </button>
          </form>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col lg:flex-row gap-3 lg:items-center justify-between">
              <div>
                <h2 className="font-bold">Danh sách số dư</h2>
                <p className="text-xs text-slate-500 mt-1">Chốt số dư sau khi kế toán kiểm tra đúng kỳ, chi nhánh và nguồn tiền.</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={balanceTypeFilter}
                  onChange={(event) => setBalanceTypeFilter(event.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="ALL">Tất cả loại</option>
                  {balanceTypes.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value="ALL">Tất cả trạng thái</option>
                  <option value="DRAFT">Nháp</option>
                  <option value="CONFIRMED">Đã chốt</option>
                </select>
                <button onClick={loadBalances} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">
                  Tải lại
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-3">Kỳ/Chi nhánh</th>
                    <th className="px-4 py-3">Loại</th>
                    <th className="px-4 py-3">Đối tượng</th>
                    <th className="px-4 py-3">Số tiền</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    {canManageOpeningBalances && <th className="px-4 py-3 text-right">Thao tác</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr>
                      <td colSpan={canManageOpeningBalances ? 6 : 5} className="px-4 py-10 text-center text-slate-400">
                        Đang tải số dư...
                      </td>
                    </tr>
                  ) : balances.length === 0 ? (
                    <tr>
                      <td colSpan={canManageOpeningBalances ? 6 : 5} className="px-4 py-10 text-center text-slate-400">
                        Chưa có số dư đầu kỳ.
                      </td>
                    </tr>
                  ) : (
                    balances.map((balance) => {
                      const type = balanceTypes.find((item) => item.value === balance.balanceType);
                      return (
                        <tr key={balance.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3">
                            <p className="font-bold">{balance.period}</p>
                            <p className="text-xs text-slate-500">{balance.branchCode}</p>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-blue-600 text-lg">{type?.icon || "database"}</span>
                              <span>{type?.label || balance.balanceType}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-bold">{balance.objectName || balance.objectCode || balance.moneySourceCode || "-"}</p>
                            <p className="text-xs text-slate-500">{balance.note || balance.moneySourceCode || ""}</p>
                          </td>
                          <td className="px-4 py-3 font-bold">{formatCurrency(balance.amount)} đ</td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-xs font-bold px-2 py-1 rounded ${
                                balance.status === "CONFIRMED"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {statusLabels[balance.status] || balance.status}
                            </span>
                          </td>
                          {canManageOpeningBalances && (
                            <td className="px-4 py-3 text-right">
                              {balance.status === "CONFIRMED" ? (
                                canReopenOpeningBalances ? (
                                  <button onClick={() => updateStatus(balance, "DRAFT")} className="text-xs font-bold text-slate-600 hover:underline">
                                    Mở lại
                                  </button>
                                ) : (
                                  <span className="text-xs font-bold text-slate-400">Đã khóa</span>
                                )
                              ) : (
                                <button onClick={() => updateStatus(balance, "CONFIRMED")} className="text-xs font-bold text-emerald-700 hover:underline">
                                  Chốt số dư
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
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
