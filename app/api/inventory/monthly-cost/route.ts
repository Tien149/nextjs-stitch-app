import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { writeAuditLog } from "@/lib/audit-log";
import { MonthlyCostError, applyMonthlyCost, monthlyCostStatus, previewMonthlyCost } from "@/lib/inventory-monthly-cost-db";
import { resyncOpenStocktakes } from "@/lib/stocktake-resync";

/**
 * Tính giá vốn bình quân cả tháng theo từng kho — xem lib/inventory-monthly-cost-db.ts.
 * GET trạng thái từng tháng · POST { action: "PREVIEW" | "APPLY", fromPeriod, toPeriod? }.
 * Chạy thử ai mở được Kho cũng xem được; ghi thật là việc của kế toán (quyền Duyệt ở Kho).
 */
const menuHref = "/inventory";

export async function GET(request: Request) {
  const auth = requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth.response;
  try {
    const status = await monthlyCostStatus();
    return NextResponse.json({ periods: status.periods, earliestPending: status.earliestPending });
  } catch (error) {
    console.error("Error loading monthly cost status:", error);
    return NextResponse.json({ error: "Không tải được trạng thái tính giá vốn tháng" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || "PREVIEW").toUpperCase();
  const auth = action === "APPLY" ? requireMenuAction(request, menuHref, "approve") : requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth.response;
  const fromPeriod = typeof body.fromPeriod === "string" && body.fromPeriod ? body.fromPeriod : null;
  const toPeriod = typeof body.toPeriod === "string" && body.toPeriod ? body.toPeriod : null;
  try {
    if (action === "APPLY") {
      // Chênh lệch kiểm kê chưa chốt đi theo sổ mới nhất trước khi tính giá tháng (khách 21/10/2026).
      await resyncOpenStocktakes({}, auth.session.name).catch((error) => console.error("Đồng bộ chênh lệch kiểm kê lỗi:", error));
      const outcome = await applyMonthlyCost(fromPeriod, auth.session.name, toPeriod);
      await writeAuditLog({
        session: auth.session, module: menuHref, action: "RUN_MONTHLY_COST", entityType: "InventoryCostingRun", entityId: outcome.runId,
        entityCode: `${outcome.report.fromPeriod}..${outcome.report.toPeriod}`,
        metadata: { changedLines: outcome.report.changedLines, cogs: outcome.report.cogs, reposted: outcome.reposted },
      });
      const status = await monthlyCostStatus();
      return NextResponse.json({ report: outcome.report, reposted: outcome.reposted, periods: status.periods, earliestPending: status.earliestPending });
    }
    const preview = await previewMonthlyCost(fromPeriod, toPeriod);
    return NextResponse.json({ report: preview.report, periods: preview.status });
  } catch (error) {
    if (error instanceof MonthlyCostError) return NextResponse.json({ error: error.message }, { status: 409 });
    console.error("Error running monthly cost:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Không tính được giá vốn tháng" }, { status: 500 });
  }
}
