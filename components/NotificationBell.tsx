"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { refreshUnreadCount, setUnreadCount, useUnreadCount } from "@/lib/notification-store";
import { disablePush, enablePush, isIos, pushConfig, pushState, testPush, type PushState } from "@/lib/push-client";

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

function timeLabel(value: string) {
  const date = new Date(value);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} giờ trước`;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("day")}/${part("month")} ${part("hour")}:${part("minute")}`;
}

/** Số trên chuông: quá 99 hiện 99+. */
export function UnreadBadge({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={`min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-[18px] text-center shadow ${className}`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

function PushSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let alive = true;
    void pushState().then((value) => {
      if (alive) setState(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  const run = async (task: () => Promise<string>) => {
    setBusy(true);
    setMessage("");
    try {
      setMessage(await task());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không thực hiện được");
    } finally {
      setState(await pushState());
      setBusy(false);
    }
  };

  const turnOn = () => run(async () => {
    // Xin quyền phải nằm trong cùng lượt bấm (Safari): lấy khoá trước rồi gọi enablePush ngay.
    const config = await pushConfig();
    await enablePush(config.publicKey);
    return "Đã bật. Có PR chờ duyệt là thiết bị này nhận thông báo.";
  });

  const box = "rounded-lg border px-3 py-2.5 text-xs leading-relaxed";
  if (state === null) return null;
  if (state === "on") {
    return (
      <div className={`${box} border-emerald-200 bg-emerald-50 text-emerald-900`}>
        <p className="font-semibold flex items-center gap-1.5"><span className="material-symbols-outlined text-[16px]">notifications_active</span>Đang nhận thông báo trên thiết bị này</p>
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={busy} onClick={() => run(async () => { const result = await testPush(); return `Đã gửi thử tới ${result.sent} thiết bị.`; })} className="rounded-md bg-white border border-emerald-300 px-2.5 py-1 font-semibold hover:bg-emerald-100 disabled:opacity-50">Gửi thử</button>
          <button type="button" disabled={busy} onClick={() => run(async () => { await disablePush(); return "Đã tắt thông báo trên thiết bị này."; })} className="rounded-md px-2.5 py-1 font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">Tắt</button>
        </div>
        {message && <p className="mt-1.5">{message}</p>}
      </div>
    );
  }
  if (state === "off") {
    return (
      <div className={`${box} border-blue-200 bg-blue-50 text-blue-900`}>
        <p>Nhận thông báo trên {isIos() ? "iPhone" : "thiết bị"} này khi có PR chờ duyệt — kể cả lúc không mở app.</p>
        <button type="button" disabled={busy} onClick={turnOn} className="mt-2 rounded-md bg-[#2563eb] text-white px-3 py-1.5 font-semibold hover:bg-[#1d4ed8] disabled:opacity-50">
          {busy ? "Đang bật..." : "Bật thông báo trên thiết bị này"}
        </button>
        {message && <p className="mt-1.5 text-rose-700">{message}</p>}
      </div>
    );
  }
  const notes: Record<Exclude<PushState, "on" | "off">, string> = {
    install: "iPhone/iPad: bấm nút Chia sẻ → \"Thêm vào MH chính\", mở FIN ERP từ icon đó rồi bật thông báo ở chuông này (cần iOS 16.4 trở lên).",
    "ios-old": "Máy này chạy iOS dưới 16.4 nên không nhận được thông báo đẩy — vẫn xem thông báo trong chuông này.",
    denied: "Trình duyệt đang chặn thông báo của trang này. Mở cài đặt trang (biểu tượng ổ khoá cạnh địa chỉ) → Thông báo → Cho phép, rồi tải lại trang.",
    unsupported: "Trình duyệt này không hỗ trợ thông báo đẩy (vd mở trong Zalo/Facebook). Mở bằng Chrome hoặc Safari để bật.",
  };
  return <div className={`${box} border-amber-200 bg-amber-50 text-amber-900`}>{notes[state]}</div>;
}

type PanelPosition = { top: number; left: number } | null;

/** Máy tính: thả ngay dưới chuông (không tràn mép phải); điện thoại (null): trải ngang màn hình. */
function panelPosition(anchor: HTMLElement): PanelPosition {
  if (window.innerWidth < 640) return null;
  const rect = anchor.getBoundingClientRect();
  const width = 384;
  return { top: rect.bottom + 8, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)) };
}

function NotificationPanel({ anchor, position, onClose, onNavigate }: { anchor: HTMLElement; position: PanelPosition; onClose: () => void; onNavigate?: () => void }) {
  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications?limit=40", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Không tải được thông báo");
      setItems(payload.items || []);
      setUnreadCount(Number(payload.unread) || 0);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Không tải được thông báo");
      setItems((current) => current || []);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [anchor, onClose]);

  const markRead = async (body: object) => {
    try {
      const response = await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.ok) setUnreadCount(Number((await response.json()).unread) || 0);
    } catch {
      // Không đánh dấu được thì lần mở sau vẫn hiện chưa đọc, không sao.
    }
  };

  const open = async (item: NotificationItem) => {
    if (!item.readAt) {
      setItems((current) => current?.map((row) => (row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row)) || null);
      await markRead({ action: "READ", ids: [item.id] });
    }
    onClose();
    onNavigate?.();
    if (item.url) router.push(item.url);
  };

  const readAll = async () => {
    setItems((current) => current?.map((row) => ({ ...row, readAt: row.readAt || new Date().toISOString() })) || null);
    await markRead({ action: "READ_ALL" });
  };

  const hasUnread = items?.some((item) => !item.readAt) ?? false;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Thông báo"
      style={position ? { top: position.top, left: position.left } : undefined}
      className={`fixed z-[90] flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white text-slate-800 shadow-2xl ${
        position ? "w-96 max-h-[min(36rem,calc(100dvh-6rem))]" : "inset-x-3 top-3 max-h-[calc(100dvh-1.5rem)]"
      }`}
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-bold">Thông báo</p>
        <div className="flex items-center gap-1">
          {hasUnread && (
            <button type="button" onClick={readAll} className="rounded-md px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50">Đánh dấu đã đọc hết</button>
          )}
          <button type="button" onClick={onClose} aria-label="Đóng" className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100">
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
      </div>
      <div className="border-b border-slate-100 px-4 py-3">
        <PushSection />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error && <p className="px-4 py-3 text-xs text-rose-700">{error}</p>}
        {items === null && <p className="px-4 py-6 text-center text-xs text-slate-500">Đang tải...</p>}
        {items !== null && items.length === 0 && !error && (
          <p className="px-4 py-8 text-center text-xs text-slate-500">Chưa có thông báo nào.</p>
        )}
        {items?.map((item) => {
          const unread = !item.readAt && !item.resolvedAt;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => void open(item)}
              className={`flex w-full gap-3 border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50 ${unread ? "bg-blue-50/50" : ""}`}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-[#2563eb]" : "bg-transparent"}`} />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm ${unread ? "font-bold text-slate-900" : "font-medium text-slate-600"}`}>{item.title}</span>
                {item.body && <span className="mt-0.5 block text-xs text-slate-500">{item.body}</span>}
                <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                  {timeLabel(item.createdAt)}
                  {item.resolvedAt && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-500">Đã xử lý</span>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Chuông thông báo (khách 27/11/2026, giống HRM): số chờ xử lý + danh sách, bấm mở đúng chứng từ;
 * bật / tắt thông báo đẩy cho thiết bị đang dùng. `tone="dark"` cho menu trái, `light` cho trang sáng.
 */
export function NotificationBell({ tone = "dark", onNavigate }: { tone?: "dark" | "light"; onNavigate?: () => void }) {
  const count = useUnreadCount();
  const [panel, setPanel] = useState<{ anchor: HTMLElement; position: PanelPosition } | null>(null);
  const close = useCallback(() => {
    setPanel(null);
    void refreshUnreadCount();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          const target = event.currentTarget;
          setPanel((current) => (current ? null : { anchor: target, position: panelPosition(target) }));
        }}
        aria-label={count > 0 ? `Thông báo, ${count} chưa đọc` : "Thông báo"}
        aria-expanded={Boolean(panel)}
        className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-full transition-colors ${
          tone === "dark" ? "text-white/80 hover:bg-white/10 hover:text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
        }`}
      >
        <span className="material-symbols-outlined text-[22px]">{count > 0 ? "notifications_active" : "notifications"}</span>
        <UnreadBadge count={count} className="absolute -right-0.5 -top-0.5" />
      </button>
      {panel && <NotificationPanel anchor={panel.anchor} position={panel.position} onClose={close} onNavigate={onNavigate} />}
    </>
  );
}
