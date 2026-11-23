"use client";

import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Thanh bộ lọc kiểu "mini header": dính ngay dưới header của trang khi cuộn xuống,
 * để người dùng đổi kỳ/cửa hàng/bộ lọc mà không phải kéo ngược lên đầu trang.
 *
 * Điểm dính lấy theo chiều cao <header> đầu tiên của trang (đo bằng ResizeObserver)
 * nên không phải hard-code chiều cao header ở từng trang; trang không có header thì
 * dính sát mép trên.
 *
 * z-[15]: trên tiêu đề bảng dính (thead sticky z-10 — cùng tầng thì tiêu đề bảng vẽ đè lên hàng
 * tab khi cuộn, khách báo 23/11/2026), dưới header trang (z-20).
 *
 * Lưu ý: phần tử sticky không hoạt động bên trong khối có overflow: hidden
 * (ví dụ .table-panel), nên thanh lọc phải đặt ngoài các khối đó.
 */
export default function StickyFilterBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [top, setTop] = useState(0);

  useEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const update = () => setTop(Math.round(header.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={`sticky z-[15] -mx-4 sm:-mx-6 mb-4 border-b border-slate-200/80 bg-slate-100/95 px-4 py-3 backdrop-blur sm:px-6 [&>:last-child]:mb-0 ${className}`}
      style={{ top }}
    >
      {children}
    </div>
  );
}

const STICKY_FILTER_SLOT_ID = "sticky-filter-slot";

/**
 * Chỗ trống ở cuối thanh lọc dính: màn con gửi bộ lọc riêng của nó vào đây (StickyFilterPortal)
 * để bộ lọc đó cũng đứng yên khi cuộn — ví dụ hàng Nhóm doanh thu của tab DT theo ca & món
 * (khách 23/11/2026). Rỗng thì ẩn, không tốn chỗ.
 */
export function StickyFilterSlot() {
  return <div id={STICKY_FILTER_SLOT_ID} className="mt-3 empty:hidden" />;
}

/** Đưa `children` vào StickyFilterSlot của trang; trang không có chỗ trống thì vẽ tại chỗ. */
export function StickyFilterPortal({ children }: { children: ReactNode }) {
  const [slot] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.getElementById(STICKY_FILTER_SLOT_ID)));
  return slot ? createPortal(children, slot) : <>{children}</>;
}
