import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText } from "@/lib/phase3";

/** Thông báo của người đang đăng nhập (chuông trên menu). `unread` = chưa đọc và chứng từ chưa ai xử lý. */
export async function GET(request: Request) {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth.response;
  try {
    const { searchParams } = new URL(request.url);
    const userId = auth.session.id;
    const unreadWhere = { userId, readAt: null, resolvedAt: null };
    if (searchParams.get("summary") === "1") {
      return NextResponse.json({ unread: await prisma.appNotification.count({ where: unreadWhere }) });
    }
    const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 30, 1), 100);
    const [items, unread] = await Promise.all([
      prisma.appNotification.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { id: true, type: true, title: true, body: true, url: true, readAt: true, resolvedAt: true, createdAt: true },
      }),
      prisma.appNotification.count({ where: unreadWhere }),
    ]);
    return NextResponse.json({ items, unread });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

/** Đánh dấu đã đọc: { action: "READ", ids } hoặc { action: "READ_ALL" }. Chỉ đụng thông báo của chính mình. */
export async function POST(request: Request) {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json().catch(() => ({}));
    const action = cleanText(body.action);
    const userId = auth.session.id;
    if (action === "READ") {
      const ids = Array.isArray(body.ids) ? body.ids.map((id: unknown) => cleanText(id)).filter(Boolean).slice(0, 200) : [];
      if (ids.length === 0) businessError("Thiếu thông báo cần đánh dấu");
      await prisma.appNotification.updateMany({ where: { userId, id: { in: ids }, readAt: null }, data: { readAt: new Date() } });
    } else if (action === "READ_ALL") {
      await prisma.appNotification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
    } else {
      businessError("Thao tác thông báo không hợp lệ");
    }
    return NextResponse.json({ unread: await prisma.appNotification.count({ where: { userId, readAt: null, resolvedAt: null } }) });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
