"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { DateInput } from "@/components/DateInput";
import { storeLabel } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type DepositHistory = {
  id: string;
  action: string;
  amount: number | null;
  actionDate: string | null;
  treatmentNote: string | null;
  note: string | null;
  actor: string | null;
  createdAt: string;
};

type Deposit = {
  id: string;
  code: string;
  receivedDate: string;
  partnerCode: string;
  partnerName: string;
  branchCode: string;
  moneySourceCode: string;
  amount: number;
  remainingAmount: number;
  purpose: string;
  status: string;
  note: string | null;
  histories: DepositHistory[];
};

type MasterDataOption = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
};

const emptyForm = {
  receivedDate: new Date().toISOString().slice(0, 10),
  partnerCode: "KH_ABC",
  partnerName: "Công ty TNHH ABC",
  branchCode: "HCM",
  moneySourceCode: "VCB_HCM",
  amount: "50000000",
  purpose: "Đặt cọc hợp đồng dịch vụ",
  note: "",
};

const statusLabels: Record<string, string> = {
  HOLDING: "Đang giữ cọc",
  OFFSET: "Đã cấn trừ",
  REFUNDED: "Đã hoàn",
  CANCELLED: "Đã hủy",
  REVENUE: "Chuyển doanh thu",
};

const depositActionOptions = [
  { value: "OFFSET", label: "Can tru vao bill", requiresAmount: true },
  { value: "SUPPLEMENT", label: "Khach chuyen bo sung", requiresAmount: true },
  { value: "REFUND", label: "Hoan coc", requiresAmount: false },
  { value: "TRANSFER_REVENUE", label: "Chuyen doanh thu", requiresAmount: false },
] as const;

