"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AppBrand } from "@/components/AppBrand";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { NotificationBell } from "@/components/NotificationBell";
import { type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { resolveMenuLayout, type ResolvedMenuLink } from "@/lib/menu-layout";
import { announceMenuTab } from "@/lib/menu-tab-event";
import { logout } from "@/lib/session-client";

function splitHref(href: string) {
  const [path, query = ""] = href.split("?");
  return { path, query };
}

/** Menu duoc chon = item co path khop dai nhat voi URL hien tai (ho tro route con nhu /assets/operations). */
function resolveActiveHref(items: Array<{ href: string }>, pathname: string, search: string) {
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

/** Khoá localStorage nhớ các nhóm menu người dùng đã thu gọn. */
const COLLAPSED_KEY = "sidebar_collapsed_groups";

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
  const [changingPassword, setChangingPassword] = useState(false);

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

  const layout = useMemo(() => resolveMenuLayout(session), [session]);
  const allLinks = useMemo(
    () => [...layout.top, ...layout.groups.flatMap((group) => group.sections.flatMap((section) => section.links))],
    [layout],
  );

  const activeHref = useMemo(
    () => resolveActiveHref(allLinks, pathname, search),
    [allLinks, pathname, search],
  );

  /**
   * Nhóm đang thu gọn — người dùng tự bấm, nhớ theo trình duyệt. Mặc định mở hết; nhóm chứa
   * mục đang mở luôn bung ra để không lạc chỗ.
   */
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => {
    let saved: string[] = [];
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) saved = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      saved = [];
    }
    const timer = window.setTimeout(() => setCollapsed(saved), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const toggleGroup = (id: string) => {
    setCollapsed((current) => {
      const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // Trình duyệt chặn lưu thì chỉ không nhớ được lần sau.
      }
      return next;
    });
  };

  const renderLink = (link: ResolvedMenuLink, nested: boolean) => (
    <Link
      key={link.key}
      href={link.href}
      onClick={() => {
        const { path, query } = splitHref(link.href);
        setSearch(query ? `?${query}` : "");
        // Cùng trang: báo trang đổi màn ("" = mục trần, trang tự về tab mặc định).
        if (path === pathname) announceMenuTab(path, new URLSearchParams(query).get("tab") || "");
        onNavigate?.();
      }}
      className={`w-full flex items-center ${nested ? "pl-9 pr-4 py-2" : "px-6 py-3"} text-left transition-all active:scale-[0.98] duration-150 ${
        activeHref === link.href
          ? "bg-[#1e293b] text-white border-l-4 border-[#2563eb]"
          : "text-white/70 hover:bg-[#1e293b] hover:text-white"
      }`}
    >
      <span className={`material-symbols-outlined mr-3 ${nested ? "text-[18px]" : "text-[20px]"}`}>{link.icon}</span>
      <span className="text-sm font-medium">{link.name}</span>
    </Link>
  );

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  return (
    // h-dvh thay h-screen: trên Safari/Chrome iOS, 100vh cao hơn vùng nhìn thấy nên khối chân
    // trang ("Trợ giúp", "Đăng xuất") bị đẩy khỏi màn hình và không cuộn tới được.
    <aside className="w-64 h-dvh fixed left-0 top-0 bg-[#0f172a] flex flex-col py-6 shadow-xl z-50 overflow-hidden">
      <div className="pl-6 pr-3 mb-8 shrink-0 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <AppBrand compact />
        </div>
        {/* Chuông thông báo (PR chờ duyệt...) — khách 27/11/2026. */}
        {session && <NotificationBell onNavigate={onNavigate} />}
      </div>
      <nav className="sidebar-scroll flex-1 min-h-0 space-y-1 overflow-y-auto overscroll-contain pr-1">
        {layout.top.map((link) => renderLink(link, false))}
        {layout.groups.map((group) => {
          const hasActive = group.sections.some((section) => section.links.some((link) => link.href === activeHref));
          const open = hasActive || !collapsed.includes(group.id);
          return (
            <div key={group.id} className="pt-1">
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={open}
                className="w-full flex items-center px-6 py-2.5 text-left text-white/90 hover:bg-[#1e293b] transition-colors"
              >
                <span className="material-symbols-outlined mr-3 text-[20px] text-blue-300/80">{group.icon}</span>
                <span className="flex-1 text-xs font-bold uppercase tracking-wide">{group.label}</span>
                <span className="material-symbols-outlined text-[18px] text-white/40">{open ? "expand_less" : "expand_more"}</span>
              </button>
              {open && group.sections.map((section, index) => (
                <div key={section.label || `section-${index}`}>
                  {section.label && (
                    <p className="pl-9 pr-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-white/35">{section.label}</p>
                  )}
                  {section.links.map((link) => renderLink(link, true))}
                </div>
              ))}
            </div>
          );
        })}
        {/* HRM là ứng dụng riêng ở /hr: đi qua /api/hrm-sso để đăng nhập luôn bằng tài khoản kế toán.
            Dùng <a> (điều hướng toàn trang), không dùng Link vì đích là route API chuyển hướng. */}
        {session && process.env.NEXT_PUBLIC_HRM_MENU === "1" && (
          <div className="pt-1">
            <p className="px-6 pt-2.5 pb-1 flex items-center text-xs font-bold uppercase tracking-wide text-white/90">
              <span className="material-symbols-outlined mr-3 text-[20px] text-blue-300/80">link</span>
              Link các phần mềm khác
            </p>
            <a
              href="/api/hrm-sso"
              onClick={() => onNavigate?.()}
              className="w-full flex items-center pl-9 pr-4 py-2 text-left transition-all text-white/70 hover:bg-[#1e293b] hover:text-white"
            >
              <span className="material-symbols-outlined mr-3 text-[18px]">badge</span>
              <span className="text-sm font-medium flex-1">Nhân sự (HRM)</span>
              <span className="material-symbols-outlined text-[16px] text-white/40">open_in_new</span>
            </a>
          </div>
        )}
      </nav>
      <div className="shrink-0 pt-4 border-t border-slate-800 space-y-1 bg-[#0f172a]">
        <button
          type="button"
          className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left"
        >
          <span className="material-symbols-outlined mr-3 text-[20px]">help</span>
          <span className="text-sm font-medium">Trợ giúp</span>
        </button>
        {session && (
          <button
            type="button"
            onClick={() => setChangingPassword(true)}
            className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left"
          >
            <span className="material-symbols-outlined mr-3 text-[20px]">key</span>
            <span className="text-sm font-medium">Đổi mật khẩu</span>
          </button>
        )}
        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center px-6 py-2 text-white/70 hover:bg-[#1e293b] hover:text-white transition-all text-left"
        >
          <span className="material-symbols-outlined mr-3 text-[20px]">logout</span>
          <span className="text-sm font-medium">Đăng xuất</span>
        </button>
      </div>
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
    </aside>
  );
}
