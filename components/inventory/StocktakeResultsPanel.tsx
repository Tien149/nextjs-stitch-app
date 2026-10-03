"use client";

import { useCallback, useEffect, useState } from "react";
import CopyableText from "@/components/CopyableText";
import ExportExcelButton from "@/components/ExportExcelButton";
import { money, quantity as qty, unitPrice } from "@/lib/format-number";
import { goodsGroupKey } from "@/lib/goods-group";

/**
 * Tab "Kết quả kiểm kê" (khách yêu cầu 03/10/2026): mọi đợt kiểm kê ĐÃ DUYỆT (duyệt gộp theo vị
 * trí lẫn kiểm cả kho) lọc theo nhà hàng / kho / tháng; mở một đợt xem sổ sách tại giờ chốt, số
 * kiểm, chênh lệch và giá trị lệch từng mặt hàng (lọc nhóm hàng hóa, chỉ dòng lệch).
 */
type Source = {
  sourceType: "BATCH" | "SESSION";
  sourceId: string;
  code: string;
  branchCode: string;
  warehouseCode: string;
  cutoffAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  lineCount: number;
  varianceRows: number;
  shortageValue: number;
  surplusValue: number;
};
type ResultLine = { itemId: string; itemCode: string; itemName: string; goodsGroup: string | null; unit: string; closing: number; counted: number; unitCost: number; variance: number; varianceValue: number };

type Props = {
  sessionKey: string;
  branchOptions: Array<{ code: string; label: string }>;
  warehouses: Array<{ code: string; name: string; branch: string | null }>;
  storeLabel: (code: string) => string;
};

function sessionHeaders(sessionKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(sessionKey);
  return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
}

