import { NextResponse } from "next/server";
import {
  appMenuItems,
  canAccessMenu,
  canPerformAction,
  canPerformMenuAction,
  demoUsers,
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
    const matchedUser = demoUsers.find(
      (user) => user.id === parsed.id && user.email === parsed.email && user.role === parsed.role,
    );

    if (!matchedUser || !parsed.name || !parsed.branch || !parsed.loginAt) {
      return null;
    }

    return {
      id: matchedUser.id,
      name: matchedUser.name,
      role: matchedUser.role,
      branch: matchedUser.branch,
      email: matchedUser.email,
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
  const session = parseSession(cookieSession || headerSession);

  if (!session) {
    return { ok: false, response: unauthorized() };
  }

  return { ok: true, session };
}

export function requireMenuAccess(request: Request, href: string): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  const allowed = appMenuItems.some(
    (item) => item.href === href && canAccessMenu(auth.session.role, item),
  );

  if (!allowed) {
    return { ok: false, response: forbidden("Khong co quyen truy cap module nay") };
  }

  return auth;
}

export function requireNamedMenuAccess(request: Request, href: string, name: string): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  const allowed = appMenuItems.some(
    (item) => item.href === href && item.name === name && canAccessMenu(auth.session.role, item),
  );

  if (!allowed) {
    return { ok: false, response: forbidden("Khong co quyen truy cap module nay") };
  }

  return auth;
}

export function requireAction(request: Request, action: AppAction): ApiAuthResult {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth;

  if (!canPerformAction(auth.session.role, action)) {
    return { ok: false, response: forbidden() };
  }

  return auth;
}

export function requireMenuAction(request: Request, href: string, action: AppAction): ApiAuthResult {
  const auth = requireMenuAccess(request, href);
  if (!auth.ok) return auth;

  if (!canPerformMenuAction(auth.session.role, href, action)) {
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

  if (!canPerformMenuAction(auth.session.role, href, action)) {
    return { ok: false, response: forbidden() };
  }

  return auth;
}

export function isAdmin(role: DemoRole) {
  return role === "Admin";
}
