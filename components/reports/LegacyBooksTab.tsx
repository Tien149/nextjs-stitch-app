"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoSession } from "@/lib/auth-demo";
import { hasFullBranchAccess, visibleStoreOptions } from "@/lib/branch-labels";
import { cellMatches, searchTerms } from "@/lib/legacy-books-search";

/**
 * Tab "Sổ sách kế toán trước 08/2026" (Báo cáo tài chính, khách 28/11/2026): chị Bình muốn một chỗ
 * lưu các file Excel sổ sách cũ, cần tìm gì thì gõ một ô là ra, khỏi mở từng file. Chỉ lưu trữ và
 * tra cứu — không đụng số liệu báo cáo.
 */

type SheetInfo = { index: number; name: string; rows: number; lastRow: number; columns: number };
type LegacyFile = {
  id: string;
  fileName: string;
  branchCode: string;
  periodLabel: string;
  note: string;
  sheetsJson: SheetInfo[];
  rowCount: number;
  fileSize: number;
  uploadedBy: string | null;
  createdAt: string;
};
type SearchResult = { fileId: string; sheetIndex: number; sheetName: string; rowNo: number; cells: string[] };
type UploadItem = { name: string; status: "waiting" | "uploading" | "done" | "error"; message?: string };
type Viewer = { fileId: string; sheetIndex: number; focusRow: number | null };

const ALL_COMPANY = "ALL";
const MAX_BYTES = 25 * 1024 * 1024;

function fileSizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

/** Chữ cái cột kiểu Excel: 0 → A, 26 → AA. */
function columnLetter(index: number) {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    label = String.fromCharCode(65 + rest) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

async function readError(response: Response) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `Lỗi ${response.status}`;
  } catch {
    return response.status === 413 ? "File quá lớn (tối đa 25 MB)." : `Lỗi ${response.status}`;
  }
}

