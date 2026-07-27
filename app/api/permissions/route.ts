import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/permissions");
    if (!auth.ok) return auth.response;

    const [users, roles] = await Promise.all([
      prisma.user.findMany({
        include: {
          role: true,
          branchAccesses: true,
        },
        orderBy: { email: "asc" },
      }),
      prisma.role.findMany({
        include: {
          _count: {
            select: { users: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    return NextResponse.json({ users, roles });
  } catch (error) {
    console.error("Error fetching permissions data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/permissions", "create");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const action = body.action || "CREATE_ROLE";

    if (action === "CREATE_ROLE") {
      const { name, actions } = body;
      if (!name || !name.trim()) {
        return NextResponse.json({ error: "Tên vai trò không được để trống" }, { status: 400 });
      }
      if (!Array.isArray(actions) || actions.length === 0) {
        return NextResponse.json({ error: "Cần chọn ít nhất 1 quyền trong ma trận phân quyền" }, { status: 400 });
      }

      const existing = await prisma.role.findUnique({ where: { name: name.trim() } });
      if (existing) {
        return NextResponse.json({ error: "Tên vai trò này đã tồn tại trong hệ thống" }, { status: 400 });
      }

      const role = await prisma.role.create({
        data: {
          name: name.trim(),
          actions,
        },
      });

      return NextResponse.json(role, { status: 201 });
    }

    if (action === "CREATE_USER") {
      const { email, password, name, phone, position, roleId, branchCodes } = body;
      if (!email || !email.trim()) {
        return NextResponse.json({ error: "Email / User đăng nhập không được để trống" }, { status: 400 });
      }
      if (!password || !password.trim()) {
        return NextResponse.json({ error: "Mật khẩu không được để trống" }, { status: 400 });
      }
      if (!name || !name.trim()) {
        return NextResponse.json({ error: "Họ và tên người dùng không được để trống" }, { status: 400 });
      }
      if (!roleId) {
        return NextResponse.json({ error: "Vui lòng chọn vai trò cho người dùng" }, { status: 400 });
      }

      const existingUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (existingUser) {
        return NextResponse.json({ error: "Email / Tên đăng nhập này đã tồn tại trong hệ thống" }, { status: 400 });
      }

      const branches = Array.isArray(branchCodes) && branchCodes.length > 0 ? branchCodes : ["ALL"];

      const newUser = await prisma.user.create({
        data: {
          email: email.trim().toLowerCase(),
          password: password.trim(),
          name: name.trim(),
          phone: phone ? phone.trim() : null,
          position: position ? position.trim() : null,
          roleId,
          branchAccesses: {
            create: branches.map((b: string) => ({ branchCode: b })),
          },
        },
        include: {
          role: true,
          branchAccesses: true,
        },
      });

      return NextResponse.json(newUser, { status: 201 });
    }

    return NextResponse.json({ error: "Hành động không hợp lệ" }, { status: 400 });
  } catch (error) {
    console.error("Error creating role:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const auth = requireMenuAction(request, "/permissions", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { roleId, name, actions } = body;

    if (!roleId || !name || !name.trim()) {
      return NextResponse.json({ error: "Thiếu mã vai trò hoặc tên vai trò" }, { status: 400 });
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      return NextResponse.json({ error: "Cần chọn ít nhất 1 quyền trong ma trận phân quyền" }, { status: 400 });
    }

    const role = await prisma.role.update({
      where: { id: roleId },
      data: {
        name: name.trim(),
        actions,
      },
    });

    return NextResponse.json(role);
  } catch (error) {
    console.error("Error updating role:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/permissions", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const roleId = searchParams.get("roleId");

    if (!roleId) {
      return NextResponse.json({ error: "Thiếu mã vai trò cần xóa" }, { status: 400 });
    }

    const userCount = await prisma.user.count({ where: { roleId } });
    if (userCount > 0) {
      return NextResponse.json({ error: `Không thể xóa vai trò này vì đang có ${userCount} người dùng sử dụng` }, { status: 400 });
    }

    await prisma.role.delete({ where: { id: roleId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error deleting role:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/permissions", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const userId = body.userId;
    const branchCodes = body.branchCodes;
    const roleId = body.roleId;

    if (!userId) {
      return NextResponse.json({ error: "Thiếu userId" }, { status: 400 });
    }

    if (roleId) {
      await prisma.user.update({
        where: { id: userId },
        data: { roleId },
      });
    }

    if (Array.isArray(branchCodes)) {
      await prisma.$transaction([
        prisma.userBranchAccess.deleteMany({ where: { userId } }),
        prisma.userBranchAccess.createMany({
          data: branchCodes.map((branchCode) => ({ userId, branchCode })),
        }),
      ]);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error updating user permission:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
