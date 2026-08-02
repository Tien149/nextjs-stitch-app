"use client";

import { useState } from "react";
import { canPerformMenuAction, type DemoSession } from "@/lib/auth-demo";

/**
 * Cụm nút Sửa / Xoá dùng chung cho các bảng dữ liệu.
 * Tự ẩn nút theo quyền của vai trò trên đúng module.
 */
export function RowActions({
  session,
  module: moduleHref,
  onEdit,
  onDelete,
  editDisabledReason,
  deleteDisabledReason,
  compact = false,
}: {
  session: DemoSession | null;
  /** href của menu, ví dụ "/vouchers" — dùng để kiểm tra quyền edit/delete */
  module: string;
  onEdit?: () => void;
  onDelete?: () => void;
  /** Có giá trị thì nút bị khoá và hiện lý do khi rê chuột */
  editDisabledReason?: string | null;
  deleteDisabledReason?: string | null;
  compact?: boolean;
}) {
  const canEdit = Boolean(onEdit && session && canPerformMenuAction(session, moduleHref, "edit"));
  const canDelete = Boolean(onDelete && session && canPerformMenuAction(session, moduleHref, "delete"));

  if (!canEdit && !canDelete) return null;

  const size = compact ? "text-base" : "text-lg";

  return (
    <div className="flex items-center justify-end gap-1">
      {canEdit && (
        <button
          type="button"
          onClick={onEdit}
          disabled={Boolean(editDisabledReason)}
          title={editDisabledReason || "Chỉnh sửa"}
          className="p-1.5 rounded-lg text-slate-500 hover:text-blue-700 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-500 transition-colors"
        >
          <span className={`material-symbols-outlined ${size}`}>edit</span>
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={Boolean(deleteDisabledReason)}
          title={deleteDisabledReason || "Xoá"}
          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-700 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-500 transition-colors"
        >
          <span className={`material-symbols-outlined ${size}`}>delete</span>
        </button>
      )}
    </div>
  );
}

/**
 * Hộp thoại xác nhận xoá, kèm ô nhập lý do.
 * Nói rõ dữ liệu chỉ chuyển vào Thùng rác chứ không mất, để người dùng yên tâm.
 */
export function ConfirmDeleteDialog({
  open,
  title,
  description,
  confirmLabel = "Chuyển vào thùng rác",
  requireReason = false,
  submitting = false,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  requireReason?: boolean;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
        <div className="p-5 border-b border-slate-200 flex items-start gap-3">
          <span className="material-symbols-outlined text-rose-600 text-2xl shrink-0">delete_sweep</span>
          <div className="min-w-0">
            <h3 className="font-bold text-slate-900">{title}</h3>
            {description && <p className="text-sm text-slate-500 mt-1">{description}</p>}
          </div>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs bg-blue-50 border border-blue-200 text-blue-800 rounded-lg px-3 py-2.5 flex items-start gap-2">
            <span className="material-symbols-outlined text-base shrink-0">info</span>
            Dữ liệu không bị xoá vĩnh viễn. Bản ghi sẽ chuyển vào Thùng rác và có thể khôi phục lại.
          </p>

          <div>
            <label htmlFor="delete-reason" className="text-sm font-bold text-slate-700">
              Lý do xoá {requireReason ? "" : <span className="font-normal text-slate-400">(không bắt buộc)</span>}
            </label>
            <textarea
              id="delete-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              placeholder="VD: Nhập nhầm số tiền"
              className="w-full mt-2 border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {error && (
            <p className="text-sm bg-rose-50 border border-rose-200 text-rose-700 rounded-lg px-3 py-2.5 flex items-start gap-2">
              <span className="material-symbols-outlined text-lg shrink-0">error</span>
              {error}
            </p>
          )}
        </div>

        <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setReason("");
              onCancel();
            }}
            className="px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100"
          >
            Huỷ
          </button>
          <button
            type="button"
            disabled={submitting || (requireReason && !reason.trim())}
            onClick={() => onConfirm(reason.trim())}
            className="px-4 py-2 rounded-lg text-sm font-bold bg-rose-600 hover:bg-rose-700 disabled:opacity-60 text-white"
          >
            {submitting ? "Đang xoá..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
