"use client";

import { DateInput } from "@/components/DateInput";
import { dateRangePreset, type DateRange, type DateRangePresetId } from "@/lib/date-range";

/**
 * Ô lọc "Từ ngày – Đến ngày" dùng chung cho mọi màn danh sách (khách yêu cầu 03/10/2026:
 * "tất cả các màn hình có thời gian bổ sung lọc theo khoảng thời gian"). Kèm nút nhanh Tháng
 * này / Tháng trước / 30 ngày / Năm nay / Tất cả. Ô trống = không chặn đầu đó.
 */
const PRESETS: Array<{ id: DateRangePresetId; label: string }> = [
  { id: "this-month", label: "Tháng này" },
  { id: "last-month", label: "Tháng trước" },
  { id: "last-30", label: "30 ngày" },
  { id: "this-year", label: "Năm nay" },
  { id: "all", label: "Tất cả" },
];

export function DateRangeFilter({
  value,
  onChange,
  label = "Khoảng thời gian",
  className = "",
  showPresets = true,
}: {
  value: DateRange;
  onChange: (value: DateRange) => void;
  label?: string;
  className?: string;
  showPresets?: boolean;
}) {
  const invalid = Boolean(value.from && value.to && value.to < value.from);
  return (
    <div className={`text-[11px] font-bold text-slate-600 ${className}`}>
      {label}
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <div className="w-[140px]">
          <DateInput value={value.from} onChange={(from) => onChange({ ...value, from })} ariaLabel={`${label} từ ngày`} className="control !mt-0 h-10 w-full text-sm font-normal" />
        </div>
        <span className="text-slate-400">→</span>
        <div className="w-[140px]">
          <DateInput value={value.to} onChange={(to) => onChange({ ...value, to })} ariaLabel={`${label} đến ngày`} className="control !mt-0 h-10 w-full text-sm font-normal" />
        </div>
        {showPresets && (
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => {
              const range = dateRangePreset(preset.id);
              const active = range.from === value.from && range.to === value.to;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onChange(range)}
                  className={`rounded-md border px-2 py-1 text-[11px] font-bold ${active ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {invalid && <p className="mt-1 text-[11px] font-semibold text-rose-600">Đến ngày phải sau Từ ngày.</p>}
    </div>
  );
}
