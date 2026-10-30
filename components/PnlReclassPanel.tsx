"use client";

import { useCallback, useEffect, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { BranchScopeSelect } from "@/components/BranchScopeSelect";
import { DateInput } from "@/components/DateInput";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import type { DateRange } from "@/lib/date-range";
import { ConfirmDeleteDialog } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import CopyableText from "@/components/CopyableText";
import { MoneyInput } from "@/components/MoneyInput";
import { FilterApplyButton } from "@/components/FilterApplyButton";
import { useAppliedFilters } from "@/lib/use-applied-filters";
import { canPerformAction, type DemoSession } from "@/lib/auth-demo";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { money } from "@/lib/format-number";

type Reclass = {
  id: string;
  code: string;
  documentDate: string;
  period: string;
  branchCode: string;
  fromPnlItemCode: string;
  toPnlItemCode: string;
  amount: number;
  description: string;
  status: string;
  createdBy: string | null;
};
type PnlItemOption = { code: string; name: string; group: string | null };

const API = "/api/pnl-reclassifications";

/**
 * Phiếu điều chỉnh hạng mục P&L trong một nhà hàng (khách 30/10/2026): dời chi phí từ hạng mục A sang
 * hạng mục B, không đụng quỹ / công nợ. Tab thứ hai của màn Chia sẻ chi phí nội bộ.
 */
export default function PnlReclassPanel({ user, pnlItems, initialBranch }: { user: DemoSession; pnlItems: PnlItemOption[]; initialBranch: string }) {
  const filters = useAppliedFilters<{ branchScope: string; dateRange: DateRange }>({ branchScope: initialBranch, dateRange: { from: "", to: "" } });
  const { branchScope, dateRange } = filters.applied;
  const [rows, setRows] = useState<Reclass[]>([]);
  const [message, setMessage] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Reclass | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deleting, setDeleting] = useState<Reclass | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const emptyForm = () => ({
    documentDate: new Date().toISOString().slice(0, 10),
    branchCode: branchScope !== "ALL" ? branchScope : visibleStoreOptions(user)[0]?.code || "",
    fromPnlItemCode: "",
    toPnlItemCode: "",
    amount: "",
    description: "",
  });
  const [form, setForm] = useState(emptyForm);
  const canCreate = canPerformAction(user, "create");
  const canEdit = canPerformAction(user, "edit");
  const canDelete = canPerformAction(user, "delete");

  const itemName = (code: string) => {
    const item = pnlItems.find((row) => row.code === code);
    return item ? `${item.code} - ${item.name}` : code;
  };
  const itemOptions = pnlItems
    .filter((item) => ["OPEX", "COGS"].includes((item.group || "").toUpperCase()))
    .map((item) => ({ value: item.code, label: `${item.code} - ${item.name}` }));

  const loadRows = useCallback(async () => {
    const query = new URLSearchParams({ branchCode: branchScope });
    if (dateRange.from) query.set("from", dateRange.from);
    if (dateRange.to) query.set("to", dateRange.to);
    const response = await fetch(`${API}?${query.toString()}`);
    if (response.ok) setRows((await response.json()) as Reclass[]);
  }, [branchScope, dateRange.from, dateRange.to]);

  useEffect(() => {
    window.setTimeout(() => void loadRows(), 0);
  }, [loadRows]);

  const openForm = (row?: Reclass) => {
    setFormError("");
    setEditing(row || null);
    setForm(row ? {
      documentDate: row.documentDate.slice(0, 10),
      branchCode: row.branchCode,
      fromPnlItemCode: row.fromPnlItemCode,
      toPnlItemCode: row.toPnlItemCode,
      amount: String(row.amount),
      description: row.description,
    } : emptyForm());
    setFormOpen(true);
  };

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError("");
    try {
      const response = await fetch(API, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(editing ? { id: editing.id } : {}), ...form, amount: Number(form.amount) || 0 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setFormError(payload.error || "Không ghi được phiếu điều chỉnh");
        return;
      }
      setMessage(editing ? `Đã sửa phiếu ${payload.code}.` : `Đã lập phiếu ${payload.code} và ghi sổ.`);
      setFormOpen(false);
      setEditing(null);
      await loadRows();
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`${API}?id=${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được phiếu");
        return;
      }
      setMessage(`Đã xoá phiếu ${deleting.code} và gỡ bút toán.`);
      setDeleting(null);
      await loadRows();
    } finally {
      setDeleteSubmitting(false);
    }
  };

  return (
    <>
      {message && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</p>}
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <h2 className="font-bold">Điều chỉnh hạng mục P&amp;L trong nhà hàng</h2>
            <p className="mt-1 text-xs text-slate-500">
              Dời một số tiền chi phí từ hạng mục A sang hạng mục B của cùng nhà hàng, không sửa chứng từ gốc. Chỉ đổi số trên P&amp;L / Tổng hợp chi phí — quỹ và công nợ giữ nguyên.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ExportExcelButton fileName="phieu_dieu_chinh_hang_muc_pnl" sheetName="Dieu chinh hang muc" targetId="pnl-reclass-table" />
            {canCreate && (
              <button type="button" onClick={() => openForm()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700">
                + Lập phiếu điều chỉnh
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <BranchScopeSelect session={user} value={filters.draft.branchScope} onChange={(value) => filters.update({ branchScope: value })} />
          <DateRangeFilter label="Ngày chứng từ" value={filters.draft.dateRange} onChange={(value) => filters.update({ dateRange: value })} />
          <FilterApplyButton dirty={filters.dirty} onApply={filters.apply} />
          <p className="ml-auto text-xs text-slate-500">{rows.length} phiếu · tổng {money(rows.reduce((sum, row) => sum + row.amount, 0))} đ</p>
        </div>
        <div id="pnl-reclass-table" className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                {["Phiếu", "Nhà hàng", "Từ hạng mục (giảm)", "Sang hạng mục (tăng)", "Số tiền", ""].map((label) => <th key={label} className="px-4 py-3">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className="border-t border-slate-100"><td colSpan={6} className="p-10 text-center text-slate-400">Chưa có phiếu điều chỉnh hạng mục nào trong khoảng này.</td></tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <b><CopyableText value={row.code} /></b>
                    <p className="mt-0.5 text-xs text-slate-500">{new Date(row.documentDate).toLocaleDateString("vi-VN", { timeZone: "UTC" })}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{row.description}</p>
                  </td>
                  <td className="px-4 py-3">{storeLabel(row.branchCode)}</td>
                  <td className="px-4 py-3 text-xs"><b className="text-rose-700">− </b>{itemName(row.fromPnlItemCode)}</td>
                  <td className="px-4 py-3 text-xs"><b className="text-emerald-700">+ </b>{itemName(row.toPnlItemCode)}</td>
                  <td className="px-4 py-3 text-right font-bold">{money(row.amount)} đ</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1.5" data-no-export>
                      {canEdit && (
                        <button type="button" onClick={() => openForm(row)} className="rounded-lg border border-blue-200 px-2.5 py-1 text-xs font-bold text-blue-600 hover:bg-blue-50">Sửa</button>
                      )}
                      {canDelete && (
                        <button type="button" onClick={() => { setDeleting(row); setDeleteError(null); }} className="rounded-lg border border-rose-200 px-2.5 py-1 text-xs font-bold text-rose-600 hover:bg-rose-50">Xoá</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {formOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form onSubmit={submitForm} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl">
            <div className="border-b border-slate-200 p-5">
              <h2 className="font-bold text-slate-900">{editing ? `Sửa phiếu điều chỉnh ${editing.code}` : "Lập phiếu điều chỉnh hạng mục P&L"}</h2>
              <p className="mt-1 text-xs text-slate-500">
                Hạng mục A giảm, hạng mục B tăng đúng số tiền, cùng nhà hàng và cùng kỳ của Ngày chứng từ. Chỉ dời được phần chi phí đang có trên sổ của hạng mục A trong kỳ đó.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 p-5">
              <div className="flex flex-col text-xs font-bold text-slate-600">
                <span>Ngày chứng từ *</span>
                <DateInput value={form.documentDate} onChange={(documentDate) => setForm((value) => ({ ...value, documentDate }))} className="mt-1" required ariaLabel="Ngày chứng từ điều chỉnh" />
              </div>
              <label className="block text-xs font-bold text-slate-600">
                Nhà hàng *
                <select
                  value={form.branchCode}
                  onChange={(event) => setForm((value) => ({ ...value, branchCode: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  required
                >
                  <option value="">-- Chọn nhà hàng --</option>
                  {visibleStoreOptions(user).map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
                </select>
              </label>
              <div className="col-span-2 block text-xs font-bold text-slate-600">
                Từ hạng mục (A — giảm) *
                <SearchableSelect className="mt-1" value={form.fromPnlItemCode} onChange={(fromPnlItemCode) => setForm((value) => ({ ...value, fromPnlItemCode }))} placeholder="-- Chọn hạng mục chuyển đi --" options={itemOptions} />
              </div>
              <div className="col-span-2 block text-xs font-bold text-slate-600">
                Sang hạng mục (B — tăng) *
                <SearchableSelect
                  className="mt-1"
                  value={form.toPnlItemCode}
                  onChange={(toPnlItemCode) => setForm((value) => ({ ...value, toPnlItemCode }))}
                  placeholder="-- Chọn hạng mục nhận --"
                  options={itemOptions.filter((option) => option.value !== form.fromPnlItemCode)}
                />
              </div>
              <label className="block text-xs font-bold text-slate-600">
                Số tiền *
                <MoneyInput value={form.amount} onChange={(amount) => setForm((value) => ({ ...value, amount }))} className="mt-1" required ariaLabel="Số tiền điều chỉnh" />
              </label>
              <label className="block text-xs font-bold text-slate-600">
                Lý do / diễn giải *
                <input
                  value={form.description}
                  onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
                  placeholder="VD: Tiền in menu hạch toán nhầm vào Marketing"
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  required
                />
              </label>
              {formError && <p className="col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{formError}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
              <button type="button" onClick={() => { setFormOpen(false); setEditing(null); }} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Đóng</button>
              <button type="submit" disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60">
                {saving ? "Đang ghi sổ..." : editing ? "Lưu và ghi sổ lại" : "Lập phiếu và ghi sổ"}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        title={`Xoá phiếu điều chỉnh ${deleting?.code || ""}?`}
        description="Bút toán của phiếu sẽ được gỡ, số P&L của hai hạng mục về như trước khi điều chỉnh."
        confirmLabel="Xoá phiếu"
        submitting={deleteSubmitting}
        error={deleteError}
        onCancel={() => { setDeleting(null); setDeleteError(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
