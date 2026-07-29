"use client";

import { useEffect } from "react";
import { LOGIN_PATH, clearClientSession, loginPathWithNext } from "@/lib/session-client";

function requestUrl(input: RequestInfo | URL) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, window.location.href);
  } catch {
    return null;
  }
}

/**
 * Khi cookie phiên hết hạn, mọi API trả 401 nhưng màn hình vẫn mở vì
 * localStorage còn phiên cũ — người dùng chỉ thấy "chưa đăng nhập" trong form.
 * Guard này bắt 401 ở tầng fetch, dọn phiên và đẩy thẳng về trang đăng nhập.
 */
export default function SessionExpiryGuard() {
  useEffect(() => {
    const originalFetch = window.fetch;
    let redirecting = false;

    const patchedFetch: typeof window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);

      if (response.status !== 401 || redirecting) return response;
      if (window.location.pathname === LOGIN_PATH) return response;

      const url = requestUrl(input);
      if (!url || url.origin !== window.location.origin) return response;
      if (!url.pathname.startsWith("/api/")) return response;
      // 401 ở đây là sai tài khoản/mật khẩu, không phải phiên hết hạn
      if (url.pathname === "/api/auth/login") return response;

      redirecting = true;
      clearClientSession();
      window.location.replace(loginPathWithNext(window.location.pathname + window.location.search));
      return response;
    };

    window.fetch = patchedFetch;
    return () => {
      if (window.fetch === patchedFetch) window.fetch = originalFetch;
    };
  }, []);

  return null;
}
