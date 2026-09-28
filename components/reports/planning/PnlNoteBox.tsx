"use client";

import React, { useEffect, useState } from "react";
import type { PnlNoteKind } from "@/lib/pnl-note";

type PnlNote = { period: string; note: string; updatedBy: string | null; updatedAt: string };

/**
 * Ô ghi chú theo tháng cho các chart Dashboard P&L: chọn tháng, gõ nhận định, lưu. Mỗi tháng x
 * cửa hàng x loại (`kind`) một đoạn văn, lưu ở lib/pnl-note.ts. Dùng chung cho chart biến động
 * (DASHBOARD) và ba khối CP cố định / biến đổi / Marketing (COST_*).
 */
export default function PnlNoteBox({ kind, year, branchCode, months, monthHeaders, defaultMonth, placeholder, canEdit = true, className = "" }: {
  kind: PnlNoteKind;
  year: string;
  branchCode: string;
  /** Kỳ "YYYY-MM" của 12 tháng. */
  months: string[];
  monthHeaders: string[];
  defaultMonth: number;
  placeholder: (monthIndex: number) => string;
  canEdit?: boolean;
  className?: string;
}) {
  // Đổi tháng mặc định (chip tháng) thì ô ghi chú nhảy theo — chỉnh state ngay lúc render thay
  // vì setState trong effect.
  const [noteMonth, setNoteMonth] = useState(defaultMonth);
  const [seenDefault, setSeenDefault] = useState(defaultMonth);
  if (seenDefault !== defaultMonth) {
    setSeenDefault(defaultMonth);
    setNoteMonth(defaultMonth);
  }

  const [notes, setNotes] = useState<PnlNote[]>([]);
  /** Bản nháp đang gõ theo từng kỳ; kỳ chưa gõ gì thì hiện đúng ghi chú đã lưu. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ period: string; tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const notePeriod = months[noteMonth];
  const saved = notes.find((row) => row.period === notePeriod);
  const draft = drafts[notePeriod] ?? saved?.note ?? "";
  const shownStatus = status && (status.period === notePeriod || status.period === "*") ? status : null;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ type: "pnl-note", period: `${year}-01`, branchCode, kind });
    fetch(`/api/reports?${params.toString()}`)
      .then((response) => response.json().catch(() => null))
      .then((payload) => { if (!cancelled && payload && Array.isArray(payload.notes)) setNotes(payload.notes); })
      .catch(() => { if (!cancelled) setStatus({ period: "*", tone: "error", text: "Không tải được ghi chú." }); });
    return () => { cancelled = true; };
  }, [year, branchCode, kind]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "UPSERT_PNL_NOTE", period: notePeriod, branchCode, kind, note: draft }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || "Không lưu được ghi chú.");
      const note = draft.trim();
      setNotes((current) => [
        ...current.filter((row) => row.period !== notePeriod),
        ...(note ? [{ period: notePeriod, note, updatedBy: saved?.updatedBy ?? null, updatedAt: new Date().toISOString() }] : []),
      ]);
      setDrafts((current) => {
        const next = { ...current };
        delete next[notePeriod];
        return next;
      });
      setStatus({ period: notePeriod, tone: "ok", text: note ? "Đã lưu ghi chú." : "Đã xoá ghi chú." });
    } catch (error) {
      setStatus({ period: notePeriod, tone: "error", text: error instanceof Error ? error.message : "Không lưu được ghi chú." });
    } finally {
      setSaving(false);
    }
  };

  const dirty = draft.trim() !== (saved?.note || "");

  return (
    <div className={`flex min-w-0 flex-col rounded-xl border border-violet-100 bg-violet-50/40 p-3 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-extrabold uppercase tracking-wide text-violet-700">Ghi chú T{noteMonth + 1}/{year}</p>
        <select className="control mt-0 w-24 py-1 text-xs" value={noteMonth} onChange={(event) => setNoteMonth(Number(event.target.value))}>
          {monthHeaders.map((label, index) => (
            <option key={label} value={index}>{label}{notes.some((row) => row.period === months[index]) ? " •" : ""}</option>
          ))}
        </select>
      </div>
      <textarea
        className="control mt-2 min-h-[180px] flex-1 resize-y text-sm leading-relaxed"
        value={draft}
        onChange={(event) => { const value = event.target.value; setDrafts((current) => ({ ...current, [notePeriod]: value })); }}
        readOnly={!canEdit}
        maxLength={5000}
        placeholder={placeholder(noteMonth)}
      />
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="min-w-0">
          {shownStatus ? (
            <span className={shownStatus.tone === "ok" ? "text-emerald-600 font-semibold" : "text-rose-600 font-semibold"}>{shownStatus.text}</span>
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
  );
}
