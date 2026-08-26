/**
 * Ràng buộc cho "nội dung thu" của phiếu thu: thu thường (ghi nhận trọn vẹn ngay, bản chất
 * khoản thu do Khoản mục thu/chi quyết định), hay thu tiền cọc để theo dõi số dư về sau.
 * Tách ra khỏi route để kiểm thử được và để form/API dùng chung.
 */
export const RECEIPT_PURPOSES = [
  { id: "", label: "Thu thường — không theo dõi cọc", hint: "Bản chất khoản thu khai ở Khoản mục thu/chi bên dưới." },
  { id: "COLLECT", label: "Thu tiền đặt cọc (khách sẽ dùng sau)", hint: "Khi duyệt sẽ sinh một khoản tiền cọc theo dõi riêng." },
] as const;

export function normalizeReceiptPurpose(voucherType: string, value: unknown) {
  if (voucherType !== "RECEIPT") return "";
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/** Trả về thông báo lỗi, hoặc null nếu hợp lệ. */
export function validateReceiptPurpose(voucherType: string, value: unknown, partnerCode: string | null | undefined) {
  const purpose = normalizeReceiptPurpose(voucherType, value);
  if (!purpose) return null;
  if (purpose !== "COLLECT") return "Nội dung thu không hợp lệ";
  // Thu cọc phải gắn được vào một khách hàng cụ thể thì mới theo dõi số dư về sau.
  if (!(partnerCode || "").trim()) return "Thu tiền cọc phải chọn đối tác có mã khách hàng.";
  return null;
}

/**
 * Phân loại dòng tiền của danh mục Thu/Chi. Dữ liệu cũ từng dùng nhóm
 * P&L nên vẫn được quy đổi để chứng từ lịch sử hoạt động bình thường.
 */
export function normalizeCashflowCategoryType(group: string | null | undefined) {
  const raw = (group || "").trim().toUpperCase();
  if (["RECEIPT", "THU", "INCOME", "REVENUE_SOURCE"].includes(raw)) return "RECEIPT";
  if (["PAYMENT", "CHI", "EXPENSE", "OPEX", "CAPEX", "COGS"].includes(raw)) return "PAYMENT";
  if (raw.includes("REVENUE") || raw.includes("DOANH") || raw.includes("NGUON")) return "RECEIPT";
  return raw || null;
}

/**
 * Khoản mục thu được coi là DOANH THU BÁN HÀNG. Dòng "Doanh thu bán hàng" trên Thu chi ngày,
 * đối soát tiền về và SUMIFS sao kê đều lọc theo danh sách này. Các loại thu khác (hoàn tiền
 * NCC chi trùng, thu hoàn tạm ứng...) là tiền vào quỹ thật nhưng không phải doanh thu.
 */
export const SALES_RECEIPT_CATEGORY_CODES = ["THU_BAN_HANG"];

export function isSalesReceiptCategory(categoryCode: string | null | undefined) {
  return SALES_RECEIPT_CATEGORY_CODES.includes((categoryCode || "").trim().toUpperCase());
}

/**
 * Đối tác này có được chọn trên chứng từ đang lập không.
 *
 * Chứng từ ngân hàng mở cả hai chiều: có khoản thu chi hộ nên phiếu chi ngân hàng phải chọn
 * được khách hàng, phiếu thu ngân hàng chọn được NCC hoàn tiền.
 *
 * Phiếu thu TIỀN MẶT bó theo bản chất khoản thu, không bó cứng theo chiều đối tác:
 * - Thu bán hàng (hoặc chưa chọn khoản mục): chỉ khách hàng — để thu ngân không chọn nhầm NCC.
 * - Khoản thu khác (NCC hoàn tiền chi trùng, thu hoàn tạm ứng nhân viên...): mở đủ mọi loại
 *   đối tác, vì tiền vào từ NCC/nhân viên là nghiệp vụ có thật.
 */
export function isPartnerAllowedForVoucher({
  voucherType,
  categoryCode,
  isBankChannel = false,
  partnerType,
}: {
  voucherType: string;
  categoryCode?: string | null;
  isBankChannel?: boolean;
  partnerType?: string | null;
}) {
  if (isBankChannel) return true;
  const type = (partnerType || "").toUpperCase();
  if (voucherType === "RECEIPT") {
    if (categoryCode && !isSalesReceiptCategory(categoryCode)) return true;
    return ["CUSTOMER", "BOTH", "OTHER_PARTNER"].includes(type);
  }
  return ["SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(type);
}

/** Chuẩn hoá nhóm P&L; có fallback cho danh mục Thu/Chi mới khi định khoản. */
export function normalizeCategoryGroup(group: string | null | undefined) {
  const raw = (group || "").toUpperCase();
  if (["RECEIPT", "THU", "INCOME"].includes(raw)) return "REVENUE_SOURCE";
  if (["PAYMENT", "CHI", "EXPENSE"].includes(raw)) return "OPEX";
  if (raw.includes("REVENUE") || raw.includes("DOANH") || raw.includes("NGUON")) return "REVENUE_SOURCE";
  if (raw.includes("COGS") || raw.includes("GIA")) return "COGS";
  if (raw.includes("CAPEX")) return "CAPEX";
  if (raw.includes("OPEX")) return "OPEX";
  return raw || null;
}

/**
 * Cửa sổ sửa chứng từ.
 *
 * Phiếu thu/chi được duyệt ngay lúc tạo. Trong ngày, ai có quyền sửa đều có thể lưu và
 * hệ thống tự duyệt lại. Phiếu khác ngày chỉ Admin/Kế toán tổng hợp có `edit_past` được
 * sửa; backend bắt buộc lý do và ghi audit trước/sau.
 */
export const VIETNAM_TIME_ZONE = "Asia/Ho_Chi_Minh";

function calendarDateKey(value: Date, timeZone = VIETNAM_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isSameCalendarDay(a: Date, b: Date) {
  const first = calendarDateKey(new Date(a));
  return Boolean(first) && first === calendarDateKey(new Date(b));
}

/** Trả về lý do chặn, hoặc null nếu được phép. */
export function voucherEditWindowError(
  voucherDate: Date,
  canEditPast: boolean,
  now: Date = new Date(),
  actionLabel = "sửa",
) {
  if (canEditPast) return null;
  if (isSameCalendarDay(new Date(voucherDate), now)) return null;
  return `Chứng từ lập ngày ${new Date(voucherDate).toLocaleDateString("vi-VN")} đã qua ngày, chỉ Kế toán tổng hợp hoặc Admin mới ${actionLabel} được. Liên hệ kế toán để xử lý.`;
}
