import * as XLSX from "xlsx";
import {
  normalizeHeader,
  type ImportFieldDefinition,
  type ImportTemplateDefinition,
} from "@/lib/import-templates";

export type ImportCellValue = string | number | Date | null;

export type ParsedImportRow = {
  sheetName: string;
  rowNumber: number;
  rawValues: Record<string, ImportCellValue>;
  values: Record<string, ImportCellValue>;
  errors: string[];
};

export type ParsedImportResult = {
  sheetName: string;
  headerRowNumber: number;
  headers: string[];
  mapping: Record<string, string>;
  rows: ParsedImportRow[];
  totalRows: number;
  validRows: number;
  errorRows: number;
};

export type ParseImportOptions = {
  mapping?: Record<string, string>;
  defaultValues?: Record<string, string | number>;
};

type SheetRows = {
  name: string;
  rows: Array<Array<string | number | boolean | Date | null>>;
};

function parseNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;

  let text = String(value).trim();
  if (!text) return 0;
  const negativeByParentheses = /^\(.*\)$/.test(text);
  text = text.replace(/[()]/g, "").replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!text || text === "-" || text === "." || text === ",") return Number.NaN;

  const commaIndex = text.lastIndexOf(",");
  const dotIndex = text.lastIndexOf(".");
  if (commaIndex >= 0 && dotIndex >= 0) {
    const decimalSeparator = commaIndex > dotIndex ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    text = text.split(thousandsSeparator).join("");
    if (decimalSeparator === ",") text = text.replace(",", ".");
  } else if (commaIndex >= 0) {
    text = /^-?\d{1,3}(,\d{3})+$/.test(text) ? text.replace(/,/g, "") : text.replace(",", ".");
  } else if (dotIndex >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, "");
  }

  const numberValue = Number(text);
  if (!Number.isFinite(numberValue)) return Number.NaN;
  return negativeByParentheses ? -Math.abs(numberValue) : numberValue;
}

function parseInteger(value: unknown) {
  const numberValue = parseNumber(value);
  return Number.isFinite(numberValue) && Number.isInteger(numberValue) ? numberValue : Number.NaN;
}

function checkedUtcDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    ? value
    : null;
}

function parseDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return checkedUtcDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? checkedUtcDate(parsed.y, parsed.m, parsed.d) : null;
  }

  const text = String(value || "").trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(text);
  if (iso) return checkedUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (slash) return checkedUtcDate(Number(slash[3]), Number(slash[2]), Number(slash[1]));

  return null;
}

function coerceValue(field: ImportFieldDefinition, value: unknown) {
  if (value === null || value === undefined || value === "") {
    return field.required ? { value: null, error: `${field.label} là bắt buộc` } : { value: null };
  }

  if (field.type === "text") return { value: String(value).trim() };

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
  return parsed ? { value: parsed } : { value: null, error: `${field.label} không đúng định dạng ngày hợp lệ` };
}

function headerMatchesCandidate(header: string, candidate: string) {
  const normalizedHeader = normalizeHeader(header);
  const normalizedCandidate = normalizeHeader(candidate);
  if (!normalizedHeader || !normalizedCandidate) return false;
  return normalizedHeader === normalizedCandidate || normalizedHeader.startsWith(`${normalizedCandidate} `);
}

export function autoMapHeaders(headers: string[], template: ImportTemplateDefinition) {
  const mapping: Record<string, string> = {};
  for (const field of template.fields) {
    if (field.hiddenFromMapping) continue;
    const candidates = [field.label, field.field, ...field.aliases];
    const matched = headers.find((header) => candidates.some((candidate) => headerMatchesCandidate(header, candidate)));
    if (matched) mapping[field.field] = matched;
  }
  return mapping;
}

function readWorkbook(buffer: ArrayBuffer): SheetRows[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(workbook.Sheets[name], {
      header: 1,
      raw: true,
      defval: "",
    }),
  }));
}

function rowContainsMarker(row: Array<unknown>, markers: string[]) {
  const normalizedMarkers = markers.map(normalizeHeader);
  return row.some((cell) => {
    const value = normalizeHeader(String(cell || ""));
    return normalizedMarkers.some((marker) => value === marker || value.startsWith(`${marker} `));
  });
}

function orderedSheets(sheets: SheetRows[], template: ImportTemplateDefinition) {
  const preferred = (template.preferredSheetNames || []).map(normalizeHeader);
  return [...sheets].sort((left, right) => {
    const leftIndex = preferred.indexOf(normalizeHeader(left.name));
    const rightIndex = preferred.indexOf(normalizeHeader(right.name));
    if (leftIndex >= 0 && rightIndex < 0) return -1;
    if (rightIndex >= 0 && leftIndex < 0) return 1;
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    return 0;
  });
}

