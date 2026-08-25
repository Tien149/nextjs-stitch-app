"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppBrand } from "@/components/AppBrand";
import { appMenuItems, canAccessMenu, type AppMenuItem, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { logout } from "@/lib/session-client";

function splitHref(href: string) {
  const [path, query = ""] = href.split("?");
  return { path, query };
}

/** Menu duoc chon = item co path khop dai nhat voi URL hien tai (ho tro route con nhu /assets/operations). */
function resolveActiveHref(items: AppMenuItem[], pathname: string, search: string) {
  const currentTab = new URLSearchParams(search).get("tab") || "";

  const matched = items.filter((item) => {
    const { path, query } = splitHref(item.href);
    const pathMatched = path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
    if (!pathMatched) return false;
    if (!query) return true;
    return new URLSearchParams(query).get("tab") === currentTab;
  });

  if (matched.length === 0) return "";

  // Uu tien item co query (vi du /reports?tab=cashflow) roi den path dai nhat.
  const best = matched.reduce((prev, item) => {
    const prevScore = splitHref(prev.href).query ? 1000 : 0;
    const itemScore = splitHref(item.href).query ? 1000 : 0;
    return itemScore + item.href.length > prevScore + prev.href.length ? item : prev;
  });

  return best.href;
}

/** Đọc phiên đăng nhập từ localStorage, dùng chung cho lần dựng đầu và mỗi lần đổi route. */
function readSession(): DemoSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as DemoSession) : null;
  } catch {
    return null;
  }
}

export function AppSidebar({ onNavigate, inDrawer = false }: { onNavigate?: () => void; inDrawer?: boolean } = {}) {
  const router = useRouter();
  const pathname = usePathname();
  // Drawer trên điện thoại dựng lại component từ đầu mỗi lần mở. Nếu chờ effect mới nạp phiên
  // thì lần nào bấm menu cũng thấy drawer TRỐNG TRƠN một nhịp rồi menu mới hiện ra.
  const [session, setSession] = useState<DemoSession | null>(() => (inDrawer ? readSession() : null));
  const [search, setSearch] = useState(() => (inDrawer && typeof window !== "undefined" ? window.location.search : ""));

  // Doc lai session + query moi khi doi route de sidebar luon dung quyen va menu dang mo.
  useEffect(() => {
    const currentSearch = window.location.search;
    const nextSession = readSession();
    const timer = window.setTimeout(() => {
      setSearch(currentSearch);
      setSession(nextSession);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pathname]);

  const allowedMenuItems = useMemo(
    () => (session ? appMenuItems.filter((item) => canAccessMenu(session, item)) : []),
    [session],
  );

  const activeHref = useMemo(
    () => resolveActiveHref(allowedMenuItems, pathname, search),
    [allowedMenuItems, pathname, search],
  );

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  return (
    // h-dvh thay h-screen: trên Safari/Chrome iOS, 100vh cao hơn vùng nhìn thấy nên khối chân
    // trang ("Trợ giúp", "Đăng xuất") bị đẩy khỏi màn hình và không cuộn tới được.
    <aside className="w-64 h-dvh fixed left-0 top-0 bg-[#0f172a] flex flex-col py-6 shadow-xl z-50 overflow-hidden">
      <div className="px-6 mb-8 shrink-0">
        <AppBrand compact />
      </div>
      <nav className="sidebar-scroll flex-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
        {allowedMenuItems.map((item) => (
          <Link
            key={item.name}
            href={item.href}
            onClick={() => {
              setSearch(splitHref(item.href).query ? `?${splitHref(item.href).query}` : "");
              onNavigate?.();
            }}
            className={`w-full flex items-center px-6 py-3 text-left transition-all active:scale-[0.98] duration-150 ${
              activeHref === item.href
                ? "bg-[#1e293b] text-white border-l-4 border-[#2563eb]"
                : "text-white/70 hover:bg-[#1e293b] hover:text-white"
            }`}
          >
            <span className="material-symbols-outlined mr-3 text-[20px]">{item.icon}</span>
            <span className="text-sm font-medium">{item.name}</span>
          </Link>
        ))}
      </nav>
      <div className="shrink-0 pt-4 border-t border-slate-800 space-y-1 bg-[#0f172a]">
        <button
          type="button"
          className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left"
        >
          <span className="material-symbols-outlined mr-3 text-[20px]">help</span>
          <span className="text-sm font-medium">Trợ giúp</span>
        </button>
        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left"
        >
          <span className="material-symbols-outlined mr-3 text-[20px]">logout</span>
          <span className="text-sm font-medium">Đăng xuất</span>
        </button>
      </div>
    </aside>
  );
}