const dateTime = (value: string | null | undefined) =>
  (value ? new Date(value).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

export default function StocktakeResultsPanel({ sessionKey, branchOptions, warehouses, storeLabel }: Props) {
  const [filters, setFilters] = useState({ branchCode: branchOptions[0]?.code || "ALL", warehouseCode: "", month: "" });
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Source | null>(null);
  const [lines, setLines] = useState<ResultLine[] | null>(null);
  const [lineFilter, setLineFilter] = useState({ group: "ALL", onlyVariance: true, search: "" });

  const load = useCallback(async () => {
    setError("");
    const query = new URLSearchParams({ view: "stocktake-sources", branchCode: filters.branchCode });
    if (filters.warehouseCode) query.set("warehouseCode", filters.warehouseCode);
    if (filters.month) query.set("month", filters.month);
    try {
      const response = await fetch(`/api/inventory?${query.toString()}`, { headers: sessionHeaders(sessionKey) });
      const payload = await response.json() as { sources?: Source[]; error?: string };
      if (!response.ok) setError(payload.error || "Không tải được kết quả kiểm kê");
      setSources(payload.sources || []);
    } catch {
      setError("Mất kết nối tới máy chủ.");
      setSources([]);
    }
  }, [filters, sessionKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openSource = async (source: Source) => {
    setSelected(source);
    setLines(null);
    const response = await fetch(`/api/inventory?view=stocktake-source-lines&sourceType=${source.sourceType}&sourceId=${encodeURIComponent(source.sourceId)}`, { headers: sessionHeaders(sessionKey) });
    const payload = await response.json() as { lines?: ResultLine[]; error?: string };
    if (!response.ok) setError(payload.error || "Không tải được chi tiết đợt kiểm kê");
    setLines((payload.lines || []).sort((a, b) => Math.abs(b.varianceValue) - Math.abs(a.varianceValue) || a.itemCode.localeCompare(b.itemCode)));
  };

  const warehouseOptions = warehouses.filter((warehouse) => filters.branchCode === "ALL" || warehouse.branch === filters.branchCode || !warehouse.branch);
  const groupOptions = [...new Map((lines || []).filter((line) => line.goodsGroup).map((line) => [goodsGroupKey(line.goodsGroup), line.goodsGroup as string])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "vi"));
  const keyword = lineFilter.search.trim().toLowerCase();
  const visibleLines = (lines || []).filter((line) => {
    if (lineFilter.onlyVariance && Math.abs(line.variance) <= 1e-6) return false;
    if (lineFilter.group === "MISSING" && line.goodsGroup) return false;
    if (!["ALL", "MISSING"].includes(lineFilter.group) && goodsGroupKey(line.goodsGroup) !== lineFilter.group) return false;
    return !keyword || line.itemCode.toLowerCase().includes(keyword) || line.itemName.toLowerCase().includes(keyword);
  });
  const shortage = visibleLines.filter((line) => line.varianceValue < 0).reduce((sum, line) => sum + line.varianceValue, 0);
  const surplus = visibleLines.filter((line) => line.varianceValue > 0).reduce((sum, line) => sum + line.varianceValue, 0);

  return (
    <div className="space-y-5">
      <section className="table-panel shadow-sm" data-export-root>
        <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800">Kết quả kiểm kê</h2>
            <p className="text-xs text-slate-500 mt-1">Các đợt kiểm kê đã duyệt — bấm <b>Xem</b> để mở chênh lệch từng mặt hàng.</p>
          </div>
          <div className="flex items-center gap-2">
            <ExportExcelButton fileName="ket_qua_kiem_ke_cac_dot" sheetName="Ket qua kiem ke" />
            <button type="button" title="Tải lại" onClick={() => void load()} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
          </div>
        </div>
        <div className="px-5 pb-4 grid grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="text-xs font-bold text-slate-500">Nhà hàng
            <select className="control mt-1" value={filters.branchCode} onChange={(e) => setFilters({ ...filters, branchCode: e.target.value, warehouseCode: "" })}>
              {branchOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Kho
            <select className="control mt-1" value={filters.warehouseCode} onChange={(e) => setFilters({ ...filters, warehouseCode: e.target.value })}>
              <option value="">Tất cả kho</option>
              {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Tháng chốt
            <input type="month" className="control mt-1" value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })} />
          </label>
        </div>
        {error && <p className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <div className="overflow-x-auto max-h-[360px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
              <tr>
                {["Đợt kiểm kê", "Nhà hàng", "Kho", "Giờ chốt", "Duyệt", "Số mã", "Mã lệch", "Thiếu", "Thừa", ""].map((label, index) => (
                  <th key={index} className={`px-4 py-3 font-bold whitespace-nowrap ${index >= 5 && index <= 8 ? "text-right" : "text-left"}`}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources === null && <tr><td colSpan={10} className="cell text-center text-slate-400">Đang tải...</td></tr>}
              {sources !== null && sources.length === 0 && <tr><td colSpan={10} className="cell text-center text-slate-400">Chưa có đợt kiểm kê nào đã duyệt khớp bộ lọc.</td></tr>}
              {(sources || []).map((source) => (
                <tr key={`${source.sourceType}|${source.sourceId}`} className={`border-t border-slate-100 ${selected?.sourceId === source.sourceId ? "bg-blue-50/60" : ""}`}>
                  <td className="cell whitespace-nowrap"><CopyableText value={source.code}><b>{source.code}</b></CopyableText><small className="block text-slate-500">{source.sourceType === "BATCH" ? "Duyệt gộp theo vị trí" : "Kiểm cả kho"}</small></td>
                  <td className="cell whitespace-nowrap">{storeLabel(source.branchCode)}</td>
                  <td className="cell whitespace-nowrap">{source.warehouseCode}</td>
                  <td className="cell whitespace-nowrap">{dateTime(source.cutoffAt)}</td>
                  <td className="cell whitespace-nowrap">{source.approvedBy || ""}<small className="block text-slate-500">{dateTime(source.approvedAt)}</small></td>
                  <td className="cell text-right tabular-nums">{source.lineCount}</td>
                  <td className="cell text-right tabular-nums">{source.varianceRows}</td>
                  <td className="cell text-right tabular-nums text-rose-700">{source.sourceType === "BATCH" ? money(source.shortageValue) : "-"}</td>
                  <td className="cell text-right tabular-nums text-emerald-700">{source.sourceType === "BATCH" ? money(source.surplusValue) : "-"}</td>
                  <td className="cell text-right" data-no-export><button type="button" className="secondary-button !min-h-8 !py-1" onClick={() => void openSource(source)}>Xem</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <section className="table-panel shadow-sm" data-export-root>
          <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-slate-800">Kết quả đợt {selected.code} — kho {selected.warehouseCode}</h2>
              <p className="text-xs text-slate-500 mt-1">{storeLabel(selected.branchCode)} · chốt {dateTime(selected.cutoffAt)} · duyệt {selected.approvedBy || ""} {dateTime(selected.approvedAt)}</p>
            </div>
            <div className="flex items-center gap-2">
              <ExportExcelButton fileName={`ket_qua_kiem_ke_${selected.code}`} sheetName="Ket qua kiem ke" />
              <button type="button" className="text-xs font-bold text-slate-500 hover:underline" onClick={() => setSelected(null)}>Đóng</button>
            </div>
          </div>
          <div className="px-5 pb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs font-bold text-slate-500">Nhóm hàng hóa
              <select className="control mt-1" value={lineFilter.group} onChange={(e) => setLineFilter({ ...lineFilter, group: e.target.value })}>
                <option value="ALL">Tất cả nhóm</option>
                <option value="MISSING">Chưa có nhóm</option>
                {groupOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-500">Tìm mã / tên
              <input className="control mt-1" value={lineFilter.search} onChange={(e) => setLineFilter({ ...lineFilter, search: e.target.value })} placeholder="Mã hoặc tên hàng..." />
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs font-bold text-slate-600">
              <input type="checkbox" checked={lineFilter.onlyVariance} onChange={(e) => setLineFilter({ ...lineFilter, onlyVariance: e.target.checked })} />Chỉ dòng có chênh lệch
            </label>
          </div>
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  {["Mã", "Tên hàng", "Nhóm hàng hóa", "ĐVT", "Sổ sách tại giờ chốt", "Kiểm kê", "Chênh lệch", "Đơn giá", "Giá trị lệch"].map((label, index) => (
                    <th key={label} className={`px-4 py-3 font-bold whitespace-nowrap ${index >= 4 ? "text-right" : "text-left"}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines === null && <tr><td colSpan={9} className="cell text-center text-slate-400">Đang tải...</td></tr>}
                {lines !== null && visibleLines.length === 0 && <tr><td colSpan={9} className="cell text-center text-slate-400">Không có dòng nào khớp bộ lọc.</td></tr>}
                {visibleLines.map((line) => {
                  const tone = Math.abs(line.variance) <= 1e-6 ? "text-slate-500" : line.variance > 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold";
                  return (
                    <tr key={line.itemId} className="border-t border-slate-100">
                      <td className="cell whitespace-nowrap"><b>{line.itemCode}</b></td>
                      <td className="cell">{line.itemName}</td>
                      <td className="cell whitespace-nowrap">{line.goodsGroup || ""}</td>
                      <td className="cell whitespace-nowrap">{line.unit}</td>
                      <td className="cell text-right tabular-nums">{qty(line.closing)}</td>
                      <td className="cell text-right tabular-nums font-bold">{qty(line.counted)}</td>
                      <td className={`cell text-right tabular-nums ${tone}`}>{qty(line.variance)}</td>
                      <td className="cell text-right tabular-nums">{unitPrice(line.unitCost)}</td>
                      <td className={`cell text-right tabular-nums ${tone}`}>{money(line.varianceValue)}</td>
                    </tr>
                  );
                })}
              </tbody>
              {visibleLines.length > 0 && (
                <tfoot className="sticky bottom-0 bg-slate-100 font-bold border-t-2 border-slate-300">
                  <tr>
                    <td className="cell" colSpan={8}>Cộng {visibleLines.length} mã · Thiếu {money(shortage)} · Thừa {money(surplus)}</td>
                    <td className="cell text-right tabular-nums">{money(shortage + surplus)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
