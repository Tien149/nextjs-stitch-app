import { NextResponse } from "next/server";
import {
  appMenuItems,
  canAccessMenu,
  canCreateCashDeposit,
  canOpenPath,
  canPerformAction,
  canPerformMenuAction,
  type AppAction,
  type DemoRole,
  type DemoSession,
  SESSION_KEY,
} from "@/lib/auth-demo";

type ApiAuthResult =
  | { ok: true; session: DemoSession }
  | { ok: false; response: NextResponse<{ error: string }> };

function getCookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") || "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  if (!cookie) return "";
  return cookie.slice(name.length + 1);
}

function parseSession(rawValue: string): DemoSession | null {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(decodeURIComponent(rawValue)) as Partial<DemoSession>;

    if (!parsed.id || !parsed.name || !parsed.role || !parsed.branch || !parsed.email || !parsed.loginAt) {
      return null;
    }

    return {
      id: parsed.id,
      name: parsed.name,
      role: parsed.role as DemoRole,
      branch: parsed.branch,
      email: parsed.email,
      allowedBranches: parsed.allowedBranches || [],
      menuAccess: parsed.menuAccess || [],
      actions: parsed.actions || [],
      loginAt: parsed.loginAt,
    };
  } catch {
    return null;
  }
}

export function unauthorized(message = "Chua dang nhap hoac phien dang nhap khong hop le") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function forbidden(message = "Khong du quyen thuc hien thao tac nay") {
  return NextResponse.json({ error: message }, { status: 403 });
}

export function getRequestSession(request: Request): ApiAuthResult {
  const cookieSession = getCookieValue(request, SESSION_KEY);
  const headerSession = request.headers.get("x-demo-session") || "";
  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const session = parseSession(cookieSession || headerSession || bearerToken);

  if (!session) {
    return { ok: false, response: unauthorized() };
  }

  return { ok: true, session };
}

export function requireMenuAccess(request: Request, href: string): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  // Vai trò được gán menu theo tab ("/reports?tab=daily-cash") vẫn phải gọi được API của trang.
  const allowed = canOpenPath(auth.session, href);

  if (!allowed) {
    return { ok: false, response: forbidden("Khong co quyen truy cap module nay") };
  }

  return auth;
}

export function requireNamedMenuAccess(request: Request, href: string, name: string): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  const allowed = appMenuItems.some(
    (item) => item.href === href && item.name === name && canAccessMenu(auth.session, item),
  );

  if (!allowed) {
    return { ok: false, response: forbidden("Khong co quyen truy cap module nay") };
  }

  return auth;
}

export function requireAction(request: Request, action: AppAction): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  if (!canPerformAction(auth.session, action)) {
    return { ok: false, response: forbidden() };
  }

  return auth;
}

export function requireMenuAction(request: Request, href: string, action: AppAction): ApiAuthResult {
  const auth = requireMenuAccess(request, href);
  if (!auth.ok) return auth;

  if (!canPerformMenuAction(auth.session, href, action)) {
    return { ok: false, response: forbidden() };
  }

  return auth;
}

/**
 * Gác cổng riêng cho phiếu nộp tiền: form nằm ở "Thu chi ngày" nên phiên chỉ cần mở được một
 * trong hai màn liên quan, còn quyền thao tác do canCreateCashDeposit quyết định.
 */
export function requireCashDepositCreate(request: Request): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  const reachesForm = canOpenPath(auth.session, "/finance-operations") || canOpenPath(auth.session, "/reports");
  if (!reachesForm) {
    return { ok: false, response: forbidden("Khong co quyen truy cap module nay") };
  }

  if (!canCreateCashDeposit(auth.session)) {
    return { ok: false, response: forbidden() };
  }

  return auth;
}

export function requireNamedMenuAction(
  request: Request,
  href: string,
  name: string,
  action: AppAction,
): ApiAuthResult {
  const auth = requireNamedMenuAccess(request, href, name);
  if (!auth.ok) return auth;

  if (!canPerformMenuAction(auth.session, href, action)) {
    return { ok: false, response: forbidden() };
  }

  return auth;
}

export function isAdmin(role: DemoRole) {
  return role === "Admin";
}
