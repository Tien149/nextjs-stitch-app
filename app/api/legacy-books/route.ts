import { NextResponse } from "next/server";
import { Prisma } from "@prisma/custom-client";
import { requireMenuAccess, type ApiAuthResult } from "@/lib/api-auth";
import { allowedMenuTabs, canPerformMenuAction, type AppAction } from "@/lib/auth-demo";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { legacyBranchScope, saveLegacyBook } from "@/lib/legacy-books";
import { searchTerms } from "@/lib/legacy-books-search";

/**
 * API tab "Sổ sách kế toán trước 08/2026" (Báo cáo tài chính, khách 28/11/2026).
 * Quyền: mở được tab legacy-books của /reports; tải lên = Tạo mới, sửa thông tin = Sửa, xoá = Xoá.
 */
const menuHref = "/reports";
const TAB = "legacy-books";
const SEARCH_LIMIT = 200;
const SHEET_PAGE = 300;

export const maxDuration = 300;

function errorResponse(error: unknown) {
  const { message, status } = apiError(error);
  return NextResponse.json({ error: message }, { status });
}

function requireTab(request: Request, action?: AppAction): ApiAuthResult {
  const auth = requireMenuAccess(request, menuHref);
  if (!auth.ok) return auth;
  const tabs = allowedMenuTabs(auth.session, menuHref);
  if (tabs && !tabs.includes(TAB)) {
    return { ok: false, response: NextResponse.json({ error: "Bạn không có quyền xem Sổ sách kế toán trước 08/2026" }, { status: 403 }) };
  }
  if (action && !canPerformMenuAction(auth.session, menuHref, action)) {
    return { ok: false, response: NextResponse.json({ error: "Bạn không có quyền thao tác này" }, { status: 403 }) };
  }
  return auth;
}

function cleanBranch(value: unknown, allowed: string[] | null) {
  const code = (cleanText(value) || "ALL").toUpperCase();
  if (allowed && (code === "ALL" || !allowed.includes(code))) {
    businessError(`Bạn chỉ được lưu file của cửa hàng được phân công (${allowed.join(", ")}).`);
  }
  return code;
}

async function findFile(id: string, allowed: string[] | null) {
  const file = await prisma.legacyBookFile.findUnique({
    where: { id },
    select: { id: true, fileName: true, branchCode: true, periodLabel: true, note: true, sheetsJson: true, rowCount: true, fileSize: true, uploadedBy: true, createdAt: true },
  });
  if (!file || (allowed && !allowed.includes(file.branchCode))) businessError("Không tìm thấy file.");
  return file;
}

