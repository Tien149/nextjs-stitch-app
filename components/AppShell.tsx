"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/AppSidebar";

/** Cac route khong dung khung sidebar: man dang nhap, cac trang in chung tu va phieu PO cong khai gui NCC. */
function isBareRoute(pathname: string) {
  return pathname === "/login" || pathname.endsWith("/print") || pathname.startsWith("/po/");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  /** Drawer menu trên điện thoại: dưới breakpoint lg sidebar ẩn đi, mở bằng nút nổi góc trái. */
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // Đổi trang thì tự đóng drawer để nội dung mới không bị che.
  useEffect(() => {
    const timer = window.setTimeout(() => setMenuOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  // Mở drawer: khoá cuộn nền (nếu không, vuốt trên lớp phủ vẫn cuộn trang bên dưới),
  // đóng bằng phím Esc, và trả con trỏ về nút menu khi đóng.
  useEffect(() => {
    if (!menuOpen) return;
    const menuButton = menuButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      menuButton?.focus();
    };
  }, [menuOpen]);

  // Xoay ngang / phóng to qua breakpoint lg: sidebar cố định hiện lại, drawer phải đóng theo,
  // nếu không thu nhỏ lại là nó tự bung ra dù người dùng không bấm gì.
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => { if (media.matches) setMenuOpen(false); };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  if (isBareRoute(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen w-full bg-[#f1f5f9]">
      {/* Desktop: sidebar cố định như cũ */}
      <div className="hidden lg:block">
        <AppSidebar />
      </div>

      {/* Mobile: sidebar thành drawer trượt + lớp phủ bấm ra ngoài để đóng */}
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="Menu điều hướng">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setMenuOpen(false)} aria-hidden />
          <AppSidebar onNavigate={() => setMenuOpen(false)} inDrawer />
        </div>
      )}

      {/*
        Nút menu nổi cho điện thoại — góc trái dưới cho thuận ngón cái.
        z-40: PHẢI thấp hơn lớp phủ của các hộp thoại trong app (đều z-50). Để cao hơn thì khi mở
        hộp thoại trên điện thoại, nút tròn này nổi đè lên và che đúng nút "Huỷ" ở góc trái dưới.
        Cũng ẩn hẳn khi drawer đang mở để không chồng lên chính drawer.
      */}
      <button
        ref={menuButtonRef}
        type="button"
        onClick={() => setMenuOpen(true)}
        aria-label="Mở menu"
        aria-expanded={menuOpen}
        // Luôn render (không ẩn khi drawer mở) để còn trả được con trỏ về đây lúc đóng;
        // z-40 đủ thấp nên nó nằm dưới cả drawer (z-70) lẫn lớp phủ hộp thoại (z-50).
        className="lg:hidden fixed bottom-5 left-4 z-40 h-12 w-12 rounded-full bg-[#0f172a] text-white shadow-lg shadow-slate-900/30 grid place-items-center active:scale-95 transition-transform"
      >
        <span className="material-symbols-outlined">menu</span>
      </button>

      {/* overflow-x-clip thay cho overflow-x-hidden: hidden biến khối này thành scroll
          container và vô hiệu hoá position: sticky của mọi header/thanh lọc bên trong. */}
      <div className="flex-1 min-w-0 lg:pl-64 flex flex-col min-h-screen overflow-x-clip">{children}</div>
    </div>
  );
}
