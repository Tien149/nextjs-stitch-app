export type WorkStatus = "TODO" | "IN_PROGRESS" | "WAITING_APPROVAL" | "COMPLETED" | "CANCELLED";
export type WorkPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type WorkView = "LIST" | "KANBAN" | "CALENDAR";

export type WorkChecklist = {
  id: string;
  title: string;
  position: number;
  isDone: boolean;
  completedBy: string | null;
  completedAt: string | null;
};

export type WorkComment = {
  id: string;
  content: string;
  authorName: string;
  authorRole: string | null;
  createdAt: string;
};

export type WorkAttachment = {
  id: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  url: string;
  uploadedBy: string | null;
  createdAt: string;
};

export type WorkHistory = {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string | null;
  actor: string | null;
  createdAt: string;
};

export type WorkItem = {
  id: string;
  code: string;
  title: string;
  description: string | null;
  branchCode: string;
  departmentCode: string;
  assigneeId: string | null;
  assigneeName: string;
  priority: WorkPriority;
  status: WorkStatus;
  period: string | null;
  dueDate: string;
  completedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string | null;
  linkedModule: string | null;
  linkedId: string | null;
  linkedCode: string | null;
  createdAt: string;
  updatedAt: string;
  isOverdue: boolean;
  checklistProgress: { done: number; total: number };
  checklistItems: WorkChecklist[];
  comments: WorkComment[];
  attachments: WorkAttachment[];
  histories: WorkHistory[];
};

export type WorkListData = {
  items: WorkItem[];
  summary: {
    total: number;
    completed: number;
    inProgress: number;
    overdue: number;
    waitingApproval: number;
  };
  branchCode: string;
  departments: Array<{ code: string; name: string; branch: string | null }>;
  users: Array<{ id: string; name: string; branches: string[] }>;
};

export const workStatusOrder: WorkStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "WAITING_APPROVAL",
  "COMPLETED",
  "CANCELLED",
];

export const workStatusLabels: Record<WorkStatus, string> = {
  TODO: "Chưa làm",
  IN_PROGRESS: "Đang làm",
  WAITING_APPROVAL: "Chờ duyệt",
  COMPLETED: "Hoàn thành",
  CANCELLED: "Đã hủy",
};

export const workPriorityLabels: Record<WorkPriority, string> = {
  LOW: "Thấp",
  MEDIUM: "Trung bình",
  HIGH: "Cao",
  URGENT: "Khẩn cấp",
};

export function statusTone(status: WorkStatus) {
  if (status === "COMPLETED") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "WAITING_APPROVAL") return "bg-blue-50 text-blue-700 border-blue-200";
  if (status === "IN_PROGRESS") return "bg-amber-50 text-amber-700 border-amber-200";
  if (status === "CANCELLED") return "bg-slate-100 text-slate-500 border-slate-200";
  return "bg-white text-slate-600 border-slate-200";
}

export function priorityTone(priority: WorkPriority) {
  if (priority === "URGENT") return "bg-rose-100 text-rose-700";
  if (priority === "HIGH") return "bg-orange-100 text-orange-700";
  if (priority === "MEDIUM") return "bg-blue-50 text-blue-700";
  return "bg-slate-100 text-slate-600";
}

export function localDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleDateString("vi-VN");
}

export function localDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString("vi-VN");
}
