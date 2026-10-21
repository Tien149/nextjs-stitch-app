"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { MoneyInput } from "@/components/MoneyInput";
import { money } from "@/components/reports/report-ui";

/**
 * Màn "Số liệu trước khi lên phần mềm" (khách 19/10/2026): nhập tay số P&L THỰC TẾ từng tháng
 * trước 01/08/2026, theo nhà hàng, cùng cây dòng → nhóm → hạng mục như Dự báo P&L. Lưu xong là
 * Dashboard, Dự báo P&L, Kỳ tháng, Biến động YoY và Dashboard trang chủ lấy số này cho các tháng
 * đó (lib/pnl-history.ts). Doanh thu nhập theo Bếp / Bar / Phụ thu, đã gồm SVC.
 */

type EditorItem = { metric: string; name: string };
type EditorLine = { key: string; label: string; groups: Array<{ code: string; name: string; items: EditorItem[] }> };
type Editor = {
  year: string;
  branchCode: string;
  cutoff: string;
  months: string[];
  lines: EditorLine[];
  values: Record<string, number>;
  lastUpdate: { by: string | null; at: string } | null;
};

const INCOME_LINES = new Set(["revenue", "otherIncome"]);
const cellKey = (metric: string, period: string) => `${metric}|${period}`;
const toDraft = (value: number | undefined) => (value && Math.abs(value) >= 0.5 ? String(Math.round(value)) : "");

