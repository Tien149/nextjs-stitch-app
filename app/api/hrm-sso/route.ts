import { NextRequest, NextResponse } from "next/server";
import { SESSION_KEY } from "@/lib/auth-demo";
import { prisma } from "@/lib/prisma";
import { SESSION_MAX_AGE_REMEMBER } from "@/lib/session-cookie";
import { HRM_PROOF_COOKIE, hrmSsoSecret, issueHrmTicket, safeHrmNext, verifyProof } from "@/lib/hrm-sso";

// Nơi nhận vé bên HRM. Production cùng domain: mặc định "/hr-api/v1/auth/sso".
// Dev (HRM chạy cổng khác): HRM_SSO_TARGET=http://localhost:3100/hr-api/v1/auth/sso
const target = process.env.HRM_SSO_TARGET || "/hr-api/v1/auth/sso";

// Location tương đối: sau nginx, request.url của `next start` là http://localhost:3000/... nên không dùng làm gốc.
function redirectTo(location: string) {
  return new NextResponse(null, {
    status: 307,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

/**
 * Mục menu "Nhân sự (HRM)" trỏ vào đây. Đã đăng nhập kế toán → phát vé một lần, chuyển sang HRM.
 * Chưa đăng nhập (hoặc thiếu cookie chứng thực) → về trang đăng nhập kế toán, xong quay lại đây.
 */
export async function GET(request: NextRequest) {
  const next = safeHrmNext(request.nextUrl.searchParams.get("next"));
  const secret = hrmSsoSecret();
  if (!secret) {
    return NextResponse.json({ error: "Chưa cấu hình HRM_SSO_SECRET" }, { status: 503 });
  }

  const toLogin = () => {
    const back = `/api/hrm-sso?next=${encodeURIComponent(next)}`;
    return redirectTo(`/login?next=${encodeURIComponent(back)}`);
  };

  // Chỉ đọc cookie (không nhận header/bearer như các API khác) và bắt buộc có cookie chứng thực có chữ ký.
  let sessionId = "";
  try {
    const raw = request.cookies.get(SESSION_KEY)?.value;
    sessionId = raw ? String(JSON.parse(decodeURIComponent(raw)).id || "") : "";
  } catch {
    sessionId = "";
  }
  const provenId = verifyProof(secret, request.cookies.get(HRM_PROOF_COOKIE)?.value, SESSION_MAX_AGE_REMEMBER);
  if (!sessionId || !provenId || provenId !== sessionId) return toLogin();

  // Tài khoản phải còn hoạt động (tài khoản bị xoá mềm không tìm thấy).
  const user = await prisma.user.findFirst({ where: { id: provenId }, select: { id: true, email: true, name: true } });
  if (!user) return toLogin();

  const ticket = issueHrmTicket(secret, user);
  return redirectTo(`${target}?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}`);
}
