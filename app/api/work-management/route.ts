import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/custom-client";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { requestedBranch, assertBranchAccess } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { apiError, businessError, cleanText, normalizePeriod } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import type { DemoSession } from "@/lib/auth-demo";

const menuHref = "/work-management";
const statuses = ["TODO", "IN_PROGRESS", "WAITING_APPROVAL", "COMPLETED", "CANCELLED"];
const priorities = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const maxAttachmentSize = 2_000_000;

const detailInclude = {
  checklistItems: { orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }] },
  comments: { orderBy: { createdAt: "desc" as const } },
  attachments: { orderBy: { createdAt: "desc" as const } },
  histories: { orderBy: { createdAt: "desc" as const } },
};

function ensureBranchAccess(session: DemoSession, branchCode: string) {
  try {
    assertBranchAccess(session, branchCode);
  } catch (error) {
    businessError(error instanceof Error ? error.message : "Không có quyền với cửa hàng này");
  }
}

function endOfDay(value: string) {
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requiredDate(value: unknown, label: string) {
  const text = cleanText(value);
  if (!text) businessError(`${label} không được để trống`);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) businessError(`${label} không đúng định dạng ngày hợp lệ`);
  return date;
}

function itemView<T extends { dueDate: Date; status: string; checklistItems: Array<{ isDone: boolean }> }>(item: T) {
  const checklistDone = item.checklistItems.filter((row) => row.isDone).length;
  return {
    ...item,
    isOverdue: !["COMPLETED", "CANCELLED"].includes(item.status) && item.dueDate.getTime() < Date.now(),
    checklistProgress: {
      done: checklistDone,
      total: item.checklistItems.length,
    },
  };
}

