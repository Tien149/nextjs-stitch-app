"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { MoneyInput } from "@/components/MoneyInput";
import { QuantityInput } from "@/components/QuantityInput";
import { money } from "@/components/reports/report-ui";

/**
 * Màn "Số liệu trước khi lên phần mềm" (khách 19/10/2026): nhập tay số P&L THỰC TẾ từng tháng
 * trước 01/08/2026, theo nhà hàng, cùng cây dòng → nhóm → hạng mục như Dự báo P&L. Lưu xong là
 * Dashboard, Dự báo P&L, Kỳ tháng, Biến động YoY và Dashboard trang chủ lấy số này cho các tháng
 * đó (lib/pnl-history.ts). Doanh thu nhập theo Bếp / Bar / Phụ thu, đã gồm SVC.
 */

type EditorItem = { metric: string; name: string };
type EditorLine = { key: string; label: string; informational?: boolean; unit?: "people"; groups: Array<{ code: string; name: string; items: EditorItem[] }> };
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
/** SVC và thuế GTGT không thuộc kênh bán nào — phần tách theo nguồn so với doanh thu trừ hai dòng này. */
const REVENUE_OUTSIDE_CHANNEL = new Set(["revenue:SVC", "revenue:VAT"]);
const cellKey = (metric: string, period: string) => `${metric}|${period}`;
/** Số lượng nhân sự (headcount:<bộ phận>) nhập số lẻ 2 chữ số (0,5 người); còn lại là tiền tròn đồng. */
const isPeopleMetric = (metric: string) => metric.startsWith("headcount:");
const toDraft = (value: number | undefined, metric = "") => {
  if (isPeopleMetric(metric)) return value && Math.abs(value) >= 0.005 ? String(Math.round(value * 100) / 100) : "";
  return value && Math.abs(value) >= 0.5 ? String(Math.round(value)) : "";
};
const people = (value: number) => (Math.round(value * 100) / 100).toLocaleString("vi-VN");

