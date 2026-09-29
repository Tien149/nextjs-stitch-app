"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import CopyableText from "@/components/CopyableText";
import ExportExcelButton from "@/components/ExportExcelButton";
import { money, quantity as qty, unitPrice } from "@/lib/format-number";
import { isLocationStocktakeItemType, resolveUnitInputs } from "@/lib/stocktake-consolidate";
import { STOCKTAKE_APPROVED, STOCKTAKE_PENDING, STOCKTAKE_RETURNED, isStocktakeEditable, stocktakeStatusLabel, stocktakeStatusTone } from "@/lib/stocktake-status";

/**
 * Kiểm kê THEO VỊ TRÍ + duyệt GỘP (khách chốt 28/09/2026) — nguyên liệu & bao bì.
 *
 *  - Đếm: chọn kho + vị trí, nạp form mẫu của vị trí, nhập số đếm nhiều ĐVT cùng lúc
 *    (thùng + chai + gr), Gửi duyệt. Phiếu chỉ ghi số đếm.
 *  - Duyệt gộp (kế toán): chọn các phiếu của một kho + GIỜ CHỐT -> bảng tổng hợp (cột từng vị
 *    trí, tổng đếm, sổ sách tại giờ chốt, chênh lệch) -> Duyệt.
 *  - Đợt đã chốt: kết quả tổng kiểm kê; Mở lại để đảo điều chỉnh rồi duyệt lại giờ khác.
 *  - Vị trí & form mẫu: danh sách mã theo thứ tự đếm của từng vị trí.
 * Luật ở lib/stocktake-batch.ts + lib/stocktake-consolidate.ts.
 */

type UnitConversion = { unitCode: string; unitName?: string | null; conversionRate: number; isDefaultPurchase?: boolean };
type Item = { id: string; code: string; name: string; unit: string; itemType: string; status?: string | null; unitConversions?: UnitConversion[] };
type Warehouse = { code: string; name: string; branch: string | null };
type Balance = { warehouseCode: string; quantity: number; item: { id: string } };
type LocationItem = { itemId: string; sortOrder: number; item: Item };
type Location = { id: string; branchCode: string; warehouseCode: string; code: string; name: string; sortOrder: number; status: string; note?: string | null; items: LocationItem[] };
type SheetLine = { id: string; itemId: string; actualQuantity: number; unitCost?: number | null; unitInputs?: string | null; reason?: string | null; item: Item };
type Sheet = {
  id: string; code: string; stocktakeDate: string; branchCode: string; warehouseCode: string; locationCode: string; status: string;
  createdBy?: string | null; approvedBy?: string | null; returnedReason?: string | null; note?: string | null;
  lines: SheetLine[]; batch?: { code: string; cutoffAt: string } | null;
};
type BatchLine = { id: string; itemId: string; bookQuantity: number; countedQuantity: number; varianceQuantity: number; unitCost: number; varianceValue: number; breakdownJson?: string | null; notCounted: boolean; item: Item };
type Batch = {
  id: string; code: string; branchCode: string; warehouseCode: string; cutoffAt: string; status: string; approvedBy?: string | null; approvedAt?: string | null;
  reopenedBy?: string | null; reopenedAt?: string | null; note?: string | null; shortageValue: number; surplusValue: number;
  lines: BatchLine[]; sessions: Array<{ id: string; code: string; locationCode: string | null }>;
};
type PreviewRow = {
  itemId: string; itemCode: string; itemName: string; unit: string; breakdown: Record<string, number>; countedQuantity: number; bookQuantity: number;
  varianceQuantity: number; unitCost: number; varianceValue: number; notCounted: boolean; needsUnitCost: boolean;
};
type Preview = {
  warehouseCode: string; cutoffAt: string; sheets: Array<{ id: string; code: string; locationCode: string; createdBy: string | null; lineCount: number }>;
  locations: Array<{ code: string; name: string }>; rows: PreviewRow[]; warnings: string[];
  totals: { shortageValue: number; surplusValue: number; varianceRows: number; notCountedRows: number };
};
type CountRow = { itemId: string; inputs: Record<string, string>; unitCost: string; reason: string };

const api = "/api/inventory/stocktake-locations";
const EPSILON = 0.000001;

function sessionHeaders(sessionKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(sessionKey);
  return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
}

/** ĐVT đếm của một mặt hàng: ĐVT mua (lớn) trước, ĐVT tồn cuối — đúng thứ tự người đếm nhìn thùng -> chai -> lẻ. */
function countUnitsOf(item: Item) {
  const base = item.unit.trim().toUpperCase();
  const others = (item.unitConversions || [])
    .filter((conversion) => conversion.unitCode.trim().toUpperCase() !== base && conversion.conversionRate > 0)
    .sort((a, b) => b.conversionRate - a.conversionRate);
  return [...others.map((conversion) => ({ unitCode: conversion.unitCode.toUpperCase(), label: conversion.unitName || conversion.unitCode, conversionRate: conversion.conversionRate })), { unitCode: base, label: item.unit, conversionRate: 1 }];
}

