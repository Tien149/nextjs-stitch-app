import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { softDeleteRecord } from "@/lib/soft-delete";

const EDIT_PAST_ROLE_NAMES = new Set(["Admin", "Kế toán tổng hợp"]);

function sanitizeRoleActions(roleName: string, actions: unknown[]) {
  const normalized = [...new Set(actions.filter((action): action is string => typeof action === "string"))];
  return EDIT_PAST_ROLE_NAMES.has(roleName.trim())
    ? normalized
    : normalized.filter((action) => action !== "edit_past");
}

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
          actions: sanitizeRoleActions(name, actions),
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
        actions: sanitizeRoleActions(name, actions),
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
    const userId = searchParams.get("userId");

    if (userId) {
      const target = await prisma.user.findUnique({
        where: { id: userId },
        include: { role: true },
      });
      if (!target) {
        return NextResponse.json({ error: "Không tìm thấy người dùng cần xóa" }, { status: 404 });
      }
      if (target.email.toLowerCase() === auth.session.email.toLowerCase()) {
        return NextResponse.json({ error: "Không thể xóa tài khoản bạn đang đăng nhập" }, { status: 400 });
      }
      if (target.role?.name === "Admin") {
        const adminCount = await prisma.user.count({ where: { role: { name: "Admin" } } });
        if (adminCount <= 1) {
          return NextResponse.json(
            { error: "Không thể xóa tài khoản Admin cuối cùng của hệ thống" },
            { status: 400 },
          );
        }
      }

      await softDeleteRecord({ model: "User", id: userId, session: auth.session });
      return NextResponse.json({ ok: true });
    }

    if (!roleId) {
      return NextResponse.json({ error: "Thiếu mã vai trò cần xóa" }, { status: 400 });
    }

    const userCount = await prisma.user.count({ where: { roleId } });
    if (userCount > 0) {
      return NextResponse.json({ error: `Không thể xóa vai trò này vì đang có ${userCount} người dùng sử dụng` }, { status: 400 });
    }

    await softDeleteRecord({ model: "Role", id: roleId, session: auth.session });
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

    if (body.action === "UPDATE_ROLE_MENU" || (roleId && Array.isArray(body.menuAccess))) {
      const updatedRole = await prisma.role.update({
        where: { id: roleId },
        data: { menuAccess: body.menuAccess },
      });
      return NextResponse.json(updatedRole);
    }

    if (!userId) {
      return NextResponse.json({ error: "Thiếu userId hoặc thông tin cần cập nhật" }, { status: 400 });
    }

    if (body.action === "UPDATE_USER") {
      const { email, name, phone, position, password } = body;

      if (!email || !String(email).trim()) {
        return NextResponse.json({ error: "Email / User đăng nhập không được để trống" }, { status: 400 });
      }
      if (!name || !String(name).trim()) {
        return NextResponse.json({ error: "Họ và tên người dùng không được để trống" }, { status: 400 });
      }
      if (!roleId) {
        return NextResponse.json({ error: "Vui lòng chọn vai trò cho người dùng" }, { status: 400 });
      }

      const normalizedEmail = String(email).trim().toLowerCase();
      const duplicated = await prisma.user.findFirst({
        where: { email: normalizedEmail, NOT: { id: userId } },
      });
      if (duplicated) {
        return NextResponse.json(
          { error: "Email / Tên đăng nhập này đã tồn tại trong hệ thống" },
          { status: 400 },
        );
      }

      // Không hạ quyền Admin cuối cùng, tránh khóa toàn bộ màn hình phân quyền
      const current = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
      if (current?.role?.name === "Admin" && current.roleId !== roleId) {
        const adminCount = await prisma.user.count({ where: { role: { name: "Admin" } } });
        if (adminCount <= 1) {
          return NextResponse.json(
            { error: "Không thể đổi vai trò của tài khoản Admin cuối cùng" },
            { status: 400 },
          );
        }
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          email: normalizedEmail,
          name: String(name).trim(),
          phone: phone ? String(phone).trim() : null,
          position: position ? String(position).trim() : null,
          roleId,
          ...(password && String(password).trim() ? { password: String(password).trim() } : {}),
        },
      });

      if (Array.isArray(branchCodes)) {
        await prisma.$transaction([
          prisma.userBranchAccess.deleteMany({ where: { userId } }),
          prisma.userBranchAccess.createMany({
            data: branchCodes.map((branchCode: string) => ({ userId, branchCode })),
          }),
        ]);
      }

      return NextResponse.json({ ok: true });
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
