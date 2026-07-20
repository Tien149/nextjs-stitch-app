import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/permissions");
    if (!auth.ok) return auth.response;

    const users = await prisma.user.findMany({
      include: {
        role: true,
        branchAccesses: true
      },
      orderBy: { email: "asc" }
    });

    return NextResponse.json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/permissions", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const userId = body.userId;
    const branchCodes = body.branchCodes; // array of strings e.g. ["HCM", "HN", "ALL"]

    if (!userId || !Array.isArray(branchCodes)) {
      return NextResponse.json({ error: "Thiếu userId hoặc danh sách chi nhánh không hợp lệ" }, { status: 400 });
    }

    // Update branch accesses inside a transaction
    await prisma.$transaction([
      prisma.userBranchAccess.deleteMany({ where: { userId } }),
      prisma.userBranchAccess.createMany({
        data: branchCodes.map((branchCode) => ({ userId, branchCode }))
      })
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error updating user branch access:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
