"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { displayRoleName, storeLabel, storeOptions } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type MasterItem = {
  id: string;
  type: string;
  code: string;
  name: string;
  branch: string | null;
  status: string;
  group?: string | null;
};

type Asset = {
  id: string;
  code: string;
  name: string;
  branchCode: string;
  departmentCode: string | null;
  assetGroup: string;
  imageUrl: string | null;
  location: string | null;
  quantity: number;
  purchaseDate: string;
  originalCost: number;
  currentValue: number;
  usefulLifeMonths: number | null;
  depreciationStartDate: string | null;
  residualValue: number;
  supplierCode: string | null;
  supplierName: string | null;
  sourcePurchaseOrderId: string | null;
  sourceReceiptId: string | null;
  status: string;
  note: string | null;
  allocatedPeriods?: number;
  allocatedAmount?: number;
  remainingPeriods?: number | null;
  computedCurrentValue?: number;
  computedStatus?: "IN_USE" | "FULLY_ALLOCATED" | "DISPOSED";
};

const ASSET_GROUPS: { code: string; label: string; isTool?: boolean }[] = [
  { code: "EQUIPMENT", label: "Máy móc thiết bị" },
  { code: "FURNITURE", label: "Nội thất, decor" },
  { code: "VEHICLE", label: "Phương tiện vận chuyển" },
  { code: "TOOL", label: "Công cụ dụng cụ (CCDC)", isTool: true },
  { code: "OTHER", label: "Tài sản khác" },
];

const emptyForm = {
  name: "",
  branchCode: "HCM",
  departmentCode: "",
  assetGroup: "EQUIPMENT",
  location: "",
  quantity: "1",
  purchaseDate: new Date().toISOString().slice(0, 10),
  originalCost: "",
  usefulLifeMonths: "24",
  depreciationStartDate: new Date().toISOString().slice(0, 10),
  residualValue: "0",
  supplierCode: "",
  supplierName: "",
  imageUrl: "",
  note: "",
};