function findHeaderCandidate(sheets: SheetRows[], template: ImportTemplateDefinition) {
  const candidates: Array<{
    sheet: SheetRows;
    headerIndex: number;
    stopIndex: number;
    mapping: Record<string, string>;
    requiredMatches: number;
    totalMatches: number;
  }> = [];
  const preferredNames = (template.preferredSheetNames || []).map(normalizeHeader);

  for (const sheet of orderedSheets(sheets, template)) {
    const preferredSheet = preferredNames.includes(normalizeHeader(sheet.name));
    let startIndex = 0;
    let stopIndex = sheet.rows.length;
    if (template.sectionMarkers?.length) {
      const markerIndex = sheet.rows.findIndex((row) => rowContainsMarker(row, template.sectionMarkers || []));
      if (markerIndex >= 0) startIndex = markerIndex + 1;
      else if (!preferredSheet) continue;
    }
    if (template.stopSectionMarkers?.length) {
      const relativeStop = sheet.rows
        .slice(startIndex)
        .findIndex((row) => rowContainsMarker(row, template.stopSectionMarkers || []));
      if (relativeStop >= 0) stopIndex = startIndex + relativeStop;
    }

    const searchEnd = Math.min(stopIndex, startIndex + 40);
    for (let index = startIndex; index < searchEnd; index += 1) {
      const headers = sheet.rows[index].map((cell) => String(cell || "").trim());
      const mapping = autoMapHeaders(headers, template);
      const requiredMatches = template.fields.filter(
        (field) => field.required && (mapping[field.field] || template.defaultValues?.[field.field] !== undefined),
      ).length;
      candidates.push({
        sheet,
        headerIndex: index,
        stopIndex,
        mapping,
        requiredMatches,
        totalMatches: Object.keys(mapping).length,
      });
    }
  }

  return candidates.sort((left, right) => {
    if (right.requiredMatches !== left.requiredMatches) return right.requiredMatches - left.requiredMatches;
    return right.totalMatches - left.totalMatches;
  })[0];
}

export async function parseImportFile(
  file: File,
  template: ImportTemplateDefinition,
  options: ParseImportOptions = {},
): Promise<ParsedImportResult> {
  const sheets = readWorkbook(await file.arrayBuffer());
  if (sheets.length === 0) throw new Error("File không có sheet dữ liệu");

  const candidate = findHeaderCandidate(sheets, template);
  if (!candidate || candidate.totalMatches === 0) {
    throw new Error("Không tìm thấy dòng header phù hợp với profile import đã chọn");
  }

  const headers = candidate.sheet.rows[candidate.headerIndex].map((cell) => String(cell || "").trim());
  const mapping = { ...candidate.mapping };
  for (const [field, header] of Object.entries(options.mapping || {})) {
    if (headers.includes(header)) mapping[field] = header;
    else delete mapping[field];
  }
  const defaults = { ...(template.defaultValues || {}), ...(options.defaultValues || {}) };
  const missingFields = template.fields.filter(
    (field) => field.required && !mapping[field.field] && defaults[field.field] === undefined,
  );

  const parsedRows = candidate.sheet.rows
    .slice(candidate.headerIndex + 1, candidate.stopIndex)
    .map((row, relativeIndex) => ({ row, sourceIndex: candidate.headerIndex + 1 + relativeIndex }))
    .filter(({ row }) => row.some((cell) => String(cell || "").trim() !== ""))
    .filter(({ row }) => !rowContainsMarker(row, [
      ...(template.sectionMarkers || []),
      ...(template.stopSectionMarkers || []),
    ]))
    .map(({ row, sourceIndex }) => {
      const source: Record<string, ImportCellValue> = {};
      headers.forEach((header, index) => {
        if (header) source[header] = (row[index] as ImportCellValue) ?? null;
      });

      const values: ParsedImportRow["values"] = {};
      const errors = missingFields.map((field) => `Không tìm thấy cột ${field.label}`);
      for (const field of template.fields) {
        const header = mapping[field.field];
        const sourceValue = header ? source[header] : undefined;
        const rawValue = sourceValue === null || sourceValue === undefined || sourceValue === ""
          ? defaults[field.field]
          : sourceValue;
        const result = coerceValue(field, rawValue);
        values[field.field] = result.value ?? null;
        if (result.error) errors.push(result.error);
      }

      return {
        sheetName: candidate.sheet.name,
        rowNumber: sourceIndex + 1,
        rawValues: source,
        values,
        errors,
      };
    });

  return {
    sheetName: candidate.sheet.name,
    headerRowNumber: candidate.headerIndex + 1,
    headers,
    mapping,
    rows: parsedRows,
    totalRows: parsedRows.length,
    validRows: parsedRows.filter((row) => row.errors.length === 0).length,
    errorRows: parsedRows.filter((row) => row.errors.length > 0).length,
  };
}
