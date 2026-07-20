"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { displayRoleName, storeLabel } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

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

type BatchDetail = Batch & {
  bankTransactions?: Record<string, string | number | null>[];
  revenueRows?: Record<string, string | number | null>[];
  payrollRows?: Record<string, string | number | null>[];
  importRows?: Record<string, string | number | null>[];
  vouchers?: Record<string, string | number | null>[];
  moneyTransfers?: Record<string, string | number | null>[];
  debtRecords?: Record<string, string | number | null>[];
};

type TemplateField = {
  field: string;
  label: string;
  required: boolean;
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
}: ImportUploadPageProps) {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<BatchDetail | null>(null);
  const [message, setMessage] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [branchCode, setBranchCode] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingFields, setMappingFields] = useState<TemplateField[]>([]);
  const [mappingDirty, setMappingDirty] = useState(false);
  const [showTemplateLink, setShowTemplateLink] = useState(false);

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
    void fetch("/api/master-data?type=BRANCH&status=ACTIVE", { signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : [])
      .then((items: BranchOption[]) => setBranches(items.map((item) => ({ code: item.code, name: item.name }))))
      .catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setMessage("Không tải được danh sách chi nhánh.");
      });
    return () => controller.abort();
  }, [isCheckingAuth, requiresBranch]);

  const errorRows = useMemo(() => preview?.rows.filter((row) => row.errors.length > 0) || [], [preview]);

  const loadBatches = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(apiPath, { signal });
    if (response.ok && !signal?.aborted) setBatches((await response.json()) as Batch[]);
  }, [apiPath]);

  const loadBatchDetail = async (batchId: string) => {
    const response = await fetch(withQuery(apiPath, { batchId }));
    if (response.ok) setSelectedBatch((await response.json()) as BatchDetail);
  };

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
      setMessage("");
      void loadBatches(controller.signal).catch((error) => {
        if (error instanceof Error && error.name !== "AbortError") setMessage("Không tải được lịch sử import.");
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [apiPath, isCheckingAuth, loadBatches]);

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
      if (Object.keys(mapping).length > 0) formData.append("mappingJson", JSON.stringify(mapping));

      const response = await fetch(withQuery(apiPath, { mode }), {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      if (payload.preview) {
        setPreview(payload.preview as PreviewPayload);
        setMapping((payload.preview as PreviewPayload).mapping || {});
        setMappingFields((payload.template?.fields || []) as TemplateField[]);
        setMappingDirty(false);
      }
      if (!response.ok) throw new Error(payload.error || "Không xử lý được file import");

      setMessage(mode === "preview" ? "Đã đọc file, vui lòng kiểm tra preview." : "Đã commit dữ liệu import.");
      if (mode === "commit") await loadBatches();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi import file");
    } finally {
      setIsUploading(false);
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

  const rollbackBatch = async (batch: Batch) => {
    const note = window.prompt(`Nhập lý do rollback batch "${batch.fileName}"`);
    if (note === null) return;
    if (!note.trim()) {
      setMessage("Rollback bắt buộc nhập lý do.");
      return;
    }
    setMessage("");
    const response = await fetch(apiPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ROLLBACK_BATCH", batchId: batch.id, note }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Rollback batch thất bại.");
      await loadBatches();
      return;
    }
    setSelectedBatch(null);
    setMessage(`Đã rollback batch ${batch.fileName}.`);
    await loadBatches();
  };

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/")}
            className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center"
            title="Về dashboard"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-lg font-bold">{title}</h1>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
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
            {showTemplateLink && (
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

            {message && <p className="h-9 max-w-[360px] truncate rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2 text-xs shadow-sm">{message}</p>}
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
                        <tr key={row.rowNumber} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-bold">{row.rowNumber}</td>
                          {primaryFields.map((field) => (
                            <td key={field} className="px-4 py-3 whitespace-nowrap">
                              {String(row.values[field] ?? "-")}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-rose-700">{row.errors.join("; ") || "-"}</td>
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
                    <tr key={batch.id} onClick={() => loadBatchDetail(batch.id)} className="hover:bg-slate-50 cursor-pointer">
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
                                void rollbackBatch(batch);
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

        {selectedBatch && (
          <section className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="font-bold">Chi tiết batch: {selectedBatch.fileName}</h2>
                <p className="text-xs text-slate-500 mt-1">
                  {selectedBatch.validRows}/{selectedBatch.totalRows} dòng, trạng thái {selectedBatch.status}
                  {selectedBatch.rolledBackAt ? `, rollback lúc ${new Date(selectedBatch.rolledBackAt).toLocaleString("vi-VN")}` : ""}.
                </p>
              </div>
              <button onClick={() => setSelectedBatch(null)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">
                Đóng
              </button>
            </div>
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase sticky top-0">
                  <tr>
                    {Object.keys(
                      selectedBatch.bankTransactions?.[0] ||
                      selectedBatch.revenueRows?.[0] ||
                      selectedBatch.payrollRows?.[0] ||
                      selectedBatch.vouchers?.[0] ||
                      selectedBatch.moneyTransfers?.[0] ||
                      selectedBatch.debtRecords?.[0] ||
                      selectedBatch.importRows?.[0] ||
                      {},
                    )
                      .filter((key) => !["id", "importBatchId", "createdAt"].includes(key))
                      .slice(0, 10)
                      .map((key) => (
                        <th key={key} className="px-4 py-3 whitespace-nowrap">{key}</th>
                      ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(
                    selectedBatch.bankTransactions ||
                    selectedBatch.revenueRows ||
                    selectedBatch.payrollRows ||
                    selectedBatch.vouchers ||
                    selectedBatch.moneyTransfers ||
                    selectedBatch.debtRecords ||
                    selectedBatch.importRows ||
                    []
                  ).slice(0, 100).map((row, index) => (
                    <tr key={index} className="hover:bg-slate-50">
                      {Object.entries(row)
                        .filter(([key]) => !["id", "importBatchId", "createdAt"].includes(key))
                        .slice(0, 10)
                        .map(([key, value]) => (
                          <td key={key} className="px-4 py-3 whitespace-nowrap">{String(value ?? "-")}</td>
                        ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