function nowLocalInput() {
  const now = new Date();
  now.setSeconds(0, 0);
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
const todayInput = () => nowLocalInput().slice(0, 10);
const dateTimeText = (value: string | Date) => new Date(value).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" });

export default function StocktakeByLocation(props: {
  sessionKey: string;
  items: Item[];
  warehouses: Warehouse[];
  balances: Balance[];
  branchOptions: Array<{ code: string; label: string }>;
  defaultBranch: string;
  canCreate: boolean;
  canEdit: boolean;
  canApprove: boolean;
  canDelete: boolean;
  onStockChanged: () => void;
}) {
  const { sessionKey, items, warehouses, balances, branchOptions, canCreate, canEdit, canApprove, canDelete, onStockChanged } = props;
  const [section, setSection] = useState<"count" | "approve" | "batches" | "locations">(canCreate ? "count" : canApprove ? "approve" : "batches");
  const [branchCode, setBranchCode] = useState(props.defaultBranch);
  const [data, setData] = useState<{ locations: Location[]; sheets: Sheet[]; batches: Batch[] }>({ locations: [], sheets: [], batches: [] });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const branchWarehouses = useMemo(
    () => warehouses.filter((warehouse) => !warehouse.branch || warehouse.branch.toUpperCase() === branchCode.toUpperCase()),
    [warehouses, branchCode],
  );
  const [warehouseCode, setWarehouseCode] = useState("");
  const activeWarehouse = branchWarehouses.some((warehouse) => warehouse.code === warehouseCode) ? warehouseCode : branchWarehouses[0]?.code || "";
  const warehouseName = (code: string) => warehouses.find((warehouse) => warehouse.code === code)?.name || code;
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const scopedItems = useMemo(() => items.filter((item) => isLocationStocktakeItemType(item.itemType) && (item.status || "ACTIVE") === "ACTIVE"), [items]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${api}?branchCode=${encodeURIComponent(branchCode)}`, { headers: sessionHeaders(sessionKey) });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không tải được dữ liệu kiểm kê theo vị trí");
        return;
      }
      setData(payload);
    } catch {
      setMessage("Mất kết nối tới máy chủ khi tải kiểm kê theo vị trí.");
    }
  }, [branchCode, sessionKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const post = async (body: object, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders(sessionKey) },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không thực hiện được thao tác");
        return null;
      }
      if (success) setMessage(success);
      return payload;
    } catch {
      setMessage("Mất kết nối tới máy chủ. Vui lòng thử lại.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Trả lại / xoá phiếu đếm dùng chung đường của /api/inventory. */
  const legacy = async (init: RequestInit & { url?: string }, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(init.url || "/api/inventory", { ...init, headers: { "Content-Type": "application/json", ...sessionHeaders(sessionKey) } });
      const payload = await response.json();
      setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
      if (response.ok) await load();
    } finally {
      setBusy(false);
    }
  };

  const locationsOf = (code: string) => data.locations.filter((location) => location.warehouseCode === code);

  // ───────────────────────── Đếm theo vị trí ─────────────────────────
  const [countForm, setCountForm] = useState({ locationCode: "", stocktakeDate: todayInput(), note: "" });
  const [countRows, setCountRows] = useState<CountRow[]>([]);
  const [editingSheet, setEditingSheet] = useState<{ id: string; code: string; returnedReason?: string | null } | null>(null);
  const [countSearch, setCountSearch] = useState("");
  const [addItemCode, setAddItemCode] = useState("");
  const warehouseLocations = locationsOf(activeWarehouse).filter((location) => location.status === "ACTIVE" || location.code === countForm.locationCode);
  const activeLocation = warehouseLocations.find((location) => location.code === countForm.locationCode) || null;

  const loadTemplate = (location: Location | null) => {
    setCountRows((location?.items || []).map((entry) => ({ itemId: entry.itemId, inputs: {}, unitCost: "", reason: "" })));
    setCountSearch("");
  };
  const chooseLocation = (code: string) => {
    setCountForm((form) => ({ ...form, locationCode: code }));
    if (!editingSheet) loadTemplate(locationsOf(activeWarehouse).find((location) => location.code === code) || null);
  };
  const addCountItem = () => {
    const code = addItemCode.trim().toUpperCase();
    const item = scopedItems.find((candidate) => candidate.code.toUpperCase() === code);
    if (!item) {
      setMessage(`Không tìm thấy mã ${code} trong nhóm nguyên liệu / bao bì.`);
      return;
    }
    if (!countRows.some((row) => row.itemId === item.id)) setCountRows((rows) => [...rows, { itemId: item.id, inputs: {}, unitCost: "", reason: "" }]);
    setAddItemCode("");
  };
  const patchCount = (itemId: string, patch: Partial<CountRow>) => setCountRows((rows) => rows.map((row) => (row.itemId === itemId ? { ...row, ...patch } : row)));
  const baseQuantityOf = (row: CountRow) => {
    const item = itemById.get(row.itemId);
    if (!item) return { quantity: 0, error: "", counted: false };
    const result = resolveUnitInputs(item.unit, (item.unitConversions || []).map((unit) => ({ unitCode: unit.unitCode, conversionRate: unit.conversionRate })), Object.entries(row.inputs).map(([unitCode, quantity]) => ({ unitCode, quantity })));
    return { quantity: result.baseQuantity, error: result.error || "", counted: result.inputs.length > 0 };
  };

  const editSheet = (sheet: Sheet) => {
    setWarehouseCode(sheet.warehouseCode);
    setCountForm({ locationCode: sheet.locationCode, stocktakeDate: sheet.stocktakeDate.slice(0, 10), note: sheet.note || "" });
    const location = locationsOf(sheet.warehouseCode).find((candidate) => candidate.code === sheet.locationCode);
    const rows: CountRow[] = sheet.lines.map((line) => {
      let inputs: Record<string, string> = {};
      try {
        const parsed = JSON.parse(line.unitInputs || "[]") as Array<{ unitCode: string; quantity: number }>;
        inputs = Object.fromEntries(parsed.map((input) => [input.unitCode.toUpperCase(), String(input.quantity)]));
      } catch { /* dòng cũ không có số theo ĐVT */ }
      if (Object.keys(inputs).length === 0) inputs = { [line.item.unit.toUpperCase()]: String(line.actualQuantity) };
      return { itemId: line.itemId, inputs, unitCost: line.unitCost ? String(line.unitCost) : "", reason: line.reason || "" };
    });
    for (const entry of location?.items || []) {
      if (!rows.some((row) => row.itemId === entry.itemId)) rows.push({ itemId: entry.itemId, inputs: {}, unitCost: "", reason: "" });
    }
    setCountRows(rows);
    setEditingSheet({ id: sheet.id, code: sheet.code, returnedReason: sheet.status === STOCKTAKE_RETURNED ? sheet.returnedReason : null });
    setSection("count");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const cancelEdit = () => {
    setEditingSheet(null);
    loadTemplate(activeLocation);
  };

  const submitSheet = async () => {
    const invalid = countRows.map((row) => ({ row, result: baseQuantityOf(row) })).find(({ result }) => result.error);
    if (invalid) {
      setMessage(`${itemById.get(invalid.row.itemId)?.code}: ${invalid.result.error}`);
      return;
    }
    const payload = await post({
      action: "SAVE_SHEET",
      stocktakeId: editingSheet?.id,
      branchCode,
      warehouseCode: activeWarehouse,
      locationCode: countForm.locationCode,
      stocktakeDate: countForm.stocktakeDate,
      note: countForm.note,
      lines: countRows.map((row) => ({
        itemId: row.itemId,
        inputs: Object.entries(row.inputs).map(([unitCode, quantity]) => ({ unitCode, quantity })),
        unitCost: row.unitCost,
        reason: row.reason,
      })),
    }, editingSheet ? `Đã lưu và gửi lại phiếu ${editingSheet.code} — chờ kế toán duyệt gộp.` : "Đã gửi phiếu đếm — chờ kế toán duyệt gộp. Tồn kho chỉ đổi khi kế toán duyệt.");
    if (payload) {
      setEditingSheet(null);
      loadTemplate(activeLocation);
      await load();
    }
  };

  // ───────────────────────── Duyệt gộp ─────────────────────────
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const [cutoffInput, setCutoffInput] = useState(nowLocalInput());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [unitCosts, setUnitCosts] = useState<Record<string, string>>({});
  const [onlyVariance, setOnlyVariance] = useState(false);
  const pendingSheets = data.sheets.filter((sheet) => sheet.warehouseCode === activeWarehouse && sheet.status === STOCKTAKE_PENDING);
  const selected = selectedIds === null ? pendingSheets.map((sheet) => sheet.id) : selectedIds.filter((id) => pendingSheets.some((sheet) => sheet.id === id));
  const toggleSheet = (id: string) => {
    setPreview(null);
    setSelectedIds(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  };
  const cutoffIso = () => new Date(cutoffInput).toISOString();
  const costPayload = () => Object.fromEntries(Object.entries(unitCosts).filter(([, value]) => Number(value) > 0).map(([itemId, value]) => [itemId, Number(value)]));
  const runPreview = async () => {
    if (selected.length === 0) {
      setMessage("Chọn ít nhất một phiếu đếm.");
      return;
    }
    const payload = await post({ action: "PREVIEW_BATCH", stocktakeIds: selected, cutoffAt: cutoffIso(), unitCosts: costPayload() }, "");
    if (payload) setPreview(payload);
  };
  const approve = async () => {
    if (!preview) return;
    if (!window.confirm(`Duyệt gộp ${preview.sheets.length} phiếu đếm của kho ${warehouseName(preview.warehouseCode)}, chốt tồn lúc ${dateTimeText(cutoffInput)}?\nHệ thống sinh phiếu nhập/xuất kiểm kê theo phần chênh ${preview.totals.varianceRows} mã.`)) return;
    const payload = await post({ action: "APPROVE_BATCH", stocktakeIds: selected, cutoffAt: cutoffIso(), unitCosts: costPayload() }, "");
    if (payload) {
      setMessage(`Đã duyệt đợt ${payload.batch.code} — ${payload.documents.length ? `phiếu ${payload.documents.join(", ")}` : "không có chênh lệch"}.`);
      setPreview(null);
      setSelectedIds(null);
      setUnitCosts({});
      await load();
      onStockChanged();
      setSection("batches");
    }
  };

  // ───────────────────────── Đợt đã chốt ─────────────────────────
  const [openBatchId, setOpenBatchId] = useState("");
  const reopen = async (batch: Batch) => {
    if (!window.confirm(`Mở lại đợt ${batch.code} (chốt ${dateTimeText(batch.cutoffAt)})?\nPhiếu điều chỉnh của đợt bị đảo, tồn kho trả về như trước khi duyệt, các phiếu đếm về Chờ duyệt để duyệt lại (chọn được giờ chốt khác).`)) return;
    const payload = await post({ action: "REOPEN_BATCH", batchId: batch.id }, `Đã mở lại đợt ${batch.code} và đảo phiếu điều chỉnh. Chọn giờ chốt rồi duyệt lại.`);
    if (payload) {
      await load();
      onStockChanged();
      setWarehouseCode(batch.warehouseCode);
      setSelectedIds(payload.sessionIds || null);
      setCutoffInput(new Date(new Date(batch.cutoffAt).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
      setPreview(null);
      setSection("approve");
    }
  };

  // ───────────────────────── Vị trí & form mẫu ─────────────────────────
  const emptyLocation = { id: "", code: "", name: "", sortOrder: "0", status: "ACTIVE", note: "", itemIds: [] as string[] };
  const [locationForm, setLocationForm] = useState(emptyLocation);
  const [templateAdd, setTemplateAdd] = useState("");
  const editLocation = (location: Location) => setLocationForm({ id: location.id, code: location.code, name: location.name, sortOrder: String(location.sortOrder), status: location.status, note: location.note || "", itemIds: location.items.map((entry) => entry.itemId) });
  const moveTemplateItem = (index: number, delta: number) => setLocationForm((form) => {
    const next = [...form.itemIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return form;
    [next[index], next[target]] = [next[target], next[index]];
    return { ...form, itemIds: next };
  });
  const addTemplateItems = (codes: string) => {
    const wanted = codes.split(/[\s,;]+/).map((code) => code.trim().toUpperCase()).filter(Boolean);
    const found = scopedItems.filter((item) => wanted.includes(item.code.toUpperCase()));
    const missing = wanted.filter((code) => !found.some((item) => item.code.toUpperCase() === code));
    setLocationForm((form) => ({ ...form, itemIds: [...form.itemIds, ...found.map((item) => item.id).filter((id) => !form.itemIds.includes(id))] }));
    setTemplateAdd("");
    if (missing.length) setMessage(`Không thêm được (không phải nguyên liệu / bao bì hoặc sai mã): ${missing.join(", ")}`);
  };
  const addStockedItems = () => {
    const stocked = balances
      .filter((balance) => balance.warehouseCode === activeWarehouse && Math.abs(balance.quantity) > EPSILON)
      .map((balance) => balance.item.id)
      .filter((id) => { const item = itemById.get(id); return item && isLocationStocktakeItemType(item.itemType); });
    setLocationForm((form) => ({ ...form, itemIds: [...form.itemIds, ...stocked.filter((id) => !form.itemIds.includes(id))] }));
  };
  const saveLocation = async () => {
    const payload = await post({ action: "SAVE_LOCATION", ...locationForm, branchCode, warehouseCode: activeWarehouse }, `Đã lưu vị trí ${locationForm.code || locationForm.name}.`);
    if (payload) {
      setLocationForm(emptyLocation);
      await load();
    }
  };

  const itemLabel = (itemId: string) => {
    const item = itemById.get(itemId);
    return item ? `${item.code} · ${item.name}` : itemId;
  };
  const scopedDatalist = (
    <datalist id="stocktake-location-items">
      {scopedItems.map((item) => <option key={item.id} value={item.code}>{item.name}</option>)}
    </datalist>
  );

  const tabs = [
    canCreate && { key: "count" as const, label: "Đếm theo vị trí" },
    canApprove && { key: "approve" as const, label: "Duyệt gộp" },
    { key: "batches" as const, label: "Đợt đã chốt" },
    canEdit && { key: "locations" as const, label: "Vị trí & form mẫu" },
  ].filter(Boolean) as Array<{ key: typeof section; label: string }>;

  return (
    <div className="space-y-4">
      {scopedDatalist}
      <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map((tab) => (
            <button key={tab.key} type="button" onClick={() => setSection(tab.key)}
              className={`px-3 py-1.5 rounded-full text-sm font-bold border ${section === tab.key ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-600 border-slate-200 hover:border-blue-300"}`}>
              {tab.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-bold text-slate-600">Cửa hàng
            <select className="control" value={branchCode} onChange={(e) => { setBranchCode(e.target.value); setWarehouseCode(""); setPreview(null); setSelectedIds(null); }}>
              {branchOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
          <label className="block text-xs font-bold text-slate-600">Kho
            <select className="control" value={activeWarehouse} disabled={branchWarehouses.length === 0 || !!editingSheet} onChange={(e) => { setWarehouseCode(e.target.value); setCountForm((form) => ({ ...form, locationCode: "" })); setCountRows([]); setPreview(null); setSelectedIds(null); setLocationForm(emptyLocation); }}>
              {branchWarehouses.length === 0 && <option value="">Chưa có kho</option>}
              {branchWarehouses.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
            </select>
          </label>
        </div>
        {message && <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-800 whitespace-pre-line">{message}</p>}
        {/* Tick menu Kiểm kê chỉ mở màn; lập phiếu đếm cần quyền thao tác "create" của vai trò. */}
        {!canCreate && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Vai trò của bạn chưa có quyền <b>create</b> nên không lập được phiếu đếm. Nhờ Admin tick <b>create</b>{" "}cho vai trò ở Phân quyền &amp; Người dùng.
          </p>
        )}
      </div>

      {section === "count" && canCreate && (
        <form onSubmit={(e) => { e.preventDefault(); void submitSheet(); }} className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 shadow-sm">
          <h2 className="font-bold text-slate-800">{editingSheet ? `Sửa phiếu đếm ${editingSheet.code}` : "Phiếu đếm theo vị trí"}</h2>
          {editingSheet && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 flex flex-wrap items-start justify-between gap-2">
              <div className="space-y-1">
                <p>Đang sửa phiếu <b>{editingSheet.code}</b> — bấm <b>Lưu &amp; gửi lại</b>.</p>
                {editingSheet.returnedReason && <p className="text-rose-700"><b>Kế toán trả lại:</b> {editingSheet.returnedReason}</p>}
              </div>
              <button type="button" className="font-bold text-slate-500 hover:underline" onClick={cancelEdit}>Huỷ sửa</button>
            </div>
          )}
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Mỗi phiếu là số đếm của MỘT vị trí, không so tồn hệ thống. Mã nằm ở nhiều vị trí thì đếm ở từng vị trí — kế toán duyệt gộp sẽ cộng tổng
            và so với tồn tại giờ chốt. Mã có tồn mà không vị trí nào đếm sẽ tính = 0. Nhập được nhiều ĐVT cùng lúc (thùng + chai + lẻ).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-bold text-slate-600">Vị trí
              <select className="control" value={countForm.locationCode} disabled={!!editingSheet} onChange={(e) => chooseLocation(e.target.value)}>
                <option value="">— Chọn vị trí —</option>
                {warehouseLocations.map((location) => <option key={location.id} value={location.code}>{location.name} ({location.code})</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-600">Ngày đếm
              <input type="date" className="control" value={countForm.stocktakeDate} onChange={(e) => setCountForm({ ...countForm, stocktakeDate: e.target.value })} />
            </label>
          </div>
          {warehouseLocations.length === 0 && (
            <p className="rounded-md bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">Kho này chưa khai vị trí kiểm kê. {canEdit ? "Khai ở mục Vị trí & form mẫu." : "Nhờ quản lý khai vị trí & form mẫu."}</p>
          )}
          {countForm.locationCode && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <input type="search" className="control !mt-0 flex-1 min-w-[180px]" placeholder="Tìm nhanh mặt hàng..." value={countSearch} onChange={(e) => setCountSearch(e.target.value)} />
                <input list="stocktake-location-items" className="control !mt-0 w-44" placeholder="Thêm mã ngoài form" value={addItemCode} onChange={(e) => setAddItemCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCountItem(); } }} />
                <button type="button" className="secondary-button" onClick={addCountItem}>Thêm</button>
                {!editingSheet && <button type="button" className="secondary-button" onClick={() => loadTemplate(activeLocation)}>Nạp lại form mẫu</button>}
              </div>
              <p className="text-xs text-slate-500">
                {countRows.length} mặt hàng · <b>{countRows.filter((row) => baseQuantityOf(row).counted).length} đã đếm</b> · ô trống = chưa đếm (tính 0 nếu không vị trí nào đếm)
              </p>
              <div className="space-y-2">
                {countRows
                  .filter((row) => {
                    const keyword = countSearch.trim().toLowerCase();
                    const item = itemById.get(row.itemId);
                    return !keyword || !item || item.code.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword);
                  })
                  .map((row) => {
                    const item = itemById.get(row.itemId);
                    if (!item) return null;
                    const total = baseQuantityOf(row);
                    return (
                      <div key={row.itemId} className={`rounded-xl border p-3 space-y-2 ${total.counted ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-bold text-sm">{item.name}</p>
                            <p className="text-xs text-slate-500">{item.code}{total.counted ? <> · Tổng: <b className="text-slate-800">{qty(total.quantity)} {item.unit}</b></> : ""}</p>
                            {total.error && <p className="text-xs font-bold text-rose-700">{total.error}</p>}
                          </div>
                          <button type="button" className="text-xs text-slate-400 hover:text-rose-600" title="Bỏ dòng khỏi phiếu" onClick={() => setCountRows((rows) => rows.filter((candidate) => candidate.itemId !== row.itemId))}>✕</button>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {countUnitsOf(item).map((unit) => (
                            <label key={unit.unitCode} className="flex items-center gap-1 text-xs text-slate-600">
                              <input type="number" min="0" step="any" inputMode="decimal" className="control !mt-0 w-20 text-right text-base"
                                value={row.inputs[unit.unitCode] ?? ""}
                                onChange={(e) => patchCount(row.itemId, { inputs: { ...row.inputs, [unit.unitCode]: e.target.value } })}
                                aria-label={`${item.name} — ${unit.label}`} />
                              <span className="whitespace-nowrap">{unit.label}{unit.conversionRate !== 1 ? <small className="text-slate-400"> ={qty(unit.conversionRate)}{item.unit}</small> : ""}</span>
                            </label>
                          ))}
                          <input className="control !mt-0 flex-1 min-w-[120px]" placeholder="Ghi chú" value={row.reason} onChange={(e) => patchCount(row.itemId, { reason: e.target.value })} />
                        </div>
                      </div>
                    );
                  })}
              </div>
              <label className="block text-xs font-bold text-slate-600">Ghi chú phiếu
                <input className="control" value={countForm.note} onChange={(e) => setCountForm({ ...countForm, note: e.target.value })} />
              </label>
              <div className="sticky bottom-0 z-20 -mx-4 sm:-mx-5 -mb-4 sm:-mb-5 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 rounded-b-lg pl-20 lg:pl-4">
                <button className="primary-button w-full !min-h-12" disabled={busy}>{editingSheet ? "Lưu & gửi lại" : "Gửi duyệt"}</button>
              </div>
            </>
          )}
        </form>
      )}

      {section === "approve" && canApprove && (
        <section className="bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4 shadow-sm">
          <h2 className="font-bold text-slate-800">Duyệt gộp — {warehouseName(activeWarehouse) || "chọn kho"}</h2>
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Sổ sách lấy TẠI GIỜ CHỐT: mọi phiếu kho có ngày giờ chứng từ trước giờ chốt. Chứng từ giải trình (nhập/xuất bổ sung) phải lập với ngày
            giờ trước giờ chốt. Rã nguyên liệu từ doanh thu tới giờ chốt trước khi duyệt.
          </p>
          {pendingSheets.length === 0 ? (
            <p className="text-sm text-slate-500">Kho này không có phiếu đếm nào đang Chờ duyệt.</p>
          ) : (
            <div className="space-y-1">
              {pendingSheets.map((sheet) => (
                <label key={sheet.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={selected.includes(sheet.id)} onChange={() => toggleSheet(sheet.id)} />
                  <b>{sheet.code}</b>
                  <span className="text-slate-600">{locationsOf(sheet.warehouseCode).find((location) => location.code === sheet.locationCode)?.name || sheet.locationCode}</span>
                  <span className="text-xs text-slate-400">{sheet.lines.length} mã · {sheet.createdBy || ""} · {new Date(sheet.stocktakeDate).toLocaleDateString("vi-VN")}</span>
                </label>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <label className="block text-xs font-bold text-slate-600">Giờ chốt tồn
              <input type="datetime-local" className="control" value={cutoffInput} max={nowLocalInput()} onChange={(e) => { setCutoffInput(e.target.value); setPreview(null); }} />
            </label>
            <button type="button" className="secondary-button" onClick={() => { setCutoffInput(nowLocalInput()); setPreview(null); }}>Bây giờ</button>
            <button type="button" className="primary-button" disabled={busy || selected.length === 0} onClick={() => void runPreview()}>Xem tổng hợp ({selected.length} phiếu)</button>
          </div>

          {preview && (
            <div className="space-y-3" data-export-root>
              {preview.warnings.length > 0 && (
                <ul className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800 list-disc pl-6 space-y-1">
                  {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <p>
                  Chốt lúc <b>{dateTimeText(preview.cutoffAt)}</b> · {preview.rows.length} mã · <b className="text-amber-700">{preview.totals.varianceRows} mã lệch</b>
                  {" "}· {preview.totals.notCountedRows} mã không ai đếm · Thiếu <b className="text-rose-700">{money(preview.totals.shortageValue)}</b> · Thừa <b className="text-emerald-700">{money(preview.totals.surplusValue)}</b>
                </p>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={onlyVariance} onChange={(e) => setOnlyVariance(e.target.checked)} />Chỉ dòng lệch</label>
                  <ExportExcelButton fileName={`tong_hop_kiem_ke_${preview.warehouseCode}`} sheetName="Tong hop kiem ke" />
                </div>
              </div>
              <ConsolidatedTable
                locations={preview.locations}
                rows={preview.rows.filter((row) => !onlyVariance || Math.abs(row.varianceQuantity) > EPSILON)}
                unitCostCell={(row) => row.varianceQuantity > 0 ? (
                  <input type="number" min="0" className={`control text-right w-24 inline-block ${row.needsUnitCost ? "border-rose-400" : ""}`}
                    placeholder={row.needsUnitCost ? "Nhập giá" : unitPrice(row.unitCost)}
                    value={unitCosts[row.itemId] ?? ""}
                    onChange={(e) => { setUnitCosts({ ...unitCosts, [row.itemId]: e.target.value }); }} />
                ) : <span className="text-slate-500">{unitPrice(row.unitCost)}</span>}
              />
              {Object.keys(unitCosts).length > 0 && <p className="text-xs text-slate-500">Đã sửa đơn giá — bấm <b>Xem tổng hợp</b> lại để tính giá trị theo giá mới trước khi duyệt.</p>}
              <button type="button" className="primary-button w-full !min-h-12" disabled={busy || preview.rows.some((row) => row.needsUnitCost && !(Number(unitCosts[row.itemId]) > 0))} onClick={() => void approve()}>
                Duyệt {preview.sheets.length} phiếu · chốt tồn lúc {dateTimeText(cutoffInput)}
              </button>
            </div>
          )}
        </section>
      )}

      {section === "batches" && (
        <section className="table-panel shadow-sm">
          <div className="p-5 flex justify-between items-center gap-3">
            <h2 className="font-bold text-slate-800">Đợt kiểm kê đã chốt</h2>
            <button type="button" title="Tải lại" onClick={() => void load()} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
          </div>
          {data.batches.length === 0 && <p className="px-5 pb-5 text-sm text-slate-500">Chưa có đợt nào.</p>}
          <div className="divide-y divide-slate-100">
            {data.batches.map((batch) => {
              const locationsInBatch = [...new Set(batch.lines.flatMap((line) => Object.keys(JSON.parse(line.breakdownJson || "{}") as Record<string, number>)))];
              const isOpen = openBatchId === batch.id;
              return (
                <div key={batch.id} className="px-5 py-3 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <CopyableText value={batch.code}><b>{batch.code}</b></CopyableText>
                      <span className={`status ml-2 ${batch.status === "APPROVED" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>{batch.status === "APPROVED" ? "Đã duyệt" : "Đã mở lại"}</span>
                      <p className="text-xs text-slate-500">
                        {warehouseName(batch.warehouseCode)} · chốt <b>{dateTimeText(batch.cutoffAt)}</b> · duyệt {batch.approvedBy || ""}
                        {batch.status !== "APPROVED" && batch.reopenedAt ? ` · mở lại ${batch.reopenedBy || ""} ${dateTimeText(batch.reopenedAt)}` : ""}
                      </p>
                      <p className="text-xs text-slate-600">
                        {batch.lines.length} mã · {batch.lines.filter((line) => Math.abs(line.varianceQuantity) > EPSILON).length} mã lệch · Thiếu <b className="text-rose-700">{money(batch.shortageValue)}</b> · Thừa <b className="text-emerald-700">{money(batch.surplusValue)}</b>
                      </p>
                      {batch.note && <p className="text-xs text-slate-400">{batch.note}</p>}
                    </div>
                    <div className="flex gap-3">
                      <button type="button" className="text-xs font-bold text-blue-700 hover:underline" onClick={() => setOpenBatchId(isOpen ? "" : batch.id)}>{isOpen ? "Thu gọn" : "Xem kết quả"}</button>
                      {canApprove && batch.status === "APPROVED" && (
                        <button type="button" className="text-xs font-bold text-slate-400 hover:text-rose-600 hover:underline" disabled={busy} onClick={() => void reopen(batch)}>Mở lại</button>
                      )}
                    </div>
                  </div>
                  {isOpen && (
                    <div data-export-root className="space-y-2">
                      <ExportExcelButton fileName={`ket_qua_kiem_ke_${batch.code}`} sheetName="Ket qua kiem ke" />
                      <ConsolidatedTable
                        locations={locationsInBatch.map((code) => ({ code, name: locationsOf(batch.warehouseCode).find((location) => location.code === code)?.name || code }))}
                        rows={batch.lines.map((line) => ({
                          itemId: line.itemId, itemCode: line.item.code, itemName: line.item.name, unit: line.item.unit,
                          breakdown: JSON.parse(line.breakdownJson || "{}"), countedQuantity: line.countedQuantity, bookQuantity: line.bookQuantity,
                          varianceQuantity: line.varianceQuantity, unitCost: line.unitCost, varianceValue: line.varianceValue, notCounted: line.notCounted, needsUnitCost: false,
                        })).sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue))}
                        unitCostCell={(row) => <span>{unitPrice(row.unitCost)}</span>}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {section === "locations" && canEdit && (
        <div className="grid lg:grid-cols-[420px_1fr] gap-4">
          <form onSubmit={(e) => { e.preventDefault(); void saveLocation(); }} className="bg-white border border-slate-200 rounded-lg p-4 space-y-3 shadow-sm h-fit">
            <h2 className="font-bold text-slate-800">{locationForm.id ? `Sửa vị trí ${locationForm.code}` : "Thêm vị trí"} — {warehouseName(activeWarehouse)}</h2>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-bold text-slate-600">Mã vị trí
                <input className="control" value={locationForm.code} placeholder="TU_DONG_1" onChange={(e) => setLocationForm({ ...locationForm, code: e.target.value })} />
              </label>
              <label className="block text-xs font-bold text-slate-600">Tên vị trí
                <input className="control" value={locationForm.name} placeholder="Tủ đông 1" onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })} />
              </label>
              <label className="block text-xs font-bold text-slate-600">Thứ tự
                <input type="number" className="control" value={locationForm.sortOrder} onChange={(e) => setLocationForm({ ...locationForm, sortOrder: e.target.value })} />
              </label>
              <label className="block text-xs font-bold text-slate-600">Trạng thái
                <select className="control" value={locationForm.status} onChange={(e) => setLocationForm({ ...locationForm, status: e.target.value })}>
                  <option value="ACTIVE">Đang dùng</option>
                  <option value="INACTIVE">Ngưng</option>
                </select>
              </label>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-bold text-slate-600">Form mẫu — mặt hàng theo thứ tự đếm ({locationForm.itemIds.length})</p>
              <div className="flex gap-2">
                <input list="stocktake-location-items" className="control !mt-0 flex-1" placeholder="Mã hàng (dán nhiều mã cách nhau dấu phẩy)" value={templateAdd} onChange={(e) => setTemplateAdd(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTemplateItems(templateAdd); } }} />
                <button type="button" className="secondary-button" onClick={() => addTemplateItems(templateAdd)}>Thêm</button>
              </div>
              <button type="button" className="text-xs font-bold text-blue-700 hover:underline" onClick={addStockedItems}>+ Thêm mọi nguyên liệu / bao bì đang có tồn trong kho</button>
              <ol className="max-h-80 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-md">
                {locationForm.itemIds.map((itemId, index) => (
                  <li key={itemId} className="flex items-center gap-2 px-2 py-1 text-sm">
                    <span className="text-xs text-slate-400 w-6 text-right">{index + 1}</span>
                    <span className="flex-1 truncate">{itemLabel(itemId)}</span>
                    <button type="button" className="text-xs text-slate-500" onClick={() => moveTemplateItem(index, -1)}>▲</button>
                    <button type="button" className="text-xs text-slate-500" onClick={() => moveTemplateItem(index, 1)}>▼</button>
                    <button type="button" className="text-xs text-rose-500" onClick={() => setLocationForm((form) => ({ ...form, itemIds: form.itemIds.filter((id) => id !== itemId) }))}>✕</button>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex gap-2">
              <button className="primary-button flex-1" disabled={busy || !activeWarehouse}>Lưu vị trí</button>
              {locationForm.id && <button type="button" className="secondary-button" onClick={() => setLocationForm(emptyLocation)}>Huỷ</button>}
            </div>
          </form>
          <section className="table-panel shadow-sm">
            <div className="p-5"><h2 className="font-bold text-slate-800">Vị trí của {warehouseName(activeWarehouse)}</h2></div>
            <div className="divide-y divide-slate-100">
              {locationsOf(activeWarehouse).length === 0 && <p className="px-5 pb-5 text-sm text-slate-500">Chưa có vị trí nào.</p>}
              {locationsOf(activeWarehouse).map((location) => (
                <div key={location.id} className="px-5 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-bold text-sm">{location.name} <span className="text-xs text-slate-400">{location.code}</span> {location.status !== "ACTIVE" && <span className="status bg-slate-100 text-slate-500">Ngưng</span>}</p>
                    <p className="text-xs text-slate-500 truncate">{location.items.length} mã: {location.items.slice(0, 8).map((entry) => entry.item.name).join(", ")}{location.items.length > 8 ? "…" : ""}</p>
                  </div>
                  <button type="button" className="text-xs font-bold text-blue-700 hover:underline" onClick={() => editLocation(location)}>Sửa</button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {(section === "count" || section === "approve") && (
        <section className="table-panel shadow-sm">
          <div className="p-5 flex justify-between items-center gap-3">
            <h2 className="font-bold text-slate-800">Phiếu đếm theo vị trí</h2>
            <button type="button" title="Tải lại" onClick={() => void load()} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
          </div>
          <div className="divide-y divide-slate-100 pb-20 md:pb-0">
            {data.sheets.filter((sheet) => sheet.warehouseCode === activeWarehouse).length === 0 && <p className="px-5 pb-5 text-sm text-slate-500">Chưa có phiếu đếm nào của kho này.</p>}
            {data.sheets.filter((sheet) => sheet.warehouseCode === activeWarehouse).map((sheet) => (
              <div key={sheet.id} className="px-5 py-3 space-y-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CopyableText value={sheet.code}><b>{sheet.code}</b></CopyableText>
                    <span className={`status ml-2 ${stocktakeStatusTone(sheet.status)}`}>{stocktakeStatusLabel(sheet.status)}</span>
                    <p className="text-xs text-slate-500">
                      {locationsOf(sheet.warehouseCode).find((location) => location.code === sheet.locationCode)?.name || sheet.locationCode}
                      {" "}· {new Date(sheet.stocktakeDate).toLocaleDateString("vi-VN")} · {sheet.lines.length} mã{sheet.createdBy ? ` · ${sheet.createdBy}` : ""}
                      {sheet.status === STOCKTAKE_APPROVED && sheet.batch ? ` · đợt ${sheet.batch.code} chốt ${dateTimeText(sheet.batch.cutoffAt)}` : ""}
                    </p>
                    {sheet.status === STOCKTAKE_RETURNED && sheet.returnedReason && <p className="text-xs text-rose-700">Lý do trả lại: {sheet.returnedReason}</p>}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {canCreate && isStocktakeEditable(sheet.status) && <button type="button" className="text-xs font-bold text-blue-700 hover:underline" onClick={() => editSheet(sheet)}>Sửa</button>}
                    {canApprove && sheet.status === STOCKTAKE_PENDING && (
                      <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => {
                        const reason = window.prompt(`Lý do trả lại phiếu ${sheet.code}:`, "");
                        if (!reason?.trim()) return;
                        void legacy({ method: "POST", body: JSON.stringify({ action: "RETURN_STOCKTAKE", stocktakeId: sheet.id, reason: reason.trim() }) }, `Đã trả lại phiếu ${sheet.code}.`);
                      }}>Trả lại</button>
                    )}
                    {canDelete && sheet.status !== STOCKTAKE_APPROVED && (
                      <button type="button" className="text-xs font-bold text-slate-400 hover:text-rose-600 hover:underline" onClick={() => {
                        if (!window.confirm(`Xoá phiếu đếm ${sheet.code}?`)) return;
                        void legacy({ method: "DELETE", url: `/api/inventory?type=STOCKTAKE&id=${encodeURIComponent(sheet.id)}` }, `Đã xoá phiếu ${sheet.code}.`);
                      }}>Xoá</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Bảng tổng hợp: mỗi mã một dòng, cột số đếm từng vị trí, tổng đếm, sổ sách, chênh lệch. */
function ConsolidatedTable({ locations, rows, unitCostCell }: {
  locations: Array<{ code: string; name: string }>;
  rows: PreviewRow[];
  unitCostCell: (row: PreviewRow) => React.ReactNode;
}) {
  const head = "px-3 py-2 font-bold whitespace-nowrap";
  const shortage = rows.filter((row) => row.varianceQuantity < 0).reduce((sum, row) => sum + row.varianceValue, 0);
  const surplus = rows.filter((row) => row.varianceQuantity > 0).reduce((sum, row) => sum + row.varianceValue, 0);
  return (
    <div className="overflow-x-auto max-h-[620px] overflow-y-auto custom-scrollbar border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
          <tr>
            <th className={`${head} text-left`}>Mã</th>
            <th className={`${head} text-left`}>Tên hàng</th>
            <th className={`${head} text-left`}>ĐVT</th>
            {locations.map((location) => <th key={location.code} className={`${head} text-right`}>{location.name}</th>)}
            <th className={`${head} text-right`}>Tổng kiểm kê</th>
            <th className={`${head} text-right`}>Sổ sách</th>
            <th className={`${head} text-right`}>Chênh lệch</th>
            <th className={`${head} text-right`}>Đơn giá</th>
            <th className={`${head} text-right`}>Giá trị lệch</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tone = Math.abs(row.varianceQuantity) <= EPSILON ? "text-slate-500" : row.varianceQuantity > 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold";
            return (
              <tr key={row.itemId} className={`border-t border-slate-100 ${row.notCounted ? "bg-rose-50/50" : ""}`}>
                <td className="cell whitespace-nowrap"><b>{row.itemCode}</b></td>
                <td className="cell">{row.itemName}{row.notCounted && <small className="block text-rose-700">Không vị trí nào đếm — tính 0</small>}</td>
                <td className="cell">{row.unit}</td>
                {locations.map((location) => <td key={location.code} className="cell text-right tabular-nums">{row.breakdown[location.code] !== undefined ? qty(row.breakdown[location.code]) : ""}</td>)}
                <td className="cell text-right tabular-nums font-bold">{qty(row.countedQuantity)}</td>
                <td className="cell text-right tabular-nums">{qty(row.bookQuantity)}</td>
                <td className={`cell text-right tabular-nums ${tone}`}>{qty(row.varianceQuantity)}</td>
                <td className="cell text-right tabular-nums">{unitCostCell(row)}</td>
                <td className={`cell text-right tabular-nums ${tone}`}>{money(row.varianceValue)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="sticky bottom-0 bg-slate-50 font-bold border-t-2 border-slate-300">
          <tr>
            <td className="cell" colSpan={3 + locations.length + 3}>Cộng {rows.length} mã · Thiếu {money(shortage)} · Thừa {money(surplus)}</td>
            <td className="cell" />
            <td className="cell text-right tabular-nums">{money(shortage + surplus)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
