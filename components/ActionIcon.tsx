"use client";

/**
 * Nút thao tác dạng ICON thống nhất mọi màn (khách 21/10/2026): Duyệt = dấu tích, Huỷ / Từ chối /
 * Trả lại = dấu X, Sửa = cây bút, Xoá = thùng rác, Mở lại = ổ khoá. Chữ đi vào tooltip + aria-label
 * nên di chuột (máy tính) hoặc nhấn giữ vẫn biết nút làm gì.
 */
export type ActionIconKind = "approve" | "cancel" | "edit" | "delete" | "reopen";

const ICON: Record<ActionIconKind, string> = {
  approve: "check",
  cancel: "close",
  edit: "edit",
  delete: "delete",
  reopen: "lock_open",
};

/** Cùng khuôn với nút Sửa / Xoá của RowActions (icon trơn, nền khi di chuột), thêm màu theo nghĩa. */
const TONE: Record<ActionIconKind, string> = {
  approve: "text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700",
  cancel: "text-rose-500 hover:bg-rose-50 hover:text-rose-700",
  edit: "text-slate-500 hover:bg-blue-50 hover:text-blue-700",
  delete: "text-slate-500 hover:bg-rose-50 hover:text-rose-700",
  reopen: "text-amber-600 hover:bg-amber-50 hover:text-amber-700",
};

export function ActionIcon({ kind, title, onClick, disabled, className = "" }: {
  kind: ActionIconKind;
  /** Chữ của thao tác — hiện ở tooltip, đọc bởi trình đọc màn hình. */
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`inline-grid shrink-0 place-items-center rounded-lg p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${TONE[kind]} ${className}`}
    >
      <span className="material-symbols-outlined text-lg leading-none">{ICON[kind]}</span>
    </button>
  );
}
