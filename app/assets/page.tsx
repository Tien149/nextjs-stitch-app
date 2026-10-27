"use client";

import { useEffect, useMemo, useState } from "react";
import { formatPeriodCount } from "@/lib/period-count";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import type { DateRange } from "@/lib/date-range";
import ExportExcelButton from "@/components/ExportExcelButton";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import { displayRoleName, storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import CopyableText from "@/components/CopyableText";
import { DocLink } from "@/components/DocLink";
import { focusRowClass, readDocFocus, scrollToDoc } from "@/lib/doc-focus";
import { parseVatRate, VAT_RATE_CODES, vatRateLabel } from "@/lib/inventory-vat";
import { purchaseLineFigures } from "@/lib/purchase-discount";
import { MoneyInput } from "@/components/MoneyInput";
import StickyFilterBar from "@/components/StickyFilterBar";
import { resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { defaultAssetCodePrefix } from "@/lib/asset-code-generator";
import { matchesSearch } from "@/lib/search-text";
import AssetCatalogPanel, { type CatalogItem } from "@/components/assets/AssetCatalogPanel";

type MasterItem = {
  id: string;
  type: string;
  code: string;
  name: string;
  branch: string | null;
  status: string;
  group?: string | null;
  partnerType?: string | null;
  partnerGroup?: string | null;
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
  paymentStatus: string;
  payableAmount: number;
  paymentDueDate: string | null;
  payableDebtCode?: string | null;
  payableDebtStatus?: string | null;
  sourcePurchaseOrderId: string | null;
  openingBalanceId?: string | null;
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
  /** Một mã nhiều đợt (lib/asset-lot.ts): đợt thứ mấy / tổng số đợt của mã. */
  lotNo?: number;
  lotCount?: number;
  /** Phiếu mua nhiều dòng + chi tiết mua (khách 27/10/2026). */
  purchaseDocCode?: string | null;
  unitPrice?: number | null;
  discountRate?: number | null;
  discountAmount?: number;
  vatRate?: number | null;
  vatAmount?: number;
  purchaseCostShare?: number;
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
  paymentStatus: "PAYABLE",
  payableAmount: "",
  paymentDueDate: "",
  imageUrl: "",
  note: "",
  /** Mua tăng vào mã đã có: đợt mới dùng lại mã/tên/nhóm/phòng ban của đợt trước. */
  reuseCode: false,
  /** Hồ sơ tạo từ Danh mục mã: tên + nhóm theo danh mục, không gõ tay. */
  catalogLocked: false,
  /** Chi tiết mua của dòng (khách 27/10/2026): nguyên giá = SL × đơn giá − chiết khấu + thuế + chi phí mua. */
  unitPrice: "",
  discountRate: "",
  discountAmount: "",
  vatRate: "KKKNT",
  /** Tạo mới: chi phí mua hàng của CẢ phiếu (chia theo tiền hàng từng dòng). Sửa: phần đã phân bổ cho hồ sơ này. */
  purchaseCost: "",
};

/** Ô của một DÒNG tài sản trên phiếu mua; phần còn lại của form (cửa hàng, kho, ngày, NCC, thanh toán) là chung của phiếu. */
const LINE_FIELDS = ["reuseCode", "catalogLocked", "code", "name", "departmentCode", "assetGroup", "quantity", "unitPrice", "discountRate", "discountAmount", "vatRate", "usefulLifeMonths", "residualValue", "imageUrl", "note"] as const;
type AssetForm = typeof emptyForm;
type PurchaseLineDraft = Pick<AssetForm, (typeof LINE_FIELDS)[number]> & { key: string };
const pickLine = (form: AssetForm, key: string): PurchaseLineDraft => ({ key, ...Object.fromEntries(LINE_FIELDS.map((field) => [field, form[field]])) } as PurchaseLineDraft);
/** Các cột tiền của dòng — cùng công thức phiếu nhập mua (lib/purchase-discount). */
const lineFiguresOf = (lines: Array<Pick<AssetForm, "quantity" | "unitPrice" | "discountRate" | "discountAmount" | "vatRate">>, purchaseCost: number) => purchaseLineFigures(lines.map((line) => {
  const vat = parseVatRate(line.vatRate);
  return { quantity: Number(line.quantity) || 1, unitPrice: Number(line.unitPrice) || 0, discountRate: line.discountRate, discountAmount: line.discountAmount, vatRate: vat.ok ? vat.rate : null };
}), purchaseCost);

type AssetDeleteStep = { text: string; href?: string; linkLabel?: string };

export default function AssetsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  /** Danh sách theo bộ lọc nhưng CHƯA áp ô tìm kiếm: nguồn gợi ý tìm và danh sách mã mua tăng. */
  const [unsearchedAssets, setUnsearchedAssets] = useState<Asset[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [warehouses, setWarehouses] = useState<MasterItem[]>([]);
  const [departments, setDepartments] = useState<MasterItem[]>([]);
  const [suppliers, setSuppliers] = useState<MasterItem[]>([]);
  const [assetGroups, setAssetGroups] = useState<MasterItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  /** Form tạo mở bằng nút "+ Thêm tài sản / CCDC" (khách 27/10/2026: form cố định bên trái quá hẹp). */
  const [formOpen, setFormOpen] = useState(false);
  /** Các dòng đã "Thêm vào phiếu" của phiếu mua đang lập. */
  const [purchaseLines, setPurchaseLines] = useState<PurchaseLineDraft[]>([]);
  /** Tài sản tick chọn để in gộp một phiếu. */
  const [printIds, setPrintIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [loading, setLoading] = useState(true);
  /** Tài sản đang sửa; null nghĩa là biểu mẫu đang ở chế độ tạo mới. */
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Việc cần làm trước khi xoá được tài sản đang mở hộp thoại; null = đang kiểm tra. */
  const [deleteSteps, setDeleteSteps] = useState<AssetDeleteStep[] | null>(null);

  // Filters
  const [filterBranch, setFilterBranch] = useState("ALL");
  const [filterWarehouse, setFilterWarehouse] = useState("ALL");
  const [filterDepartment, setFilterDepartment] = useState("ALL");
  const [filterGroup, setFilterGroup] = useState("ALL");
  const [filterStatus, setFilterStatus] = useState("ALL");
  /** Lọc theo ngày mua (khách yêu cầu 03/10/2026). */
  const [purchaseRange, setPurchaseRange] = useState<DateRange>({ from: "", to: "" });
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
  const canEditCatalog = user ? canPerformAction(user, "edit") : false;
  const canDeleteCatalog = user ? canPerformAction(user, "delete") : false;
  /** "records" = hồ sơ từng đợt mua; "catalog" = Danh mục mã (master list, 12/10/2026). */
  const [view, setView] = useState<"records" | "catalog">("records");
  /** Tài sản được trỏ tới từ link chứng từ (/open/<mã> → ?code=&branch=): lọc mã, tô sáng dòng. */
  const [focusCode, setFocusCode] = useState("");
  useEffect(() => {
    const focus = readDocFocus();
    if (!focus) return;
    window.setTimeout(() => {
      setView("records");
      setFocusCode(focus.code);
      setSearchQuery(focus.code);
      if (focus.branch) setFilterBranch(focus.branch);
      scrollToDoc(focus.code);
    }, 0);
  }, []);
  // Khấu hao/phân bổ chia theo số kỳ nên hay ra số lẻ; bảng tài sản chỉ đọc tới đồng.
  const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);
  /** Biểu mẫu bên trái hiện ra khi được tạo mới hoặc khi đang sửa một tài sản. */
  const showAssetForm = (canCreate && formOpen) || Boolean(editingAsset);
  /** Số kỳ đã trích khấu hao của tài sản đang sửa; lớn hơn 0 thì các trường tài chính bị khoá. */
  const editingAllocatedPeriods = editingAsset?.allocatedPeriods || 0;
  /** Lý do không đổi được hình thức thanh toán khi sửa (null = đổi được). Tạo mới luôn chọn được. */
  const paymentLockReason = !editingAsset
    ? null
    : editingAsset.sourcePurchaseOrderId || editingAsset.sourceReceiptId
      ? "Tài sản nhận từ đơn mua hàng — công nợ nằm ở phiếu nhập mua."
      : editingAsset.openingBalanceId
        ? "Tài sản tạo từ số dư đầu kỳ — công nợ khai ở Số dư đầu kỳ / Công nợ đối tác."
        : editingAsset.status === "DISPOSED" || editingAsset.computedStatus === "DISPOSED"
          ? "Tài sản đã thanh lý."
          : null;

  const isDisposed = (asset: Asset) =>
    Boolean(asset.disposalStatus) || asset.status === "DISPOSED" || asset.computedStatus === "DISPOSED";

  /** Tài sản đã thanh lý thì hồ sơ phải giữ nguyên để đối chiếu sổ sách. */
  const editLockReason = (asset: Asset) => {
    if (isDisposed(asset)) return "Tài sản đã thanh lý, không thể sửa";
    return null;
  };

  // Nút Xoá luôn mở được hộp thoại: tài sản chưa xoá được (thanh lý, khấu hao, phiếu chi đã trả
  // nợ, kỳ khoá sổ) thì hộp thoại liệt kê từng việc cần gỡ trước, kèm link tới đúng màn hình.
  const openDeleteAsset = async (asset: Asset) => {
    setDeleteError(null);
    setDeleteSteps(null);
    setDeletingAsset(asset);
    try {
      const response = await fetch(`/api/assets?deleteCheck=${encodeURIComponent(asset.id)}`, { headers: getSessionHeaders() });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không kiểm tra được điều kiện xoá tài sản");
        setDeleteSteps([]);
        return;
      }
      setDeleteSteps(Array.isArray(payload.steps) ? payload.steps : []);
    } catch {
      setDeleteSteps([]);
    }
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
        fetch("/api/master-data?type=PARTNER&status=ACTIVE&usage=SUPPLIER", { headers }),
        fetch("/api/master-data?type=ASSET_GROUP&status=ACTIVE", { headers }),
      ]);
      if (whRes.ok) setWarehouses((await whRes.json()) as MasterItem[]);
      if (depRes.ok) setDepartments((await depRes.json()) as MasterItem[]);
      if (groupRes.ok) setAssetGroups((await groupRes.json()) as MasterItem[]);
      if (supRes.ok) {
        setSuppliers((await supRes.json()) as MasterItem[]);
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
    if (purchaseRange.from) params.set("purchaseFrom", purchaseRange.from);
    if (purchaseRange.to) params.set("purchaseTo", purchaseRange.to);
    if (searchQuery.trim()) params.set("q", searchQuery.trim());

    const response = await fetch(`/api/assets?${params.toString()}`, {
      headers: getSessionHeaders(),
    });
    if (response.ok) {
      const rows = (await response.json()) as Asset[];
      setAssets(rows);
      if (!searchQuery.trim()) setUnsearchedAssets(rows);
    }
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadMasterData();
        void loadAssets();
      }, 0);
    }
  }, [loading, filterBranch, filterWarehouse, filterDepartment, filterGroup, filterStatus, searchQuery, purchaseRange.from, purchaseRange.to]);

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

  /** Mã có thể mua tăng: mỗi mã một dòng (lấy đợt mới nhất làm mẫu), bỏ mã đã thanh lý hết. */
  const reusableAssets = useMemo(() => {
    const byCode = new Map<string, Asset>();
    for (const asset of unsearchedAssets) {
      if ((asset.computedStatus || asset.status) === "DISPOSED") continue;
      const current = byCode.get(asset.code);
      if (!current || (asset.lotNo || 1) > (current.lotNo || 1)) byCode.set(asset.code, asset);
    }
    return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [unsearchedAssets]);

  /** Gợi ý dưới ô tìm kiếm: mỗi mã một dòng, khớp không cần dấu / hoa thường / đúng thứ tự từ. */
  const searchSuggestions = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const seen = new Set<string>();
    const rows: Asset[] = [];
    for (const asset of unsearchedAssets) {
      if (seen.has(asset.code) || !matchesSearch(searchQuery, [asset.code, asset.name])) continue;
      seen.add(asset.code);
      rows.push(asset);
      if (rows.length >= 8) break;
    }
    return rows;
  }, [unsearchedAssets, searchQuery]);

  const autoCodePreview = useMemo(() => {
    const group = assetGroups.find((item) => item.code === form.assetGroup);
    const department = departments.find((item) => item.code === form.departmentCode);
    // Dùng chung luật với chỗ cấp mã thật (lib/asset-code-generator.ts) để "Mã dự kiến" trên
    // form không bao giờ khác mã hệ thống ghi xuống.
    const groupRaw = (group?.codePrefix || defaultAssetCodePrefix(form.assetGroup, group?.group))
      .replace(/[-_]/g, "").toUpperCase();
    const departmentRaw = (department?.codePrefix || department?.code || "").replace(/[-_]/g, "").toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(groupRaw) || !/^[A-Z0-9]{3}$/.test(departmentRaw)) return "";
    return `${groupRaw}${departmentRaw}0001`;
  }, [assetGroups, departments, form.assetGroup, form.departmentCode]);

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
      paymentStatus: asset.paymentStatus === "PAYABLE" ? "PAYABLE" : "PAID",
      payableAmount: asset.payableAmount ? String(asset.payableAmount) : "",
      paymentDueDate: asset.paymentDueDate ? asset.paymentDueDate.slice(0, 10) : "",
      imageUrl: asset.imageUrl || "",
      note: asset.note || "",
      reuseCode: false,
      catalogLocked: false,
      // Hồ sơ cũ chưa có chi tiết mua: coi nguyên giá là tiền hàng (đơn giá = nguyên giá / SL).
      unitPrice: String(asset.unitPrice ?? (asset.quantity ? asset.originalCost / asset.quantity : asset.originalCost)),
      discountRate: asset.discountRate !== null && asset.discountRate !== undefined ? String(Number((asset.discountRate * 100).toFixed(4))) : "",
      discountAmount: asset.discountRate === null || asset.discountRate === undefined ? (asset.discountAmount ? String(asset.discountAmount) : "") : "",
      vatRate: asset.unitPrice === null || asset.unitPrice === undefined ? "KKKNT" : vatRateLabel(asset.vatRate),
      purchaseCost: asset.purchaseCostShare ? String(asset.purchaseCostShare) : "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Dòng đang nhập đã có nội dung (tên hoặc mã) — lưu phiếu thì tính cả dòng này. */
  const currentLineFilled = Boolean(form.name.trim() || form.code.trim());
  /** Đưa dòng đang nhập vào bảng phiếu; ô dòng trống lại để nhập mã tiếp theo (giữ phòng ban, nhóm, số kỳ). */
  const addPurchaseLine = () => {
    if (!currentLineFilled) {
      setMessageTone("error");
      setMessage(form.reuseCode ? "Chọn mã tài sản / CCDC đã có." : "Nhập tên tài sản / CCDC trước khi thêm dòng.");
      return;
    }
    setMessage("");
    const key = `line-${purchaseLines.reduce((max, line) => Math.max(max, Number(line.key.replace("line-", "")) || 0), 0) + 1}`;
    setPurchaseLines((current) => [...current, pickLine(form, key)]);
    setForm((current) => ({ ...current, reuseCode: false, catalogLocked: false, code: "", name: "", quantity: "1", unitPrice: "", discountRate: "", discountAmount: "", imageUrl: "", note: "" }));
  };
  /** Sửa một dòng đã thêm: đưa ngược lên ô nhập (dòng đang nhập dở thì thêm vào bảng trước). */
  const editPurchaseLine = (key: string) => {
    const line = purchaseLines.find((row) => row.key === key);
    if (!line) return;
    setPurchaseLines((current) => [
      ...current.filter((row) => row.key !== key),
      ...(currentLineFilled ? [pickLine(form, `${key}-x`)] : []),
    ]);
    const { key: _key, ...fields } = line;
    void _key;
    setForm((current) => ({ ...current, ...fields }));
  };
  const closeAssetForm = () => {
    setFormOpen(false);
    resetAssetForm();
  };

  const submitAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");

    if (editingAsset) {
      // Đổi Đã thanh toán ↔ Công nợ là thao tác riêng: máy chủ sinh/gỡ công nợ CN-<mã> và ghi lại
      // bút toán ghi tăng. Chạy trước phần sửa hồ sơ để lỗi (thiếu NCC, nợ đã trả...) dừng ngay.
      const currentPayment = editingAsset.paymentStatus === "PAYABLE" ? "PAYABLE" : "PAID";
      if (form.paymentStatus !== currentPayment) {
        const changeResponse = await fetch("/api/assets", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...getSessionHeaders() },
          body: JSON.stringify({
            action: "CHANGE_PAYMENT",
            id: editingAsset.id,
            paymentStatus: form.paymentStatus,
            supplierCode: form.supplierCode,
            paymentDueDate: form.paymentDueDate,
          }),
        });
        const changePayload = await changeResponse.json();
        if (!changeResponse.ok) {
          setMessageTone("error");
          setMessage(changePayload.error || "Không đổi được hình thức thanh toán");
          return;
        }
      }
      const { paymentStatus: _paymentStatus, payableAmount: _payableAmount, paymentDueDate: _paymentDueDate, purchaseCost: _purchaseCost, unitPrice: _unitPrice, discountRate: _discountRate, discountAmount: _discountAmount, vatRate: _vatRate, ...editableForm } = form;
      void _paymentStatus;
      void _payableAmount;
      void _paymentDueDate;
      void _purchaseCost;
      void _unitPrice;
      void _discountRate;
      void _discountAmount;
      void _vatRate;
      // Nguyên giá = trị giá mua của dòng (khách 27/10/2026), lưu kèm chi tiết để in phiếu.
      const [editFigures] = lineFiguresOf([form], Number(form.purchaseCost) || 0);
      const editVat = parseVatRate(form.vatRate);
      const purchaseTerms = {
        originalCost: String(editFigures.purchaseValue),
        unitPrice: form.unitPrice === "" ? null : Number(form.unitPrice) || 0,
        discountRate: editFigures.discountRate,
        discountAmount: editFigures.discountAmount,
        vatRate: editVat.ok ? editVat.rate : null,
        vatAmount: editFigures.vatAmount,
        purchaseCostShare: editFigures.costShare,
      };
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
        : { ...editableForm, ...purchaseTerms, id: editingAsset.id };

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

    // Phiếu mua nhiều dòng (khách 27/10/2026): dòng đã thêm + dòng đang nhập (nếu có), chung phần đầu phiếu.
    const lines = [...purchaseLines, ...(currentLineFilled ? [pickLine(form, "current")] : [])];
    if (lines.length === 0) {
      setMessageTone("error");
      setMessage("Nhập ít nhất một dòng tài sản / CCDC (tên hoặc mã).");
      return;
    }
    const response = await fetch("/api/assets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getSessionHeaders(),
      },
      body: JSON.stringify({
        branchCode: form.branchCode,
        location: form.location,
        purchaseDate: form.purchaseDate,
        depreciationStartDate: form.depreciationStartDate,
        supplierCode: form.supplierCode,
        supplierName: form.supplierName,
        paymentStatus: form.paymentStatus,
        paymentDueDate: form.paymentDueDate,
        purchaseCost: form.purchaseCost,
        lines: lines.map(({ key: _key, catalogLocked: _catalogLocked, ...line }) => { void _key; void _catalogLocked; return line; }),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessageTone("error");
      setMessage(payload.error || "Không tạo được tài sản");
      return;
    }
    const created = (payload.assets || []) as Asset[];
    setMessageTone("success");
    setMessage(`Đã lưu phiếu mua ${payload.purchaseDocCode || ""}: ${created.map((asset) => `${asset.code}${(asset.lotNo || 1) > 1 ? ` (đợt ${asset.lotNo})` : ""}`).join(", ")}. Bấm "In phiếu" trên dòng để in cả phiếu.`);
    setPurchaseLines([]);
    setForm({ ...emptyForm, branchCode: form.branchCode, location: form.location, purchaseDate: form.purchaseDate, depreciationStartDate: form.depreciationStartDate, departmentCode: form.departmentCode });
    setFormOpen(false);
    await loadAssets();
  };

  /**
   * "Tạo hồ sơ" từ Danh mục mã: mã đã có hồ sơ thì là mua tăng (đợt mới), chưa có thì hồ sơ đầu
   * tiên mang đúng mã / tên / nhóm của danh mục.
   */
  const startRecordFromCatalog = (item: CatalogItem) => {
    setEditingAsset(null);
    setFormOpen(true);
    setMessage("");
    setView("records");
    setForm((current) => ({
      ...emptyForm,
      branchCode: current.branchCode,
      code: item.code,
      name: item.name,
      assetGroup: item.assetGroup,
      departmentCode: item.departmentCode || "",
      reuseCode: item.usage.lotCount > 0,
      catalogLocked: item.usage.lotCount === 0,
    }));
    window.setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 0);
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
        if (Array.isArray(payload.steps)) setDeleteSteps(payload.steps);
        setDeleteError(payload.steps?.length ? null : payload.error || "Không xoá được tài sản");
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
            {/* Dạng bảng chia đôi hai bên cho gọn (khách 27/10/2026): 6 phòng ban thì mỗi bên 3; bấm dòng để lọc. */}
            {(() => {
              const half = Math.ceil(departmentSummary.length / 2);
              const halves = [departmentSummary.slice(0, half), departmentSummary.slice(half)].filter((rows) => rows.length > 0);
              return (
                <div className="grid lg:grid-cols-2 gap-px bg-slate-200">
                  {halves.map((rows, index) => (
                    <table key={index} className="w-full bg-white text-xs self-start">
                      <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                        <tr>
                          <th className="px-4 py-2 text-left font-bold">Phòng ban</th>
                          <th className="px-3 py-2 text-right font-bold">Dòng</th>
                          <th className="px-3 py-2 text-right font-bold">Số lượng</th>
                          <th className="px-3 py-2 text-right font-bold">Nguyên giá</th>
                          <th className="px-4 py-2 text-right font-bold">Còn lại</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr
                            key={row.code}
                            onClick={() => setFilterDepartment(row.code)}
                            className={`cursor-pointer border-t border-slate-100 hover:bg-blue-50 ${filterDepartment === row.code ? "bg-blue-50" : ""}`}
                            title="Bấm để lọc danh sách theo phòng ban này"
                          >
                            <td className="px-4 py-2 font-bold text-slate-900">{row.name}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.count}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{row.quantity}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-bold text-slate-800">{money(row.originalCost)} đ</td>
                            <td className="px-4 py-2 text-right tabular-nums font-bold text-emerald-700">{money(row.remainingValue)} đ</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ))}
                </div>
              );
            })()}
          </section>
        )}

        {/* Hồ sơ từng đợt mua | Danh mục mã (giống tab Mặt hàng bên Kho). */}
        <div className="flex flex-wrap gap-2">
          {([["records", "Hồ sơ tài sản & CCDC", "inventory_2"], ["catalog", "Danh mục mã", "list_alt"]] as const).map(([key, label, icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-bold border transition-colors ${view === key ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              <span className="material-symbols-outlined text-lg">{icon}</span>{label}
            </button>
          ))}
        </div>

        {view === "catalog" ? (
          <AssetCatalogPanel
            headers={getSessionHeaders}
            assetGroups={assetGroupOptions}
            departments={departments.map((department) => ({ code: department.code, label: department.name }))}
            canCreate={canCreate}
            canEdit={canEditCatalog}
            canDelete={canDeleteCatalog}
            onChanged={() => void loadAssets()}
            onCreateRecord={startRecordFromCatalog}
          />
        ) : (
        <div className="space-y-5">
          {/* Form tạo mở bằng nút (khách 27/10/2026: form cố định bên trái quá hẹp) — mở ra rộng hết khung. */}
          {canCreate && !showAssetForm && (
            <button
              type="button"
              onClick={() => { setMessage(""); setFormOpen(true); }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-blue-700"
            >
              <span className="material-symbols-outlined text-lg">add</span>Thêm tài sản / CCDC
            </button>
          )}
          {showAssetForm && (() => {
            // Nguyên giá từng dòng = trị giá mua (sau CK + thuế + chi phí mua phân bổ theo tiền hàng các dòng).
            const draftLines = editingAsset ? [form] : [...purchaseLines, ...(currentLineFilled || form.unitPrice ? [form] : [])];
            const figures = lineFiguresOf(draftLines, Number(form.purchaseCost) || 0);
            const currentFigures = editingAsset || currentLineFilled || form.unitPrice ? figures[figures.length - 1] : null;
            const savedFigures = editingAsset ? [] : figures.slice(0, purchaseLines.length);
            const lineCount = purchaseLines.length + (currentLineFilled ? 1 : 0);
            const priceLocked = editingAllocatedPeriods > 0;
            return (
            <form
              onSubmit={submitAsset}
              className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold text-blue-600 uppercase">Tài sản & CCDC Master</p>
                  <h2 className="font-bold text-lg text-slate-900 mt-0.5">
                    {editingAsset ? `Sửa hồ sơ ${editingAsset.code}` : "Phiếu mua tài sản / CCDC"}
                  </h2>
                  {!editingAsset && (
                    <p className="text-xs text-slate-500 mt-0.5">Mua nhiều mã một lần: nhập từng dòng rồi bấm <b>Thêm dòng vào phiếu</b>; cả phiếu chung một số phiếu để in gộp. Nguyên giá (số dùng khấu hao / phân bổ) = sau chiết khấu + thuế + chi phí mua hàng.</p>
                  )}
                </div>
                <button type="button" onClick={closeAssetForm} className="icon-button" title="Đóng"><span className="material-symbols-outlined">close</span></button>
              </div>

              {editingAsset && editingAllocatedPeriods > 0 && (
                <p className="text-xs rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
                  Tài sản đã trích khấu hao {editingAllocatedPeriods} kỳ nên số lượng, ngày mua, nguyên giá, số kỳ khấu hao,
                  ngày bắt đầu khấu hao và giá trị thu hồi sẽ được giữ nguyên. Chỉ thông tin quản lý được cập nhật.
                </p>
              )}

              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
                <section className="space-y-3">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{editingAsset ? "Thông tin mua" : "Thông tin chung của phiếu"}</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Cửa hàng *
                  <select
                    value={form.branchCode}
                    onChange={(e) => {
                      const branchCode = e.target.value;
                      // Mua tăng mã của nhà hàng khác: kho/phòng ban lấy từ đợt cũ có thể không thuộc cửa hàng mới.
                      const inBranch = (item?: MasterItem) => Boolean(item) && (!item?.branch || item.branch === branchCode || item.branch === "ALL");
                      setForm((v) => ({
                        ...v,
                        branchCode,
                        location: inBranch(warehouses.find((w) => w.code === v.location)) ? v.location : "",
                        departmentCode: inBranch(departments.find((d) => d.code === v.departmentCode)) ? v.departmentCode : "",
                      }));
                    }}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white disabled:bg-slate-100 disabled:text-slate-500"
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
                    required={form.paymentStatus === "PAYABLE"}
                    disabled={Boolean(editingAsset && editingAsset.paymentStatus === "PAYABLE")}
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
                      required={form.paymentStatus === "PAYABLE"}
                      disabled={Boolean(editingAsset && editingAsset.paymentStatus === "PAYABLE")}
                    />
                  </label>
                )}

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Thanh toán mua tài sản *
                  <select
                    value={form.paymentStatus}
                    onChange={(e) => setForm((v) => ({ ...v, paymentStatus: e.target.value, payableAmount: e.target.value === "PAYABLE" ? v.originalCost : "", paymentDueDate: e.target.value === "PAYABLE" ? v.paymentDueDate : "" }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white disabled:bg-slate-100"
                    disabled={paymentLockReason !== null}
                    title={paymentLockReason || undefined}
                    required
                  >
                    <option value="PAYABLE">Công nợ phải trả NCC</option>
                    <option value="PAID">Đã thanh toán</option>
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-600 block">
                  Hạn thanh toán
                  <DateInput
                    value={form.paymentDueDate}
                    onChange={(paymentDueDate) => setForm((v) => ({ ...v, paymentDueDate }))}
                    className="mt-1"
                    disabled={form.paymentStatus !== "PAYABLE" || Boolean(editingAsset && editingAsset.paymentStatus === "PAYABLE")}
                    ariaLabel="Hạn thanh toán công nợ tài sản"
                  />
                </label>
              </div>
              {form.paymentStatus === "PAYABLE" && !editingAsset && (
                <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  Khi lưu, hệ thống tạo công nợ NCC bằng nguyên giá và bút toán Nợ 211/242 – Có 331 trong cùng giao dịch.
                </p>
              )}
              {editingAsset && form.paymentStatus !== (editingAsset.paymentStatus === "PAYABLE" ? "PAYABLE" : "PAID") && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {form.paymentStatus === "PAYABLE"
                    ? "Khi lưu, hệ thống tạo công nợ NCC bằng nguyên giá (mã CN-<mã tài sản>) và đổi bút toán ghi tăng sang Có 331. Cần chọn Nhà cung cấp."
                    : "Khi lưu, hệ thống gỡ công nợ NCC của tài sản này (chỉ được khi chưa trả đồng nào) và đổi bút toán ghi tăng sang Có 411."}
                </p>
              )}
              {paymentLockReason && editingAsset && (
                <p className="text-[11px] text-slate-500">{paymentLockReason}</p>
              )}

              <label className="text-xs font-bold text-slate-600 block">
                {editingAsset ? "Chi phí mua phân bổ cho tài sản này (đ)" : "Chi phí mua hàng của phiếu (đ)"}
                <MoneyInput className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 text-right" value={form.purchaseCost} onChange={(purchaseCost) => setForm((v) => ({ ...v, purchaseCost }))} placeholder="0" ariaLabel="Chi phí mua hàng" disabled={priceLocked} />
                <span className="mt-1 block text-[11px] font-normal text-slate-500">Vận chuyển, lắp đặt... cộng vào nguyên giá{editingAsset ? "" : ", chia theo tiền hàng (sau chiết khấu) từng dòng"}.</span>
              </label>
                </section>

                <section className="space-y-3 lg:border-l lg:border-slate-200 lg:pl-6 lg:pr-2 lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
                  <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{editingAsset ? "Tài sản / CCDC" : `Dòng ${purchaseLines.length + 1} của phiếu`}</h3>
              {/* Mua tăng cùng loại: dùng lại mã cũ, ghi thành ĐỢT mới (lib/asset-lot.ts). */}
              {!editingAsset && (
                <label className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
                  <input
                    type="checkbox"
                    className="mt-0.5 accent-emerald-600"
                    checked={form.reuseCode}
                    onChange={(e) => setForm((v) => ({ ...emptyForm, branchCode: v.branchCode, reuseCode: e.target.checked }))}
                  />
                  <span>
                    <b>Mua tăng vào mã đã có</b> — chọn mã CCDC/tài sản cũ, hệ thống ghi đợt mới với ngày mua, nguyên giá và số kỳ phân bổ riêng; tên, nhóm lấy theo mã cũ; cửa hàng, kho, phòng ban chọn lại được (cùng mã có thể ở nhiều nhà hàng).
                  </span>
                </label>
              )}

              {form.reuseCode && !editingAsset ? (
                <SearchableSelect
                  label="Mã tài sản / CCDC đã có *"
                  value={form.code}
                  onChange={(code) => {
                    const template = reusableAssets.find((asset) => asset.code === code);
                    setForm((v) => ({
                      ...v,
                      code,
                      name: template?.name || "",
                      branchCode: template?.branchCode || v.branchCode,
                      departmentCode: template?.departmentCode || "",
                      assetGroup: template?.assetGroup || v.assetGroup,
                      location: template?.location || "",
                      usefulLifeMonths: template?.usefulLifeMonths ? String(template.usefulLifeMonths) : v.usefulLifeMonths,
                      supplierCode: template?.supplierCode || "",
                      supplierName: template?.supplierName || "",
                    }));
                  }}
                  options={reusableAssets.map((asset) => ({ value: asset.code, label: `${asset.code} - ${asset.name}`, subLabel: `${asset.branchCode} · ${asset.departmentCode || "-"} · ${asset.lotCount || 1} đợt` }))}
                  placeholder="Gõ mã hoặc tên để tìm..."
                  required
                />
              ) : (
                <label className="text-xs font-bold text-slate-600 block">
                  Mã tài sản / CCDC
                  <input
                    type="text"
                    value={form.code}
                    onChange={(e) => setForm((v) => ({ ...v, code: e.target.value.toUpperCase() }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono uppercase focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                    placeholder={autoCodePreview || "Để trống để hệ thống tự sinh"}
                    disabled={Boolean(editingAsset && editingAsset.canEditCode === false) || (form.catalogLocked && !editingAsset)}
                    maxLength={50}
                  />
                  <span className="mt-1 block text-[11px] font-normal text-slate-500">
                    {editingAsset?.canEditCode === false
                      ? editingAsset.codeEditLockReason || "Mã đã bị khóa do hồ sơ đã phát sinh nghiệp vụ."
                      : form.code
                        ? "Mã nhập thủ công; chỉ dùng chữ, số, dấu - và _."
                        : autoCodePreview
                          ? `Mã dự kiến: ${autoCodePreview} (4 ký tự nhóm + 3 ký tự phòng ban + 4 số).`
                          : "Hãy cấu hình tiền tố nhóm 4 ký tự và phòng ban 3 ký tự để tự sinh mã."}
                  </span>
                </label>
              )}

              <label className="text-xs font-bold text-slate-600 block">
                Tên tài sản / CCDC *
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                  placeholder="Nhập tên máy móc, thiết bị, CCDC..."
                  disabled={(form.reuseCode || form.catalogLocked) && !editingAsset}
                  required
                />
                {form.catalogLocked && !editingAsset && (
                  <span className="mt-1 block text-[11px] font-normal text-slate-500">Tên và nhóm theo Danh mục mã — sai thì sửa ở tab Danh mục mã.</span>
                )}
              </label>

              <div className="grid grid-cols-2 gap-3">
                <SearchableSelect
                  label="Phòng ban / Bộ phận"
                  value={form.departmentCode}
                  onChange={(departmentCode) => setForm((v) => ({ ...v, departmentCode }))}
                  options={availableFormDepartments.map((dep) => ({ value: dep.code, label: dep.name, subLabel: dep.code }))}
                  placeholder="Chọn phòng ban..."
                  required={!form.code}
                />

                <label className="text-xs font-bold text-slate-600 block">
                  Nhóm tài sản *
                  <select
                    value={form.assetGroup}
                    disabled={(form.reuseCode || form.catalogLocked) && !editingAsset}
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

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Số lượng *
                  <input type="number" min="0.01" step="0.01" value={form.quantity} onChange={(e) => setForm((v) => ({ ...v, quantity: e.target.value }))} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500" disabled={priceLocked} required />
                </label>
                <label className="text-xs font-bold text-slate-600 block">
                  Đơn giá (đ)
                  <MoneyInput className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 text-right font-bold" value={form.unitPrice} onChange={(unitPrice) => setForm((v) => ({ ...v, unitPrice }))} placeholder="0" ariaLabel="Đơn giá tài sản" disabled={priceLocked} />
                </label>
                {/* Gõ % thì xoá số tiền và ngược lại — dòng chỉ theo một cách khai. */}
                <label className="text-xs font-bold text-slate-600 block">
                  Chiết khấu %
                  <input type="number" min="0" max="100" step="any" inputMode="decimal" value={form.discountRate} onChange={(e) => setForm((v) => ({ ...v, discountRate: e.target.value, discountAmount: "" }))} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 text-right" placeholder="%" disabled={priceLocked} />
                </label>
                <label className="text-xs font-bold text-slate-600 block">
                  Tiền chiết khấu
                  <MoneyInput className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 text-right" value={form.discountRate && currentFigures ? String(currentFigures.discountAmount) : form.discountAmount} onChange={(discountAmount) => setForm((v) => ({ ...v, discountAmount, discountRate: "" }))} placeholder="0" ariaLabel="Tiền chiết khấu" disabled={priceLocked} />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Thuế suất GTGT
                  <select value={form.vatRate || "KKKNT"} onChange={(e) => setForm((v) => ({ ...v, vatRate: e.target.value }))} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500 bg-white" disabled={priceLocked}>
                    {VAT_RATE_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-600 block">
                  Số kỳ (tháng)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.usefulLifeMonths}
                    onChange={(e) => setForm((v) => ({ ...v, usefulLifeMonths: e.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-2.5 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100 disabled:text-slate-500"
                    disabled={editingAllocatedPeriods > 0}
                    placeholder="VD: 24"
                  />
                </label>
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
              </div>

              {currentFigures && (
                <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
                  <div className="flex justify-between gap-2"><dt>Thành tiền trước thuế</dt><dd className="tabular-nums">{money(currentFigures.gross)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Chiết khấu</dt><dd className="tabular-nums">{money(currentFigures.discountAmount)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Tiền thuế</dt><dd className="tabular-nums">{money(currentFigures.vatAmount)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Thành tiền sau thuế</dt><dd className="tabular-nums">{money(currentFigures.afterTax)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>CP mua phân bổ</dt><dd className="tabular-nums">{money(currentFigures.costShare)}</dd></div>
                  <div className="flex justify-between gap-2 font-bold"><dt>Nguyên giá</dt><dd className="tabular-nums">{money(currentFigures.purchaseValue)} đ</dd></div>
                </dl>
              )}

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

              {!editingAsset && (
                <button type="button" onClick={addPurchaseLine} className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-white px-3 py-2 text-sm font-bold text-blue-700 hover:bg-blue-50">
                  <span className="material-symbols-outlined text-lg">playlist_add</span>Thêm dòng vào phiếu
                </button>
              )}

              {/* Bảng dòng của phiếu nằm ngay dưới ô nhập; khung phải tự cuộn khi phiếu dài (khách 27/10/2026). */}
              {!editingAsset && purchaseLines.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                      <tr>
                        {["#", "Tài sản / CCDC", "Nhóm / Phòng ban", "SL", "Đơn giá", "Chiết khấu", "Thuế", "Sau thuế", "CP mua PB", "Nguyên giá", "Số kỳ", ""].map((label, index) => (
                          <th key={`${label}-${index}`} className={`px-2 py-2 font-bold ${index >= 3 && index <= 10 ? "text-right" : "text-left"}`}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {purchaseLines.map((line, index) => {
                        const lineFigures = savedFigures[index];
                        return (
                          <tr key={line.key} className="border-t border-slate-100 align-top">
                            <td className="px-2 py-2">{index + 1}</td>
                            <td className="px-2 py-2"><b>{line.name || line.code}</b><small className="block text-slate-500">{line.reuseCode ? `Mua tăng ${line.code}` : line.code || "Mã tự sinh"}</small></td>
                            <td className="px-2 py-2">{assetGroupOptions.find((group) => group.code === line.assetGroup)?.label || line.assetGroup}<small className="block text-slate-500">{line.departmentCode || "-"}</small></td>
                            <td className="px-2 py-2 text-right tabular-nums">{line.quantity}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{money(Number(line.unitPrice) || 0)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{lineFigures?.discountAmount ? money(lineFigures.discountAmount) : "-"}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{lineFigures?.vatAmount ? money(lineFigures.vatAmount) : "-"}<small className="block text-slate-500">{line.vatRate}</small></td>
                            <td className="px-2 py-2 text-right tabular-nums">{money(lineFigures?.afterTax || 0)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{lineFigures?.costShare ? money(lineFigures.costShare) : "-"}</td>
                            <td className="px-2 py-2 text-right tabular-nums font-bold">{money(lineFigures?.purchaseValue || 0)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{line.usefulLifeMonths || "-"}</td>
                            <td className="px-2 py-2 text-right whitespace-nowrap">
                              <button type="button" onClick={() => editPurchaseLine(line.key)} className="font-bold text-blue-700 hover:underline">Sửa</button>
                              <button type="button" onClick={() => setPurchaseLines((current) => current.filter((row) => row.key !== line.key))} className="ml-2 font-bold text-rose-600 hover:underline">Bỏ</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                      <tr>
                        <td className="px-2 py-2" colSpan={9}>Cộng {lineCount} dòng{currentLineFilled ? " (gồm dòng đang nhập)" : ""}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{money(figures.reduce((sum, row) => sum + row.purchaseValue, 0))} đ</td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
                </section>
              </div>


              {message && (
                <p className={`text-sm rounded-lg border px-3 py-2 ${messageTone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
                  {message}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={closeAssetForm}
                  className="px-4 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-lg py-2.5 text-sm font-bold transition-colors"
                >
                  {editingAsset ? "Huỷ" : "Đóng"}
                </button>
                <button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2.5 text-sm font-bold transition-colors shadow-sm">
                  {editingAsset ? "Lưu thay đổi" : `Lưu phiếu mua (${lineCount} dòng)`}
                </button>
              </div>
            </form>
            );
          })()}

          {/* Asset List & Filter Table */}
          <section className="min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col max-h-[760px]">
            {/* Filter Toolbar */}
            <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-bold text-slate-900 text-base">Danh sách Tài sản &amp; CCDC</h2>
                {/* Tick nhiều tài sản → in chung một phiếu (khách 27/10/2026). */}
                {printIds.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => window.open(`/assets/batch/print?ids=${encodeURIComponent(printIds.join(","))}`, "_blank")}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 font-bold text-white hover:bg-blue-700"
                    >
                      In gộp {printIds.length} tài sản
                    </button>
                    <button type="button" onClick={() => setPrintIds([])} className="font-bold text-slate-500 hover:underline">Bỏ chọn</button>
                  </div>
                )}
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

                <div className="relative">
                  <label className="text-[11px] font-semibold text-slate-500 block mb-1">Tìm kiếm</label>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    // Trễ một nhịp để bấm được vào gợi ý trước khi danh sách đóng.
                    onBlur={() => window.setTimeout(() => setSearchFocused(false), 150)}
                    onKeyDown={(e) => { if (e.key === "Escape") setSearchFocused(false); }}
                    placeholder="Mã, tên, ghi chú... (không cần dấu)"
                    className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs focus:border-blue-500"
                  />
                  {searchFocused && searchSuggestions.length > 0 && (
                    <ul className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 text-xs shadow-lg">
                      {searchSuggestions.map((asset) => (
                        <li key={asset.code}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => { setSearchQuery(asset.code); setSearchFocused(false); }}
                            className="w-full px-2.5 py-1.5 text-left hover:bg-blue-50"
                          >
                            <span className="font-medium text-slate-800">{asset.name}</span>
                            <span className="ml-1.5 font-mono text-[11px] text-slate-400">{asset.code}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-4 py-2">
              <DateRangeFilter label="Ngày mua" value={purchaseRange} onChange={setPurchaseRange} />
              <ExportExcelButton fileName="danh_sach_tai_san" sheetName="Tai san" targetId="asset-table" />
            </div>
            <div id="asset-table" className="overflow-x-auto overflow-y-auto flex-1 custom-scrollbar max-h-[560px]">
              <table className="w-full text-left text-xs min-w-[1040px]">
                <thead className="bg-slate-100 text-slate-600 uppercase font-bold border-b border-slate-200 sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="pl-4 pr-1 py-3 w-8" data-export-cells="[]">
                      <input
                        type="checkbox"
                        aria-label="Chọn tất cả để in gộp"
                        checked={assets.length > 0 && assets.every((asset) => printIds.includes(asset.id))}
                        onChange={(e) => setPrintIds(e.target.checked ? assets.map((asset) => asset.id) : [])}
                      />
                    </th>
                    {/* File Excel tách ô gộp ra từng cột (data-export-cells) để khách lọc / pivot được. */}
                    <th className="px-4 py-3" data-export-cells={JSON.stringify(["Mã", "Đợt", "Tên tài sản / CCDC", "Nhà cung cấp", "Ghi chú", "Công nợ"])}>Tài sản / CCDC</th>
                    <th className="px-3 py-3">Cửa hàng / Kho</th>
                    <th className="px-3 py-3" data-export-cells={JSON.stringify(["Nhóm", "Số lượng", "Phòng ban"])}>Nhóm / SL</th>
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
                      <td colSpan={11} className="px-4 py-12 text-center text-slate-400">
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
                        <tr key={asset.id} data-doc-code={asset.code} className={asset.code === focusCode ? focusRowClass : "hover:bg-slate-50/80 transition-colors"}>
                          <td className="pl-4 pr-1 py-3 align-top" data-export-cells="[]">
                            <input
                              type="checkbox"
                              aria-label={`Chọn ${asset.code} để in gộp`}
                              checked={printIds.includes(asset.id)}
                              onChange={(e) => setPrintIds((current) => (e.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id)))}
                            />
                          </td>
                          <td
                            className="px-4 py-3"
                            data-export-cells={JSON.stringify([
                              asset.code,
                              (asset.lotCount || 1) > 1 ? `${asset.lotNo || 1}/${asset.lotCount}` : "",
                              asset.name,
                              asset.supplierName || "",
                              asset.note || "",
                              asset.payableDebtCode ? `${asset.payableDebtCode} · ${asset.payableDebtStatus || "OPEN"}` : "",
                            ])}
                          >
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
                                  {(asset.lotCount || 1) > 1 && (
                                    <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700" title="Mã này có nhiều đợt mua; mỗi đợt phân bổ theo ngày mua và số kỳ riêng">
                                      đợt {asset.lotNo || 1}/{asset.lotCount}
                                    </span>
                                  )}
                                  <span className="font-medium text-slate-800">- {asset.name}</span>
                                </div>
                                <p className="text-[11px] text-slate-400">
                                  NCC: {asset.supplierName || "-"}
                                  {asset.note && ` · ${asset.note}`}
                                </p>
                                {asset.purchaseDocCode && (
                                  <p className="text-[11px] font-medium text-slate-600">
                                    Phiếu mua{" "}
                                    <button type="button" onClick={() => window.open(`/assets/batch/print?doc=${encodeURIComponent(asset.purchaseDocCode || "")}`, "_blank")} className="font-bold text-blue-700 hover:underline" title="In cả phiếu mua">
                                      {asset.purchaseDocCode}
                                    </button>
                                  </p>
                                )}
                                {asset.payableDebtCode && (
                                  <p className="text-[11px] font-medium text-amber-700">
                                    Công nợ: <DocLink code={asset.payableDebtCode} /> · {asset.payableDebtStatus || "OPEN"}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>

                          <td className="px-3 py-3">
                            <span className="font-semibold text-slate-800">{storeLabel(asset.branchCode)}</span>
                            <p className="text-[11px] text-slate-500">{warehouseName}</p>
                          </td>

                          <td className="px-3 py-3" data-export-cells={JSON.stringify([getGroupLabel(asset.assetGroup), String(asset.quantity ?? ""), departmentName])}>
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
                                  {formatPeriodCount(asset.allocatedPeriods || 0)} / {formatPeriodCount(asset.usefulLifeMonths)} kỳ
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
                            <div className="flex items-center justify-end gap-1.5">
                            {/* In Phiếu nhập tài sản / CCDC (khách yêu cầu 03/10/2026). */}
                            <button
                              type="button"
                              onClick={() => window.open(asset.purchaseDocCode ? `/assets/batch/print?doc=${encodeURIComponent(asset.purchaseDocCode)}` : `/assets/${asset.id}/print`, "_blank")}
                              className="px-2.5 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-bold transition-colors"
                              title="In phiếu nhập tài sản / CCDC"
                            >
                              In
                            </button>
                            <RowActions
                              session={user}
                              module="/assets"
                              compact
                              onEdit={() => startEditAsset(asset)}
                              onDelete={() => void openDeleteAsset(asset)}
                              editDisabledReason={editLockReason(asset)}
                            />
                            </div>
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
        )}
      </main>

      <ConfirmDeleteDialog
        open={Boolean(deletingAsset)}
        title={`Xoá tài sản ${deletingAsset?.code || ""}?`}
        description={deletingAsset ? `${deletingAsset.name} · Nguyên giá ${money(deletingAsset.originalCost)} đ` : undefined}
        submitting={deleting}
        error={deleteError}
        confirmDisabled={deleteSteps === null || deleteSteps.length > 0}
        onCancel={() => {
          setDeletingAsset(null);
          setDeleteError(null);
          setDeleteSteps(null);
        }}
        onConfirm={confirmDeleteAsset}
      >
        {deleteSteps === null ? (
          <p className="text-xs text-slate-500 flex items-center gap-2">
            <span className="material-symbols-outlined text-base animate-spin">progress_activity</span>
            Đang kiểm tra chứng từ liên quan...
          </p>
        ) : deleteSteps.length > 0 ? (
          <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-3">
            <p className="font-bold flex items-center gap-2">
              <span className="material-symbols-outlined text-lg">checklist</span>
              Chưa xoá được — cần làm lần lượt {deleteSteps.length} việc sau:
            </p>
            <ol className="mt-2 space-y-2 list-decimal pl-5">
              {deleteSteps.map((step, index) => (
                <li key={index}>
                  <span>{step.text}</span>
                  {step.href && (
                    <a
                      href={step.href}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 inline-flex items-center gap-0.5 font-bold text-blue-700 hover:underline whitespace-nowrap"
                    >
                      {step.linkLabel || "Mở"}
                      <span className="material-symbols-outlined text-sm">open_in_new</span>
                    </a>
                  )}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-amber-800">
              Làm xong thì bấm Xoá lại tài sản này. Công nợ nhà cung cấp và bút toán ghi tăng của tài sản sẽ tự chuyển vào Thùng rác theo — không cần xoá riêng ở màn Công nợ Đối tác.
            </p>
          </div>
        ) : deletingAsset?.paymentStatus === "PAYABLE" ? (
          <p className="text-xs bg-slate-50 border border-slate-200 text-slate-600 rounded-lg px-3 py-2.5">
            Công nợ nhà cung cấp {deletingAsset.payableDebtCode || ""} và bút toán ghi tăng của tài sản này sẽ chuyển vào Thùng rác cùng lúc, khôi phục cũng đi cùng nhau.
          </p>
        ) : null}
      </ConfirmDeleteDialog>
    </div>
  );
}
