/**
 * Đối tác "Khách hàng mua lẻ" (KH_LE). Tiền bán hàng của khách lẻ lấy từ doanh thu, doanh thu
 * không sinh công nợ nên phiếu thu / ủy nhiệm thu gắn KH_LE cũng không được lên công nợ (khách
 * chốt 03/10/2026). Trước đây chỉ dựa vào cờ "Không theo dõi công nợ" của danh mục — VPS tạo
 * KH_LE trước khi có cờ nên cờ tắt, 457 phiếu thu bán hàng thành ~707 triệu "phải trả" ảo.
 * Nay KH_LE luôn coi như đã bật cờ, không phụ thuộc dữ liệu danh mục.
 */
export const RETAIL_CUSTOMER_CODE = "KH_LE";

export function isRetailCustomerCode(code: string | null | undefined): boolean {
  return (code || "").trim().toUpperCase() === RETAIL_CUSTOMER_CODE;
}

/** Đối tác mà phiếu thu/chi và dòng sao kê KHÔNG cộng vào bảng Công nợ. */
export function skipsDebtTracking(partner: { code: string; skipDebtTracking?: boolean | null }): boolean {
  return partner.skipDebtTracking === true || isRetailCustomerCode(partner.code);
}