export default function AssetsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [warehouses, setWarehouses] = useState<MasterItem[]>([]);
  const [departments, setDepartments] = useState<MasterItem[]>([]);
  const [suppliers, setSuppliers] = useState<MasterItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterBranch, setFilterBranch] = useState("ALL");
  const [filterWarehouse, setFilterWarehouse] = useState("ALL");
  const [filterDepartment, setFilterDepartment] = useState("ALL");
  const [filterGroup, setFilterGroup] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/assets");
    if (!raw) {
      router.push("/login?next=/assets");
      return;
    }
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setLoading(false);
    }, 0);
  }, [router]);

  const canCreate = user ? canPerformAction(user.role, "create") : false;
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  const loadMasterData = async () => {
    try {
      const [whRes, depRes, supRes] = await Promise.all([
        fetch("/api/master-data?type=WAREHOUSE"),
        fetch("/api/master-data?type=DEPARTMENT"),
        fetch("/api/master-data?type=PARTNER"),
      ]);
      if (whRes.ok) setWarehouses((await whRes.json()) as MasterItem[]);
      if (depRes.ok) setDepartments((await depRes.json()) as MasterItem[]);
      if (supRes.ok) {
        const partners = (await supRes.json()) as MasterItem[];
        setSuppliers(partners.filter((p) => p.group === "SUPPLIER" || p.type === "PARTNER"));
      }
    } catch (e) {
      console.error("Lỗi tải danh mục master data:", e);
    }
  };

  const loadAssets = async () => {
    const params = new URLSearchParams();
    if (filterBranch !== "ALL") params.set("branchCode", filterBranch);
    if (filterWarehouse !== "ALL") params.set("warehouseCode", filterWarehouse);
    if (filterDepartment !== "ALL") params.set("departmentCode", filterDepartment);
    if (filterGroup !== "ALL") params.set("assetGroup", filterGroup);
    if (filterStatus !== "ALL") params.set("status", filterStatus);
    if (searchQuery.trim()) params.set("q", searchQuery.trim());

    const response = await fetch(`/api/assets?${params.toString()}`);
    if (response.ok) {
      setAssets((await response.json()) as Asset[]);
    }
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadMasterData();
        void loadAssets();
      }, 0);
    }
  }, [loading, filterBranch, filterWarehouse, filterDepartment, filterGroup, filterStatus, searchQuery]);

  // Update default warehouse in form when branchCode changes
  useEffect(() => {
    const branchWhs = warehouses.filter(
      (w) => !w.branch || w.branch === form.branchCode || w.branch === "ALL"
    );
    if (branchWhs.length > 0 && (!form.location || !branchWhs.some((w) => w.code === form.location))) {
      setForm((prev) => ({ ...prev, location: branchWhs[0].code }));
    }
  }, [form.branchCode, warehouses]);

  // Form warehouse list
  const availableFormWarehouses = useMemo(() => {
    return warehouses.filter(
      (w) => !w.branch || w.branch === form.branchCode || w.branch === "ALL"
    );
  }, [warehouses, form.branchCode]);

  const availableFormDepartments = useMemo(() => {
    return departments.filter(
      (d) => !d.branch || d.branch === form.branchCode || d.branch === "ALL"
    );
  }, [departments, form.branchCode]);

  // Filter warehouse list
  const availableFilterWarehouses = useMemo(() => {
    if (filterBranch === "ALL") return warehouses;
    return warehouses.filter((w) => !w.branch || w.branch === filterBranch || w.branch === "ALL");
  }, [warehouses, filterBranch]);

  const availableFilterDepartments = useMemo(() => {
    if (filterBranch === "ALL") return departments;
    return departments.filter((d) => !d.branch || d.branch === filterBranch || d.branch === "ALL");
  }, [departments, filterBranch]);

  // KPI Calculations
  const kpis = useMemo(() => {
    const totalOriginalCost = assets.reduce((sum, a) => sum + a.originalCost, 0);
    const totalAllocatedAmount = assets.reduce((sum, a) => sum + (a.allocatedAmount || 0), 0);
    const totalRemainingValue = assets.reduce(
      (sum, a) => sum + (a.computedCurrentValue !== undefined ? a.computedCurrentValue : a.currentValue),
      0
    );
    const inUseCount = assets.filter((a) => (a.computedStatus || a.status) === "IN_USE").length;
    const fullyAllocatedCount = assets.filter((a) => (a.computedStatus || a.status) === "FULLY_ALLOCATED").length;
    const disposedCount = assets.filter((a) => (a.computedStatus || a.status) === "DISPOSED").length;

    return {
      totalOriginalCost,
      totalAllocatedAmount,
      totalRemainingValue,
      totalCount: assets.length,
      inUseCount,
      fullyAllocatedCount,
      disposedCount,
    };
  }, [assets]);

  const createAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không tạo được tài sản");
      return;
    }
    setMessage("Đã tạo thành công hồ sơ tài sản / CCDC.");
    setForm({ ...emptyForm, branchCode: form.branchCode });
    await loadAssets();
  };

  const handleImageUpload = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessage("Vui lòng chọn file hình ảnh hợp lệ.");
      return;
    }
    if (file.size > 1_500_000) {
      setMessage("Hình ảnh nên nhỏ hơn 1.5MB để tải nhanh trên VPS.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setForm((v) => ({ ...v, imageUrl: String(reader.result || "") }));
    };
    reader.readAsDataURL(file);
  };

  const departmentSummary = useMemo(() => {
    const map = new Map<string, { code: string; name: string; count: number; quantity: number; originalCost: number; remainingValue: number }>();
    for (const asset of assets) {
      const code = asset.departmentCode || "UNASSIGNED";
      const department = departments.find((d) => d.code === code);
      const currentVal = asset.computedCurrentValue !== undefined ? asset.computedCurrentValue : asset.currentValue;
      const current = map.get(code) || {
        code,
        name: department ? department.name : code === "UNASSIGNED" ? "Chưa gán phòng ban" : code,
        count: 0,
        quantity: 0,
        originalCost: 0,
        remainingValue: 0,
      };
      current.count += 1;
      current.quantity += asset.quantity;
      current.originalCost += asset.originalCost;
      current.remainingValue += currentVal;
      map.set(code, current);
    }
    return Array.from(map.values()).sort((a, b) => b.originalCost - a.originalCost);
  }, [assets, departments]);

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case "FULLY_ALLOCATED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-amber-100 text-amber-800">Đã phân bổ hết</span>;
      case "DISPOSED":
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-slate-200 text-slate-700">Đã thanh lý</span>;
      case "IN_USE":
      default:
        return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold bg-emerald-100 text-emerald-800">Đang dùng</span>;
    }
  };

  const getGroupLabel = (groupCode: string) => {
    const matched = ASSET_GROUPS.find((g) => g.code === groupCode);
    return matched ? matched.label : groupCode;
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Quản lý Tài sản & CCDC</h1>
            <p className="text-xs text-slate-500">
              Tổng hợp Tài sản cố định và CCDC, quản lý theo Cửa hàng, Kho/Vị trí & tiến độ phân bổ.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/assets/operations")}
            className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-bold inline-flex items-center gap-2 transition-colors shadow-sm"
          >
            <span className="material-symbols-outlined text-lg">settings_suggest</span>
            Vận hành & Khấu hao
          </button>
          <p className="hidden sm:block text-xs font-bold text-slate-500">{displayRoleName(user?.role)}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        {/* KPI Stats Grid */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Tổng nguyên giá</p>
            <p className="text-xl font-extrabold text-slate-900">{money(kpis.totalOriginalCost)} đ</p>
            <p className="text-[11px] text-slate-400">Tổng cộng {kpis.totalCount} tài sản/CCDC</p>
          </div>
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Đã phân bổ / khấu hao</p>
            <p className="text-xl font-extrabold text-blue-600">{money(kpis.totalAllocatedAmount)} đ</p>
            <p className="text-[11px] text-slate-400">Tích lũy từ phiếu khấu hao</p>
          </div>
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Giá trị còn lại</p>
            <p className="text-xl font-extrabold text-emerald-600">{money(kpis.totalRemainingValue)} đ</p>
            <p className="text-[11px] text-slate-400">Giá trị thực tế còn lại</p>
          </div>
          <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Trạng thái tài sản</p>
            <div className="flex items-center gap-2 pt-0.5 text-xs font-semibold">
              <span className="text-emerald-700">{kpis.inUseCount} đang dùng</span>
              <span className="text-slate-300">•</span>
              <span className="text-amber-700">{kpis.fullyAllocatedCount} hết PB</span>
              {kpis.disposedCount > 0 && (
                <>
                  <span className="text-slate-300">•</span>
                  <span className="text-slate-500">{kpis.disposedCount} thanh lý</span>
                </>
              )}
            </div>
          </div>
        </section>

        {departmentSummary.length > 0 && (
          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/80 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-slate-900 text-sm">Tổng hợp theo phòng ban</h2>
                <p className="text-xs text-slate-500">Số lượng, nguyên giá và giá trị còn lại của tài sản/CCDC theo bộ phận.</p>
              </div>
              <span className="material-symbols-outlined text-slate-400">corporate_fare</span>
            </div>
            <div className="grid md:grid-cols-3 xl:grid-cols-4 gap-px bg-slate-100">
              {departmentSummary.slice(0, 8).map((row) => (
                <button
                  key={row.code}
                  type="button"
                  onClick={() => setFilterDepartment(row.code)}
                  className="bg-white p-4 text-left hover:bg-blue-50 transition-colors"
                >
                  <p className="text-sm font-bold text-slate-900 truncate">{row.name}</p>
                  <p className="text-xs text-slate-500 mt-1">{row.count} dòng · SL {row.quantity}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-slate-400">Nguyên giá</p>
                      <p className="font-bold text-slate-800">{money(row.originalCost)} đ</p>
                    </div>
                    <div>
                      <p className="text-slate-400">Còn lại</p>
                      <p className="font-bold text-emerald-700">{money(row.remainingValue)} đ</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="grid xl:grid-cols-[380px_1fr] gap-6">
          {/* Form Create Asset */}
          {canCreate && (
            <form
              onSubmit={createAsset}
              className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 h-fit"
            >
              <div>
                <p className="text-xs font-bold text-blue-600 uppercase">Tài sản & CCDC Master</p>
                <h2 className="font-bold text-lg text-slate-900 mt-0.5">Tạo hồ sơ tài sản / CCDC</h2>
              </div>

              <label className="text-xs font-bold text-slate-600 block">
                Tên tài sản / CCDC *
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  placeholder="Nhập tên máy móc, thiết bị, CCDC..."
                  required
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Cửa hàng *
                  <select
                    value={form.branchCode}
                    onChange={(e) => setForm((v) => ({ ...v, branchCode: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                    required
                  >
                    {storeOptions.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {storeLabel(opt.code)}
                      </option>
                    ))}
                  </select>
                </label>

                <SearchableSelect
                  label="Vị trí / Kho *"
                  value={form.location}
                  onChange={(location) => setForm((v) => ({ ...v, location }))}
                  options={availableFormWarehouses.map((wh) => ({ value: wh.code, label: `${wh.name} (${wh.code})` }))}
                  placeholder="Gõ tên/mã kho để lọc"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <SearchableSelect
                  label="Phòng ban / Bộ phận"
                  value={form.departmentCode}
                  onChange={(departmentCode) => setForm((v) => ({ ...v, departmentCode }))}
                  options={availableFormDepartments.map((dep) => ({ value: dep.code, label: `${dep.name} (${dep.code})` }))}
                  placeholder="Gõ tên/mã phòng ban"
                />

                <label className="text-xs font-bold text-slate-600 block">
                  Nhóm tài sản *
                  <select
                    value={form.assetGroup}
                    onChange={(e) => setForm((v) => ({ ...v, assetGroup: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                    required
                  >
                    {ASSET_GROUPS.map((g) => (
                      <option key={g.code} value={g.code}>
                        {g.label}
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
                    min="0.01"
                    step="0.01"
                    value={form.quantity}
                    onChange={(e) => setForm((v) => ({ ...v, quantity: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Ngày mua / nhập *
                  <DateInput
                    value={form.purchaseDate}
                    onChange={(purchaseDate) => setForm((v) => ({ ...v, purchaseDate }))}
                    className="mt-1"
                    required
                    ariaLabel="Ngày mua tài sản"
                  />
                </label>

                <label className="text-xs font-bold text-slate-600 block">
                  Nguyên giá (đ) *
                  <input
                    type="number"
                    min="1"
                    value={form.originalCost}
                    onChange={(e) => setForm((v) => ({ ...v, originalCost: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    placeholder="0"
                    required
                  />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs font-bold text-slate-600 block">
                  Số kỳ (tháng)
                  <input
                    type="number"
                    min="1"
                    value={form.usefulLifeMonths}
                    onChange={(e) => setForm((v) => ({ ...v, usefulLifeMonths: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    placeholder="VD: 24"
                  />
                </label>

                <label className="text-xs font-bold text-slate-600 block col-span-2">
                  Ngày bắt đầu KH
                  <DateInput
                    value={form.depreciationStartDate}
                    onChange={(depreciationStartDate) => setForm((v) => ({ ...v, depreciationStartDate }))}
                    className="mt-1"
                    ariaLabel="Ngày bắt đầu khấu hao"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Giá trị còn lại tối thiểu
                  <input
                    type="number"
                    min="0"
                    value={form.residualValue}
                    onChange={(e) => setForm((v) => ({ ...v, residualValue: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    placeholder="0"
                  />
                </label>

                {suppliers.length > 0 ? (
                  <SearchableSelect
                    label="Nhà cung cấp"
                    value={form.supplierCode}
                    onChange={(supplierCode) => {
                      const matched = suppliers.find((s) => s.code === supplierCode);
                      setForm((v) => ({ ...v, supplierCode, supplierName: matched ? matched.name : "" }));
                    }}
                    options={suppliers.map((sup) => ({ value: sup.code, label: `${sup.name} (${sup.code})` }))}
                    placeholder="Gõ tên/mã NCC"
                  />
                ) : (
                  <label className="text-xs font-bold text-slate-600 block">
                    Nhà cung cấp
                    <input
                      type="text"
                      value={form.supplierName}
                      onChange={(e) => setForm((v) => ({ ...v, supplierName: e.target.value, supplierCode: "" }))}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      placeholder="Tên NCC"
                    />
                  </label>
                )}
              </div>

              <div className="grid grid-cols-[88px_1fr] gap-3 items-end">
                <div className="h-20 w-20 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 grid place-items-center">
                  {form.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={form.imageUrl} alt="Ảnh tài sản" className="h-full w-full object-cover" />
                  ) : (
                    <span className="material-symbols-outlined text-slate-400">image</span>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-600 block">
                    Hình ảnh / logo tài sản
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageUpload(e.target.files?.[0] || null)}
                      className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1 file:text-xs file:font-bold file:text-blue-700"
                    />
                  </label>
                  <input
                    type="text"
                    value={form.imageUrl}
                    onChange={(e) => setForm((v) => ({ ...v, imageUrl: e.target.value }))}
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    placeholder="Hoặc dán URL hình ảnh"
                  />
                </div>
              </div>

              <label className="text-xs font-bold text-slate-600 block">
                Ghi chú
                <textarea
                  value={form.note}
                  onChange={(e) => setForm((v) => ({ ...v, note: e.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-16 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  placeholder="Mô tả thêm..."
                />
              </label>

              {message && (
                <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">
                  {message}
                </p>
              )}

              <button className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 text-sm font-bold transition-colors shadow-sm">
                Tạo tài sản / CCDC
              </button>
            </form>
          )}

          {/* Asset List & Filter Table */}
          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col">
            {/* Filter Toolbar */}
            <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-bold text-slate-900 text-base">Danh sách Tài sản & CCDC</h2>
                <button
                  onClick={loadAssets}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors inline-flex items-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-base">refresh</span>
                  Tải lại
                </button>
              </div>

              {/* Filter inputs grid */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-2.5">
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Cửa hàng</label>
                  <select
                    value={filterBranch}
                    onChange={(e) => {
                      setFilterBranch(e.target.value);
                      setFilterWarehouse("ALL");
                      setFilterDepartment("ALL");
                    }}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500"
                  >
                    <option value="ALL">Tất cả cửa hàng</option>
                    {storeOptions.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {storeLabel(opt.code)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Vị trí / Kho</label>
                  <select
                    value={filterWarehouse}
                    onChange={(e) => setFilterWarehouse(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500"
                  >
                    <option value="ALL">Tất cả kho</option>
                    {availableFilterWarehouses.map((wh) => (
                      <option key={wh.id} value={wh.code}>
                        {wh.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Phòng ban</label>
                  <select
                    value={filterDepartment}
                    onChange={(e) => setFilterDepartment(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500"
                  >
                    <option value="ALL">Tất cả phòng ban</option>
                    {availableFilterDepartments.map((dep) => (
                      <option key={dep.id} value={dep.code}>
                        {dep.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Nhóm tài sản</label>
                  <select
                    value={filterGroup}
                    onChange={(e) => setFilterGroup(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500"
                  >
                    <option value="ALL">Tất cả nhóm</option>
                    {ASSET_GROUPS.map((g) => (
                      <option key={g.code} value={g.code}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Trạng thái</label>
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:border-blue-500"
                  >
                    <option value="ALL">Tất cả trạng thái</option>
                    <option value="IN_USE">Đang dùng</option>
                    <option value="FULLY_ALLOCATED">Đã phân bổ hết</option>
                    <option value="DISPOSED">Đã thanh lý</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Tìm kiếm</label>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Mã, tên, ghi chú..."
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs focus:border-blue-500"
                  />
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto flex-1">
              <table className="w-full text-left text-xs min-w-[760px]">
                <thead className="bg-slate-100 text-slate-600 uppercase font-bold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3">Tài sản / CCDC</th>
                    <th className="px-3 py-3">Cửa hàng / Kho</th>
                    <th className="px-3 py-3">Nhóm / SL</th>
                    <th className="px-3 py-3">Ngày mua</th>
                    <th className="px-3 py-3 text-right">Nguyên giá</th>
                    <th className="px-3 py-3 text-center">Tiến độ PB</th>
                    <th className="px-3 py-3 text-right">Đã phân bổ</th>
                    <th className="px-3 py-3 text-right">Còn lại</th>
                    <th className="px-4 py-3 text-center">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {assets.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-12 text-center text-slate-400">
                        Chưa có tài sản hoặc CCDC nào phù hợp với bộ lọc.
                      </td>
                    </tr>
                  ) : (
                    assets.map((asset) => {
                      const warehouseItem = warehouses.find((w) => w.code === asset.location);
                      const warehouseName = warehouseItem ? warehouseItem.name : asset.location || "-";
                      const currentVal = asset.computedCurrentValue !== undefined ? asset.computedCurrentValue : asset.currentValue;
                      const statusToShow = asset.computedStatus || asset.status;
                      const isTool = asset.assetGroup === "TOOL";
                      const departmentItem = departments.find((d) => d.code === asset.departmentCode);
                      const departmentName = departmentItem ? departmentItem.name : asset.departmentCode || "Chưa gán phòng ban";

                      return (
                        <tr key={asset.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                                {asset.imageUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={asset.imageUrl} alt={asset.name} className="h-full w-full object-cover" />
                                ) : (
                                  <span className={`material-symbols-outlined ${isTool ? "text-amber-600" : "text-blue-600"}`}>
                                    {isTool ? "build" : "precision_manufacturing"}
                                  </span>
                                )}
                              </div>
                              <div>
                                <div className="flex items-center gap-1.5">
                                  <span className="font-bold text-slate-900">{asset.code}</span>
                                  <span className="font-medium text-slate-800">- {asset.name}</span>
                                </div>
                                <p className="text-[11px] text-slate-400">
                                  NCC: {asset.supplierName || "-"}
                                  {asset.note && ` · ${asset.note}`}
                                </p>
                              </div>
                            </div>
                          </td>

                          <td className="px-3 py-3">
                            <span className="font-semibold text-slate-800">{storeLabel(asset.branchCode)}</span>
                            <p className="text-[11px] text-slate-500">{warehouseName}</p>
                          </td>

                          <td className="px-3 py-3">
                            <span className="font-medium text-slate-700">{getGroupLabel(asset.assetGroup)}</span>
                            <p className="text-[11px] text-slate-500">SL: {asset.quantity} · {departmentName}</p>
                          </td>

                          <td className="px-3 py-3 text-slate-600">
                            {asset.purchaseDate ? new Date(asset.purchaseDate).toLocaleDateString("vi-VN") : "-"}
                          </td>

                          <td className="px-3 py-3 text-right font-bold text-slate-900">
                            {money(asset.originalCost)} đ
                          </td>

                          <td className="px-3 py-3 text-center">
                            {asset.usefulLifeMonths ? (
                              <div className="space-y-0.5">
                                <span className="font-semibold text-slate-700">
                                  {asset.allocatedPeriods || 0} / {asset.usefulLifeMonths} kỳ
                                </span>
                                <div className="w-16 bg-slate-200 rounded-full h-1.5 mx-auto overflow-hidden">
                                  <div
                                    className="bg-blue-600 h-1.5 rounded-full"
                                    style={{
                                      width: `${Math.min(
                                        100,
                                        Math.round(((asset.allocatedPeriods || 0) / asset.usefulLifeMonths) * 100)
                                      )}%`,
                                    }}
                                  />
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>

                          <td className="px-3 py-3 text-right font-medium text-blue-700">
                            {money(asset.allocatedAmount || 0)} đ
                          </td>

                          <td className="px-3 py-3 text-right font-bold text-emerald-700">
                            {money(currentVal)} đ
                          </td>

                          <td className="px-4 py-3 text-center">
                            {getStatusBadge(statusToShow)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function SearchableSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) => `${option.value} ${option.label}`.toLowerCase().includes(keyword));
  }, [options, search]);

  return (
    <label className="text-xs font-bold text-slate-600 block">
      {label}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mt-1 w-full border border-slate-300 rounded-t-lg px-3 py-1.5 text-xs focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
        placeholder={placeholder || "Gõ để lọc danh mục"}
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border-x border-b border-slate-300 rounded-b-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
        required={required}
      >
        <option value="">{options.length === 0 ? "Chưa có dữ liệu danh mục" : "Chọn"}</option>
        {filtered.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
