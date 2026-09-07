/**
 * Cộng doanh thu POS theo NGÀY BÁN + CỬA HÀNG — bảng "Doanh thu theo ngày" trên màn Import
 * (yêu cầu chị Bình 08/09/2026: import xong muốn xem ngay từng ngày bán bao nhiêu, kiểu sổ
 * ngân hàng, thay vì phải qua Báo cáo hoặc tự cộng 9.913 dòng chi tiết).
 *
 * Cách tách tiền lấy nguyên của lib/revenue-pos-journal.ts (revenuePosJournalLines) để bảng này
 * và dòng Doanh thu trên P&L luôn ra cùng một số:
 *   - Doanh thu hàng bán = Doanh thu − Giảm giá (file cũ chỉ có Tổng tiền thì lấy Tổng tiền).
 *   - SVC và Thuế GTGT đứng riêng, đều là doanh thu.
 *   - Chênh lệch = phần Tổng tiền không giải thích được bằng ba khoản trên (hoa hồng, phí ship...).
 *   - Tổng tiền = số khách trả, đúng bằng phần dòng này đóng góp vào dòng Doanh thu của P&L.
 * Vì vậy cột Tổng tiền của bảng cộng lại phải khớp doanh thu cùng kỳ trên P&L và trên tab
 * "Tiền về đủ chưa".
 *
 * Dùng cho cả hai chỗ nên nhận `unknown`: preview đọc từ file (khoá snake_case, đã ép kiểu số)
 * và batch đã commit đọc từ RevenueImportRow (khoá camelCase, ngày là chuỗi ISO).
 */

/** Cùng cách làm tròn với bút toán doanh thu POS — không thì bảng lệch vài đồng so với P&L. */
const round = (value: number) => Math.round((value || 0) * 100) / 100;

/** Ép về số; chuỗi có dấu phân cách nghìn kiểu Việt Nam vẫn đọc được. Không đọc được thì 0. */
function toAmount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  const text = String(value).trim().replace(/\s/g, "");
  if (!text) return 0;
  const cleaned = /^-?\d{1,3}([.,]\d{3})+$/.test(text)
    ? text.replace(/[.,]/g, "")
    : text.replace(/,/g, ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Ngày nghiệp vụ (giờ Việt Nam) của một giá trị ngày bán.
 * Dữ liệu import mới lưu UTC nửa đêm, dữ liệu cũ lưu nửa đêm giờ máy chủ — cộng 7 giờ rồi cắt
 * ngày thì cả hai đều ra đúng ngày, giống vietnamBusinessDayKey mà báo cáo đang dùng.
 * Chuỗi "YYYY-MM-DD" đã là ngày nghiệp vụ nên giữ nguyên, không quy đổi múi giờ lần nữa.
 */
export function revenueDayKey(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : new Date(value.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }
  if (typeof value === "number") return revenueDayKey(new Date(value));
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : revenueDayKey(parsed);
}

/** Một dòng import doanh thu, đã gom về đúng 7 trường mà bảng cần. */
export type RevenueDayInput = {
  saleDate: unknown;
  branchCode: unknown;
  grossAmount: unknown;
  discountAmount: unknown;
  feeAmount: unknown;
  vatAmount: unknown;
  netAmount: unknown;
};

export type RevenueDayRow = {
  /** "YYYY-MM-DD" theo ngày nghiệp vụ; rỗng nghĩa là dòng không đọc được ngày. */
  date: string;
  branchCode: string;
  rowCount: number;
  /** Doanh thu hàng bán = Doanh thu − Giảm giá. */
  salesRevenue: number;
  discount: number;
  /** Phụ thu dịch vụ (cột SVC) — là doanh thu. */
  svc: number;
  vat: number;
  /** Tổng tiền − (hàng bán + SVC + thuế): hoa hồng, phí ship... khai trên file. */
  adjust: number;
  /** Tổng tiền khách trả — khớp dòng Doanh thu của P&L. */
  net: number;
};

const emptyRow = (date: string, branchCode: string): RevenueDayRow => ({
  date,
  branchCode,
  rowCount: 0,
  salesRevenue: 0,
  discount: 0,
  svc: 0,
  vat: 0,
  adjust: 0,
  net: 0,
});

/**
 * Gom các dòng import thành một dòng cho mỗi (ngày bán × cửa hàng), xếp theo ngày tăng dần rồi
 * tới cửa hàng. `totals` là dòng "Cộng" cuối bảng, cộng đúng những dòng đang liệt kê.
 */
export function buildRevenueDaySummary(rows: RevenueDayInput[]): { rows: RevenueDayRow[]; totals: RevenueDayRow } {
  const byKey = new Map<string, RevenueDayRow>();
  const totals = emptyRow("", "");

  for (const row of rows) {
    const date = revenueDayKey(row.saleDate);
    const branchCode = String(row.branchCode ?? "").trim() || "—";
    const gross = round(toAmount(row.grossAmount));
    const discount = round(toAmount(row.discountAmount));
    const svc = round(toAmount(row.feeAmount));
    const vat = round(toAmount(row.vatAmount));
    const net = round(toAmount(row.netAmount));
    // File tổng hợp cũ chỉ có Tổng tiền (không có Doanh thu/SVC/Thuế): toàn bộ là doanh thu
    // hàng bán, không có phần chênh — đúng nhánh `hasBreakdown` của bút toán doanh thu POS.
    const hasBreakdown = gross !== 0 || svc !== 0 || vat !== 0;
    const salesRevenue = hasBreakdown ? round(gross - discount) : net;
    const adjust = hasBreakdown ? round(net - salesRevenue - svc - vat) : 0;

    const key = `${date}|${branchCode}`;
    const current = byKey.get(key) || emptyRow(date, branchCode);
    for (const bucket of [current, totals]) {
      bucket.rowCount += 1;
      bucket.salesRevenue = round(bucket.salesRevenue + salesRevenue);
      bucket.discount = round(bucket.discount + discount);
      bucket.svc = round(bucket.svc + svc);
      bucket.vat = round(bucket.vat + vat);
      bucket.adjust = round(bucket.adjust + adjust);
      bucket.net = round(bucket.net + net);
    }
    byKey.set(key, current);
  }

  // Dòng không đọc được ngày đẩy xuống cuối để không chen vào giữa dãy ngày.
  const sorted = [...byKey.values()].sort((a, b) => {
    if (!a.date !== !b.date) return a.date ? -1 : 1;
    return a.date.localeCompare(b.date) || a.branchCode.localeCompare(b.branchCode, "vi");
  });
  return { rows: sorted, totals };
}