export default function DepositsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [branches, setBranches] = useState<MasterDataOption[]>([]);
  const [partners, setPartners] = useState<MasterDataOption[]>([]);
  const [moneySources, setMoneySources] = useState<MasterDataOption[]>([]);
  const [branchScope, setBranchScope] = useState("ALL");
  const [processForm, setProcessForm] = useState({
    depositId: "",
    action: "OFFSET",
    actionDate: new Date().toISOString().slice(0, 10),
    amount: "",
    note: "",
  });

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/deposits");
    if (!raw) {
      router.push("/login?next=/deposits");
      return;
    }
    try {
      const session = JSON.parse(raw) as DemoSession;
      if (!menu || !canAccessMenu(session.role, menu)) {
        router.push("/");
        return;
      }
      window.setTimeout(() => {
        setUser(session);
        const initialBranch = resolveInitialBranchScope(session);
        setBranchScope(initialBranch);
        if (initialBranch !== "ALL") {
          setForm((current) => ({ ...current, branchCode: initialBranch }));
        }
        setIsCheckingAuth(false);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/deposits");
    }
  }, [router]);

  const formatCurrency = (amount: number) => new Intl.NumberFormat("vi-VN").format(amount);
  const canCreateDeposits = user ? canPerformAction(user.role, "create") : false;
  const canProcessDeposits = user ? canPerformAction(user.role, "edit") : false;

  const loadDeposits = async () => {
    setMessage("");
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    params.set("branchCode", branchScope);
    const response = await fetch(`/api/deposits?${params.toString()}`);
    if (!response.ok) {
      setMessage("Không tải được danh sách tiền cọc");
      return;
    }
    setDeposits((await response.json()) as Deposit[]);
  };

  const loadMasterData = async () => {
    try {
      const response = await fetch("/api/master-data?status=ACTIVE");
      if (response.ok) {
        const data = (await response.json()) as MasterDataOption[];
        const activeBranches = data.filter((item) => item.type === "BRANCH");
        const activePartners = data.filter((item) => item.type === "PARTNER");
        const activeMoneySources = data.filter((item) => item.type === "MONEY_SOURCE");
        setBranches(activeBranches);
        setPartners(activePartners);
        setMoneySources(activeMoneySources);
        
        // Update form with default values if they are empty
        setForm(prev => {
          const firstBranch = branchScope !== "ALL" ? branchScope : activeBranches[0]?.code || "";
          const firstPartner = activePartners[0] || null;
          const firstMoneySource = activeMoneySources.find((item) => !firstBranch || item.branch === firstBranch)?.code || activeMoneySources[0]?.code || "";
          return {
            ...prev,
            branchCode: branchScope !== "ALL" ? firstBranch : prev.branchCode || firstBranch,
            partnerCode: prev.partnerCode || (firstPartner ? firstPartner.code : ""),
            partnerName: prev.partnerName || (firstPartner ? firstPartner.name : ""),
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
        loadDeposits();
        loadMasterData();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingAuth, branchScope]);

  const handlePartnerChange = (code: string) => {
    const p = partners.find(item => item.code === code);
    setForm(value => ({
      ...value,
      partnerCode: code,
      partnerName: p ? p.name : "",
    }));
  };

  const createDeposit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreateDeposits) {
      setMessage("Bạn chỉ có quyền xem tiền cọc.");
      return;
    }
    setIsSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/deposits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, actor: user?.name }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Không tạo được phiếu cọc");
      setForm((current) => ({ ...emptyForm, branchCode: branchScope !== "ALL" ? branchScope : current.branchCode }));
      setMessage("Đã tạo phiếu cọc mới.");
      await loadDeposits();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi tạo phiếu cọc");
    } finally {
      setIsSaving(false);
    }
  };

  const selectedDeposit = deposits.find((deposit) => deposit.id === processForm.depositId) || null;
  const selectedAction = depositActionOptions.find((action) => action.value === processForm.action) || depositActionOptions[0];

  const openProcessForm = (deposit: Deposit, action = "OFFSET") => {
    const option = depositActionOptions.find((item) => item.value === action) || depositActionOptions[0];
    setProcessForm({
      depositId: deposit.id,
      action: option.value,
      actionDate: new Date().toISOString().slice(0, 10),
      amount: option.requiresAmount && option.value !== "SUPPLEMENT" ? String(deposit.remainingAmount) : "",
      note: option.label,
    });
  };

  const submitProcessDeposit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canProcessDeposits) {
      setMessage("Bạn không có quyền xử lý tiền cọc.");
      return;
    }
    if (!selectedDeposit) return;

    const amount = selectedAction.requiresAmount ? Number(processForm.amount) : selectedDeposit.remainingAmount;
    if (selectedAction.requiresAmount && (!amount || amount <= 0)) {
      setMessage("Số tiền xử lý phải lớn hơn 0.");
      return;
    }

    const response = await fetch("/api/deposits", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: selectedDeposit.id,
        action: selectedAction.value,
        actionDate: processForm.actionDate,
        amount,
        actor: user?.name,
        treatmentNote: selectedAction.label,
        note: processForm.note || selectedAction.label,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không xử lý được phiếu cọc");
      return;
    }
    setProcessForm({ depositId: "", action: "OFFSET", actionDate: new Date().toISOString().slice(0, 10), amount: "", note: "" });
    setMessage("Đã xử lý phiếu cọc.");
    await loadDeposits();
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
          <button onClick={() => router.push("/")} className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">Quản trị Tiền cọc</h1>
            <p className="text-xs text-slate-500">Nhóm B 2.1 - 2.3: ghi nhận, cấn trừ, hoàn/hủy cọc.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <BranchScopeSelect session={user} value={branchScope} onChange={setBranchScope} />
          <p className="hidden text-xs font-bold text-slate-500 sm:block">{user?.role}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-6">
        {!canCreateDeposits && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 h-fit">
            <p className="text-xs font-bold text-blue-600 uppercase">Quyền truy cập</p>
            <h2 className="font-bold text-lg mt-1">Chỉ xem tiền cọc</h2>
            <p className="text-sm text-slate-500 mt-2">
              Vai trò hiện tại được xem danh sách tiền cọc, không được tạo phiếu mới.
            </p>
          </div>
        )}

        <form onSubmit={createDeposit} className={`bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 ${canCreateDeposits ? "" : "hidden"}`}>
          <div>
            <p className="text-xs font-bold text-blue-600 uppercase">2.1 Ghi nhận cọc</p>
            <h2 className="font-bold text-lg mt-1">Tạo phiếu cọc</h2>
          </div>

          <label className="text-xs font-bold text-slate-600 block">
            Ngày nhận cọc *
            <DateInput value={form.receivedDate} onChange={(receivedDate) => setForm((value) => ({ ...value, receivedDate }))} className="mt-1" required ariaLabel="Ngày nhận cọc" />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Khách hàng *
            <select
              value={form.partnerCode}
              onChange={(e) => handlePartnerChange(e.target.value)}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">-- Chọn đối tác --</option>
              {partners.map(item => (
                <option key={item.id} value={item.code}>
                  [{item.code}] {item.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Tên khách hàng
            <input
              value={form.partnerName}
              readOnly
              className="mt-1 w-full border border-slate-200 bg-slate-50 text-slate-500 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed"
              placeholder="Tên khách hàng tự động điền"
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Cửa hàng *
            <select
              value={form.branchCode}
              onChange={(e) => setForm(val => ({ ...val, branchCode: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">-- Chọn cửa hàng --</option>
              {branches
                .filter((item) => branchScope === "ALL" || item.code === branchScope)
                .map(item => (
                  <option key={item.id} value={item.code}>
                    {storeLabel(item.code)}
                  </option>
                ))}
            </select>
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Nguồn tiền *
            <select
              value={form.moneySourceCode}
              onChange={(e) => setForm(val => ({ ...val, moneySourceCode: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">-- Chọn nguồn tiền --</option>
              {moneySources
                .filter(item => !form.branchCode || item.branch === form.branchCode)
                .map(item => (
                  <option key={item.id} value={item.code}>
                    [{item.code}] {item.name} ({item.group || ""})
                  </option>
                ))}
            </select>
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Số tiền *
            <input
              type="number"
              value={form.amount}
              onChange={(e) => setForm(val => ({ ...val, amount: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Nội dung cọc *
            <input
              type="text"
              value={form.purpose}
              onChange={(e) => setForm(val => ({ ...val, purpose: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Ghi chú
            <textarea
              value={form.note}
              onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              placeholder="Nhập ghi chú thêm..."
            />
          </label>

          {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}

          <button disabled={isSaving} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold transition-colors">
            {isSaving ? "Đang lưu..." : "Tạo phiếu cọc"}
          </button>
        </form>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row gap-3 md:items-center justify-between">
            <div>
              <h2 className="font-bold">Danh sách tiền cọc</h2>
              <p className="text-xs text-slate-500 mt-1">Cấn trừ không được vượt số tiền còn lại.</p>
            </div>
            <div className="flex gap-2">
              <input value={search} onChange={(event) => setSearch(event.target.value)} className="border border-slate-300 rounded-lg px-3 py-2 text-sm" placeholder="Tìm mã/khách hàng..." />
              <button onClick={loadDeposits} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tìm</button>
            </div>
          </div>

          {selectedDeposit && (
            <form onSubmit={submitProcessDeposit} className="border-b border-slate-200 bg-blue-50/60 p-4">
              <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_140px_1fr_1.4fr_auto] lg:items-end">
                <div>
                  <p className="text-[11px] font-bold uppercase text-blue-700">Xử lý tiền cọc</p>
                  <p className="mt-1 text-sm font-bold text-slate-900">{selectedDeposit.code} - {selectedDeposit.partnerName}</p>
                  <p className="text-xs text-slate-500">Còn giữ: {formatCurrency(selectedDeposit.remainingAmount)} đ</p>
                </div>
                <label className="text-xs font-bold text-slate-600">
                  Hướng xử lý
                  <select
                    value={processForm.action}
                    onChange={(event) => {
                      const nextAction = depositActionOptions.find((item) => item.value === event.target.value) || depositActionOptions[0];
                      setProcessForm((value) => ({
                        ...value,
                        action: nextAction.value,
                        amount: nextAction.requiresAmount && nextAction.value !== "SUPPLEMENT" ? String(selectedDeposit.remainingAmount) : "",
                        note: nextAction.label,
                      }));
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  >
                    {depositActionOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Ngày xử lý
                  <DateInput
                    value={processForm.actionDate}
                    onChange={(actionDate) => setProcessForm((value) => ({ ...value, actionDate }))}
                    className="mt-1"
                    required
                    ariaLabel="Ngày xử lý tiền cọc"
                  />
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Số tiền
                  <input
                    type="number"
                    value={selectedAction.requiresAmount ? processForm.amount : selectedDeposit.remainingAmount}
                    onChange={(event) => setProcessForm((value) => ({ ...value, amount: event.target.value }))}
                    readOnly={!selectedAction.requiresAmount}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 read-only:bg-slate-100"
                  />
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Ghi chú xử lý
                  <input
                    value={processForm.note}
                    onChange={(event) => setProcessForm((value) => ({ ...value, note: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </label>
                <div className="flex gap-2">
                  <button type="submit" className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-bold text-white hover:bg-blue-700">Lưu</button>
                  <button type="button" onClick={() => setProcessForm({ depositId: "", action: "OFFSET", actionDate: new Date().toISOString().slice(0, 10), amount: "", note: "" })} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Hủy</button>
                </div>
              </div>
            </form>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">Phiếu cọc</th>
                  <th className="px-4 py-3">Khách hàng</th>
                  <th className="px-4 py-3">Số tiền</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  {canProcessDeposits && <th className="px-4 py-3 text-right">Xử lý</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deposits.length === 0 ? (
                  <tr><td colSpan={canProcessDeposits ? 5 : 4} className="px-4 py-10 text-center text-slate-400">Chưa có phiếu cọc.</td></tr>
                ) : deposits.map((deposit) => (
                  <tr key={deposit.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <p className="font-bold">{deposit.code}</p>
                      <p className="text-xs text-slate-500">{storeLabel(deposit.branchCode)} - {deposit.moneySourceCode}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold">{deposit.partnerName}</p>
                      <p className="text-xs text-slate-500">{deposit.purpose}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold">{formatCurrency(deposit.amount)} đ</p>
                      <p className="text-xs text-emerald-600">Còn: {formatCurrency(deposit.remainingAmount)} đ</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-bold bg-slate-100 rounded px-2 py-1">{statusLabels[deposit.status] || deposit.status}</span>
                      {deposit.histories[0] && (
                        <p className="mt-1 text-[11px] text-slate-500">
                          {deposit.histories[0].treatmentNote || deposit.histories[0].action}
                          {" · "}
                          {new Date(deposit.histories[0].actionDate || deposit.histories[0].createdAt).toLocaleDateString("vi-VN")}
                        </p>
                      )}
                    </td>
                    {canProcessDeposits && (
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={() => openProcessForm(deposit, "OFFSET")} disabled={deposit.remainingAmount <= 0} className="text-xs font-bold text-blue-600 disabled:text-slate-300">Cấn trừ</button>
                        <button onClick={() => openProcessForm(deposit, "SUPPLEMENT")} className="text-xs font-bold text-slate-600">Bổ sung</button>
                        <button onClick={() => openProcessForm(deposit, "REFUND")} disabled={deposit.remainingAmount <= 0} className="text-xs font-bold text-emerald-600 disabled:text-slate-300">Hoàn</button>
                        <button onClick={() => openProcessForm(deposit, "TRANSFER_REVENUE")} disabled={deposit.remainingAmount <= 0} className="text-xs font-bold text-amber-600 disabled:text-slate-300">Chuyển DT</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
