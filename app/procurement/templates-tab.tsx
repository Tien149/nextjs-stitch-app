"use client";

import { useEffect, useMemo, useState } from "react";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { defaultPurchaseUnit } from "@/lib/unit-conversion";
import type { DemoSession } from "@/lib/auth-demo";

export type TemplateUnitConversion = { id: string; unitCode: string; unitName: string | null; conversionRate: number; isDefaultPurchase: boolean };
export type TemplateItem = { id: string; code: string; name: string; unit: string; itemType: string; unitConversions?: TemplateUnitConversion[] };
export type TemplateLine = { id: string; itemId: string; unitCode: string | null; sortOrder: number; note: string | null; item: TemplateItem };
export type PurchaseTemplate = { id: string; code: string; name: string; branchCode: string | null; departmentCode: string | null; status: string; note: string | null; lines: TemplateLine[] };
export type DepartmentOption = { id: string; code: string; name: string; branch: string | null };

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Nháp form lưu trong sessionStorage: dev server reload (Fast Refresh), F5 hay điện thoại
 * rớt trang giữa chừng thì dữ liệu đang gõ không mất — mở lại tab là nháp tự khôi phục.
 */
const MANAGE_DRAFT_KEY = "procurement_template_manage_draft";
const FILL_DRAFT_KEY = "procurement_template_fill_draft";

function readDraft<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sessionStorage bị chặn (chế độ riêng tư...) thì bỏ qua — form vẫn hoạt động bình thường.
  }
}

function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

type ManageDraft = {
  form: { name: string; branchCode: string; departmentCode: string; note: string };
  rows: Array<{ itemId: string; unitCode: string }>;
  editingId: string | null;
};

type FillDraft = {
  templateId: string;
  branch: string;
  department: string;
  neededDate: string;
  note: string;
  quantities: Record<string, string>;
};

/** ĐVT hiển thị của một dòng mẫu: ĐVT khai trên mẫu -> ĐVT mua mặc định -> ĐVT tồn kho. */
function lineUnit(line: { unitCode: string | null; item: TemplateItem }) {
  return defaultPurchaseUnit(line.item.unit, line.item.unitConversions, line.unitCode).unitLabel;
}

/**
 * Số lượng quy về ĐVT tồn kho — hiện ngay dưới ô nhập để người đặt thấy đúng thứ PR sẽ ghi
 * (chỉ hiện khi thực sự có quy đổi, ví dụ 2 thùng = 48 lon).
 */
function baseQuantityHint(line: { unitCode: string | null; item: TemplateItem }, quantity: string) {
  const { conversionRate } = defaultPurchaseUnit(line.item.unit, line.item.unitConversions, line.unitCode);
  const value = Number(quantity || 0);
  if (conversionRate === 1 || !(value > 0)) return "";
  return `= ${new Intl.NumberFormat("vi-VN").format(value * conversionRate)} ${line.item.unit}`;
}

/**
 * Tab "Đặt theo mẫu": nhân viên nhà hàng mở mẫu set sẵn trên điện thoại, điền số lượng
 * vào dòng cần mua rồi gửi — hệ thống tạo PR nhiều dòng chờ duyệt. Bên dưới là khu
 * quản lý mẫu cho người có quyền (tạo/sửa/xoá mẫu: tên hàng + ĐVT, không có số lượng).
 */
