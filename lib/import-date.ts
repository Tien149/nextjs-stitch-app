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

/**
 * GIỜ bán (0–23, giờ Việt Nam như máy POS ghi) của một ô "Thời gian" — để tách doanh thu trong
 * ngày theo giờ chốt kiểm kê (khách chốt 28/09/2026, lib/stocktake-batch.ts). Nhận:
 *   - serial Excel có phần thập phân (45900.4375 -> 10);
 *   - chữ "31/08/2026 10:23", "2026-08-31T10:23", hoặc chỉ giờ "10:23" (cột Giờ riêng);
 *   - Date (đọc giờ theo máy đang chạy — file POS ghi giờ địa phương).
 * Ô chỉ có ngày (không có phần giờ) trả null: dòng đó là doanh thu CẢ NGÀY, không tách được.
 */
export function parseImportHour(value: unknown): number | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0 ? null : value.getHours();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const fraction = value - Math.floor(value);
    if (fraction <= 0) return null;
    // Làm tròn tới giây trước khi lấy giờ: 10:00:00 lưu thành 0.41666666 dễ rơi về 9 giờ.
    const seconds = Math.round(fraction * 86400);
    return Math.min(23, Math.floor(seconds / 3600));
  }
  const text = String(value || "").trim();
  if (!text) return null;
  const match = /(?:^|[\sT])(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*(AM|PM|SA|CH))?\s*$/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const marker = (match[3] || "").toUpperCase();
  if ((marker === "PM" || marker === "CH") && hour < 12) hour += 12;
  if ((marker === "AM" || marker === "SA") && hour === 12) hour = 0;
  return hour >= 0 && hour <= 23 && Number(match[2]) < 60 ? hour : null;
}
