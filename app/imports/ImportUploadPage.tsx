"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { SearchableSelect } from "@/components/SearchableSelect";
import { displayRoleName, storeLabel } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { getImportTemplate, type ImportFieldDefinition, type ImportType } from "@/lib/import-templates";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";

type PreviewRow = {
  sheetName: string;
  rowNumber: number;
  values: Record<string, string | number | null>;
  errors: string[];
};

type PreviewPayload = {
  sheetName: string;
  headerRowNumber: number;
  headers: string[];
  mapping: Record<string, string>;
  rows: PreviewRow[];
  totalRows: number;
  validRows: number;
  errorRows: number;
};

type Batch = {
  id: string;
  fileName: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  uploadedBy: string | null;
  createdAt: string;
  rolledBackAt?: string | null;
  rolledBackBy?: string | null;
  rollbackNote?: string | null;
};

type DetailValue = string | number | boolean | null | Record<string, unknown> | unknown[];
type DetailRow = Record<string, DetailValue>;

type BatchDetail = Batch & {
  bankTransactions?: DetailRow[];
  revenueRows?: DetailRow[];
  payrollRows?: DetailRow[];
  importRows?: DetailRow[];
  vouchers?: DetailRow[];
  moneyTransfers?: DetailRow[];
  debtRecords?: DetailRow[];
  inventoryTransactions?: DetailRow[];
};

type TemplateField = {
  field: string;
  label: string;
  required: boolean;
  type?: string;
  hiddenFromMapping?: boolean;
};

type BranchOption = { code: string; name: string };

type ImportUploadPageProps = {
  title: string;
  subtitle: string;
  menuHref: string;
  apiPath: string;
  templatePath: string;
  templateCode: string;
  primaryFields: string[];
  requiresBranch?: boolean;
  navigation?: ReactNode;
  expectedMasterType?: string;
};

function withQuery(url: string, values: Record<string, string>) {
  const [path, query = ""] = url.split("?");
  const params = new URLSearchParams(query);
  Object.entries(values).forEach(([key, value]) => params.set(key, value));
  return `${path}?${params.toString()}`;
}

function statusBadgeClass(status: string) {
  if (status === "ROLLED_BACK") return "bg-slate-100 text-slate-600 border-slate-200";
  if (status === "ROLLBACK_FAILED") return "bg-rose-50 text-rose-700 border-rose-200";
  if (status.includes("ERROR") || status.includes("FAILED")) return "bg-rose-50 text-rose-700 border-rose-200";
  if (status.includes("COMMITTED") || status === "APPROVED") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  return "bg-amber-50 text-amber-700 border-amber-200";
}

function importTypeFromApiPath(apiPath: string) {
  const [, query = ""] = apiPath.split("?");
  return new URLSearchParams(query).get("importType") || "";
}

function currentDateValue() {
  return new Date().toISOString().slice(0, 10);
}

function currentPeriodValue() {
  return new Date().toISOString().slice(0, 7);
}

function parseDetailJson(value: DetailValue) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, DetailValue>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, DetailValue> : {};
  } catch {
    return {};
  }
}

function firstNonEmptyRows(...groups: Array<DetailRow[] | undefined>) {
  return groups.find((rows) => Array.isArray(rows) && rows.length > 0) || [];
}

function normalizeGenericImportRows(rows: DetailRow[] | undefined) {
  return (rows || []).map((row) => {
    const normalized = parseDetailJson(row.normalizedJson);
    return {
      sheetName: row.sheetName,
      sourceRowNumber: row.sourceRowNumber,
      targetType: row.targetType,
      ...normalized,
      errorJson: row.errorJson,
    };
  });
}

function formatDetailValue(value: DetailValue) {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "number") return new Intl.NumberFormat("vi-VN").format(value);
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (typeof value === "object") return JSON.stringify(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value).toLocaleDateString("vi-VN");
  return value;
}

function manualInitialValue(field: ImportFieldDefinition, selectedBranch: string) {
  if (field.field === "branch_code") return selectedBranch;
  if (field.type === "date") return currentDateValue();
  if (field.field.includes("period")) return currentPeriodValue();
  if (field.field === "transaction_code" || field.field === "external_ref" || field.field === "document_code" || field.field === "reference_code") {
    return `MANUAL-${Date.now()}`;
  }
  if (field.type === "number" || field.type === "integer") return "";
  return "";
}

type MasterOption = { code: string; name: string; group?: string | null; partnerType?: string | null; branch?: string | null };

/**
 * Các cột trong template thực chất là mã tham chiếu tới danh mục -> cho chọn từ danh sách
 * (có ô tìm kiếm) thay vì bắt người dùng gõ tay đúng mã.
 */