export function TemplatesTab({
  user,
  canCreate,
  canEdit,
  items,
  templates,
  departments,
  notify,
  reload,
}: {
  user: DemoSession | null;
  canCreate: boolean;
  canEdit: boolean;
  items: TemplateItem[];
  templates: PurchaseTemplate[];
  departments: DepartmentOption[];
  notify: (message: string) => void;
  reload: () => Promise<void>;
}) {
  /** Mẫu đang mở để điền số lượng. */
  const [filling, setFilling] = useState<PurchaseTemplate | null>(null);
  const [fillBranch, setFillBranch] = useState("");
  const [fillDepartment, setFillDepartment] = useState("");
  const [fillNeededDate, setFillNeededDate] = useState(today());
  const [fillNote, setFillNote] = useState("");
  const [fillQuantities, setFillQuantities] = useState<Record<string, string>>({});
  const [fillSearch, setFillSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /** Khu quản lý mẫu. */
  const [showManage, setShowManage] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<PurchaseTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState({ name: "", branchCode: "", departmentCode: "", note: "" });
  const [templateRows, setTemplateRows] = useState<Array<{ itemId: string; unitCode: string }>>([{ itemId: "", unitCode: "" }]);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PurchaseTemplate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Đã khôi phục nháp xong chưa — chưa xong thì không ghi đè nháp bằng state rỗng ban đầu. */
  const [draftRestored, setDraftRestored] = useState(false);

  // Khôi phục nháp sau khi mount (chỉ chạy phía client để không lệch hydration).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const manage = readDraft<ManageDraft>(MANAGE_DRAFT_KEY);
      if (manage) {
        setTemplateForm(manage.form);
        setTemplateRows(manage.rows.length > 0 ? manage.rows : [{ itemId: "", unitCode: "" }]);
        setShowManage(true);
      }
      const fill = readDraft<FillDraft>(FILL_DRAFT_KEY);
      if (fill) {
        setFillBranch(fill.branch);
        setFillDepartment(fill.department);
        setFillNeededDate(fill.neededDate);
        setFillNote(fill.note);
        setFillQuantities(fill.quantities);
      }
      setDraftRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Danh sách mẫu về sau (loadData bất đồng bộ) -> gắn lại mẫu đang sửa / đang điền theo nháp.
  useEffect(() => {
    if (!draftRestored || templates.length === 0) return;
    const timer = window.setTimeout(() => {
      const manage = readDraft<ManageDraft>(MANAGE_DRAFT_KEY);
      if (manage?.editingId) {
        const template = templates.find((candidate) => candidate.id === manage.editingId);
        if (template) setEditingTemplate((current) => current || template);
      }
      const fill = readDraft<FillDraft>(FILL_DRAFT_KEY);
      if (fill) {
        const template = templates.find((candidate) => candidate.id === fill.templateId);
        if (template) setFilling((current) => current || template);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftRestored, templates]);

  // Tự lưu nháp form quản lý mẫu mỗi khi gõ.
  useEffect(() => {
    if (!draftRestored || !showManage) return;
    const hasContent = Boolean(
      templateForm.name || templateForm.note || templateForm.branchCode || templateForm.departmentCode ||
      templateRows.some((row) => row.itemId) || editingTemplate,
    );
    if (hasContent) {
      writeDraft(MANAGE_DRAFT_KEY, { form: templateForm, rows: templateRows, editingId: editingTemplate?.id || null } satisfies ManageDraft);
    } else {
      clearDraft(MANAGE_DRAFT_KEY);
    }
  }, [draftRestored, showManage, templateForm, templateRows, editingTemplate]);

  // Tự lưu nháp màn điền mẫu (số lượng đang gõ trên điện thoại).
  useEffect(() => {
    if (!draftRestored || !filling) return;
    writeDraft(FILL_DRAFT_KEY, {
      templateId: filling.id,
      branch: fillBranch,
      department: fillDepartment,
      neededDate: fillNeededDate,
      note: fillNote,
      quantities: fillQuantities,
    } satisfies FillDraft);
  }, [draftRestored, filling, fillBranch, fillDepartment, fillNeededDate, fillNote, fillQuantities]);

  const branchOptions = visibleStoreOptions(user);
  const itemOptions = useMemo(
    () => items.map((item) => ({ value: item.id, label: `${item.name} (${item.code})`, subLabel: item.unit })),
    [items],
  );

  const departmentsForBranch = (branchCode: string) =>
    departments.filter((item) => !item.branch || item.branch === "ALL" || item.branch === branchCode);

  const startFilling = (template: PurchaseTemplate) => {
    const branchCode = template.branchCode || branchOptions[0]?.code || "HCM";
    setFilling(template);
    setFillBranch(branchCode);
    setFillDepartment(template.departmentCode || departmentsForBranch(branchCode)[0]?.code || "");
    setFillNeededDate(today());
    setFillNote("");
    setFillQuantities({});
    setFillSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const filledCount = filling
    ? filling.lines.filter((line) => Number(fillQuantities[line.id] || 0) > 0).length
    : 0;

  const visibleFillLines = filling
    ? filling.lines.filter((line) => {
        const keyword = fillSearch.trim().toLowerCase();
        if (!keyword) return true;
        return line.item.name.toLowerCase().includes(keyword) || line.item.code.toLowerCase().includes(keyword);
      })
    : [];

  const submitFill = async () => {
    if (!filling) return;
    const lines = filling.lines
      .map((line) => ({ lineId: line.id, quantity: Number(fillQuantities[line.id] || 0) }))
      .filter((line) => line.quantity > 0);
    if (lines.length === 0) {
      notify("Chưa điền số lượng cho dòng nào — nhập số lượng vào các mặt hàng cần đặt rồi gửi.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/procurement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_REQUEST_FROM_TEMPLATE",
          templateId: filling.id,
          branchCode: fillBranch,
          departmentCode: fillDepartment,
          neededDate: fillNeededDate,
          note: fillNote,
          lines,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify(payload.error || "Không gửi được yêu cầu mua hàng");
        return;
      }
      notify(`Đã gửi yêu cầu ${payload.code} (${lines.length} mặt hàng) — mua hàng có thể so sánh giá và đặt hàng ngay.`);
      setFilling(null);
      clearDraft(FILL_DRAFT_KEY);
      await reload();
    } finally {
      setSubmitting(false);
    }
  };

  const resetTemplateForm = () => {
    setEditingTemplate(null);
    setTemplateForm({ name: "", branchCode: "", departmentCode: "", note: "" });
    setTemplateRows([{ itemId: "", unitCode: "" }]);
    clearDraft(MANAGE_DRAFT_KEY);
  };

  const startEditTemplate = (template: PurchaseTemplate) => {
    setShowManage(true);
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      branchCode: template.branchCode || "",
      departmentCode: template.departmentCode || "",
      note: template.note || "",
    });
    setTemplateRows(template.lines.map((line) => ({ itemId: line.itemId, unitCode: line.unitCode || "" })));
  };

  const submitTemplate = async (event: React.FormEvent) => {
    event.preventDefault();
    const lines = templateRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, unitCode: row.unitCode || undefined }));
    if (lines.length === 0) {
      notify("Mẫu cần ít nhất một mặt hàng.");
      return;
    }
    setSavingTemplate(true);
    try {
      const response = await fetch("/api/procurement", {
        method: editingTemplate ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: editingTemplate ? "UPDATE_TEMPLATE" : "CREATE_TEMPLATE",
          ...(editingTemplate ? { templateId: editingTemplate.id } : {}),
          name: templateForm.name,
          branchCode: templateForm.branchCode,
          departmentCode: templateForm.departmentCode,
          note: templateForm.note,
          lines,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify(payload.error || "Không lưu được mẫu");
        return;
      }
      notify(editingTemplate ? `Đã lưu mẫu ${payload.code}.` : `Đã tạo mẫu ${payload.code} — bộ phận vào tab này điền số lượng để đặt hàng.`);
      resetTemplateForm();
      await reload();
    } finally {
      setSavingTemplate(false);
    }
  };

  const confirmDeleteTemplate = async (reason: string) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ type: "TEMPLATE", id: deleteTarget.id });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/procurement?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được mẫu");
        return;
      }
      if (editingTemplate?.id === deleteTarget.id) resetTemplateForm();
      if (filling?.id === deleteTarget.id) setFilling(null);
      setDeleteTarget(null);
      notify(`Đã chuyển mẫu ${deleteTarget.code} vào Thùng rác.`);
      await reload();
    } finally {
      setDeleting(false);
    }
  };

  /** Các ĐVT chọn được cho một mặt hàng trên mẫu: mặc định (ĐVT mua) + từng quy đổi. */
  const unitOptionsForItem = (itemId: string) => {
    const item = items.find((candidate) => candidate.id === itemId);
    const conversions = item?.unitConversions || [];
    const defaultUnit = conversions.find((unit) => unit.isDefaultPurchase);
    return {
      defaultLabel: `Mặc định: ${defaultUnit?.unitName || defaultUnit?.unitCode || item?.unit || "ĐVT tồn kho"}`,
      conversions,
    };
  };

  // ───────────────────────── Màn điền mẫu ─────────────────────────
  if (filling) {
    return (
      <div className="max-w-2xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <div className="p-4 sm:p-5 border-b border-slate-100 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800 leading-snug">{filling.name}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{filling.code} · {filling.lines.length} mặt hàng — chỉ điền số lượng vào dòng cần đặt</p>
            </div>
            <button type="button" onClick={() => { setFilling(null); clearDraft(FILL_DRAFT_KEY); }} className="icon-button shrink-0" title="Quay lại danh sách mẫu">
              <span className="material-symbols-outlined text-lg">arrow_back</span>
            </button>
          </div>

          <div className="p-4 sm:p-5 grid grid-cols-2 gap-3 border-b border-slate-100">
            <label className="block text-xs font-bold text-slate-600">Cửa hàng
              <select
                className="control"
                value={fillBranch}
                disabled={Boolean(filling.branchCode)}
                onChange={(e) => {
                  const branchCode = e.target.value;
                  setFillBranch(branchCode);
                  setFillDepartment(filling.departmentCode || departmentsForBranch(branchCode)[0]?.code || "");
                }}
              >
                {branchOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-600">Bộ phận đặt
              <select className="control" value={fillDepartment} onChange={(e) => setFillDepartment(e.target.value)}>
                {departmentsForBranch(fillBranch).map((item) => <option key={item.id} value={item.code}>{item.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-600">Ngày cần hàng
              <DateInput value={fillNeededDate} onChange={setFillNeededDate} className="control" ariaLabel="Ngày cần hàng" />
            </label>
            <label className="block text-xs font-bold text-slate-600">Ghi chú
              <input className="control" value={fillNote} onChange={(e) => setFillNote(e.target.value)} placeholder="Không bắt buộc" />
            </label>
          </div>

          <div className="p-4 sm:p-5 pb-2">
            <input
              type="search"
              className="control !mt-0"
              placeholder="Tìm nhanh mặt hàng trong mẫu..."
              value={fillSearch}
              onChange={(e) => setFillSearch(e.target.value)}
            />
          </div>

          <div className="px-4 sm:px-5 pb-4 space-y-2">
            {visibleFillLines.map((line) => {
              const quantity = fillQuantities[line.id] || "";
              const active = Number(quantity) > 0;
              return (
                <div key={line.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${active ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white"}`}>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-slate-800 leading-snug">{line.item.name}</p>
                    <p className="text-xs text-slate-500">
                      {line.item.code} · ĐVT: <b>{lineUnit(line)}</b>
                      {baseQuantityHint(line, quantity) ? <span className="text-blue-700 font-semibold"> {baseQuantityHint(line, quantity)}</span> : null}
                      {line.note ? ` · ${line.note}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      className="control !mt-0 w-20 text-right text-base"
                      placeholder="0"
                      value={quantity}
                      onChange={(e) => { const value = e.target.value; setFillQuantities((current) => ({ ...current, [line.id]: value })); }}
                      aria-label={`Số lượng ${line.item.name}`}
                    />
                    <span className="text-xs font-semibold text-slate-500 w-12 truncate">{lineUnit(line)}</span>
                  </div>
                </div>
              );
            })}
            {visibleFillLines.length === 0 && (
              <p className="text-sm text-slate-500 py-3 text-center">Không có mặt hàng khớp từ khoá.</p>
            )}
          </div>

          {/* Thanh gửi dính đáy màn hình — chừa chỗ nút menu nổi bên trái trên điện thoại */}
          <div className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 rounded-b-lg flex items-center gap-3 pl-20 lg:pl-4">
            <p className="text-xs text-slate-600 shrink-0">
              Đã điền <b className="text-blue-700">{filledCount}</b>/{filling.lines.length} dòng
            </p>
            <button type="button" disabled={submitting || filledCount === 0} onClick={() => void submitFill()} className="primary-button flex-1 !min-h-12">
              <span className="material-symbols-outlined text-lg">send</span>
              {submitting ? "Đang gửi..." : "Gửi yêu cầu mua hàng"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ───────────────────────── Danh sách mẫu + quản lý ─────────────────────────
  const activeTemplates = templates.filter((template) => template.status === "ACTIVE");

  return (
    <div className="space-y-5">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-slate-800">Chọn mẫu để đặt hàng</h2>
          {canCreate && (
            <button type="button" onClick={() => { setShowManage((current) => !current); if (showManage) resetTemplateForm(); }} className="secondary-button !min-h-9 text-xs">
              <span className="material-symbols-outlined text-lg">{showManage ? "expand_less" : "settings"}</span>
              {showManage ? "Đóng quản lý mẫu" : "Quản lý mẫu"}
            </button>
          )}
        </div>

        {activeTemplates.length === 0 && (
          <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-sm text-slate-500 text-center">
            Chưa có mẫu nào. {canCreate ? "Bấm \"Quản lý mẫu\" để tạo mẫu đầu tiên (chỉ cần tên hàng + ĐVT)." : "Liên hệ quản lý để tạo mẫu đặt hàng."}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {activeTemplates.map((template) => (
            <div key={template.id} className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-bold text-slate-800 leading-snug">{template.name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {template.code} · {template.lines.length} mặt hàng
                  </p>
                </div>
                {(canEdit || canCreate) && (
                  <RowActions
                    session={user}
                    module="/procurement"
                    compact
                    onEdit={() => startEditTemplate(template)}
                    onDelete={() => { setDeleteError(null); setDeleteTarget(template); }}
                  />
                )}
              </div>
              <p className="text-xs text-slate-500">
                {template.branchCode ? storeLabel(template.branchCode) : "Dùng chung mọi cửa hàng"}
                {template.departmentCode ? ` · ${departments.find((item) => item.code === template.departmentCode)?.name || template.departmentCode}` : ""}
              </p>
              <p className="text-xs text-slate-400 line-clamp-2">
                {template.lines.slice(0, 4).map((line) => line.item.name).join(", ")}{template.lines.length > 4 ? ",…" : ""}
              </p>
              {canCreate && (
                <button type="button" onClick={() => startFilling(template)} className="primary-button w-full !min-h-11 mt-auto">
                  <span className="material-symbols-outlined text-lg">edit_note</span>Đặt hàng theo mẫu này
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* canEdit cũng phải mở được khối này: nút Sửa trên thẻ mẫu gác theo quyền edit, chỉ gác
          khối form theo canCreate thì người có mỗi quyền sửa bấm Sửa xong không thấy gì hiện ra. */}
      {showManage && (canCreate || canEdit) && (
        <section className="bg-white border border-slate-200 rounded-lg shadow-sm p-4 sm:p-5">
          <h2 className="font-bold text-slate-800 mb-1">{editingTemplate ? `Sửa mẫu ${editingTemplate.code}` : "Tạo mẫu mới"}</h2>
          <p className="text-xs text-slate-500 mb-4">Mẫu chỉ gồm tên hàng + ĐVT (không có số lượng). Bộ phận cần đặt sẽ mở mẫu và điền số lượng.</p>
          <form onSubmit={submitTemplate} className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-xs font-bold text-slate-600">Tên mẫu
                <input className="control" required value={templateForm.name} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, name: value })); }} placeholder="VD: Mẫu đặt hàng Bếp" />
              </label>
              <label className="block text-xs font-bold text-slate-600">Cửa hàng áp dụng
                <select className="control" value={templateForm.branchCode} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, branchCode: value })); }}>
                  <option value="">Dùng chung mọi cửa hàng</option>
                  {branchOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-600">Bộ phận mặc định
                <select className="control" value={templateForm.departmentCode} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, departmentCode: value })); }}>
                  <option value="">Người đặt tự chọn</option>
                  {departments.map((item) => <option key={item.id} value={item.code}>{item.name}{item.branch && item.branch !== "ALL" ? ` (${storeLabel(item.branch)})` : ""}</option>)}
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-600">Ghi chú
                <input className="control" value={templateForm.note} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, note: value })); }} />
              </label>
            </div>

            <div className="space-y-3 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
              <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Danh sách mặt hàng của mẫu</h3>
                <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setTemplateRows((rows) => [...rows, { itemId: "", unitCode: "" }])}>
                  <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                </button>
              </div>
              {templateRows.map((row, index) => {
                const { defaultLabel, conversions } = unitOptionsForItem(row.itemId);
                return (
                  <div key={index} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Hàng #{index + 1}</span>
                      {templateRows.length > 1 && (
                        <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => setTemplateRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>Xóa</button>
                      )}
                    </div>
                    <div className="grid sm:grid-cols-[minmax(0,1fr)_180px] gap-2">
                      <SearchableSelect
                        value={row.itemId}
                        onChange={(itemId) => setTemplateRows((rows) => rows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId, unitCode: "" } : candidate))}
                        options={itemOptions}
                        placeholder="Chọn mặt hàng..."
                      />
                      <select
                        className="control !mt-0"
                        value={row.unitCode}
                        onChange={(e) => { const value = e.target.value; setTemplateRows((rows) => rows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, unitCode: value } : candidate)); }}
                      >
                        <option value="">{defaultLabel}</option>
                        {conversions.map((unit) => (
                          <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              {editingTemplate && (
                <button type="button" onClick={resetTemplateForm} className="secondary-button">Huỷ</button>
              )}
              <button className="primary-button flex-1" disabled={savingTemplate}>
                <span className="material-symbols-outlined text-lg">{editingTemplate ? "save" : "add"}</span>
                {savingTemplate ? "Đang lưu..." : editingTemplate ? "Lưu mẫu" : "Tạo mẫu"}
              </button>
            </div>
          </form>
        </section>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget ? `Xoá mẫu ${deleteTarget.code}?` : ""}
        description={deleteTarget ? `${deleteTarget.name} · ${deleteTarget.lines.length} mặt hàng` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
        onConfirm={confirmDeleteTemplate}
      />
    </div>
  );
}
