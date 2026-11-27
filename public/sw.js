// Service worker FIN ERP: CHỈ nhận thông báo đẩy (Web Push) — không cache trang / API (số liệu kế toán
// luôn phải lấy từ máy chủ). Học theo HRM (hrm-web/public/sw.js), 27/11/2026.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : "" };
  }
  const scope = self.registration.scope;
  const url = new URL(String(d.url || "/").replace(/^\/+/, ""), scope).href;
  event.waitUntil(
    Promise.all([
      // App đang mở thì báo cho trang cập nhật số trên chuông ngay.
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.forEach((client) => client.postMessage({ type: "notification" }))),
      self.registration.showNotification(d.title || "FIN ERP", {
        body: d.body || "",
        tag: d.tag || undefined,
        renotify: Boolean(d.tag),
        icon: scope + "icon-192.png",
        badge: scope + "icon-192.png",
        data: { url },
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const scope = self.registration.scope;
  const url = (event.notification.data && event.notification.data.url) || scope;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (list) => {
      // HRM chạy cùng tên miền ở /hr (service worker riêng) — không lấy nhầm tab HRM để mở chứng từ kế toán.
      const open = list.find((c) => c.url.startsWith(scope) && !c.url.startsWith(scope + "hr/") && !c.url.startsWith(scope + "hr-demo/"));
      if (open) {
        await open.focus();
        if ("navigate" in open) {
          try {
            await open.navigate(url);
            return;
          } catch {
            // trang chưa được service worker kiểm soát → mở cửa sổ mới
          }
        }
      }
      await self.clients.openWindow(url);
    }),
  );
});
