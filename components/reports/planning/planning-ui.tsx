"use client";

import React from "react";
import { money, statValueTextClass } from "@/components/reports/report-ui";
import { compactVnd } from "@/components/charts/ReportCharts";

/**
 * Bộ primitive giao diện cho cụm màn "Hoạch định tài chính" — học theo bố cục phần mềm
 * Omni Plan mà khách hàng đã xem (tab dạng viên thuốc, chip lũy kế tháng T1..T12, thẻ KPI số
 * kế hoạch màu + dòng "Thực đạt" kèm chip %, badge trạng thái định mức). Giữ tone màu
 * slate/indigo để đồng bộ với phần còn lại của app.
 */

export { statValueTextClass };
export const fmtMoney = (value: number) => `${money(Math.round(value))} đ`;
export const fmtCompact = (value: number) => compactVnd(value);
export const ratioOf = (numerator: number, denominator: number) => (denominator ? numerator / denominator : null);
export const pctText = (rate: number | null, digits = 1) => (rate === null || !Number.isFinite(rate) ? "—" : `${(rate * 100).toFixed(digits)}%`);
export const signedMoney = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.round(Math.abs(value)))} đ`;

export type Tone = "indigo" | "blue" | "emerald" | "amber" | "rose" | "violet" | "sky" | "slate" | "teal" | "orange";

export const toneText: Record<Tone, string> = {
  indigo: "text-indigo-600", blue: "text-blue-600", emerald: "text-emerald-600", amber: "text-amber-600", rose: "text-rose-600",
  violet: "text-violet-600", sky: "text-sky-600", slate: "text-slate-700", teal: "text-teal-600", orange: "text-orange-600",
};
export const toneSoft: Record<Tone, string> = {
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-100", blue: "bg-blue-50 text-blue-700 border-blue-100", emerald: "bg-emerald-50 text-emerald-700 border-emerald-100",
  amber: "bg-amber-50 text-amber-700 border-amber-100", rose: "bg-rose-50 text-rose-700 border-rose-100", violet: "bg-violet-50 text-violet-700 border-violet-100",
  sky: "bg-sky-50 text-sky-700 border-sky-100", slate: "bg-slate-100 text-slate-600 border-slate-200", teal: "bg-teal-50 text-teal-700 border-teal-100", orange: "bg-orange-50 text-orange-700 border-orange-100",
};
export const toneBar: Record<Tone, string> = {
  indigo: "bg-indigo-500", blue: "bg-blue-500", emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500",
  violet: "bg-violet-500", sky: "bg-sky-500", slate: "bg-slate-400", teal: "bg-teal-500", orange: "bg-orange-500",
};

/** Thanh tab dạng viên thuốc (như thanh "Dự báo P&L · Dashboard P&L · Định mức ..." của phần mềm mẫu). */
export function PillTabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string; icon: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-full p-1 overflow-x-auto max-w-full">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-bold transition-colors ${isActive ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"}`}
          >
            <span className="material-symbols-outlined text-base">{tab.icon}</span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Chip "LŨY KẾ THÁNG: T1 ... T12" — chọn tháng cuối của khoảng lũy kế (0-based). */
