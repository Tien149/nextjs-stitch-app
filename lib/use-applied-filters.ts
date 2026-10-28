"use client";

import { useCallback, useState } from "react";

/**
 * Bộ lọc chỉ chạy khi người dùng bấm "Lọc" (khách 28/10/2026: "phải có cái gì đó để đưa lệnh cho
 * hệ thống chạy" — đổi ngày / chọn cửa hàng xong màn tự chạy là không ổn). Ô lọc gắn vào `draft`;
 * danh sách, lời gọi máy chủ dùng `applied`. `apply()` chép bản nháp sang bản đang áp dụng; `dirty`
 * = có thay đổi chưa bấm Lọc. Đổi thẳng cả hai (link chứng từ, nút nhanh) dùng `applyNow`.
 */
export function useAppliedFilters<T extends Record<string, unknown>>(initial: T | (() => T)) {
  const [draft, setDraft] = useState<T>(initial);
  const [applied, setApplied] = useState<T>(initial);
  const update = useCallback((patch: Partial<T>) => setDraft((current) => ({ ...current, ...patch })), []);
  const apply = useCallback(() => setApplied(draft), [draft]);
  const applyNow = useCallback((patch: Partial<T>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setApplied((current) => ({ ...current, ...patch }));
  }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  return { draft, applied, update, apply, applyNow, dirty, setDraft };
}

/**
 * Bản nháp cho một thanh lọc mà màn đã có sẵn state "đang áp dụng" (nhiều useState rời): ô lọc gắn
 * `draft`, nút Lọc gọi `apply()` → `onApply(draft)` ghi sang các state thật. Khi state thật đổi từ
 * nơi khác (link chứng từ, đổi tab, Xoá lọc) bản nháp tự theo.
 */
export function useFilterDraft<T extends Record<string, unknown>>(applied: T, onApply: (draft: T) => void) {
  const key = JSON.stringify(applied);
  const [state, setState] = useState<{ key: string; draft: T }>({ key, draft: applied });
  // Giá trị áp dụng đổi từ ngoài → bỏ bản nháp cũ (so khoá ngay lúc render, không cần effect).
  const draft = state.key === key ? state.draft : applied;
  const update = useCallback((patch: Partial<T>) => setState((current) => ({
    key,
    draft: { ...(current.key === key ? current.draft : applied), ...patch },
  })), [key, applied]);
  const apply = () => onApply(draft);
  const dirty = JSON.stringify(draft) !== key;
  return { draft, update, apply, dirty };
}
