import { NextResponse } from "next/server";
import { branchAccessLabel } from "@/lib/branch-labels";
import { prisma } from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Thiếu email hoặc mật khẩu" }, { status: 400 });
    }

    const normalizedEmail = email.trim();

    // Query user by email or fallback search (e.g. ID matching lower case)
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: normalizedEmail, mode: "insensitive" } },
          { name: { equals: normalizedEmail, mode: "insensitive" } },
          { id: { equals: normalizedEmail.toLowerCase() } }
        ]
      },
      include: {
        role: true,
        branchAccesses: true
      }
    });

    if (!user || user.password !== password) {
      return NextResponse.json({ error: "Sai tài khoản hoặc mật khẩu. Mật khẩu mặc định là: 123456" }, { status: 401 });
    }

    const allowedBranches = user.branchAccesses.map((branchAccess) => branchAccess.branchCode);

    const session = {
      id: user.id,
      name: user.id === "quanly" ? "Chủ cửa hàng" : user.name,
      role: user.role.name,
      branch: branchAccessLabel(allowedBranches),
      email: user.email,
      allowedBranches,
      loginAt: new Date().toISOString(),
    };

    return NextResponse.json(session);
  } catch (error) {
    console.error("Login API error:", error);
    return NextResponse.json({ error: "Lỗi máy chủ nội bộ" }, { status: 500 });
  }
}
