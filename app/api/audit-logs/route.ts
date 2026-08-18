import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/api-auth";
import { SYSTEM_ACTOR_ROLE } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/custom-client";

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/audit-logs");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const branchCode = searchParams.get("branchCode") || "ALL";
    const moduleFilter = searchParams.get("module") || "ALL";
    const search = searchParams.get("search")?.trim() || "";
    const startDate = searchParams.get("startDate") || "";
    const endDate = searchParams.get("endDate") || "";
    // Thao tác do lệnh bảo trì chạy (vá dữ liệu cũ, nhập bù...) luôn ẩn khỏi màn Nhật ký:
    // kế toán mở lên là để soi thao tác của NGƯỜI, lẫn dòng máy vào chỉ gây hoang mang.
    //
    // Màn hình không có nút bật — cố ý, để người dùng không thấy khái niệm này. Vết vẫn ghi
    // đủ trong database, khi cần soi thì gọi thẳng /api/audit-logs?includeSystem=1 bằng tài
    // khoản có quyền vào /audit-logs. Ẩn khỏi giao diện, không bao giờ xoá.
    const includeSystem = searchParams.get("includeSystem") === "1";

    // Hai điều kiện cùng dùng OR (ẩn thao tác máy, và tìm kiếm nhiều cột) nên phải gộp qua
    // AND. Gán thẳng `where.OR` hai lần thì cái sau đè cái trước — gõ từ khoá là dòng máy
    // hiện lại, còn bộ lọc coi như không có.
    const conditions: Prisma.AuditLogWhereInput[] = [];
    const where: Prisma.AuditLogWhereInput = {};
    // Phải cho NULL đi qua: `{ not: "SCRIPT" }` của Prisma loại luôn dòng rỗng, mà 28 dòng
    // import cũ đều để trống vai trò — lọc kiểu đó là nuốt mất thao tác thật của người dùng.
    if (!includeSystem) {
      conditions.push({ OR: [{ actorRole: null }, { actorRole: { not: SYSTEM_ACTOR_ROLE } }] });
    }

    // Filter by branch
    if (branchCode !== "ALL") {
      where.branchCode = branchCode;
    }

    // Filter by module
    if (moduleFilter !== "ALL") {
      where.module = moduleFilter;
    }

    // Filter by date range
    if (startDate || endDate) {
      where.occurredAt = {};
      if (startDate) {
        where.occurredAt.gte = new Date(`${startDate}T00:00:00.000Z`);
      }
      if (endDate) {
        where.occurredAt.lte = new Date(`${endDate}T23:59:59.999Z`);
      }
    }

    // Search query
    if (search) {
      conditions.push({
        OR: [
          { actorName: { contains: search } },
          { actorRole: { contains: search } },
          { entityCode: { contains: search } },
          { message: { contains: search } },
          { metadataJson: { contains: search } },
        ],
      });
    }

    if (conditions.length) where.AND = conditions;

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      take: 200, // Limit to recent 200 logs for performance
    });

    return NextResponse.json(logs);
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
