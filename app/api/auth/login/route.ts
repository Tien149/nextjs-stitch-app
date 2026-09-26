import { NextResponse } from "next/server";
import { branchAccessLabel } from "@/lib/branch-labels";
import { prisma } from "@/lib/prisma";
import { SESSION_MAX_AGE_DEFAULT, SESSION_MAX_AGE_REMEMBER, setSessionCookie } from "@/lib/session-cookie";
import { HRM_PROOF_COOKIE, HRM_PROOF_PATH, hrmSsoSecret, signProof } from "@/lib/hrm-sso";

export async function POST(request: Request) {
  try {
    const { email, password, rememberMe } = await request.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Thiếu email hoặc mật khẩu" }, { status: 400 });
    }

    const normalizedEmail = String(email).trim();
    const normalizedPassword = String(password).trim();

    type DbUser = {
      id: string;
      email: string;
      password: string;
      name: string;
      role?: { name: string; menuAccess: string[]; actions: string[] } | null;
      branchAccesses?: { branchCode: string }[] | null;
      departmentAccesses?: { departmentCode: string }[] | null;
    };

    let dbUser: DbUser | null = null;

    try {
      dbUser = await prisma.user.findFirst({
        where: {
          OR: [
            { email: { equals: normalizedEmail, mode: "insensitive" } },
            { name: { equals: normalizedEmail, mode: "insensitive" } },
            { id: { equals: normalizedEmail.toLowerCase() } },
          ],
        },
        select: {
          id: true,
          email: true,
          password: true,
          name: true,
          role: {
            select: {
              name: true,
              menuAccess: true,
              actions: true,
            },
          },
          branchAccesses: {
            select: {
              branchCode: true,
            },
          },
          departmentAccesses: {
            select: {
              departmentCode: true,
            },
          },
        },
      });
    } catch (dbErr) {
      // Không có cơ chế đăng nhập dự phòng: nếu không kiểm tra được tài khoản
      // trong database thì phải từ chối, tuyệt đối không cấp phiên đăng nhập.
      console.error("Lỗi truy vấn tài khoản khi đăng nhập:", dbErr);
      return NextResponse.json(
        { error: "Hệ thống đang không truy cập được dữ liệu tài khoản. Vui lòng thử lại sau." },
        { status: 503 }
      );
    }

    if (dbUser) {
      if (dbUser.password.trim() !== normalizedPassword) {
        return NextResponse.json(
          { error: "Tài khoản hoặc mật khẩu không đúng." },
          { status: 401 }
        );
      }

      const allowedBranches = dbUser.branchAccesses?.map((b) => b.branchCode) || [];
      // Phạm vi phòng ban (kiểm kê theo bộ phận). Không gán = mọi phòng ban, giữ nguyên hành vi cũ.
      const allowedDepartments = dbUser.departmentAccesses?.map((d) => d.departmentCode) || [];

      const session = {
        id: dbUser.id,
        name: dbUser.id === "quanly" ? "Chủ cửa hàng" : dbUser.name,
        role: dbUser.role?.name || "Giam Sat",
        menuAccess: dbUser.role?.menuAccess || [],
        actions: dbUser.role?.actions || [],
        branch: branchAccessLabel(allowedBranches),
        email: dbUser.email,
        allowedBranches,
        allowedDepartments,
        loginAt: new Date().toISOString(),
      };

      // Server là nơi duy nhất phát hành cookie phiên, tránh cảnh client và API
      // giữ hai bản phiên có tuổi thọ lệch nhau.
      const response = NextResponse.json(session);
      setSessionCookie(response, JSON.stringify(session), Boolean(rememberMe));

      // Cookie chứng thực có chữ ký cho việc đăng nhập sang HRM (/api/hrm-sso). Chỉ phát khi đã cấu hình khóa.
      const ssoSecret = hrmSsoSecret();
      if (ssoSecret) {
        response.cookies.set({
          name: HRM_PROOF_COOKIE,
          value: signProof(ssoSecret, dbUser.id),
          httpOnly: true,
          sameSite: "lax",
          path: HRM_PROOF_PATH,
          maxAge: rememberMe ? SESSION_MAX_AGE_REMEMBER : SESSION_MAX_AGE_DEFAULT,
        });
      }
      return response;
    }

    // Không tìm thấy tài khoản đang hoạt động trong database.
    // Tài khoản đã bị xoá (deletedAt khác null) cũng rơi vào nhánh này nên
    // mất quyền đăng nhập ngay sau khi bị xoá.
    return NextResponse.json(
      { error: "Tài khoản hoặc mật khẩu không đúng." },
      { status: 401 }
    );
  } catch (error) {
    console.error("Login API error:", error);
    return NextResponse.json({ error: "Lỗi máy chủ nội bộ khi đăng nhập" }, { status: 500 });
  }
}
