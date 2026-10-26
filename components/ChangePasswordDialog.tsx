"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * Người dùng tự đổi mật khẩu (khách 26/10/2026 — trên điện thoại không có chỗ đổi). Mở từ menu bên
 * trái / menu ☰; vẽ ra document.body vì drawer điện thoại có hiệu ứng trượt sẽ nhốt `fixed` bên trong.
 */
export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword.trim().length < 6) return setError("Mật khẩu mới phải có ít nhất 6 ký tự.");
    if (newPassword !== confirmPassword) return setError("Nhập lại mật khẩu mới chưa khớp.");
    setSaving(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || "Không đổi được mật khẩu, vui lòng thử lại.");
        return;
      }
      setDone(true);
    } catch {
      setError("Không kết nối được máy chủ, vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  };

  const inputType = showPasswords ? "text" : "password";
  return createPortal(
    <div className="fixed inset-0 z-[90] bg-slate-900/60 flex items-start justify-center p-4 overflow-y-auto overscroll-contain" role="dialog" aria-modal="true" aria-label="Đổi mật khẩu">
      <div className="my-auto w-full max-w-sm rounded-2xl bg-white text-slate-800 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="font-bold text-slate-900">Đổi mật khẩu</h3>
          <button type="button" onClick={onClose} className="icon-button" title="Đóng">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        {done ? (
          <div className="space-y-4 p-5">
            <p className="text-sm text-emerald-700">Đã đổi mật khẩu. Lần đăng nhập sau dùng mật khẩu mới.</p>
            <button type="button" onClick={onClose} className="primary-button w-full">Xong</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3 p-5">
            <label className="block text-xs font-bold text-slate-600">Mật khẩu hiện tại
              <input className="control" type={inputType} autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </label>
            <label className="block text-xs font-bold text-slate-600">Mật khẩu mới (ít nhất 6 ký tự)
              <input className="control" type={inputType} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            </label>
            <label className="block text-xs font-bold text-slate-600">Nhập lại mật khẩu mới
              <input className="control" type={inputType} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" className="accent-blue-600" checked={showPasswords} onChange={(e) => setShowPasswords(e.target.checked)} />
              Hiện mật khẩu
            </label>
            {error && <p className="text-xs font-semibold text-rose-600">{error}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="secondary-button">Huỷ</button>
              <button type="submit" disabled={saving} className="primary-button flex-1">{saving ? "Đang lưu..." : "Đổi mật khẩu"}</button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}