const masterDataFieldTypes: Record<string, string> = {
  partner_code: "PARTNER",
  category_code: "REVENUE_EXPENSE_CATEGORY",
  money_source_code: "MONEY_SOURCE",
  from_money_source_code: "MONEY_SOURCE",
  to_money_source_code: "MONEY_SOURCE",
  summary_money_source_code: "MONEY_SOURCE",
  increase_money_source_code: "MONEY_SOURCE",
  decrease_money_source_code: "MONEY_SOURCE",
  warehouse_code: "WAREHOUSE",
  to_warehouse_code: "WAREHOUSE",
  department_code: "DEPARTMENT",
  branch_code: "BRANCH",
};

/** Cột tên đối tác được điền tự động theo mã đã chọn. */
const partnerNameFields: Record<string, string> = { partner_code: "partner_name" };

const normalizeGroup = (value?: string | null) => (value || "").trim().toUpperCase();

/**
 * Thu hẹp danh sách theo nghiệp vụ của từng template: phiếu phải trả chỉ gợi ý nhà cung cấp
 * và khoản mục chi phí, phiếu phải thu chỉ gợi ý khách hàng và nguồn doanh thu.
 */
function filterMasterOptions(
  fieldName: string,
  templateCode: string,
  options: MasterOption[],
  values: Record<string, string> = {},
) {
  const selectedBranch = normalizeGroup(values.branch_code);
  const branchScopedFields = [
    "partner_code",
    "money_source_code",
    "from_money_source_code",
    "to_money_source_code",
    "summary_money_source_code",
    "increase_money_source_code",
    "decrease_money_source_code",
    "warehouse_code",
    "to_warehouse_code",
    "department_code",
  ];
  const scopedOptions = selectedBranch && branchScopedFields.includes(fieldName)
    ? options.filter((option) => {
        const optionBranch = normalizeGroup(option.branch);
        return !optionBranch || optionBranch === "ALL" || optionBranch === selectedBranch;
      })
    : options;

  // Sao kê không có "loại phiếu": chiều tiền do cột Ghi nợ / Ghi có quyết định, nên
  // suy ra từ chính hai ô đó để chỉ gợi ý khoản mục đúng chiều.
  const isBankStatement = /BANK_STATEMENT/.test(templateCode);
  const bankDebit = Number((values.debit_amount || "").replace(/[^\d.-]/g, "")) > 0;
  const bankCredit = Number((values.credit_amount || "").replace(/[^\d.-]/g, "")) > 0;
  const isPayable = /PAYABLE|PAYMENT/.test(templateCode) || (isBankStatement && bankDebit);
  const isReceivable = /RECEIVABLE|RECEIPT/.test(templateCode) || (isBankStatement && bankCredit);

  if (fieldName === "partner_code") {
    return scopedOptions.filter((option) => {
      const type = normalizeGroup(option.partnerType || option.group);
      if (isPayable) return ["SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(type);
      if (isReceivable) return ["CUSTOMER", "BOTH", "OTHER_PARTNER"].includes(type);
      return true;
    });
  }

  if (fieldName === "category_code") {
    return scopedOptions.filter((option) => {
      const cashflowType = normalizeCashflowCategoryType(option.group);
      if (isPayable) return cashflowType === "PAYMENT";
      if (isReceivable) return cashflowType === "RECEIPT";
      return true;
    });
  }

  return scopedOptions;
}

function getSessionFromStorage(): DemoSession | null {
  const rawSession = localStorage.getItem(SESSION_KEY);
  if (!rawSession) return null;
  try {
    return JSON.parse(rawSession) as DemoSession;
  } catch {
    return null;
  }
}

export default function ImportUploadPage({
  title,
  subtitle,
  menuHref,
  apiPath,
  templatePath,
  templateCode,
  primaryFields,
  requiresBranch = false,
  navigation,
  expectedMasterType = "",
}: ImportUploadPageProps) {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<BatchDetail | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [batchDetailLoading, setBatchDetailLoading] = useState(false);
  const [batchDetailError, setBatchDetailError] = useState("");
  const [message, setMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [branchCode, setBranchCode] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingFields, setMappingFields] = useState<TemplateField[]>([]);
  const [mappingDirty, setMappingDirty] = useState(false);
  const [showTemplateLink, setShowTemplateLink] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<Batch | null>(null);
  const [rollbackNote, setRollbackNote] = useState("");
  const [rollbackError, setRollbackError] = useState("");
  const [rollbackSaving, setRollbackSaving] = useState(false);
  const [masterOptions, setMasterOptions] = useState<Record<string, MasterOption[]>>({});
  const alwaysShowTemplateLink = templateCode === "OPENING_BALANCE_STANDARD_V1";
  const importType = importTypeFromApiPath(apiPath);
  const template = useMemo(() => getImportTemplate(importType as ImportType, templateCode), [importType, templateCode]);
  const manualFields = useMemo(() => template?.fields.filter((field) => !field.hiddenFromMapping) || [], [template]);
  const batchDetailRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const session = getSessionFromStorage();
    const menu = appMenuItems.find((item) => item.href === menuHref);
    if (!session) {
      router.push(`/login?next=${menuHref}`);
      return;
    }
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      if (session.allowedBranches?.length === 1 && !session.allowedBranches.includes("ALL")) {
        setBranchCode(session.allowedBranches[0]);
      }
      setIsCheckingAuth(false);
    }, 0);
  }, [menuHref, router]);

  useEffect(() => {
    if (isCheckingAuth || !requiresBranch) return;
    const controller = new AbortController();
    const rawSession = localStorage.getItem(SESSION_KEY);
    const headers: Record<string, string> = rawSession ? { "x-demo-session": encodeURIComponent(rawSession) } : {};
    void fetch("/api/master-data?type=BRANCH&status=ACTIVE", { headers, signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : [])
      .then((items: BranchOption[]) => setBranches(items.map((item) => ({ code: item.code, name: item.name }))))
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setMessage("Không tải được danh sách chi nhánh.");
      });
    return () => controller.abort();
  }, [isCheckingAuth, requiresBranch]);

  const errorRows = useMemo(() => preview?.rows.filter((row) => row.errors.length > 0) || [], [preview]);
  const messageIsError = /lỗi|không|vui lòng|thất bại|sai|thiếu|bắt buộc|error|failed|invalid|khong|loi|dong|dòng/i.test(message);

  const loadBatches = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(apiPath, { signal });
    if (response.ok && !signal?.aborted) setBatches((await response.json()) as Batch[]);
  }, [apiPath]);

  const loadBatchDetail = async (batchId: string) => {
    if (selectedBatchId === batchId && selectedBatch && !batchDetailError) return;
    setSelectedBatchId(batchId);
    setBatchDetailLoading(true);
    setBatchDetailError("");
    try {
      const response = await fetch(withQuery(apiPath, { batchId }));
      const payload = await response.json();
      if (!response.ok) {
        setBatchDetailError(payload.error || "Không tải được chi tiết batch import.");
        return;
      }
      setSelectedBatch(payload as BatchDetail);
    } catch {
      setBatchDetailError("Không tải được chi tiết batch import.");
    } finally {
      setBatchDetailLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedBatch) return;
    window.setTimeout(() => {
      batchDetailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  }, [selectedBatch]);

  useEffect(() => {
    if (isCheckingAuth) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setFile(null);
      setPreview(null);
      setMapping({});
      setMappingFields([]);
      setMappingDirty(false);
      setBatches([]);
      setSelectedBatch(null);
      setSelectedBatchId("");
      setBatchDetailLoading(false);
      setBatchDetailError("");
      setMessage("");
      setManualOpen(false);
      setManualValues({});
      setManualError("");
      void loadBatches(controller.signal).catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setMessage("Không tải được lịch sử import.");
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiPath, isCheckingAuth, loadBatches]);

  // Chỉ tải danh mục khi người dùng thực sự mở form nhập nhanh, và mỗi loại chỉ tải một lần.
  useEffect(() => {
    if (!manualOpen) return;
    const neededTypes = [...new Set(
      manualFields
        .map((field) => masterDataFieldTypes[field.field])
        .filter((type): type is string => Boolean(type))
    )].filter((type) => !masterOptions[type]);
    if (neededTypes.length === 0) return;

    const controller = new AbortController();
    const rawSession = localStorage.getItem(SESSION_KEY);
    const headers: Record<string, string> = rawSession ? { "x-demo-session": encodeURIComponent(rawSession) } : {};
    void Promise.all(neededTypes.map(async (type) => {
      const response = await fetch(`/api/master-data?type=${type}&status=ACTIVE`, { headers, signal: controller.signal });
      return [type, response.ok ? ((await response.json()) as MasterOption[]) : []] as const;
    }))
      .then((entries) => {
        setMasterOptions((current) => ({ ...current, ...Object.fromEntries(entries) }));
      })
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setManualError("Không tải được danh mục để chọn. Vui lòng thử lại.");
      });

    return () => controller.abort();
  }, [manualFields, manualOpen, masterOptions]);

  useEffect(() => {
    if (!manualOpen) return;
    const timer = window.setTimeout(() => {
      setManualError("");
      setManualValues((current) => {
        const next: Record<string, string> = {};
        for (const field of manualFields) {
          next[field.field] = current[field.field]
            ?? (field.field === "type" && expectedMasterType ? expectedMasterType : manualInitialValue(field, branchCode));
        }
        return next;
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [branchCode, expectedMasterType, manualFields, manualOpen]);

  const upload = async (mode: "preview" | "commit") => {
    if (!file) {
      setMessage("Vui lòng chọn file Excel trước.");
      return;
    }
    if (requiresBranch && !branchCode) {
      setMessage("Vui lòng chọn chi nhánh áp dụng cho file import.");
      return;
    }

    setIsUploading(true);
    setMessage("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("templateCode", templateCode);
      if (branchCode) formData.append("branchCode", branchCode);
      if (expectedMasterType) formData.append("expectedMasterType", expectedMasterType);
      if (Object.keys(mapping).length > 0) formData.append("mappingJson", JSON.stringify(mapping));

      const response = await fetch(withQuery(apiPath, { mode }), {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      const previewPayload = payload.preview as PreviewPayload | undefined;
      if (previewPayload) {
        setPreview(previewPayload);
        setMapping(previewPayload.mapping || {});
        setMappingFields((payload.template?.fields || []) as TemplateField[]);
        setMappingDirty(false);
      }
      if (!response.ok) throw new Error(payload.error || "Không xử lý được file import");

      if (mode === "preview" && previewPayload && previewPayload.errorRows > 0) {
        setMessage(`File có ${previewPayload.errorRows} dòng lỗi, vui lòng kiểm tra phần màu đỏ.`);
      } else if (mode === "commit" && templateCode === "BANK_STATEMENT_STANDARD_V1") {
        const pendingCount = (payload.batch?.vouchers?.length || 0) + (payload.batch?.moneyTransfers?.length || 0);
        const manualCount = previewPayload?.rows.filter((row) => row.values.auto_process_type === "MANUAL_REQUIRED").length || 0;
        const skippedCount = previewPayload?.rows.filter((row) => row.values.import_action === "SKIP_EXISTING").length || 0;
        const netZeroCount = previewPayload?.rows.filter((row) => row.values.import_action === "NET_ZERO").length || 0;
        setMessage(`Đã import sao kê: tạo ${pendingCount} chứng từ ngân hàng/điều chuyển chờ duyệt, ${manualCount} dòng chờ đối soát thủ công, bỏ qua ${skippedCount} dòng đã có, ghi nhận ${netZeroCount} dòng đảo Nợ/Có ròng 0 đ.`);
      } else {
        setMessage(mode === "preview" ? "Đã đọc file, vui lòng kiểm tra preview." : "Đã commit dữ liệu import.");
      }
      if (mode === "commit") await loadBatches();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi import file");
    } finally {
      setIsUploading(false);
    }
  };

  const saveManualRow = async () => {
    if (!template || manualFields.length === 0) {
      setManualError("Không tải được cấu trúc template import.");
      return;
    }
    if (requiresBranch && !branchCode) {
      setManualError("Vui lòng chọn chi nhánh trước khi thêm mới.");
      return;
    }
    // Ô chọn danh mục không phải <input> nên trình duyệt không tự chặn được trường bắt buộc.
    const missingSelect = manualFields.find(
      (field) => field.required && masterDataFieldTypes[field.field] && !(manualValues[field.field] || "").trim()
    );
    if (missingSelect) {
      setManualError(`Vui lòng chọn ${missingSelect.label.toLowerCase()}.`);
      return;
    }

    setManualSaving(true);
    setManualError("");
    setMessage("");
    try {
      const XLSX = await import("xlsx");
      const headers = manualFields.map((field) => field.label);
      const row = manualFields.map((field) => manualValues[field.field] ?? "");
      const worksheet = XLSX.utils.aoa_to_sheet([headers, row], { cellDates: true });
      worksheet["!cols"] = headers.map((header) => ({ wch: Math.min(Math.max(header.length + 4, 14), 34) }));
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, (template.preferredSheetNames?.[0] || "Nhap tay").slice(0, 31));
      const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
      const fileName = `manual_${template.code.toLowerCase()}_${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;
      const manualFile = new File([buffer], fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

      const formData = new FormData();
      formData.append("file", manualFile);
      formData.append("templateCode", templateCode);
      if (branchCode) formData.append("branchCode", branchCode);
      if (expectedMasterType) formData.append("expectedMasterType", expectedMasterType);

      const response = await fetch(withQuery(apiPath, { mode: "commit" }), {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      const previewPayload = payload.preview as PreviewPayload | undefined;
      if (previewPayload) {
        setPreview(previewPayload);
        setMapping(previewPayload.mapping || {});
        setMappingFields((payload.template?.fields || []) as TemplateField[]);
        setMappingDirty(false);
      }
      if (!response.ok) {
        const firstError = previewPayload?.rows.find((row) => row.errors.length > 0)?.errors.join("; ");
        throw new Error(firstError || payload.error || "Không lưu được dòng nhập tay");
      }

      setManualOpen(false);
      setManualValues({});
      setMessage("Đã thêm mới 1 dòng dữ liệu và commit vào hệ thống.");
      await loadBatches();
    } catch (error) {
      setManualError(error instanceof Error ? error.message : "Có lỗi khi thêm mới dữ liệu.");
    } finally {
      setManualSaving(false);
    }
  };

  const downloadPreviewErrors = async () => {
    if (!preview || errorRows.length === 0) return;
    const XLSX = await import("xlsx");
    const rows = errorRows.map((row) => ({
      sheet: row.sheetName,
      row_number: row.rowNumber,
      errors: row.errors.join("; "),
      ...Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, value ?? ""])),
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = Object.keys(rows[0] || {}).map((key) => ({ wch: Math.min(Math.max(key.length + 8, 16), 44) }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Dong loi");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx", compression: true });
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `preview_errors_${templateCode.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadBatchErrors = async (batchId: string) => {
    const response = await fetch(withQuery(apiPath, { batchId, download: "errors" }));
    if (!response.ok) {
      setMessage("Không tải được file lỗi của batch.");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `batch_${batchId}_errors.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const openRollbackDialog = (batch: Batch) => {
    setRollbackTarget(batch);
    setRollbackNote("");
    setRollbackError("");
  };

  const rollbackBatch = async () => {
    if (!rollbackTarget) return;
    const note = rollbackNote.trim();
    if (!note) {
      setRollbackError("Vui lòng nhập lý do rollback.");
      return;
    }
    setRollbackSaving(true);
    setRollbackError("");
    setMessage("");
    try {
      const response = await fetch(apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ROLLBACK_BATCH", batchId: rollbackTarget.id, note }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setRollbackError(payload.error || "Rollback batch thất bại.");
        await loadBatches();
        return;
      }
      const fileName = rollbackTarget.fileName;
      setRollbackTarget(null);
      setRollbackNote("");
      setSelectedBatch(null);
      setMessage(`Đã rollback batch ${fileName}.`);
      await loadBatches();
    } catch {
      setRollbackError("Không thể kết nối để rollback batch. Vui lòng thử lại.");
    } finally {
      setRollbackSaving(false);
    }
  };

  const selectedBatchRows = selectedBatch ? firstNonEmptyRows(
    selectedBatch.bankTransactions,
    selectedBatch.revenueRows,
    selectedBatch.payrollRows,
    selectedBatch.vouchers,
    selectedBatch.moneyTransfers,
    selectedBatch.debtRecords,
    selectedBatch.inventoryTransactions,
    normalizeGenericImportRows(selectedBatch.importRows)
  ) : [];
  const selectedBatchColumns = Object.keys(selectedBatchRows[0] || {})
    .filter((key) => !["id", "importBatchId", "createdAt"].includes(key))
    .slice(0, 10);

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-lg font-bold">{title}</h1>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setManualOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-bold text-white shadow-sm hover:bg-blue-700"
          >
            <span className="material-symbols-outlined text-base">add</span>
            Thêm mới
          </button>
          <label className="hidden cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-white sm:flex">
            <input
              type="checkbox"
              checked={showTemplateLink}
              onChange={(event) => setShowTemplateLink(event.target.checked)}
              className="h-3 w-3 accent-blue-600"
            />
            File mẫu
          </label>
          <div className="hidden sm:block text-right">
            <p className="text-xs font-bold">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{displayRoleName(user?.role)}</p>
          </div>
        </div>
      </header>

      <main className="w-full px-1 py-2 sm:px-2 lg:px-2 space-y-2">
        <section className="grid grid-cols-1 gap-2 lg:grid-cols-[214px_minmax(0,1fr)]">
          {navigation && (
            <aside className="lg:sticky lg:top-[84px] lg:col-start-1 lg:self-start">
              {navigation}
            </aside>
          )}

          <div className="min-w-0 space-y-2 lg:col-start-2">
          <div className="flex h-fit flex-wrap items-end justify-end gap-2">
            {(showTemplateLink || alwaysShowTemplateLink) && (
              <a
                href={templatePath}
                className="flex h-9 w-[138px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold shadow-sm hover:bg-slate-50"
              >
                <span className="material-symbols-outlined text-base text-blue-600">download</span>
                Tải file mẫu
              </a>
            )}

            {requiresBranch && (
              <label className="block w-[190px] text-xs font-bold text-slate-600">
                Cửa hàng áp dụng
                <select
                  value={branchCode}
                  onChange={(event) => {
                    setBranchCode(event.target.value);
                    setPreview(null);
                    setMappingDirty(false);
                  }}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                >
                  <option value="">Chọn cửa hàng</option>
                  {branches.map((branch) => (
                    <option key={branch.code} value={branch.code}>{storeLabel(branch.code)}</option>
                  ))}
                </select>
              </label>
            )}

            <label className="block w-[320px] cursor-pointer text-xs font-bold text-slate-600">
              File Excel
              <span className="mt-1 flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-700 shadow-sm hover:border-blue-300 hover:bg-blue-50">
                <span className="material-symbols-outlined text-base text-blue-600">upload_file</span>
                <span className="min-w-0 truncate">{file ? file.name : "Chọn file Excel"}</span>
              </span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(event) => {
                  setFile(event.target.files?.[0] || null);
                  setPreview(null);
                  setMapping({});
                  setMappingFields([]);
                  setMappingDirty(false);
                }}
                className="sr-only"
              />
            </label>

            <div className="flex gap-2">
              <button
                onClick={() => upload("preview")}
                disabled={isUploading}
                className="h-9 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg px-4 text-xs font-bold shadow-sm"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-base">visibility</span>
                  Preview
                </span>
              </button>
              <button
                onClick={() => upload("commit")}
                disabled={isUploading || !preview || preview.errorRows > 0 || mappingDirty}
                className="h-9 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg px-4 text-xs font-bold shadow-sm"
              >
                <span className="inline-flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-base">check_circle</span>
                  Commit
                </span>
              </button>
            </div>

            {message && (
              <p className={`h-9 max-w-[420px] truncate rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm ${
                messageIsError
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : "border-blue-100 bg-blue-50 text-blue-700"
              }`}>
                {message}
              </p>
            )}
          </div>

          <section className="min-w-0 bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <h2 className="font-bold">Preview dữ liệu</h2>
              <p className="text-xs text-slate-500 mt-1">
                Hệ thống tự nhận header theo alias. Dòng lỗi sẽ bị chặn khi commit vào dữ liệu vận hành.
              </p>
            </div>

            {preview ? (
              <>
                <div className="grid grid-cols-3 gap-3 px-4 py-3 border-b border-slate-100">
                  <div className="rounded-lg bg-slate-50 px-3 py-2.5">
                    <p className="text-xs text-slate-500">Tổng dòng</p>
                    <p className="text-xl font-bold">{preview.totalRows}</p>
                  </div>
                  <div className="rounded-lg bg-emerald-50 px-3 py-2.5">
                    <p className="text-xs text-emerald-700">Hợp lệ</p>
                    <p className="text-xl font-bold text-emerald-700">{preview.validRows}</p>
                  </div>
                  <div className="rounded-lg bg-rose-50 px-3 py-2.5">
                    <p className="text-xs text-rose-700">Lỗi</p>
                    <p className="text-xl font-bold text-rose-700">{preview.errorRows}</p>
                  </div>
                </div>

                {mappingFields.some((field) => !field.hiddenFromMapping) && (
                  <div className="border-b border-slate-100 px-4 py-3">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-bold">Mapping cột</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Sheet {preview.sheetName}, header dòng {preview.headerRowNumber}. Có thể đổi mapping rồi preview lại.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => upload("preview")}
                        disabled={isUploading || !mappingDirty}
                        className="rounded-lg border border-blue-200 px-3 py-2 text-sm font-bold text-blue-700 disabled:opacity-40"
                      >
                        Áp dụng mapping
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {mappingFields.filter((field) => !field.hiddenFromMapping).map((field) => (
                        <label key={field.field} className="text-xs font-bold text-slate-600">
                          {field.label}{field.required ? " *" : ""}
                          <select
                            value={mapping[field.field] || ""}
                            onChange={(event) => {
                              setMapping((current) => ({ ...current, [field.field]: event.target.value }));
                              setMappingDirty(true);
                            }}
                            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-normal"
                          >
                            <option value="">Không map</option>
                            {preview.headers.filter(Boolean).map((header) => (
                              <option key={`${field.field}-${header}`} value={header}>{header}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {errorRows.length > 0 && (
                  <div className="px-4 py-3 border-b border-slate-100 bg-rose-50 text-sm text-rose-800">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <p className="font-bold">Dòng lỗi đầu tiên:</p>
                        <p className="mt-1">
                          Dòng {errorRows[0].rowNumber}: {errorRows[0].errors.join("; ")}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={downloadPreviewErrors}
                        className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-bold text-rose-700 hover:bg-rose-50"
                      >
                        Tải file lỗi
                      </button>
                    </div>
                  </div>
                )}

                <div className="max-h-[calc(100vh-365px)] min-h-[330px] overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>
                        <th className="px-4 py-3">Dòng</th>
                        {primaryFields.map((field) => (
                          <th key={field} className="px-4 py-3">{field}</th>
                        ))}
                        <th className="px-4 py-3">Lỗi</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.rows.slice(0, 100).map((row) => (
                        <tr key={row.rowNumber} className={row.errors.length > 0 ? "bg-rose-50/70 hover:bg-rose-50" : "hover:bg-slate-50"}>
                          <td className="px-4 py-3 font-bold">{row.rowNumber}</td>
                          {primaryFields.map((field) => (
                            <td key={field} className="px-4 py-3 whitespace-nowrap">
                              {String(row.values[field] ?? "-")}
                            </td>
                          ))}
                          <td className={`px-4 py-3 ${row.errors.length > 0 ? "font-semibold text-rose-700" : "text-slate-400"}`}>
                            {row.errors.join("; ") || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="px-4 py-10 text-center text-slate-400 text-sm">Chưa có dữ liệu preview.</div>
            )}
          </section>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Lịch sử import</h2>
              <p className="text-xs text-slate-500 mt-1">20 batch gần nhất, bấm một dòng để xem chi tiết.</p>
            </div>
            <button onClick={() => void loadBatches()} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">
              Tải lại
            </button>
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3">Trạng thái</th>
                  <th className="px-4 py-3">Dòng</th>
                  <th className="px-4 py-3">Người upload</th>
                  <th className="px-4 py-3">Ngày tạo</th>
                  <th className="px-4 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batches.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400">Chưa có batch import.</td>
                  </tr>
                ) : (
                  batches.map((batch) => (
                    <tr
                      key={batch.id}
                      onClick={() => void loadBatchDetail(batch.id)}
                      className={`cursor-pointer hover:bg-slate-50 ${selectedBatchId === batch.id ? "bg-blue-50/70 ring-1 ring-inset ring-blue-200" : ""}`}
                    >
                      <td className="px-4 py-3 font-bold">{batch.fileName}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${statusBadgeClass(batch.status)}`}>
                          {batch.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">{batch.validRows}/{batch.totalRows}</td>
                      <td className="px-4 py-3">{batch.uploadedBy || "-"}</td>
                      <td className="px-4 py-3">{new Date(batch.createdAt).toLocaleString("vi-VN")}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          {batch.errorRows > 0 && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                void downloadBatchErrors(batch.id);
                              }}
                              className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-bold text-slate-600 hover:bg-slate-50"
                            >
                              File lỗi
                            </button>
                          )}
                          {["COMMITTED", "APPROVED", "COMMITTED_WITH_ERRORS"].includes(batch.status) && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                openRollbackDialog(batch);
                              }}
                              className="rounded-lg border border-rose-200 px-2 py-1 text-xs font-bold text-rose-700 hover:bg-rose-50"
                            >
                              Rollback
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {(selectedBatchId || selectedBatch || batchDetailLoading || batchDetailError) && (
          <section ref={batchDetailRef} className="scroll-mt-4 bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="font-bold">Chi tiết batch{selectedBatch ? `: ${selectedBatch.fileName}` : ""}</h2>
                <p className="text-xs text-slate-500 mt-1">
                  {selectedBatch ? (
                    <>
                      {selectedBatch.validRows}/{selectedBatch.totalRows} dòng, trạng thái {selectedBatch.status}
                      {selectedBatch.rolledBackAt ? `, rollback lúc ${new Date(selectedBatch.rolledBackAt).toLocaleString("vi-VN")}` : ""}.
                    </>
                  ) : "Chọn một dòng lịch sử để xem chi tiết dữ liệu đã import."}
                </p>
              </div>
              <button
                onClick={() => {
                  setSelectedBatch(null);
                  setSelectedBatchId("");
                  setBatchDetailError("");
                }}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50"
              >
                Đóng
              </button>
            </div>
            <div className="relative overflow-x-auto max-h-[420px] min-h-[140px]">
              {batchDetailLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/75 text-sm font-semibold text-blue-700 backdrop-blur-[1px]">
                  Đang tải chi tiết batch import...
                </div>
              )}
              {batchDetailError ? (
                <div className="p-5">
                  <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
                    {batchDetailError}
                  </p>
                </div>
              ) : selectedBatchRows.length > 0 ? (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-500 uppercase sticky top-0">
                    <tr>
                      {selectedBatchColumns.map((key) => (
                          <th key={key} className="px-4 py-3 whitespace-nowrap">{key}</th>
                        ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {selectedBatchRows.slice(0, 100).map((row, index) => (
                      <tr key={index} className="hover:bg-slate-50">
                        {selectedBatchColumns.map((key) => (
                          <td key={key} className="px-4 py-3 whitespace-nowrap">{formatDetailValue(row[key])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="flex min-h-[140px] items-center justify-center px-4 text-sm text-slate-400">
                  Chưa có dữ liệu chi tiết.
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {rollbackTarget && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/50 px-4 backdrop-blur-[1px]">
          <button
            type="button"
            aria-label="Đóng hộp thoại rollback"
            className="absolute inset-0 cursor-default"
            onClick={() => !rollbackSaving && setRollbackTarget(null)}
          />
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="rollback-dialog-title"
            onSubmit={(event) => {
              event.preventDefault();
              void rollbackBatch();
            }}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600">
                <span className="material-symbols-outlined">history</span>
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="rollback-dialog-title" className="text-base font-bold text-slate-900">Rollback batch import</h2>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Dữ liệu do batch tạo sẽ được hoàn tác nếu chưa phát sinh nghiệp vụ liên quan.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRollbackTarget(null)}
                disabled={rollbackSaving}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">File import</p>
                <p className="mt-1 truncate text-sm font-semibold text-slate-800" title={rollbackTarget.fileName}>
                  {rollbackTarget.fileName}
                </p>
              </div>

              <label className="block text-sm font-semibold text-slate-700">
                Lý do rollback <span className="text-rose-600">*</span>
                <textarea
                  autoFocus
                  rows={3}
                  value={rollbackNote}
                  onChange={(event) => {
                    setRollbackNote(event.target.value);
                    if (rollbackError) setRollbackError("");
                  }}
                  disabled={rollbackSaving}
                  placeholder="Ví dụ: Import nhầm dữ liệu kiểm thử"
                  className="mt-2 w-full resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
                />
              </label>

              {rollbackError && (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
                  {rollbackError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4">
              <button
                type="button"
                onClick={() => setRollbackTarget(null)}
                disabled={rollbackSaving}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={rollbackSaving}
                className="inline-flex min-w-[132px] items-center justify-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {rollbackSaving ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    Đang rollback...
                  </>
                ) : "Xác nhận rollback"}
              </button>
            </div>
          </form>
        </div>
      )}

      {manualOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40">
          <button
            type="button"
            aria-label="Đóng thêm mới"
            className="absolute inset-0 cursor-default"
            onClick={() => !manualSaving && setManualOpen(false)}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveManualRow();
            }}
            className="relative flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-2xl"
          >
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase text-blue-600">Nhập nhanh</p>
                  <h2 className="mt-1 text-lg font-bold text-slate-900">{title}</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Nhập một dòng dữ liệu ít phát sinh. Hệ thống vẫn dùng validation và lịch sử import như file Excel.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setManualOpen(false)}
                  disabled={manualSaving}
                  className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>

              {requiresBranch && (
                <p className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700">
                  Chi nhánh áp dụng: {branchCode ? storeLabel(branchCode) : "Chưa chọn"}
                </p>
              )}
            </div>

            <div className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-4">
              {manualFields.length === 0 ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  Không tìm thấy cấu trúc field của template này.
                </p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {manualFields.map((field) => {
                    const masterType = masterDataFieldTypes[field.field];
                    const rawOptions = masterType ? masterOptions[masterType] : undefined;
                    const masterLoading = Boolean(masterType) && !rawOptions;
                    const selectOptions = masterType
                      ? filterMasterOptions(field.field, templateCode, rawOptions || [], manualValues).map((option) => ({
                          value: option.code,
                          label: option.name || option.code,
                          subLabel: option.code,
                        }))
                      : null;

                    return (
                    <label key={field.field} className="min-w-0 text-xs font-bold text-slate-600">
                      {field.label}{field.required ? " *" : ""}
                      {selectOptions ? (
                        <>
                          <SearchableSelect
                            value={manualValues[field.field] || ""}
                            onChange={(value) => setManualValues((current) => {
                              const next = { ...current, [field.field]: value };
                              // Chọn mã đối tác thì điền luôn tên để khỏi gõ lại.
                              const nameField = partnerNameFields[field.field];
                              if (nameField && Object.prototype.hasOwnProperty.call(current, nameField)) {
                                const picked = rawOptions?.find((option) => option.code === value);
                                if (picked) next[nameField] = picked.name || "";
                              }
                              return next;
                            })}
                            options={selectOptions}
                            placeholder={masterLoading ? "Đang tải danh mục..." : `-- Chọn ${field.label.toLowerCase()} --`}
                            searchPlaceholder="Gõ tên hoặc mã để tìm..."
                            required={field.required}
                            className="mt-1"
                          />
                          {selectOptions.length === 0 && !masterLoading && (
                            <span className="mt-1 block text-[11px] font-medium text-amber-700">
                              Chưa có danh mục phù hợp. Hãy khai báo trong Cấu hình Danh mục trước.
                            </span>
                          )}
                        </>
                      ) : field.type === "date" ? (
                        <DateInput
                          value={manualValues[field.field] || ""}
                          onChange={(value) => setManualValues((current) => ({ ...current, [field.field]: value }))}
                          className="mt-1"
                          required={field.required}
                          ariaLabel={field.label}
                        />
                      ) : (
                        <input
                          type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                          step={field.type === "integer" ? 1 : "any"}
                          value={manualValues[field.field] || ""}
                          onChange={(event) => setManualValues((current) => ({ ...current, [field.field]: event.target.value }))}
                          className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                          required={field.required}
                          placeholder={field.type === "number" || field.type === "integer" ? "0" : field.field}
                        />
                      )}
                    </label>
                    );
                  })}
                </div>
              )}

              {manualError && (
                <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
                  {manualError}
                </p>
              )}
            </div>

            <div className="border-t border-slate-200 bg-slate-50 px-5 py-4">
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setManualOpen(false)}
                  disabled={manualSaving}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  Huỷ
                </button>
                <button
                  type="submit"
                  disabled={manualSaving || manualFields.length === 0}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {manualSaving ? "Đang lưu..." : "Lưu & commit"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
