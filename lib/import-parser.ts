import * as XLSX from "xlsx";
import {
  type ImportFieldDefinition,
  type ImportTemplateDefinition,
  normalizeHeader,
} from "@/lib/import-templates";

export type ParsedImportRow = {
  rowNumber: number;
  values: Record<string, string | number | Date | null>;
  errors: string[];
};

export type ParsedImportResult = {
  headers: string[];
  mapping: Record<string, string>;
  rows: ParsedImportRow[];
  totalRows: number;
  validRows: number;
  errorRows: number;
};

function parseNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;

  const text = String(value)
    .trim()
    .replace(/\s/g, "")
    .replace(/,/g, "");
  const numberValue = Number(text);
  return Number.isFinite(numberValue) ? numberValue : Number.NaN;
}

function parseInteger(value: unknown) {
  const numberValue = parseNumber(value);
  return Number.isFinite(numberValue) ? Math.trunc(numberValue) : Number.NaN;
}

function parseDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }

  const text = String(value || "").trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (slash) return new Date(Date.UTC(Number(slash[3]), Number(slash[2]) - 1, Number(slash[1])));

  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function coerceValue(field: ImportFieldDefinition, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return field.required ? { value: null, error: `${field.label} là bắt buộc` } : { value: null };
  }

  if (field.type === "text") {
    return { value: String(value).trim() };
  }

  if (field.type === "number") {
    const parsed = parseNumber(value);
    return Number.isFinite(parsed)
      ? { value: parsed }
      : { value: null, error: `${field.label} phải là số` };
  }

  if (field.type === "integer") {
    const parsed = parseInteger(value);
    return Number.isFinite(parsed)
      ? { value: parsed }
      : { value: null, error: `${field.label} phải là số nguyên` };
  }

  const parsed = parseDate(value);
  return parsed ? { value: parsed } : { value: null, error: `${field.label} không đúng định dạng ngày` };
}

function autoMapHeaders(headers: string[], template: ImportTemplateDefinition) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const mapping: Record<string, string> = {};

  for (const field of template.fields) {
    const candidates = [field.label, field.field, ...field.aliases].map(normalizeHeader);
    const matched = candidates.map((candidate) => normalizedHeaders.get(candidate)).find(Boolean);
    if (matched) mapping[field.field] = matched;
  }

  return mapping;
}

function readWorkbookRows(buffer: ArrayBuffer) {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("File không có sheet dữ liệu");

  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json<Array<string | number | Date | null>>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  });
}

export async function parseImportFile(file: File, template: ImportTemplateDefinition): Promise<ParsedImportResult> {
  const rows = readWorkbookRows(await file.arrayBuffer()).filter((row) =>
    row.some((cell) => String(cell || "").trim() !== ""),
  );

  const headers = (rows[0] || []).map((cell) => String(cell || "").trim());
  if (headers.length === 0) throw new Error("File thiếu header");

  const mapping = autoMapHeaders(headers, template);
  const missingFields = template.fields.filter((field) => field.required && !mapping[field.field]);

  const parsedRows = rows.slice(1).map((row, rowIndex) => {
    const source: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      source[header] = row[index];
    });

    const values: ParsedImportRow["values"] = {};
    const errors = missingFields.map((field) => `Không tìm thấy cột ${field.label}`);

    for (const field of template.fields) {
      const header = mapping[field.field];
      const result = coerceValue(field, header ? source[header] : undefined);
      values[field.field] = result.value ?? null;
      if (result.error) errors.push(result.error);
    }

    return {
      rowNumber: rowIndex + 2,
      values,
      errors,
    };
  });

  return {
    headers,
    mapping,
    rows: parsedRows,
    totalRows: parsedRows.length,
    validRows: parsedRows.filter((row) => row.errors.length === 0).length,
    errorRows: parsedRows.filter((row) => row.errors.length > 0).length,
  };
}