function validAttachmentUrl(value: string) {
  if (/^https?:\/\//i.test(value)) return true;
  if (/^\/[^/]/.test(value)) return true;
  return /^data:(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain|text\/csv|application\/vnd\.ms-excel|application\/vnd\.openxmlformats-officedocument\.[^;]+);base64,/i.test(value);
}

async function loadDetail(id: string) {
  const item = await prisma.workItem.findUnique({ where: { id }, include: detailInclude });
  if (!item) businessError("Không tìm thấy công việc");
  return itemView(item);
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;

    const params = new URL(request.url).searchParams;
    const id = cleanText(params.get("id"));
    if (id) {
      const item = await loadDetail(id);
      ensureBranchAccess(auth.session, item.branchCode);
      return NextResponse.json(item);
    }

    const branchCode = requestedBranch(auth.session, cleanText(params.get("branchCode")) || "ALL");
    const status = cleanText(params.get("status"));
    const departmentCode = cleanText(params.get("departmentCode"));
    const assignee = cleanText(params.get("assignee"));
    const priority = cleanText(params.get("priority"));
    const search = cleanText(params.get("search"));
    const dueFrom = startOfDay(cleanText(params.get("dueFrom")));
    const dueTo = endOfDay(cleanText(params.get("dueTo")));

    const where: Prisma.WorkItemWhereInput = {
      ...(branchCode === "ALL" ? {} : { branchCode }),
      ...(status && status !== "ALL" ? { status } : {}),
      ...(departmentCode && departmentCode !== "ALL" ? { departmentCode } : {}),
      ...(priority && priority !== "ALL" ? { priority } : {}),
      ...(assignee && assignee !== "ALL" ? { assigneeName: assignee } : {}),
      ...(dueFrom || dueTo ? { dueDate: { ...(dueFrom ? { gte: dueFrom } : {}), ...(dueTo ? { lte: dueTo } : {}) } } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: "insensitive" } },
              { title: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
              { assigneeName: { contains: search, mode: "insensitive" } },
              { linkedCode: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [items, departments, users] = await Promise.all([
      prisma.workItem.findMany({
        where,
        include: {
          checklistItems: { orderBy: { position: "asc" } },
          attachments: { select: { id: true } },
          comments: { select: { id: true } },
          histories: { orderBy: { createdAt: "desc" }, take: 3 },
        },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      }),
      prisma.masterDataItem.findMany({
        where: {
          type: "DEPARTMENT",
          status: "ACTIVE",
          ...(branchCode === "ALL"
            ? {}
            : { OR: [{ branch: branchCode }, { branch: "ALL" }, { branch: null }] }),
        },
        select: { code: true, name: true, branch: true },
        orderBy: { name: "asc" },
      }),
      prisma.user.findMany({
        include: { branchAccesses: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const responseItems = items.map(itemView);
    const summary = {
      total: items.length,
      completed: items.filter((item) => item.status === "COMPLETED").length,
      inProgress: items.filter((item) => item.status === "IN_PROGRESS").length,
      overdue: responseItems.filter((item) => item.isOverdue).length,
      waitingApproval: items.filter((item) => item.status === "WAITING_APPROVAL").length,
    };

    return NextResponse.json({
      items: responseItems,
      summary,
      branchCode,
      departments,
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        branches: user.branchAccesses.map((access) => access.branchCode),
      })),
    });
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
    const priority = cleanText(body.priority) || "MEDIUM";
    const dueDate = requiredDate(body.dueDate, "Hạn hoàn thành");
    const checklist = Array.isArray(body.checklist)
      ? body.checklist.map(cleanText).filter(Boolean).slice(0, 100)
      : [];

    if (!title || !assigneeName || !departmentCode || !branchCode) {
      businessError("Công việc thiếu tiêu đề, người phụ trách, phòng ban hoặc cửa hàng");
    }
    if (!priorities.includes(priority)) businessError("Mức ưu tiên không hợp lệ");
    ensureBranchAccess(auth.session, branchCode);

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
        priority,
        dueDate,
        createdBy: auth.session.name,
        linkedModule: cleanText(body.linkedModule) || null,
        linkedId: cleanText(body.linkedId) || null,
        linkedCode: cleanText(body.linkedCode) || null,
        checklistItems: {
          create: checklist.map((checklistTitle: string, position: number) => ({
            title: checklistTitle,
            position,
          })),
        },
        histories: {
          create: {
            action: "CREATED",
            toStatus: "TODO",
            actor: auth.session.name,
            note: cleanText(body.note) || null,
          },
        },
      },
      include: detailInclude,
    });

    await writeAuditLog({
      session: auth.session,
      module: "WORK_MANAGEMENT",
      action: "CREATE_WORK_ITEM",
      entityType: "WorkItem",
      entityId: item.id,
      entityCode: item.code,
      branchCode,
      metadata: { departmentCode, assigneeName, dueDate, priority, checklist: checklist.length },
    });

    return NextResponse.json(itemView(item), { status: 201 });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const action = cleanText(body.action) || "STATUS_CHANGE";
    const auth = requireMenuAction(request, menuHref, action === "APPROVE" ? "approve" : "edit");
    if (!auth.ok) return auth.response;

    const id = cleanText(body.id);
    if (!id) businessError("Thiếu mã công việc");
    const item = await prisma.workItem.findUnique({
      where: { id },
      include: { checklistItems: true, attachments: true },
    });
    if (!item) businessError("Không tìm thấy công việc");
    ensureBranchAccess(auth.session, item.branchCode);

    if (action === "UPDATE_DETAILS") {
      const targetBranch = cleanText(body.branchCode) || item.branchCode;
      ensureBranchAccess(auth.session, targetBranch);
      const targetPriority = cleanText(body.priority) || item.priority;
      if (!priorities.includes(targetPriority)) businessError("Mức ưu tiên không hợp lệ");

      await prisma.workItem.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: cleanText(body.title) || item.title } : {}),
          ...(body.description !== undefined ? { description: cleanText(body.description) || null } : {}),
          ...(body.branchCode !== undefined ? { branchCode: targetBranch } : {}),
          ...(body.departmentCode !== undefined ? { departmentCode: cleanText(body.departmentCode) || item.departmentCode } : {}),
          ...(body.assigneeId !== undefined ? { assigneeId: cleanText(body.assigneeId) || null } : {}),
          ...(body.assigneeName !== undefined ? { assigneeName: cleanText(body.assigneeName) || item.assigneeName } : {}),
          ...(body.priority !== undefined ? { priority: targetPriority } : {}),
          ...(body.period !== undefined ? { period: normalizePeriod(body.period) || null } : {}),
          ...(body.dueDate !== undefined ? { dueDate: requiredDate(body.dueDate, "Hạn hoàn thành") } : {}),
          histories: {
            create: {
              action: "UPDATED",
              fromStatus: item.status,
              toStatus: item.status,
              actor: auth.session.name,
              note: cleanText(body.note) || "Cập nhật thông tin công việc",
            },
          },
        },
      });
    } else if (action === "ADD_CHECKLIST") {
      const title = cleanText(body.title);
      if (!title) businessError("Nội dung checklist không được để trống");
      const position = item.checklistItems.length
        ? Math.max(...item.checklistItems.map((row) => row.position)) + 1
        : 0;
      await prisma.workChecklistItem.create({ data: { workItemId: id, title, position } });
      await prisma.workItemHistory.create({
        data: { workItemId: id, action, actor: auth.session.name, note: title },
      });
    } else if (action === "TOGGLE_CHECKLIST") {
      const checklistId = cleanText(body.checklistId);
      const checklist = item.checklistItems.find((row) => row.id === checklistId);
      if (!checklist) businessError("Không tìm thấy dòng checklist");
      const isDone = Boolean(body.isDone);
      await prisma.workChecklistItem.update({
        where: { id: checklistId },
        data: {
          isDone,
          completedBy: isDone ? auth.session.name : null,
          completedAt: isDone ? new Date() : null,
        },
      });
      await prisma.workItemHistory.create({
        data: {
          workItemId: id,
          action,
          actor: auth.session.name,
          note: `${isDone ? "Hoàn tất" : "Mở lại"}: ${checklist.title}`,
        },
      });
    } else if (action === "DELETE_CHECKLIST") {
      const checklistId = cleanText(body.checklistId);
      const checklist = item.checklistItems.find((row) => row.id === checklistId);
      if (!checklist) businessError("Không tìm thấy dòng checklist");
      await prisma.workChecklistItem.delete({ where: { id: checklistId } });
      await prisma.workItemHistory.create({
        data: { workItemId: id, action, actor: auth.session.name, note: checklist.title },
      });
    } else if (action === "ADD_COMMENT") {
      const content = cleanText(body.content);
      if (!content) businessError("Nội dung trao đổi không được để trống");
      if (content.length > 4000) businessError("Nội dung trao đổi tối đa 4.000 ký tự");
      await prisma.workComment.create({
        data: {
          workItemId: id,
          content,
          authorId: auth.session.id,
          authorName: auth.session.name,
          authorRole: auth.session.role,
        },
      });
      await prisma.workItemHistory.create({
        data: { workItemId: id, action, actor: auth.session.name, note: "Đã thêm trao đổi" },
      });
    } else if (action === "ADD_ATTACHMENT") {
      const fileName = cleanText(body.fileName);
      const url = cleanText(body.url);
      const fileSize = Number(body.fileSize) || null;
      if (!fileName || !url) businessError("Tệp đính kèm thiếu tên hoặc dữ liệu");
      if (fileSize && fileSize > maxAttachmentSize) businessError("Tệp đính kèm tối đa 2 MB");
      if (url.length > 2_800_000) businessError("Dữ liệu tệp đính kèm vượt giới hạn");
      if (!validAttachmentUrl(url)) businessError("Định dạng hoặc đường dẫn tệp không được hỗ trợ");
      await prisma.workAttachment.create({
        data: {
          workItemId: id,
          fileName,
          mimeType: cleanText(body.mimeType) || null,
          fileSize,
          url,
          uploadedBy: auth.session.name,
        },
      });
      await prisma.workItemHistory.create({
        data: { workItemId: id, action, actor: auth.session.name, note: fileName },
      });
    } else if (action === "DELETE_ATTACHMENT") {
      const attachmentId = cleanText(body.attachmentId);
      const attachment = item.attachments.find((row) => row.id === attachmentId);
      if (!attachment) businessError("Không tìm thấy tệp đính kèm");
      await prisma.workAttachment.delete({ where: { id: attachmentId } });
      await prisma.workItemHistory.create({
        data: { workItemId: id, action, actor: auth.session.name, note: attachment.fileName },
      });
    } else {
      let nextStatus = cleanText(body.status);
      if (action === "APPROVE") {
        if (item.status !== "WAITING_APPROVAL") businessError("Công việc chưa ở trạng thái chờ duyệt");
        nextStatus = "COMPLETED";
      } else if (action === "RETURN") {
        if (item.status !== "WAITING_APPROVAL") businessError("Chỉ có thể trả lại công việc đang chờ duyệt");
        nextStatus = "IN_PROGRESS";
      }
      if (!statuses.includes(nextStatus)) businessError("Trạng thái công việc không hợp lệ");
      if (nextStatus === "WAITING_APPROVAL" && item.checklistItems.some((row) => !row.isDone)) {
        businessError("Cần hoàn tất toàn bộ checklist trước khi gửi duyệt");
      }

      await prisma.workItem.update({
        where: { id },
        data: {
          status: nextStatus,
          completedAt: nextStatus === "COMPLETED" ? new Date() : null,
          ...(action === "APPROVE"
            ? { approvedBy: auth.session.name, approvedAt: new Date() }
            : nextStatus !== "COMPLETED"
              ? { approvedBy: null, approvedAt: null }
              : {}),
          histories: {
            create: {
              action,
              fromStatus: item.status,
              toStatus: nextStatus,
              actor: auth.session.name,
              note: cleanText(body.note) || null,
            },
          },
        },
      });
    }

    const updated = await loadDetail(id);
    await writeAuditLog({
      session: auth.session,
      module: "WORK_MANAGEMENT",
      action,
      entityType: "WorkItem",
      entityId: updated.id,
      entityCode: updated.code,
      branchCode: updated.branchCode,
      metadata: { status: updated.status },
    });
    return NextResponse.json(updated);
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
