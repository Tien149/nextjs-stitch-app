"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDeleteDialog } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import CopyableText from "@/components/CopyableText";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { money, quantity as qty, unitPrice as formatUnitPrice } from "@/lib/format-number";
import { VAT_RATE_OPTIONS, vatAmountOf, vatRateLabel } from "@/lib/inventory-vat";
import {
  PRICE_IMPORT_HEADERS,
  activePrices,
  lastDayOfMonth,
  priceListInMonth,
  priceListStatus,
  priceListWindow,
  stockUnitPriceOf,
  type PriceListLike,
} from "@/lib/supplier-price-list";
import type { DemoSession } from "@/lib/auth-demo";

/**
 * Tab "Bảng giá NCC" (khách yêu cầu 03/10/2026): giá mua theo từng NCC × khoảng hiệu lực (thường
 * theo tháng), không phụ thuộc yêu cầu mua. Bốn phần: danh sách bảng giá (xem chi tiết hiệu lực
 * từ – đến), import Excel nhiều NCC / nhiều tháng một lần, so sánh giá giữa các NCC, và đối chiếu
 * phiếu nhập mua lệch bảng giá. Luật chọn giá hiệu lực ở lib/supplier-price-list.ts.
 */

type Item = { id: string; code: string; name: string; unit: string; unitConversions?: Array<{ unitCode: string; conversionRate: number }> };
type Supplier = { code: string; name: string };
type PriceListLine = { itemId: string; unitCode: string; conversionRate: number; unitPrice: number; vatRate: number | null; note: string | null };
type PriceList = Omit<PriceListLike, "lines"> & { note: string | null; source: string; createdBy: string | null; updatedAt: string; lines: PriceListLine[] };
type DeviationRow = {
  transactionId: string; code: string; date: string; branchCode: string; warehouseCode: string; supplierCode: string;
  itemCode: string; itemName: string; unit: string; quantity: number; actualPrice: number; listPrice: number;
  diff: number; ratio: number | null; amount: number; priceListCode: string; listUnitCode: string; listUnitPrice: number;
  vatRate: number | null; actualVatRate: number | null;
};

type Props = {
  user: DemoSession | null;
  canCreate: boolean;
  canDelete: boolean;
  items: Item[];
  suppliers: Supplier[];
  notify: (message: string) => void;
};

type View = "lists" | "compare" | "deviations";
type FormLine = { key: number; itemId: string; unitCode: string; unitPrice: string; vatRate: string; note: string };
type FormState = { id: string | null; supplierCode: string; branchCode: string; from: string; to: string; note: string; lines: FormLine[] };

const todayDay = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const thisMonth = () => todayDay().slice(0, 7);
const dayText = (day: string | null) => (day ? day.split("-").reverse().join("/") : "");
const nextMonth = (month: string) => {
  const [year, index] = month.split("-").map(Number);
  return index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
};
const STATUS_LABEL = { ACTIVE: "Đang áp dụng", UPCOMING: "Sắp áp dụng", EXPIRED: "Hết hiệu lực" } as const;
const STATUS_TONE = { ACTIVE: "bg-emerald-50 text-emerald-700", UPCOMING: "bg-sky-50 text-sky-700", EXPIRED: "bg-slate-100 text-slate-500" } as const;

let lineKey = 1;
const emptyLine = (): FormLine => ({ key: lineKey++, itemId: "", unitCode: "", unitPrice: "", vatRate: "KKKNT", note: "" });
const emptyForm = (): FormState => {
  const month = thisMonth();
  return { id: null, supplierCode: "", branchCode: "", from: `${month}-01`, to: lastDayOfMonth(month), note: "", lines: [emptyLine()] };
};

