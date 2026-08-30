"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { canPerformMenuAction, SESSION_KEY, type DemoSession } from "@/lib/auth-demo";

type TrashRow = {
  id: string;
  model: string;
  label: string;
  module: string;
  code: string | null;
  title: string | null;
  branchCode: string | null;
  deletedAt: string;
  deletedBy: string | null;
};

type TrashSummary = { model: string; label: string; module: string; count: number };

function sessionHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Bảng Thùng rác dùng chung.
 * - Không truyền `models`: hiện toàn bộ dữ liệu đã xoá mà người dùng được xem.
 * - Truyền `models`: chỉ hiện đúng các loại đó, dùng làm tab "Đã xoá" trong từng module.
 */
export function TrashPanel({
  session,
  models,
  emptyHint = "Chưa có dữ liệu nào bị xoá.",
}: {
  session: DemoSession | null;
  models?: string[];
  emptyHint?: string;
}) {
  const [rows, setRows] = useState<TrashRow[]>([]);
  const [summary, setSummary] = useState<TrashSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [activeModel, setActiveModel] = useState<string>("ALL");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);

  const modelsKey = models?.join(",") || "";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (modelsKey) params.set("models", modelsKey);
      const response = await fetch(`/api/trash?${params.toString()}`, { headers: sessionHeaders() });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Không tải được thùng rác");
      }
      const data = await response.json();
      setRows(data.rows || []);
      setSummary(data.summary || []);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không tải được thùng rác" });
    } finally {
      setLoading(false);
    }
  }, [modelsKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const handleRestore = async (row: TrashRow) => {
    if (!window.confirm(`Khôi phục ${row.label.toLowerCase()} "${row.code || row.title || row.id}"?`)) return;
    setBusyId(row.id);
    setMessage(null);
    try {
      const response = await fetch("/api/trash", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionHeaders() },
        body: JSON.stringify({ action: "RESTORE", model: row.model, id: row.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Không khôi phục được bản ghi");
      setMessage({ type: "ok", text: `Đã khôi phục ${row.label.toLowerCase()} "${row.code || row.title || ""}".` });
      await load();
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Không khôi phục được bản ghi" });
    } finally {
      setBusyId(null);
    }
  };

  /** Chỉ hiện nút Khôi phục khi vai trò có quyền xoá trên module gốc của bản ghi. */
  const canRestore = (row: TrashRow) =>
    Boolean(session && canPerformMenuAction(session, row.module, "delete"));

  const filtered = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (activeModel !== "ALL" && row.model !== activeModel) return false;
      if (!key) return true;
      return (
        row.code?.toLowerCase().includes(key) ||
        row.title?.toLowerCase().includes(key) ||
        row.label.toLowerCase().includes(key) ||
        row.deletedBy?.toLowerCase().includes(key)
      );
    });
  }, [rows, keyword, activeModel]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xl pointer-events-none">
            search
          </span>
          <input
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="Tìm theo mã, tên hoặc người xoá..."
            className="w-full border border-slate-300 rounded-lg pl-10 pr-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <button
          type="button"
          onClick={load}
          className="px-4 py-2.5 rounded-lg text-sm font-bold border border-slate-300 text-slate-600 hover:bg-slate-50 flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined text-lg">refresh</span>
          Tải lại
        </button>
      </div>

      {summary.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setActiveModel("ALL")}
            className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap border ${
              activeModel === "ALL"
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
            }`}
          >
            Tất cả ({rows.length})
          </button>
          {summary.map((item) => (
            <button
              key={item.model}
              type="button"
              onClick={() => setActiveModel(item.model)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap border ${
                activeModel === item.model
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-300 hover:bg-slate-50"
              }`}
            >
              {item.label} ({item.count})
            </button>
          ))}
        </div>
      )}

      {message && (
        <p
          className={`text-sm rounded-lg px-3 py-2.5 flex items-start gap-2 border ${
            message.type === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-rose-50 border-rose-200 text-rose-700"
          }`}
        >
          <span className="material-symbols-outlined text-lg shrink-0">
            {message.type === "ok" ? "check_circle" : "error"}
          </span>
          {message.text}
        </p>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden" data-export-root>
        <div className="flex justify-end border-b border-slate-200 px-4 py-2">
          <ExportExcelButton fileName="thung_rac" sheetName="Thung rac" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-xs font-bold text-slate-500 uppercase">
                <th className="px-4 py-3">Loại dữ liệu</th>
                <th className="px-4 py-3">Mã</th>
                <th className="px-4 py-3">Nội dung</th>
                <th className="px-4 py-3 whitespace-nowrap">Thời điểm xoá</th>
                <th className="px-4 py-3">Người xoá</th>
                <th className="px-4 py-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                    Đang tải...
                  </td>
                </tr>
              )}

              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                    <span className="material-symbols-outlined text-4xl block mb-2">delete_outline</span>
                    {keyword ? "Không tìm thấy bản ghi phù hợp." : emptyHint}
                  </td>
                </tr>
              )}

              {!loading &&
                filtered.map((row) => (
                  <tr key={`${row.model}-${row.id}`} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-bold">
                        {row.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-bold text-slate-800 whitespace-nowrap">{row.code || "—"}</td>
                    <td className="px-4 py-3 text-slate-600 max-w-xs truncate" title={row.title || ""}>
                      {row.title || "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{formatDateTime(row.deletedAt)}</td>
                    <td className="px-4 py-3 text-slate-500">{row.deletedBy || "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {!canRestore(row) ? (
                        <span className="text-xs text-slate-400" title="Vai trò của bạn không được khôi phục loại dữ liệu này">
                          Chỉ xem
                        </span>
                      ) : (
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => handleRestore(row)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold border border-emerald-300 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        <span className="material-symbols-outlined text-base">restore_from_trash</span>
                        {busyId === row.id ? "Đang khôi phục..." : "Khôi phục"}
                      </button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        Dữ liệu trong Thùng rác được giữ nguyên trong hệ thống và không bị xoá vĩnh viễn. Mọi thao tác xoá và
        khôi phục đều được ghi lại trong Nhật ký Hệ thống.
      </p>
    </div>
  );
}
