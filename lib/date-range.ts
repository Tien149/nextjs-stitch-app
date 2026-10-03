/**
 * Khoảng ngày lọc danh sách (YYYY-MM-DD, ô trống = không chặn đầu đó) — dùng chung cho mọi màn
 * có lọc "Từ ngày – Đến ngày" (khách yêu cầu 03/10/2026). Ngày tính theo giờ Việt Nam.
 */
export type DateRange = { from: string; to: string };
export type DateRangePresetId = "this-month" | "last-month" | "last-30" | "this-year" | "all";

const DAY_MS = 86_400_000;

/** Hôm nay theo giờ Việt Nam. */
export function vnToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function dateRangePreset(id: DateRangePresetId, now: Date = new Date()): DateRange {
  const today = vnToday(now);
  const [year, month] = today.split("-").map(Number);
  const pad = (value: number) => String(value).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (id === "this-month") return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}` };
  if (id === "last-month") {
    const y = month === 1 ? year - 1 : year;
    const m = month === 1 ? 12 : month - 1;
    return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  }
  if (id === "last-30") return { from: new Date(Date.parse(`${today}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10), to: today };
  if (id === "this-year") return { from: `${year}-01-01`, to: `${year}-12-31` };
  return { from: "", to: "" };
}

/**
 * Một giá trị ngày (Date / ISO / "YYYY-MM-DD") có nằm trong khoảng không. `mode: "utc"` cho cột
 * lưu 00:00 UTC (ngày chứng từ nhập tay), mặc định đọc theo giờ VN (thời điểm thật).
 */
export function inDateRange(value: Date | string | null | undefined, range: DateRange, mode: "vn" | "utc" = "vn"): boolean {
  if (!range.from && !range.to) return true;
  if (!value) return false;
  const text = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : mode === "utc"
      ? new Date(value).toISOString().slice(0, 10)
      : vnToday(new Date(value));
  if (range.from && text < range.from) return false;
  if (range.to && text > range.to) return false;
  return true;
}

/** Điều kiện Prisma `{ gte, lt }` cho cột DateTime; null khi khoảng trống. */
export function prismaDateRange(range: { from?: string | null; to?: string | null }, mode: "vn" | "utc" = "vn") {
  const valid = (value?: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const from = valid(range.from);
  const to = valid(range.to);
  if (!from && !to) return null;
  const start = (day: string) => new Date(`${day}T00:00:00${mode === "utc" ? "Z" : "+07:00"}`);
  return {
    ...(from ? { gte: start(from) } : {}),
    ...(to ? { lt: new Date(start(to).getTime() + DAY_MS) } : {}),
  };
}

/** Kỳ "YYYY-MM" có ngày nào nằm trong khoảng không (giao nhau là tính). */
export function periodInRange(period: string | null | undefined, range: DateRange): boolean {
  if (!range.from && !range.to) return true;
  if (!period || !/^\d{4}-\d{2}/.test(period)) return false;
  const month = period.slice(0, 7);
  const [year, monthIndex] = month.split("-").map(Number);
  const last = `${month}-${String(new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()).padStart(2, "0")}`;
  if (range.from && last < range.from) return false;
  if (range.to && `${month}-01` > range.to) return false;
  return true;
}
