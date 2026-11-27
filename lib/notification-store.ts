"use client";

import { useSyncExternalStore } from "react";

/**
 * Số thông báo chưa đọc dùng chung cho chuông trên menu, nút menu điện thoại và chuông trang chủ —
 * một vòng hỏi máy chủ mỗi 60 giây (và khi quay lại tab) thay vì mỗi chỗ tự hỏi.
 */
let unread = 0;
let timer: number | null = null;
let inFlight = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function setUnreadCount(value: number) {
  if (value === unread) return;
  unread = value;
  emit();
}

export async function refreshUnreadCount() {
  if (inFlight || typeof window === "undefined") return;
  inFlight = true;
  try {
    const response = await fetch("/api/notifications?summary=1", { cache: "no-store" });
    if (response.ok) setUnreadCount(Number((await response.json()).unread) || 0);
  } catch {
    // Mất mạng: giữ số cũ, lượt sau hỏi lại.
  } finally {
    inFlight = false;
  }
}

function onVisible() {
  if (document.visibilityState === "visible") void refreshUnreadCount();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshUnreadCount();
    timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshUnreadCount();
    }, 60_000);
    document.addEventListener("visibilitychange", onVisible);
    // Service worker báo có thông báo mới khi app đang mở → cập nhật số ngay.
    navigator.serviceWorker?.addEventListener?.("message", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) window.clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener?.("message", onVisible);
    }
  };
}

export function useUnreadCount() {
  return useSyncExternalStore(subscribe, () => unread, () => 0);
}
