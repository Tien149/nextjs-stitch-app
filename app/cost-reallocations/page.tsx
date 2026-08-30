"use client";

import { useCallback, useEffect, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import CopyableText from "@/components/CopyableText";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";

type ReallocationLine = {
  id: string;
  toBranchCode: string;
  amount: number;
  receivableDebtCode: string | null;
  payableDebtCode: string | null;
  note: string | null;
};

type Reallocation = {
  id: string;
  code: string;
  documentDate: string;
  period: string;
  fromBranchCode: string;
  pnlItemCode: string;
  description: string;
  totalAmount: number;
  status: string;
  createdBy: string | null;
  lines: ReallocationLine[];
};

type PnlItemOption = { id: string; code: string; name: string; group: string | null };

const emptyDraftLine = (key: number) => ({ key, toBranchCode: "", amount: "", note: "" });

export default function CostReallocationsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Reallocation[]>([]);
  const [pnlItems, setPnlItems] = useState<PnlItemOption[]>([]);
  const [branchScope, setBranchScope] = useState("ALL");
  const [message, setMessage] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deleting, setDeleting] = useState<Reallocation | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [form, setForm] = useState({
    documentDate: new Date().toISOString().slice(0, 10),
    fromBranchCode: "",
    pnlItemCode: "",
    description: "",
  });
  const [draftLines, setDraftLines] = useState([emptyDraftLine(1)]);

  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  const draftTotal = draftLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const canCreate = user ? canPerformAction(user, "create") : false;
  const canDelete = user ? canPerformAction(user, "delete") : false;

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/cost-reallocations");
    if (!raw) return void router.push("/login?next=/cost-reallocations");
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) return void router.push("/");
    window.setTimeout(() => {
      setUser(session);
      setBranchScope(resolveInitialBranchScope(session));
      setLoading(false);
    }, 0);
    void fetch("/api/master-data?type=PNL_ITEM&status=ACTIVE")
      .then((response) => response.ok ? response.json() : [])
      .then((data: PnlItemOption[]) => setPnlItems(data));
  }, [router]);

  const loadRows = useCallback(async () => {
    const response = await fetch(`/api/cost-reallocations?branchCode=${encodeURIComponent(branchScope)}`);
    if (response.ok) setRows((await response.json()) as Reallocation[]);
  }, [branchScope]);

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadRows(), 0);
  }, [loading, loadRows]);

  const openForm = () => {
    setFormError("");
    setForm((current) => ({
      ...current,
      fromBranchCode: current.fromBranchCode || (branchScope !== "ALL" ? branchScope : visibleStoreOptions(user)[0]?.code || ""),
    }));
    setDraftLines([emptyDraftLine(1)]);
    setFormOpen(true);
  };

  const submitForm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setFormError("");
    const lines = draftLines.filter((line) => line.toBranchCode || line.amount);
    if (!form.fromBranchCode || !form.pnlItemCode || !form.description.trim() || lines.length === 0) {
      setFormError("Cần chọn nhà hàng đã trả, hạng mục P&L, diễn giải và ít nhất một dòng phân bổ.");
      return;
    }
    if (lines.some((line) => !line.toBranchCode || !(Number(line.amount) > 0))) {
      setFormError("Mỗi dòng phải chọn nhà hàng nhận và số tiền lớn hơn 0.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/cost-reallocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          lines: lines.map((line) => ({ toBranchCode: line.toBranchCode, amount: Number(line.amount), note: line.note })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setFormError(payload.error || "Không tạo được phiếu phân bổ.");
        return;
      }
      setFormOpen(false);
      setForm((current) => ({ ...current, pnlItemCode: "", description: "" }));
      setMessage(`Đã tạo phiếu ${payload.code}: giảm chi phí ${storeLabel(payload.fromBranchCode)}, tăng chi phí ${payload.lines.length} nhà hàng và sinh công nợ nội bộ.`);
      await loadRows();
    } catch {
      setFormError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/cost-reallocations?id=${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được phiếu.");
        return;
      }
      setDeleting(null);
      setMessage("Đã xoá phiếu phân bổ, hoàn tác bút toán và công nợ nội bộ.");
      await loadRows();
    } catch {
      setDeleteError("Không kết nối được máy chủ.");
    } finally {
      setDeleteSubmitting(false);
    }
  };

  if (loading) {
    return <div className="flex h-screen items-center justify-center bg-slate-100">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
    </div>;
  }

  return <div className="min-h-screen bg-slate-100 text-slate-800">
    <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Phân bổ chi phí liên nhà hàng</h1>
          <p className="text-xs text-slate-500">
            Nhà hàng trả hộ chuyển bớt chi phí sang nhà hàng thụ hưởng: giảm chi phí bên trả, tăng bên nhận, kèm công nợ nội bộ để đòi lại tiền.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {canCreate && (
            <button type="button" onClick={openForm} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700">
              + Lập phiếu phân bổ
            </button>
          )}
          <BranchScopeSelect session={user} value={branchScope} onChange={setBranchScope} />
        </div>
      </div>
    </header>

    <main className="mx-auto max-w-7xl space-y-4 p-6">
      {message && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">{message}</p>}

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div>
            <h2 className="font-bold">Danh sách phiếu phân bổ</h2>
            <p className="mt-1 text-xs text-slate-500">
              Phiếu ghi sổ ngay khi lập: không có dòng tiền nào chạy, tiền chỉ chạy khi nhà hàng kia hoàn lại bằng phiếu thu/chi gạch vào mã công nợ bên dưới.
            </p>
          </div>
          <ExportExcelButton fileName="phieu_phan_bo_chi_phi" sheetName="Phan bo" targetId="cost-reallocation-table" />
        </div>
        <div id="cost-reallocation-table" className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                {["Phiếu", "Nhà hàng đã trả", "Hạng mục P&L", "Phân bổ cho", "Tổng tiền", ""].map((label) => (
                  <th key={label} className="px-4 py-3">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className="border-t border-slate-100"><td colSpan={6} className="p-10 text-center text-slate-400">Chưa có phiếu phân bổ nào.</td></tr>
              )}
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <b><CopyableText value={row.code} /></b>
                    <p className="mt-0.5 text-xs text-slate-500">{new Date(row.documentDate).toLocaleDateString("vi-VN", { timeZone: "UTC" })}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{row.description}</p>
                  </td>
                  <td className="px-4 py-3">
                    <b className="text-rose-700">− {storeLabel(row.fromBranchCode)}</b>
                    <p className="text-xs text-slate-500">giảm chi phí</p>
                  </td>
                  <td className="px-4 py-3 text-xs">{row.pnlItemCode}</td>
                  <td className="px-4 py-3">
                    {row.lines.map((line) => (
                      <div key={line.id} className="mb-1.5 last:mb-0">
                        <b className="text-emerald-700">+ {storeLabel(line.toBranchCode)}</b>
                        <span className="ml-2 font-bold">{money(line.amount)} đ</span>
                        <p className="text-[11px] text-slate-500">
                          Công nợ: {line.receivableDebtCode || "-"} / {line.payableDebtCode || "-"}
                        </p>
                      </div>
                    ))}
                  </td>
                  <td className="px-4 py-3 text-right font-bold">{money(row.totalAmount)} đ</td>
                  <td className="px-4 py-3 text-right">
                    {canDelete && row.status !== "CANCELLED" && (
                      <button
                        type="button"
                        onClick={() => { setDeleting(row); setDeleteError(null); }}
                        className="rounded-lg border border-rose-200 px-2.5 py-1 text-xs font-bold text-rose-600 hover:bg-rose-50"
                      >
                        Xoá
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>

    {formOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
        <form onSubmit={submitForm} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-xl">
          <div className="border-b border-slate-200 p-5">
            <h2 className="font-bold text-slate-900">Lập phiếu phân bổ chi phí</h2>
            <p className="mt-1 text-xs text-slate-500">
              Chi phí sẽ được chuyển đúng phần sang nhà hàng thụ hưởng theo cùng hạng mục P&amp;L; tổng chi phí toàn công ty không đổi.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 p-5">
            <div className="flex flex-col text-xs font-bold text-slate-600">
              <span>Ngày chứng từ *</span>
              <DateInput
                value={form.documentDate}
                onChange={(documentDate) => setForm((value) => ({ ...value, documentDate }))}
                className="mt-1"
                required
                ariaLabel="Ngày chứng từ phân bổ"
              />
            </div>
            <label className="text-xs font-bold text-slate-600 block">
              Nhà hàng đã trả 100% *
              <select
                value={form.fromBranchCode}
                onChange={(event) => setForm((value) => ({ ...value, fromBranchCode: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                required
              >
                <option value="">-- Chọn nhà hàng --</option>
                {visibleStoreOptions(user).map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] font-medium text-slate-500">Nhà hàng này sẽ được giảm chi phí.</span>
            </label>
            <div className="col-span-2 text-xs font-bold text-slate-600 block">
              Hạng mục P&amp;L *
              <SearchableSelect
                className="mt-1"
                value={form.pnlItemCode}
                onChange={(pnlItemCode) => setForm((value) => ({ ...value, pnlItemCode }))}
                placeholder="-- Chọn hạng mục chi phí --"
                options={pnlItems
                  .filter((item) => ["OPEX", "COGS"].includes((item.group || "").toUpperCase()))
                  .map((item) => ({ value: item.code, label: `${item.code} - ${item.name}` }))}
              />
              <span className="mt-1 block text-[11px] font-medium text-slate-500">Cả hai đầu ghi cùng hạng mục nên P&amp;L không lệch nhóm.</span>
            </div>
            <label className="col-span-2 text-xs font-bold text-slate-600 block">
              Diễn giải *
              <input
                value={form.description}
                onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
                placeholder="VD: Phân bổ tiền gas tháng 8 do NME trả hộ"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                required
              />
            </label>

            <div className="col-span-2 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3">
              <p className="text-[11px] font-bold uppercase text-indigo-700">Phân bổ cho nhà hàng</p>
              <div className="mt-2 space-y-2">
                {draftLines.map((line, index) => (
                  <div key={line.key} className="grid grid-cols-[1.4fr_1fr_1.4fr_auto] items-center gap-2">
                    <select
                      value={line.toBranchCode}
                      onChange={(event) => setDraftLines((current) => current.map((item) => item.key === line.key ? { ...item, toBranchCode: event.target.value } : item))}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                    >
                      <option value="">{`Nhà hàng dòng ${index + 1}`}</option>
                      {visibleStoreOptions(user)
                        .filter((option) => option.code !== form.fromBranchCode)
                        .map((option) => (
                          <option key={option.code} value={option.code}>{option.label}</option>
                        ))}
                    </select>
                    <input
                      type="number"
                      min="1"
                      value={line.amount}
                      onChange={(event) => setDraftLines((current) => current.map((item) => item.key === line.key ? { ...item, amount: event.target.value } : item))}
                      placeholder="Số tiền"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    <input
                      value={line.note}
                      onChange={(event) => setDraftLines((current) => current.map((item) => item.key === line.key ? { ...item, note: event.target.value } : item))}
                      placeholder="Ghi chú (không bắt buộc)"
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => setDraftLines((current) => current.length > 1 ? current.filter((item) => item.key !== line.key) : current)}
                      className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-bold text-rose-600 hover:bg-rose-50"
                      title="Xoá dòng"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setDraftLines((current) => [...current, emptyDraftLine(Math.max(...current.map((item) => item.key)) + 1)])}
                  className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-50"
                >
                  + Thêm nhà hàng
                </button>
                <span className="text-sm font-bold text-slate-800">Tổng phân bổ: {money(draftTotal)} đ</span>
              </div>
            </div>

            {formError && (
              <p className="col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{formError}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
            <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
              Đóng
            </button>
            <button type="submit" disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60">
              {saving ? "Đang ghi sổ..." : "Lập phiếu và ghi sổ"}
            </button>
          </div>
        </form>
      </div>
    )}

    <ConfirmDeleteDialog
      open={Boolean(deleting)}
      title={`Xoá phiếu phân bổ ${deleting?.code || ""}?`}
      description={deleting ? `Sẽ hoàn tác bút toán ở ${1 + deleting.lines.length} nhà hàng và xoá công nợ nội bộ đã sinh.` : undefined}
      submitting={deleteSubmitting}
      error={deleteError}
      onCancel={() => { setDeleting(null); setDeleteError(null); }}
      onConfirm={confirmDelete}
    />
  </div>;
}
