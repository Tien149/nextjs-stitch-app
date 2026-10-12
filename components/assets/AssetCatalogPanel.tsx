"use client";

import { useEffect, useMemo, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { ConfirmDeleteDialog } from "@/components/RowActions";
import CopyableText from "@/components/CopyableText";
import { storeLabel } from "@/lib/branch-labels";
import { matchesSearch } from "@/lib/search-text";

/**
 * Danh mục mã Tài sản / CCDC (master list, khách xin 12/10/2026) — giống tab Mặt hàng bên Kho.
 * Tạo mã mới, sửa tên (áp cho mọi đợt / mọi nhà hàng đang dùng mã), ngưng hoặc xoá mã chưa dùng.
 * Nghiệp vụ ở lib/asset-catalog.ts + /api/assets/catalog.
 */
export type CatalogItem = {
  id: string;
  code: string;
  name: string;
  assetGroup: string;
  departmentCode: string | null;
  unit: string | null;
  note: string | null;
  status: string;
  usage: { lotCount: number; branchCodes: string[]; quantity: number; originalCost: number; inUse: number };
};

type Option = { code: string; label: string };

type Props = {
  headers: () => Record<string, string>;
  assetGroups: Option[];
  departments: Option[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Sau khi đổi tên: danh sách hồ sơ tải lại để hiện tên mới. */
  onChanged: () => void;
  /** Tạo hồ sơ (đợt mua) từ một mã của danh mục. */
  onCreateRecord: (item: CatalogItem) => void;
};

const emptyForm = { code: "", name: "", assetGroup: "", departmentCode: "", unit: "", note: "", status: "ACTIVE" };
const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value || 0);
const qty = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value || 0);

