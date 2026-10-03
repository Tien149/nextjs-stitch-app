"use client";

import { useEffect, useMemo, useState } from "react";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { SearchableSelect } from "@/components/SearchableSelect";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { defaultPurchaseUnit } from "@/lib/unit-conversion";
import { quantity as formatQuantity } from "@/lib/format-number";
import type { DemoSession } from "@/lib/auth-demo";
import { TEMPLATE_IMPORT_HEADERS, templateWindow, templateWindowStatus, type TemplateWindowStatus } from "@/lib/purchase-template";

export type TemplateUnitConversion = { id: string; unitCode: string; unitName: string | null; conversionRate: number; isDefaultPurchase: boolean };
export type TemplateItem = { id: string; code: string; name: string; unit: string; itemType: string; unitConversions?: TemplateUnitConversion[] };
export type TemplateLine = { id: string; itemId: string; unitCode: string | null; sortOrder: number; note: string | null; item: TemplateItem };
export type PurchaseTemplate = { id: string; code: string; name: string; branchCode: string | null; departmentCode: string | null; effectiveFrom?: string | null; effectiveTo?: string | null; status: string; note: string | null; createdBy?: string | null; updatedAt?: string; lines: TemplateLine[] };
export type DepartmentOption = { id: string; code: string; name: string; branch: string | null };

const today = () => new Date().toISOString().slice(0, 10);
/** Đọc file Excel (hoặc CSV UTF-8 — đọc dạng chữ, không thì tiếng Việt vỡ dấu). */
async function readWorkbook(file: File, cellDates = false) {
  const XLSX = await import("xlsx");
  return /\.csv$/i.test(file.name)
    ? XLSX.read(await file.text(), { type: "string", cellDates })
    : XLSX.read(await file.arrayBuffer(), { cellDates });
}

/** Ngày hôm nay giờ Việt Nam — so với ngày áp dụng / kết thúc của mẫu. */
const vnToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const dayText = (day: string | null) => (day ? day.split("-").reverse().join("/") : "");
const WINDOW_LABEL: Record<TemplateWindowStatus, string> = { ACTIVE: "Đang áp dụng", UPCOMING: "Chưa áp dụng", EXPIRED: "Đã kết thúc" };
const WINDOW_TONE: Record<TemplateWindowStatus, string> = { ACTIVE: "bg-emerald-50 text-emerald-700", UPCOMING: "bg-sky-50 text-sky-700", EXPIRED: "bg-slate-100 text-slate-500" };
type TemplateImportResult = {
  committed: boolean;
  groups: Array<{ code: string | null; name: string; branchCode: string | null; departmentCode: string | null; from: string | null; to: string | null; lineCount: number }>;
  errors: Array<{ row: number; message: string }>;
  errorCount: number;
  codes?: string[];
};

/**
 * Nháp form lưu trong sessionStorage: dev server reload (Fast Refresh), F5 hay điện thoại
 * rớt trang giữa chừng thì dữ liệu đang gõ không mất — mở lại tab là nháp tự khôi phục.
 */
const MANAGE_DRAFT_KEY = "procurement_template_manage_draft";
const FILL_DRAFT_KEY = "procurement_template_fill_draft";

function readDraft<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeDraft(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // sessionStorage bị chặn (chế độ riêng tư...) thì bỏ qua — form vẫn hoạt động bình thường.
  }
}

