import * as XLSX from "xlsx";

function checkedUtcDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    ? value
    : null;
}

const javascriptDateMonths: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/**
 * Parse the date formats accepted by import files and normalize them to UTC midnight.
 * JavaScript Date.toString() values are matched explicitly so ambiguous locale dates
 * are not silently interpreted by Date.parse().
 */
export function parseImportDate(value: unknown) {
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

  // Sao kê ngân hàng thường xuất ngày kèm giờ, ví dụ 04-08-2026 15:27:22.
  const dateTime = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+\d{1,2}:\d{2}(?::\d{2})?$/.exec(text);
  if (dateTime) return checkedUtcDate(Number(dateTime[3]), Number(dateTime[2]), Number(dateTime[1]));

  // Date objects stored in JSON columns can return from Prisma as Date.toString().
  // Read only the explicit English format instead of accepting arbitrary Date.parse input.
  const javascriptDate = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{4})\s+\d{2}:\d{2}:\d{2}\s+GMT[+-]\d{4}(?:\s+\([^)]*\))?$/.exec(text);
  if (javascriptDate) {
    return checkedUtcDate(
      Number(javascriptDate[3]),
      javascriptDateMonths[javascriptDate[1]],
      Number(javascriptDate[2]),
    );
  }

  return null;
}
