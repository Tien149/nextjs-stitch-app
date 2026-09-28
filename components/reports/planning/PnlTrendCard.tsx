"use client";

import React, { useEffect, useState } from "react";
import { TrendLineChart } from "@/components/charts/ReportCharts";
import { Card } from "@/components/reports/planning/planning-ui";
import { lastPicked, type MonthPick, type PlanningData } from "@/components/reports/planning/planning-types";

type PnlNote = { period: string; note: string; updatedBy: string | null; updatedAt: string };

/**
 * "Biến động Doanh thu – Chi phí – Lợi nhuận – EBITDA" — gộp hai chart cũ (Doanh thu & LN, %
 * biên LN) thành một theo slide mẫu của khách (28/09/2026), kèm ô ghi chú nhận định từng tháng.
 *
 * Báo cáo quản trị nội bộ, không theo mẫu thuế:
 *  - Tổng chi phí = COGS + CAPEX + OPEX (nhân sự + chi phí hoạt động, đã gồm khấu hao).
 *  - Lợi nhuận = Lợi nhuận vận hành (netProfit).
 *  - EBITDA = LN gộp − nhân sự − CAPEX − OPEX + khấu hao, trước thu nhập/chi phí khác (dòng 7
 *    KQKD, chốt 28/09/2026).
 * Chỉ vẽ đường, nối thẳng — khách không muốn cột lẫn đường uốn cong.
 */
export default function PnlTrendCard({ data, picked, monthHeaders, canEdit = true }: {
  data: PlanningData;
  picked: MonthPick;
  monthHeaders: string[];
  canEdit?: boolean;
}) {
  // Tháng chưa phát sinh gì thì bỏ trống điểm (NaN) để đường dừng ở tháng cuối có số.
  const active = data.totals.map((bucket) => Math.abs(bucket.revenue) + Math.abs(bucket.cogs + bucket.payroll + bucket.otherOpex + bucket.capex) > 0.5);
  const series = (pick: (index: number) => number) => data.totals.map((_, index) => (active[index] ? pick(index) : Number.NaN));
  const totalCost = series((index) => {
    const bucket = data.totals[index];
    return bucket.cogs + bucket.capex + bucket.payroll + bucket.otherOpex;
  });

  const defaultMonth = (() => {
    const last = lastPicked(picked);
    if (last >= 0) return last;
    const lastActive = active.lastIndexOf(true);
    return lastActive >= 0 ? lastActive : new Date().getMonth();
  })();
  const [noteMonth, setNoteMonth] = useState(defaultMonth);
  useEffect(() => setNoteMonth(defaultMonth), [defaultMonth]);

  const [notes, setNotes] = useState<PnlNote[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const notePeriod = data.months[noteMonth];
  const saved = notes.find((row) => row.period === notePeriod);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ type: "pnl-note", period: `${data.year}-01`, branchCode: data.branchCode });
    fetch(`/api/reports?${params.toString()}`)
      .then((response) => response.json().catch(() => null))
      .then((payload) => { if (!cancelled && payload && Array.isArray(payload.notes)) setNotes(payload.notes); })
      .catch(() => { if (!cancelled) setStatus({ tone: "error", text: "Không tải được ghi chú." }); });
    return () => { cancelled = true; };
  }, [data.year, data.branchCode]);

  useEffect(() => {
    setDraft(saved?.note || "");
    setStatus(null);
  }, [notePeriod, saved?.note]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "UPSERT_PNL_NOTE", period: notePeriod, branchCode: data.branchCode, note: draft }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Không lưu được ghi chú.");
      const note = draft.trim();
      setNotes((current) => [
        ...current.filter((row) => row.period !== notePeriod),
        ...(note ? [{ period: notePeriod, note, updatedBy: saved?.updatedBy ?? null, updatedAt: new Date().toISOString() }] : []),
      ]);
      setStatus({ tone: "ok", text: note ? "Đã lưu ghi chú." : "Đã xoá ghi chú." });
    } catch (error) {
      setStatus({ tone: "error", text: error instanceof Error ? error.message : "Không lưu được ghi chú." });
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft.trim() !== (saved?.note || "");
  const monthLabel = `T${noteMonth + 1}/${data.year}`;

  return (
    <Card
      title={`Biến động Doanh thu – Chi phí – Lợi nhuận – EBITDA năm ${data.year}`}
      subtitle="Báo cáo quản trị nội bộ: Tổng chi phí = COGS + CAPEX + OPEX (gồm nhân sự); Lợi nhuận = LN vận hành; EBITDA = LN gộp − nhân sự − CAPEX − OPEX + khấu hao (chưa tính thu nhập/chi phí khác)."
      icon="show_chart"
      bodyClassName="px-2 pb-3"
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="min-w-0">
          <TrendLineChart
            labels={monthHeaders}
            series={[
              { name: "Doanh thu", values: series((index) => data.totals[index].revenue), color: "#16a34a" },
              { name: "Tổng chi phí", values: totalCost, color: "#b91c1c" },
              { name: "Lợi nhuận", values: series((index) => data.totals[index].netProfit), color: "#2563eb" },
              { name: "EBITDA", values: series((index) => data.totals[index].ebitda), color: "#a21caf" },
            ]}
          />
        </div>
        <div className="flex min-w-0 flex-col rounded-xl border border-violet-100 bg-violet-50/40 p-3 mx-2 xl:mx-0 xl:mr-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-extrabold uppercase tracking-wide text-violet-700">Ghi chú {monthLabel}</p>
            <select className="control mt-0 w-24 py-1 text-xs" value={noteMonth} onChange={(event) => setNoteMonth(Number(event.target.value))}>
              {monthHeaders.map((label, index) => (
                <option key={label} value={index}>{label}{notes.some((row) => row.period === data.months[index]) ? " •" : ""}</option>
              ))}
            </select>
          </div>
          <textarea
            className="control mt-2 min-h-[220px] flex-1 resize-y text-sm leading-relaxed"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            readOnly={!canEdit}
            maxLength={5000}
            placeholder={`Nhận định tháng ${noteMonth + 1}: doanh thu so chỉ tiêu, lợi nhuận tăng/giảm vì đâu (COGS, lương, marketing, chi phí biến đổi...)`}
          />
          <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
            <span className="min-w-0">
              {status ? (
                <span className={status.tone === "ok" ? "text-emerald-600 font-semibold" : "text-rose-600 font-semibold"}>{status.text}</span>
              ) : saved ? (
                `Lưu lúc ${new Date(saved.updatedAt).toLocaleString("vi-VN")}${saved.updatedBy ? ` · ${saved.updatedBy}` : ""}`
              ) : "Chưa có ghi chú cho tháng này."}
            </span>
            {canEdit && (
              <button type="button" className="shrink-0 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-violet-700 disabled:opacity-50" disabled={!dirty || saving} onClick={save}>
                {saving ? "Đang lưu..." : "Lưu ghi chú"}
              </button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
