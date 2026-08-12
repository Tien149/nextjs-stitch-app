"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import { displayRoleName, storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";
import { resolveInitialBranchScope } from "@/components/BranchScopeSelect";

type MasterItem = {
  id: string;
  type: string;
  code: string;
  name: string;
  branch: string | null;
  status: string;
  group?: string | null;
  codePrefix?: string | null;
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
  disposalStatus?: string | null;
  note: string | null;
  allocatedPeriods?: number;
  allocatedAmount?: number;
  remainingPeriods?: number | null;
  computedCurrentValue?: number;
  computedStatus?: "IN_USE" | "FULLY_ALLOCATED" | "DISPOSED";
  canEditCode?: boolean;
  codeEditLockReason?: string | null;
};

const ASSET_GROUPS: { code: string; label: string; isTool?: boolean }[] = [
  { code: "EQUIPMENT", label: "Máy móc thiết bị" },
  { code: "FURNITURE", label: "Nội thất, decor" },
  { code: "VEHICLE", label: "Phương tiện vận chuyển" },
  { code: "TOOL", label: "Công cụ dụng cụ (CCDC)", isTool: true },
  { code: "OTHER", label: "Tài sản khác" },
];

const emptyForm = {
  code: "",
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
  const [assetGroups, setAssetGroups] = useState<MasterItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [loading, setLoading] = useState(true);
  /** Tài sản đang sửa; null nghĩa là biểu mẫu đang ở chế độ tạo mới. */
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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
      const initialScope = resolveInitialBranchScope(session, "");
      const initialBranch = initialScope === "ALL"
        ? visibleStoreOptions(session)[0]?.code || ""
        : initialScope;
      setForm((current) => ({ ...current, branchCode: initialBranch, location: "", departmentCode: "" }));
      setUser(session);
      setLoading(false);
    }, 0);
  }, [router]);

  const canCreate = user ? canPerformAction(user, "create") : false;
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  /** Biểu mẫu bên trái hiện ra khi được tạo mới hoặc khi đang sửa một tài sản. */
  const showAssetForm = canCreate || Boolean(editingAsset);
  /** Số kỳ đã trích khấu hao của tài sản đang sửa; lớn hơn 0 thì các trường tài chính bị khoá. */
  const editingAllocatedPeriods = editingAsset?.allocatedPeriods || 0;

  const isDisposed = (asset: Asset) =>
    Boolean(asset.disposalStatus) || asset.status === "DISPOSED" || asset.computedStatus === "DISPOSED";

  /** Tài sản đã thanh lý thì hồ sơ phải giữ nguyên để đối chiếu sổ sách. */
  const editLockReason = (asset: Asset) => {
    if (isDisposed(asset)) return "Tài sản đã thanh lý, không thể sửa";
    return null;
  };

  const deleteLockReason = (asset: Asset) => {
    if (isDisposed(asset)) return "Tài sản đã thanh lý, không thể xoá. Hồ sơ thanh lý cần được lưu để đối chiếu sổ sách.";
    if ((asset.allocatedPeriods || 0) > 0) {
      return `Tài sản đã trích khấu hao ${asset.allocatedPeriods} kỳ, không thể xoá. Hãy thanh lý tài sản thay vì xoá.`;
    }
    return null;
  };

  const getSessionHeaders = (): Record<string, string> => {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
  };

  const loadMasterData = async () => {
    try {
      const headers = getSessionHeaders();
      const [whRes, depRes, supRes, groupRes] = await Promise.all([
        fetch("/api/master-data?type=WAREHOUSE", { headers }),
        fetch("/api/master-data?type=DEPARTMENT", { headers }),
        fetch("/api/master-data?type=PARTNER", { headers }),
        fetch("/api/master-data?type=ASSET_GROUP&status=ACTIVE", { headers }),
      ]);
      if (whRes.ok) setWarehouses((await whRes.json()) as MasterItem[]);
      if (depRes.ok) setDepartments((await depRes.json()) as MasterItem[]);
      if (groupRes.ok) setAssetGroups((await groupRes.json()) as MasterItem[]);
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

    const response = await fetch(`/api/assets?${params.toString()}`, {
      headers: getSessionHeaders(),
    });
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
    if (!form.location || !branchWhs.some((w) => w.code === form.location)) {
      window.setTimeout(() => {
        setForm((prev) => ({ ...prev, location: branchWhs[0]?.code || "" }));
      }, 0);
    }
  }, [form.branchCode, form.location, warehouses]);

  // Form warehouse list
  const availableFormWarehouses = useMemo(() => {
    const filtered = warehouses.filter(
      (w) => !w.branch || w.branch === form.branchCode || w.branch === "ALL"
    );
    return filtered;
  }, [warehouses, form.branchCode]);

  const availableFormDepartments = useMemo(() => {
    const filtered = departments.filter(
      (d) => !d.branch || d.branch === form.branchCode || d.branch === "ALL"
    );
    return filtered;
  }, [departments, form.branchCode]);

  // Filter warehouse list
  const availableFilterWarehouses = useMemo(() => {
    if (filterBranch === "ALL") return warehouses;
    const filtered = warehouses.filter((w) => !w.branch || w.branch === filterBranch || w.branch === "ALL");
    return filtered.length > 0 ? filtered : warehouses;
  }, [warehouses, filterBranch]);

  const availableFilterDepartments = useMemo(() => {
    if (filterBranch === "ALL") return departments;
    const filtered = departments.filter((d) => !d.branch || d.branch === filterBranch || d.branch === "ALL");
    return filtered.length > 0 ? filtered : departments;
  }, [departments, filterBranch]);

  const assetGroupOptions = useMemo(() => {
    if (assetGroups.length > 0) {
      return assetGroups.map((group) => ({ code: group.code, label: group.name }));
    }
    return ASSET_GROUPS.map((group) => ({ code: group.code, label: group.label }));
  }, [assetGroups]);

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

  const resetAssetForm = () => {
    setEditingAsset(null);
    setForm((prev) => ({ ...emptyForm, branchCode: prev.branchCode }));
  };

  const startEditAsset = (asset: Asset) => {
    setMessage("");
    setEditingAsset(asset);
    setForm({
      code: asset.code,
      name: asset.name,
      branchCode: asset.branchCode,
      departmentCode: asset.departmentCode || "",
      assetGroup: asset.assetGroup,
      location: asset.location || "",
      quantity: String(asset.quantity),
      purchaseDate: asset.purchaseDate ? asset.purchaseDate.slice(0, 10) : "",
      originalCost: String(asset.originalCost),
      usefulLifeMonths: asset.usefulLifeMonths ? String(asset.usefulLifeMonths) : "",
      depreciationStartDate: asset.depreciationStartDate ? asset.depreciationStartDate.slice(0, 10) : "",
      residualValue: String(asset.residualValue),
      supplierCode: asset.supplierCode || "",
      supplierName: asset.supplierName || "",
      imageUrl: asset.imageUrl || "",
      note: asset.note || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");

    if (editingAsset) {
      // Tài sản đã trích khấu hao thì API khoá 6 trường tài chính, chỉ gửi thông tin quản lý.
      const payloadBody = editingAllocatedPeriods > 0
        ? {
            id: editingAsset.id,
            code: form.code,
            name: form.name,
            branchCode: form.branchCode,
            departmentCode: form.departmentCode,
            assetGroup: form.assetGroup,
            location: form.location,
            supplierCode: form.supplierCode,
            supplierName: form.supplierName,
            imageUrl: form.imageUrl,
            note: form.note,
          }
        : { ...form, id: editingAsset.id };

      const response = await fetch("/api/assets", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...getSessionHeaders(),
        },
        body: JSON.stringify(payloadBody),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessageTone("error");
        setMessage(payload.error || "Không lưu được thay đổi tài sản");
        return;
      }
      setMessageTone("success");
      setMessage(`Đã lưu thay đổi hồ sơ tài sản ${payload.code || editingAsset.code}.`);
      resetAssetForm();
      await loadAssets();
      return;
    }

    const response = await fetch("/api/assets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getSessionHeaders(),
      },
      body: JSON.stringify(form),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessageTone("error");
      setMessage(payload.error || "Không tạo được tài sản");
      return;
    }
    setMessageTone("success");
    setMessage("Đã tạo thành công hồ sơ tài sản / CCDC.");
    setForm({ ...emptyForm, branchCode: form.branchCode });
    await loadAssets();
  };

  const confirmDeleteAsset = async (reason: string) => {
    if (!deletingAsset) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingAsset.id, type: "ASSET" });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/assets?${query.toString()}`, {
        method: "DELETE",
        headers: getSessionHeaders(),
      });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được tài sản");
        return;
      }
      if (editingAsset?.id === deletingAsset.id) resetAssetForm();
      setMessageTone("success");
      setMessage(`Đã chuyển tài sản ${deletingAsset.code} vào Thùng rác.`);
      setDeletingAsset(null);
      await loadAssets();
    } finally {
      setDeleting(false);
    }
  };

  const handleImageUpload = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setMessageTone("error");
      setMessage("Vui lòng chọn file hình ảnh hợp lệ.");
      return;
    }
    if (file.size > 1_500_000) {
      setMessageTone("error");
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
    const matched = assetGroupOptions.find((g) => g.code === groupCode);
    return matched ? matched.label : groupCode;
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
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

      <main className="w-full max-w-[1720px] mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* KPI Stats Grid */}
        <StickyFilterBar className="!mb-0">
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
        </StickyFilterBar>

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

        <div className="grid xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)] gap-5">
          {/* Form Create Asset */}
          {showAssetForm && (
            <form
              onSubmit={submitAsset}
              className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 h-fit"
            >
              <div>
                <p className="text-xs font-bold text-blue-600 uppercase">Tài sản & CCDC Master</p>
                <h2 className="font-bold text-lg text-slate-900 mt-0.5">
                  {editingAsset ? `Sửa hồ sơ ${editingAsset.code}` : "Tạo hồ sơ tài sản / CCDC"}
                </h2>
              </div>

              {editingAsset && editingAllocatedPeriods > 0 && (
                <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
                  Tài sản đã trích khấu hao {editingAllocatedPeriods} kỳ nên số lượng, ngày mua, nguyên giá, số kỳ khấu hao,
                  ngày bắt đầu khấu hao và giá trị thu hồi sẽ được giữ nguyên. Chỉ thông tin quản lý được cập nhật.
                </p>
              )}

              <label className="text-xs font-bold text-slate-600 block">
                Mã tài sản / CCDC
                <input
                  type="text"
                  value={form.code}
                  onChange={(e) => setForm((v) => ({ ...v, code: e.target.value.toUpperCase() }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono uppercase focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                  placeholder={assetGroups.find((group) => group.code === form.assetGroup)?.codePrefix || "Để trống để hệ thống tự sinh"}
                  disabled={Boolean(editingAsset && editingAsset.canEditCode === false)}
                  maxLength={50}
                />
                <span className="mt-1 block text-[11px] font-normal text-slate-500">
                  {editingAsset?.canEditCode === false
                    ? editingAsset.codeEditLockReason || "Mã đã bị khóa do hồ sơ đã phát sinh nghiệp vụ."
                    : form.code
                      ? "Mã nhập thủ công; chỉ dùng chữ, số, dấu - và _."
                      : "Để trống để tự sinh theo tiền tố của nhóm tài sản."}
                </span>
              </label>

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
                    {visibleStoreOptions(user).map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {storeLabel(opt.code)}
                      </option>
                    ))}
                  </select>
                </label>

                <SearchableSelect
                  label="Vị trí / Kho"
                  value={form.location}
                  onChange={(location) => setForm((v) => ({ ...v, location }))}
                  options={availableFormWarehouses.map((wh) => ({ value: wh.code, label: wh.name, subLabel: wh.code }))}
                  placeholder="Chọn vị trí / kho..."
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <SearchableSelect
                  label="Phòng ban / Bộ phận"
                  value={form.departmentCode}
                  onChange={(departmentCode) => setForm((v) => ({ ...v, departmentCode }))}
                  options={availableFormDepartments.map((dep) => ({ value: dep.code, label: dep.name, subLabel: dep.code }))}
                  placeholder="Chọn phòng ban..."
                />

                <label className="text-xs font-bold text-slate-600 block">
                  Nhóm tài sản *
                  <select
                    value={form.assetGroup}
                    onChange={(e) => setForm((v) => ({ ...v, assetGroup: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                    required
                  >
                    {assetGroupOptions.map((g) => (
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
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                    disabled={editingAllocatedPeriods > 0}
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
                    disabled={editingAllocatedPeriods > 0}
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
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                    disabled={editingAllocatedPeriods > 0}
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
                    className="mt-1 w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                    disabled={editingAllocatedPeriods > 0}
                    placeholder="VD: 24"
                  />
                </label>

                <label className="text-xs font-bold text-slate-600 block col-span-2">
                  Ngày bắt đầu KH
                  <DateInput
                    value={form.depreciationStartDate}
                    onChange={(depreciationStartDate) => setForm((v) => ({ ...v, depreciationStartDate }))}
                    className="mt-1"
                    disabled={editingAllocatedPeriods > 0}
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
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                    disabled={editingAllocatedPeriods > 0}
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
                    options={suppliers.map((sup) => ({ value: sup.code, label: sup.name, subLabel: sup.code }))}
                    placeholder="Chọn nhà cung cấp..."
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
                <p className={`text-sm rounded-lg border px-3 py-2 ${messageTone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                  {message}
                </p>
              )}

              <div className="flex gap-2">
                {editingAsset && (
                  <button
                    type="button"
                    onClick={resetAssetForm}
                    className="px-4 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-lg py-2.5 text-sm font-bold transition-colors"
                  >
                    Huỷ
                  </button>
                )}
                <button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 text-sm font-bold transition-colors shadow-sm">
                  {editingAsset ? "Lưu thay đổi" : "Tạo tài sản / CCDC"}
                </button>
              </div>
            </form>
          )}

          {/* Asset List & Filter Table */}
          <section className="min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col max-h-[760px]">
            {/* Filter Toolbar */}
            <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-bold text-slate-900 text-base">Danh sách Tài sản &amp; CCDC</h2>
                {message && !showAssetForm && (
                  <p className={`text-xs rounded-lg border px-3 py-1.5 ${messageTone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{message}</p>
                )}
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
                    {visibleStoreOptions(user).map((opt) => (
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
                    {assetGroupOptions.map((g) => (
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
            <div className="overflow-x-auto overflow-y-auto flex-1 custom-scrollbar max-h-[560px]">
              <table className="w-full text-left text-xs min-w-[1040px]">
                <thead className="bg-slate-100 text-slate-600 uppercase font-bold border-b border-slate-200 sticky top-0 z-10 shadow-sm">
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
                    <th className="px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {assets.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4 py-12 text-center text-slate-400">
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
                                  <CopyableText value={asset.code}><span className="font-bold text-slate-900">{asset.code}</span></CopyableText>
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

                          <td className="px-4 py-3 text-right">
                            <RowActions
                              session={user}
                              module="/assets"
                              compact
                              onEdit={() => startEditAsset(asset)}
                              onDelete={() => {
                                setDeleteError(null);
                                setDeletingAsset(asset);
                              }}
                              editDisabledReason={editLockReason(asset)}
                              deleteDisabledReason={deleteLockReason(asset)}
                            />
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

      <ConfirmDeleteDialog
        open={Boolean(deletingAsset)}
        title={`Xoá tài sản ${deletingAsset?.code || ""}?`}
        description={deletingAsset ? `${deletingAsset.name} · Nguyên giá ${money(deletingAsset.originalCost)} đ` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => {
          setDeletingAsset(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDeleteAsset}
      />
    </div>
  );
}
