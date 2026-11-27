import { prisma } from "@/lib/prisma";
import { canOpenPath, canPerformMenuAction, type DemoSession } from "@/lib/auth-demo";
import { publicBaseUrl } from "@/lib/public-url";
import { warehouseAllowed } from "@/lib/warehouse-scope";
import { generateVapidKeys, sendWebPush, type VapidKeys } from "@/lib/web-push";

/**
 * Thông báo trong app + đẩy lên thiết bị (khách 27/11/2026: "báo người duyệt PO khi có PR", làm
 * giống HRM). Mỗi người nhận một dòng AppNotification; ai đã bật thông báo trên trình duyệt /
 * điện thoại thì nhận thêm Web Push. Gửi thông báo KHÔNG BAO GIỜ làm hỏng thao tác chính — lỗi chỉ ghi log.
 */

export type NotificationInput = {
  type: string;
  title: string;
  body?: string | null;
  url?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey?: string | null;
};

let cachedKeys: VapidKeys | null = null;

/** Khoá VAPID: .env PUSH_VAPID_PUBLIC_KEY + PUSH_VAPID_PRIVATE_KEY nếu có, không thì tự sinh một lần và lưu DB. */
export async function vapidKeys(): Promise<VapidKeys> {
  if (cachedKeys) return cachedKeys;
  const envPublic = (process.env.PUSH_VAPID_PUBLIC_KEY || "").trim();
  const envPrivate = (process.env.PUSH_VAPID_PRIVATE_KEY || "").trim();
  if (envPublic && envPrivate) {
    cachedKeys = { publicKey: envPublic, privateKey: envPrivate };
    return cachedKeys;
  }
  const existing = await prisma.webPushVapidKey.findUnique({ where: { id: 1 } });
  if (existing) {
    cachedKeys = { publicKey: existing.publicKey, privateKey: existing.privateKey };
    return cachedKeys;
  }
  const generated = generateVapidKeys();
  // Hai tiến trình cùng sinh lần đầu: bản ghi id=1 tạo trước thắng, bên kia đọc lại.
  const saved = await prisma.webPushVapidKey.upsert({ where: { id: 1 }, create: { id: 1, ...generated }, update: {} });
  cachedKeys = { publicKey: saved.publicKey, privateKey: saved.privateKey };
  return cachedKeys;
}

/** "sub" của VAPID (Apple bắt buộc https:// hoặc mailto: thật). */
export function pushSubject(request?: Request) {
  const configured = (process.env.PUSH_VAPID_SUBJECT || "").trim();
  if (configured) return configured;
  if (request) {
    const base = publicBaseUrl(request);
    if (base.startsWith("https://")) return base;
  }
  const appUrl = (process.env.APP_PUBLIC_URL || "").trim();
  if (appUrl) return /^https?:\/\//i.test(appUrl) ? appUrl.replace(/\/+$/, "") : `https://${appUrl.replace(/\/+$/, "")}`;
  return "mailto:admin@localhost";
}

/** Đẩy lên mọi thiết bị đã bật thông báo của các user; đăng ký đã chết (404/410) thì xoá. */
export async function pushToUsers(userIds: string[], payload: { title: string; body?: string | null; url?: string | null; tag?: string | null }, request?: Request) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return { sent: 0, failed: 0 };
  const subscriptions = await prisma.webPushSubscription.findMany({ where: { userId: { in: ids } } });
  if (subscriptions.length === 0) return { sent: 0, failed: 0 };
  const keys = await vapidKeys();
  const subject = pushSubject(request);
  let sent = 0;
  let failed = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    const result = await sendWebPush(subscription, { title: payload.title, body: payload.body || "", url: payload.url || "/", tag: payload.tag || undefined }, keys, subject);
    if (result.ok) {
      sent += 1;
      await prisma.webPushSubscription.update({ where: { id: subscription.id }, data: { lastSuccessAt: new Date() } }).catch(() => undefined);
      return;
    }
    failed += 1;
    if (result.gone) {
      await prisma.webPushSubscription.deleteMany({ where: { id: subscription.id } }).catch(() => undefined);
    } else {
      console.warn(`Web Push lỗi ${result.status} (${new URL(subscription.endpoint).host}): ${result.message}`);
    }
  }));
  return { sent, failed };
}

/**
 * Ghi thông báo cho từng người nhận rồi đẩy lên thiết bị (đẩy chạy nền, không chờ). Cùng dedupeKey
 * = làm mới dòng cũ (chưa đọc, chưa xử lý, lên đầu danh sách) — vd PR bị từ chối rồi gửi lại.
 */
