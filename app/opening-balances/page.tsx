"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { MonthInput } from "@/components/DateInput";
import { storeLabel } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type OpeningBalance = {
  id: string;
  period: string;
  branchCode: string;
  balanceType: string;
  objectCode: string | null;
  objectName: string | null;
  moneySourceCode: string | null;
  warehouseCode: string | null;
  departmentCode: string | null;
  quantity: number | null;
  unitCost: number | null;
  allocationMonths: number | null;
  allocationStartPeriod: string | null;
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
  warehouseCode: string;
  departmentCode: string;
  quantity: string;
  unitCost: string;
  allocationMonths: string;
  allocationStartPeriod: string;
  amount: string;
  note: string;
  status: string;
};

type MasterDataOption = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
};

const balanceTypes = [
  { value: "CASH", label: "Tiền mặt", icon: "payments" },
  { value: "BANK", label: "Ngân hàng", icon: "account_balance" },
  { value: "WALLET_POS", label: "Ví/POS", icon: "point_of_sale" },
  { value: "AR", label: "Phải thu", icon: "call_received" },
  { value: "AP", label: "Phải trả", icon: "call_made" },
  { value: "DEPOSIT", label: "Tiền cọc", icon: "savings" },
  { value: "INVENTORY", label: "Tồn kho đầu kỳ", icon: "inventory_2" },
  { value: "ASSET", label: "Tài sản/CCDC đầu kỳ", icon: "precision_manufacturing" },
  { value: "PREPAID_EXPENSE", label: "Chi phí phân bổ đầu kỳ", icon: "event_repeat" },
];

