import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/api-auth";
import { writeAuditLog } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";

/** Mật khẩu tối thiểu khi người dùng tự đổi. */
const MIN_PASSWORD_LENGTH = 6;

/**
 * Người dùng tự đổi mật khẩu của chính mình (khách 26/10/2026: trước đây chỉ admin đặt lại ở
 * màn Phân quyền). Bắt nhập đúng mật khẩu hiện tại — phiên chỉ cho biết đang là ai, không đủ
 * để đổi mật khẩu. Lưu cùng dạng với màn Phân quyền và so khớp như /api/auth/login (trim).
 */
export async function POST(request: Request) {
  const auth = getRequestSession(request);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const currentPassword = String(body.currentPassword ?? "").trim();
    const newPassword = String(body.newPassword ?? "").trim();
    if (!currentPassword || !newPassword) {
      return NextResponse.json({ error: "Nhập mật khẩu hiện tại và mật khẩu mới." }, { status: 400 });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Mật khẩu mới phải có ít nhất ${MIN_PASSWORD_LENGTH} ký tự.` }, { status: 400 });
    }
    if (newPassword === currentPassword) {
      return NextResponse.json({ error: "Mật khẩu mới phải khác mật khẩu hiện tại." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: auth.session.id }, select: { id: true, email: true, password: true } });
    if (!user) {
      return NextResponse.json({ error: "Không tìm thấy tài khoản — đăng nhập lại rồi thử lại." }, { status: 404 });
    }
    if (user.password.trim() !== currentPassword) {
      await writeAuditLog({ session: auth.session, module: "AUTH", action: "CHANGE_PASSWORD", entityType: "User", entityId: user.id, entityCode: user.email, status: "FAILED", message: "Sai mật khẩu hiện tại" });
      return NextResponse.json({ error: "Mật khẩu hiện tại không đúng." }, { status: 400 });
    }

    await prisma.user.update({ where: { id: user.id }, data: { password: newPassword } });
    await writeAuditLog({ session: auth.session, module: "AUTH", action: "CHANGE_PASSWORD", entityType: "User", entityId: user.id, entityCode: user.email, message: "Người dùng tự đổi mật khẩu" });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Lỗi đổi mật khẩu:", error);
    return NextResponse.json({ error: "Không đổi được mật khẩu, vui lòng thử lại." }, { status: 500 });
  }
}