export function MonthChips({ upTo, onChange, label = "Lũy kế tháng" }: { upTo: number; onChange: (index: number) => void; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-xl px-4 py-2.5">
      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mr-1 flex items-center gap-1">
        <span className="material-symbols-outlined text-base">filter_alt</span>{label}:
      </span>
      {Array.from({ length: 12 }, (_, index) => (
        <button
          key={index}
          type="button"
          onClick={() => onChange(index)}
          className={`h-7 min-w-8 px-2 rounded-md text-xs font-bold transition-colors ${index <= upTo ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
          title={index <= upTo ? `Đang gộp tới tháng ${index + 1}` : `Gộp tới tháng ${index + 1}`}
        >
          T{index + 1}
        </button>
      ))}
      <span className="ml-auto text-xs font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1">Tổng lũy kế: {upTo + 1} tháng</span>
    </div>
  );
}

/** Thẻ KPI: nhãn màu chữ hoa, số lớn màu, dòng phụ "Thực đạt" + chip %. */
export function StatCard({ label, value, tone = "indigo", sub, rate, rateGood, hint, icon }: {
  label: string; value: string; tone?: Tone; sub?: string; rate?: number | null; rateGood?: boolean | null; hint?: string; icon?: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm min-w-0" title={hint}>
      <div className="flex items-center justify-between gap-2">
        <p className={`text-[10px] font-bold uppercase tracking-wider ${toneText[tone]}`}>{label}</p>
        {icon && <span className={`material-symbols-outlined text-lg ${toneText[tone]} opacity-70`}>{icon}</span>}
      </div>
      {/* Không truncate: thà chữ nhỏ hơn một nấc còn hơn giấu mất chữ số cuối. */}
      <p className={`mt-1.5 font-extrabold tracking-tight leading-tight tabular-nums whitespace-nowrap ${statValueTextClass(value)} ${toneText[tone]}`} title={value}>{value}</p>
      {(sub || rate !== undefined) && (
        // Dòng phụ cũng mang số tiền đủ chữ số nên cho xuống dòng khi thẻ hẹp, không cắt đuôi.
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-slate-500">
          <span className="min-w-0 tabular-nums">{sub}</span>
          {rate !== undefined && <RateChip rate={rate} good={rateGood ?? null} />}
        </div>
      )}
    </div>
  );
}

/** Chip tỷ lệ: xanh khi tốt, đỏ khi xấu, xám khi chưa so được. */
export function RateChip({ rate, good, className = "" }: { rate: number | null; good: boolean | null; className?: string }) {
  const tone = rate === null ? "bg-slate-100 text-slate-500" : good === null ? "bg-indigo-50 text-indigo-700" : good ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700";
  return <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap ${tone} ${className}`}>{pctText(rate)}</span>;
}

/** Khung card có tiêu đề + mô tả + vùng nút bên phải. */
export function Card({ title, subtitle, right, children, className = "", bodyClassName = "p-4", icon }: {
  title?: React.ReactNode; subtitle?: string; right?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string; icon?: string;
}) {
  return (
    <section className={`bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden ${className}`}>
      {(title || right) && (
        <div className="px-4 pt-4 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h3 className="font-bold text-slate-800 flex items-center gap-1.5">{icon && <span className="material-symbols-outlined text-lg text-indigo-500">{icon}</span>}{title}</h3>}
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** Nhãn nhỏ (tên cửa hàng, nhóm hạng mục, CĐ/BĐ). */
export function Tag({ children, tone = "slate", className = "" }: { children: React.ReactNode; tone?: Tone; className?: string }) {
  return <span className={`inline-block rounded-md border px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap ${toneSoft[tone]} ${className}`}>{children}</span>;
}

/** Thanh tiến độ tiêu hao ngân sách; màu đổi theo mức dùng. */
export function ProgressBar({ rate, tone, className = "" }: { rate: number | null; tone?: Tone; className?: string }) {
  const width = rate === null ? 0 : Math.max(0, Math.min(100, rate * 100));
  const auto: Tone = rate === null ? "slate" : rate > 1 ? "rose" : rate > 0.9 ? "amber" : "emerald";
  return (
    <div className={`h-1.5 w-full rounded-full bg-slate-100 overflow-hidden ${className}`}>
      <div className={`h-full rounded-full ${toneBar[tone || auto]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export type BudgetStatus = "OK" | "WATCH" | "OVER" | "NONE";
export const budgetStatusOf = (usage: number | null): BudgetStatus => (usage === null ? "NONE" : usage > 1 ? "OVER" : usage > 0.9 ? "WATCH" : "OK");

/** Badge "Đúng định mức / Cần chú ý / Vượt ngân sách". */
export function StatusBadge({ status }: { status: BudgetStatus }) {
  const config = {
    OK: { label: "Đúng định mức", cls: "bg-emerald-50 text-emerald-700 border-emerald-100", icon: "check_circle" },
    WATCH: { label: "Cần chú ý", cls: "bg-amber-50 text-amber-700 border-amber-100", icon: "warning" },
    OVER: { label: "Vượt ngân sách", cls: "bg-rose-50 text-rose-700 border-rose-100", icon: "error" },
    NONE: { label: "Chưa set định mức", cls: "bg-slate-100 text-slate-500 border-slate-200", icon: "remove_circle" },
  }[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${config.cls}`}>
      <span className="material-symbols-outlined text-sm">{config.icon}</span>{config.label}
    </span>
  );
}

/** Nút chuyển "Kế hoạch / Thực tế" nhỏ trong góc card. */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (value: T) => void; options: Array<{ id: T; label: string }> }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${value === option.id ? "bg-white text-indigo-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Nhắc khi năm chưa set kế hoạch — mọi so sánh KH/TT đều trống. */
export function NoPlanNotice({ year }: { year: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <span className="material-symbols-outlined text-xl">lightbulb</span>
      <div>
        <b>Năm {year} chưa có kế hoạch (ngân sách) nào.</b> Các cột kế hoạch, % hoàn thành và định mức sẽ trống cho tới khi set ngân sách từng tháng ở tab <b>Ngân sách</b>.
        Số hòa vốn và giả định tạm lấy số thực tế làm gốc.
      </div>
    </div>
  );
}

/** Ô "Kế hoạch (đậm) + Thực đạt (chip màu) + %" dùng trong bảng Dự báo P&L và bảng theo cửa hàng. */
export function PlanActualCell({ plan, actual, income, align = "right", compact = false }: { plan: number | null; actual: number; income: boolean; align?: "right" | "left"; compact?: boolean }) {
  const fmt = compact ? fmtCompact : (value: number) => money(Math.round(value));
  const hasPlan = plan !== null && Math.abs(plan) > 0.5;
  const hasActual = Math.abs(actual) > 0.5;
  const rate = hasPlan ? actual / (plan as number) : null;
  const good = rate === null ? null : income ? rate >= 1 : rate <= 1;
  const chipTone = !hasActual ? "bg-slate-50 text-slate-400" : good === null ? "bg-slate-100 text-slate-600" : good ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700";
  return (
    <div className={`flex flex-col gap-0.5 ${align === "right" ? "items-end" : "items-start"}`}>
      <span className={`text-[13px] font-bold whitespace-nowrap ${hasPlan ? "text-slate-800" : "text-slate-300"}`}>{hasPlan ? `${fmt(plan as number)}${compact ? "" : " đ"}` : "—"}</span>
      <span className="flex items-center gap-1">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${chipTone}`}>{hasActual ? `${fmt(actual)}${compact ? "" : " đ"}` : "0"}</span>
        {rate !== null && <span className={`text-[10px] font-bold ${good ? "text-emerald-600" : "text-rose-600"}`}>{pctText(rate, 0)}</span>}
      </span>
    </div>
  );
}