export async function notifyUsers(userIds: string[], input: NotificationInput, request?: Request) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  const data = {
    type: input.type,
    title: input.title,
    body: input.body || null,
    url: input.url || null,
    entityType: input.entityType || null,
    entityId: input.entityId || null,
  };
  if (input.dedupeKey) {
    const dedupeKey = input.dedupeKey;
    await prisma.$transaction(ids.map((userId) => prisma.appNotification.upsert({
      where: { userId_dedupeKey: { userId, dedupeKey } },
      create: { ...data, userId, dedupeKey },
      update: { ...data, readAt: null, resolvedAt: null, createdAt: new Date() },
    })));
  } else {
    await prisma.appNotification.createMany({ data: ids.map((userId) => ({ ...data, userId })) });
  }
  void pushToUsers(ids, { title: input.title, body: input.body, url: input.url, tag: input.dedupeKey }, request)
    .catch((error) => console.error("Không gửi được thông báo đẩy:", error));
  return ids.length;
}

/** Chứng từ đã được xử lý (duyệt / từ chối / huỷ / xoá): thông báo của nó thôi tính là việc chờ. */
export async function resolveEntityNotifications(entityType: string, entityId: string) {
  try {
    await prisma.appNotification.updateMany({ where: { entityType, entityId, resolvedAt: null }, data: { resolvedAt: new Date() } });
  } catch (error) {
    console.error("Không cập nhật được thông báo:", error);
  }
}

/**
 * Dựng phiên tạm của các user mà VAI TRÒ đã tick nhận loại thông báo này (Phân quyền) — cùng cách
 * /api/auth/login dựng phiên — để dùng lại đúng luật phân quyền.
 */
async function sessionsSubscribedTo(notificationType: string): Promise<DemoSession[]> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: { select: { name: true, menuAccess: true, actions: true, notificationTypes: true, deletedAt: true } },
      branchAccesses: { select: { branchCode: true } },
      warehouseAccesses: { select: { warehouseCode: true } },
    },
  });
  return users
    .filter((user) => user.role && !user.role.deletedAt && (user.role.notificationTypes || []).includes(notificationType))
    .map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: (user.role?.name || "") as DemoSession["role"],
      branch: "",
      menuAccess: user.role?.menuAccess || [],
      actions: user.role?.actions || [],
      allowedBranches: user.branchAccesses.map((access) => access.branchCode),
      allowedWarehouses: user.warehouseAccesses.map((access) => access.warehouseCode),
      loginAt: new Date().toISOString(),
    }));
}

function branchAllowed(session: DemoSession, branchCode: string) {
  const code = (branchCode || "").trim().toUpperCase();
  const allowed = (session.allowedBranches || []).map((value) => value.toUpperCase());
  return allowed.includes("ALL") || allowed.includes(code);
}

/**
 * Người nhận "PR chờ duyệt": vai trò tick nhận (Phân quyền, khách chốt 27/11/2026 — mặc định Thu Mua)
 * VÀ duyệt được đúng PR đó: mở được màn Mua hàng + quyền Duyệt + được phân cửa hàng và kho của PR
 * (các điều kiện APPROVE_REQUEST kiểm tra).
 */
export async function purchaseRequestApproverIds(pr: { branchCode: string; warehouseCode: string | null }, excludeUserId?: string) {
  const sessions = await sessionsSubscribedTo("PR_PENDING");
  return sessions
    .filter((session) => session.id !== excludeUserId)
    .filter((session) => canOpenPath(session, "/procurement") && canPerformMenuAction(session, "/procurement", "approve"))
    .filter((session) => branchAllowed(session, pr.branchCode))
    .filter((session) => warehouseAllowed(session, pr.warehouseCode))
    .map((session) => session.id);
}

type PendingRequest = {
  id: string;
  code: string;
  branchCode: string;
  warehouseCode: string | null;
  requestedBy: string;
  neededDate: Date | null;
  reason: string;
  lines?: unknown[];
};

/** "28/11" theo giờ Việt Nam (Intl vi-VN in ra "28-11"). */
function shortDate(value: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit" }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("day")}/${part("month")}`;
}

/** Báo người duyệt có PR chờ duyệt (tạo mới, đặt theo mẫu, hoặc gửi lại sau khi bị từ chối). */
export async function notifyPurchaseRequestPending(pr: PendingRequest, actor: DemoSession, request: Request, resubmitted = false) {
  try {
    const recipients = await purchaseRequestApproverIds(pr, actor.id);
    if (recipients.length === 0) return 0;
    const warehouse = pr.warehouseCode
      ? await prisma.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: pr.warehouseCode }, select: { name: true } })
      : null;
    const place = warehouse?.name || pr.warehouseCode || pr.branchCode;
    const parts = [
      `${pr.requestedBy} · ${place}`,
      pr.lines ? `${pr.lines.length} mặt hàng` : "",
      pr.neededDate ? `cần ${shortDate(pr.neededDate)}` : "",
    ].filter(Boolean);
    return await notifyUsers(recipients, {
      type: "PR_PENDING",
      title: `${pr.code} ${resubmitted ? "gửi lại, " : ""}chờ duyệt`,
      body: parts.join(" · "),
      url: `/open/${encodeURIComponent(pr.code)}`,
      entityType: "PurchaseRequest",
      entityId: pr.id,
      dedupeKey: `PR_PENDING:${pr.id}`,
    }, request);
  } catch (error) {
    console.error(`Không gửi được thông báo PR ${pr.code}:`, error);
    return 0;
  }
}
