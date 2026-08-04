"use client";

import { type ReactNode, useEffect, useState } from "react";

/**
 * Thanh bộ lọc kiểu "mini header": dính ngay dưới header của trang khi cuộn xuống,
 * để người dùng đổi kỳ/cửa hàng/bộ lọc mà không phải kéo ngược lên đầu trang.
 *
 * Điểm dính lấy theo chiều cao <header> đầu tiên của trang (đo bằng ResizeObserver)
 * nên không phải hard-code chiều cao header ở từng trang; trang không có header thì
 * dính sát mép trên.
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
      className={`sticky z-10 -mx-4 sm:-mx-6 mb-4 border-b border-slate-200/80 bg-slate-100/95 px-4 py-3 backdrop-blur sm:px-6 ${className}`}
      style={{ top }}
    >
      {children}
    </div>
  );
}
