"use client";

import { Fragment, useEffect, useId, useMemo, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { DateInput, MonthInput } from "@/components/DateInput";
import { canOpenPath, canPerformMenuAction, SESSION_KEY, filterModuleTabs } from "@/lib/auth-demo";
import { allowedDepartmentsOf } from "@/lib/department-scope";
import { assetLotLabel, distributeStocktakeCount, type StocktakeLotInput } from "@/lib/asset-lot";
import { useModuleAuth } from "@/lib/use-module-auth";
import CopyableText from "@/components/CopyableText";

type Asset = {
  id: string;
  code: string;
  /** Đợt của mã (một mã nhiều đợt — lib/asset-lot.ts). */
  lotNo?: number;
  name: string;
  branchCode: string;
  departmentCode?: string | null;
  originalCost: number;
  currentValue: number;
  residualValue: number;
  usefulLifeMonths: number | null;
  depreciationStartDate: string | null;
  supplierName?: string | null;
  supplierCode?: string | null;
  status?: string;
  disposalAmount?: number | null;
};

type Depreciation = {
  id: string;
  period: string;
  depreciationAmount: number;
  accumulatedDepreciation: number;
  remainingValue: number;
  asset: Asset;
};

type Maintenance = {
  id: string;
  maintenanceType: string;
  scheduledDate: string;
  completedDate: string | null;
  supplierName: string | null;
  cost: number;
  recurrenceRule?: string | null;
  linkedWorkItemId?: string | null;
  status: string;
  asset: Asset;
};

type Damage = {
  id: string;
  code: string;
  severity: string;
  description: string;
  status: string;
  repairCost: number;
  repairTreatment: string | null;
  linkedWorkItemId?: string | null;
  asset: Asset;
};

type AssetStocktakeLine = {
  id: string;
  systemQuantity: number;
  actualQuantity: number;
  varianceQuantity: number;
  condition: string | null;
  note: string | null;
  /** Danh sách không kèm ảnh (data URL nặng); bấm "Xem ảnh" mới tải qua ?stocktakeLineImage=. */
  hasImage?: boolean;
  asset: Asset & { quantity?: number };
};

type MasterOption = { code: string; name: string; branch?: string | null };

type AssetStocktakeSession = {
  id: string;
  code: string;
  stocktakeDate: string;
  branchCode: string;
  status: string;
  note: string | null;
  approvedBy: string | null;
  /** Phiên kiểm của một phòng ban; null = kiểm cả cửa hàng. */
  departmentCode?: string | null;
  lines: AssetStocktakeLine[];
};

type StocktakeDraftRow = {
  assetId: string;
  code: string;
  name: string;
  departmentCode: string;
  systemQuantity: number;
  actualQuantity: string;
  condition: string;
  note: string;
  imageUrl: string;
  /**
   * Các đợt của mã (một mã nhiều đợt): kiểm kê đếm THEO MÃ, lúc duyệt hệ thống chia số đếm về
   * từng đợt (lib/asset-lot.ts distributeStocktakeCount). `assetId` là đợt đầu, chỉ để làm khoá dòng.
   */
  lots: StocktakeLotInput[];
  /** Tài sản vừa tạo mã ngay trong phiên (phát hiện khi kiểm kê). */
  isNew?: boolean;
};

const emptyNewAsset = { name: "", assetGroup: "", departmentCode: "", warehouseCode: "", quantity: "1", condition: "", imageUrl: "" };

type Data = {
  assets: (Asset & { quantity?: number })[];
  depreciations: Depreciation[];
  maintenances: Maintenance[];
  damageReports: Damage[];
  assetStocktakes: AssetStocktakeSession[];
};

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);

const MONTH_HEADERS = Array.from({ length: 12 }, (_, index) => ({ label: `T${index + 1}`, align: "right" as const }));

