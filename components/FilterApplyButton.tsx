"use client";

/**
 * Nút "Lọc" của thanh bộ lọc (lib/use-applied-filters.ts). Có thay đổi chưa áp dụng thì nút đậm màu
 * kèm nhắc "Bấm Lọc để xem"; đặt cạnh các ô lọc, cùng hàng.
 */
export function FilterApplyButton({ dirty, onApply, loading = false, className = "" }: { dirty: boolean; onApply: () => void; loading?: boolean; className?: string }) {
  return (
    <div className={`flex items-end gap-2 ${className}`}>
      <button
        type="button"
        onClick={onApply}
        disabled={loading}
        className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-bold shadow-sm transition-colors disabled:opacity-60 ${dirty ? "bg-blue-600 text-white hover:bg-blue-700" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
        title="Áp dụng bộ lọc"
      >
        {loading
          ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          : <span className="material-symbols-outlined text-lg">filter_alt</span>}
        Lọc
      </button>
      {dirty && !loading && <span className="pb-2.5 text-[11px] font-semibold text-amber-700">Đã đổi bộ lọc — bấm Lọc để xem</span>}
    </div>
  );
}
