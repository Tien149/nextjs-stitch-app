"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeUnitCode } from "@/lib/unit-code";

/**
 * Ô chọn ĐVT có tìm kiếm (khách 23/11/2026): chọn từ các ĐVT đã dùng trong danh mục để khỏi người
 * gõ thường, người gõ hoa, có cách, không cách. Chưa có thì gõ rồi bấm "Thêm ĐVT mới" — mã mới
 * được chuẩn hoá (bỏ dấu, viết hoa, bỏ khoảng trắng) trước khi lưu.
 */
export function UnitPicker({ value, onChange, units, placeholder = "Chọn hoặc gõ ĐVT" }: {
  value: string;
  onChange: (value: string) => void;
  /** Các mã ĐVT đang có (đã chuẩn hoá hay chưa đều được, ở đây gom lại). */
  units: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(() => {
    const byCode = new Map<string, string>();
    for (const unit of units) {
      const code = normalizeUnitCode(unit);
      if (code && !byCode.has(code)) byCode.set(code, String(unit).trim());
    }
    return [...byCode.entries()].map(([code, raw]) => ({ code, raw })).sort((a, b) => a.code.localeCompare(b.code));
  }, [units]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const typed = normalizeUnitCode(query);
  const matches = options.filter((option) => !typed || option.code.includes(typed));
  const exact = options.find((option) => option.code === typed);
  const pick = (code: string) => {
    onChange(code);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        className="control flex w-full items-center justify-between text-left"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={value ? "" : "text-slate-400"}>{value || placeholder}</span>
        <span className="material-symbols-outlined text-base text-slate-400">expand_more</span>
      </button>
      {open && (
        <div className="absolute left-0 right-0 z-40 mt-1 rounded-lg border border-slate-200 bg-white p-1.5 shadow-lg">
          <input
            autoFocus
            className="control mb-1"
            placeholder="Gõ để tìm ĐVT..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (exact) pick(exact.code);
              else if (matches.length === 1) pick(matches[0].code);
              else if (typed) pick(typed);
            }}
          />
          <div className="max-h-56 overflow-y-auto">
            {matches.map((option) => (
              <button
                key={option.code}
                type="button"
                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50 ${option.code === value ? "bg-blue-50 font-bold text-blue-700" : "text-slate-700"}`}
                onClick={() => pick(option.code)}
              >
                {option.code}
                {option.raw !== option.code && <span className="text-[11px] text-slate-400">đang ghi: {option.raw}</span>}
              </button>
            ))}
            {matches.length === 0 && !typed && <p className="px-2 py-1.5 text-xs text-slate-400">Chưa có ĐVT nào.</p>}
          </div>
          {typed && !exact && (
            <button
              type="button"
              className="mt-1 flex w-full items-center gap-1 rounded border border-dashed border-blue-300 px-2 py-1.5 text-left text-sm font-bold text-blue-700 hover:bg-blue-50"
              onClick={() => pick(typed)}
            >
              <span className="material-symbols-outlined text-base">add</span>
              Thêm ĐVT mới: {typed}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