export default function AssetOperationsPage() {
  // Màn con của "/assets": ai mở được Tài sản thì mở được đây; vai trò chỉ gán mục
  // "Kiểm kê CCDC & Tài sản" (/assets/operations?tab=stocktake) cũng vào được (lib/auth-demo.ts canOpenPath).
  const href = "/assets/operations";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("depreciation");
  const [data, setData] = useState<Data>({ assets: [], depreciations: [], maintenances: [], damageReports: [], assetStocktakes: [] });
  const [departments, setDepartments] = useState<MasterOption[]>([]);
  const [assetGroups, setAssetGroups] = useState<MasterOption[]>([]);
  const [warehouses, setWarehouses] = useState<MasterOption[]>([]);
  const [stocktakeBranch, setStocktakeBranch] = useState("");
  const [stocktakeDepartment, setStocktakeDepartment] = useState("");
  const [stocktakeDate, setStocktakeDate] = useState(new Date().toISOString().slice(0, 10));
  const [stocktakeNote, setStocktakeNote] = useState("Kiểm kê CCDC & tài sản định kỳ");
  const [stocktakeRows, setStocktakeRows] = useState<StocktakeDraftRow[]>([]);
  const [showNewAsset, setShowNewAsset] = useState(false);
  const [newAsset, setNewAsset] = useState(emptyNewAsset);
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [expandedStocktake, setExpandedStocktake] = useState("");
  const [imageViewer, setImageViewer] = useState("");
  const [message, setMessage] = useState("");

  // Mở từ menu "Kiểm kê CCDC & Tài sản" (/assets/operations?tab=stocktake) thì vào thẳng tab đó.
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab) window.setTimeout(() => setActive(tab), 0);
  }, []);
  const [assetId, setAssetId] = useState("");
  const [config, setConfig] = useState({
    usefulLifeMonths: "60",
    depreciationStartDate: new Date().toISOString().slice(0, 10),
    residualValue: "0",
  });
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [depreciationYear, setDepreciationYear] = useState(new Date().toISOString().slice(0, 4));
  const [maintenance, setMaintenance] = useState({
    maintenanceType: "Bảo trì định kỳ",
    scheduledDate: new Date().toISOString().slice(0, 10),
    supplierName: "",
    cost: "0",
    recurrenceRule: "NONE",
    recurrenceInterval: "1",
    recurrenceEndDate: "",
    assigneeName: "",
    createWorkTask: true,
    note: "",
  });
  const [damage, setDamage] = useState({
    severity: "MEDIUM",
    description: "",
    assigneeName: "",
    dueDate: "",
    note: "",
  });
  const [resolveDamage, setResolveDamage] = useState({
    id: "",
    repairCost: "1000000",
    repairTreatment: "EXPENSE",
    numberOfPeriods: "6",
    moneySourceCode: "",
    categoryCode: "REPAIR",
    supplierName: "",
    supplierCode: "",
    dueDate: "",
    note: "",
  });
  const [disposalForm, setDisposalForm] = useState({
    assetId: "",
    disposalDate: new Date().toISOString().slice(0, 10),
    disposalAmount: "0",
    moneySourceCode: "",
    disposalNote: "",
  });

  // Menu dùng chung "/assets", nhưng tab thuộc riêng màn Vận hành tài sản.
  const visibleTabs = useMemo(() => filterModuleTabs(user, "/assets/operations"), [user]);

  // Tab mặc định có thể nằm ngoài quyền -> chuyển về tab đầu tiên được phép.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (visibleTabs.some((tab) => tab.id === active)) return;
    const fallback = visibleTabs[0].id;
    window.setTimeout(() => setActive(fallback), 0);
  }, [active, visibleTabs]);
  const canCreate = user ? canPerformMenuAction(user, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user, href, "edit") : false;

  const getSessionHeaders = (): Record<string, string> => {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
  };

  const loadData = async () => {
    const response = await fetch("/api/assets/operations", {
      headers: getSessionHeaders(),
    });
    if (!response.ok) return;
    const payload = await response.json() as Data;
    setData(payload);
    setAssetId((value) => value || payload.assets[0]?.id || "");
  };

  // Danh mục cho tab Kiểm kê: lọc theo phòng ban + form tạo mã cho tài sản phát hiện khi kiểm.
  const loadMasterData = async () => {
    const headers = getSessionHeaders();
    const toOptions = async (response: Response): Promise<MasterOption[]> => {
      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows.map((row) => ({ code: String(row.code), name: String(row.name || row.code), branch: row.branch ?? null })) : [];
    };
    const [departmentRows, groupRows, warehouseRows] = await Promise.all([
      fetch("/api/master-data?type=DEPARTMENT&status=ACTIVE", { headers }).then(toOptions),
      fetch("/api/master-data?type=ASSET_GROUP&status=ACTIVE", { headers }).then(toOptions),
      fetch("/api/master-data?type=WAREHOUSE&status=ACTIVE", { headers }).then(toOptions),
    ]);
    setDepartments(departmentRows);
    setAssetGroups(groupRows);
    setWarehouses(warehouseRows);
  };

  /** Phạm vi bộ phận của người đang đăng nhập; null = không giới hạn. */
  const scopedDepartments = useMemo(() => allowedDepartmentsOf(user), [user]);

  /** Phòng ban chọn được ở tab Kiểm kê: theo cửa hàng đang kiểm và theo phạm vi bộ phận của user. */
  const stocktakeDepartmentOptions = useMemo(() => departments
    .filter((department) => !stocktakeBranch || !department.branch || department.branch === "ALL" || department.branch === stocktakeBranch)
    .filter((department) => !scopedDepartments || scopedDepartments.includes(department.code.toUpperCase())), [departments, stocktakeBranch, scopedDepartments]);

  // Dòng kiểm kê dựng từ danh sách tài sản (API đã cắt theo phạm vi bộ phận), lọc thêm theo
  // cửa hàng và phòng ban đang chọn. Chỉ tài sản chưa thanh lý.
  const buildStocktakeRows = (branchCode: string, departmentCode: string): StocktakeDraftRow[] => {
    const rows = new Map<string, StocktakeDraftRow>();
    const candidates = data.assets
      .filter((asset) => asset.branchCode === branchCode && asset.status !== "DISPOSED")
      .filter((asset) => !departmentCode || (asset.departmentCode || "").toUpperCase() === departmentCode.toUpperCase())
      .sort((a, b) => a.code.localeCompare(b.code) || (a.lotNo || 1) - (b.lotNo || 1));
    // Một mã nhiều đợt gộp thành MỘT dòng: nhân viên đếm cái nồi, không phân biệt nồi mua đợt nào.
    for (const asset of candidates) {
      const lot = { id: asset.id, lotNo: asset.lotNo || 1, quantity: asset.quantity || 0 };
      const existing = rows.get(asset.code);
      if (existing) {
        existing.lots.push(lot);
        existing.systemQuantity += lot.quantity;
        existing.actualQuantity = String(existing.systemQuantity);
        continue;
      }
      rows.set(asset.code, {
        assetId: asset.id,
        code: asset.code,
        name: asset.name,
        departmentCode: asset.departmentCode || "",
        systemQuantity: lot.quantity,
        actualQuantity: String(lot.quantity),
        condition: "",
        note: "",
        imageUrl: "",
        lots: [lot],
      });
    }
    return [...rows.values()];
  };

  /** Dòng gửi lên API: mỗi ĐỢT một dòng, số đếm theo mã chia về từng đợt. */
  const stocktakeLinesForSubmit = () => stocktakeRows.flatMap((row) => {
    const actual = Number(row.actualQuantity || 0);
    if (row.isNew || row.lots.length <= 1) {
      return [{ assetId: row.assetId, systemQuantity: row.systemQuantity, actualQuantity: actual, condition: row.condition, note: row.note, imageUrl: row.imageUrl, discovered: Boolean(row.isNew) }];
    }
    return distributeStocktakeCount(row.lots, actual).map((lot) => ({
      assetId: lot.id,
      systemQuantity: lot.systemQuantity,
      actualQuantity: lot.actualQuantity,
      condition: row.condition,
      note: row.note,
      imageUrl: row.imageUrl,
      discovered: false,
    }));
  });

  /** Tài sản phát hiện khi kiểm: tạo mã trên server rồi thêm ngay một dòng (sổ sách 0, đếm = số thực tế). */
  const createStocktakeAsset = async () => {
    if (creatingAsset) return;
    setCreatingAsset(true);
    setMessage("");
    try {
      const response = await fetch("/api/assets/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getSessionHeaders() },
        body: JSON.stringify({
          action: "CREATE_STOCKTAKE_ASSET",
          branchCode: stocktakeBranch,
          stocktakeDate,
          name: newAsset.name,
          assetGroup: newAsset.assetGroup,
          departmentCode: newAsset.departmentCode,
          warehouseCode: newAsset.warehouseCode,
          quantity: newAsset.quantity,
          imageUrl: newAsset.imageUrl,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không tạo được mã tài sản");
        return;
      }
      setStocktakeRows((rows) => [
        ...rows,
        {
          assetId: String(payload.id),
          code: String(payload.code),
          name: String(payload.name),
          departmentCode: String(payload.departmentCode || ""),
          // Sổ sách 0: hồ sơ vừa tạo có số lượng = số đếm, nhưng phiên kiểm phải ghi rõ đây là
          // phát hiện thừa so với sổ trước kiểm. API bỏ qua khoá lạc quan khi systemQuantity không gửi.
          systemQuantity: 0,
          actualQuantity: String(Number(newAsset.quantity) || 1),
          condition: newAsset.condition,
          note: "Phát hiện khi kiểm kê",
          imageUrl: newAsset.imageUrl,
          lots: [{ id: String(payload.id), lotNo: 1, quantity: 0 }],
          isNew: true,
        },
      ]);
      setMessage(`Đã cấp mã ${payload.code} cho "${payload.name}" và thêm vào phiên kiểm kê. Nhớ bấm Duyệt kiểm kê để chốt.`);
      setNewAsset({ ...emptyNewAsset, departmentCode: newAsset.departmentCode });
      setShowNewAsset(false);
      // Nạp lại danh sách để các tab khác thấy tài sản mới; dòng kiểm kê đang soạn giữ nguyên.
      await loadData();
    } catch {
      setMessage("Lỗi kết nối máy chủ khi tạo mã tài sản.");
    } finally {
      setCreatingAsset(false);
    }
  };

  const openStocktakeImage = async (lineId: string) => {
    const response = await fetch(`/api/assets/operations?stocktakeLineImage=${encodeURIComponent(lineId)}`, { headers: getSessionHeaders() });
    const payload = await response.json();
    if (!response.ok || !payload.imageUrl) {
      setMessage(payload.error || "Dòng kiểm kê này không có ảnh.");
      return;
    }
    setImageViewer(String(payload.imageUrl));
  };

  useEffect(() => {
    if (!loading) window.setTimeout(() => { void loadData(); void loadMasterData(); }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // User bị giới hạn bộ phận: mặc định chọn sẵn phòng ban đầu tiên trong phạm vi (không có lựa chọn "Tất cả").
  useEffect(() => {
    if (scopedDepartments && !stocktakeDepartment && stocktakeDepartmentOptions.length > 0) {
      window.setTimeout(() => setStocktakeDepartment(stocktakeDepartmentOptions[0].code), 0);
    }
  }, [scopedDepartments, stocktakeDepartment, stocktakeDepartmentOptions]);

  const send = async (body: object, success: string | ((payload: Record<string, unknown>) => string)) => {
    const response = await fetch("/api/assets/operations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getSessionHeaders(),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    setMessage(response.ok ? (typeof success === "function" ? success(payload) : success) : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
  };

  // Mở lại kỳ đã chạy để chạy lại sau khi sửa cấu hình khấu hao. Xoá số đã ghi nên luôn hỏi lại,
  // và nói thẳng là bút toán trên sổ cái cũng mất theo.
  const reopenDepreciation = (targetPeriod: string, asset?: Asset) => {
    const scope = asset ? `${asset.code} - ${asset.name}` : "tất cả tài sản";
    if (!window.confirm(`Mở lại khấu hao kỳ ${targetPeriod} của ${scope}? Số đã chạy và bút toán khấu hao của kỳ này sẽ bị xoá khỏi sổ cái, giá trị còn lại của tài sản được cộng trả về như trước khi chạy.`)) return;
    void send(
      { action: "REOPEN_DEPRECIATION", period: targetPeriod, branchCode: "ALL", ...(asset ? { assetId: asset.id } : {}) },
      (payload) => `Đã mở lại ${payload.reopened ?? 0} dòng khấu hao kỳ ${targetPeriod} (${money(Number(payload.totalAmount || 0))} đ). Sửa cấu hình rồi chạy lại kỳ này.`,
    );
  };

  const depreciationYears = useMemo(() => {
    const years = new Set<string>();
    data.depreciations.forEach((row) => {
      if (row.period && row.period.length >= 4) years.add(row.period.slice(0, 4));
    });
    years.add(new Date().toISOString().slice(0, 4));
    return [...years].sort((a, b) => b.localeCompare(a));
  }, [data.depreciations]);

  // Năm đang chọn có thể biến mất sau khi tải lại dữ liệu, khi đó rơi về năm mới nhất còn số liệu.
  const activeDepreciationYear = depreciationYears.includes(depreciationYear) ? depreciationYear : depreciationYears[0];

  // Mỗi tài sản một dòng: 12 cột là số khấu hao từng tháng của năm đang chọn, lũy kế và
  // giá trị còn lại lấy theo kỳ gần nhất mà tài sản đó đã chạy trong năm.
  const depreciationMatrix = useMemo(() => {
    const rows = new Map<string, { asset: Asset; months: number[]; total: number; accumulated: number; remaining: number; lastPeriod: string }>();
    data.depreciations.forEach((row) => {
      if (!row.period?.startsWith(activeDepreciationYear)) return;
      const monthIndex = Number(row.period.slice(5, 7)) - 1;
      if (!(monthIndex >= 0 && monthIndex <= 11)) return;
      const entry = rows.get(row.asset.id) || { asset: row.asset, months: Array(12).fill(0) as number[], total: 0, accumulated: 0, remaining: 0, lastPeriod: "" };
      entry.months[monthIndex] += row.depreciationAmount || 0;
      entry.total += row.depreciationAmount || 0;
      if (row.period >= entry.lastPeriod) {
        entry.lastPeriod = row.period;
        entry.accumulated = row.accumulatedDepreciation;
        entry.remaining = row.remainingValue;
        entry.asset = row.asset;
      }
      rows.set(row.asset.id, entry);
    });
    return [...rows.values()].sort((a, b) => a.asset.code.localeCompare(b.asset.code, "vi"));
  }, [data.depreciations, activeDepreciationYear]);

  const depreciationTotals = useMemo(() => {
    const months = Array(12).fill(0) as number[];
    let total = 0;
    depreciationMatrix.forEach((row) => {
      row.months.forEach((amount, index) => { months[index] += amount; });
      total += row.total;
    });
    return { months, total };
  }, [depreciationMatrix]);

  const getTreatmentLabel = (treatment?: string | null, cost?: number | null) => {
    if (!treatment) return "-";
    const amountStr = cost ? ` (${money(cost)} đ)` : "";
    switch (treatment) {
      case "EXPENSE":
        return <span className="status bg-blue-50 text-blue-800">Chi phí ngay{amountStr}</span>;
      case "DEBT":
        return <span className="status bg-purple-50 text-purple-800">Ghi nợ NCC{amountStr}</span>;
      case "ALLOCATE":
        return <span className="status bg-amber-50 text-amber-800">Phân bổ nhiều kỳ{amountStr}</span>;
      case "CAPITALIZE":
        return <span className="status bg-emerald-50 text-emerald-800">Tăng nguyên giá{amountStr}</span>;
      default:
        return <span>{treatment}{amountStr}</span>;
    }
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame
      title="Vận hành tài sản"
      subtitle="Khấu hao, bảo trì cố định, sửa chữa phát sinh và thanh lý tài sản"
      role={user?.role}
      // Chỉ hiện nút quay lại khi người dùng mở được màn Tài sản; vai trò chỉ kiểm kê thì không có chỗ để về.
      backHref={user && canOpenPath(user, "/assets") ? "/assets" : undefined}
      backLabel="Tài sản"
    >
      <ModuleTabs
        active={active}
        onChange={setActive}
        tabs={visibleTabs}
      />

      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}
      {data.assets.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-4 text-sm">
          Cần tạo hồ sơ tài sản ở màn hình Tài sản trước khi chạy nghiệp vụ.
        </div>
      )}

      {active === "stocktake" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {canCreate && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({
                  action: "APPROVE_ASSET_STOCKTAKE",
                  branchCode: stocktakeBranch,
                  departmentCode: stocktakeDepartment,
                  stocktakeDate,
                  note: stocktakeNote,
                  lines: stocktakeLinesForSubmit(),
                }, "Đã duyệt kiểm kê và cập nhật số lượng sổ sách theo số đếm.");
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit shadow-sm"
            >
              <h2 className="font-bold text-slate-800">Kiểm kê CCDC & Tài sản</h2>
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                Duyệt xong hệ thống lấy SỐ ĐẾM làm số sổ sách. Hàng tồn kho kiểm ở Kho & Định lượng.
                {scopedDepartments && <> Bạn đang kiểm trong phạm vi bộ phận: <b>{scopedDepartments.join(", ")}</b>.</>}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cửa hàng">
                  <select
                    className="control"
                    value={stocktakeBranch}
                    onChange={(e) => {
                      const branchCode = e.target.value;
                      setStocktakeBranch(branchCode);
                      setStocktakeRows(buildStocktakeRows(branchCode, stocktakeDepartment));
                    }}
                  >
                    <option value="">Chọn cửa hàng</option>
                    {[...new Set(data.assets.map((asset) => asset.branchCode))].map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                  </select>
                </Field>
                <Field label="Ngày kiểm kê">
                  <DateInput className="mt-1.5" value={stocktakeDate} onChange={setStocktakeDate} ariaLabel="Ngày kiểm kê tài sản" />
                </Field>
                <Field label={scopedDepartments ? "Phòng ban / Bộ phận *" : "Phòng ban / Bộ phận"}>
                  <select
                    className="control"
                    value={stocktakeDepartment}
                    required={Boolean(scopedDepartments)}
                    onChange={(e) => {
                      const departmentCode = e.target.value;
                      setStocktakeDepartment(departmentCode);
                      setStocktakeRows(buildStocktakeRows(stocktakeBranch, departmentCode));
                    }}
                  >
                    {!scopedDepartments && <option value="">Tất cả phòng ban</option>}
                    {stocktakeDepartmentOptions.map((department) => (
                      <option key={department.code} value={department.code}>{department.name} ({department.code})</option>
                    ))}
                  </select>
                </Field>
                <Field label="Ghi chú phiên kiểm kê">
                  <input className="control" value={stocktakeNote} onChange={(e) => setStocktakeNote(e.target.value)} />
                </Field>
              </div>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                    <tr><th className="px-3 py-2">Tài sản</th><th className="px-3 py-2 text-right">Sổ sách</th><th className="px-3 py-2 text-right">Số đếm</th><th className="px-3 py-2">Tình trạng</th><th className="px-3 py-2">Ảnh</th></tr>
                  </thead>
                  <tbody>
                    {stocktakeRows.length === 0 && (
                      <tr><td className="px-3 py-4 text-slate-500" colSpan={5}>{stocktakeBranch ? "Không có CCDC/tài sản nào trong phạm vi đã chọn." : "Chọn cửa hàng để nạp danh sách CCDC/tài sản."}</td></tr>
                    )}
                    {stocktakeRows.map((row, index) => {
                      const variance = Number(row.actualQuantity || 0) - row.systemQuantity;
                      const updateRow = (patch: Partial<StocktakeDraftRow>) => setStocktakeRows((rows) => rows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, ...patch } : candidate));
                      return (
                        <tr key={row.assetId} className={`border-t border-slate-100 ${row.isNew ? "bg-emerald-50/60" : ""}`}>
                          <td className="px-3 py-2">
                            <b>{row.code}</b>
                            {row.isNew && <span className="ml-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">MỚI</span>}
                            {row.lots.length > 1 && <span className="ml-1 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700" title="Đếm chung cho cả mã; thừa ghi vào đợt mới nhất, thiếu trừ từ đợt mới nhất">{row.lots.length} đợt</span>}
                            <small className="block text-slate-500">{row.name}{row.departmentCode ? ` · ${row.departmentCode}` : ""}</small>
                          </td>
                          <td className="px-3 py-2 text-right">{money(row.systemQuantity)}</td>
                          <td className="px-3 py-2 text-right">
                            <input type="number" min="0" step="1" className="control text-right w-24 inline-block" value={row.actualQuantity}
                              onChange={(e) => updateRow({ actualQuantity: e.target.value })} />
                            {variance !== 0 && <small className={variance > 0 ? "block text-emerald-700 font-bold" : "block text-rose-700 font-bold"}>{variance > 0 ? "+" : ""}{money(variance)}</small>}
                          </td>
                          <td className="px-3 py-2">
                            <input className="control" placeholder="Tốt / Hỏng nhẹ..." value={row.condition}
                              onChange={(e) => updateRow({ condition: e.target.value })} />
                          </td>
                          <td className="px-3 py-2">
                            <StocktakeImageInput
                              value={row.imageUrl}
                              onChange={(imageUrl) => updateRow({ imageUrl })}
                              onError={(text) => setMessage(text)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Tài sản phát hiện lúc kiểm mà chưa có mã: tạo hồ sơ ngay tại đây, không phải rời màn kiểm kê. */}
              {stocktakeBranch && (
                <div className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50/40 p-3">
                  {!showNewAsset ? (
                    <button type="button" className="text-sm font-bold text-emerald-700 hover:underline" onClick={() => setShowNewAsset(true)}>
                      + Tài sản/CCDC chưa có trong danh sách (tạo mã mới)
                    </button>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-emerald-800">Tài sản phát hiện khi kiểm kê</h3>
                        <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setShowNewAsset(false)}>Đóng</button>
                      </div>
                      <p className="text-[11px] text-slate-600">Hệ thống tự cấp mã theo nhóm + phòng ban, nguyên giá tạm 0 đ — kế toán bổ sung giá/NCC sau ở màn Tài sản. Dòng kiểm kê sẽ ghi sổ sách 0, số đếm = số thực tế.</p>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Tên tài sản / CCDC *">
                          <input className="control" value={newAsset.name} onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })} placeholder="VD: Nồi inox 30cm" />
                        </Field>
                        <Field label="Nhóm tài sản *">
                          <select className="control" value={newAsset.assetGroup} onChange={(e) => setNewAsset({ ...newAsset, assetGroup: e.target.value })}>
                            <option value="">Chọn nhóm</option>
                            {assetGroups.map((group) => <option key={group.code} value={group.code}>{group.name} ({group.code})</option>)}
                          </select>
                        </Field>
                        <Field label="Phòng ban *">
                          <select className="control" value={newAsset.departmentCode} onChange={(e) => setNewAsset({ ...newAsset, departmentCode: e.target.value })}>
                            <option value="">Chọn phòng ban</option>
                            {stocktakeDepartmentOptions.map((department) => <option key={department.code} value={department.code}>{department.name} ({department.code})</option>)}
                          </select>
                        </Field>
                        <Field label="Vị trí / Kho">
                          <select className="control" value={newAsset.warehouseCode} onChange={(e) => setNewAsset({ ...newAsset, warehouseCode: e.target.value })}>
                            <option value="">Không chọn</option>
                            {warehouses.filter((warehouse) => !warehouse.branch || warehouse.branch === "ALL" || warehouse.branch === stocktakeBranch).map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name} ({warehouse.code})</option>)}
                          </select>
                        </Field>
                        <Field label="Số đếm *">
                          <input type="number" min="1" step="1" className="control" value={newAsset.quantity} onChange={(e) => setNewAsset({ ...newAsset, quantity: e.target.value })} />
                        </Field>
                        <Field label="Tình trạng">
                          <input className="control" value={newAsset.condition} onChange={(e) => setNewAsset({ ...newAsset, condition: e.target.value })} placeholder="Tốt / Hỏng nhẹ..." />
                        </Field>
                        <Field label="Ảnh">
                          <div className="mt-1.5">
                            <StocktakeImageInput value={newAsset.imageUrl} onChange={(imageUrl) => setNewAsset({ ...newAsset, imageUrl })} onError={(text) => setMessage(text)} />
                          </div>
                        </Field>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={creatingAsset || !newAsset.name.trim() || !newAsset.assetGroup || !newAsset.departmentCode || Number(newAsset.quantity) <= 0}
                          onClick={() => void createStocktakeAsset()}
                        >
                          {creatingAsset ? "Đang tạo mã..." : "Tạo mã & thêm vào phiên"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <a className="text-sm font-bold text-blue-700" href="/imports?tab=asset-stocktake">Hoặc import file kiểm kê Excel</a>
                <button className="primary-button" disabled={!stocktakeBranch || stocktakeRows.length === 0}>Duyệt kiểm kê</button>
              </div>
            </form>
          )}
          <section className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden h-fit">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3"><h2 className="font-bold">Phiên kiểm kê gần nhất</h2><ExportExcelButton fileName="phien_kiem_ke_tai_san" sheetName="Kiem ke" /></div>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr><th className="px-3 py-2">Phiên</th><th className="px-3 py-2">Cửa hàng</th><th className="px-3 py-2">Bộ phận</th><th className="px-3 py-2 text-right">Dòng</th><th className="px-3 py-2 text-right">Chênh lệch</th><th className="px-3 py-2 text-right"></th></tr>
              </thead>
              <tbody>
                {data.assetStocktakes.length === 0 && (
                  <tr><td className="px-3 py-4 text-slate-500" colSpan={6}>Chưa có phiên kiểm kê nào.</td></tr>
                )}
                {data.assetStocktakes.map((session) => (
                  <Fragment key={session.id}>
                    <tr className="border-t border-slate-100">
                      <td className="px-3 py-2"><CopyableText value={session.code}><b>{session.code}</b></CopyableText><small className="block text-slate-500">{new Date(session.stocktakeDate).toLocaleDateString("vi-VN")} · {session.approvedBy || "-"}</small></td>
                      <td className="px-3 py-2">{session.branchCode}</td>
                      <td className="px-3 py-2">{session.departmentCode
                        ? (departments.find((department) => department.code === session.departmentCode)?.name || session.departmentCode)
                        : <span className="text-slate-400">Cả cửa hàng</span>}</td>
                      <td className="px-3 py-2 text-right">{session.lines.length}</td>
                      <td className="px-3 py-2 text-right">
                        <b className={session.lines.some((line) => line.varianceQuantity !== 0) ? "text-rose-700" : "text-slate-400"}>
                          {money(session.lines.reduce((sum, line) => sum + Math.abs(line.varianceQuantity), 0))}
                        </b>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setExpandedStocktake((current) => current === session.id ? "" : session.id)}
                          className="text-xs font-bold text-blue-700 hover:underline mr-3"
                        >
                          {expandedStocktake === session.id ? "Thu gọn" : "Chi tiết"}
                        </button>
                        {canEdit && session.status === "APPROVED" && (
                          <button
                            type="button"
                            onClick={() => {
                              if (!window.confirm(`Mở lại phiên kiểm kê ${session.code}? Số lượng của ${session.lines.length} tài sản trong phiên sẽ quay về đúng số sổ sách trước lúc duyệt.`)) return;
                              void send({ action: "REOPEN_ASSET_STOCKTAKE", sessionId: session.id }, `Đã mở lại phiên ${session.code} và trả số lượng tài sản về như trước khi duyệt. Kiểm lại rồi duyệt phiên mới.`);
                            }}
                            className="text-xs font-bold text-slate-400 hover:text-rose-600 hover:underline whitespace-nowrap"
                            title="Trả số lượng tài sản về số sổ sách trước lúc duyệt và đưa phiên về Nháp"
                          >
                            Mở lại
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedStocktake === session.id && (
                      <tr className="border-t border-slate-100 bg-slate-50/60">
                        <td colSpan={6} className="px-3 py-2">
                          {session.note && <p className="mb-2 text-xs text-slate-600">Ghi chú: {session.note}</p>}
                          <table className="w-full text-xs">
                            <thead className="text-slate-500 uppercase">
                              <tr><th className="py-1 text-left">Tài sản</th><th className="py-1 text-right">Sổ sách</th><th className="py-1 text-right">Đếm</th><th className="py-1 text-right">Chênh</th><th className="py-1 text-left pl-3">Tình trạng</th><th className="py-1 text-right">Ảnh</th></tr>
                            </thead>
                            <tbody>
                              {session.lines.map((line) => (
                                <tr key={line.id} className="border-t border-slate-200/70">
                                  <td className="py-1"><b>{assetLotLabel(line.asset)}</b> <span className="text-slate-500">{line.asset.name}</span></td>
                                  <td className="py-1 text-right">{money(line.systemQuantity)}</td>
                                  <td className="py-1 text-right">{money(line.actualQuantity)}</td>
                                  <td className={`py-1 text-right font-bold ${line.varianceQuantity > 0 ? "text-emerald-700" : line.varianceQuantity < 0 ? "text-rose-700" : "text-slate-400"}`}>{line.varianceQuantity > 0 ? "+" : ""}{money(line.varianceQuantity)}</td>
                                  <td className="py-1 pl-3">{line.condition || "-"}{line.note ? <span className="text-slate-400"> · {line.note}</span> : null}</td>
                                  <td className="py-1 text-right">
                                    {line.hasImage
                                      ? <button type="button" className="text-blue-700 font-bold hover:underline" onClick={() => void openStocktakeImage(line.id)}>Xem ảnh</button>
                                      : <span className="text-slate-300">-</span>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </section>
          {imageViewer && (
            <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/70 p-4" onClick={() => setImageViewer("")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imageViewer} alt="Ảnh kiểm kê" className="max-h-[90vh] max-w-full rounded-lg shadow-2xl" />
            </div>
          )}
        </div>
      )}

      {active === "depreciation" && (
        <div className="space-y-5">
          <div className="grid lg:grid-cols-2 gap-5">
            {canEdit && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "CONFIGURE_DEPRECIATION", assetId, ...config }, "Đã cập nhật cấu hình khấu hao.");
                }}
                className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
              >
                <h2 className="font-bold">Cấu hình tài sản</h2>
                <AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} />
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Số tháng">
                    <input type="number" className="control" value={config.usefulLifeMonths} onChange={(e) => setConfig({ ...config, usefulLifeMonths: e.target.value })} />
                  </Field>
                  <Field label="Bắt đầu">
                    <DateInput className="mt-1.5" value={config.depreciationStartDate} onChange={(depreciationStartDate) => setConfig({ ...config, depreciationStartDate })} ariaLabel="Ngày bắt đầu khấu hao" />
                  </Field>
                  <Field label="Giá trị còn lại">
                    <input type="number" className="control" value={config.residualValue} onChange={(e) => setConfig({ ...config, residualValue: e.target.value })} />
                  </Field>
                </div>
                <button className="secondary-button w-full">Lưu cấu hình</button>
              </form>
            )}

            {canEdit && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "RUN_DEPRECIATION", period, branchCode: "ALL" }, "Đã chạy khấu hao cho các tài sản hợp lệ.");
                }}
                className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
              >
                <h2 className="font-bold">Chạy khấu hao tháng</h2>
                <Field label="Kỳ kế toán">
                  <MonthInput className="mt-1.5" value={period} onChange={setPeriod} ariaLabel="Kỳ khấu hao" />
                </Field>
                <p className="text-xs text-slate-500">Hệ thống bỏ qua tài sản đã chạy trong kỳ và không khấu hao thấp hơn giá trị còn lại.</p>
                <button className="primary-button w-full"><span className="material-symbols-outlined text-lg">play_arrow</span>Chạy khấu hao</button>
                <button
                  type="button"
                  onClick={() => reopenDepreciation(period)}
                  className="secondary-button w-full"
                  title="Xoá số khấu hao đã chạy của kỳ này để chạy lại sau khi sửa cấu hình"
                >
                  <span className="material-symbols-outlined text-lg">lock_open</span>Mở lại kỳ để chạy lại
                </button>
                <p className="text-xs text-slate-500">Chạy sai số thì mở lại kỳ, sửa cấu hình tài sản rồi chạy lại. Mỗi tài sản chỉ mở được kỳ sau cùng đã chạy, nên đã chạy nhiều tháng thì lùi dần từ tháng mới nhất.</p>
              </form>
            )}
          </div>

          <section className="table-panel">
            <Panel title="Lịch sử khấu hao" reload={loadData} exportFileName="lich_su_khau_hao">
              <select
                className="control h-8 w-32 text-xs py-0"
                value={activeDepreciationYear}
                onChange={(e) => setDepreciationYear(e.target.value)}
                aria-label="Năm khấu hao"
                data-no-export
              >
                {depreciationYears.map((year) => (
                  <option key={year} value={year}>Năm {year}</option>
                ))}
              </select>
            </Panel>
            <Table
              headers={[
                { label: "Tài sản", sticky: true },
                ...MONTH_HEADERS,
                { label: "Cộng năm", align: "right" as const },
                { label: "Lũy kế", align: "right" as const },
                { label: "Còn lại", align: "right" as const },
              ]}
            >
              {depreciationMatrix.map((row) => (
                <tr key={row.asset.id} className="border-t border-slate-100">
                  <Cell sticky><b><CopyableText value={row.asset.code}>{assetLotLabel(row.asset)}</CopyableText> - {row.asset.name}</b></Cell>
                  {row.months.map((amount, index) => (
                    <Cell key={index} right className={`whitespace-nowrap ${amount ? "" : "text-slate-300"}`}>
                      {amount ? (
                        canEdit ? (
                          <button
                            type="button"
                            onClick={() => reopenDepreciation(`${activeDepreciationYear}-${String(index + 1).padStart(2, "0")}`, row.asset)}
                            className="underline decoration-dotted underline-offset-4 hover:text-rose-600"
                            title={`Mở lại khấu hao T${index + 1}/${activeDepreciationYear} của ${row.asset.code} để chạy lại`}
                          >
                            {money(amount)}
                          </button>
                        ) : money(amount)
                      ) : "—"}
                    </Cell>
                  ))}
                  <Cell right className="whitespace-nowrap"><b>{money(row.total)}</b></Cell>
                  <Cell right className="whitespace-nowrap">{money(row.accumulated)}</Cell>
                  <Cell right className="whitespace-nowrap"><b>{money(row.remaining)}</b></Cell>
                </tr>
              ))}
              {depreciationMatrix.length > 0 && (
                <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                  <Cell sticky className="!bg-slate-50">Tổng cộng</Cell>
                  {depreciationTotals.months.map((amount, index) => (
                    <Cell key={index} right className={`whitespace-nowrap ${amount ? "" : "text-slate-300"}`}>
                      {amount ? money(amount) : "—"}
                    </Cell>
                  ))}
                  <Cell right className="whitespace-nowrap">{money(depreciationTotals.total)}</Cell>
                  <Cell right>—</Cell>
                  <Cell right>—</Cell>
                </tr>
              )}
              {depreciationMatrix.length === 0 && (
                <tr className="border-t border-slate-100">
                  <td colSpan={16} className="px-4 py-6 text-center text-slate-500">Năm {activeDepreciationYear} chưa chạy khấu hao cho tài sản nào.</td>
                </tr>
              )}
            </Table>
            <p className="px-5 py-3 text-xs text-slate-500">
              Số liệu tính bằng đồng. Lũy kế và Còn lại lấy theo kỳ gần nhất tài sản đã chạy trong năm {activeDepreciationYear}.
              {canEdit && " Bấm vào số của một tháng để mở lại đúng tháng đó của riêng tài sản trên dòng."}
            </p>
          </section>
        </div>
      )}

      {active === "maintenance" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "SCHEDULE_MAINTENANCE", assetId, ...maintenance }, maintenance.recurrenceRule === "NONE" ? "Đã tạo lịch bảo trì." : "Đã tạo chuỗi lịch bảo trì cố định và công việc liên quan.");
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
            >
              <h2 className="font-bold">Lập lịch bảo trì cố định</h2>
              <AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} />
              <Field label="Nội dung">
                <input className="control" value={maintenance.maintenanceType} onChange={(e) => setMaintenance({ ...maintenance, maintenanceType: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ngày dự kiến">
                  <DateInput className="mt-1.5" value={maintenance.scheduledDate} onChange={(scheduledDate) => setMaintenance({ ...maintenance, scheduledDate })} ariaLabel="Ngày bảo trì dự kiến" />
                </Field>
                <Field label="Chi phí dự kiến">
                  <input type="number" className="control" value={maintenance.cost} onChange={(e) => setMaintenance({ ...maintenance, cost: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Kiểu lặp">
                  <select className="control" value={maintenance.recurrenceRule} onChange={(e) => setMaintenance({ ...maintenance, recurrenceRule: e.target.value })}>
                    <option value="NONE">Một lần</option>
                    <option value="MONTHLY">Hàng tháng</option>
                    <option value="QUARTERLY">Hàng quý</option>
                    <option value="YEARLY">Hàng năm</option>
                  </select>
                </Field>
                <Field label="Mỗi">
                  <input type="number" min="1" className="control" value={maintenance.recurrenceInterval} onChange={(e) => setMaintenance({ ...maintenance, recurrenceInterval: e.target.value })} />
                </Field>
                <Field label="Lặp đến">
                  <DateInput className="mt-1.5" value={maintenance.recurrenceEndDate} onChange={(recurrenceEndDate) => setMaintenance({ ...maintenance, recurrenceEndDate })} ariaLabel="Ngày kết thúc lặp bảo trì" />
                </Field>
              </div>
              <Field label="Nhà cung cấp">
                <input className="control" value={maintenance.supplierName} onChange={(e) => setMaintenance({ ...maintenance, supplierName: e.target.value })} />
              </Field>
              <Field label="Người phụ trách công việc">
                <input className="control" value={maintenance.assigneeName} onChange={(e) => setMaintenance({ ...maintenance, assigneeName: e.target.value })} placeholder="Trống = người đang đăng nhập" />
              </Field>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={maintenance.createWorkTask} onChange={(e) => setMaintenance({ ...maintenance, createWorkTask: e.target.checked })} />
                Tự tạo công việc vận hành cho lịch bảo trì
              </label>
              <button className="primary-button w-full">Tạo lịch</button>
            </form>
          )}

          <section className="table-panel">
            <Panel title="Lịch bảo trì" reload={loadData} exportFileName="lich_bao_tri" />
            <Table headers={[{ label: "Tài sản" }, { label: "Nội dung" }, { label: "Ngày dự kiến" }, { label: "Lặp" }, { label: "Task" }, { label: "Chi phí", align: "right" }, { label: "Trạng thái" }, { label: "Thao tác", align: "right" }]}>
              {data.maintenances.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <Cell><CopyableText value={row.asset.code}><b>{row.asset.code}</b></CopyableText><small>{row.asset.name}</small></Cell>
                  <Cell>{row.maintenanceType}</Cell>
                  <Cell>{new Date(row.scheduledDate).toLocaleDateString("vi-VN")}</Cell>
                  <Cell>{row.recurrenceRule || "-"}</Cell>
                  <Cell>{row.linkedWorkItemId ? <span className="status bg-blue-50 text-blue-700">Đã tạo</span> : "-"}</Cell>
                  <Cell right>{money(row.cost)} đ</Cell>
                  <Cell><span className="status bg-slate-100">{row.status}</span></Cell>
                  <Cell right>
                    {canEdit && row.status === "SCHEDULED" && (
                      <button className="action-link text-emerald-700" onClick={() => void send({ action: "COMPLETE_MAINTENANCE", id: row.id, completedDate: new Date().toISOString(), cost: row.cost }, "Đã hoàn thành bảo trì và đóng công việc liên quan.")}>
                        Hoàn thành
                      </button>
                    )}
                    {canEdit && row.status === "COMPLETED" && (
                      <button
                        className="action-link text-slate-400 hover:text-rose-600"
                        title="Đưa lịch bảo trì về Chờ làm và mở lại công việc liên quan"
                        onClick={() => {
                          if (!window.confirm(`Mở lại lịch bảo trì ${row.maintenanceType} của ${row.asset.code}? Lịch quay về Chờ làm và công việc liên quan mở lại.`)) return;
                          void send({ action: "REOPEN_MAINTENANCE", id: row.id }, "Đã mở lại lịch bảo trì. Sửa chi phí rồi bấm Hoàn thành lại.");
                        }}
                      >
                        Mở lại
                      </button>
                    )}
                  </Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {active === "damage" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canCreate && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "REPORT_DAMAGE", assetId, ...damage }, "Đã gửi báo hỏng và tạo công việc sửa chữa.");
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
            >
              <h2 className="font-bold">Sửa chữa phát sinh</h2>
              <AssetSelect assets={data.assets} value={assetId} onChange={setAssetId} />
              <Field label="Mức độ">
                <select className="control" value={damage.severity} onChange={(e) => setDamage({ ...damage, severity: e.target.value })}>
                  <option value="LOW">Thấp</option>
                  <option value="MEDIUM">Trung bình</option>
                  <option value="HIGH">Nghiêm trọng</option>
                </select>
              </Field>
              <Field label="Mô tả">
                <textarea className="control h-24 resize-none" value={damage.description} onChange={(e) => setDamage({ ...damage, description: e.target.value })} required />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Người phụ trách">
                  <input className="control" value={damage.assigneeName} onChange={(e) => setDamage({ ...damage, assigneeName: e.target.value })} placeholder="Trống = người đăng nhập" />
                </Field>
                <Field label="Hạn xử lý">
                  <DateInput className="mt-1.5" value={damage.dueDate} onChange={(dueDate) => setDamage({ ...damage, dueDate })} ariaLabel="Hạn xử lý sửa chữa" />
                </Field>
              </div>
              <button className="primary-button w-full">Gửi báo hỏng</button>
            </form>
          )}

          <div className="space-y-4">
            {resolveDamage.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "RESOLVE_DAMAGE", ...resolveDamage, resolvedAt: new Date().toISOString() }, resolveDamage.repairTreatment === "EXPENSE" ? "Đã xử lý và tạo phiếu chi chờ duyệt." : resolveDamage.repairTreatment === "DEBT" ? "Đã ghi nhận công nợ nhà cung cấp." : "Đã hoàn tất xử lý báo hỏng.");
                  setResolveDamage({ id: "", repairCost: "1000000", repairTreatment: "EXPENSE", numberOfPeriods: "6", moneySourceCode: "", categoryCode: "REPAIR", supplierName: "", supplierCode: "", dueDate: "", note: "" });
                }}
                className="bg-blue-50 border border-blue-100 rounded-lg p-4 grid md:grid-cols-3 gap-3 items-end"
              >
                <Field label="Cách xử lý">
                  <select className="control" value={resolveDamage.repairTreatment} onChange={(e) => setResolveDamage({ ...resolveDamage, repairTreatment: e.target.value })}>
                    <option value="EXPENSE">Chi phí ngay (Tạo phiếu chi)</option>
                    <option value="DEBT">Ghi nợ NCC (Công nợ trả)</option>
                    <option value="ALLOCATE">Phân bổ nhiều kỳ</option>
                    <option value="CAPITALIZE">Tăng nguyên giá tài sản</option>
                  </select>
                </Field>
                <Field label="Chi phí sửa chữa (đ)">
                  <input type="number" className="control" value={resolveDamage.repairCost} onChange={(e) => setResolveDamage({ ...resolveDamage, repairCost: e.target.value })} required />
                </Field>
                {resolveDamage.repairTreatment === "ALLOCATE" && (
                  <Field label="Số kỳ phân bổ">
                    <input type="number" min="2" className="control" value={resolveDamage.numberOfPeriods} onChange={(e) => setResolveDamage({ ...resolveDamage, numberOfPeriods: e.target.value })} />
                  </Field>
                )}
                {resolveDamage.repairTreatment === "EXPENSE" && (
                  <Field label="Nguồn tiền">
                    <input className="control" value={resolveDamage.moneySourceCode} onChange={(e) => setResolveDamage({ ...resolveDamage, moneySourceCode: e.target.value })} placeholder="Trống = tự chọn" />
                  </Field>
                )}
                {(resolveDamage.repairTreatment === "DEBT" || resolveDamage.repairTreatment === "EXPENSE") && (
                  <Field label="Nhà cung cấp sửa chữa">
                    <input className="control" value={resolveDamage.supplierName} onChange={(e) => setResolveDamage({ ...resolveDamage, supplierName: e.target.value })} />
                  </Field>
                )}
                {resolveDamage.repairTreatment === "DEBT" && (
                  <>
                    <Field label="Mã NCC">
                      <input className="control" value={resolveDamage.supplierCode} onChange={(e) => setResolveDamage({ ...resolveDamage, supplierCode: e.target.value })} />
                    </Field>
                    <Field label="Hạn thanh toán">
                      <DateInput className="mt-1.5" value={resolveDamage.dueDate} onChange={(dueDate) => setResolveDamage({ ...resolveDamage, dueDate })} ariaLabel="Hạn thanh toán công nợ" />
                    </Field>
                  </>
                )}
                <Field label="Nhóm chi phí">
                  <input className="control" value={resolveDamage.categoryCode} onChange={(e) => setResolveDamage({ ...resolveDamage, categoryCode: e.target.value })} />
                </Field>
                <div className="flex gap-2">
                  <button className="primary-button flex-1">Lưu xử lý</button>
                  <button type="button" onClick={() => setResolveDamage({ id: "", repairCost: "1000000", repairTreatment: "EXPENSE", numberOfPeriods: "6", moneySourceCode: "", categoryCode: "REPAIR", supplierName: "", supplierCode: "", dueDate: "", note: "" })} className="secondary-button">Hủy</button>
                </div>
              </form>
            )}

            <section className="table-panel">
              <Panel title="Phiếu báo hỏng & sửa chữa" reload={loadData} exportFileName="phieu_bao_hong_sua_chua" />
              <Table headers={[{ label: "Phiếu" }, { label: "Tài sản" }, { label: "Mức độ" }, { label: "Mô tả" }, { label: "Task" }, { label: "Xử lý" }, { label: "Thao tác", align: "right" }]}>
                {data.damageReports.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small>{row.status}</small></Cell>
                    <Cell><CopyableText value={row.asset.code} /> - {row.asset.name}</Cell>
                    <Cell><span className="status bg-amber-50 text-amber-700">{row.severity}</span></Cell>
                    <Cell>{row.description}</Cell>
                    <Cell>{row.linkedWorkItemId ? <span className="status bg-blue-50 text-blue-700">Đã tạo</span> : "-"}</Cell>
                    <Cell>{getTreatmentLabel(row.repairTreatment, row.repairCost)}</Cell>
                    <Cell right>
                      {canEdit && row.status !== "COMPLETED" && (
                        <button className="action-link text-blue-700" onClick={() => setResolveDamage({ ...resolveDamage, id: row.id, supplierName: row.asset.supplierName || "" })}>Xử lý</button>
                      )}
                      {canEdit && row.status === "COMPLETED" && (
                        <button
                          className="action-link text-slate-400 hover:text-rose-600"
                          title="Gỡ chứng từ mà lần xử lý đã sinh ra và đưa báo hỏng về Chờ xử lý"
                          onClick={() => {
                            if (!window.confirm(`Mở lại báo hỏng ${row.code}? Chứng từ mà lần xử lý đã sinh ra (phiếu chi, công nợ, phiếu phân bổ hoặc phần tăng nguyên giá) sẽ bị gỡ bỏ.`)) return;
                            void send({ action: "REOPEN_DAMAGE", id: row.id }, `Đã mở lại báo hỏng ${row.code}. Chọn lại cách xử lý rồi lưu.`);
                          }}
                        >
                          Mở lại
                        </button>
                      )}
                    </Cell>
                  </tr>
                ))}
              </Table>
            </section>
          </div>
        </div>
      )}

      {active === "disposal" && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-5">
          {canEdit && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ action: "DISPOSE_ASSET", ...disposalForm }, "Đã thực hiện thanh lý tài sản thành công.");
                setDisposalForm({ assetId: "", disposalDate: new Date().toISOString().slice(0, 10), disposalAmount: "0", moneySourceCode: "", disposalNote: "" });
              }}
              className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit"
            >
              <h2 className="font-bold text-rose-700 flex items-center gap-2">
                <span className="material-symbols-outlined">delete_sweep</span>
                Thực hiện thanh lý tài sản
              </h2>
              <AssetSelect assets={data.assets.filter((a) => a.status !== "DISPOSED")} value={disposalForm.assetId} onChange={(assetIdValue) => setDisposalForm({ ...disposalForm, assetId: assetIdValue })} />
              <Field label="Ngày thanh lý *">
                <DateInput className="mt-1.5" value={disposalForm.disposalDate} onChange={(disposalDate) => setDisposalForm({ ...disposalForm, disposalDate })} ariaLabel="Ngày thanh lý tài sản" required />
              </Field>
              <Field label="Số tiền thu từ thanh lý (đ)">
                <input type="number" min="0" className="control" value={disposalForm.disposalAmount} onChange={(e) => setDisposalForm({ ...disposalForm, disposalAmount: e.target.value })} />
              </Field>
              {Number(disposalForm.disposalAmount) > 0 && (
                <Field label="Tài khoản nhận tiền">
                  <input className="control" value={disposalForm.moneySourceCode} onChange={(e) => setDisposalForm({ ...disposalForm, moneySourceCode: e.target.value })} placeholder="Mã nguồn tiền" />
                </Field>
              )}
              <Field label="Lý do / ghi chú thanh lý">
                <textarea className="control h-20 resize-none" value={disposalForm.disposalNote} onChange={(e) => setDisposalForm({ ...disposalForm, disposalNote: e.target.value })} />
              </Field>
              <button className="primary-button bg-rose-600 hover:bg-rose-700 w-full">Xác nhận thanh lý</button>
            </form>
          )}

          <section className="table-panel">
            <Panel title="Danh sách tài sản đã thanh lý" reload={loadData} exportFileName="tai_san_da_thanh_ly" />
            <Table headers={[{ label: "Mã & tên tài sản" }, { label: "Nguyên giá", align: "right" }, { label: "Tiền thu thanh lý", align: "right" }, { label: "Trạng thái" }, { label: "Thao tác", align: "right" }]}>
              {data.assets.filter((a) => a.status === "DISPOSED").length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">Chưa có tài sản nào được thanh lý.</td></tr>
              ) : (
                data.assets.filter((a) => a.status === "DISPOSED").map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <Cell><CopyableText value={row.code}><b>{row.code}</b></CopyableText><small className="block text-slate-600">{row.name}</small></Cell>
                    <Cell right>{money(row.originalCost)} đ</Cell>
                    <Cell right><b className="text-emerald-700">{money(row.disposalAmount || 0)} đ</b></Cell>
                    <Cell><span className="status bg-rose-100 text-rose-800">Đã thanh lý</span></Cell>
                    <Cell right>
                      {canEdit && (
                        <button
                          className="action-link text-slate-400 hover:text-rose-600"
                          title="Đưa tài sản về Đang dùng, dựng lại giá trị còn lại và xoá phiếu thu thanh lý"
                          onClick={() => {
                            if (!window.confirm(`Mở lại thanh lý ${row.code}? Tài sản quay về Đang dùng, giá trị còn lại dựng lại theo nguyên giá trừ khấu hao đã chạy, và phiếu thu tiền thanh lý bị xoá.`)) return;
                            void send({ action: "REOPEN_DISPOSAL", assetId: row.id }, `Đã mở lại thanh lý ${row.code}. Thanh lý lại với số đúng nếu cần.`);
                          }}
                        >
                          Mở lại
                        </button>
                      )}
                    </Cell>
                  </tr>
                ))
              )}
            </Table>
          </section>
        </div>
      )}
    </ModuleFrame>
  );
}

