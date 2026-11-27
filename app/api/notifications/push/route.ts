import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText } from "@/lib/phase3";
import { pushToUsers, vapidKeys } from "@/lib/notifications";
import { isAllowedPushEndpoint } from "@/lib/web-push";

/** Khoá công khai VAPID + số thiết bị đã bật thông báo của người đang đăng nhập. */
export async function GET(request: Request) {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth.response;
  try {
    const [keys, devices] = await Promise.all([
      vapidKeys(),
      prisma.webPushSubscription.count({ where: { userId: auth.session.id } }),
    ]);
    return NextResponse.json({ enabled: true, publicKey: keys.publicKey, devices });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

function base64urlKey(value: unknown, minBytes: number) {
  const text = cleanText(value);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(text)) return "";
  return Buffer.from(text.replace(/=+$/, ""), "base64url").length >= minBytes ? text : "";
}

/**
 * { action: "subscribe", subscription } — gắn đăng ký của trình duyệt này vào tài khoản đang đăng nhập
 * (máy dùng chung: người đăng nhập sau nhận thông báo). { action: "unsubscribe", endpoint } — tắt.
 * { action: "test" } — gửi thử tới mọi thiết bị của mình.
 */
export async function POST(request: Request) {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json().catch(() => ({}));
    const action = cleanText(body.action);
    const userId = auth.session.id;

    if (action === "subscribe") {
      const subscription = (body.subscription || {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      const endpoint = cleanText(subscription.endpoint);
      if (!endpoint || endpoint.length > 1000 || !isAllowedPushEndpoint(endpoint)) businessError("Trình duyệt này không hỗ trợ thông báo đẩy (BAD_ENDPOINT).");
      const p256dh = base64urlKey(subscription.keys?.p256dh, 65);
      const authKey = base64urlKey(subscription.keys?.auth, 16);
      if (!p256dh || !authKey) businessError("Đăng ký thông báo không hợp lệ (BAD_SUBSCRIPTION).");
      const userAgent = (request.headers.get("user-agent") || "").slice(0, 300) || null;
      await prisma.webPushSubscription.upsert({
        where: { endpoint },
        create: { userId, endpoint, p256dh, auth: authKey, userAgent },
        update: { userId, p256dh, auth: authKey, userAgent },
      });
    } else if (action === "unsubscribe") {
      const endpoint = cleanText(body.endpoint);
      if (endpoint) await prisma.webPushSubscription.deleteMany({ where: { endpoint, userId } });
    } else if (action === "test") {
      const result = await pushToUsers([userId], { title: "FIN ERP · Gửi thử", body: "Thông báo đã bật trên thiết bị này.", url: "/", tag: "push-test" }, request);
      if (result.sent === 0) businessError(result.failed > 0 ? "Gửi thử không thành công — hãy tắt rồi bật lại thông báo trên thiết bị." : "Chưa có thiết bị nào bật thông báo.");
      return NextResponse.json({ ok: true, ...result });
    } else {
      businessError("Thao tác không hợp lệ");
    }
    return NextResponse.json({ ok: true, devices: await prisma.webPushSubscription.count({ where: { userId } }) });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
