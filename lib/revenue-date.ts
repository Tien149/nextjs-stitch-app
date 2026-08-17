import { parseImportDate } from "@/lib/import-parser";

export type RevenueDateSuggestion = {
  date: Date;
  source: "DESCRIPTION";
  matchedText: string;
};

function checkedUtcDate(year: number, month: number, day: number) {
  return parseImportDate(`${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`);
}

/**
 * Extracts one unambiguous revenue-date suggestion from a statement description.
 * The result is advisory only: callers must not silently persist or auto-approve it.
 */
export function suggestRevenueDateFromDescription(description: string): RevenueDateSuggestion | null {
  const text = String(description || "").trim();
  if (!text) return null;

  const pattern = /(?:ngay|ngày|dt|doanh\s*thu)\s*[:.-]?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})/giu;
  const suggestions = [...text.matchAll(pattern)].flatMap((match) => {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const date = checkedUtcDate(year, month, day);
    return date ? [{ date, source: "DESCRIPTION" as const, matchedText: match[0] }] : [];
  });
  const unique = new Map(suggestions.map((item) => [item.date.toISOString().slice(0, 10), item]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

/**
 * Ngày nghiệp vụ Việt Nam của một mốc date-only đã lưu.
 *
 * Hệ thống đang tồn tại hai quy ước: dữ liệu import chuẩn hoá về UTC midnight
 * (2026-08-06T00:00:00Z), còn dữ liệu nhập trên giao diện lưu theo nửa đêm giờ Việt Nam
 * (2026-08-05T17:00:00Z). Cộng 7 tiếng rồi lấy ngày UTC quy cả hai về đúng một ngày,
 * nên đối chiếu hai nguồn không bị lệch một ngày.
 */
export function vietnamBusinessDayKey(value: Date) {
  return new Date(value.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Khoảng ngày nghiệp vụ Việt Nam (+07:00) tương ứng với date-only đã lưu.
 * Khoảng này chủ động bao phủ cả dữ liệu cũ lưu local midnight và dữ liệu import
 * mới chuẩn hóa UTC midnight, giống cách màn hình Thu chi ngày đang truy vấn.
 */
export function vietnamBusinessDayBounds(value: Date) {
  const key = dateKey(value);
  const start = new Date(`${key}T00:00:00+07:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}
