"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput, MonthInput } from "@/components/DateInput";
import { ModuleFrame } from "@/components/ModuleFrame";
import { resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { storeLabel, storeOptions } from "@/lib/branch-labels";
import { useModuleAuth } from "@/lib/use-module-auth";
import {
  localDate,
  priorityTone,
  statusTone,
  workPriorityLabels,
  workStatusLabels,
  workStatusOrder,
  type WorkItem,
  type WorkListData,
  type WorkPriority,
  type WorkStatus,
  type WorkView,
} from "@/lib/work-management-types";

const emptyData: WorkListData = {
  items: [],
  summary: { total: 0, completed: 0, inProgress: 0, overdue: 0, waitingApproval: 0 },
  branchCode: "ALL",
  departments: [],
  users: [],
};

const currentDate = new Date().toISOString().slice(0, 10);
const initialForm = {
  title: "",
  description: "",
  branchCode: "HCM",
  departmentCode: "ACCOUNTING",
  assigneeId: "",
  assigneeName: "",
  priority: "MEDIUM" as WorkPriority,
  period: currentDate.slice(0, 7),
  dueDate: currentDate,
  checklistText: "",
};

export default function WorkManagementPage() {
  const href = "/work-management";
  const router = useRouter();
  const { user, loading } = useModuleAuth(href);
  const [data, setData] = useState<WorkListData>(emptyData);
  const [view, setView] = useState<WorkView>("LIST");
  const [branchCode, setBranchCode] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [departmentCode, setDepartmentCode] = useState("ALL");
  const [assignee, setAssignee] = useState("ALL");
  const [priority, setPriority] = useState("ALL");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));

  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user.role, href, "edit") : false;
  const canApprove = user ? canPerformMenuAction(user.role, href, "approve") : false;

  useEffect(() => {
    if (!loading && user) {
      const timer = window.setTimeout(() => setBranchCode(resolveInitialBranchScope(user)), 0);
      return () => window.clearTimeout(timer);
    }
  }, [loading, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const loadData = useCallback(async () => {
    const params = new URLSearchParams({ branchCode, status, departmentCode, assignee, priority });
    if (search) params.set("search", search);
    const response = await fetch(`/api/work-management?${params.toString()}`);
    const payload = await response.json();
    if (response.ok) setData(payload as WorkListData);
    else setMessage(payload.error || "Không tải được danh sách công việc");
  }, [assignee, branchCode, departmentCode, priority, search, status]);

  useEffect(() => {
    if (!loading && user) {
      const timer = window.setTimeout(() => void loadData(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [loading, user, loadData]);

  async function send(body: object, success: string) {
    setBusy(true);
    const response = await fetch("/api/work-management", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    setBusy(false);
    setMessage(response.ok ? success : payload.error || "Không thực hiện được thao tác");
    if (response.ok) await loadData();
  }

  async function createWork() {
    setBusy(true);
    const response = await fetch("/api/work-management", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        checklist: form.checklistText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      }),
    });
    const payload = await response.json();
    setBusy(false);
    setMessage(response.ok ? "Đã tạo và phân công công việc." : payload.error || "Không tạo được công việc");
    if (response.ok) {
      setShowCreate(false);
      setForm(initialForm);
      await loadData();
      router.push(`/work-management/${payload.id}`);
    }
  }

  function chooseAssignee(userId: string) {
    const selected = data.users.find((item) => item.id === userId);
    setForm((current) => ({ ...current, assigneeId: userId, assigneeName: selected?.name || "" }));
  }

  function openCreateForm() {
    const allowed = user?.allowedBranches || ["ALL"];
    const targetBranch = branchCode !== "ALL"
      ? branchCode
      : allowed.includes("ALL")
        ? "HCM"
        : allowed[0] || "HCM";
    setForm((current) => ({ ...current, branchCode: targetBranch, assigneeId: "", assigneeName: "" }));
    setShowCreate(true);
  }

  if (loading) return <div className="grid h-screen place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame
      title="Quản lý công việc"
      subtitle="Theo dõi giao việc, tiến độ và phê duyệt"
      role={user?.role}
      branchCode={branchCode}
      onChangeBranch={setBranchCode}
    >
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Tổng công việc" value={data.summary.total} icon="assignment" />
        <Metric label="Đang làm" value={data.summary.inProgress} icon="pending_actions" tone="amber" />
        <Metric label="Chờ duyệt" value={data.summary.waitingApproval} icon="approval" tone="blue" />
        <Metric label="Hoàn thành" value={data.summary.completed} icon="check_circle" tone="green" />
        <Metric label="Quá hạn" value={data.summary.overdue} icon="warning" tone="red" />
      </div>

      {message && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
          <span>{message}</span>
          <button type="button" title="Đóng thông báo" onClick={() => setMessage("")}>
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}

      <section className="table-panel">
        <div className="border-b border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {([
                ["LIST", "view_list", "Danh sách"],
                ["KANBAN", "view_kanban", "Kanban"],
                ["CALENDAR", "calendar_month", "Lịch"],
              ] as const).map(([id, icon, label]) => (
                <button
                  key={id}
                  type="button"
                  title={label}
                  onClick={() => setView(id)}
                  className={`grid h-8 w-9 place-items-center rounded-md ${view === id ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                >
                  <span className="material-symbols-outlined text-lg">{icon}</span>
                </button>
              ))}
            </div>
            <div className="relative min-w-52 flex-1">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-lg text-slate-400">search</span>
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Tìm mã, tiêu đề, người phụ trách..."
                className="h-9 w-full rounded-lg border border-slate-200 pl-10 pr-3 text-sm outline-none focus:border-blue-500"
              />
            </div>
            {canCreate && (
              <button type="button" onClick={openCreateForm} className="primary-button min-h-9 py-1.5">
                <span className="material-symbols-outlined text-lg">add</span>
                Tạo công việc
              </button>
            )}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Filter value={status} onChange={setStatus}>
              <option value="ALL">Tất cả trạng thái</option>
              {workStatusOrder.map((item) => <option key={item} value={item}>{workStatusLabels[item]}</option>)}
            </Filter>
            <Filter value={departmentCode} onChange={setDepartmentCode}>
              <option value="ALL">Tất cả phòng ban</option>
              {data.departments.map((item) => <option key={`${item.code}-${item.branch}`} value={item.code}>{item.name}</option>)}
            </Filter>
            <Filter value={assignee} onChange={setAssignee}>
              <option value="ALL">Tất cả người phụ trách</option>
              {Array.from(new Set(data.users.map((item) => item.name))).map((name) => <option key={name} value={name}>{name}</option>)}
            </Filter>
            <Filter value={priority} onChange={setPriority}>
              <option value="ALL">Tất cả mức ưu tiên</option>
              {Object.entries(workPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </Filter>
          </div>
        </div>

        {view === "LIST" && <ListView items={data.items} onOpen={(id) => router.push(`/work-management/${id}`)} />}
        {view === "KANBAN" && (
          <KanbanView
            items={data.items}
            canEdit={canEdit}
            canApprove={canApprove}
            busy={busy}
            onOpen={(id) => router.push(`/work-management/${id}`)}
            onMove={(item, target) => {
              const action = target === "COMPLETED" ? "APPROVE" : "STATUS_CHANGE";
              void send({ id: item.id, action, status: target }, `Đã chuyển sang ${workStatusLabels[target].toLowerCase()}.`);
            }}
          />
        )}
        {view === "CALENDAR" && (
          <CalendarView items={data.items} month={calendarMonth} onMonth={setCalendarMonth} onOpen={(id) => router.push(`/work-management/${id}`)} />
        )}
      </section>

      {showCreate && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" onMouseDown={() => setShowCreate(false)}>
          <form
            onSubmit={(event) => { event.preventDefault(); void createWork(); }}
            onMouseDown={(event) => event.stopPropagation()}
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl"
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4">
              <div>
                <h2 className="font-bold">Tạo công việc</h2>
                <p className="mt-0.5 text-xs text-slate-500">Phân công rõ người, thời hạn và tiêu chí hoàn thành.</p>
              </div>
              <button type="button" className="icon-button" title="Đóng" onClick={() => setShowCreate(false)}>
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label="Tiêu đề *" className="sm:col-span-2">
                <input required className="control" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
              </Field>
              <Field label="Mô tả" className="sm:col-span-2">
                <textarea className="control min-h-20 resize-y" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
              </Field>
              <Field label="Cửa hàng *">
                <select required className="control" value={form.branchCode} onChange={(event) => setForm({ ...form, branchCode: event.target.value })}>
                  {storeOptions.filter((option) => user?.allowedBranches.includes("ALL") || user?.allowedBranches.includes(option.code)).map((option) => (
                    <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Phòng ban *">
                <select required className="control" value={form.departmentCode} onChange={(event) => setForm({ ...form, departmentCode: event.target.value })}>
                  <option value="">Chọn phòng ban</option>
                  {data.departments.map((item) => <option key={`${item.code}-${item.branch}`} value={item.code}>{item.name}</option>)}
                </select>
              </Field>
              <Field label="Người phụ trách *">
                <select required className="control" value={form.assigneeId} onChange={(event) => chooseAssignee(event.target.value)}>
                  <option value="">Chọn người phụ trách</option>
                  {data.users.filter((item) => item.branches.includes("ALL") || item.branches.includes(form.branchCode)).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Mức ưu tiên">
                <select className="control" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as WorkPriority })}>
                  {Object.entries(workPriorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Kỳ công việc">
                <MonthInput className="mt-1.5" value={form.period} onChange={(period) => setForm({ ...form, period })} ariaLabel="Kỳ công việc" />
              </Field>
              <Field label="Hạn hoàn thành *">
                <DateInput required className="mt-1.5" value={form.dueDate} onChange={(dueDate) => setForm({ ...form, dueDate })} ariaLabel="Hạn hoàn thành" />
              </Field>
              <Field label="Checklist (mỗi dòng một việc)" className="sm:col-span-2">
                <textarea
                  className="control min-h-24 resize-y"
                  placeholder={"Ví dụ:\nĐối chiếu chứng từ\nXác nhận số liệu\nGửi quản lý duyệt"}
                  value={form.checklistText}
                  onChange={(event) => setForm({ ...form, checklistText: event.target.value })}
                />
              </Field>
            </div>
            <div className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-3">
              <button type="button" className="secondary-button" onClick={() => setShowCreate(false)}>Hủy</button>
              <button disabled={busy} className="primary-button disabled:opacity-50">
                <span className="material-symbols-outlined text-lg">add_task</span>
                {busy ? "Đang tạo..." : "Tạo công việc"}
              </button>
            </div>
          </form>
        </div>
      )}
    </ModuleFrame>
  );
}

function ListView({ items, onOpen }: { items: WorkItem[]; onOpen: (id: string) => void }) {
  if (!items.length) return <Empty />;
  return (
    <div className="max-h-[calc(100vh-320px)] min-h-80 overflow-auto">
      <table className="w-full min-w-[980px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs uppercase text-slate-500">
          <tr>
            <th className="cell">Công việc</th>
            <th className="cell">Phụ trách</th>
            <th className="cell">Phòng ban</th>
            <th className="cell">Ưu tiên</th>
            <th className="cell">Tiến độ</th>
            <th className="cell">Hạn</th>
            <th className="cell">Trạng thái</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
            <tr key={item.id} onClick={() => onOpen(item.id)} className="cursor-pointer hover:bg-slate-50">
              <td className="cell max-w-80"><b className="text-slate-800">{item.title}</b><small>{item.code} · {storeLabel(item.branchCode)}</small></td>
              <td className="cell">{item.assigneeName}</td>
              <td className="cell">{item.departmentCode}</td>
              <td className="cell"><span className={`status ${priorityTone(item.priority)}`}>{workPriorityLabels[item.priority]}</span></td>
              <td className="cell"><Progress item={item} /></td>
              <td className={`cell whitespace-nowrap ${item.isOverdue ? "font-bold text-rose-600" : ""}`}>{localDate(item.dueDate)}</td>
              <td className="cell"><span className={`status border ${statusTone(item.status)}`}>{workStatusLabels[item.status]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KanbanView({
  items,
  canEdit,
  canApprove,
  busy,
  onOpen,
  onMove,
}: {
  items: WorkItem[];
  canEdit: boolean;
  canApprove: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onMove: (item: WorkItem, target: WorkStatus) => void;
}) {
  const [dragId, setDragId] = useState("");
  return (
    <div className="overflow-x-auto bg-slate-50 p-3">
      <div className="grid min-w-[1380px] grid-cols-5 gap-3">
        {workStatusOrder.map((column) => {
          const columnItems = items.filter((item) => item.status === column);
          const canDrop = column !== "COMPLETED" ? canEdit : canApprove;
          return (
            <section
              key={column}
              onDragOver={(event) => { if (canDrop) event.preventDefault(); }}
              onDrop={() => {
                const item = items.find((row) => row.id === dragId);
                if (item && item.status !== column && canDrop && !busy) onMove(item, column);
                setDragId("");
              }}
              className="min-h-[440px]"
            >
              <div className={`mb-2 flex items-center justify-between rounded-md border px-3 py-2 text-sm font-bold ${statusTone(column)}`}>
                <span>{workStatusLabels[column]}</span>
                <span>{columnItems.length}</span>
              </div>
              <div className="space-y-2">
                {columnItems.map((item) => (
                  <article
                    key={item.id}
                    draggable={canEdit || canApprove}
                    onDragStart={() => setDragId(item.id)}
                    onClick={() => onOpen(item.id)}
                    className="cursor-pointer rounded-md border border-slate-200 bg-white p-3 shadow-sm hover:border-blue-300"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <b className="line-clamp-2 text-sm">{item.title}</b>
                      <span className={`status shrink-0 ${priorityTone(item.priority)}`}>{workPriorityLabels[item.priority]}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{item.code} · {storeLabel(item.branchCode)}</p>
                    <div className="mt-3"><Progress item={item} /></div>
                    <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                      <span className="max-w-32 truncate">{item.assigneeName}</span>
                      <span className={item.isOverdue ? "font-bold text-rose-600" : ""}>{localDate(item.dueDate)}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CalendarView({ items, month, onMonth, onOpen }: { items: WorkItem[]; month: Date; onMonth: (date: Date) => void; onOpen: (id: string) => void }) {
  const days = useMemo(() => calendarDays(month), [month]);
  const grouped = useMemo(() => {
    const value = new Map<string, WorkItem[]>();
    items.forEach((item) => {
      const key = item.dueDate.slice(0, 10);
      value.set(key, [...(value.get(key) || []), item]);
    });
    return value;
  }, [items]);
  return (
    <div>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex gap-1">
          <button type="button" className="icon-button" title="Tháng trước" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><span className="material-symbols-outlined">chevron_left</span></button>
          <button type="button" className="secondary-button min-h-9 px-3 py-1.5" onClick={() => onMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Hôm nay</button>
          <button type="button" className="icon-button" title="Tháng sau" onClick={() => onMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><span className="material-symbols-outlined">chevron_right</span></button>
        </div>
        <b>Tháng {month.getMonth() + 1}/{month.getFullYear()}</b>
      </div>
      <div className="grid min-w-[760px] grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-bold text-slate-500">
        {["Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7", "CN"].map((day) => <div key={day} className="p-2">{day}</div>)}
      </div>
      <div className="grid min-w-[760px] grid-cols-7">
        {days.map((day) => {
          const key = dateKey(day);
          const dayItems = grouped.get(key) || [];
          const inMonth = day.getMonth() === month.getMonth();
          return (
            <div key={key} className={`min-h-28 border-b border-r border-slate-100 p-1.5 ${inMonth ? "bg-white" : "bg-slate-50 text-slate-400"}`}>
              <span className={`grid h-6 w-6 place-items-center rounded-full text-xs ${key === currentDate ? "bg-blue-600 font-bold text-white" : ""}`}>{day.getDate()}</span>
              <div className="mt-1 space-y-1">
                {dayItems.slice(0, 3).map((item) => (
                  <button key={item.id} type="button" onClick={() => onOpen(item.id)} className={`block w-full truncate rounded px-1.5 py-1 text-left text-[11px] font-semibold ${statusTone(item.status)}`} title={item.title}>
                    {item.title}
                  </button>
                ))}
                {dayItems.length > 3 && <span className="block px-1 text-[11px] text-slate-500">+{dayItems.length - 3} công việc</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function calendarDays(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function Progress({ item }: { item: WorkItem }) {
  const { done, total } = item.checklistProgress;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="min-w-28">
      <div className="mb-1 flex justify-between text-[11px] text-slate-500"><span>Checklist</span><span>{done}/{total}</span></div>
      <div className="h-1.5 overflow-hidden rounded bg-slate-100"><div className="h-full bg-blue-600" style={{ width: `${percent}%` }} /></div>
    </div>
  );
}

function Metric({ label, value, icon, tone = "slate" }: { label: string; value: number; icon: string; tone?: "slate" | "green" | "blue" | "amber" | "red" }) {
  const colors = {
    slate: "bg-slate-100 text-slate-600",
    green: "bg-emerald-50 text-emerald-600",
    blue: "bg-blue-50 text-blue-600",
    amber: "bg-amber-50 text-amber-600",
    red: "bg-rose-50 text-rose-600",
  };
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-200 bg-white p-3">
      <span className={`material-symbols-outlined grid h-9 w-9 shrink-0 place-items-center rounded-lg ${colors[tone]}`}>{icon}</span>
      <div className="min-w-0"><p className="truncate text-xs text-slate-500">{label}</p><p className="text-xl font-bold">{value}</p></div>
    </div>
  );
}

function Filter({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500">{children}</select>;
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block text-xs font-bold text-slate-600 ${className}`}>{label}{children}</label>;
}

function Empty() {
  return <div className="grid min-h-80 place-items-center p-8 text-center text-sm text-slate-400"><div><span className="material-symbols-outlined mb-2 text-4xl">task_alt</span><p>Chưa có công việc phù hợp bộ lọc.</p></div></div>;
}