const emptyForm: OpeningBalanceForm = {
  period: "2026-07",
  branchCode: "HCM",
  balanceType: "CASH",
  objectCode: "",
  objectName: "",
  moneySourceCode: "",
  warehouseCode: "",
  departmentCode: "",
  quantity: "",
  unitCost: "",
  allocationMonths: "",
  allocationStartPeriod: "2026-07",
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
  const [branchScope, setBranchScope] = useState("ALL");
  const [balanceTypeFilter, setBalanceTypeFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  const [branches, setBranches] = useState<MasterDataOption[]>([]);
  const [partners, setPartners] = useState<MasterDataOption[]>([]);
  const [moneySources, setMoneySources] = useState<MasterDataOption[]>([]);
  const [warehouses, setWarehouses] = useState<MasterDataOption[]>([]);
  const [departments, setDepartments] = useState<MasterDataOption[]>([]);
  const [inventoryItems, setInventoryItems] = useState<{ id: string; code: string; name: string; unit: string }[]>([]);

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
      const initialBranch = resolveInitialBranchScope(session);
      setBranchScope(initialBranch);
      if (initialBranch !== "ALL") {
        setForm((current) => ({ ...current, branchCode: initialBranch }));
      }
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
      params.set("branchCode", branchScope);
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
      const [resMaster, resInv] = await Promise.all([
        fetch("/api/master-data?status=ACTIVE"),
        fetch("/api/inventory"),
      ]);

      if (resMaster.ok) {
        const data = (await resMaster.json()) as MasterDataOption[];
        const activeBranches = data.filter((item) => item.type === "BRANCH");
        const activePartners = data.filter((item) => item.type === "PARTNER");
        const activeMoneySources = data.filter((item) => item.type === "MONEY_SOURCE");
        const activeWarehouses = data.filter((item) => item.type === "WAREHOUSE");
        const activeDepartments = data.filter((item) => item.type === "DEPARTMENT");

        setBranches(activeBranches);
        setPartners(activePartners);
        setMoneySources(activeMoneySources);
        setWarehouses(activeWarehouses);
        setDepartments(activeDepartments);
        
        // Update form with default values if they are empty
        setForm(prev => {
          const firstBranch = branchScope !== "ALL" ? branchScope : activeBranches[0]?.code || "";
          const firstPartner = activePartners[0] || null;
          const firstMoneySource = activeMoneySources.find((item) => !firstBranch || item.branch === firstBranch)?.code || activeMoneySources[0]?.code || "";
          const firstWarehouse = activeWarehouses.find(w => !firstBranch || w.branch === firstBranch)?.code || activeWarehouses[0]?.code || "";
          const firstDept = activeDepartments.find(d => !firstBranch || d.branch === firstBranch)?.code || activeDepartments[0]?.code || "";
          
          return {
            ...prev,
            branchCode: branchScope !== "ALL" ? firstBranch : prev.branchCode || firstBranch,
            objectCode: prev.objectCode || (firstPartner ? firstPartner.code : ""),
            objectName: prev.objectName || (firstPartner ? firstPartner.name : ""),
            moneySourceCode: prev.moneySourceCode || firstMoneySource,
            warehouseCode: prev.warehouseCode || firstWarehouse,
            departmentCode: prev.departmentCode || firstDept,
          };
        });
      }

      if (resInv.ok) {
        const invData = await resInv.json();
        setInventoryItems(invData.items || []);
      }
    } catch (error) {
      console.error("Failed to load master data", error);
    }
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        void loadBalances();
        void loadMasterData();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingAuth, branchScope, balanceTypeFilter, statusFilter]);

  const handlePartnerChange = (code: string) => {
    const p = partners.find(item => item.code === code);
    setForm(value => ({
      ...value,
      objectCode: code,
      objectName: p ? p.name : "",
    }));
  };

  const handleInventoryItemChange = (code: string) => {
    const item = inventoryItems.find(i => i.code === code);
    setForm(value => ({
      ...value,
      objectCode: code,
      objectName: item ? item.name : "",
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
  const isSourceType = ["CASH", "BANK", "WALLET_POS"].includes(form.balanceType);
  const isObjectType = ["AR", "AP", "DEPOSIT"].includes(form.balanceType);
  const isInventoryType = form.balanceType === "INVENTORY";
  const isAssetType = form.balanceType === "ASSET";
  const isPrepaidType = form.balanceType === "PREPAID_EXPENSE";
  const calculatedAmount = useMemo(() => {
    if (!isInventoryType && !isAssetType) return "";
    const quantity = Number(form.quantity) || 0;
    const unitCost = Number(form.unitCost) || 0;
    const amount = quantity * unitCost;
    return amount > 0 ? String(amount) : "";
  }, [form.quantity, form.unitCost, isInventoryType, isAssetType]);
  const effectiveAmount = calculatedAmount || form.amount;

  const createBalance = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManageOpeningBalances) {
      setMessage("Bạn chỉ có quyền xem số dư đầu kỳ.");
      return;
    }

    if (isSourceType && !form.moneySourceCode) {
      setMessage("Đối với số dư quỹ/ngân hàng/ví, bắt buộc phải chọn Nguồn tiền.");
      return;
    }

    if (isObjectType && !form.objectCode) {
      setMessage("Đối với số dư công nợ/tiền cọc, bắt buộc phải chọn Đối tượng.");
      return;
    }

    if (isInventoryType && (!form.objectCode || !form.warehouseCode)) {
      setMessage("Đối với tồn kho đầu kỳ, bắt buộc chọn Mặt hàng và Kho.");
      return;
    }

    if ((isInventoryType || isAssetType) && (Number(form.quantity) <= 0 || Number(form.unitCost) <= 0)) {
      setMessage("Số lượng và đơn giá phải lớn hơn 0.");
      return;
    }

    if (isAssetType && (!form.objectCode || !form.objectName)) {
      setMessage("Đối với tài sản/CCDC, bắt buộc nhập Mã tài sản và Tên tài sản.");
      return;
    }

    if (isPrepaidType && (!form.objectCode || !form.allocationStartPeriod || Number(form.allocationMonths) <= 1)) {
      setMessage("Đối với chi phí phân bổ, bắt buộc nhập mã chi phí, số kỳ > 1 và kỳ bắt đầu.");
      return;
    }

    setIsSaving(true);
    setMessage("");
    try {
      const payload = {
        ...form,
        objectCode: (isObjectType || isInventoryType || isAssetType || isPrepaidType) ? form.objectCode : "",
        objectName: (isObjectType || isAssetType || isPrepaidType) ? form.objectName : "",
        moneySourceCode: isSourceType ? form.moneySourceCode : "",
        warehouseCode: isInventoryType ? form.warehouseCode : "",
        departmentCode: isAssetType ? form.departmentCode : "",
        quantity: (isInventoryType || isAssetType) ? Number(form.quantity) : undefined,
        unitCost: (isInventoryType || isAssetType) ? Number(form.unitCost) : undefined,
        allocationMonths: (isAssetType || isPrepaidType) ? Number(form.allocationMonths) : undefined,
        allocationStartPeriod: (isAssetType || isPrepaidType) ? form.allocationStartPeriod : "",
        amount: Number(effectiveAmount),
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
        branchCode: form.branchCode,
        period: form.period,
        balanceType: form.balanceType,
        objectCode: partners[0]?.code || "",
        objectName: partners[0]?.name || "",
        moneySourceCode: moneySources.find(m => m.branch === form.branchCode)?.code || moneySources[0]?.code || "",
        warehouseCode: warehouses.find(w => w.branch === form.branchCode)?.code || warehouses[0]?.code || "",
        departmentCode: departments.find(d => d.branch === form.branchCode)?.code || departments[0]?.code || "",
      });
      setMessage("Đã thêm số dư đầu kỳ thành công.");
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
    setMessage(status === "CONFIRMED" ? "Đã chốt số dư đầu kỳ thành công và đồng bộ hệ thống." : "Đã mở lại bản nháp và thu hồi đồng bộ.");
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
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition"
            title="Về dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Cấu hình Số dư Đầu kỳ</h1>
            <p className="text-xs text-slate-500">Nhóm F 6.1: nhập số dư quỹ, công nợ, tồn kho và chi phí phân bổ trước go-live.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <BranchScopeSelect session={user} value={branchScope} onChange={setBranchScope} />
          {canManageOpeningBalances && (
            <button
              type="button"
              onClick={() => router.push("/imports?tab=opening-balance")}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700"
              title="Import so du dau ky bang Excel"
            >
              <span className="material-symbols-outlined text-[18px]">upload_file</span>
              Import Excel
            </button>
          )}
          <div className="hidden sm:block text-right">
            <p className="text-xs font-bold text-slate-900">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{user?.role}</p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
            <p className="text-xs font-bold text-slate-500 uppercase">Dòng số dư</p>
            <p className="text-2xl font-bold mt-2 text-slate-900">{totals.count}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
            <p className="text-xs font-bold text-slate-500 uppercase">Tổng đang xem</p>
            <p className="text-2xl font-bold mt-2 text-blue-700">{formatCurrency(totals.amount)} đ</p>
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
              <h2 className="font-bold text-lg mt-1 text-slate-800">Chỉ xem số dư đầu kỳ</h2>
              <p className="text-sm text-slate-500 mt-2">
                Vai trò hiện tại được xem và lọc số dư, không được nhập mới, chốt hoặc mở lại số dư.
              </p>
            </div>
          )}

          <form onSubmit={createBalance} className={`bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 ${canManageOpeningBalances ? "" : "hidden"}`}>
            <div>
              <p className="text-xs font-bold text-blue-600 uppercase">6.1 Số dư đầu kỳ</p>
              <h2 className="font-bold text-lg mt-1 text-slate-900">Nhập số dư</h2>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Kỳ *
                <MonthInput
                  value={form.period}
                  onChange={(period) => setForm((value) => ({ ...value, period }))}
                  className="mt-1"
                  required
                  ariaLabel="Kỳ số dư đầu kỳ"
                />
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Cửa hàng *
                <select
                  value={form.branchCode}
                  onChange={(event) => setForm((value) => ({ ...value, branchCode: event.target.value }))}
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
            </div>

            <label className="text-xs font-bold text-slate-600 block">
              Loại số dư *
              <select
                value={form.balanceType}
                onChange={(event) => setForm((value) => ({ ...value, balanceType: event.target.value, objectCode: "", objectName: "" }))}
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 cursor-pointer"
                required
              >
                {balanceTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </select>
            </label>

            {/* Cash, Bank, Wallet */}
            {isSourceType && (
              <label className="text-xs font-bold text-slate-600 block">
                Nguồn tiền (Quỹ/Ngân hàng/Ví) *
                <select
                  value={form.moneySourceCode}
                  onChange={(event) => setForm((value) => ({ ...value, moneySourceCode: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                >
                  <option value="">-- Chọn nguồn tiền --</option>
                  {moneySources
                    .filter(item => !form.branchCode || item.branch === form.branchCode)
                    .map(item => (
                      <option key={item.id} value={item.code}>
                        [{item.code}] {item.name}
                      </option>
                    ))}
                </select>
              </label>
            )}

            {/* AR, AP, DEPOSIT */}
            {isObjectType && (
              <>
                <label className="text-xs font-bold text-slate-600 block">
                  Mã đối tượng (Công nợ/Cọc) *
                  <select
                    value={form.objectCode}
                    onChange={(event) => handlePartnerChange(event.target.value)}
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
                  Tên đối tượng
                  <input
                    value={form.objectName}
                    readOnly
                    className="mt-1.5 w-full border border-slate-200 bg-slate-50 text-slate-500 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed"
                    placeholder="Tên khách hàng/nhà cung cấp tự động điền"
                  />
                </label>
              </>
            )}

            {/* INVENTORY */}
            {isInventoryType && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Mặt hàng *
                    <select
                      value={form.objectCode}
                      onChange={(event) => handleInventoryItemChange(event.target.value)}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      required
                    >
                      <option value="">-- Chọn mặt hàng --</option>
                      {inventoryItems.map(item => (
                        <option key={item.id} value={item.code}>
                          [{item.code}] {item.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="text-xs font-bold text-slate-600 block">
                    Kho hàng *
                    <select
                      value={form.warehouseCode}
                      onChange={(event) => setForm((value) => ({ ...value, warehouseCode: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      required
                    >
                      <option value="">-- Chọn kho hàng --</option>
                      {warehouses
                        .filter(item => !form.branchCode || item.branch === form.branchCode)
                        .map(item => (
                          <option key={item.id} value={item.code}>
                            [{item.code}] {item.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Số lượng tồn *
                    <input
                      type="number"
                      step="0.01"
                      value={form.quantity}
                      onChange={(event) => setForm((value) => ({ ...value, quantity: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Đơn giá bình quân *
                    <input
                      type="number"
                      value={form.unitCost}
                      onChange={(event) => setForm((value) => ({ ...value, unitCost: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      required
                    />
                  </label>
                </div>
              </>
            )}

            {/* ASSET */}
            {isAssetType && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Mã tài sản *
                    <input
                      value={form.objectCode}
                      onChange={(event) => setForm((value) => ({ ...value, objectCode: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      placeholder="VD: CCDC_MAYPHA"
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Tên tài sản *
                    <input
                      value={form.objectName}
                      onChange={(event) => setForm((value) => ({ ...value, objectName: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      placeholder="VD: Máy pha cà phê La Marzocco"
                      required
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Bộ phận sử dụng
                    <select
                      value={form.departmentCode}
                      onChange={(event) => setForm((value) => ({ ...value, departmentCode: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                    >
                      <option value="">-- Chọn bộ phận --</option>
                      {departments
                        .filter(item => !form.branchCode || item.branch === form.branchCode)
                        .map(item => (
                          <option key={item.id} value={item.code}>
                            [{item.code}] {item.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Vị trí (Kho cất)
                    <select
                      value={form.warehouseCode}
                      onChange={(event) => setForm((value) => ({ ...value, warehouseCode: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                    >
                      <option value="">-- Chọn kho hàng --</option>
                      {warehouses
                        .filter(item => !form.branchCode || item.branch === form.branchCode)
                        .map(item => (
                          <option key={item.id} value={item.code}>
                            [{item.code}] {item.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Số lượng *
                    <input
                      type="number"
                      value={form.quantity}
                      onChange={(event) => setForm((value) => ({ ...value, quantity: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Nguyên giá đơn vị *
                    <input
                      type="number"
                      value={form.unitCost}
                      onChange={(event) => setForm((value) => ({ ...value, unitCost: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      required
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Số kỳ phân bổ (Tháng) *
                    <input
                      type="number"
                      value={form.allocationMonths}
                      onChange={(event) => setForm((value) => ({ ...value, allocationMonths: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      placeholder="VD: 24"
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Kỳ bắt đầu khấu hao *
                    <MonthInput
                      value={form.allocationStartPeriod}
                      onChange={(allocationStartPeriod) => setForm((value) => ({ ...value, allocationStartPeriod }))}
                      className="mt-1"
                      required
                      ariaLabel="Kỳ bắt đầu phân bổ"
                    />
                  </label>
                </div>
              </>
            )}

            {/* PREPAID EXPENSE */}
            {isPrepaidType && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Mã chi phí *
                    <input
                      value={form.objectCode}
                      onChange={(event) => setForm((value) => ({ ...value, objectCode: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      placeholder="VD: CP_THUENHA_2026"
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Tên chi phí *
                    <input
                      value={form.objectName}
                      onChange={(event) => setForm((value) => ({ ...value, objectName: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      placeholder="VD: Tiền thuê mặt bằng"
                      required
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Nhóm chi phí/Tài khoản
                    <select
                      value={form.moneySourceCode}
                      onChange={(event) => setForm((value) => ({ ...value, moneySourceCode: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                    >
                      <option value="OPEX">OPEX (Chi phí vận hành)</option>
                      <option value="CAPEX">CAPEX (Chi phí đầu tư)</option>
                    </select>
                  </label>
                  <label className="text-xs font-bold text-slate-600 block">
                    Số kỳ phân bổ (Tháng) *
                    <input
                      type="number"
                      value={form.allocationMonths}
                      onChange={(event) => setForm((value) => ({ ...value, allocationMonths: event.target.value }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500"
                      placeholder="VD: 6"
                      required
                    />
                  </label>
                </div>

                <label className="text-xs font-bold text-slate-600 block">
                  Kỳ bắt đầu phân bổ *
                  <MonthInput
                    value={form.allocationStartPeriod}
                    onChange={(allocationStartPeriod) => setForm((value) => ({ ...value, allocationStartPeriod }))}
                    className="mt-1"
                    required
                    ariaLabel="Kỳ bắt đầu phân bổ chi phí"
                  />
                </label>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-bold text-slate-600 block">
                Số tiền / Nguyên giá *
                <input
                  type="number"
                  value={effectiveAmount}
                  onChange={(event) => setForm((value) => ({ ...value, amount: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  readOnly={isInventoryType || isAssetType}
                  required
                />
              </label>
              <label className="text-xs font-bold text-slate-600 block">
                Trạng thái *
                <select
                  value={form.status}
                  onChange={(event) => setForm((value) => ({ ...value, status: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 cursor-pointer"
                  required
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
                className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                placeholder="Nhập ghi chú thêm..."
              />
            </label>

            {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}

            <button disabled={isSaving} className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold transition-colors shadow-sm">
              {isSaving ? "Đang lưu..." : "Thêm số dư đầu kỳ"}
            </button>
          </form>

          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col lg:flex-row gap-3 lg:items-center justify-between">
              <div>
                <h2 className="font-bold text-slate-900">Danh sách số dư</h2>
                <p className="text-xs text-slate-500 mt-1">Chốt số dư sau khi kế toán kiểm tra đúng kỳ, chi nhánh và nguồn tiền.</p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={balanceTypeFilter}
                  onChange={(event) => setBalanceTypeFilter(event.target.value)}
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 cursor-pointer"
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
                  className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white text-slate-700 cursor-pointer"
                >
                  <option value="ALL">Tất cả trạng thái</option>
                  <option value="DRAFT">Nháp</option>
                  <option value="CONFIRMED">Đã chốt</option>
                </select>
                <button onClick={loadBalances} className="rounded-lg border border-slate-200 bg-white text-slate-700 px-3 py-2 text-sm font-bold hover:bg-slate-50 transition">
                  Tải lại
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">Kỳ/Cửa hàng</th>
                    <th className="px-4 py-3">Loại</th>
                    <th className="px-4 py-3">Đối tượng / Chi tiết</th>
                    <th className="px-4 py-3">Số tiền</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    {canManageOpeningBalances && <th className="px-4 py-3 text-right">Thao tác</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
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
                        <tr key={balance.id} className="hover:bg-slate-50 transition">
                          <td className="px-4 py-3">
                            <p className="font-bold text-slate-900">{balance.period}</p>
                            <p className="text-xs text-slate-500 mt-0.5">{storeLabel(balance.branchCode)}</p>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-blue-600 text-lg">{type?.icon || "database"}</span>
                              <span className="font-medium">{type?.label || balance.balanceType}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-bold text-slate-900">{balance.objectName || balance.objectCode || balance.moneySourceCode || "-"}</p>
                            
                            {/* Inventory Detail */}
                            {balance.balanceType === "INVENTORY" && (
                              <span className="text-[11px] text-slate-500 font-bold block mt-0.5">
                                Kho: {balance.warehouseCode} · SL: {balance.quantity} · ĐG: {balance.unitCost ? formatCurrency(balance.unitCost) : 0} đ
                              </span>
                            )}
                            {/* Asset Detail */}
                            {balance.balanceType === "ASSET" && (
                              <span className="text-[11px] text-slate-500 font-bold block mt-0.5">
                                BP: {balance.departmentCode || "Văn phòng"} · Khấu hao: {balance.allocationMonths} tháng · BĐ: {balance.allocationStartPeriod}
                              </span>
                            )}
                            {/* Prepaid Detail */}
                            {balance.balanceType === "PREPAID_EXPENSE" && (
                              <span className="text-[11px] text-slate-500 font-bold block mt-0.5">
                                Phân bổ: {balance.allocationMonths} tháng · BĐ: {balance.allocationStartPeriod} · Loại: {balance.moneySourceCode || "OPEX"}
                              </span>
                            )}

                            <p className="text-xs text-slate-400 mt-0.5 italic">{balance.note || ""}</p>
                          </td>
                          <td className="px-4 py-3 font-bold text-slate-900">{formatCurrency(balance.amount)} đ</td>
                          <td className="px-4 py-3">
                            <span
                              className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                                balance.status === "CONFIRMED"
                                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                  : "bg-amber-50 text-amber-700 border border-amber-100"
                              }`}
                            >
                              {statusLabels[balance.status] || balance.status}
                            </span>
                          </td>
                          {canManageOpeningBalances && (
                            <td className="px-4 py-3 text-right">
                              {balance.status === "CONFIRMED" ? (
                                canReopenOpeningBalances ? (
                                  <button onClick={() => updateStatus(balance, "DRAFT")} className="text-xs font-bold text-slate-500 hover:text-slate-800 transition">
                                    Mở lại
                                  </button>
                                ) : (
                                  <span className="text-xs font-bold text-slate-400">Đã khóa</span>
                                )
                              ) : (
                                <button onClick={() => updateStatus(balance, "CONFIRMED")} className="text-xs font-bold text-emerald-700 hover:text-emerald-900 transition">
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
