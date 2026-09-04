/**
 * Nút "Chuẩn hoá nhóm doanh thu đã import" trên Cài đặt > Danh mục Thu/Chi.
 *
 * Người dùng sửa nhóm doanh thu / từ khoá nhận dạng trên danh mục xong bấm nút này để dữ liệu
 * doanh thu cũ chạy lại đúng luật — thay cho việc phải gọi người chạy lệnh backfill.
 * POST không kèm gì = chạy thử, trả về sẽ đổi bao nhiêu dòng; { apply: true } mới ghi thật.
 */
import { NextResponse } from "next/server";
import { requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { writeAuditLog } from "@/lib/audit-log";
import { normalizeRevenueSources, type NormalizeClient } from "@/lib/revenue-source-normalize";

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/settings", "config");
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => ({}));
    const apply = body?.apply === true;
    // prisma ở đây là client đã gắn extension xoá mềm, kiểu không khớp TransactionClient thuần
    // như trong import (lib/import-commit.ts cũng ép kiểu y hệt).
    const result = await normalizeRevenueSources(prisma as unknown as NormalizeClient, { apply });

    if (result.applied && (result.changedRows > 0 || result.releasedRows > 0)) {
      await writeAuditLog({
        session: auth.session,
        module: "/settings",
        action: "NORMALIZE_REVENUE_SOURCE",
        entityType: "RevenueImportRow",
        message: `Chuẩn hoá nhóm doanh thu cho ${result.changedRows} dòng doanh thu và ${result.journalLines} dòng bút toán 511`
          + (result.releasedRows > 0 ? `, thả ${result.releasedRows} dòng khỏi hàng chờ rã nguyên liệu` : ""),
        metadata: { groups: result.groups, releasedRows: result.releasedRows },
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error normalizing revenue source:", error);
    return NextResponse.json({ error: "Không chuẩn hoá được nhóm doanh thu" }, { status: 500 });
  }
}
