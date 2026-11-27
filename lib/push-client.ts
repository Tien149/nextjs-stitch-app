// Thông báo đẩy Web Push trên thiết bị hiện tại (port từ HRM hrm-web/lib/push.ts, 27/11/2026).
// Máy chủ chỉ đẩy tiêu đề ngắn + link mở chứng từ, giống thông báo trong app.

/** unsupported: trình duyệt không hỗ trợ · install: iPhone/iPad phải "Thêm vào MH chính" trước · ios-old: iOS < 16.4 · denied: đã chặn quyền. */
export type PushState = "unsupported" | "install" | "ios-old" | "denied" | "off" | "on";

const SCOPE = "/";
const SW_URL = "/sw.js";

export function isIos() {
  if (/android/i.test(navigator.userAgent)) return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Phiên bản iOS từ user agent ("OS 15_8_7" → 15.08); null nếu không đọc được (iPad mới báo như Mac). */
function iosVersion(): number | null {
  const match = /OS (\d+)_(\d+)/.exec(navigator.userAgent);
  return match ? Number(match[1]) + Number(match[2]) / 100 : null;
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function supported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration(SCOPE);
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (typeof window === "undefined") return "unsupported";
  // Web Push trên iPhone/iPad cần iOS 16.4+: bản cũ hơn có cài ra màn hình chính cũng không nhận được.
  const version = isIos() ? iosVersion() : null;
  if (version !== null && version < 16.04) return "ios-old";
  if (!supported()) return isIos() && !isStandalone() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && (await currentSubscription()) ? "on" : "off";
}

function keyBytes(b64url: string) {
  const text = atob(b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(text.length));
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index);
  return out;
}

function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array) {
  if (!current || current.byteLength !== expected.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((value, index) => value === expected[index]);
}

async function postPush(body: object) {
  const response = await fetch("/api/notifications/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Không lưu được cài đặt thông báo");
  return payload as { ok: boolean; devices?: number; sent?: number };
}

export async function pushConfig() {
  const response = await fetch("/api/notifications/push", { cache: "no-store" });
  if (!response.ok) throw new Error("Không tải được cài đặt thông báo");
  return (await response.json()) as { enabled: boolean; publicKey: string; devices: number };
}

/** Gọi TRỰC TIẾP trong sự kiện bấm nút (Safari chỉ cho xin quyền khi có thao tác người dùng). */
export async function enablePush(publicKey: string) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Bạn chưa cho phép thông báo — bật lại trong cài đặt trình duyệt / điện thoại.");
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
  await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe(); // máy chủ đổi khoá VAPID → đăng ký lại
    subscription = null;
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return postPush({ action: "subscribe", subscription: subscription.toJSON() });
}

/** Gắn lại đăng ký sẵn có của trình duyệt vào tài khoản vừa đăng nhập (máy dùng chung). */
export async function syncPush() {
  try {
    const subscription = supported() && Notification.permission === "granted" ? await currentSubscription() : null;
    if (subscription) await postPush({ action: "subscribe", subscription: subscription.toJSON() });
  } catch {
    // Không gắn lại được thì người dùng bật lại ở chuông thông báo.
  }
}

/** Tắt trên thiết bị này (cũng gọi lúc đăng xuất để người sau không nhận thông báo của mình). */
export async function disablePush() {
  if (!supported()) return;
  const subscription = await currentSubscription();
  if (!subscription) return;
  try {
    await postPush({ action: "unsubscribe", endpoint: subscription.endpoint });
  } finally {
    await subscription.unsubscribe();
  }
}

export async function testPush() {
  return postPush({ action: "test" });
}