export function PriceListsTab({ user, canCreate, canDelete, items, suppliers, notify }: Props) {
  const [view, setView] = useState<View>("lists");
  const [lists, setLists] = useState<PriceList[] | null>(null);
  const [filters, setFilters] = useState({ month: thisMonth(), supplierCode: "", branchCode: "ALL", status: "ALL", search: "" });
  const [detail, setDetail] = useState<PriceList | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<PriceList | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importState, setImportState] = useState<{ fileName: string; rows: Array<Record<string, unknown>>; result: ImportResult | null; busy: boolean } | null>(null);
  const [compareDay, setCompareDay] = useState(todayDay());
  const [deviations, setDeviations] = useState<{ rows: DeviationRow[]; checked: number; uncovered: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const storeOptions = visibleStoreOptions(user);
  const canAllStores = Boolean(user?.allowedBranches?.includes("ALL"));
  const today = todayDay();

  const load = useCallback(async () => {
    const response = await fetch("/api/procurement?view=price-lists");
    const payload = await response.json().catch(() => ({}));
    setLists(response.ok ? (payload.priceLists as PriceList[]) : []);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const keyword = filters.search.trim().toLowerCase();
  const filtered = (lists || []).filter((list) => {
    if (filters.month && !priceListInMonth(list, filters.month)) return false;
    if (filters.supplierCode && list.supplierCode !== filters.supplierCode) return false;
    if (filters.branchCode !== "ALL" && list.branchCode && list.branchCode !== filters.branchCode) return false;
    if (filters.status !== "ALL" && priceListStatus(list, today) !== filters.status) return false;
    if (keyword && !list.lines.some((line) => {
      const item = itemById.get(line.itemId);
      return item && (item.code.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword));
    }) && !`${list.code} ${list.supplierName} ${list.supplierCode}`.toLowerCase().includes(keyword)) return false;
    return true;
  });
  const supplierOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const supplier of suppliers) map.set(supplier.code, supplier.name);
    for (const list of lists || []) if (!map.has(list.supplierCode)) map.set(list.supplierCode, list.supplierName);
    return [...map.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [suppliers, lists]);

  // ---------- Form tạo / sửa ----------
  const openCreate = () => { setFormError(""); setForm(emptyForm()); };
  const toForm = (list: PriceList, copyToNextMonth = false): FormState => {
    const window = priceListWindow(list);
    const month = copyToNextMonth ? nextMonth((window.to || window.from).slice(0, 7)) : null;
    return {
      id: copyToNextMonth ? null : list.id,
      supplierCode: list.supplierCode,
      branchCode: list.branchCode || "",
      from: month ? `${month}-01` : window.from,
      to: month ? lastDayOfMonth(month) : window.to || "",
      note: copyToNextMonth ? "" : list.note || "",
      lines: list.lines.map((line) => ({ key: lineKey++, itemId: line.itemId, unitCode: line.unitCode, unitPrice: String(line.unitPrice), vatRate: vatRateLabel(line.vatRate), note: line.note || "" })),
    };
  };
  const unitOptions = (itemId: string) => {
    const item = itemById.get(itemId);
    if (!item) return [];
    return [{ unitCode: item.unit.toUpperCase(), conversionRate: 1 }, ...(item.unitConversions || []).map((conversion) => ({ unitCode: conversion.unitCode.toUpperCase(), conversionRate: conversion.conversionRate }))]
      .filter((option, index, all) => all.findIndex((other) => other.unitCode === option.unitCode) === index);
  };
  const updateLine = (key: number, patch: Partial<FormLine>) => setForm((current) => current && { ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) });

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || saving) return;
    setFormError("");
    if (!form.supplierCode) return setFormError("Chọn nhà cung cấp.");
    if (!form.from) return setFormError("Chọn ngày bắt đầu áp dụng.");
    const lines = form.lines.filter((line) => line.itemId);
    if (lines.length === 0) return setFormError("Thêm ít nhất một mặt hàng.");
    const badLine = lines.findIndex((line) => line.unitPrice === "" || !(Number(line.unitPrice) >= 0));
    if (badLine >= 0) return setFormError(`Dòng ${badLine + 1}: nhập đơn giá trước thuế.`);
    setSaving(true);
    try {
      const response = await fetch("/api/procurement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SAVE_PRICE_LIST", ...form, lines: lines.map((line) => ({ itemId: line.itemId, unitCode: line.unitCode, unitPrice: Number(line.unitPrice), vatRate: line.vatRate, note: line.note })) }),
      });
      const payload = await response.json();
      if (!response.ok) return setFormError(payload.error || "Không lưu được bảng giá.");
      notify(`Đã lưu bảng giá ${payload.code}.`);
      setForm(null);
      await load();
    } catch {
      setFormError("Mất kết nối máy chủ.");
    } finally {
      setSaving(false);
    }
  };

  // ---------- Xoá ----------
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteError(null);
    const response = await fetch(`/api/procurement?type=PRICE_LIST&id=${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return setDeleteError(payload.error || "Không xoá được bảng giá.");
    notify(`Đã chuyển bảng giá ${deleting.code} vào Thùng rác.`);
    setDeleting(null);
    if (detail?.id === deleting.id) setDetail(null);
    await load();
  };

  // ---------- Import ----------
  const downloadTemplate = async () => {
    const XLSX = await import("xlsx");
    const sample = items.slice(0, 2);
    const month = thisMonth();
    const rows = [
      [...PRICE_IMPORT_HEADERS],
      ...sample.map((item, index) => [suppliers[0]?.code || "NCC_MA", suppliers[0]?.name || "Tên NCC (tham khảo)", `${month.slice(5)}/${month.slice(0, 4)}`, "", "", "", item.code, item.name, item.unit, index === 0 ? 120000 : 45000, index === 0 ? "10%" : "8%", ""]),
    ];
    const guide = [
      ["Cột", "Cách ghi"],
      ["Mã NCC", "Bắt buộc — mã đối tác trong danh mục Đối tác."],
      ["Tên NCC", "Chỉ để tham khảo, không đọc."],
      ["Tháng áp dụng", "Ghi 10/2026 = áp dụng từ ngày 1 tới cuối tháng. Bỏ trống nếu ghi Từ ngày / Đến ngày."],
      ["Từ ngày / Đến ngày", "dd/mm/yyyy — ghi đè Tháng áp dụng. Bỏ trống Đến ngày = áp dụng tới khi có bảng giá mới."],
      ["Cửa hàng", "Bỏ trống = áp cho mọi cửa hàng; ghi mã cửa hàng = chỉ cửa hàng đó (ưu tiên hơn bảng chung)."],
      ["Mã hàng / Tên hàng", "Mã hàng bắt buộc; Tên hàng chỉ để tham khảo."],
      ["ĐVT", "ĐVT báo giá: ĐVT tồn kho hoặc ĐVT quy đổi đã khai cho mặt hàng (THÙNG, KG...). Trống = ĐVT tồn kho."],
      ["Đơn giá trước thuế", "Theo ĐVT ở cột trước."],
      ["Thuế suất", "KKKNT, 0%, 5%, 8%, 10%."],
      ["", "Một file ghi được nhiều NCC, nhiều tháng. Cùng NCC + cửa hàng + khoảng ngày đã có bảng giá thì import lại sẽ GHI ĐÈ bảng đó."],
    ];
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [12, 28, 14, 12, 12, 10, 16, 32, 8, 18, 10, 24].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, "Bang gia NCC");
    const guideSheet = XLSX.utils.aoa_to_sheet(guide);
    guideSheet["!cols"] = [{ wch: 22 }, { wch: 110 }];
    XLSX.utils.book_append_sheet(workbook, guideSheet, "Huong dan");
    XLSX.writeFile(workbook, "mau_bang_gia_ncc.xlsx");
  };

  const runImport = async (rows: Array<Record<string, unknown>>, commit: boolean) => {
    const response = await fetch("/api/procurement", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "IMPORT_PRICE_LISTS", rows, commit }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { committed: false, groups: [], errors: [{ row: 0, message: payload.error || "Không import được file." }], errorCount: 1 } as ImportResult;
    return payload as ImportResult;
  };
  const pickFile = async (file: File) => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true });
    // Date của SheetJS mang giờ máy người dùng — đổi về chuỗi ngày để máy chủ khỏi lệch múi giờ.
    const cleaned = rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : value])));
    setImportState({ fileName: file.name, rows: cleaned, result: null, busy: true });
    const result = await runImport(cleaned, false);
    setImportState({ fileName: file.name, rows: cleaned, result, busy: false });
  };
  const commitImport = async () => {
    if (!importState) return;
    setImportState({ ...importState, busy: true });
    const result = await runImport(importState.rows, true);
    if (result.committed) {
      notify(`Đã import ${result.groups.length} bảng giá: ${(result.codes || []).join(", ")}.`);
      setImportState(null);
      await load();
    } else {
      setImportState({ ...importState, result, busy: false });
    }
  };

  // ---------- So sánh giá ----------
  const comparison = view !== "compare" ? { supplierList: [] as Array<[string, string]>, rows: [] as Array<{ item: Item | undefined; itemId: string; map: Map<string, ReturnType<ReturnType<typeof activePrices>["get"]>> }> } : (() => {
    const branchCode = filters.branchCode === "ALL" ? null : filters.branchCode;
    const prices = activePrices((lists || []) as unknown as PriceListLike[], { day: compareDay, branchCode });
    const suppliersInUse = new Map<string, string>();
    const byItem = new Map<string, Map<string, ReturnType<typeof prices.get>>>();
    for (const price of prices.values()) {
      if (filters.supplierCode && price.supplierCode !== filters.supplierCode) continue;
      const item = itemById.get(price.itemId);
      if (keyword && item && !item.code.toLowerCase().includes(keyword) && !item.name.toLowerCase().includes(keyword)) continue;
      suppliersInUse.set(price.supplierCode, price.supplierName);
      const row = byItem.get(price.itemId) || new Map();
      row.set(price.supplierCode, price);
      byItem.set(price.itemId, row);
    }
    const supplierList = [...suppliersInUse.entries()].sort((a, b) => a[1].localeCompare(b[1], "vi"));
    const rows = [...byItem.entries()]
      .map(([itemId, map]) => ({ item: itemById.get(itemId), itemId, map }))
      .sort((a, b) => (a.item?.code || a.itemId).localeCompare(b.item?.code || b.itemId));
    return { supplierList, rows };
  })();

  // ---------- Lệch giá nhập mua ----------
  const loadDeviations = useCallback(async () => {
    setDeviations(null);
    const query = new URLSearchParams({ view: "price-deviations", month: filters.month || thisMonth(), branchCode: filters.branchCode });
    if (filters.supplierCode) query.set("supplierCode", filters.supplierCode);
    const response = await fetch(`/api/procurement?${query.toString()}`);
    const payload = await response.json().catch(() => ({}));
    setDeviations(response.ok ? payload : { rows: [], checked: 0, uncovered: 0 });
    if (!response.ok) notify(payload.error || "Không tải được đối chiếu giá nhập.");
  }, [filters.month, filters.branchCode, filters.supplierCode, notify]);
  useEffect(() => {
    if (view !== "deviations") return;
    const timer = window.setTimeout(() => void loadDeviations(), 0);
    return () => window.clearTimeout(timer);
  }, [view, loadDeviations]);

  const exportDetail = async (list: PriceList) => {
    const XLSX = await import("xlsx");
    const window = priceListWindow(list);
    const aoa: Array<Array<string | number>> = [
      [`BẢNG GIÁ ${list.supplierName.toUpperCase()} (${list.supplierCode}) — ${list.code}`],
      [`Áp dụng từ ${dayText(window.from)} đến ${window.to ? dayText(window.to) : "khi có bảng giá mới"} — ${list.branchCode ? storeLabel(list.branchCode) : "mọi cửa hàng"}`],
      ["STT", "Mã hàng", "Tên hàng", "ĐVT", "Đơn giá trước thuế", "Thuế suất", "Tiền thuế", "Đơn giá sau thuế", "Ghi chú"],
      ...list.lines.map((line, index) => {
        const item = itemById.get(line.itemId);
        const vat = vatAmountOf(line.unitPrice, line.vatRate);
        return [index + 1, item?.code || "", item?.name || "", line.unitCode, line.unitPrice, vatRateLabel(line.vatRate), vat, line.unitPrice + vat, line.note || ""];
      }),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 8 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 8 } }];
    sheet["!cols"] = [6, 16, 34, 8, 16, 10, 14, 16, 24].map((wch) => ({ wch }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Bang gia");
    XLSX.writeFile(workbook, `bang_gia_${list.code}.xlsx`);
  };

  return (
    <div className="space-y-4">
      <section className="table-panel shadow-sm p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {([["lists", "Danh sách bảng giá", "list_alt"], ["compare", "So sánh giá NCC", "compare_arrows"], ["deviations", "Nhập mua lệch giá", "warning"]] as const).map(([id, label, icon]) => (
              <button key={id} type="button" onClick={() => setView(id)} className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md ${view === id ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                <span className="material-symbols-outlined text-[16px]">{icon}</span>{label}
              </button>
            ))}
          </div>
          {canCreate && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void downloadTemplate()} className="secondary-button bg-white"><span className="material-symbols-outlined text-lg">description</span>File mẫu</button>
              <button type="button" onClick={() => fileRef.current?.click()} className="secondary-button bg-white"><span className="material-symbols-outlined text-lg">upload_file</span>Import Excel</button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void pickFile(file); }} />
              <button type="button" onClick={openCreate} className="primary-button"><span className="material-symbols-outlined text-lg">add</span>Tạo bảng giá</button>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
          <label className="text-xs font-bold text-slate-500">{view === "compare" ? "Ngày so sánh" : "Tháng"}
            {view === "compare"
              ? <input type="date" className="control mt-1" value={compareDay} onChange={(e) => setCompareDay(e.target.value || todayDay())} />
              : <input type="month" className="control mt-1" value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })} />}
          </label>
          <label className="text-xs font-bold text-slate-500">Nhà cung cấp
            <select className="control mt-1" value={filters.supplierCode} onChange={(e) => setFilters({ ...filters, supplierCode: e.target.value })}>
              <option value="">Tất cả NCC</option>
              {supplierOptions.map((supplier) => <option key={supplier.code} value={supplier.code}>{supplier.name} ({supplier.code})</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Cửa hàng
            <select className="control mt-1" value={filters.branchCode} onChange={(e) => setFilters({ ...filters, branchCode: e.target.value })}>
              <option value="ALL">Tất cả cửa hàng</option>
              {storeOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
            </select>
          </label>
          {view === "lists" && (
            <label className="text-xs font-bold text-slate-500">Trạng thái
              <select className="control mt-1" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="ALL">Tất cả</option>
                <option value="ACTIVE">Đang áp dụng</option>
                <option value="UPCOMING">Sắp áp dụng</option>
                <option value="EXPIRED">Hết hiệu lực</option>
              </select>
            </label>
          )}
          <label className="text-xs font-bold text-slate-500">Tìm mặt hàng / mã bảng giá
            <input className="control mt-1" value={filters.search} placeholder="Mã hoặc tên..." onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </label>
        </div>
      </section>

      {view === "lists" && (
        <section className="table-panel shadow-sm">
          <div className="p-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-800">Bảng giá NCC</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {lists === null ? "Đang tải..." : `${filtered.length} bảng giá${filters.month ? ` có hiệu lực trong tháng ${filters.month.slice(5)}/${filters.month.slice(0, 4)}` : ""}.`}
                {" "}Nhiều bảng cùng phủ một ngày: bảng riêng cửa hàng thắng bảng chung, rồi bảng bắt đầu muộn hơn.
              </p>
            </div>
            <button type="button" title="Tải lại" onClick={() => void load()} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
          </div>
          <div className="overflow-x-auto max-h-[620px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  {["Mã bảng giá", "Nhà cung cấp", "Cửa hàng", "Áp dụng từ", "Đến", "Trạng thái", "Số mặt hàng", "Nguồn", "Thao tác"].map((label, index) => (
                    <th key={label} className={`px-4 py-3 font-bold whitespace-nowrap ${index === 6 ? "text-right" : index === 8 ? "text-right" : "text-left"}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lists !== null && filtered.length === 0 && <tr><td colSpan={9} className="cell text-center text-slate-400">Chưa có bảng giá khớp bộ lọc. Bấm Tạo bảng giá hoặc Import Excel.</td></tr>}
                {filtered.map((list) => {
                  const window = priceListWindow(list);
                  const status = priceListStatus(list, today);
                  return (
                    <tr key={list.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                      <td className="cell whitespace-nowrap"><button type="button" onClick={() => setDetail(list)} className="font-bold text-blue-700 hover:underline">{list.code}</button></td>
                      <td className="cell"><b>{list.supplierName}</b><small>{list.supplierCode}</small></td>
                      <td className="cell whitespace-nowrap">{list.branchCode ? storeLabel(list.branchCode) : <span className="text-slate-500">Mọi cửa hàng</span>}</td>
                      <td className="cell whitespace-nowrap">{dayText(window.from)}</td>
                      <td className="cell whitespace-nowrap">{window.to ? dayText(window.to) : <span className="text-slate-500">Tới khi có bảng mới</span>}</td>
                      <td className="cell"><span className={`status ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span></td>
                      <td className="cell text-right tabular-nums">{list.lines.length}</td>
                      <td className="cell whitespace-nowrap text-xs text-slate-500">{list.source === "IMPORT" ? "Import Excel" : "Nhập tay"}{list.createdBy ? ` · ${list.createdBy}` : ""}</td>
                      <td className="cell">
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                          <button type="button" onClick={() => setDetail(list)} className="action-link text-blue-700 hover:underline">Xem</button>
                          {canCreate && <button type="button" onClick={() => { setFormError(""); setForm(toForm(list)); }} className="action-link text-slate-700 hover:underline">Sửa</button>}
                          {canCreate && <button type="button" onClick={() => { setFormError(""); setForm(toForm(list, true)); }} className="action-link text-emerald-700 hover:underline" title="Tạo bảng giá tháng sau từ bảng này (sửa giá rồi lưu)">Sao chép tháng sau</button>}
                          {canDelete && <button type="button" onClick={() => { setDeleteError(null); setDeleting(list); }} className="action-link text-rose-700 hover:underline">Xoá</button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === "compare" && (
        <section className="table-panel shadow-sm">
          <div className="p-4">
            <h2 className="font-bold text-slate-800">So sánh giá giữa các NCC ngày {dayText(compareDay)}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Giá trước thuế quy về ĐVT tồn kho để so được NCC báo theo thùng với NCC báo theo lon. Ô xanh = rẻ nhất. Dòng nhỏ là giá gốc theo ĐVT báo giá và thuế suất.</p>
          </div>
          <div className="overflow-x-auto max-h-[620px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-left font-bold uppercase">Mặt hàng</th>
                  <th className="px-4 py-3 text-left font-bold uppercase">ĐVT tồn</th>
                  {comparison.supplierList.map(([code, name]) => <th key={code} className="px-4 py-3 text-right font-bold whitespace-nowrap">{name}<small className="block font-normal text-slate-400">{code}</small></th>)}
                  <th className="px-4 py-3 text-right font-bold uppercase whitespace-nowrap">Chênh cao – thấp</th>
                </tr>
              </thead>
              <tbody>
                {comparison.rows.length === 0 && <tr><td colSpan={3 + comparison.supplierList.length} className="cell text-center text-slate-400">Không có bảng giá nào hiệu lực ngày này.</td></tr>}
                {comparison.rows.map(({ item, itemId, map }) => {
                  const values = [...map.values()].map((price) => price!.stockUnitPrice);
                  const min = Math.min(...values);
                  const max = Math.max(...values);
                  return (
                    <tr key={itemId} className="border-t border-slate-100">
                      <td className="cell"><b>{item?.code || itemId}</b><small>{item?.name}</small></td>
                      <td className="cell">{item?.unit}</td>
                      {comparison.supplierList.map(([code]) => {
                        const price = map.get(code);
                        if (!price) return <td key={code} className="cell text-right text-slate-300">-</td>;
                        const best = values.length > 1 && price.stockUnitPrice === min;
                        return (
                          <td key={code} className={`cell text-right tabular-nums whitespace-nowrap ${best ? "bg-emerald-50 text-emerald-800 font-bold" : ""}`}>
                            {formatUnitPrice(price.stockUnitPrice)} đ
                            <small className="block font-normal text-slate-500">{money(price.unitPrice)} đ/{price.unitCode} · {vatRateLabel(price.vatRate)} · {price.priceListCode}</small>
                          </td>
                        );
                      })}
                      <td className="cell text-right tabular-nums whitespace-nowrap">{values.length > 1 ? <>{formatUnitPrice(max - min)} đ<small className="block text-slate-500">{min > 0 ? `${(((max - min) / min) * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%` : ""}</small></> : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {view === "deviations" && (
        <section className="table-panel shadow-sm">
          <div className="p-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-slate-800">Phiếu nhập mua lệch bảng giá — tháng {(filters.month || thisMonth()).slice(5)}/{(filters.month || thisMonth()).slice(0, 4)}</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                So đơn giá trước thuế (theo ĐVT tồn) của từng dòng phiếu Nhập mua với bảng giá của đúng NCC + cửa hàng đang hiệu lực ngày chứng từ. Lệch dưới 1 đ hoặc 0,5% coi là khớp.
                {deviations && <> Đã đối chiếu <b>{deviations.checked}</b> dòng · lệch <b className="text-rose-700">{deviations.rows.length}</b> · <b>{deviations.uncovered}</b> dòng chưa có bảng giá để so.</>}
              </p>
            </div>
            <button type="button" title="Tải lại" onClick={() => void loadDeviations()} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
          </div>
          <div className="overflow-x-auto max-h-[620px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  {["Ngày", "Phiếu nhập", "Cửa hàng / kho", "NCC", "Mặt hàng", "SL", "Giá nhập", "Giá bảng giá", "Chênh / ĐVT", "Tiền chênh", "Bảng giá"].map((label, index) => (
                    <th key={label} className={`px-4 py-3 font-bold whitespace-nowrap ${index >= 5 && index <= 9 ? "text-right" : "text-left"}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deviations === null && <tr><td colSpan={11} className="cell text-center text-slate-400">Đang đối chiếu...</td></tr>}
                {deviations && deviations.rows.length === 0 && <tr><td colSpan={11} className="cell text-center text-slate-400">Không có dòng nhập mua nào lệch bảng giá.</td></tr>}
                {deviations?.rows.map((row, index) => (
                  <tr key={`${row.transactionId}-${row.itemCode}-${index}`} className="border-t border-slate-100">
                    <td className="cell whitespace-nowrap">{dayText(row.date)}</td>
                    <td className="cell whitespace-nowrap"><CopyableText value={row.code}><b>{row.code}</b></CopyableText></td>
                    <td className="cell whitespace-nowrap">{storeLabel(row.branchCode)}<small>{row.warehouseCode}</small></td>
                    <td className="cell whitespace-nowrap">{row.supplierCode}</td>
                    <td className="cell"><b>{row.itemCode}</b><small>{row.itemName}</small></td>
                    <td className="cell text-right tabular-nums whitespace-nowrap">{qty(row.quantity)} {row.unit}</td>
                    <td className="cell text-right tabular-nums whitespace-nowrap">{formatUnitPrice(row.actualPrice)} đ</td>
                    <td className="cell text-right tabular-nums whitespace-nowrap">{formatUnitPrice(row.listPrice)} đ<small className="block text-slate-500">{money(row.listUnitPrice)} đ/{row.listUnitCode}</small></td>
                    <td className={`cell text-right tabular-nums whitespace-nowrap font-bold ${row.diff > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                      {row.diff > 0 ? "+" : ""}{formatUnitPrice(row.diff)} đ
                      {row.ratio !== null && <small className="block font-normal">{row.diff > 0 ? "+" : ""}{(row.ratio * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%</small>}
                    </td>
                    <td className={`cell text-right tabular-nums whitespace-nowrap ${row.amount > 0 ? "text-rose-700" : "text-emerald-700"}`}>{row.amount > 0 ? "+" : ""}{money(row.amount)} đ</td>
                    <td className="cell whitespace-nowrap text-xs">{row.priceListCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {detail && (() => {
        const window = priceListWindow(detail);
        const status = priceListStatus(detail, today);
        return (
          <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
            <div className="bg-white rounded-xl w-full max-w-6xl shadow-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="p-5 border-b border-slate-200 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-slate-900 text-lg">{detail.code} — {detail.supplierName}</h3>
                  <p className="text-sm text-slate-600 mt-1">
                    Áp dụng từ <b>{dayText(window.from)}</b> đến <b>{window.to ? dayText(window.to) : "khi có bảng giá mới"}</b>
                    {" · "}{detail.branchCode ? storeLabel(detail.branchCode) : "Mọi cửa hàng"}
                    {" · "}<span className={`status ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
                  </p>
                  <p className="text-xs text-slate-500 mt-1">{detail.source === "IMPORT" ? "Import Excel" : "Nhập tay"}{detail.createdBy ? ` bởi ${detail.createdBy}` : ""} · cập nhật {new Date(detail.updatedAt).toLocaleString("vi-VN")}{detail.note ? ` · ${detail.note}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void exportDetail(detail)} className="secondary-button bg-white"><span className="material-symbols-outlined text-lg">download</span>Xuất Excel</button>
                  <button type="button" onClick={() => setDetail(null)} className="icon-button"><span className="material-symbols-outlined">close</span></button>
                </div>
              </div>
              <div className="overflow-auto custom-scrollbar">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0">
                    <tr>
                      {["STT", "Mã hàng", "Tên hàng", "ĐVT", "Đơn giá trước thuế", "Thuế suất", "Tiền thuế", "Đơn giá sau thuế", "Giá / ĐVT tồn", "Ghi chú"].map((label, index) => (
                        <th key={label} className={`px-4 py-3 font-bold whitespace-nowrap ${index >= 4 && index <= 8 ? "text-right" : "text-left"}`}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line, index) => {
                      const item = itemById.get(line.itemId);
                      const vat = vatAmountOf(line.unitPrice, line.vatRate);
                      return (
                        <tr key={`${line.itemId}-${line.unitCode}`} className="border-t border-slate-100">
                          <td className="cell">{index + 1}</td>
                          <td className="cell whitespace-nowrap font-bold">{item?.code || line.itemId}</td>
                          <td className="cell">{item?.name}</td>
                          <td className="cell">{line.unitCode}</td>
                          <td className="cell text-right tabular-nums">{money(line.unitPrice)}</td>
                          <td className="cell text-right">{vatRateLabel(line.vatRate)}</td>
                          <td className="cell text-right tabular-nums">{money(vat)}</td>
                          <td className="cell text-right tabular-nums font-bold">{money(line.unitPrice + vat)}</td>
                          <td className="cell text-right tabular-nums text-slate-500">{formatUnitPrice(stockUnitPriceOf(line))} đ/{item?.unit}</td>
                          <td className="cell">{line.note}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {form && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <form onSubmit={submitForm} className="bg-white rounded-xl w-full max-w-6xl shadow-xl max-h-[92vh] flex flex-col">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="font-bold text-slate-900 text-lg">{form.id ? "Sửa bảng giá" : "Tạo bảng giá NCC"}</h3>
              <button type="button" onClick={() => setForm(null)} className="icon-button"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="p-5 space-y-4 overflow-y-auto custom-scrollbar">
              <div className="grid md:grid-cols-6 gap-3">
                <div className="md:col-span-2 text-xs font-bold text-slate-500">Nhà cung cấp
                  <SearchableSelect className="mt-1" value={form.supplierCode} onChange={(code) => setForm({ ...form, supplierCode: code })} placeholder="-- Chọn NCC --" options={supplierOptions.map((supplier) => ({ value: supplier.code, label: `${supplier.name} (${supplier.code})` }))} />
                </div>
                <label className="text-xs font-bold text-slate-500">Cửa hàng
                  <select className="control mt-1" value={form.branchCode} onChange={(e) => setForm({ ...form, branchCode: e.target.value })}>
                    {canAllStores && <option value="">Mọi cửa hàng</option>}
                    {storeOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-500">Áp dụng cả tháng
                  <input type="month" className="control mt-1" value={form.from.slice(0, 7)} onChange={(e) => e.target.value && setForm({ ...form, from: `${e.target.value}-01`, to: lastDayOfMonth(e.target.value) })} />
                </label>
                <label className="text-xs font-bold text-slate-500">Từ ngày
                  <input type="date" className="control mt-1" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} required />
                </label>
                <label className="text-xs font-bold text-slate-500">Đến ngày
                  <input type="date" className="control mt-1" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} title="Bỏ trống = áp dụng tới khi có bảng giá mới" />
                </label>
              </div>
              <label className="block text-xs font-bold text-slate-500">Ghi chú
                <input className="control mt-1" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="vd: Báo giá tháng 10, giao trong 2 ngày" />
              </label>

              <div className="border border-slate-200 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200">
                    <tr>
                      {["#", "Mặt hàng", "ĐVT", "Đơn giá trước thuế", "Thuế suất", "Tiền thuế", "Đơn giá sau thuế", "Ghi chú", ""].map((label, index) => (
                        <th key={index} className={`px-3 py-2 font-bold whitespace-nowrap ${index >= 3 && index <= 6 ? "text-right" : "text-left"}`}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {form.lines.map((line, index) => {
                      const units = unitOptions(line.itemId);
                      const vatOption = VAT_RATE_OPTIONS.find((option) => option.code === line.vatRate);
                      const price = Number(line.unitPrice) || 0;
                      const vat = vatAmountOf(price, vatOption?.rate ?? null);
                      return (
                        <tr key={line.key} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2 text-slate-400">{index + 1}</td>
                          <td className="px-3 py-2 min-w-[280px]">
                            <SearchableSelect
                              value={line.itemId}
                              onChange={(itemId) => updateLine(line.key, { itemId, unitCode: itemById.get(itemId)?.unit.toUpperCase() || "" })}
                              placeholder="-- Chọn mặt hàng --"
                              options={items.map((item) => ({ value: item.id, label: `${item.code} - ${item.name}` }))}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select className="control !mt-0 min-w-[90px]" value={line.unitCode} onChange={(e) => updateLine(line.key, { unitCode: e.target.value })} disabled={!line.itemId}>
                              {units.map((unit) => <option key={unit.unitCode} value={unit.unitCode}>{unit.unitCode}{unit.conversionRate !== 1 ? ` (=${qty(unit.conversionRate)})` : ""}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2"><input type="number" min="0" step="any" inputMode="decimal" className="control !mt-0 w-36 text-right" value={line.unitPrice} onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })} /></td>
                          <td className="px-3 py-2">
                            <select className="control !mt-0 w-24" value={line.vatRate} onChange={(e) => updateLine(line.key, { vatRate: e.target.value })}>
                              {VAT_RATE_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.code}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-slate-600 whitespace-nowrap">{money(vat)}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold whitespace-nowrap">{money(price + vat)}</td>
                          <td className="px-3 py-2"><input className="control !mt-0 min-w-[140px]" value={line.note} onChange={(e) => updateLine(line.key, { note: e.target.value })} /></td>
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => setForm({ ...form, lines: form.lines.length > 1 ? form.lines.filter((other) => other.key !== line.key) : form.lines })} className="icon-button" title="Bỏ dòng"><span className="material-symbols-outlined text-lg">delete</span></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={() => setForm({ ...form, lines: [...form.lines, emptyLine()] })} className="secondary-button bg-white"><span className="material-symbols-outlined text-lg">add</span>Thêm dòng</button>
              {formError && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{formError}</p>}
            </div>
            <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setForm(null)} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Huỷ</button>
              <button className="primary-button" disabled={saving}><span className="material-symbols-outlined text-lg">save</span>{saving ? "Đang lưu..." : "Lưu bảng giá"}</button>
            </div>
          </form>
        </div>
      )}

      {importState && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-4xl shadow-xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-lg">Import bảng giá NCC</h3>
                <p className="text-xs text-slate-500 mt-0.5">{importState.fileName} · {importState.rows.length} dòng</p>
              </div>
              <button type="button" onClick={() => setImportState(null)} className="icon-button"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
              {importState.busy && !importState.result && <p className="text-sm text-slate-500">Đang kiểm tra file...</p>}
              {importState.result && (
                <>
                  <div>
                    <h4 className="text-sm font-bold text-slate-700 mb-2">{importState.result.groups.length} bảng giá sẽ được ghi (cùng NCC + cửa hàng + khoảng ngày đã có thì ghi đè)</h4>
                    <table className="w-full text-sm border border-slate-200">
                      <thead className="bg-slate-50 text-xs text-slate-500 uppercase"><tr><th className="px-3 py-2 text-left">NCC</th><th className="px-3 py-2 text-left">Cửa hàng</th><th className="px-3 py-2 text-left">Áp dụng</th><th className="px-3 py-2 text-right">Số mặt hàng</th></tr></thead>
                      <tbody>
                        {importState.result.groups.map((group, index) => (
                          <tr key={index} className="border-t border-slate-100">
                            <td className="px-3 py-1.5"><b>{group.supplierName}</b> <small className="text-slate-500">{group.supplierCode}</small></td>
                            <td className="px-3 py-1.5">{group.branchCode ? storeLabel(group.branchCode) : "Mọi cửa hàng"}</td>
                            <td className="px-3 py-1.5">{dayText(group.from)} → {group.to ? dayText(group.to) : "khi có bảng mới"}</td>
                            <td className="px-3 py-1.5 text-right">{group.lineCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {importState.result.errorCount > 0 && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <h4 className="text-sm font-bold text-rose-800 mb-1">{importState.result.errorCount} lỗi — sửa file rồi chọn lại, chưa ghi gì</h4>
                      <ul className="text-xs text-rose-700 space-y-0.5 max-h-60 overflow-y-auto">
                        {importState.result.errors.map((error, index) => <li key={index}>{error.row ? `Dòng ${error.row}: ` : ""}{error.message}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setImportState(null)} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Đóng</button>
              <button type="button" onClick={() => void commitImport()} disabled={importState.busy || !importState.result || importState.result.errorCount > 0 || importState.result.groups.length === 0} className="primary-button disabled:bg-slate-300">
                <span className="material-symbols-outlined text-lg">upload</span>{importState.busy ? "Đang ghi..." : "Ghi bảng giá"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        title={`Xoá bảng giá ${deleting?.code || ""}?`}
        description={deleting ? `${deleting.supplierName} · ${deleting.lines.length} mặt hàng — chuyển vào Thùng rác, khôi phục được.` : undefined}
        error={deleteError}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

type ImportResult = {
  committed: boolean;
  groups: Array<{ supplierCode: string; supplierName: string; branchCode: string | null; from: string; to: string | null; lineCount: number }>;
  errors: Array<{ row: number; message: string }>;
  errorCount: number;
  codes?: string[];
};