/**
 * Nén ảnh trước khi lưu: ảnh kiểm kê lưu dạng data URL ngay trong DB (cùng cách với ảnh hồ sơ
 * tài sản), nên ảnh chụp thẳng từ điện thoại (3–8 MB) phải co về tối đa 1280px, JPEG 0.8 —
 * thường còn 150–300 KB. Không có canvas (trình duyệt cũ) thì lấy nguyên ảnh nếu đủ nhỏ.
 */
async function compressImageFile(file: File): Promise<string> {
  const readAsDataUrl = () => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Không đọc được file ảnh"));
    reader.readAsDataURL(file);
  });
  const original = await readAsDataUrl();
  if (typeof document === "undefined") return original;
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => resolve(null);
    element.src = original;
  });
  if (!image) return original;
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return original;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const compressed = canvas.toDataURL("image/jpeg", 0.8);
  return compressed.length < original.length ? compressed : original;
}

/** Ô chọn/chụp ảnh của một dòng kiểm kê: thumbnail + nút xoá; trên điện thoại mở thẳng camera. */
function StocktakeImageInput({ value, onChange, onError }: { value: string; onChange: (dataUrl: string) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const pick = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onError("Vui lòng chọn file hình ảnh hợp lệ.");
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await compressImageFile(file);
      if (dataUrl.length > 2_000_000) {
        onError("Ảnh vẫn quá lớn sau khi nén (trên 2 MB). Chụp lại ở độ phân giải thấp hơn.");
        return;
      }
      onChange(dataUrl);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Không đọc được ảnh");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2">
      {value ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="Ảnh kiểm kê" className="h-10 w-10 rounded object-cover border border-slate-200" />
          <button type="button" className="text-[11px] text-rose-600 hover:underline" onClick={() => onChange("")}>Xoá</button>
        </>
      ) : (
        <label htmlFor={inputId} className={`inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50 ${busy ? "opacity-50" : ""}`}>
          <span className="material-symbols-outlined text-base">photo_camera</span>
          {busy ? "Đang nén..." : "Chụp / chọn"}
        </label>
      )}
      <input id={inputId} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void pick(e.target.files?.[0] || null); e.target.value = ""; }} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>;
}