export default function LegacyBooksTab({ user, canCreate, canEdit, canDelete }: { user: DemoSession | null; canCreate: boolean; canEdit: boolean; canDelete: boolean }) {
  const fullAccess = hasFullBranchAccess(user);
  const stores = visibleStoreOptions(user);
  const branchChoices = useMemo(
    () => [...(fullAccess ? [{ code: ALL_COMPANY, label: "Toàn công ty" }] : []), ...stores],
    [fullAccess, stores],
  );
  const branchLabel = useCallback((code: string) => branchChoices.find((option) => option.code === code)?.label || (code === ALL_COMPANY ? "Toàn công ty" : code), [branchChoices]);

  const [files, setFiles] = useState<LegacyFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [message, setMessage] = useState("");

  const [query, setQuery] = useState("");
  const [filterBranch, setFilterBranch] = useState("*");
  const [filterPeriod, setFilterPeriod] = useState("");
  const [filterFile, setFilterFile] = useState("");
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<{ query: string; terms: string[]; results: SearchResult[]; hasMore: boolean } | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editing, setEditing] = useState<LegacyFile | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const response = await fetch("/api/legacy-books?view=files");
      if (!response.ok) {
        setMessage(await readError(response));
        return;
      }
      const body = (await response.json()) as { files: LegacyFile[] };
      setFiles(body.files);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  useEffect(() => {
    // Nạp danh sách file một lần khi mở tab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFiles();
  }, [loadFiles]);

  const fileById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const periodOptions = useMemo(() => [...new Set(files.map((file) => file.periodLabel).filter(Boolean))].sort((a, b) => b.localeCompare(a, "vi")), [files]);

  const runSearch = async () => {
    const text = query.trim();
    if (searchTerms(text).length === 0) {
      setSearch(null);
      return;
    }
    setSearching(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ view: "search", q: text });
      if (filterBranch !== "*") params.set("branchCode", filterBranch);
      if (filterPeriod) params.set("periodLabel", filterPeriod);
      if (filterFile) params.set("fileId", filterFile);
      const response = await fetch(`/api/legacy-books?${params.toString()}`);
      if (!response.ok) {
        setMessage(await readError(response));
        return;
      }
      const body = (await response.json()) as { terms: string[]; results: SearchResult[]; hasMore: boolean };
      setSearch({ query: text, ...body });
    } finally {
      setSearching(false);
    }
  };

  const removeFile = async (file: LegacyFile) => {
    if (!window.confirm(`Xoá hẳn file "${file.fileName}" (${file.rowCount.toLocaleString("vi-VN")} dòng)? Xoá rồi không khôi phục được — cần thì tải về giữ trước.`)) return;
    const response = await fetch(`/api/legacy-books?id=${encodeURIComponent(file.id)}`, { method: "DELETE" });
    if (!response.ok) {
      setMessage(await readError(response));
      return;
    }
    setMessage(`Đã xoá file ${file.fileName}.`);
    setSearch(null);
    void loadFiles();
  };

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Sổ sách kế toán trước 08/2026</h2>
            <p className="text-xs text-slate-500">Kho lưu file Excel sổ sách cũ để tra cứu — không ảnh hưởng số liệu báo cáo. Gõ số tiền, tên NCC, số chứng từ, diễn giải… là tìm trên tất cả file.</p>
          </div>
          {canCreate && (
            <button type="button" className="primary-button" onClick={() => setUploadOpen(true)}>
              <span className="material-symbols-outlined text-lg">upload_file</span>
              Tải file lên
            </button>
          )}
        </div>

        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch();
          }}
        >
          <label className="min-w-[240px] flex-1">
            <span className="text-xs font-semibold text-slate-600">Tìm trong sổ sách</span>
            <div className="relative">
              <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 mt-0.5 -translate-y-1/2 text-lg text-slate-400">search</span>
              <input
                className="control pl-10"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder='VD: 1.500.000 · Kim Long · PC-0123 · "tiền điện tháng 5"'
                autoFocus
              />
            </div>
          </label>
          <label className="w-40">
            <span className="text-xs font-semibold text-slate-600">Cửa hàng</span>
            <select className="control" value={filterBranch} onChange={(event) => setFilterBranch(event.target.value)}>
              <option value="*">Tất cả</option>
              {branchChoices.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
          <label className="w-36">
            <span className="text-xs font-semibold text-slate-600">Kỳ / Năm</span>
            <select className="control" value={filterPeriod} onChange={(event) => setFilterPeriod(event.target.value)}>
              <option value="">Tất cả</option>
              {periodOptions.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="w-56">
            <span className="text-xs font-semibold text-slate-600">File</span>
            <select className="control" value={filterFile} onChange={(event) => setFilterFile(event.target.value)}>
              <option value="">Tất cả file</option>
              {files.map((file) => <option key={file.id} value={file.id}>{file.fileName}</option>)}
            </select>
          </label>
          <button type="submit" className="primary-button" disabled={searching}>
            <span className={`material-symbols-outlined text-lg ${searching ? "animate-spin" : ""}`}>{searching ? "progress_activity" : "search"}</span>
            Tìm
          </button>
        </form>
        <p className="mt-2 text-[11px] text-slate-400">Nhiều từ = dòng phải có đủ các từ. Cụm trong ngoặc kép tìm nguyên cụm. Không phân biệt dấu, hoa thường; số tiền gõ có hay không có dấu chấm đều được.</p>
      </section>

      {message && <p className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700">{message}</p>}

      {search && (
        <section className="table-panel">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <h3 className="text-sm font-bold text-slate-900">
              {search.results.length === 0 ? "Không tìm thấy dòng nào" : `${search.results.length}${search.hasMore ? "+" : ""} dòng có "${search.query}"`}
            </h3>
            {search.hasMore && <p className="text-xs text-amber-700">Chỉ hiện 200 dòng đầu — thêm từ khoá hoặc lọc theo file/kỳ để thu hẹp.</p>}
          </div>
          {search.results.length > 0 && (
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-white text-left text-[11px] uppercase tracking-wide text-slate-500 shadow-[0_1px_0_#e2e8f0]">
                  <tr>
                    <th className="px-3 py-2 font-semibold">File · Sheet · Dòng</th>
                    <th className="px-3 py-2 font-semibold">Nội dung dòng</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {search.results.map((row) => {
                    const file = fileById.get(row.fileId);
                    return (
                      <tr key={`${row.fileId}-${row.sheetIndex}-${row.rowNo}`} className="border-t border-slate-100 align-top hover:bg-blue-50/40">
                        <td className="w-64 px-3 py-2">
                          <p className="font-semibold text-slate-800 break-all">{file?.fileName || "—"}</p>
                          <p className="text-xs text-slate-500">{row.sheetName} · dòng {row.rowNo}{file ? ` · ${branchLabel(file.branchCode)}${file.periodLabel ? ` · ${file.periodLabel}` : ""}` : ""}</p>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {row.cells.map((cell, index) => cell ? (
                              <span
                                key={index}
                                title={`Cột ${columnLetter(index)}`}
                                className={`max-w-[320px] truncate rounded px-1.5 py-0.5 text-xs ${cellMatches(cell, search.terms) ? "bg-amber-200 font-semibold text-amber-950" : "bg-slate-100 text-slate-700"}`}
                              >
                                {cell}
                              </span>
                            ) : null)}
                          </div>
                        </td>
                        <td className="w-24 px-3 py-2 text-right">
                          <button type="button" className="secondary-button !min-h-8 !px-2.5 !py-1 text-xs whitespace-nowrap" onClick={() => setViewer({ fileId: row.fileId, sheetIndex: row.sheetIndex, focusRow: row.rowNo })}>
                            Xem sheet
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="table-panel">
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-900">File đã lưu ({files.length})</h3>
          <button type="button" className="icon-button" title="Tải lại danh sách" onClick={() => void loadFiles()}>
            <span className="material-symbols-outlined text-lg">refresh</span>
          </button>
        </div>
        {filesLoading ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">Đang tải...</p>
        ) : files.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">Chưa có file nào.{canCreate ? " Bấm “Tải file lên” để thêm sổ sách cũ." : ""}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Tên file</th>
                  <th className="px-3 py-2 font-semibold">Cửa hàng</th>
                  <th className="px-3 py-2 font-semibold">Kỳ / Năm</th>
                  <th className="px-3 py-2 font-semibold">Ghi chú</th>
                  <th className="px-3 py-2 text-right font-semibold">Sheet · Dòng</th>
                  <th className="px-3 py-2 font-semibold">Tải lên</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr key={file.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2">
                      <button type="button" className="text-left font-semibold text-blue-700 hover:underline break-all" onClick={() => setViewer({ fileId: file.id, sheetIndex: file.sheetsJson.find((sheet) => sheet.rows > 0)?.index ?? 0, focusRow: null })}>
                        {file.fileName}
                      </button>
                      <p className="text-xs text-slate-400">{fileSizeLabel(file.fileSize)}</p>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{branchLabel(file.branchCode)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{file.periodLabel || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{file.note || "—"}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{file.sheetsJson.length} · {file.rowCount.toLocaleString("vi-VN")}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-500">{file.uploadedBy || "—"}<br />{dateLabel(file.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <a className="icon-button" title="Tải file gốc" href={`/api/legacy-books?view=download&fileId=${encodeURIComponent(file.id)}`}>
                          <span className="material-symbols-outlined text-lg">download</span>
                        </a>
                        {canEdit && (
                          <button type="button" className="icon-button" title="Sửa cửa hàng / kỳ / ghi chú" onClick={() => setEditing(file)}>
                            <span className="material-symbols-outlined text-lg">edit</span>
                          </button>
                        )}
                        {canDelete && (
                          <button type="button" className="icon-button text-red-600" title="Xoá file" onClick={() => void removeFile(file)}>
                            <span className="material-symbols-outlined text-lg">delete</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {uploadOpen && (
        <UploadDialog
          branchChoices={branchChoices}
          periodOptions={periodOptions}
          onClose={(uploaded) => {
            setUploadOpen(false);
            if (uploaded) {
              setSearch(null);
              void loadFiles();
            }
          }}
        />
      )}
      {editing && (
        <EditDialog
          file={editing}
          branchChoices={branchChoices}
          periodOptions={periodOptions}
          onClose={(saved) => {
            setEditing(null);
            if (saved) void loadFiles();
          }}
        />
      )}
      {viewer && fileById.get(viewer.fileId) && (
        <SheetViewer file={fileById.get(viewer.fileId)!} viewer={viewer} terms={search?.terms || []} onChange={setViewer} onClose={() => setViewer(null)} />
      )}
    </div>
  );
}

function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-2 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`w-full rounded-xl bg-white shadow-xl ${wide ? "max-w-[1400px]" : "max-w-lg"}`}>
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <h3 className="min-w-0 truncate text-base font-bold text-slate-900">{title}</h3>
          <button type="button" className="icon-button shrink-0" onClick={onClose} title="Đóng">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function MetaFields({ branchChoices, periodOptions, value, onChange }: {
  branchChoices: Array<{ code: string; label: string }>;
  periodOptions: string[];
  value: { branchCode: string; periodLabel: string; note: string };
  onChange: (value: { branchCode: string; periodLabel: string; note: string }) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className="text-xs font-semibold text-slate-600">Cửa hàng</span>
          <select className="control" value={value.branchCode} onChange={(event) => onChange({ ...value, branchCode: event.target.value })}>
            {branchChoices.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
          </select>
        </label>
        <label>
          <span className="text-xs font-semibold text-slate-600">Kỳ / Năm</span>
          <input className="control" list="legacy-book-periods" value={value.periodLabel} maxLength={60} placeholder="VD: 2025 hoặc T01-T07/2026" onChange={(event) => onChange({ ...value, periodLabel: event.target.value })} />
          <datalist id="legacy-book-periods">{periodOptions.map((option) => <option key={option} value={option} />)}</datalist>
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-semibold text-slate-600">Ghi chú</span>
        <input className="control" value={value.note} maxLength={500} placeholder="VD: Sổ nhật ký chung, Sổ quỹ tiền mặt…" onChange={(event) => onChange({ ...value, note: event.target.value })} />
      </label>
    </>
  );
}

function UploadDialog({ branchChoices, periodOptions, onClose }: { branchChoices: Array<{ code: string; label: string }>; periodOptions: string[]; onClose: (uploaded: boolean) => void }) {
  const [meta, setMeta] = useState({ branchCode: branchChoices[0]?.code || ALL_COMPANY, periodLabel: "", note: "" });
  const [picked, setPicked] = useState<File[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const uploadedRef = useRef(false);

  const start = async () => {
    if (picked.length === 0) return;
    setRunning(true);
    const list: UploadItem[] = picked.map((file) => ({ name: file.name, status: "waiting" }));
    setItems([...list]);
    for (let index = 0; index < picked.length; index += 1) {
      const file = picked[index];
      if (file.size > MAX_BYTES) {
        list[index] = { name: file.name, status: "error", message: "Lớn hơn 25 MB — tách file rồi tải lại." };
        setItems([...list]);
        continue;
      }
      list[index] = { name: file.name, status: "uploading" };
      setItems([...list]);
      const form = new FormData();
      form.set("file", file);
      form.set("branchCode", meta.branchCode);
      form.set("periodLabel", meta.periodLabel);
      form.set("note", meta.note);
      try {
        const response = await fetch("/api/legacy-books", { method: "POST", body: form });
        if (response.ok) {
          const body = (await response.json()) as { rowCount: number; sheetCount: number };
          list[index] = { name: file.name, status: "done", message: `${body.sheetCount} sheet · ${body.rowCount.toLocaleString("vi-VN")} dòng` };
          uploadedRef.current = true;
        } else {
          list[index] = { name: file.name, status: "error", message: await readError(response) };
        }
      } catch {
        list[index] = { name: file.name, status: "error", message: "Mất kết nối — thử lại." };
      }
      setItems([...list]);
    }
    setRunning(false);
    setPicked([]);
  };

  return (
    <Modal title="Tải sổ sách cũ lên" onClose={() => !running && onClose(uploadedRef.current)}>
      <div className="space-y-3 p-4">
        <label className="block">
          <span className="text-xs font-semibold text-slate-600">Chọn file (chọn được nhiều file cùng lúc, mỗi file tối đa 25 MB)</span>
          <input
            type="file"
            multiple
            accept=".xlsx,.xls,.xlsm,.csv"
            className="control file:mr-3 file:rounded file:border-0 file:bg-blue-50 file:px-3 file:py-1 file:text-sm file:font-semibold file:text-blue-700"
            disabled={running}
            onChange={(event) => setPicked(Array.from(event.target.files || []))}
          />
        </label>
        <MetaFields branchChoices={branchChoices} periodOptions={periodOptions} value={meta} onChange={setMeta} />
        <p className="text-[11px] text-slate-500">Cửa hàng, kỳ/năm và ghi chú áp cho mọi file đang chọn — sửa riêng từng file sau được.</p>
        {items.length > 0 && (
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2 text-sm">
            {items.map((item, index) => (
              <li key={`${item.name}-${index}`} className="flex items-start gap-2">
                <span className={`material-symbols-outlined text-base ${item.status === "done" ? "text-emerald-600" : item.status === "error" ? "text-red-600" : item.status === "uploading" ? "animate-spin text-blue-600" : "text-slate-400"}`}>
                  {item.status === "done" ? "check_circle" : item.status === "error" ? "error" : item.status === "uploading" ? "progress_activity" : "schedule"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="break-all font-medium text-slate-800">{item.name}</span>
                  {item.message && <span className={`block text-xs ${item.status === "error" ? "text-red-600" : "text-slate-500"}`}>{item.message}</span>}
                  {item.status === "uploading" && <span className="block text-xs text-slate-500">Đang tải lên và đọc file…</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
        <button type="button" className="secondary-button" disabled={running} onClick={() => onClose(uploadedRef.current)}>Đóng</button>
        <button type="button" className={`primary-button ${picked.length === 0 || running ? "button-disabled" : ""}`} disabled={picked.length === 0 || running} onClick={() => void start()}>
          <span className="material-symbols-outlined text-lg">upload</span>
          {running ? "Đang tải lên…" : `Tải lên${picked.length > 0 ? ` ${picked.length} file` : ""}`}
        </button>
      </div>
    </Modal>
  );
}

function EditDialog({ file, branchChoices, periodOptions, onClose }: { file: LegacyFile; branchChoices: Array<{ code: string; label: string }>; periodOptions: string[]; onClose: (saved: boolean) => void }) {
  const [meta, setMeta] = useState({ branchCode: file.branchCode, periodLabel: file.periodLabel, note: file.note });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError("");
    const response = await fetch("/api/legacy-books", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: file.id, ...meta }) });
    setSaving(false);
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    onClose(true);
  };
  return (
    <Modal title={file.fileName} onClose={() => onClose(false)}>
      <div className="space-y-3 p-4">
        <MetaFields branchChoices={branchChoices} periodOptions={periodOptions} value={meta} onChange={setMeta} />
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
        <button type="button" className="secondary-button" onClick={() => onClose(false)}>Huỷ</button>
        <button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>Lưu</button>
      </div>
    </Modal>
  );
}

function SheetViewer({ file, viewer, terms, onChange, onClose }: { file: LegacyFile; viewer: Viewer; terms: string[]; onChange: (viewer: Viewer) => void; onClose: () => void }) {
  const [page, setPage] = useState<{ key: string; rows: Array<{ rowNo: number; cells: string[] }>; nextFrom: number | null; prevFrom: number | null } | null>(null);
  const [from, setFrom] = useState(() => (viewer.focusRow ? Math.max(1, viewer.focusRow - 30) : 1));
  const [error, setError] = useState("");
  const focusRef = useRef<HTMLTableRowElement | null>(null);
  const sheet = file.sheetsJson.find((item) => item.index === viewer.sheetIndex);
  const key = `${file.id}|${viewer.sheetIndex}|${from}`;

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ view: "sheet", fileId: file.id, sheet: String(viewer.sheetIndex), from: String(from) });
    void fetch(`/api/legacy-books?${params.toString()}`).then(async (response) => {
      if (cancelled) return;
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const body = (await response.json()) as { rows: Array<{ rowNo: number; cells: string[] }>; nextFrom: number | null; prevFrom: number | null };
      if (!cancelled) setPage({ key, ...body });
    });
    return () => {
      cancelled = true;
    };
  }, [file.id, from, key, viewer.sheetIndex]);

  useEffect(() => {
    if (page?.key === key) focusRef.current?.scrollIntoView({ block: "center" });
  }, [key, page]);

  const loading = !page || page.key !== key;
  const columns = Math.max(sheet?.columns || 0, ...(page?.rows || []).map((row) => row.cells.length));

  const openSheet = (sheetIndex: number) => {
    setFrom(1);
    onChange({ fileId: file.id, sheetIndex, focusRow: null });
  };

  return (
    <Modal title={file.fileName} onClose={onClose} wide>
      <div className="flex flex-wrap gap-1 border-b border-slate-200 px-4 py-2">
        {file.sheetsJson.map((item) => (
          <button
            key={item.index}
            type="button"
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${item.index === viewer.sheetIndex ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
            onClick={() => openSheet(item.index)}
          >
            {item.name} <span className="opacity-70">({item.rows.toLocaleString("vi-VN")})</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs text-slate-500">
        <span>
          {page && !loading && page.rows.length > 0 ? `Dòng ${page.rows[0].rowNo.toLocaleString("vi-VN")} – ${page.rows[page.rows.length - 1].rowNo.toLocaleString("vi-VN")}` : ""}
          {sheet ? ` / ${sheet.lastRow.toLocaleString("vi-VN")}` : ""}
          {viewer.focusRow ? ` · dòng tìm thấy: ${viewer.focusRow}` : ""}
        </span>
        <span className="flex gap-2">
          <button type="button" className="secondary-button !min-h-8 !px-2.5 !py-1 text-xs" disabled={loading || !page?.prevFrom} onClick={() => page?.prevFrom && setFrom(page.prevFrom)}>‹ Trước</button>
          <button type="button" className="secondary-button !min-h-8 !px-2.5 !py-1 text-xs" disabled={loading || !page?.nextFrom} onClick={() => page?.nextFrom && setFrom(page.nextFrom)}>Sau ›</button>
          <a className="secondary-button !min-h-8 !px-2.5 !py-1 text-xs" href={`/api/legacy-books?view=download&fileId=${encodeURIComponent(file.id)}`}>
            <span className="material-symbols-outlined text-base">download</span>File gốc
          </a>
        </span>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-600">{error}</p>}
      <div className="max-h-[72vh] overflow-auto border-t border-slate-200">
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">Đang tải sheet…</p>
        ) : page.rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">Sheet trống.</p>
        ) : (
          <table className="border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-slate-100 text-slate-500">
              <tr>
                <th className="sticky left-0 z-20 w-12 border border-slate-200 bg-slate-100 px-2 py-1" />
                {Array.from({ length: columns }, (_, index) => <th key={index} className="min-w-[80px] border border-slate-200 px-2 py-1 font-semibold">{columnLetter(index)}</th>)}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row) => {
                const focused = row.rowNo === viewer.focusRow;
                return (
                  <tr key={row.rowNo} ref={focused ? focusRef : undefined} className={focused ? "bg-amber-100" : ""}>
                    <td className={`sticky left-0 border border-slate-200 px-2 py-1 text-right font-semibold ${focused ? "bg-amber-200 text-amber-900" : "bg-slate-50 text-slate-400"}`}>{row.rowNo}</td>
                    {Array.from({ length: columns }, (_, index) => {
                      const cell = row.cells[index] || "";
                      return (
                        <td key={index} className={`max-w-[360px] whitespace-pre-wrap border border-slate-200 px-2 py-1 align-top text-slate-800 ${cellMatches(cell, terms) ? "bg-amber-300/70 font-semibold" : ""}`}>
                          {cell}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