export async function GET(request: Request) {
  const auth = requireTab(request);
  if (!auth.ok) return auth.response;
  try {
    const params = new URL(request.url).searchParams;
    const view = cleanText(params.get("view")) || "files";
    const allowed = legacyBranchScope(auth.session.allowedBranches);

    if (view === "download") {
      const id = cleanText(params.get("fileId"));
      await findFile(id, allowed);
      const file = await prisma.legacyBookFile.findUnique({ where: { id }, select: { fileName: true, mimeType: true, content: true } });
      if (!file) businessError("Không tìm thấy file.");
      const ascii = file.fileName.normalize("NFD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "") || "so-sach.xlsx";
      return new Response(Buffer.from(file.content), {
        headers: {
          "Content-Type": file.mimeType || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
          "Cache-Control": "private, no-store",
        },
      });
    }

    if (view === "sheet") {
      const fileId = cleanText(params.get("fileId"));
      const file = await findFile(fileId, allowed);
      const sheetIndex = Math.max(0, Number(params.get("sheet")) || 0);
      const from = Math.max(1, Number(params.get("from")) || 1);
      const rows = await prisma.legacyBookRow.findMany({
        where: { fileId, sheetIndex, rowNo: { gte: from } },
        orderBy: { rowNo: "asc" },
        take: SHEET_PAGE + 1,
        select: { rowNo: true, cells: true },
      });
      const previous = await prisma.legacyBookRow.findMany({
        where: { fileId, sheetIndex, rowNo: { lt: from } },
        orderBy: { rowNo: "desc" },
        take: SHEET_PAGE,
        select: { rowNo: true },
      });
      return NextResponse.json({
        file,
        sheetIndex,
        rows: rows.slice(0, SHEET_PAGE),
        nextFrom: rows.length > SHEET_PAGE ? rows[SHEET_PAGE].rowNo : null,
        prevFrom: previous.length > 0 ? previous[previous.length - 1].rowNo : null,
      });
    }

    if (view === "search") {
      const terms = searchTerms(cleanText(params.get("q")));
      if (terms.length === 0) return NextResponse.json({ terms, results: [], hasMore: false });
      const branchCode = (cleanText(params.get("branchCode")) || "").toUpperCase();
      const periodLabel = cleanText(params.get("periodLabel"));
      const fileId = cleanText(params.get("fileId"));
      const conditions: Prisma.Sql[] = terms.map((term) => Prisma.sql`r."searchText" LIKE ${`%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}`);
      if (allowed) conditions.push(Prisma.sql`f."branchCode" IN (${Prisma.join(allowed)})`);
      if (branchCode && branchCode !== "*") conditions.push(Prisma.sql`f."branchCode" = ${branchCode}`);
      if (periodLabel) conditions.push(Prisma.sql`f."periodLabel" = ${periodLabel}`);
      if (fileId) conditions.push(Prisma.sql`f."id" = ${fileId}`);
      const results = await prisma.$queryRaw<Array<{ fileId: string; sheetIndex: number; sheetName: string; rowNo: number; cells: string[] }>>(Prisma.sql`
        SELECT r."fileId", r."sheetIndex", r."sheetName", r."rowNo", r."cells"
        FROM "LegacyBookRow" r JOIN "LegacyBookFile" f ON f."id" = r."fileId"
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY f."createdAt" DESC, r."fileId", r."sheetIndex", r."rowNo"
        LIMIT ${SEARCH_LIMIT + 1}
      `);
      return NextResponse.json({ terms, results: results.slice(0, SEARCH_LIMIT), hasMore: results.length > SEARCH_LIMIT });
    }

    const files = await prisma.legacyBookFile.findMany({
      where: allowed ? { branchCode: { in: allowed } } : {},
      orderBy: { createdAt: "desc" },
      select: { id: true, fileName: true, branchCode: true, periodLabel: true, note: true, sheetsJson: true, rowCount: true, fileSize: true, uploadedBy: true, createdAt: true },
    });
    return NextResponse.json({ files });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Tải một file lên (multipart: file, branchCode, periodLabel, note). Nhiều file thì trình duyệt gửi lần lượt. */
export async function POST(request: Request) {
  const auth = requireTab(request, "create");
  if (!auth.ok) return auth.response;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) businessError("Chưa chọn file.");
    if (!/\.(xlsx|xlsm|xls|csv)$/i.test(file.name)) businessError("Chỉ nhận file Excel (.xlsx, .xls, .xlsm) hoặc .csv.");
    const allowed = legacyBranchScope(auth.session.allowedBranches);
    const branchCode = cleanBranch(form.get("branchCode"), allowed);
    const periodLabel = cleanText(form.get("periodLabel")).slice(0, 60);
    const note = cleanText(form.get("note")).slice(0, 500);
    const saved = await saveLegacyBook({
      fileName: file.name.slice(0, 255),
      mimeType: file.type || null,
      buffer: Buffer.from(await file.arrayBuffer()),
      branchCode,
      periodLabel,
      note,
      uploadedBy: auth.session.name || auth.session.email || "",
    });
    await writeAuditLog({ session: auth.session, module: menuHref, action: "UPLOAD_LEGACY_BOOK", entityType: "LegacyBookFile", entityId: saved.id, entityCode: file.name, branchCode, metadata: { ...saved, periodLabel, fileSize: file.size } });
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Sửa thông tin file (cửa hàng, kỳ/năm, ghi chú) — không đổi nội dung. */
export async function PATCH(request: Request) {
  const auth = requireTab(request, "edit");
  if (!auth.ok) return auth.response;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const allowed = legacyBranchScope(auth.session.allowedBranches);
    const id = cleanText(body.id);
    await findFile(id, allowed);
    const data = {
      branchCode: cleanBranch(body.branchCode, allowed),
      periodLabel: cleanText(body.periodLabel).slice(0, 60),
      note: cleanText(body.note).slice(0, 500),
    };
    await prisma.legacyBookFile.update({ where: { id }, data });
    await writeAuditLog({ session: auth.session, module: menuHref, action: "UPDATE_LEGACY_BOOK", entityType: "LegacyBookFile", entityId: id, branchCode: data.branchCode, metadata: data });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Xoá hẳn file và mọi dòng của nó. */
export async function DELETE(request: Request) {
  const auth = requireTab(request, "delete");
  if (!auth.ok) return auth.response;
  try {
    const id = cleanText(new URL(request.url).searchParams.get("id"));
    const allowed = legacyBranchScope(auth.session.allowedBranches);
    const file = await findFile(id, allowed);
    await prisma.legacyBookFile.delete({ where: { id } });
    await writeAuditLog({ session: auth.session, module: menuHref, action: "DELETE_LEGACY_BOOK", entityType: "LegacyBookFile", entityId: id, entityCode: file.fileName, branchCode: file.branchCode, metadata: { rowCount: file.rowCount, periodLabel: file.periodLabel } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