function AssetSelect({ assets, value, onChange }: { assets: Asset[]; value: string; onChange: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return assets;
    return assets.filter((asset) => `${asset.code} ${asset.name}`.toLowerCase().includes(keyword));
  }, [assets, search]);

  return (
    <Field label="Tài sản">
      <input
        className="control mt-1.5 rounded-b-none text-xs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Gõ mã hoặc tên tài sản để lọc"
      />
      <select className="control rounded-t-none border-t-0" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Chọn tài sản</option>
        {filtered.map((asset) => (
          <option key={asset.id} value={asset.id}>{assetLotLabel(asset)} - {asset.name}</option>
        ))}
      </select>
    </Field>
  );
}

function Panel({ title, reload, exportFileName, children }: { title: string; reload: () => void; exportFileName?: string; children?: React.ReactNode }) {
  return (
    <div className="p-5 flex justify-between items-center gap-3">
      <h2 className="font-bold">{title}</h2>
      <div className="flex items-center gap-2">
        {children}
        {exportFileName && <ExportExcelButton fileName={exportFileName} sheetName={title.slice(0, 31)} />}
        <button type="button" title="Tải lại" onClick={reload} className="icon-button">
          <span className="material-symbols-outlined text-lg">refresh</span>
        </button>
      </div>
    </div>
  );
}

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right"; sticky?: boolean }[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            {headers.map((header) => (
              <th
                key={header.label}
                className={`px-4 py-3 ${header.align === "right" ? "text-right" : "text-left"} ${header.sticky ? "sticky left-0 z-10 bg-slate-50" : ""}`}
              >
                {header.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Cell({ children, right, sticky, className }: { children: React.ReactNode; right?: boolean; sticky?: boolean; className?: string }) {
  return (
    <td className={`px-4 py-3 align-top ${right ? "text-right" : ""} ${sticky ? "sticky left-0 z-10 bg-white" : ""} ${className || ""}`}>
      {children}
    </td>
  );
}
