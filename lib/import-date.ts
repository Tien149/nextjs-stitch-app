function checkedUtcDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === day
    ? value
    : null;
}

/**
 * Đổi số serial ngày của Excel thành ngày UTC.
 *
 * Excel đếm từ mốc 1899-12-30 và có lỗi lịch nổi tiếng: nó coi 1900 là năm nhuận, nên các serial
 * từ 60 trở xuống lệch một ngày so với lịch thật. Ngày nghiệp vụ không bao giờ rơi vào tháng 1-2
 * năm 1900, nên loại thẳng khoảng đó thay vì đoán. Phần thập phân là giờ trong ngày, bỏ đi.
 *
 * Công thức này đã được đối chiếu khớp tuyệt đối với XLSX.SSF.parse_date_code trên toàn bộ
 * serial 61 -> 80000 (1900-03-02 đến năm 2119). Không dùng SSF vì nó không tồn tại khi thư viện
 * xlsx được nạp dưới dạng ESM, khiến script chạy ngoài Next.js gãy.
 */
function excelSerialToUtcDate(serial: number) {
  if (!Number.isFinite(serial) || serial < 61) return null;
  const value = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return Number.isNaN(value.getTime()) ? null : value;
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
  if (typeof value === "number") return excelSerialToUtcDate(value);

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