export default function PnlHistoryTab({ year: pageYear, branchCode, onSaved }: { year: string; branchCode: string; onSaved?: () => void }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [year, setYear] = useState(pageYear);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const readOnly = branchCode === "ALL";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ type: "pnl-history", year, branchCode });
      const response = await fetch(`/api/reports?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({ tone: "error", text: payload.error || "Không tải được số liệu." });
        return;
      }
      const next = payload as Editor;
      setEditor(next);
      setDraft(Object.fromEntries(Object.entries(next.values).map(([key, value]) => [key, toDraft(value)])));
    } catch {
      setMessage({ tone: "error", text: "Lỗi kết nối máy chủ." });
    } finally {
      setLoading(false);
    }
  }, [year, branchCode]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const cutoffYear = Number((editor?.cutoff || "2026-08").slice(0, 4));
  const yearOptions = Array.from({ length: 4 }, (_, index) => String(cutoffYear - index));
  const months = editor?.months || [];

  /** Ô đã sửa so với số đang lưu — chỉ gửi những ô này. */
  const changed = useMemo(() => {
    if (!editor) return [];
    const keys = new Set([...Object.keys(draft), ...Object.keys(editor.values)]);
    return [...keys].filter((key) => (draft[key] || "") !== toDraft(editor.values[key]));
  }, [draft, editor]);

  const amountOf = (metric: string, period: string) => Number(draft[cellKey(metric, period)] || 0);
  const lineMonthTotal = (line: EditorLine, period: string) =>
    line.groups.reduce((sum, group) => sum + group.items.reduce((itemSum, item) => itemSum + amountOf(item.metric, period), 0), 0);
  const revenueLine = editor?.lines.find((line) => line.key === "revenue");
  /** Lợi nhuận vận hành tạm tính = thu − chi, để chị soát nhanh trước khi lưu. */
  const profitOf = (period: string) => (editor?.lines || []).reduce((sum, line) =>
    sum + (INCOME_LINES.has(line.key) ? 1 : -1) * lineMonthTotal(line, period), 0);

  const save = async () => {
    if (!editor || changed.length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const entries = changed.map((key) => {
        const [metric, period] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
        return { metric, period, amount: draft[key] || "" };
      });
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SAVE_PNL_HISTORY", branchCode, entries }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({ tone: "error", text: payload.error || "Không lưu được." });
        return;
      }
      setMessage({ tone: "ok", text: `Đã lưu ${payload.saved || 0} ô${payload.removed ? `, xoá ${payload.removed} ô để trống` : ""}. Các báo cáo P&L đã lấy số mới.` });
      await load();
      onSaved?.();
    } catch {
      setMessage({ tone: "error", text: "Lỗi kết nối máy chủ khi lưu." });
    } finally {
      setSaving(false);
    }
  };

  const cutoffLabel = editor ? `${editor.cutoff.slice(5)}/${editor.cutoff.slice(0, 4)}` : "08/2026";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h3 className="text-base font-bold text-slate-900">Số liệu P&amp;L trước khi lên phần mềm</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-3xl">
              Nhập số <b>thực tế</b> từng tháng <b>trước {cutoffLabel}</b> theo từng nhà hàng (doanh thu Bếp / Bar / Phụ thu, SVC và thuế GTGT nhập dòng riêng). Lưu xong, Dashboard,
              Dự báo P&amp;L, Kỳ tháng và Biến động YoY dùng số này cho các tháng đó. Tháng nào của nhà hàng đã nhập thì bỏ số hệ thống
              của tháng đó, không cộng trùng. Số này không sinh bút toán, không đụng quỹ, công nợ hay tồn kho. Ô để trống = 0.
            </p>
          </div>
          <label className="ml-auto text-xs font-bold text-slate-600">Năm
            <select className="control mt-1 !w-28" value={year} onChange={(e) => setYear(e.target.value)}>
              {[...new Set([...yearOptions, pageYear])].filter((value) => Number(value) <= cutoffYear).sort().reverse().map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {!readOnly && (
            <button type="button" disabled={saving || changed.length === 0} onClick={() => void save()}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
              {saving ? "Đang lưu..." : changed.length > 0 ? `Lưu ${changed.length} ô` : "Đã lưu"}
            </button>
          )}
        </div>
        {readOnly && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
            Đang xem <b>tổng mọi nhà hàng</b> (chỉ xem). Chọn <b>một nhà hàng</b> ở bộ lọc trên cùng để nhập số.
          </p>
        )}
        {editor?.lastUpdate && <p className="text-[11px] text-slate-400">Lưu gần nhất: {editor.lastUpdate.by || "-"} · {new Date(editor.lastUpdate.at).toLocaleString("vi-VN")}</p>}
        {message && <p className={`rounded-md px-3 py-2 text-xs font-semibold ${message.tone === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{message.text}</p>}
      </div>

      {loading && !editor && <p className="py-10 text-center text-sm text-slate-500 animate-pulse">Đang tải...</p>}
      {editor && months.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">Năm {year} không có tháng nào trước {cutoffLabel} — chọn năm khác.</p>
      )}
      {editor && months.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-x-auto max-h-[70vh] overflow-y-auto custom-scrollbar">
          <table className="text-xs min-w-full">
            <thead className="sticky top-0 z-20 bg-slate-50 text-slate-500 uppercase">
              <tr>
                <th className="sticky left-0 z-30 bg-slate-50 px-3 py-2 text-left font-bold min-w-[260px]">Khoản mục · {storeLabel(branchCode)}</th>
                {months.map((period) => <th key={period} className="px-2 py-2 text-right font-bold min-w-[130px]">T{Number(period.slice(5))}/{period.slice(0, 4)}</th>)}
                <th className="px-3 py-2 text-right font-bold min-w-[130px]">Cộng</th>
              </tr>
            </thead>
            <tbody>
              {editor.lines.map((line) => {
                const isCollapsed = collapsed[line.key];
                const lineTotals = months.map((period) => lineMonthTotal(line, period));
                return (
                  <React.Fragment key={line.key}>
                    <tr className="border-t border-slate-200 bg-indigo-50/60">
                      <td className="sticky left-0 z-10 bg-indigo-50 px-3 py-2 font-bold text-slate-800">
                        <button type="button" className="mr-1 text-slate-400" onClick={() => setCollapsed({ ...collapsed, [line.key]: !isCollapsed })}>{isCollapsed ? "▸" : "▾"}</button>
                        {line.label}
                      </td>
                      {lineTotals.map((value, index) => <td key={months[index]} className="px-2 py-2 text-right font-bold text-slate-800">{value ? money(value) : "-"}</td>)}
                      <td className="px-3 py-2 text-right font-bold text-slate-900">{money(lineTotals.reduce((sum, value) => sum + value, 0))}</td>
                    </tr>
                    {!isCollapsed && line.groups.map((group) => (
                      <React.Fragment key={`${line.key}-${group.code}`}>
                        {line.groups.length > 1 || group.items.length > 1 ? (
                          <tr className="border-t border-slate-100 bg-slate-50/60">
                            <td colSpan={months.length + 2} className="sticky left-0 px-3 py-1.5 pl-7 font-bold text-slate-600">{group.name}</td>
                          </tr>
                        ) : null}
                        {group.items.map((item) => {
                          const rowTotal = months.reduce((sum, period) => sum + amountOf(item.metric, period), 0);
                          return (
                            <tr key={item.metric} className="border-t border-slate-100 hover:bg-slate-50/50">
                              <td className="sticky left-0 z-10 bg-white px-3 py-1 pl-10 text-slate-700">{item.name}</td>
                              {months.map((period) => {
                                const key = cellKey(item.metric, period);
                                const dirty = (draft[key] || "") !== toDraft(editor.values[key]);
                                return (
                                  <td key={period} className="px-1 py-0.5">
                                    <MoneyInput
                                      value={draft[key] || ""}
                                      onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
                                      readOnly={readOnly}
                                      ariaLabel={`${item.name} tháng ${period}`}
                                      className={`control !mt-0 !h-8 !py-1 text-right !text-xs ${dirty ? "!border-amber-400 !bg-amber-50" : ""}`}
                                    />
                                  </td>
                                );
                              })}
                              <td className="px-3 py-1 text-right font-semibold text-slate-700">{rowTotal ? money(rowTotal) : "-"}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                );
              })}
              <tr className="border-t-2 border-slate-300 bg-emerald-50">
                <td className="sticky left-0 z-10 bg-emerald-50 px-3 py-2 font-bold text-emerald-900">Lợi nhuận vận hành (tạm tính)</td>
                {months.map((period) => <td key={period} className="px-2 py-2 text-right font-bold text-emerald-900">{money(profitOf(period))}</td>)}
                <td className="px-3 py-2 text-right font-bold text-emerald-900">{money(months.reduce((sum, period) => sum + profitOf(period), 0))}</td>
              </tr>
              {revenueLine && (
                <tr className="border-t border-slate-100">
                  <td className="sticky left-0 z-10 bg-white px-3 py-1.5 text-slate-500">Tỷ suất LN vận hành / doanh thu</td>
                  {months.map((period) => {
                    const revenue = lineMonthTotal(revenueLine, period);
                    return <td key={period} className="px-2 py-1.5 text-right text-slate-500">{revenue ? `${((profitOf(period) / revenue) * 100).toFixed(1)}%` : "-"}</td>;
                  })}
                  <td />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
