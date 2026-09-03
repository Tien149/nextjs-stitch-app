"use client";

import React, { useMemo, useState } from "react";
import CopyableText from "@/components/CopyableText";
import { Cell, Kpi, PanelHeader, Table, money } from "@/components/reports/report-ui";

/**
 * Tab "Ngân sách" (feedback 03/09/2026): bảng ngân sách bám theo cây hạng mục P&L khai ở
 * Cài đặt > Danh mục, set ngay trên từng dòng thay vì form chọn chỉ tiêu bên trái.
 *  - Dòng set tổng (Doanh thu, Giá vốn, Nhân sự, Khấu hao, Nguồn tiền còn lại): một con số.
 *  - Dòng set chi tiết (OPEX): set từng hạng mục P&L (marketing, điện nước, mặt bằng...),
 *    nhóm và dòng tổng tự cộng.
 *  - Lợi nhuận gộp, EBITDA suy từ các target đã set.
 * Cha truyền key={kỳ-cửa hàng} để form đang sửa / bảng kê đang mở tự đóng khi đổi bộ lọc.
 */

export type BudgetRow = {
  key: string;
  parentKey: string | null;
  level: number;
  label: string;
  code: string | null;
  kind: "REVENUE" | "EXPENSE" | "PROFIT" | "CASH";
  scope: "TOTAL" | "DETAIL" | "DERIVED" | "ROLLUP" | "INFO";
  metric: string | null;
  drilldown: { metric: string; line: string } | null;
  actual: number | null;
  target: number;
  targetMode: string | null;
  targetPercent: number | null;
  standard: number | null;
  variance: number | null;
  usageRate: number | null;
  isGood: boolean;
  hasTarget: boolean;
  hint: string | null;
  warning: string | null;
};
export type BudgetData = {
  period: string;
  branchCode: string;
  rows: BudgetRow[];
  summary: { expenseActual: number; expenseTarget: number; revenueActual: number; revenueTarget: number };
};

type DrilldownRow = { id: string; date: string; code: string; accountCode: string; accountName: string; description: string; amount: number };
type EditorState = { key: string; metric: string; mode: "AMOUNT" | "PERCENT_REVENUE"; value: string; percent: string };

