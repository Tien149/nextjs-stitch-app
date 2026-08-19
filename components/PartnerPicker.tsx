"use client";

import { useState } from "react";
import { SearchableSelect, type OptionItem } from "@/components/SearchableSelect";

export type CreatedPartner = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
  partnerType?: string | null;
  partnerGroup?: string | null;
  status?: string;
};

const partnerTypeOptions = [
  { value: "CUSTOMER", label: "Khách hàng (phải thu)" },
  { value: "SUPPLIER", label: "Nhà cung cấp (phải trả)" },
  { value: "BOTH", label: "Vừa mua vừa bán" },
  { value: "EMPLOYEE", label: "Nhân viên" },
  { value: "OTHER_PARTNER", label: "Đối tác khác" },
];

/**
 * Ô chọn đối tác dùng chung: gõ tìm theo mã/tên, kèm nút "+" tạo nhanh đối tác mới
 * ngay tại chỗ để không phải bỏ dở phiếu chạy sang màn Danh mục.
 *
 * Nút "+" chỉ hiện khi `canCreate` — tạo đối tác đi qua API danh mục nên cần quyền
 * cấu hình danh mục; truyền đúng quyền của user, đừng bật cứng.
 */
export function PartnerPicker({
  value,
  onChange,
  options,
  placeholder = "-- Chọn đối tác --",
  required,
  disabled,
  className = "",
  canCreate = false,
  defaultPartnerType = "SUPPLIER",
  onCreated,
}: {
  value: string;
  onChange: (value: string) => void;
  options: OptionItem[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  canCreate?: boolean;
  defaultPartnerType?: string;
  onCreated?: (partner: CreatedPartner) => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ code: "", name: "", partnerType: defaultPartnerType, phone: "" });

  const submitCreate = async () => {
    if (!draft.code.trim() || !draft.name.trim()) {
      setError("Mã và tên đối tác là bắt buộc.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/master-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "PARTNER",
          code: draft.code.trim().toUpperCase(),
          name: draft.name.trim(),
          partnerType: draft.partnerType,
          group: draft.partnerType,
          phone: draft.phone.trim() || undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || "Không tạo được đối tác.");
        return;
      }
      setShowCreate(false);
      setDraft({ code: "", name: "", partnerType: defaultPartnerType, phone: "" });
      onCreated?.(payload as CreatedPartner);
    } catch {
      setError("Không thể kết nối để tạo đối tác. Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <div className="flex items-start gap-1.5">
        <SearchableSelect
          value={value}
          onChange={onChange}
          options={options}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className="flex-1 min-w-0"
        />
        {canCreate && (
          <button
            type="button"
            onClick={() => { setShowCreate((current) => !current); setError(""); }}
            disabled={disabled}
            title="Tạo mã đối tác mới"
            className="mt-0 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 text-lg font-bold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            +
          </button>
        )}
      </div>

      {showCreate && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
          <p className="text-xs font-bold uppercase text-blue-700">Tạo nhanh đối tác</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-[11px] font-bold text-slate-600">
              Mã *
              <input
                value={draft.code}
                onChange={(event) => setDraft((current) => ({ ...current, code: event.target.value }))}
                placeholder="VD: VE00093"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="text-[11px] font-bold text-slate-600">
              Loại đối tác *
              <select
                value={draft.partnerType}
                onChange={(event) => setDraft((current) => ({ ...current, partnerType: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500"
              >
                {partnerTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="col-span-2 text-[11px] font-bold text-slate-600">
              Tên đối tác *
              <input
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Tên công ty/cá nhân"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label className="col-span-2 text-[11px] font-bold text-slate-600">
              Điện thoại
              <input
                value={draft.phone}
                onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))}
                placeholder="Không bắt buộc"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
              />
            </label>
          </div>
          {error && <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs font-semibold text-rose-700">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50">
              Đóng
            </button>
            <button type="button" onClick={submitCreate} disabled={saving} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-60">
              {saving ? "Đang tạo..." : "Tạo và chọn"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
