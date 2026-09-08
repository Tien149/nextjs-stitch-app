"use client";

import { useEffect, useMemo, useState } from "react";
import RevenueDaySummary from "@/app/imports/RevenueDaySummary";
import { DateInput } from "@/components/DateInput";
import { type ImportFieldDefinition } from "@/lib/import-templates";
import { type RevenueDayInput } from "@/lib/revenue-day-summary";

/**
 * Popup xem trước & chỉnh sửa file doanh thu POS trước khi import chính thức (yêu cầu
 * 08/09/2026): đọc file xong là mở bảng này, người dùng sửa thẳng ô sai, bấm "Kiểm tra lại"
 * để hệ thống chấm lỗi lại, và chỉ khi bấm "Lưu import" dữ liệu mới vào hệ thống.
 *
 * Bảng không tự tính toán gì: mọi ô sửa được gom vào `edits` (key theo sheet + số dòng) và
 * gửi kèm mỗi lần gọi API, server đọc lại file gốc rồi áp bản sửa lên (applyImportRowEdits).
 * Nhờ vậy số hiện trên bảng sau "Kiểm tra lại" luôn là số server sẽ ghi, không phải số
 * trình duyệt tự đoán.
 */

export type PreviewRow = {
  sheetName: string;
  rowNumber: number;
  values: Record<string, string | number | null>;
  errors: string[];
};

export type PreviewPayload = {
  sheetName: string;
  headerRowNumber: number;
  headers: string[];
  mapping: Record<string, string>;
  rows: PreviewRow[];
  totalRows: number;
  validRows: number;
  errorRows: number;
};

/** Bản đồ ô đã sửa: key dòng -> { field: chuỗi nhập }. */
export type RowEdits = Record<string, Record<string, string>>;

export const previewRowKey = (row: Pick<PreviewRow, "sheetName" | "rowNumber">) => `${row.sheetName}#${row.rowNumber}`;

/** Đổi bản đồ sửa thành mảng `ImportRowEdit` gửi lên API (trường rowEditsJson). */
export function rowEditsToPayload(edits: RowEdits) {
  return Object.entries(edits).map(([key, values]) => {
    const at = key.lastIndexOf("#");
    return { sheetName: key.slice(0, at), rowNumber: Number(key.slice(at + 1)), values };
  });
}

/**
 * Giá trị server đã đọc, quy về chuỗi để đổ vào ô nhập: ngày ISO -> yyyy-mm-dd (DateInput
 * dùng dạng này), số -> chữ số, trống -> "".
 */
function cellText(field: ImportFieldDefinition, value: string | number | null) {
  if (value === null || value === undefined) return "";
  if (field.type === "date") {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
    return match ? match[1] : String(value);
  }
  return String(value);
}

const PAGE_SIZE = 50;

type RowFilter = "ALL" | "ERROR" | "EDITED";

type Props = {
  fileName: string;
  preview: PreviewPayload;
  /** Cột cho sửa: các field của template trừ cột hệ thống tự điền. */
  fields: ImportFieldDefinition[];
  edits: RowEdits;
  /** Có ô sửa từ sau lần server chấm lỗi gần nhất — số lỗi trên bảng chưa phản ánh bản sửa. */
  editsDirty: boolean;
  /** Mapping cột ngoài trang chính đổi mà chưa "Áp dụng": không cho lưu để khỏi lệch cột. */
  mappingDirty: boolean;
  busy: boolean;
  message: string;
  messageIsError: boolean;
  summaryRows: RevenueDayInput[];
  templateCode: string;
  onEdit: (rowKey: string, field: string, value: string) => void;
  onResetRow: (rowKey: string) => void;
  onRecheck: () => void;
  onSave: () => void;
  onClose: () => void;
};

