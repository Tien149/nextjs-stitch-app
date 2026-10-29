"use client";

import { useState } from "react";
import { flushSync } from "react-dom";

/**
 * Bảng dài (danh mục ~3.600 mặt hàng, ~1.700 định lượng) chỉ vẽ một phần, bấm "Xem thêm" để vẽ tiếp —
 * vẽ hết một lúc làm điện thoại khựng, gõ ô nào trên màn cũng chậm (khách 29/10/2026).
 *
 * `resetKey` đổi (bộ lọc mới) thì quay về trang đầu. Nút "Hiện tất cả" mang `data-export-show-all`:
 * ExportExcelButton bấm nó trước khi đọc bảng để file Excel vẫn đủ mọi dòng đang lọc.
 */
export function useRowLimit(step: number, resetKey: string) {
  const [state, setState] = useState({ key: resetKey, limit: step });
  // Điều chỉnh state ngay lúc render khi bộ lọc đổi (không cần effect, không vẽ thừa một lượt).
  if (state.key !== resetKey) setState({ key: resetKey, limit: step });
  const limit = state.key === resetKey ? state.limit : step;
  return {
    limit,
    more: () => setState((current) => ({ ...current, limit: current.limit + step })),
    // flushSync: nút xuất Excel đọc bảng ngay sau khi bấm, bảng phải vẽ đủ dòng trước đó.
    all: () => flushSync(() => setState((current) => ({ ...current, limit: Number.POSITIVE_INFINITY }))),
  };
}

export function ShowMoreRows({ shown, total, step, onMore, onAll, unit = "dòng" }: {
  shown: number;
  total: number;
  step: number;
  onMore: () => void;
  onAll: () => void;
  unit?: string;
}) {
  if (total <= shown) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-500" data-no-export>
      <span>Đang hiện <b className="text-slate-700">{shown.toLocaleString("vi-VN")}</b> / {total.toLocaleString("vi-VN")} {unit}</span>
      <button type="button" className="secondary-button !min-h-8 !py-1" onClick={onMore}>Xem thêm {Math.min(step, total - shown).toLocaleString("vi-VN")}</button>
      <button type="button" className="font-bold text-blue-600 hover:underline" data-export-show-all onClick={onAll}>Hiện tất cả</button>
    </div>
  );
}
