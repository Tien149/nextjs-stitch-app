import { NextResponse } from "next/server";
import { requireMenuAccess } from "@/lib/api-auth";
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

    const where: Prisma.AuditLogWhereInput = {};

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
      where.OR = [
        { actorName: { contains: search } },
        { actorRole: { contains: search } },
        { entityCode: { contains: search } },
        { message: { contains: search } },
        { metadataJson: { contains: search } },
      ];
    }

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
