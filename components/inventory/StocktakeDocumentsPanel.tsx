"use client";

import { useCallback, useEffect, useState } from "react";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import CopyableText from "@/components/CopyableText";
import ExportExcelButton from "@/components/ExportExcelButton";
import { STOCKTAKE_APPROVED, STOCKTAKE_PENDING, STOCKTAKE_RETURNED, stocktakeStatusLabel, stocktakeStatusTone } from "@/lib/stocktake-status";

/**
 * "Danh sách phiếu kiểm kê" đầu tab Kiểm kê (khách yêu cầu 03/10/2026): MỌI phiếu — đếm theo vị
 * trí lẫn kiểm cả kho — lọc theo nhà hàng, kho, trạng thái, tháng. Chỉ để tra; thao tác đếm / duyệt
 * vẫn ở các khung bên dưới.
 */
type StocktakeDocument = {
  id: string;
  code: string;
  stocktakeDate: string;
  branchCode: string;
  warehouseCode: string;
  status: string;
  locationCode: string | null;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  returnedReason: string | null;
  batch: { code: string; cutoffAt: string } | null;
  lineCount: number;
  varianceRows: number | null;
};

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

const dateTime = (value: string | null) => (value ? new Date(value).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

export default function StocktakeDocumentsPanel({ sessionKey, branchOptions, warehouses, storeLabel }: Props) {
  const [filters, setFilters] = useState({ branchCode: "ALL", warehouseCode: "", status: "ALL", from: "", to: "" });
  const [documents, setDocuments] = useState<StocktakeDocument[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(true);

  const load = useCallback(async () => {
    setError("");
    const query = new URLSearchParams({ view: "stocktake-documents", branchCode: filters.branchCode, status: filters.status });
    if (filters.warehouseCode) query.set("warehouseCode", filters.warehouseCode);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    try {
      const response = await fetch(`/api/inventory?${query.toString()}`, { headers: sessionHeaders(sessionKey) });
      const payload = await response.json() as { documents?: StocktakeDocument[]; error?: string };
      if (!response.ok) setError(payload.error || "Không tải được danh sách phiếu kiểm kê");
      setDocuments(payload.documents || []);
    } catch {
      setError("Mất kết nối tới máy chủ khi tải danh sách phiếu kiểm kê.");
      setDocuments([]);
    }
  }, [filters, sessionKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const warehouseOptions = warehouses.filter((warehouse) => filters.branchCode === "ALL" || warehouse.branch === filters.branchCode || !warehouse.branch);
  const rows = documents || [];
  const counts = {
    pending: rows.filter((row) => row.status === STOCKTAKE_PENDING).length,
    returned: rows.filter((row) => row.status === STOCKTAKE_RETURNED).length,
    approved: rows.filter((row) => row.status === STOCKTAKE_APPROVED).length,
  };

  return (
    <section className="table-panel shadow-sm mb-5" data-export-root>
      <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-800">Danh sách phiếu kiểm kê</h2>
          <p className="text-xs text-slate-500 mt-1">
            Mọi phiếu đếm theo vị trí và phiếu kiểm cả kho. {documents && <>Đang hiện <b>{rows.length}</b> phiếu · chờ duyệt <b>{counts.pending}</b> · bị trả lại <b>{counts.returned}</b> · đã duyệt <b>{counts.approved}</b>.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ExportExcelButton fileName="danh_sach_phieu_kiem_ke" sheetName="Phieu kiem ke" />
          <button type="button" title="Tải lại" onClick={() => void load()} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
          <button type="button" onClick={() => setOpen(!open)} className="text-xs font-bold text-blue-600 hover:underline">{open ? "Thu gọn" : "Mở rộng"}</button>
        </div>
      </div>
      {open && (
        <>
          <div className="px-5 pb-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
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
            <label className="text-xs font-bold text-slate-500">Trạng thái
              <select className="control mt-1" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="ALL">Tất cả trạng thái</option>
                <option value={STOCKTAKE_PENDING}>{stocktakeStatusLabel(STOCKTAKE_PENDING)}</option>
                <option value={STOCKTAKE_RETURNED}>{stocktakeStatusLabel(STOCKTAKE_RETURNED)}</option>
                <option value={STOCKTAKE_APPROVED}>{stocktakeStatusLabel(STOCKTAKE_APPROVED)}</option>
              </select>
            </label>
            <DateRangeFilter label="Ngày kiểm" value={{ from: filters.from, to: filters.to }} onChange={(range) => setFilters({ ...filters, ...range })} className="col-span-2 !text-xs !text-slate-500" />
          </div>
          {error && <p className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  {["Phiếu", "Ngày kiểm", "Nhà hàng", "Kho", "Kiểu", "Trạng thái", "Đợt duyệt", "Số dòng", "Dòng lệch", "Người lập", "Duyệt"].map((label, index) => (
                    <th key={label} className={`px-4 py-3 font-bold whitespace-nowrap ${index >= 7 && index <= 8 ? "text-right" : "text-left"}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {documents === null && <tr><td colSpan={11} className="cell text-center text-slate-400">Đang tải...</td></tr>}
                {documents !== null && rows.length === 0 && <tr><td colSpan={11} className="cell text-center text-slate-400">Không có phiếu kiểm kê khớp bộ lọc.</td></tr>}
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="cell whitespace-nowrap"><CopyableText value={row.code}><b>{row.code}</b></CopyableText></td>
                    <td className="cell whitespace-nowrap">{dateTime(row.stocktakeDate)}</td>
                    <td className="cell whitespace-nowrap">{storeLabel(row.branchCode)}</td>
                    <td className="cell whitespace-nowrap">{row.warehouseCode}</td>
                    <td className="cell whitespace-nowrap">{row.locationCode ? `Theo vị trí · ${row.locationCode}` : "Cả kho"}</td>
                    <td className="cell">
                      <span className={`status ${stocktakeStatusTone(row.status)}`}>{stocktakeStatusLabel(row.status)}</span>
                      {row.status === STOCKTAKE_RETURNED && row.returnedReason && <small className="block text-rose-700">{row.returnedReason}</small>}
                    </td>
                    <td className="cell whitespace-nowrap">{row.batch ? <>{row.batch.code}<small className="block text-slate-500">chốt {dateTime(row.batch.cutoffAt)}</small></> : "-"}</td>
                    <td className="cell text-right tabular-nums">{row.lineCount}</td>
                    <td className="cell text-right tabular-nums">{row.varianceRows === null ? <span className="text-slate-400" title="Phiếu theo vị trí không tự so sổ — xem chênh lệch ở đợt duyệt gộp">-</span> : row.varianceRows}</td>
                    <td className="cell whitespace-nowrap">{row.createdBy || ""}</td>
                    <td className="cell whitespace-nowrap">{row.approvedBy ? <>{row.approvedBy}<small className="block text-slate-500">{dateTime(row.approvedAt)}</small></> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
