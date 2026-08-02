import { NextResponse } from "next/server";
import { getRequestSession } from "@/lib/api-auth";
import { appMenuItems, canAccessMenu, canPerformMenuAction } from "@/lib/auth-demo";
import {
  countTrash,
  listTrash,
  restoreRecord,
  softDeleteRecord,
  SoftDeleteError,
  TRASH_ENTITIES,
  trashEntity,
} from "@/lib/soft-delete";

/** Các loại thực thể mà phiên đăng nhập hiện tại được phép nhìn thấy. */
function visibleModels(session: Parameters<typeof canAccessMenu>[0]): string[] {
  return TRASH_ENTITIES.filter((entity) => {
    const menu = appMenuItems.find((item) => item.href === entity.module);
    // Thực thể không gắn với menu nào thì mặc định cho xem, quyền xử lý ở bước khôi phục.
    if (!menu) return true;
    return canAccessMenu(session, menu);
  }).map((entity) => entity.model);
}

export async function GET(request: Request) {
  try {
    const auth = getRequestSession(request);
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const allowed = visibleModels(auth.session);
    const requested = searchParams.get("models")?.split(",").filter(Boolean) || [];
    const models = requested.length ? requested.filter((model) => allowed.includes(model)) : allowed;

    if (searchParams.get("summary") === "1") {
      return NextResponse.json({ summary: await countTrash(models) });
    }

    const rows = await listTrash({
      models,
      branchCodes: auth.session.allowedBranches,
      keyword: searchParams.get("keyword") || undefined,
      limitPerModel: Number(searchParams.get("limit")) || 100,
    });

    return NextResponse.json({ rows, summary: await countTrash(models) });
  } catch (error) {
    console.error("Error listing trash:", error);
    return NextResponse.json({ error: "Không tải được thùng rác" }, { status: 500 });
  }
}

/**
 * Xoá mềm hoặc khôi phục một bản ghi bất kỳ.
 * body: { action: "DELETE" | "RESTORE", model: string, id: string, reason?: string }
 */
export async function POST(request: Request) {
  try {
    const auth = getRequestSession(request);
    if (!auth.ok) return auth.response;

    const body = await request.json();
    const { action, model, id, reason } = body as {
      action?: string;
      model?: string;
      id?: string;
      reason?: string;
    };

    if (!model || !id) {
      return NextResponse.json({ error: "Thiếu model hoặc id của bản ghi" }, { status: 400 });
    }

    const entity = trashEntity(model);
    if (!entity) {
      return NextResponse.json({ error: `Loại dữ liệu "${model}" không được hỗ trợ` }, { status: 400 });
    }

    const menu = appMenuItems.find((item) => item.href === entity.module);
    if (menu && !canAccessMenu(auth.session, menu)) {
      return NextResponse.json({ error: "Không có quyền truy cập module này" }, { status: 403 });
    }
    if (!canPerformMenuAction(auth.session, entity.module, "delete")) {
      return NextResponse.json(
        { error: `Không đủ quyền xoá/khôi phục dữ liệu ${entity.label.toLowerCase()}` },
        { status: 403 },
      );
    }

    const result =
      action === "RESTORE"
        ? await restoreRecord({ model, id, session: auth.session })
        : await softDeleteRecord({ model, id, session: auth.session, reason });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error processing trash action:", error);
    return NextResponse.json({ error: "Không thực hiện được thao tác" }, { status: 500 });
  }
}