export default function RevenuePreviewEditor({
  fileName,
  preview,
  fields,
  edits,
  editsDirty,
  mappingDirty,
  busy,
  message,
  messageIsError,
  summaryRows,
  templateCode,
  onEdit,
  onResetRow,
  onRecheck,
  onSave,
  onClose,
}: Props) {
  const [filter, setFilter] = useState<RowFilter>("ALL");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const editedCount = Object.keys(edits).length;
  const visibleRows = useMemo(() => {
    if (filter === "ERROR") return preview.rows.filter((row) => row.errors.length > 0);
    if (filter === "EDITED") return preview.rows.filter((row) => Boolean(edits[previewRowKey(row)]));
    return preview.rows;
  }, [preview.rows, filter, edits]);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = visibleRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const canSave = !busy && !mappingDirty && preview.rows.length > 0 && (preview.errorRows === 0 || editsDirty);
  const saveHint = mappingDirty
    ? "Mapping cột đang đổi dở, đóng popup và bấm Áp dụng mapping trước."
    : preview.errorRows > 0 && !editsDirty
      ? `Còn ${preview.errorRows} dòng lỗi, sửa các ô đỏ rồi mới lưu được.`
      : editsDirty
        ? "Có ô vừa sửa: bấm Lưu sẽ kiểm tra lại rồi ghi vào hệ thống nếu hết lỗi."
        : "Dữ liệu chỉ vào hệ thống khi bấm Lưu import.";

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/50 px-3 py-4 backdrop-blur-[1px]">
      <button
        type="button"
        aria-label="Đóng popup xem trước"
        className="absolute inset-0 cursor-default"
        onClick={() => !busy && onClose()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="revenue-preview-editor-title"
        className="relative flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600">
            <span className="material-symbols-outlined">table_edit</span>
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="revenue-preview-editor-title" className="text-base font-bold text-slate-900">Xem trước &amp; chỉnh sửa doanh thu</h2>
            <p className="truncate text-xs text-slate-500">
              {fileName} · sheet {preview.sheetName}, header dòng {preview.headerRowNumber}. Sửa thẳng vào ô, dữ liệu chưa vào hệ thống cho tới khi bấm Lưu import.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-slate-700">Tổng {preview.totalRows}</span>
            <span className="rounded-lg bg-emerald-50 px-2.5 py-1.5 text-emerald-700">Hợp lệ {preview.validRows}</span>
            <span className={`rounded-lg px-2.5 py-1.5 ${preview.errorRows > 0 ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500"}`}>Lỗi {preview.errorRows}</span>
            <span className={`rounded-lg px-2.5 py-1.5 ${editedCount > 0 ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"}`}>Đã sửa {editedCount}</span>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            aria-label="Đóng"
            className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {message && (
          <div className={`border-b px-5 py-2 text-xs font-semibold ${messageIsError ? "border-rose-200 bg-rose-50 text-rose-700" : "border-blue-100 bg-blue-50 text-blue-700"}`}>
            <span className="whitespace-pre-line leading-5">{message}</span>
          </div>
        )}

        {editsDirty && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-semibold text-amber-800">
            <span>Có ô vừa sửa, số lỗi và bảng theo ngày chưa cập nhật. Bấm Kiểm tra lại để hệ thống đọc lại với bản sửa.</span>
            <button
              type="button"
              onClick={onRecheck}
              disabled={busy}
              className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
            >
              Kiểm tra lại
            </button>
          </div>
        )}

        <details open className="border-b border-slate-100">
          <summary className="cursor-pointer select-none px-5 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50">
            Doanh thu theo ngày của file (cộng dòng hợp lệ)
          </summary>
          <div className="max-h-56 overflow-auto">
            <RevenueDaySummary
              rows={summaryRows}
              tableId="revenue-editor-day-table"
              fileName={`doanh_thu_theo_ngay_preview_${templateCode.toLowerCase()}`}
              subtitle={`Cộng ${summaryRows.length} dòng hợp lệ; dòng lỗi không tính`}
            />
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-2 text-xs">
          <label className="font-bold text-slate-600">
            Hiển thị
            <select
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value as RowFilter);
                setPage(0);
              }}
              className="ml-2 rounded-lg border border-slate-300 bg-white px-2 py-1.5 font-normal"
            >
              <option value="ALL">Tất cả dòng</option>
              <option value="ERROR">Chỉ dòng lỗi</option>
              <option value="EDITED">Chỉ dòng đã sửa</option>
            </select>
          </label>
          <span className="text-slate-500">{visibleRows.length} dòng</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={safePage === 0}
              className="rounded-lg border border-slate-200 px-2 py-1 font-bold disabled:opacity-40"
            >
              ‹
            </button>
            <span className="px-2 text-slate-600">Trang {safePage + 1}/{pageCount}</span>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-lg border border-slate-200 px-2 py-1 font-bold disabled:opacity-40"
            >
              ›
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Dòng</th>
                {fields.map((field) => (
                  <th key={field.field} className="whitespace-nowrap px-2 py-2">{field.label}{field.required ? " *" : ""}</th>
                ))}
                <th className="px-3 py-2">Lỗi</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.length === 0 && (
                <tr>
                  <td colSpan={fields.length + 3} className="px-4 py-8 text-center text-slate-400">Không có dòng nào theo bộ lọc này.</td>
                </tr>
              )}
              {pageRows.map((row) => {
                const rowKey = previewRowKey(row);
                const rowEdit = edits[rowKey];
                return (
                  <tr key={rowKey} className={row.errors.length > 0 ? "bg-rose-50/70" : rowEdit ? "bg-amber-50/40" : "hover:bg-slate-50"}>
                    <td className="px-3 py-1.5 font-bold text-slate-700">{row.rowNumber}</td>
                    {fields.map((field) => {
                      const edited = rowEdit ? Object.prototype.hasOwnProperty.call(rowEdit, field.field) : false;
                      const value = edited ? rowEdit[field.field] : cellText(field, row.values[field.field] ?? null);
                      const cellClass = `w-full rounded-md border px-2 py-1 text-sm ${edited ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"}`;
                      return (
                        <td key={field.field} className="px-1 py-1 align-top">
                          {field.type === "date" ? (
                            <div className="min-w-[128px]">
                              <DateInput value={value} onChange={(next) => onEdit(rowKey, field.field, next)} className={cellClass} ariaLabel={`${field.label} dòng ${row.rowNumber}`} />
                            </div>
                          ) : (
                            <input
                              type="text"
                              value={value}
                              inputMode={field.type === "number" || field.type === "integer" ? "decimal" : undefined}
                              onChange={(event) => onEdit(rowKey, field.field, event.target.value)}
                              aria-label={`${field.label} dòng ${row.rowNumber}`}
                              className={`${cellClass} ${field.type === "number" || field.type === "integer" ? "min-w-[110px] text-right" : "min-w-[120px]"}`}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td className={`max-w-[280px] px-3 py-1.5 text-xs ${row.errors.length > 0 ? "font-semibold text-rose-700" : "text-slate-400"}`}>
                      {row.errors.join("; ") || "-"}
                    </td>
                    <td className="px-2 py-1.5">
                      {rowEdit && (
                        <button
                          type="button"
                          onClick={() => onResetRow(rowKey)}
                          title="Bỏ các ô đã sửa của dòng này, lấy lại số trong file"
                          className="grid h-7 w-7 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        >
                          <span className="material-symbols-outlined text-[18px]">undo</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <p className={`text-xs ${canSave ? "text-slate-500" : "font-semibold text-amber-700"}`}>{saveHint}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={onRecheck}
              disabled={busy || !editsDirty}
              className="rounded-lg border border-blue-200 bg-white px-4 py-2 text-sm font-bold text-blue-700 hover:bg-blue-50 disabled:opacity-40"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">rule</span>
                Kiểm tra lại
              </span>
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">{busy ? "hourglass_top" : "save"}</span>
                {busy ? "Đang xử lý..." : "Lưu import"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