function clearDraft(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

type ManageDraft = {
  form: { name: string; branchCode: string; departmentCode: string; note: string; effectiveFrom?: string; effectiveTo?: string };
  rows: Array<{ itemId: string; unitCode: string; note?: string }>;
  editingId: string | null;
};

type FillDraft = {
  templateId: string;
  branch: string;
  department: string;
  neededDate: string;
  note: string;
  quantities: Record<string, string>;
};

/** ĐVT hiển thị của một dòng mẫu: ĐVT khai trên mẫu -> ĐVT mua mặc định -> ĐVT tồn kho. */
function lineUnit(line: { unitCode: string | null; item: TemplateItem }) {
  return defaultPurchaseUnit(line.item.unit, line.item.unitConversions, line.unitCode).unitLabel;
}

/**
 * Số lượng quy về ĐVT tồn kho — hiện ngay dưới ô nhập để người đặt thấy đúng thứ PR sẽ ghi
 * (chỉ hiện khi thực sự có quy đổi, ví dụ 2 thùng = 48 lon).
 */
function baseQuantityHint(line: { unitCode: string | null; item: TemplateItem }, quantity: string) {
  const { conversionRate } = defaultPurchaseUnit(line.item.unit, line.item.unitConversions, line.unitCode);
  const value = Number(quantity || 0);
  if (conversionRate === 1 || !(value > 0)) return "";
  return `= ${formatQuantity(value * conversionRate)} ${line.item.unit}`;
}

/**
 * Tab "Đặt theo mẫu": nhân viên nhà hàng mở mẫu set sẵn trên điện thoại, điền số lượng
 * vào dòng cần mua rồi gửi — hệ thống tạo PR nhiều dòng chờ duyệt. Bên dưới là khu
 * quản lý mẫu cho người có quyền (tạo/sửa/xoá mẫu: tên hàng + ĐVT, không có số lượng).
 */
export function TemplatesTab({
  user,
  canCreate,
  canEdit,
  items,
  templates,
  departments,
  notify,
  reload,
}: {
  user: DemoSession | null;
  canCreate: boolean;
  canEdit: boolean;
  items: TemplateItem[];
  templates: PurchaseTemplate[];
  departments: DepartmentOption[];
  notify: (message: string) => void;
  reload: () => Promise<void>;
}) {
  /** Mẫu đang mở để điền số lượng. */
  const [filling, setFilling] = useState<PurchaseTemplate | null>(null);
  const [fillBranch, setFillBranch] = useState("");
  const [fillDepartment, setFillDepartment] = useState("");
  const [fillNeededDate, setFillNeededDate] = useState(today());
  const [fillNote, setFillNote] = useState("");
  const [fillQuantities, setFillQuantities] = useState<Record<string, string>>({});
  const [fillSearch, setFillSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  /** Khu quản lý mẫu. */
  const [showManage, setShowManage] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<PurchaseTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState({ name: "", branchCode: "", departmentCode: "", note: "", effectiveFrom: "", effectiveTo: "" });
  const [templateRows, setTemplateRows] = useState<Array<{ itemId: string; unitCode: string; note?: string }>>([{ itemId: "", unitCode: "" }]);
  /** Danh sách mẫu: lọc + mẫu đang xem chi tiết (khách yêu cầu 03/10/2026 — rất nhiều mẫu). */
  const [listFilter, setListFilter] = useState({ search: "", branch: "ALL", status: "ACTIVE" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importState, setImportState] = useState<{ fileName: string; rows: Array<Record<string, unknown>>; result: TemplateImportResult | null; busy: boolean } | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PurchaseTemplate | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Đã khôi phục nháp xong chưa — chưa xong thì không ghi đè nháp bằng state rỗng ban đầu. */
  const [draftRestored, setDraftRestored] = useState(false);

  // Khôi phục nháp sau khi mount (chỉ chạy phía client để không lệch hydration).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const manage = readDraft<ManageDraft>(MANAGE_DRAFT_KEY);
      if (manage) {
        setTemplateForm({ effectiveFrom: "", effectiveTo: "", ...manage.form });
        setTemplateRows(manage.rows.length > 0 ? manage.rows : [{ itemId: "", unitCode: "" }]);
        setShowManage(true);
      }
      const fill = readDraft<FillDraft>(FILL_DRAFT_KEY);
      if (fill) {
        setFillBranch(fill.branch);
        setFillDepartment(fill.department);
        setFillNeededDate(fill.neededDate);
        setFillNote(fill.note);
        setFillQuantities(fill.quantities);
      }
      setDraftRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Danh sách mẫu về sau (loadData bất đồng bộ) -> gắn lại mẫu đang sửa / đang điền theo nháp.
  useEffect(() => {
    if (!draftRestored || templates.length === 0) return;
    const timer = window.setTimeout(() => {
      const manage = readDraft<ManageDraft>(MANAGE_DRAFT_KEY);
      if (manage?.editingId) {
        const template = templates.find((candidate) => candidate.id === manage.editingId);
        if (template) setEditingTemplate((current) => current || template);
      }
      const fill = readDraft<FillDraft>(FILL_DRAFT_KEY);
      if (fill) {
        const template = templates.find((candidate) => candidate.id === fill.templateId);
        if (template) setFilling((current) => current || template);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftRestored, templates]);

  // Tự lưu nháp form quản lý mẫu mỗi khi gõ.
  useEffect(() => {
    if (!draftRestored || !showManage) return;
    const hasContent = Boolean(
      templateForm.name || templateForm.note || templateForm.branchCode || templateForm.departmentCode ||
      templateRows.some((row) => row.itemId) || editingTemplate,
    );
    if (hasContent) {
      writeDraft(MANAGE_DRAFT_KEY, { form: templateForm, rows: templateRows, editingId: editingTemplate?.id || null } satisfies ManageDraft);
    } else {
      clearDraft(MANAGE_DRAFT_KEY);
    }
  }, [draftRestored, showManage, templateForm, templateRows, editingTemplate]);

  // Tự lưu nháp màn điền mẫu (số lượng đang gõ trên điện thoại).
  useEffect(() => {
    if (!draftRestored || !filling) return;
    writeDraft(FILL_DRAFT_KEY, {
      templateId: filling.id,
      branch: fillBranch,
      department: fillDepartment,
      neededDate: fillNeededDate,
      note: fillNote,
      quantities: fillQuantities,
    } satisfies FillDraft);
  }, [draftRestored, filling, fillBranch, fillDepartment, fillNeededDate, fillNote, fillQuantities]);

  const branchOptions = visibleStoreOptions(user);
  const itemOptions = useMemo(
    () => items.map((item) => ({ value: item.id, label: `${item.name} (${item.code})`, subLabel: item.unit })),
    [items],
  );

  const departmentsForBranch = (branchCode: string) =>
    departments.filter((item) => !item.branch || item.branch === "ALL" || item.branch === branchCode);

  const startFilling = (template: PurchaseTemplate) => {
    const branchCode = template.branchCode || branchOptions[0]?.code || "HCM";
    setFilling(template);
    setFillBranch(branchCode);
    setFillDepartment(template.departmentCode || departmentsForBranch(branchCode)[0]?.code || "");
    setFillNeededDate(today());
    setFillNote("");
    setFillQuantities({});
    setFillSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const filledCount = filling
    ? filling.lines.filter((line) => Number(fillQuantities[line.id] || 0) > 0).length
    : 0;

  const visibleFillLines = filling
    ? filling.lines.filter((line) => {
        const keyword = fillSearch.trim().toLowerCase();
        if (!keyword) return true;
        return line.item.name.toLowerCase().includes(keyword) || line.item.code.toLowerCase().includes(keyword);
      })
    : [];

  const submitFill = async () => {
    if (!filling) return;
    const lines = filling.lines
      .map((line) => ({ lineId: line.id, quantity: Number(fillQuantities[line.id] || 0) }))
      .filter((line) => line.quantity > 0);
    if (lines.length === 0) {
      notify("Chưa điền số lượng cho dòng nào — nhập số lượng vào các mặt hàng cần đặt rồi gửi.");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch("/api/procurement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_REQUEST_FROM_TEMPLATE",
          templateId: filling.id,
          branchCode: fillBranch,
          departmentCode: fillDepartment,
          neededDate: fillNeededDate,
          note: fillNote,
          lines,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify(payload.error || "Không gửi được yêu cầu mua hàng");
        return;
      }
      notify(`Đã gửi yêu cầu ${payload.code} (${lines.length} mặt hàng) — mua hàng có thể so sánh giá và đặt hàng ngay.`);
      setFilling(null);
      clearDraft(FILL_DRAFT_KEY);
      await reload();
    } finally {
      setSubmitting(false);
    }
  };

  const resetTemplateForm = () => {
    setEditingTemplate(null);
    setTemplateForm({ name: "", branchCode: "", departmentCode: "", note: "", effectiveFrom: "", effectiveTo: "" });
    setTemplateRows([{ itemId: "", unitCode: "" }]);
    clearDraft(MANAGE_DRAFT_KEY);
  };

  const startEditTemplate = (template: PurchaseTemplate) => {
    setShowManage(true);
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      branchCode: template.branchCode || "",
      departmentCode: template.departmentCode || "",
      note: template.note || "",
      effectiveFrom: templateWindow(template).from || "",
      effectiveTo: templateWindow(template).to || "",
    });
    setTemplateRows(template.lines.map((line) => ({ itemId: line.itemId, unitCode: line.unitCode || "", note: line.note || "" })));
    window.setTimeout(() => document.getElementById("template-manage")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  const submitTemplate = async (event: React.FormEvent) => {
    event.preventDefault();
    const lines = templateRows.filter((row) => row.itemId).map((row) => ({ itemId: row.itemId, unitCode: row.unitCode || undefined, note: row.note || undefined }));
    if (templateForm.effectiveFrom && templateForm.effectiveTo && templateForm.effectiveTo < templateForm.effectiveFrom) {
      notify("Ngày kết thúc phải sau Ngày áp dụng.");
      return;
    }
    if (lines.length === 0) {
      notify("Mẫu cần ít nhất một mặt hàng.");
      return;
    }
    setSavingTemplate(true);
    try {
      const response = await fetch("/api/procurement", {
        method: editingTemplate ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: editingTemplate ? "UPDATE_TEMPLATE" : "CREATE_TEMPLATE",
          ...(editingTemplate ? { templateId: editingTemplate.id } : {}),
          name: templateForm.name,
          branchCode: templateForm.branchCode,
          departmentCode: templateForm.departmentCode,
          effectiveFrom: templateForm.effectiveFrom,
          effectiveTo: templateForm.effectiveTo,
          note: templateForm.note,
          lines,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        notify(payload.error || "Không lưu được mẫu");
        return;
      }
      notify(editingTemplate ? `Đã lưu mẫu ${payload.code}.` : `Đã tạo mẫu ${payload.code} — bộ phận vào tab này điền số lượng để đặt hàng.`);
      resetTemplateForm();
      await reload();
    } finally {
      setSavingTemplate(false);
    }
  };

  const confirmDeleteTemplate = async (reason: string) => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ type: "TEMPLATE", id: deleteTarget.id });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/procurement?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được mẫu");
        return;
      }
      if (editingTemplate?.id === deleteTarget.id) resetTemplateForm();
      if (filling?.id === deleteTarget.id) setFilling(null);
      setDeleteTarget(null);
      notify(`Đã chuyển mẫu ${deleteTarget.code} vào Thùng rác.`);
      await reload();
    } finally {
      setDeleting(false);
    }
  };

  // ───────────── Import mẫu từ Excel (khách yêu cầu 03/10/2026) ─────────────
  const departmentName = (code: string | null) => (code ? departments.find((item) => item.code === code)?.name || code : "");

  const downloadImportSample = async () => {
    const XLSX = await import("xlsx");
    const sample = items.slice(0, 3);
    const rows = [
      [...TEMPLATE_IMPORT_HEADERS],
      ...sample.map((item, index) => [index === 0 ? "" : "", "Mẫu đặt hàng Bếp", branchOptions[0]?.code || "", departments[0]?.code || "", index === 0 ? "" : "", "", item.code, item.name, item.unitConversions?.find((unit) => unit.isDefaultPurchase)?.unitCode || item.unit, ""]),
    ];
    const guide = [
      ["Cột", "Cách ghi"],
      ["Mã mẫu", "Để trống = mẫu mới (trùng Tên mẫu + Cửa hàng với mẫu đang có thì ghi đè mẫu đó). Ghi mã MAU-xxxx = thay toàn bộ dòng hàng của mẫu đó."],
      ["Tên mẫu", "Mỗi mẫu là nhiều dòng cùng Tên mẫu (một dòng một mặt hàng). Cửa hàng / Bộ phận / Ngày chỉ cần ghi ở dòng đầu của mẫu."],
      ["Cửa hàng", "Mã cửa hàng; để trống = dùng chung mọi cửa hàng (cần quyền tất cả cửa hàng)."],
      ["Bộ phận", "Mã bộ phận mặc định khi đặt (không bắt buộc)."],
      ["Ngày áp dụng / Ngày kết thúc", "dd/mm/yyyy — để trống là không giới hạn đầu đó. Ngoài khoảng này mẫu không dùng để đặt hàng được. Chỉ cần ghi ở một dòng của mẫu."],
      ["Mã hàng / Tên hàng", "Mã hàng bắt buộc; Tên hàng chỉ để tham khảo."],
      ["ĐVT", "ĐVT đặt hàng (THÙNG, KG...) đã khai quy đổi; để trống = ĐVT mua mặc định."],
      ["Ghi chú", "Ghi chú của dòng (hiện cho người đặt)."],
    ];
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [12, 28, 10, 12, 14, 14, 16, 34, 10, 24].map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(workbook, sheet, "Mau dat hang");
    const guideSheet = XLSX.utils.aoa_to_sheet(guide);
    guideSheet["!cols"] = [{ wch: 28 }, { wch: 120 }];
    XLSX.utils.book_append_sheet(workbook, guideSheet, "Huong dan");
    XLSX.writeFile(workbook, "mau_import_mau_dat_hang.xlsx");
  };

  /** Đọc sheet đầu của file Excel thành mảng dòng; ngày đổi về chuỗi YYYY-MM-DD theo giờ máy. */
  const readSheetRows = async (file: File) => {
    const XLSX = await import("xlsx");
    const workbook = await readWorkbook(file, true);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: true });
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : value])));
  };

  const runTemplateImport = async (rows: Array<Record<string, unknown>>, commit: boolean): Promise<TemplateImportResult> => {
    const response = await fetch("/api/procurement", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "IMPORT_TEMPLATES", rows, commit }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { committed: false, groups: [], errors: [{ row: 0, message: payload.error || "Không import được file." }], errorCount: 1 };
    return payload as TemplateImportResult;
  };
  const pickImportFile = async (file: File) => {
    setImportState({ fileName: file.name, rows: [], result: null, busy: true });
    const rows = await readSheetRows(file);
    const result = await runTemplateImport(rows, false);
    setImportState({ fileName: file.name, rows, result, busy: false });
  };
  const commitImport = async () => {
    if (!importState) return;
    setImportState({ ...importState, busy: true });
    const result = await runTemplateImport(importState.rows, true);
    if (result.committed) {
      notify(`Đã import ${result.groups.length} mẫu: ${(result.codes || []).join(", ")}.`);
      setImportState(null);
      await reload();
    } else {
      setImportState({ ...importState, result, busy: false });
    }
  };

  /** Xuất chi tiết một mẫu ra Excel (cũng là file để điền số lượng rồi import lại khi đặt hàng). */
  const exportTemplate = async (template: PurchaseTemplate, withQuantities = false) => {
    const XLSX = await import("xlsx");
    const window = templateWindow(template);
    const aoa: Array<Array<string | number>> = [
      [`${template.code} — ${template.name}`],
      [`${template.branchCode ? storeLabel(template.branchCode) : "Dùng chung mọi cửa hàng"}${template.departmentCode ? ` · ${departmentName(template.departmentCode)}` : ""} · Áp dụng ${window.from ? `từ ${dayText(window.from)}` : "không giới hạn"}${window.to ? ` đến ${dayText(window.to)}` : ""}`],
      ["STT", "Mã hàng", "Tên hàng", "ĐVT", "Số lượng", "Ghi chú"],
      ...template.lines.map((line, index) => [index + 1, line.item.code, line.item.name, lineUnit(line), withQuantities ? Number(fillQuantities[line.id] || 0) || "" : "", line.note || ""]),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } }];
    sheet["!cols"] = [6, 16, 36, 10, 12, 30].map((wch) => ({ wch }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Dat hang");
    XLSX.writeFile(workbook, `${template.code}_${withQuantities ? "dat_hang" : "chi_tiet"}.xlsx`);
  };

  /**
   * Đặt hàng theo mẫu bằng file: tải file của mẫu, điền cột Số lượng rồi import lại — số lượng
   * điền vào đúng dòng theo Mã hàng, người đặt xem lại rồi bấm Gửi như bình thường.
   */
  const importQuantities = async (file: File) => {
    if (!filling) return;
    const XLSX = await import("xlsx");
    const workbook = await readWorkbook(file);
    const grid = XLSX.utils.sheet_to_json<Array<unknown>>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "" });
    const fold = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase().replace(/[^a-z0-9]/g, "");
    const headerIndex = grid.findIndex((row) => row.some((cell) => fold(cell) === "mahang") && row.some((cell) => fold(cell) === "soluong"));
    if (headerIndex < 0) {
      notify("File cần có cột Mã hàng và Số lượng — dùng nút Tải file đặt hàng để lấy đúng mẫu.");
      return;
    }
    const header = grid[headerIndex].map(fold);
    const codeColumn = header.indexOf("mahang");
    const quantityColumn = header.indexOf("soluong");
    const lineByCode = new Map(filling.lines.map((line) => [line.item.code.toUpperCase(), line]));
    const next: Record<string, string> = {};
    const unknown: string[] = [];
    for (const row of grid.slice(headerIndex + 1)) {
      const code = String(row[codeColumn] ?? "").trim().toUpperCase();
      const quantity = Number(String(row[quantityColumn] ?? "").replace(",", "."));
      if (!code || !(quantity > 0)) continue;
      const line = lineByCode.get(code);
      if (!line) { unknown.push(code); continue; }
      next[line.id] = String(quantity);
    }
    setFillQuantities(next);
    notify(`Đã điền số lượng ${Object.keys(next).length} dòng từ file${unknown.length ? ` · bỏ qua ${unknown.length} mã không có trong mẫu: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}` : ""}. Kiểm tra lại rồi bấm Gửi.`);
  };

  /** Các ĐVT chọn được cho một mặt hàng trên mẫu: mặc định (ĐVT mua) + từng quy đổi. */
  const unitOptionsForItem = (itemId: string) => {
    const item = items.find((candidate) => candidate.id === itemId);
    const conversions = item?.unitConversions || [];
    const defaultUnit = conversions.find((unit) => unit.isDefaultPurchase);
    return {
      defaultLabel: `Mặc định: ${defaultUnit?.unitName || defaultUnit?.unitCode || item?.unit || "ĐVT tồn kho"}`,
      conversions,
    };
  };

  // ───────────────────────── Màn điền mẫu ─────────────────────────
  if (filling) {
    return (
      <div className="max-w-6xl mx-auto">
        <div className="bg-white border border-slate-200 rounded-lg shadow-sm">
          <div className="p-4 sm:p-5 border-b border-slate-100 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-bold text-slate-800 leading-snug">{filling.name}</h2>
              <p className="text-xs text-slate-500 mt-0.5">{filling.code} · {filling.lines.length} mặt hàng — chỉ điền số lượng vào dòng cần đặt</p>
            </div>
            <button type="button" onClick={() => { setFilling(null); clearDraft(FILL_DRAFT_KEY); }} className="icon-button shrink-0" title="Quay lại danh sách mẫu">
              <span className="material-symbols-outlined text-lg">arrow_back</span>
            </button>
          </div>

          <div className="p-4 sm:p-5 grid grid-cols-2 lg:grid-cols-4 gap-3 border-b border-slate-100">
            <label className="block text-xs font-bold text-slate-600">Cửa hàng
              <select
                className="control"
                value={fillBranch}
                disabled={Boolean(filling.branchCode)}
                onChange={(e) => {
                  const branchCode = e.target.value;
                  setFillBranch(branchCode);
                  setFillDepartment(filling.departmentCode || departmentsForBranch(branchCode)[0]?.code || "");
                }}
              >
                {branchOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-600">Bộ phận đặt
              <select className="control" value={fillDepartment} onChange={(e) => setFillDepartment(e.target.value)}>
                {departmentsForBranch(fillBranch).map((item) => <option key={item.id} value={item.code}>{item.name}</option>)}
              </select>
            </label>
            <label className="block text-xs font-bold text-slate-600">Ngày cần hàng
              <DateInput value={fillNeededDate} onChange={setFillNeededDate} className="control" ariaLabel="Ngày cần hàng" />
            </label>
            <label className="block text-xs font-bold text-slate-600">Ghi chú
              <input className="control" value={fillNote} onChange={(e) => setFillNote(e.target.value)} placeholder="Không bắt buộc" />
            </label>
          </div>

          <div className="p-4 sm:p-5 pb-2 flex flex-wrap items-center gap-2">
            <input
              type="search"
              className="control !mt-0 flex-1 min-w-[220px]"
              placeholder="Tìm nhanh mặt hàng trong mẫu..."
              value={fillSearch}
              onChange={(e) => setFillSearch(e.target.value)}
            />
            {/* Đặt hàng bằng file: tải file của mẫu, điền cột Số lượng, import lại (khách hỏi 03/10/2026). */}
            <button type="button" onClick={() => void exportTemplate(filling, true)} className="secondary-button bg-white !min-h-10 text-xs" title="File Excel các mặt hàng của mẫu, có cột Số lượng để điền">
              <span className="material-symbols-outlined text-lg">download</span>Tải file đặt hàng
            </button>
            <label className="secondary-button bg-white !min-h-10 text-xs cursor-pointer" title="Điền số lượng từ file Excel (cột Mã hàng + Số lượng)">
              <span className="material-symbols-outlined text-lg">upload_file</span>Import số lượng
              <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importQuantities(file); }} />
            </label>
          </div>

          <div className="px-4 sm:px-5 pb-4 grid lg:grid-cols-2 gap-2">
            {visibleFillLines.map((line) => {
              const quantity = fillQuantities[line.id] || "";
              const active = Number(quantity) > 0;
              return (
                <div key={line.id} className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 ${active ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white"}`}>
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm text-slate-800 leading-snug">{line.item.name}</p>
                    <p className="text-xs text-slate-500">
                      {line.item.code} · ĐVT: <b>{lineUnit(line)}</b>
                      {baseQuantityHint(line, quantity) ? <span className="text-blue-700 font-semibold"> {baseQuantityHint(line, quantity)}</span> : null}
                      {line.note ? ` · ${line.note}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <input
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      className="control !mt-0 w-20 text-right text-base"
                      placeholder="0"
                      value={quantity}
                      onChange={(e) => { const value = e.target.value; setFillQuantities((current) => ({ ...current, [line.id]: value })); }}
                      aria-label={`Số lượng ${line.item.name}`}
                    />
                    <span className="text-xs font-semibold text-slate-500 w-12 truncate">{lineUnit(line)}</span>
                  </div>
                </div>
              );
            })}
            {visibleFillLines.length === 0 && (
              <p className="text-sm text-slate-500 py-3 text-center lg:col-span-2">Không có mặt hàng khớp từ khoá.</p>
            )}
          </div>

          {/* Thanh gửi dính đáy màn hình — chừa chỗ nút menu nổi bên trái trên điện thoại */}
          <div className="sticky bottom-0 z-20 border-t border-slate-200 bg-white/95 backdrop-blur px-4 py-3 rounded-b-lg flex items-center gap-3 pl-20 lg:pl-4">
            <p className="text-xs text-slate-600 shrink-0">
              Đã điền <b className="text-blue-700">{filledCount}</b>/{filling.lines.length} dòng
            </p>
            <button type="button" disabled={submitting || filledCount === 0} onClick={() => void submitFill()} className="primary-button flex-1 !min-h-12">
              <span className="material-symbols-outlined text-lg">send</span>
              {submitting ? "Đang gửi..." : "Gửi yêu cầu mua hàng"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ───────────────────────── Danh sách mẫu + chi tiết + quản lý ─────────────────────────
  // Rất nhiều mẫu (khách yêu cầu 03/10/2026): bảng có lọc bên trái, khung chi tiết bên phải.
  const todayVn = vnToday();
  const keyword = listFilter.search.trim().toLowerCase();
  const listedTemplates = templates
    .filter((template) => template.status === "ACTIVE")
    .filter((template) => listFilter.branch === "ALL" || !template.branchCode || template.branchCode === listFilter.branch)
    .filter((template) => listFilter.status === "ALL" || templateWindowStatus(template, todayVn) === listFilter.status)
    .filter((template) => !keyword
      || `${template.code} ${template.name}`.toLowerCase().includes(keyword)
      || template.lines.some((line) => line.item.code.toLowerCase().includes(keyword) || line.item.name.toLowerCase().includes(keyword)));
  const selected = listedTemplates.find((template) => template.id === selectedId) || listedTemplates[0] || null;
  const selectedWindow = selected ? templateWindow(selected) : null;
  const selectedStatus = selected ? templateWindowStatus(selected, todayVn) : null;
  const activeCount = templates.filter((template) => template.status === "ACTIVE" && templateWindowStatus(template, todayVn) === "ACTIVE").length;

  return (
    <div className="space-y-5">
      <section className="table-panel shadow-sm p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800">Mẫu đặt hàng</h2>
            <p className="text-xs text-slate-500 mt-0.5">{templates.filter((template) => template.status === "ACTIVE").length} mẫu · {activeCount} đang áp dụng hôm nay. Chọn mẫu để xem chi tiết rồi bấm Đặt hàng.</p>
          </div>
          {canCreate && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void downloadImportSample()} className="secondary-button bg-white !min-h-9 text-xs"><span className="material-symbols-outlined text-lg">description</span>File mẫu import</button>
              <label className="secondary-button bg-white !min-h-9 text-xs cursor-pointer">
                <span className="material-symbols-outlined text-lg">upload_file</span>Import mẫu Excel
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void pickImportFile(file); }} />
              </label>
              <button type="button" onClick={() => { setShowManage((current) => !current); if (showManage) resetTemplateForm(); else window.setTimeout(() => document.getElementById("template-manage")?.scrollIntoView({ behavior: "smooth" }), 50); }} className="secondary-button !min-h-9 text-xs">
                <span className="material-symbols-outlined text-lg">{showManage ? "expand_less" : "add"}</span>
                {showManage ? "Đóng form mẫu" : "Tạo mẫu"}
              </button>
            </div>
          )}
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input type="search" className="control !mt-0" placeholder="Tìm mã / tên mẫu hoặc mặt hàng trong mẫu..." value={listFilter.search} onChange={(e) => setListFilter({ ...listFilter, search: e.target.value })} />
          <select className="control !mt-0" value={listFilter.branch} onChange={(e) => setListFilter({ ...listFilter, branch: e.target.value })}>
            <option value="ALL">Tất cả cửa hàng</option>
            {branchOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
          </select>
          <select className="control !mt-0" value={listFilter.status} onChange={(e) => setListFilter({ ...listFilter, status: e.target.value })}>
            <option value="ACTIVE">Đang áp dụng</option>
            <option value="UPCOMING">Chưa áp dụng</option>
            <option value="EXPIRED">Đã kết thúc</option>
            <option value="ALL">Tất cả</option>
          </select>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section className="table-panel shadow-sm min-w-0">
          <div className="overflow-x-auto max-h-[640px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                <tr>
                  {["Mẫu", "Cửa hàng / bộ phận", "Áp dụng", "Số MH"].map((label, index) => (
                    <th key={label} className={`px-3 py-2.5 font-bold whitespace-nowrap ${index === 3 ? "text-right" : "text-left"}`}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listedTemplates.length === 0 && (
                  <tr><td colSpan={4} className="cell text-center text-slate-400">
                    {templates.length === 0 ? (canCreate ? "Chưa có mẫu nào — bấm Tạo mẫu hoặc Import mẫu Excel." : "Liên hệ quản lý để tạo mẫu đặt hàng.") : "Không có mẫu khớp bộ lọc."}
                  </td></tr>
                )}
                {listedTemplates.map((template) => {
                  const window = templateWindow(template);
                  const status = templateWindowStatus(template, todayVn);
                  const isSelected = selected?.id === template.id;
                  return (
                    <tr key={template.id} onClick={() => setSelectedId(template.id)} className={`border-t border-slate-100 cursor-pointer ${isSelected ? "bg-blue-50" : "hover:bg-slate-50"}`}>
                      <td className="cell min-w-[200px]"><b className="text-slate-800">{template.name}</b><small>{template.code}</small></td>
                      <td className="cell">{template.branchCode ? storeLabel(template.branchCode) : <span className="text-slate-500">Mọi cửa hàng</span>}<small>{departmentName(template.departmentCode)}</small></td>
                      <td className="cell whitespace-nowrap">
                        <span className={`status ${WINDOW_TONE[status]}`}>{WINDOW_LABEL[status]}</span>
                        <small className="block text-slate-500">{window.from ? dayText(window.from) : "…"} → {window.to ? dayText(window.to) : "…"}</small>
                      </td>
                      <td className="cell text-right tabular-nums">{template.lines.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="table-panel shadow-sm min-w-0">
          {!selected ? (
            <p className="p-6 text-sm text-slate-500 text-center">Chọn một mẫu ở danh sách để xem chi tiết.</p>
          ) : (
            <>
              <div className="p-4 sm:p-5 border-b border-slate-100 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-bold text-slate-900 text-lg leading-snug">{selected.name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{selected.code}{selected.createdBy ? ` · tạo bởi ${selected.createdBy}` : ""}{selected.updatedAt ? ` · cập nhật ${new Date(selected.updatedAt).toLocaleString("vi-VN")}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => void exportTemplate(selected)} className="secondary-button bg-white !min-h-9 text-xs"><span className="material-symbols-outlined text-lg">download</span>Xuất Excel</button>
                  {(canEdit || canCreate) && (
                    <RowActions
                      session={user}
                      module="/procurement"
                      compact
                      onEdit={() => startEditTemplate(selected)}
                      onDelete={() => { setDeleteError(null); setDeleteTarget(selected); }}
                    />
                  )}
                </div>
              </div>
              <dl className="px-4 sm:px-5 py-3 grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm border-b border-slate-100">
                <div><dt className="text-xs font-bold text-slate-500">Cửa hàng</dt><dd>{selected.branchCode ? storeLabel(selected.branchCode) : "Dùng chung mọi cửa hàng"}</dd></div>
                <div><dt className="text-xs font-bold text-slate-500">Bộ phận mặc định</dt><dd>{departmentName(selected.departmentCode) || "Người đặt tự chọn"}</dd></div>
                <div><dt className="text-xs font-bold text-slate-500">Ngày áp dụng</dt><dd>{selectedWindow?.from ? dayText(selectedWindow.from) : <span className="text-slate-400">Không giới hạn</span>}</dd></div>
                <div><dt className="text-xs font-bold text-slate-500">Ngày kết thúc</dt><dd>{selectedWindow?.to ? dayText(selectedWindow.to) : <span className="text-slate-400">Không giới hạn</span>}</dd></div>
                {selected.note && <div className="col-span-2 lg:col-span-4"><dt className="text-xs font-bold text-slate-500">Ghi chú</dt><dd>{selected.note}</dd></div>}
              </dl>
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto custom-scrollbar">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
                    <tr>{["STT", "Mã hàng", "Tên hàng", "ĐVT đặt", "Ghi chú"].map((label) => <th key={label} className="px-3 py-2 text-left font-bold whitespace-nowrap">{label}</th>)}</tr>
                  </thead>
                  <tbody>
                    {selected.lines.map((line, index) => (
                      <tr key={line.id} className="border-t border-slate-100">
                        <td className="cell text-slate-400">{index + 1}</td>
                        <td className="cell whitespace-nowrap font-bold">{line.item.code}</td>
                        <td className="cell">{line.item.name}</td>
                        <td className="cell whitespace-nowrap">{lineUnit(line)}</td>
                        <td className="cell text-slate-500">{line.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {canCreate && (
                <div className="p-4 border-t border-slate-100">
                  <button type="button" disabled={selectedStatus !== "ACTIVE"} onClick={() => startFilling(selected)} className="primary-button w-full !min-h-11 disabled:bg-slate-300 disabled:cursor-not-allowed">
                    <span className="material-symbols-outlined text-lg">edit_note</span>
                    {selectedStatus === "ACTIVE" ? "Đặt hàng theo mẫu này" : selectedStatus === "UPCOMING" ? `Mẫu áp dụng từ ${dayText(selectedWindow?.from || null)}` : `Mẫu đã kết thúc ${dayText(selectedWindow?.to || null)}`}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* canEdit cũng phải mở được khối này: nút Sửa trên thẻ mẫu gác theo quyền edit, chỉ gác
          khối form theo canCreate thì người có mỗi quyền sửa bấm Sửa xong không thấy gì hiện ra. */}
      {showManage && (canCreate || canEdit) && (
        <section id="template-manage" className="bg-white border border-slate-200 rounded-lg shadow-sm p-4 sm:p-5">
          <h2 className="font-bold text-slate-800 mb-1">{editingTemplate ? `Sửa mẫu ${editingTemplate.code}` : "Tạo mẫu mới"}</h2>
          <p className="text-xs text-slate-500 mb-4">Mẫu chỉ gồm tên hàng + ĐVT (không có số lượng). Bộ phận cần đặt sẽ mở mẫu và điền số lượng.</p>
          <form onSubmit={submitTemplate} className="space-y-4">
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              <label className="block text-xs font-bold text-slate-600">Tên mẫu
                <input className="control" required value={templateForm.name} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, name: value })); }} placeholder="VD: Mẫu đặt hàng Bếp" />
              </label>
              <label className="block text-xs font-bold text-slate-600">Cửa hàng áp dụng
                <select className="control" value={templateForm.branchCode} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, branchCode: value })); }}>
                  <option value="">Dùng chung mọi cửa hàng</option>
                  {branchOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
                </select>
              </label>
              <label className="block text-xs font-bold text-slate-600">Bộ phận mặc định
                <select className="control" value={templateForm.departmentCode} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, departmentCode: value })); }}>
                  <option value="">Người đặt tự chọn</option>
                  {departments.map((item) => <option key={item.id} value={item.code}>{item.name}{item.branch && item.branch !== "ALL" ? ` (${storeLabel(item.branch)})` : ""}</option>)}
                </select>
              </label>
              {/* Ngày áp dụng / kết thúc để trống mặc định — người lập tự điền (khách yêu cầu 03/10/2026).
                  Trống = không giới hạn đầu đó; ngoài khoảng này mẫu không dùng để đặt hàng được. */}
              <label className="block text-xs font-bold text-slate-600">Ngày áp dụng
                <input type="date" className="control" value={templateForm.effectiveFrom} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, effectiveFrom: value })); }} />
              </label>
              <label className="block text-xs font-bold text-slate-600">Ngày kết thúc
                <input type="date" className="control" value={templateForm.effectiveTo} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, effectiveTo: value })); }} />
              </label>
              <label className="block text-xs font-bold text-slate-600 sm:col-span-2 xl:col-span-3">Ghi chú
                <input className="control" value={templateForm.note} onChange={(e) => { const value = e.target.value; setTemplateForm((current) => ({ ...current, note: value })); }} />
              </label>
            </div>

            <div className="space-y-3 border border-slate-100 rounded-lg p-3.5 bg-slate-50/50">
              <div className="flex items-center justify-between border-b border-slate-200/60 pb-2">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Danh sách mặt hàng của mẫu</h3>
                <button type="button" className="text-xs font-bold text-blue-600 hover:underline flex items-center gap-0.5" onClick={() => setTemplateRows((rows) => [...rows, { itemId: "", unitCode: "" }])}>
                  <span className="material-symbols-outlined text-sm font-bold">add</span>Thêm dòng
                </button>
              </div>
              {templateRows.map((row, index) => {
                const { defaultLabel, conversions } = unitOptionsForItem(row.itemId);
                return (
                  <div key={index} className="bg-white border border-slate-200 rounded-xl p-3 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Hàng #{index + 1}</span>
                      {templateRows.length > 1 && (
                        <button type="button" className="text-xs font-bold text-rose-600 hover:underline" onClick={() => setTemplateRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>Xóa</button>
                      )}
                    </div>
                    <div className="grid sm:grid-cols-[minmax(0,1fr)_180px_minmax(0,240px)] gap-2">
                      <SearchableSelect
                        value={row.itemId}
                        onChange={(itemId) => setTemplateRows((rows) => rows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, itemId, unitCode: "" } : candidate))}
                        options={itemOptions}
                        placeholder="Chọn mặt hàng..."
                      />
                      <select
                        className="control !mt-0"
                        value={row.unitCode}
                        onChange={(e) => { const value = e.target.value; setTemplateRows((rows) => rows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, unitCode: value } : candidate)); }}
                      >
                        <option value="">{defaultLabel}</option>
                        {conversions.map((unit) => (
                          <option key={unit.unitCode} value={unit.unitCode}>{unit.unitName || unit.unitCode}</option>
                        ))}
                      </select>
                      <input
                        className="control !mt-0"
                        placeholder="Ghi chú dòng (không bắt buộc)"
                        value={row.note || ""}
                        onChange={(e) => { const value = e.target.value; setTemplateRows((rows) => rows.map((candidate, rowIndex) => rowIndex === index ? { ...candidate, note: value } : candidate)); }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              {editingTemplate && (
                <button type="button" onClick={resetTemplateForm} className="secondary-button">Huỷ</button>
              )}
              <button className="primary-button flex-1" disabled={savingTemplate}>
                <span className="material-symbols-outlined text-lg">{editingTemplate ? "save" : "add"}</span>
                {savingTemplate ? "Đang lưu..." : editingTemplate ? "Lưu mẫu" : "Tạo mẫu"}
              </button>
            </div>
          </form>
        </section>
      )}

      {importState && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-4xl shadow-xl max-h-[90vh] flex flex-col">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-lg">Import mẫu đặt hàng</h3>
                <p className="text-xs text-slate-500 mt-0.5">{importState.fileName} · {importState.rows.length} dòng</p>
              </div>
              <button type="button" onClick={() => setImportState(null)} className="icon-button"><span className="material-symbols-outlined">close</span></button>
            </div>
            <div className="p-5 overflow-y-auto custom-scrollbar space-y-4">
              {importState.busy && !importState.result && <p className="text-sm text-slate-500">Đang kiểm tra file...</p>}
              {importState.result && (
                <>
                  <table className="w-full text-sm border border-slate-200">
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                      <tr>{["Mẫu", "Cửa hàng", "Bộ phận", "Áp dụng", "Số MH", "Ghi"].map((label) => <th key={label} className="px-3 py-2 text-left">{label}</th>)}</tr>
                    </thead>
                    <tbody>
                      {importState.result.groups.map((group, index) => (
                        <tr key={index} className="border-t border-slate-100">
                          <td className="px-3 py-1.5"><b>{group.name}</b></td>
                          <td className="px-3 py-1.5">{group.branchCode ? storeLabel(group.branchCode) : "Mọi cửa hàng"}</td>
                          <td className="px-3 py-1.5">{departmentName(group.departmentCode)}</td>
                          <td className="px-3 py-1.5 whitespace-nowrap">{group.from ? dayText(group.from) : "…"} → {group.to ? dayText(group.to) : "…"}</td>
                          <td className="px-3 py-1.5 text-right">{group.lineCount}</td>
                          <td className="px-3 py-1.5 text-xs">{group.code ? <span className="text-amber-700">Ghi đè {group.code}</span> : <span className="text-emerald-700">Mẫu mới</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {importState.result.errorCount > 0 && (
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <h4 className="text-sm font-bold text-rose-800 mb-1">{importState.result.errorCount} lỗi — sửa file rồi chọn lại, chưa ghi gì</h4>
                      <ul className="text-xs text-rose-700 space-y-0.5 max-h-60 overflow-y-auto">
                        {importState.result.errors.map((error, index) => <li key={index}>{error.row ? `Dòng ${error.row}: ` : ""}{error.message}</li>)}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setImportState(null)} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Đóng</button>
              <button type="button" onClick={() => void commitImport()} disabled={importState.busy || !importState.result || importState.result.errorCount > 0 || importState.result.groups.length === 0} className="primary-button disabled:bg-slate-300">
                <span className="material-symbols-outlined text-lg">upload</span>{importState.busy ? "Đang ghi..." : "Ghi mẫu"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget ? `Xoá mẫu ${deleteTarget.code}?` : ""}
        description={deleteTarget ? `${deleteTarget.name} · ${deleteTarget.lines.length} mặt hàng` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
        onConfirm={confirmDeleteTemplate}
      />
    </div>
  );
}
