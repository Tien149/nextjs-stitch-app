import { NextResponse } from "next/server";
import { branchAccessLabel } from "@/lib/branch-labels";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();
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
      role?: { name: string; menuAccess: string[] } | null;
      branchAccesses?: { branchCode: string }[] | null;
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
            },
          },
          branchAccesses: {
            select: {
              branchCode: true,
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

      const session = {
        id: dbUser.id,
        name: dbUser.id === "quanly" ? "Chủ cửa hàng" : dbUser.name,
        role: dbUser.role?.name || "Giam Sat",
        menuAccess: dbUser.role?.menuAccess || [],
        branch: branchAccessLabel(allowedBranches),
        email: dbUser.email,
        allowedBranches,
        loginAt: new Date().toISOString(),
      };

      return NextResponse.json(session);
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
