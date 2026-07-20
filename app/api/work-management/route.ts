import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, normalizePeriod, toDate } from "@/lib/phase3";

const menuHref = "/work-management";
const statuses = ["TODO", "IN_PROGRESS", "WAITING_APPROVAL", "COMPLETED", "CANCELLED"];

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    const params = new URL(request.url).searchParams;
    const branchCode = requestedBranch(auth.session, cleanText(params.get("branchCode")) || "ALL");
    const status = cleanText(params.get("status"));
    const items = await prisma.workItem.findMany({
      where: { ...(branchCode === "ALL" ? {} : { branchCode }), ...(status && status !== "ALL" ? { status } : {}) },
      include: { histories: { orderBy: { createdAt: "desc" }, take: 5 } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    });
    const now = Date.now();
    const responseItems = items.map((item) => ({ ...item, isOverdue: !["COMPLETED", "CANCELLED"].includes(item.status) && item.dueDate.getTime() < now }));
    const summary = {
      total: items.length,
      completed: items.filter((item) => item.status === "COMPLETED").length,
      overdue: items.filter((item) => !["COMPLETED", "CANCELLED"].includes(item.status) && item.dueDate.getTime() < now).length,
      waitingApproval: items.filter((item) => item.status === "WAITING_APPROVAL").length,
    };
    return NextResponse.json({ items: responseItems, summary, branchCode });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const title = cleanText(body.title);
    const assigneeName = cleanText(body.assigneeName);
    const departmentCode = cleanText(body.departmentCode);
    const branchCode = cleanText(body.branchCode);
    if (!title || !assigneeName || !departmentCode || !branchCode) businessError("Công việc thiếu tiêu đề, người phụ trách, phòng ban hoặc chi nhánh");
    assertBranchAccess(auth.session, branchCode);
    const code = `CV-${new Date().getFullYear()}-${String(await prisma.workItem.count() + 1).padStart(4, "0")}`;
    const item = await prisma.workItem.create({
      data: {
        code,
        title,
        description: cleanText(body.description) || null,
        branchCode,
        departmentCode,
        assigneeId: cleanText(body.assigneeId) || null,
        assigneeName,
        period: normalizePeriod(body.period) || null,
        priority: cleanText(body.priority) || "MEDIUM",
        dueDate: toDate(body.dueDate),
        createdBy: auth.session.name,
        histories: { create: { action: "CREATED", toStatus: "TODO", actor: auth.session.name, note: cleanText(body.note) || null } },
      },
      include: { histories: true },
    });
    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action);
    const auth = requireMenuAction(request, menuHref, action === "APPROVE" ? "approve" : "edit");
    if (!auth.ok) return auth.response;
    const id = cleanText(body.id);
    const item = await prisma.workItem.findUnique({ where: { id } });
    if (!item) businessError("Không tìm thấy công việc");
    const allowedBranch = requestedBranch(auth.session, item.branchCode);
    if (allowedBranch !== "ALL" && allowedBranch !== item.branchCode) return NextResponse.json({ error: "Không được thao tác công việc ngoài cửa hàng được phân công" }, { status: 403 });
    let nextStatus = cleanText(body.status);
    if (action === "APPROVE") {
      if (item.status !== "WAITING_APPROVAL") businessError("Công việc chưa ở trạng thái chờ duyệt");
      nextStatus = "COMPLETED";
    }
    if (!statuses.includes(nextStatus)) businessError("Trạng thái công việc không hợp lệ");
    const updated = await prisma.workItem.update({
      where: { id },
      data: {
        status: nextStatus,
        completedAt: nextStatus === "COMPLETED" ? new Date() : null,
        ...(action === "APPROVE" ? { approvedBy: auth.session.name, approvedAt: new Date() } : {}),
        histories: { create: { action: action || "STATUS_CHANGED", fromStatus: item.status, toStatus: nextStatus, actor: auth.session.name, note: cleanText(body.note) || null } },
      },
      include: { histories: { orderBy: { createdAt: "desc" } } },
    });
    return NextResponse.json(updated);
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