export default function PnlHistoryTab({ year: pageYear, branchCode, onSaved }: { year: string; branchCode: string; onSaved?: () => void }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [year, setYear] = useState(pageYear);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const readOnly = branchCode === "ALL";
  const fileInput = useRef<HTMLInputElement>(null);

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
      setDraft(Object.fromEntries(Object.entries(next.values).map(([key, value]) => [key, toDraft(value, key)])));
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
    return [...keys].filter((key) => (draft[key] || "") !== toDraft(editor.values[key], key));
  }, [draft, editor]);

  const amountOf = (metric: string, period: string) => Number(draft[cellKey(metric, period)] || 0);
  const lineMonthTotal = (line: EditorLine, period: string) =>
    line.groups.reduce((sum, group) => sum + group.items.reduce((itemSum, item) => itemSum + amountOf(item.metric, period), 0), 0);
  const revenueLine = editor?.lines.find((line) => line.key === "revenue");
  /** Lợi nhuận vận hành tạm tính = thu − chi, để chị soát nhanh trước khi lưu. */
  const profitOf = (period: string) => (editor?.lines || []).reduce((sum, line) =>
    line.informational ? sum : sum + (INCOME_LINES.has(line.key) ? 1 : -1) * lineMonthTotal(line, period), 0);
  /** Doanh thu Bếp + Bar + Phụ thu (không SVC, thuế) chưa tách hết theo nguồn; null = tháng chưa nhập nguồn. */
  const channelGapOf = (line: EditorLine, period: string) => {
    const split = lineMonthTotal(line, period);
    if (!split || !revenueLine) return null;
    const net = revenueLine.groups.reduce((sum, group) => sum + group.items.reduce((itemSum, item) =>
      itemSum + (REVENUE_OUTSIDE_CHANNEL.has(item.metric) ? 0 : amountOf(item.metric, period)), 0), 0);
    return net - split;
  };

  /**
   * Xuất file Excel đúng khung đang xem (khách 22/10/2026: chọn năm 2024, xuất file, điền số rồi
   * import lên). Cột A là mã ô — import đọc theo mã này và tiêu đề cột T1/2024..., không theo tên.
   */
  const exportTemplate = async () => {
    if (!editor) return;
    const XLSX = await import("xlsx");
    const rows: Array<Array<string | number>> = [
      ["Số liệu P&L trước khi lên phần mềm", `Nhà hàng: ${branchCode}`, `Năm: ${editor.year}`],
      ["Điền số vào ô tháng, giữ nguyên cột Mã và dòng tiêu đề. Ô trống = 0. Dòng in hoa / không có mã chỉ để đọc."],
      ["Mã", "Khoản mục", ...months.map((period) => `T${Number(period.slice(5))}/${period.slice(0, 4)}`)],
    ];
    for (const line of editor.lines) {
      const round = (value: number) => (line.unit === "people" ? Math.round(value * 100) / 100 : Math.round(value));
      rows.push(["", line.label.toUpperCase(), ...months.map((period) => round(lineMonthTotal(line, period)))]);
      for (const group of line.groups) {
        if (line.groups.length > 1 || group.items.length > 1) rows.push(["", `  ${group.name}`]);
        for (const item of group.items) {
          rows.push([item.metric, `    ${item.name}`, ...months.map((period) => {
            const value = amountOf(item.metric, period);
            return value ? round(value) : "";
          })]);
        }
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [{ wch: 26 }, { wch: 42 }, ...months.map(() => ({ wch: 16 }))];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "So lieu P&L");
    XLSX.writeFile(book, `so-lieu-pnl-truoc-phan-mem-${branchCode}-${editor.year}.xlsx`);
  };

  /** Đọc file đã điền: đổ số vào các ô (tô vàng như sửa tay), chị soát lại rồi bấm Lưu. */
  const importTemplate = async (file: File) => {
    if (!editor) return;
    setMessage(null);
    try {
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer());
      const sheet = book.Sheets[book.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Array<unknown>>(sheet, { header: 1, defval: "" });
      const fileBranch = String(rows[0]?.[1] || "").match(/Nhà hàng:\s*(\S+)/)?.[1];
      if (fileBranch && fileBranch.toUpperCase() !== branchCode.toUpperCase()) {
        setMessage({ tone: "error", text: `File là của nhà hàng ${fileBranch}, đang chọn ${branchCode}. Chọn đúng nhà hàng rồi import lại.` });
        return;
      }
      const headerIndex = rows.findIndex((row) => String(row[0] || "").trim() === "Mã");
      if (headerIndex < 0) {
        setMessage({ tone: "error", text: "Không thấy dòng tiêu đề \"Mã\" — dùng file xuất từ nút Xuất file mẫu." });
        return;
      }
      const allowedMonths = new Set(months);
      const columns = rows[headerIndex].map((cell) => {
        const match = String(cell || "").trim().match(/^T(\d{1,2})\/(\d{4})$/i);
        const period = match ? `${match[2]}-${match[1].padStart(2, "0")}` : "";
        return allowedMonths.has(period) ? period : "";
      });
      if (!columns.some(Boolean)) {
        setMessage({ tone: "error", text: `File không có cột tháng nào của năm ${editor.year} trước ${cutoffLabel}.` });
        return;
      }
      const metrics = new Set(editor.lines.flatMap((line) => line.groups.flatMap((group) => group.items.map((item) => item.metric))));
      const next: Record<string, string> = {};
      const unknown: string[] = [];
      let filled = 0;
      for (const row of rows.slice(headerIndex + 1)) {
        const metric = String(row[0] || "").trim();
        if (!metric) continue;
        if (!metrics.has(metric)) { unknown.push(metric); continue; }
        columns.forEach((period, index) => {
          if (!period) return;
          const raw = row[index];
          const text = String(raw ?? "").replace(/\s/g, "");
          // Số người có số lẻ (1,5): phẩy là dấu thập phân; tiền thì chấm/phẩy là phân cách nghìn.
          const value = typeof raw === "number" ? raw : Number(isPeopleMetric(metric) ? text.replace(",", ".") : text.replace(/[.,]/g, ""));
          if (String(raw ?? "").trim() !== "" && !Number.isFinite(value)) { unknown.push(`${metric} ${period}`); return; }
          next[cellKey(metric, period)] = toDraft(value, metric);
          if (value) filled += 1;
        });
      }
      setDraft((current) => ({ ...current, ...next }));
      setMessage({
        tone: unknown.length ? "error" : "ok",
        text: `Đã đọc ${filled} ô có số từ file. Ô đổi tô vàng — soát lại rồi bấm Lưu.${unknown.length ? ` Bỏ qua: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}.` : ""}`,
      });
    } catch {
      setMessage({ tone: "error", text: "Không đọc được file Excel." });
    }
  };

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
              Nhập số <b>thực tế</b> từng tháng <b>trước {cutoffLabel}</b> theo từng nhà hàng (doanh thu Bếp / Bar / Phụ thu, SVC và thuế GTGT nhập dòng riêng; Doanh thu theo nguồn là tách phần Bếp + Bar + Phụ thu theo kênh bán). Có thể <b>Xuất file mẫu</b>, điền số rồi <b>Import file</b>. Lưu xong, Dashboard,
              Dự báo P&amp;L, Kỳ tháng và Biến động YoY dùng số này cho các tháng đó. Tháng nào của nhà hàng đã nhập thì bỏ số hệ thống
              của tháng đó, không cộng trùng. Số này không sinh bút toán, không đụng quỹ, công nợ hay tồn kho. Ô để trống = 0.
            </p>
          </div>
          <label className="ml-auto text-xs font-bold text-slate-600">Năm
            <select className="control mt-1 !w-28" value={year} onChange={(e) => setYear(e.target.value)}>
              {[...new Set([...yearOptions, pageYear])].filter((value) => Number(value) <= cutoffYear).sort().reverse().map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <button type="button" disabled={!editor || months.length === 0} onClick={() => void exportTemplate()}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            Xuất file mẫu
          </button>
          {!readOnly && (
            <>
              <button type="button" disabled={!editor || months.length === 0} onClick={() => fileInput.current?.click()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                Import file
              </button>
              <input ref={fileInput} type="file" accept=".xlsx,.xls" className="hidden" onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importTemplate(file);
              }} />
            </>
          )}
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
                      <td className="sticky left-0 z-10 bg-indigo-50 px-3 py-2 font-bold text-slate-800" title={line.informational ? "Tách doanh thu Bếp + Bar + Phụ thu theo kênh bán, không cộng thêm vào doanh thu" : undefined}>
                        <button type="button" className="mr-1 text-slate-400" onClick={() => setCollapsed({ ...collapsed, [line.key]: !isCollapsed })}>{isCollapsed ? "▸" : "▾"}</button>
                        {line.label}
                        {line.informational && <span className="ml-1 font-normal text-[11px] text-slate-500">{line.unit === "people" ? "· cho tab Ngân sách nhân sự, không phải tiền" : "· tách từ doanh thu trên, không gồm SVC, thuế"}</span>}
                      </td>
                      {lineTotals.map((value, index) => <td key={months[index]} className="px-2 py-2 text-right font-bold text-slate-800">{value ? (line.unit === "people" ? people(value) : money(value)) : "-"}</td>)}
                      <td className="px-3 py-2 text-right font-bold text-slate-900">{line.unit === "people" ? "" : money(lineTotals.reduce((sum, value) => sum + value, 0))}</td>
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
                                const dirty = (draft[key] || "") !== toDraft(editor.values[key], key);
                                return (
                                  <td key={period} className="px-1 py-0.5">
                                    {line.unit === "people" ? (
                                      <QuantityInput
                                        value={draft[key] || ""}
                                        decimals={2}
                                        onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
                                        disabled={readOnly}
                                        ariaLabel={`${item.name} tháng ${period}`}
                                        placeholder="người"
                                        className={`control !mt-0 !h-8 !py-1 text-right !text-xs ${dirty ? "!border-amber-400 !bg-amber-50" : ""}`}
                                      />
                                    ) : (
                                      <MoneyInput
                                        value={draft[key] || ""}
                                        onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
                                        readOnly={readOnly}
                                        ariaLabel={`${item.name} tháng ${period}`}
                                        className={`control !mt-0 !h-8 !py-1 text-right !text-xs ${dirty ? "!border-amber-400 !bg-amber-50" : ""}`}
                                      />
                                    )}
                                  </td>
                                );
                              })}
                              <td className="px-3 py-1 text-right font-semibold text-slate-700">{line.unit === "people" ? "" : rowTotal ? money(rowTotal) : "-"}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                    {line.informational && !isCollapsed && months.some((period) => channelGapOf(line, period) !== null) && (
                      <tr className="border-t border-slate-100">
                        <td className="sticky left-0 z-10 bg-white px-3 py-1.5 pl-10 text-[11px] text-slate-500">Chưa tách nguồn (Bếp + Bar + Phụ thu − tổng nguồn)</td>
                        {months.map((period) => {
                          const gap = channelGapOf(line, period);
                          return <td key={period} className={`px-2 py-1.5 text-right text-[11px] font-semibold ${gap && Math.abs(gap) >= 0.5 ? "text-rose-600" : "text-emerald-600"}`}>{gap === null ? "" : Math.abs(gap) >= 0.5 ? money(gap) : "Khớp"}</td>;
                        })}
                        <td />
                      </tr>
                    )}
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