export default function AssetCatalogPanel({ headers, assetGroups, departments, canCreate, canEdit, canDelete, onChanged, onCreateRecord }: Props) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [usageFilter, setUsageFilter] = useState("ALL");
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = async () => {
    const response = await fetch("/api/assets/catalog", { headers: headers() });
    const payload = await response.json().catch(() => ({}));
    if (response.ok) setItems(payload.items || []);
    else setMessage({ tone: "error", text: payload.error || "Không tải được danh mục" });
    setLoaded(true);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupLabel = (code: string) => assetGroups.find((group) => group.code === code)?.label || code;
  const departmentLabel = (code: string | null) => (code ? departments.find((department) => department.code === code)?.label || code : "");

  const rows = useMemo(() => items.filter((item) => {
    if (groupFilter !== "ALL" && item.assetGroup !== groupFilter) return false;
    if (statusFilter !== "ALL" && item.status !== statusFilter) return false;
    if (usageFilter === "USED" && item.usage.lotCount === 0) return false;
    if (usageFilter === "UNUSED" && item.usage.lotCount > 0) return false;
    return matchesSearch(search, [item.code, item.name, item.note]);
  }), [items, groupFilter, statusFilter, usageFilter, search]);

  const startCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm, assetGroup: assetGroups[0]?.code || "" });
    setShowForm(true);
    setMessage(null);
  };
  const startEdit = (item: CatalogItem) => {
    setEditing(item);
    setForm({ code: item.code, name: item.name, assetGroup: item.assetGroup, departmentCode: item.departmentCode || "", unit: item.unit || "", note: item.note || "", status: item.status });
    setShowForm(true);
    setMessage(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/assets/catalog", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify(editing ? { id: editing.id, ...form, code: undefined } : form),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage({ tone: "error", text: payload.error || "Không lưu được mã" });
        return;
      }
      setMessage({
        tone: "ok",
        text: editing
          ? `Đã lưu mã ${editing.code}${payload.renamedRecords ? ` — đổi tên ${payload.renamedRecords} hồ sơ đang dùng mã này` : ""}.`
          : `Đã tạo mã ${payload.code} - ${payload.name}.`,
      });
      setShowForm(false);
      setEditing(null);
      await load();
      if (editing && payload.renamedRecords) onChanged();
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/assets/catalog?id=${encodeURIComponent(deleting.id)}`, { method: "DELETE", headers: headers() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được mã");
        return;
      }
      setMessage({ tone: "ok", text: `Đã xoá mã ${deleting.code} (khôi phục được ở Thùng rác).` });
      setDeleting(null);
      await load();
    } finally {
      setDeleteBusy(false);
    }
  };

  const inputClass = "mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white disabled:bg-slate-100 disabled:text-slate-500";
  const usedCount = items.filter((item) => item.usage.lotCount > 0).length;

  return (
    <div className="grid xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)] gap-5">
      {(showForm || canCreate) && (
        <form onSubmit={submit} className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 h-fit">
          <div>
            <p className="text-xs font-bold text-blue-600 uppercase">Danh mục mã</p>
            <h2 className="font-bold text-lg text-slate-900 mt-0.5">{editing ? `Sửa mã ${editing.code}` : "Tạo mã tài sản / CCDC"}</h2>
            <p className="text-[11px] text-slate-500 mt-1">
              {editing
                ? "Đổi tên áp dụng cho mọi đợt, mọi nhà hàng đang dùng mã này. Mã đã có hồ sơ thì không đổi nhóm."
                : "Tạo mã trước, rồi bấm Tạo hồ sơ ở dòng của mã để ghi đợt mua (ngày mua, nguyên giá, số kỳ phân bổ)."}
            </p>
          </div>
          {!showForm ? (
            <button type="button" onClick={startCreate} className="w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 text-sm font-bold inline-flex items-center justify-center gap-2">
              <span className="material-symbols-outlined text-lg">add</span>Thêm mã mới
            </button>
          ) : (
            <>
              <label className="text-xs font-bold text-slate-600 block">
                Mã
                <input
                  className={`${inputClass} font-mono uppercase`}
                  value={form.code}
                  onChange={(e) => setForm((v) => ({ ...v, code: e.target.value.toUpperCase() }))}
                  placeholder="Để trống để hệ thống tự sinh"
                  disabled={Boolean(editing)}
                  maxLength={50}
                />
                {!editing && <span className="mt-1 block text-[11px] font-normal text-slate-500">Tự sinh = 4 ký tự tiền tố nhóm + 3 ký tự phòng ban + 4 số (cần chọn phòng ban).</span>}
              </label>
              <label className="text-xs font-bold text-slate-600 block">
                Tên tài sản / CCDC *
                <input className={inputClass} value={form.name} onChange={(e) => setForm((v) => ({ ...v, name: e.target.value }))} required />
              </label>
              <label className="text-xs font-bold text-slate-600 block">
                Nhóm *
                <select className={inputClass} value={form.assetGroup} onChange={(e) => setForm((v) => ({ ...v, assetGroup: e.target.value }))} disabled={Boolean(editing && editing.usage.lotCount > 0)} required>
                  <option value="">Chọn nhóm</option>
                  {assetGroups.map((group) => <option key={group.code} value={group.code}>{group.label}</option>)}
                </select>
              </label>
              <label className="text-xs font-bold text-slate-600 block">
                Phòng ban mặc định
                <select className={inputClass} value={form.departmentCode} onChange={(e) => setForm((v) => ({ ...v, departmentCode: e.target.value }))}>
                  <option value="">Không chọn</option>
                  {departments.map((department) => <option key={department.code} value={department.code}>{department.label}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  ĐVT
                  <input className={inputClass} value={form.unit} onChange={(e) => setForm((v) => ({ ...v, unit: e.target.value }))} placeholder="cái, bộ..." />
                </label>
                {editing && (
                  <label className="text-xs font-bold text-slate-600 block">
                    Trạng thái
                    <select className={inputClass} value={form.status} onChange={(e) => setForm((v) => ({ ...v, status: e.target.value }))}>
                      <option value="ACTIVE">Đang dùng</option>
                      <option value="INACTIVE">Ngưng</option>
                    </select>
                  </label>
                )}
              </div>
              <label className="text-xs font-bold text-slate-600 block">
                Ghi chú
                <textarea className={`${inputClass} h-16 resize-none`} value={form.note} onChange={(e) => setForm((v) => ({ ...v, note: e.target.value }))} />
              </label>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }} className="flex-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50">Huỷ</button>
                <button type="submit" disabled={saving} className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 text-sm font-bold">
                  {saving ? "Đang lưu..." : editing ? "Lưu" : "Tạo mã"}
                </button>
              </div>
            </>
          )}
          {message && (
            <p className={`text-xs rounded-lg px-3 py-2 border ${message.tone === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"}`}>{message.text}</p>
          )}
        </form>
      )}

      <section className="min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden flex flex-col max-h-[760px]">
        <div className="px-4 py-3 border-b border-slate-200 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-bold text-slate-900 text-base">Danh mục mã Tài sản &amp; CCDC</h2>
              <p className="text-xs text-slate-500">{items.length} mã · {usedCount} mã đang có hồ sơ · {items.length - usedCount} mã chưa có hồ sơ</p>
            </div>
            <ExportExcelButton fileName="danh_muc_ma_tai_san_ccdc" sheetName="Danh muc ma" targetId="asset-catalog-table" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <input type="search" className="border border-slate-300 rounded-lg px-3 py-2 text-sm" placeholder="Tìm mã, tên, ghi chú..." value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option value="ALL">Tất cả nhóm</option>
              {assetGroups.map((group) => <option key={group.code} value={group.code}>{group.label}</option>)}
            </select>
            <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" value={usageFilter} onChange={(e) => setUsageFilter(e.target.value)}>
              <option value="ALL">Có / chưa có hồ sơ</option>
              <option value="USED">Đang có hồ sơ</option>
              <option value="UNUSED">Chưa có hồ sơ</option>
            </select>
            <select className="border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="ACTIVE">Đang dùng</option>
              <option value="INACTIVE">Ngưng</option>
              <option value="ALL">Tất cả trạng thái</option>
            </select>
          </div>
        </div>
        <div id="asset-catalog-table" className="overflow-auto flex-1 custom-scrollbar">
          <table className="w-full text-left text-xs min-w-[980px]">
            <thead className="bg-slate-100 text-slate-600 uppercase font-bold border-b border-slate-200 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3">Mã</th>
                <th className="px-3 py-3">Tên tài sản / CCDC</th>
                <th className="px-3 py-3">Nhóm</th>
                <th className="px-3 py-3">Phòng ban mặc định</th>
                <th className="px-3 py-3">ĐVT</th>
                <th className="px-3 py-3 text-right">Số đợt</th>
                <th className="px-3 py-3">Nhà hàng</th>
                <th className="px-3 py-3 text-right">Tổng SL</th>
                <th className="px-3 py-3 text-right">Tổng nguyên giá</th>
                <th className="px-3 py-3 text-center">Trạng thái</th>
                <th className="px-4 py-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center text-slate-400">{loaded ? "Không có mã nào khớp bộ lọc." : "Đang tải danh mục..."}</td></tr>
              ) : rows.map((item) => (
                <tr key={item.id} className={`hover:bg-slate-50/80 ${editing?.id === item.id ? "bg-blue-50/60" : ""}`}>
                  <td className="px-4 py-2.5 font-mono font-bold text-slate-900"><CopyableText value={item.code} /></td>
                  <td className="px-3 py-2.5">
                    <span className="font-medium text-slate-800">{item.name}</span>
                    {item.note && <p className="text-[11px] text-slate-400">{item.note}</p>}
                  </td>
                  <td className="px-3 py-2.5">{groupLabel(item.assetGroup)}</td>
                  <td className="px-3 py-2.5">{departmentLabel(item.departmentCode)}</td>
                  <td className="px-3 py-2.5">{item.unit || ""}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{item.usage.lotCount || ""}</td>
                  <td className="px-3 py-2.5">{item.usage.branchCodes.map((code) => storeLabel(code)).join(", ")}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{item.usage.lotCount ? qty(item.usage.quantity) : ""}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{item.usage.lotCount ? money(item.usage.originalCost) : ""}</td>
                  <td className="px-3 py-2.5 text-center">
                    {item.status === "ACTIVE"
                      ? <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-800">Đang dùng</span>
                      : <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-slate-200 text-slate-600">Ngưng</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {canCreate && item.status === "ACTIVE" && (
                      <button type="button" onClick={() => onCreateRecord(item)} className="text-[11px] font-bold text-emerald-700 hover:underline mr-3" title="Ghi hồ sơ / đợt mua mới cho mã này">Tạo hồ sơ</button>
                    )}
                    {canEdit && <button type="button" onClick={() => startEdit(item)} className="text-[11px] font-bold text-blue-700 hover:underline mr-3">Sửa</button>}
                    {canDelete && item.usage.lotCount === 0 && (
                      <button type="button" onClick={() => { setDeleteError(null); setDeleting(item); }} className="text-[11px] font-bold text-rose-700 hover:underline">Xoá</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmDeleteDialog
        open={Boolean(deleting)}
        title={`Xoá mã ${deleting?.code || ""}?`}
        description={deleting ? `${deleting.name}. Mã chưa có hồ sơ nào; xoá xong vẫn khôi phục được ở Thùng rác.` : undefined}
        submitting={deleteBusy}
        error={deleteError}
        onCancel={() => { setDeleting(null); setDeleteError(null); }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
