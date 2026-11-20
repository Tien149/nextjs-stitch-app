"use client";

import React, { useState } from "react";
import { formatClock, normalizeShiftDefs, shiftRangeOf, shiftsOf, SHIFT_SLOT_MINUTES, type ShiftConfigs, type ShiftDef } from "@/lib/sales-analysis";

/**
 * Khung "Ca bán hàng theo nhà hàng" của tab DT theo ca & món (khách 20/11/2026: mỗi nhà hàng một
 * kiểu ca — NME Sáng 10:00 / Tối 15:00, ASA Sáng / Trưa 10:30 / Tối 15:00). Mỗi ca chỉ cần tên + giờ
 * bắt đầu; ca kéo tới giờ bắt đầu của ca sau. Lưu vào SalesShiftConfig, áp cho mọi người xem.
 */

const CLOCK_OPTIONS = Array.from({ length: (24 * 60) / SHIFT_SLOT_MINUTES }, (_, index) => formatClock(index * SHIFT_SLOT_MINUTES));

export default function SalesShiftEditor({ branches, configs, canEdit, hasMinuteGap, onSaved }: {
  branches: string[];
  configs: ShiftConfigs;
  canEdit: boolean;
  /** Có dòng chỉ có giờ (import trước khi lưu phút) — báo để người xem biết mốc lẻ phút chưa áp được. */
  hasMinuteGap: boolean;
  onSaved: (branchCode: string, shifts: ShiftDef[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShiftDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const startEdit = (branch: string) => {
    setEditing(branch);
    setDraft(shiftsOf(configs, branch).map((shift) => ({ ...shift })));
    setError("");
  };

  const updateRow = (index: number, patch: Partial<ShiftDef>) => setDraft((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const save = async () => {
    if (!editing) return;
    const cleaned = normalizeShiftDefs(draft);
    if (cleaned.length === 0) {
      setError("Cần ít nhất một ca có tên và giờ bắt đầu.");
      return;
    }
    if (cleaned.length !== draft.filter((row) => row.name.trim()).length) {
      setError("Có ca trùng tên hoặc trùng giờ bắt đầu — sửa lại cho mỗi ca một tên, một giờ.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SAVE_SALES_SHIFTS", branchCode: editing, shifts: cleaned }),
      });
      const payload = (await response.json().catch(() => ({}))) as { shifts?: ShiftDef[]; error?: string };
      if (!response.ok || !payload.shifts) {
        setError(payload.error || "Không lưu được ca.");
        return;
      }
      onSaved(editing, payload.shifts);
      setEditing(null);
    } catch {
      setError("Lỗi kết nối máy chủ khi lưu ca.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
      <div>
        <h2 className="font-bold">Ca bán hàng theo nhà hàng</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Mỗi ca chỉ cần tên và giờ bắt đầu — ca kéo tới giờ bắt đầu của ca sau, ca cuối kéo tới hết ngày; giờ trước ca đầu tiên tính vào ca cuối.
          Các nhà hàng đặt cùng tên ca (Sáng, Tối...) thì khi xem Tất cả cửa hàng được cộng chung một ca.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {branches.map((branch) => {
          const configured = Boolean(configs[branch]?.length);
          const shifts = shiftsOf(configs, branch);
          if (editing === branch) {
            return (
              <div key={branch} className="rounded-lg border border-blue-300 bg-blue-50/40 p-3 space-y-2">
                <p className="text-sm font-bold">{branch}</p>
                {draft.map((row, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input className="control !w-36" value={row.name} placeholder="Tên ca" onChange={(event) => updateRow(index, { name: event.target.value })} />
                    <span className="text-xs text-slate-500">bắt đầu</span>
                    <select className="control !w-24" value={row.from} onChange={(event) => updateRow(index, { from: event.target.value })}>
                      {!CLOCK_OPTIONS.includes(row.from) && <option value={row.from}>{row.from}</option>}
                      {CLOCK_OPTIONS.map((clock) => <option key={clock} value={clock}>{clock}</option>)}
                    </select>
                    <button type="button" className="text-xs font-bold text-rose-600 hover:underline disabled:opacity-40" disabled={draft.length <= 1} onClick={() => setDraft((rows) => rows.filter((_, at) => at !== index))}>
                      Xoá
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button type="button" className="secondary-button !min-h-8 !py-1" onClick={() => setDraft((rows) => [...rows, { name: "", from: "12:00" }])}>+ Thêm ca</button>
                  <button type="button" className="primary-button !min-h-8 !py-1" disabled={saving} onClick={() => void save()}>{saving ? "Đang lưu..." : "Lưu ca"}</button>
                  <button type="button" className="text-xs font-bold text-slate-600 hover:underline" onClick={() => setEditing(null)}>Huỷ</button>
                </div>
                {error && <p className="text-xs text-rose-600">{error}</p>}
              </div>
            );
          }
          return (
            <div key={branch} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold">{branch}{!configured && <span className="ml-2 text-xs font-normal text-amber-700">(chưa khai — đang dùng ca mặc định)</span>}</p>
                {canEdit && <button type="button" className="text-xs font-bold text-blue-600 hover:underline" onClick={() => startEdit(branch)}>Sửa ca</button>}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {shifts.map((shift) => (
                  <span key={shift.name} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                    <b>{shift.name}</b> {shiftRangeOf(shifts, shift.name)}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {hasMinuteGap && (
        <p className="text-xs text-amber-700">
          Doanh thu import trước 20/11/2026 chỉ lưu giờ (không lưu phút) nên tính như phút 00: mốc lẻ phút (VD Trưa từ 10:30) thì cả giờ 10h của các ngày đó vào ca Sáng.
          Muốn chia đúng thì xoá ngày ở Sổ doanh thu rồi nạp lại file có giờ:phút.
        </p>
      )}
    </section>
  );
}
