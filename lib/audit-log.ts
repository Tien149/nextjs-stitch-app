import { prisma } from "@/lib/prisma";
import type { DemoSession } from "@/lib/auth-demo";

type AuditLogInput = {
  session?: DemoSession | null;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  module: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityCode?: string | null;
  branchCode?: string | null;
  status?: "SUCCESS" | "FAILED" | "BLOCKED";
  message?: string | null;
  metadata?: unknown;
};

function serializeMetadata(value: unknown) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item).slice(0, 12000);
  } catch {
    return String(value).slice(0, 12000);
  }
}

export async function writeAuditLog(input: AuditLogInput) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.session?.id || input.actorId || null,
        actorName: input.session?.name || input.actorName || null,
        actorRole: input.session?.role || input.actorRole || null,
        branchCode: input.branchCode || null,
        module: input.module,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId || null,
        entityCode: input.entityCode || null,
        status: input.status || "SUCCESS",
        message: input.message || null,
        metadataJson: serializeMetadata(input.metadata),
      },
    });
  } catch (error) {
    console.error("Audit log write failed:", error);
  }
}