const kindLabel: Record<BudgetRow["kind"], string> = { REVENUE: "Doanh thu", EXPENSE: "Chi phí", PROFIT: "Lợi nhuận", CASH: "Nguồn tiền" };
const percentText = (ratio: number) => (ratio * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
const isEmptyAmount = (amount: number | null) => amount === null || Math.abs(amount) <= 0.5;
/** Doanh thu là gốc quy đổi, nguồn tiền không phải chi phí — hai dòng này chỉ set trị giá. */
const amountOnly = (row: BudgetRow) => row.metric === "revenue" || row.metric === "cashRemaining";

export default function BudgetTab({
  data,
  period,
  branchCode,
  branchLabel,
  canConfigure,
  onSaved,
  setMessage,
}: {
  data: BudgetData;
  period: string;
  branchCode: string;
  branchLabel: string;
  canConfigure: boolean;
  onSaved: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean> | null>(null);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [drilldownKey, setDrilldownKey] = useState<string | null>(null);
  const [drilldownRows, setDrilldownRows] = useState<DrilldownRow[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);

  const rowByKey = useMemo(() => new Map(data.rows.map((row) => [row.key, row])), [data.rows]);
  // Mặc định: dòng set chi tiết mở sẵn để thấy hạng mục cần set, dòng set tổng thu gọn cho bảng ngắn.
  const defaultCollapsed = useMemo(() => {
    const next: Record<string, boolean> = {};
    for (const row of data.rows) if (row.level === 0 && row.scope !== "DETAIL") next[row.key] = true;
    return next;
  }, [data.rows]);
  const collapsed = collapsedOverride ?? defaultCollapsed;
  const toggle = (key: string) => setCollapsedOverride({ ...collapsed, [key]: !collapsed[key] });
  const setAll = (nextCollapsed: boolean) => {
    const next: Record<string, boolean> = {};
    if (nextCollapsed) for (const row of data.rows) if (row.level < 2) next[row.key] = true;
    setCollapsedOverride(next);
  };

  const childrenOf = useMemo(() => {
    const map = new Map<string, BudgetRow[]>();
    for (const row of data.rows) {
      if (!row.parentKey) continue;
      const list = map.get(row.parentKey) || [];
      list.push(row);
      map.set(row.parentKey, list);
    }
    return map;
  }, [data.rows]);

  const visibleRows = useMemo(() => {
    const keepItem = (row: BudgetRow) => !hideEmpty || !isEmptyAmount(row.actual) || row.hasTarget || editor?.key === row.key || drilldownKey === row.key;
    const keepGroup = (row: BudgetRow) => {
      if (!hideEmpty || !isEmptyAmount(row.actual) || row.hasTarget || row.warning) return true;
      return (childrenOf.get(row.key) || []).some(keepItem);
    };
    return data.rows.filter((row) => {
      if (row.level === 0) return true;
      const parent = row.parentKey ? rowByKey.get(row.parentKey) : null;
      if (!parent) return false;
      if (row.level === 1) return !collapsed[parent.key] && keepGroup(row);
      const grandParent = parent.parentKey ? rowByKey.get(parent.parentKey) : null;
      if (!grandParent || collapsed[grandParent.key] || collapsed[parent.key]) return false;
      return keepItem(row);
    });
  }, [data.rows, rowByKey, childrenOf, collapsed, hideEmpty, editor, drilldownKey]);

  const hasChildren = (row: BudgetRow) => (childrenOf.get(row.key) || []).length > 0;

  const openEditor = (row: BudgetRow) => {
    if (!row.metric) return;
    setDrilldownKey(null);
    setEditor({
      key: row.key,
      metric: row.metric,
      mode: row.targetMode === "PERCENT_REVENUE" && !amountOnly(row) ? "PERCENT_REVENUE" : "AMOUNT",
      value: row.targetMode === "AMOUNT" && row.target ? String(Math.round(row.target)) : "",
      percent: row.targetPercent ? String(Number((row.targetPercent * 100).toFixed(2))) : "",
    });
  };

  const submitTarget = async (row: BudgetRow, payload: { targetMode: "AMOUNT" | "PERCENT_REVENUE"; targetValue: string; targetPercent: string }, successMessage: string) => {
    if (!row.metric) return;
    setSaving(true);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "UPSERT_TARGET", period, branchCode, metric: row.metric, ...payload }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(body.error || "Không lưu được ngân sách");
        return;
      }
      setMessage(successMessage);
      setEditor(null);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  const saveEditor = async (event: React.FormEvent, row: BudgetRow) => {
    event.preventDefault();
    if (!editor) return;
    if (editor.mode === "AMOUNT" && Number(editor.value) <= 0) {
      setMessage("Nhập trị giá lớn hơn 0, hoặc bấm “Bỏ ngân sách” nếu muốn xoá.");
      return;
    }
    await submitTarget(row, { targetMode: editor.mode, targetValue: editor.value, targetPercent: editor.percent }, `Đã lưu ngân sách cho ${row.label}.`);
  };

  const removeTarget = async (row: BudgetRow) => {
    await submitTarget(row, { targetMode: "AMOUNT", targetValue: "0", targetPercent: "" }, `Đã bỏ ngân sách của ${row.label}.`);
  };

  const toggleDrilldown = async (row: BudgetRow) => {
    if (!row.drilldown) return;
    if (drilldownKey === row.key) {
      setDrilldownKey(null);
      setDrilldownRows([]);
      return;
    }
    setEditor(null);
    setDrilldownKey(row.key);
    setDrilldownRows([]);
    setDrilldownLoading(true);
    try {
      const params = new URLSearchParams({ period, branchCode, metric: row.drilldown.metric, line: row.drilldown.line });
      const response = await fetch(`/api/reports/drilldown?${params.toString()}`);
      if (response.ok) setDrilldownRows((await response.json()) as DrilldownRow[]);
    } catch (error) {
      console.error(error);
    } finally {
      setDrilldownLoading(false);
    }
  };

  const revenueTarget = data.summary.revenueTarget;
  const editableCount = data.rows.filter((row) => row.metric).length;
  const setCount = data.rows.filter((row) => row.metric && row.hasTarget).length;

  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-4 gap-4">
        <Kpi label="Doanh thu thực tế" value={data.summary.revenueActual} icon="payments" tone="blue" />
        <Kpi label="Target doanh thu" value={data.summary.revenueTarget} icon="flag" />
        <Kpi label="Chi phí thực tế" value={data.summary.expenseActual} icon="receipt_long" tone="amber" />
        <Kpi label="Ngân sách chi phí" value={data.summary.expenseTarget} icon="price_check" tone="green" />
      </div>

      <section className="table-panel">
        <PanelHeader
          title="Ngân sách theo hạng mục P&L"
          subtitle={`Doanh thu, giá vốn, nhân sự, khấu hao set một con số tổng; OPEX set từng hạng mục P&L rồi tự cộng lên. Đã set ${setCount}/${editableCount} chỉ tiêu cho kỳ ${period} · ${branchLabel}.`}
          exportFileName={`ngan_sach_${period}_${branchCode}`}
        />
        <div className="px-4 py-2.5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/60">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-blue-500" />Set được ngân sách</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-300" />Tự cộng / suy ra / chỉ theo dõi</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400" />Chưa phân loại — cần gán lại hạng mục</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />
              Ẩn hạng mục chưa phát sinh và chưa set
            </label>
            <button type="button" onClick={() => setAll(false)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 bg-white">Mở tất cả</button>
            <button type="button" onClick={() => setAll(true)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50 bg-white">Thu gọn tất cả</button>
          </div>
        </div>
        <div className="max-h-[640px] overflow-auto">
          <Table headers={["Chỉ tiêu / hạng mục P&L", "Thực tế", "Ngân sách / Target", "Chênh lệch", "Tỷ lệ dùng & tiến trình", "Thao tác"]}>
            {visibleRows.map((row) => {
              const editable = canConfigure && !!row.metric;
              const isEditing = editor?.key === row.key;
              const isDrilling = drilldownKey === row.key;
              const rateVal = row.usageRate !== null ? Math.round(row.usageRate * 100) : 0;
              const barColor = !row.hasTarget
                ? "bg-slate-300"
                : row.kind === "EXPENSE"
                  ? rateVal <= 80 ? "bg-emerald-500" : rateVal <= 100 ? "bg-amber-500" : "bg-rose-500"
                  : rateVal >= 100 ? "bg-emerald-500" : rateVal >= 80 ? "bg-amber-500" : "bg-rose-500";
              const unclassified = row.level > 0 && row.code === null;
              const rowTone = row.level === 0
                ? row.scope === "DERIVED" ? "bg-blue-50/60 font-bold" : "bg-slate-50 font-bold"
                : unclassified ? "bg-amber-50/60" : row.level === 1 ? "bg-white" : "";
              const canToggle = row.level < 2 && hasChildren(row);
              const indent = row.level === 0 ? "" : row.level === 1 ? "pl-6" : "pl-14";

              return (
                <React.Fragment key={row.key}>
                  <tr className={`border-t ${row.level === 0 ? "border-slate-200" : "border-slate-100"} ${rowTone} ${canToggle ? "cursor-pointer hover:bg-slate-100/70" : ""}`} onClick={canToggle ? () => toggle(row.key) : undefined}>
                    <Cell>
                      <div className={`flex items-start gap-1 ${indent}`}>
                        {canToggle
                          ? <span className="material-symbols-outlined text-base text-slate-400 mt-0.5">{collapsed[row.key] ? "chevron_right" : "expand_more"}</span>
                          : <span className="w-4 shrink-0" />}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            {row.metric && <span className="inline-block w-2 h-2 rounded-sm bg-blue-500 shrink-0" title="Set được ngân sách" />}
                            {row.code && row.level === 2 && <span className="text-[11px] text-slate-400 font-normal">{row.code}</span>}
                            <span className={row.level === 0 ? "text-slate-800" : row.level === 1 ? "font-bold text-slate-700" : "text-slate-700"}>{row.label}</span>
                          </div>
                          {row.level === 0 && (
                            <span className="block text-[10px] text-slate-400 font-semibold uppercase tracking-wider mt-0.5">
                              {kindLabel[row.kind]}
                              {row.scope === "TOTAL" && " · set tổng"}
                              {row.scope === "DETAIL" && " · set theo hạng mục"}
                              {row.scope === "DERIVED" && " · suy ra"}
                            </span>
                          )}
                          {row.level === 0 && row.hint && !collapsed[row.key] && <span className="block text-[11px] text-slate-500 font-normal mt-0.5 whitespace-normal max-w-[380px]">{row.hint}</span>}
                          {row.warning && <span className="block text-[11px] text-amber-700 font-normal mt-0.5 whitespace-normal max-w-[380px]">{row.warning}</span>}
                        </div>
                      </div>
                    </Cell>
                    <Cell right>{row.actual === null ? <span className="text-slate-400 font-normal">Xem tab Nguồn tiền</span> : <b>{money(row.actual)} đ</b>}</Cell>
                    <Cell right>
                      {row.hasTarget ? (
                        <span>
                          {row.target || row.targetPercent === null ? `${money(Math.round(row.target))} đ` : <span className="text-amber-600 font-bold">Chưa quy đổi được</span>}
                          {row.targetPercent !== null && (
                            <span className="block text-[11px] font-normal text-slate-500">
                              = {percentText(row.targetPercent)}% DT kế hoạch
                              {!row.target && " — set target Doanh thu trước"}
                              {row.standard !== null && row.standard > 0 && ` · chuẩn theo DT thực tế: ${money(Math.round(row.standard))} đ`}
                            </span>
                          )}
                          {row.scope === "ROLLUP" && <span className="block text-[11px] font-normal text-slate-500">cộng từ hạng mục</span>}
                          {row.scope === "DETAIL" && row.level === 0 && row.targetMode === null && (
                            <span className="block text-[11px] font-normal text-slate-500">
                              cộng từ hạng mục{row.standard !== null && row.standard > 0 && ` · chuẩn theo DT thực tế: ${money(Math.round(row.standard))} đ`}
                            </span>
                          )}
                          {row.scope === "DERIVED" && <span className="block text-[11px] font-normal text-slate-500">suy từ target đã set</span>}
                        </span>
                      ) : row.metric ? (
                        <span className="text-slate-400 font-normal">Chưa set</span>
                      ) : row.scope === "DERIVED" ? (
                        <span className="text-slate-400 font-normal text-xs">Set target Doanh thu để suy ra</span>
                      ) : row.scope === "ROLLUP" || (row.scope === "DETAIL" && row.level === 0) ? (
                        <span className="text-slate-400 font-normal text-xs">Chưa set hạng mục nào</span>
                      ) : row.warning ? (
                        <span className="text-slate-400 font-normal text-xs">Không set được</span>
                      ) : (
                        <span className="text-slate-400 font-normal text-xs">Theo dõi theo dòng tổng</span>
                      )}
                    </Cell>
                    <Cell right>
                      {row.variance !== null ? (
                        <span className={`font-bold ${row.isGood ? "text-emerald-600" : "text-rose-600"}`}>{row.variance > 0 ? "+" : ""}{money(Math.round(row.variance))} đ</span>
                      ) : "-"}
                    </Cell>
                    <Cell>
                      {row.usageRate !== null ? (
                        <div className="flex items-center gap-3 min-w-[150px]">
                          <div className="flex-1 bg-slate-100 h-2.5 rounded-full overflow-hidden">
                            <div className={`h-full ${barColor} transition-all duration-500 rounded-full`} style={{ width: `${Math.min(100, Math.max(0, rateVal))}%` }} />
                          </div>
                          <span className={`text-xs font-bold w-12 text-right ${row.isGood ? "text-emerald-600" : "text-rose-600"}`}>{rateVal}%</span>
                        </div>
                      ) : row.actual === null ? (
                        <span className="text-slate-400 text-xs font-normal">Đối chiếu ở tab Nguồn tiền</span>
                      ) : (
                        <span className="text-slate-400 text-xs font-normal">{row.hasTarget ? "Chưa quy đổi" : "Chưa lập target"}</span>
                      )}
                    </Cell>
                    <Cell center>
                      <div className="flex items-center justify-center gap-3" onClick={(event) => event.stopPropagation()}>
                        {editable && (
                          <button type="button" className="text-xs text-blue-600 font-bold hover:underline flex items-center gap-1" onClick={() => (isEditing ? setEditor(null) : openEditor(row))}>
                            <span className="material-symbols-outlined text-sm">{isEditing ? "close" : row.hasTarget ? "edit" : "add_circle"}</span>
                            {isEditing ? "Đóng" : row.hasTarget ? "Sửa" : "Set ngân sách"}
                          </button>
                        )}
                        {row.drilldown && (
                          <button type="button" className="text-xs text-slate-600 font-bold hover:underline flex items-center gap-1" onClick={() => void toggleDrilldown(row)}>
                            <span>{isDrilling ? "Thu gọn" : "Xem phát sinh"}</span>
                            <span className="material-symbols-outlined text-sm">{isDrilling ? "expand_less" : "expand_more"}</span>
                          </button>
                        )}
                      </div>
                    </Cell>
                  </tr>

                  {isEditing && editor && (
                    <tr className="bg-blue-50/40 border-b border-blue-100">
                      <td colSpan={6} className="px-4 py-3">
                        <form onSubmit={(event) => void saveEditor(event, row)} className="flex flex-wrap items-end gap-4">
                          <div className="text-xs font-bold text-slate-700 self-center">
                            Ngân sách <span className="text-blue-700">{row.label}</span>
                            <span className="block text-[11px] font-normal text-slate-500">Kỳ {period} · {branchLabel}</span>
                          </div>
                          {!amountOnly(row) && (
                            <label className="block text-xs font-bold text-slate-600">
                              Cách set
                              <div className="flex gap-4 text-sm font-normal mt-1.5">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input type="radio" name={`mode-${row.key}`} checked={editor.mode === "AMOUNT"} onChange={() => setEditor({ ...editor, mode: "AMOUNT" })} />
                                  Trị giá
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input type="radio" name={`mode-${row.key}`} checked={editor.mode === "PERCENT_REVENUE"} onChange={() => setEditor({ ...editor, mode: "PERCENT_REVENUE" })} />
                                  % doanh thu
                                </label>
                              </div>
                            </label>
                          )}
                          {editor.mode === "PERCENT_REVENUE" ? (
                            <label className="block text-xs font-bold text-slate-600">
                              Tỷ lệ % trên doanh thu
                              <input autoFocus type="number" min="0" max="100" step="0.1" className="control w-40" value={editor.percent} onChange={(event) => setEditor({ ...editor, percent: event.target.value })} />
                              <span className="block text-[11px] font-normal text-slate-500 mt-1">
                                {revenueTarget
                                  ? `≈ ${money(Math.round((revenueTarget * (Number(editor.percent) || 0)) / 100))} đ theo target doanh thu kỳ này`
                                  : "Set target Doanh thu trước để hệ thống quy đổi ra tiền."}
                              </span>
                            </label>
                          ) : (
                            <label className="block text-xs font-bold text-slate-600">
                              Trị giá (đ)
                              <input autoFocus type="number" min="0" step="1000" className="control w-52" value={editor.value} onChange={(event) => setEditor({ ...editor, value: event.target.value })} />
                              {revenueTarget > 0 && Number(editor.value) > 0 && !amountOnly(row) && (
                                <span className="block text-[11px] font-normal text-slate-500 mt-1">≈ {percentText(Number(editor.value) / revenueTarget)}% target doanh thu</span>
                              )}
                            </label>
                          )}
                          <div className="flex items-center gap-2">
                            <button type="submit" disabled={saving} className="primary-button">
                              <span className="material-symbols-outlined text-lg">save</span>Lưu
                            </button>
                            <button type="button" disabled={saving} onClick={() => setEditor(null)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-2 hover:bg-white bg-white">Huỷ</button>
                            {row.hasTarget && (
                              <button type="button" disabled={saving} onClick={() => void removeTarget(row)} className="text-xs font-bold text-rose-600 border border-rose-200 rounded px-3 py-2 hover:bg-rose-50 bg-white">Bỏ ngân sách</button>
                            )}
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}

                  {isDrilling && (
                    <tr className="bg-slate-50 border-t border-b border-slate-200">
                      <td colSpan={6} className="p-4">
                        <div className="bg-white border border-slate-200 rounded-lg p-4 shadow-sm">
                          <div className="flex items-center justify-between mb-3 border-b border-slate-100 pb-2">
                            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                              <span className="material-symbols-outlined text-blue-600 text-base">receipt_long</span>
                              Bảng kê chứng từ phát sinh: <span className="text-blue-600 font-extrabold">{row.label}</span>
                            </h4>
                            <span className="text-xs text-slate-500">Kỳ {period} - {branchLabel}</span>
                          </div>
                          {drilldownLoading ? (
                            <p className="py-6 text-center text-xs text-slate-500 animate-pulse">Đang truy xuất bảng kê sổ cái phát sinh...</p>
                          ) : drilldownRows.length === 0 ? (
                            <p className="py-6 text-center text-xs text-slate-400">Không có chứng từ nào ghi nhận cho chỉ tiêu này trong kỳ.</p>
                          ) : (
                            <div className="overflow-x-auto">
                              <Table headers={["Ngày ghi sổ", "Mã chứng từ", "Mã tài khoản", "Tên tài khoản kế toán", "Diễn giải nghiệp vụ", "Số tiền (đ)"]}>
                                {drilldownRows.map((item) => (
                                  <tr key={`${item.id}-${item.accountCode}-${item.amount}`} className="border-t border-slate-100 text-xs hover:bg-slate-50">
                                    <Cell>{item.date}</Cell>
                                    <Cell><CopyableText value={item.code}><b>{item.code}</b></CopyableText></Cell>
                                    <Cell><span className="bg-blue-50 text-blue-700 font-bold px-2 py-0.5 rounded">{item.accountCode}</span></Cell>
                                    <Cell>{item.accountName}</Cell>
                                    <Cell>{item.description}</Cell>
                                    <Cell right><b>{money(item.amount)} đ</b></Cell>
                                  </tr>
                                ))}
                              </Table>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </Table>
        </div>
      </section>
    </div>
  );
}
