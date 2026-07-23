"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DateInput, MonthInput } from "@/components/DateInput";
import { ModuleFrame } from "@/components/ModuleFrame";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { storeLabel, storeOptions } from "@/lib/branch-labels";
import { useModuleAuth } from "@/lib/use-module-auth";
import {
  localDate,
  localDateTime,
  priorityTone,
  statusTone,
  workPriorityLabels,
  workStatusLabels,
  type WorkItem,
  type WorkListData,
  type WorkPriority,
} from "@/lib/work-management-types";

const maxAttachmentSize = 2_000_000;

export default function WorkDetailPage() {
  const href = "/work-management";
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user, loading } = useModuleAuth(href);
  const [item, setItem] = useState<WorkItem | null>(null);
  const [options, setOptions] = useState<Pick<WorkListData, "departments" | "users">>({ departments: [], users: [] });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [checklistTitle, setChecklistTitle] = useState("");
  const [comment, setComment] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState({
    title: "",
    description: "",
    branchCode: "",
    departmentCode: "",
    assigneeId: "",
    assigneeName: "",
    priority: "MEDIUM" as WorkPriority,
    period: "",
    dueDate: "",
  });

  const canEdit = user ? canPerformMenuAction(user.role, href, "edit") : false;
  const canApprove = user ? canPerformMenuAction(user.role, href, "approve") : false;

  const loadData = useCallback(async () => {
    const [detailResponse, listResponse] = await Promise.all([
      fetch(`/api/work-management?id=${params.id}`),
      fetch("/api/work-management?branchCode=ALL"),
    ]);
    const detailPayload = await detailResponse.json();
    const listPayload = await listResponse.json();
    if (!detailResponse.ok) {
      setMessage(detailPayload.error || "Không tải được công việc");
      return;
    }
    const detail = detailPayload as WorkItem;
    setItem(detail);
    setEditForm({
      title: detail.title,
      description: detail.description || "",
      branchCode: detail.branchCode,
      departmentCode: detail.departmentCode,
      assigneeId: detail.assigneeId || "",
      assigneeName: detail.assigneeName,
      priority: detail.priority,
      period: detail.period || "",
      dueDate: detail.dueDate.slice(0, 10),
    });
    if (listResponse.ok) {
      const list = listPayload as WorkListData;
      setOptions({ departments: list.departments, users: list.users });
    }
  }, [params.id]);

  useEffect(() => {
    if (!loading && user) {
      const timer = window.setTimeout(() => void loadData(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [loading, user, loadData]);

  async function patch(body: object, success: string) {
    if (!item) return false;
    setBusy(true);
    const response = await fetch("/api/work-management", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: item.id, ...body }),
    });
    const payload = await response.json();
    setBusy(false);
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) {
      setItem(payload as WorkItem);
      return true;
    }
    return false;
  }

  async function uploadFile(file: File | undefined) {
    if (!file) return;
    if (file.size > maxAttachmentSize) {
      setMessage("Tệp đính kèm tối đa 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      void patch({
        action: "ADD_ATTACHMENT",
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
        url: String(reader.result || ""),
      }, "Đã thêm tệp đính kèm.");
    };
    reader.onerror = () => setMessage("Không đọc được tệp đã chọn.");
    reader.readAsDataURL(file);
  }

  function chooseAssignee(userId: string) {
    const selected = options.users.find((row) => row.id === userId);
    setEditForm((current) => ({ ...current, assigneeId: userId, assigneeName: selected?.name || current.assigneeName }));
  }

  if (loading || !item) {
    return (
      <div className="grid h-screen place-items-center bg-slate-100 text-sm text-slate-500">
        {message || "Đang tải công việc..."}
      </div>
    );
  }

  const allChecklistDone = item.checklistProgress.total === item.checklistProgress.done;
  const linkedHref = sourceHref(item.linkedModule, item.linkedId);

  return (
    <ModuleFrame title={item.code} subtitle={item.title} role={user?.role}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={() => router.push("/work-management")} className="secondary-button min-h-9 py-1.5">
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Danh sách công việc
        </button>
        <div className="flex flex-wrap gap-2">
          {linkedHref && (
            <button type="button" className="secondary-button min-h-9 py-1.5" onClick={() => router.push(linkedHref)}>
              <span className="material-symbols-outlined text-lg">open_in_new</span>
              Mở chứng từ nguồn
            </button>
          )}
          {canEdit && item.status === "TODO" && (
            <button disabled={busy} className="primary-button min-h-9 py-1.5" onClick={() => void patch({ status: "IN_PROGRESS" }, "Đã bắt đầu công việc.")}>
              <span className="material-symbols-outlined text-lg">play_arrow</span>Bắt đầu
            </button>
          )}
          {canEdit && item.status === "IN_PROGRESS" && (
            <button
              disabled={busy || !allChecklistDone}
              title={!allChecklistDone ? "Hoàn tất checklist trước khi gửi duyệt" : "Gửi duyệt"}
              className="primary-button min-h-9 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void patch({ status: "WAITING_APPROVAL" }, "Đã gửi duyệt công việc.")}
            >
              <span className="material-symbols-outlined text-lg">send</span>Gửi duyệt
            </button>
          )}
          {canEdit && item.status === "WAITING_APPROVAL" && (
            <button disabled={busy} className="secondary-button min-h-9 py-1.5" onClick={() => void patch({ action: "RETURN", note: "Yêu cầu cập nhật lại" }, "Đã trả lại công việc.")}>
              <span className="material-symbols-outlined text-lg">undo</span>Trả lại
            </button>
          )}
          {canApprove && item.status === "WAITING_APPROVAL" && (
            <button disabled={busy} className="primary-button min-h-9 bg-emerald-600 py-1.5 hover:bg-emerald-700" onClick={() => void patch({ action: "APPROVE" }, "Đã duyệt hoàn thành.")}>
              <span className="material-symbols-outlined text-lg">verified</span>Duyệt
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
          <span>{message}</span>
          <button type="button" title="Đóng thông báo" onClick={() => setMessage("")}><span className="material-symbols-outlined text-lg">close</span></button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,0.7fr)]">
        <div className="space-y-4">
          <section className="table-panel">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-5">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold">{item.title}</h2>
                  <span className={`status border ${statusTone(item.status)}`}>{workStatusLabels[item.status]}</span>
                  <span className={`status ${priorityTone(item.priority)}`}>{workPriorityLabels[item.priority]}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{item.description || "Chưa có mô tả."}</p>
              </div>
              {canEdit && (
                <button type="button" className="icon-button shrink-0" title="Sửa thông tin" onClick={() => setEditing(true)}>
                  <span className="material-symbols-outlined text-lg">edit</span>
                </button>
              )}
            </div>
            <dl className="grid gap-px bg-slate-100 sm:grid-cols-2 lg:grid-cols-4">
              <Info label="Cửa hàng" value={storeLabel(item.branchCode)} />
              <Info label="Phòng ban" value={item.departmentCode} />
              <Info label="Người phụ trách" value={item.assigneeName} />
              <Info label="Hạn hoàn thành" value={localDate(item.dueDate)} warning={item.isOverdue} />
              <Info label="Kỳ công việc" value={item.period || "-"} />
              <Info label="Người tạo" value={item.createdBy || "-"} />
              <Info label="Chứng từ nguồn" value={item.linkedCode || "-"} />
              <Info label="Cập nhật gần nhất" value={localDateTime(item.updatedAt)} />
            </dl>
          </section>

          <section className="table-panel">
            <SectionTitle title="Checklist" subtitle={`${item.checklistProgress.done}/${item.checklistProgress.total} nội dung đã hoàn tất`} icon="checklist" />
            <div className="divide-y divide-slate-100">
              {!item.checklistItems.length && <p className="p-5 text-sm text-slate-400">Chưa có nội dung checklist.</p>}
              {item.checklistItems.map((row) => (
                <div key={row.id} className="flex items-center gap-3 px-5 py-3">
                  <input
                    type="checkbox"
                    checked={row.isDone}
                    disabled={!canEdit || busy || item.status === "COMPLETED"}
                    onChange={(event) => void patch({ action: "TOGGLE_CHECKLIST", checklistId: row.id, isDone: event.target.checked }, "Đã cập nhật checklist.")}
                    className="h-4 w-4 accent-blue-600"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${row.isDone ? "text-slate-400 line-through" : "text-slate-700"}`}>{row.title}</p>
                    {row.completedBy && <p className="mt-0.5 text-[11px] text-slate-400">{row.completedBy} · {localDateTime(row.completedAt)}</p>}
                  </div>
                  {canEdit && item.status !== "COMPLETED" && (
                    <button type="button" title="Xóa checklist" onClick={() => void patch({ action: "DELETE_CHECKLIST", checklistId: row.id }, "Đã xóa nội dung checklist.")} className="text-slate-400 hover:text-rose-600">
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canEdit && item.status !== "COMPLETED" && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void patch({ action: "ADD_CHECKLIST", title: checklistTitle }, "Đã thêm nội dung checklist.").then((ok) => { if (ok) setChecklistTitle(""); });
                }}
                className="flex gap-2 border-t border-slate-200 p-4"
              >
                <input required value={checklistTitle} onChange={(event) => setChecklistTitle(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-500" placeholder="Thêm nội dung cần hoàn thành..." />
                <button disabled={busy} className="primary-button min-h-9 px-3 py-1.5" title="Thêm checklist"><span className="material-symbols-outlined text-lg">add</span></button>
              </form>
            )}
          </section>

          <section className="table-panel">
            <SectionTitle title="Trao đổi" subtitle={`${item.comments.length} bình luận`} icon="forum" />
            {canEdit && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void patch({ action: "ADD_COMMENT", content: comment }, "Đã thêm trao đổi.").then((ok) => { if (ok) setComment(""); });
                }}
                className="flex gap-2 border-b border-slate-200 p-4"
              >
                <textarea required maxLength={4000} value={comment} onChange={(event) => setComment(event.target.value)} className="min-h-16 min-w-0 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500" placeholder="Nhập nội dung trao đổi..." />
                <button disabled={busy} className="primary-button self-end"><span className="material-symbols-outlined text-lg">send</span>Gửi</button>
              </form>
            )}
            <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {!item.comments.length && <p className="p-5 text-sm text-slate-400">Chưa có trao đổi.</p>}
              {item.comments.map((row) => (
                <article key={row.id} className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <b className="text-sm">{row.authorName}</b>
                    <time className="text-xs text-slate-400">{localDateTime(row.createdAt)}</time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{row.content}</p>
                </article>
              ))}
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="table-panel">
            <SectionTitle title="Tệp đính kèm" subtitle={`${item.attachments.length} tệp`} icon="attach_file" />
            {canEdit && (
              <div className="space-y-2 border-b border-slate-200 p-4">
                <label className="secondary-button w-full cursor-pointer">
                  <span className="material-symbols-outlined text-lg">upload_file</span>
                  Chọn tệp (tối đa 2 MB)
                  <input type="file" className="hidden" accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.csv,.xlsx,.xls" onChange={(event) => { void uploadFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                </label>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void patch({ action: "ADD_ATTACHMENT", fileName: attachmentUrl.split("/").pop() || "Liên kết", url: attachmentUrl }, "Đã thêm liên kết.").then((ok) => { if (ok) setAttachmentUrl(""); });
                  }}
                  className="flex gap-2"
                >
                  <input type="url" value={attachmentUrl} onChange={(event) => setAttachmentUrl(event.target.value)} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-blue-500" placeholder="Hoặc dán liên kết https://..." />
                  <button disabled={busy || !attachmentUrl} className="icon-button" title="Thêm liên kết"><span className="material-symbols-outlined text-lg">add_link</span></button>
                </form>
              </div>
            )}
            <div className="divide-y divide-slate-100">
              {!item.attachments.length && <p className="p-4 text-sm text-slate-400">Chưa có tệp đính kèm.</p>}
              {item.attachments.map((row) => (
                <div key={row.id} className="flex items-center gap-3 p-3">
                  <span className="material-symbols-outlined text-slate-400">draft</span>
                  <a href={row.url} target="_blank" rel="noreferrer" download={row.url.startsWith("data:") ? row.fileName : undefined} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-blue-700 hover:underline">{row.fileName}</p>
                    <p className="text-[11px] text-slate-400">{fileSizeLabel(row.fileSize)} · {row.uploadedBy || "-"}</p>
                  </a>
                  {canEdit && <button type="button" title="Xóa tệp" onClick={() => void patch({ action: "DELETE_ATTACHMENT", attachmentId: row.id }, "Đã xóa tệp đính kèm.")} className="text-slate-400 hover:text-rose-600"><span className="material-symbols-outlined text-lg">delete</span></button>}
                </div>
              ))}
            </div>
          </section>

          <section className="table-panel">
            <SectionTitle title="Lịch sử xử lý" subtitle={`${item.histories.length} thay đổi`} icon="history" />
            <div className="max-h-[520px] overflow-y-auto p-4">
              {!item.histories.length && <p className="text-sm text-slate-400">Chưa có lịch sử.</p>}
              <ol className="space-y-4 border-l border-slate-200 pl-4">
                {item.histories.map((row) => (
                  <li key={row.id} className="relative">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-blue-500" />
                    <div className="flex items-start justify-between gap-2">
                      <b className="text-xs">{historyLabel(row.action)}</b>
                      <time className="whitespace-nowrap text-[10px] text-slate-400">{localDateTime(row.createdAt)}</time>
                    </div>
                    {row.fromStatus && row.toStatus && row.fromStatus !== row.toStatus && (
                      <p className="mt-1 text-xs text-slate-500">{statusText(row.fromStatus)} → {statusText(row.toStatus)}</p>
                    )}
                    {row.note && <p className="mt-1 text-xs text-slate-600">{row.note}</p>}
                    <p className="mt-1 text-[10px] text-slate-400">{row.actor || "Hệ thống"}</p>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        </aside>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" onMouseDown={() => setEditing(false)}>
          <form
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              void patch({ action: "UPDATE_DETAILS", ...editForm }, "Đã cập nhật thông tin công việc.").then((ok) => { if (ok) setEditing(false); });
            }}
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h2 className="font-bold">Cập nhật công việc</h2>
              <button type="button" className="icon-button" title="Đóng" onClick={() => setEditing(false)}><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Tiêu đề *" className="sm:col-span-2"><input required className="control" value={editForm.title} onChange={(event) => setEditForm({ ...editForm, title: event.target.value })} /></Field>
              <Field label="Mô tả" className="sm:col-span-2"><textarea className="control min-h-20 resize-y" value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></Field>
              <Field label="Cửa hàng"><select className="control" value={editForm.branchCode} onChange={(event) => setEditForm({ ...editForm, branchCode: event.target.value })}>{storeOptions.map((row) => <option key={row.code} value={row.code}>{storeLabel(row.code)}</option>)}</select></Field>
              <Field label="Phòng ban"><select className="control" value={editForm.departmentCode} onChange={(event) => setEditForm({ ...editForm, departmentCode: event.target.value })}>{options.departments.map((row) => <option key={`${row.code}-${row.branch}`} value={row.code}>{row.name}</option>)}</select></Field>
              <Field label="Người phụ trách"><select className="control" value={editForm.assigneeId} onChange={(event) => chooseAssignee(event.target.value)}>{options.users.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
              <Field label="Mức ưu tiên"><select className="control" value={editForm.priority} onChange={(event) => setEditForm({ ...editForm, priority: event.target.value as WorkPriority })}>{Object.entries(workPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="Kỳ công việc"><MonthInput className="mt-1.5" value={editForm.period} onChange={(period) => setEditForm({ ...editForm, period })} ariaLabel="Kỳ công việc" /></Field>
              <Field label="Hạn hoàn thành"><DateInput className="mt-1.5" value={editForm.dueDate} onChange={(dueDate) => setEditForm({ ...editForm, dueDate })} ariaLabel="Hạn hoàn thành" /></Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
              <button type="button" className="secondary-button" onClick={() => setEditing(false)}>Hủy</button>
              <button disabled={busy} className="primary-button"><span className="material-symbols-outlined text-lg">save</span>Lưu thay đổi</button>
            </div>
          </form>
        </div>
      )}
    </ModuleFrame>
  );
}

function sourceHref(module: string | null, linkedId: string | null) {
  if (!module) return "";
  if (module.startsWith("ASSET_")) return "/assets/operations";
  if (module.startsWith("PROCUREMENT")) return "/procurement";
  if (module.startsWith("INVENTORY")) return "/inventory";
  if (module.startsWith("ACCOUNTING")) return "/accounting";
  return linkedId ? "" : "";
}

function historyLabel(action: string) {
  const labels: Record<string, string> = {
    CREATED: "Tạo công việc",
    UPDATED: "Cập nhật thông tin",
    STATUS_CHANGE: "Đổi trạng thái",
    APPROVE: "Duyệt hoàn thành",
    RETURN: "Trả lại",
    ADD_CHECKLIST: "Thêm checklist",
    TOGGLE_CHECKLIST: "Cập nhật checklist",
    DELETE_CHECKLIST: "Xóa checklist",
    ADD_COMMENT: "Thêm trao đổi",
    ADD_ATTACHMENT: "Thêm tệp",
    DELETE_ATTACHMENT: "Xóa tệp",
  };
  return labels[action] || action;
}

function statusText(status: string) {
  return workStatusLabels[status as keyof typeof workStatusLabels] || status;
}

function fileSizeLabel(value: number | null) {
  if (!value) return "Liên kết";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function Info({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className="bg-white p-4"><dt className="text-xs text-slate-500">{label}</dt><dd className={`mt-1 text-sm font-semibold ${warning ? "text-rose-600" : "text-slate-700"}`}>{value}</dd></div>;
}

function SectionTitle({ title, subtitle, icon }: { title: string; subtitle: string; icon: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-slate-200 p-4">
      <span className="material-symbols-outlined grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-600">{icon}</span>
      <div><h2 className="text-sm font-bold">{title}</h2><p className="text-xs text-slate-500">{subtitle}</p></div>
    </div>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block text-xs font-bold text-slate-600 ${className}`}>{label}{children}</label>;
}
