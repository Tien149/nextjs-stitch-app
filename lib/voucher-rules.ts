/**
 * Ràng buộc cho "nội dung thu" của phiếu thu: ghi nhận doanh thu ngay, hay thu tiền cọc
 * để theo dõi số dư về sau. Tách ra khỏi route để kiểm thử được và để form/API dùng chung.
 */
export const RECEIPT_PURPOSES = [
  { id: "", label: "Thu doanh thu (ghi nhận toàn bộ)", hint: "Tiền vào doanh thu ngay, không theo dõi số dư cọc." },
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

/** Chuẩn hoá nhóm khoản mục về 4 nhóm gốc; dùng chung cho form, API và định khoản. */
export function normalizeCategoryGroup(group: string | null | undefined) {
  const raw = (group || "").toUpperCase();
  if (raw.includes("REVENUE") || raw.includes("DOANH") || raw.includes("NGUON")) return "REVENUE_SOURCE";
  if (raw.includes("COGS") || raw.includes("GIA")) return "COGS";
  if (raw.includes("CAPEX")) return "CAPEX";
  if (raw.includes("OPEX")) return "OPEX";
  return raw || null;
}
