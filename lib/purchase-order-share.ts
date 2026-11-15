import { money, quantity } from "@/lib/format-number";

/**
 * Phiếu đặt hàng gửi NHÀ CUNG CẤP — dữ liệu do /api/public/purchase-orders/[token] trả về.
 * Dùng chung cho trang công khai /po/[token], hộp thoại "Gửi NCC" (xem trước + xuất ảnh) và
 * tin nhắn chữ gửi qua Zalo/SMS/email, để ba nơi luôn ra đúng một bố cục theo phiếu mẫu của
 * khách: Thông tin đặt hàng (Mã đơn, Nơi nhận, Muốn nhận lúc, Người đặt, Lưu ý)
 * rồi Danh sách hàng hóa, mỗi mặt hàng một dòng "1. Tên hàng: 4 Kg" (khách 26/10/2026).
 */
export type SharedOrderLine = { itemCode: string; itemName: string; unit: string; quantity: number; unitCost: number; totalCost: number; note?: string | null };
export type SharedPurchaseOrder = {
  code: string;
  status: string;
  orderDate: string;
  expectedDate: string | null;
  supplierName: string;
  supplierCode: string;
  supplierPhone: string | null;
  branchName: string;
  branchAddress: string | null;
  warehouseName: string;
  departmentName: string | null;
  note: string | null;
  createdBy: string | null;
  createdByEmail: string | null;
  createdByPhone: string | null;
  totalAmount: number;
  lines: SharedOrderLine[];
  publicUrl: string;
  qrDataUrl: string;
  shareable: boolean;
};

/** dd/mm/yyyy như phiếu mẫu — toLocaleDateString("vi-VN") ra "24/8/2026", không đệm số 0. */
export function orderDateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Ho_Chi_Minh" }).format(date);
}

/** Các dòng "Thông tin đặt hàng" theo đúng thứ tự phiếu mẫu. */
export function orderInfoRows(order: SharedPurchaseOrder) {
  const rows: Array<{ label: string; value: string; upper?: boolean }> = [
    { label: "Mã đơn", value: order.code },
    // Bỏ dòng Nhà cung cấp (tiêu đề phiếu đã ghi) và địa chỉ ở Nơi nhận, chỉ giữ tên nhà hàng (khách 26/10/2026).
    { label: "Nơi nhận", value: order.branchName },
    { label: "Muốn nhận lúc", value: orderDateLabel(order.expectedDate) || "Sớm nhất có thể" },
    { label: "Người đặt", value: [order.createdByEmail || order.createdBy, order.createdByPhone].filter(Boolean).join(" - ") || "-" },
  ];
  // Phiếu mẫu ghi bộ phận nhận ("bếp") ở Lưu ý khi không có ghi chú riêng.
  const remark = order.note || order.departmentName;
  if (remark) rows.push({ label: "Lưu ý", value: remark });
  return rows;
}

export function orderLineQuantity(line: SharedOrderLine) {
  return `${quantity(line.quantity)} ${line.unit}`;
}

/** Tin nhắn chữ dán vào Zalo/SMS/email — cùng nội dung với phiếu, kèm link xem phiếu (có QR). */
export function purchaseOrderMessage(order: SharedPurchaseOrder, options: { showPrices?: boolean } = {}) {
  const cancelled = order.status === "CANCELLED";
  const lines: string[] = [];
  if (cancelled) lines.push(`⚠️ ĐƠN ${order.code} ĐÃ HUỶ — vui lòng KHÔNG giao hàng theo đơn này.`, "");
  lines.push(`Đơn đặt hàng tới ${order.supplierName.toUpperCase()}`, "");
  lines.push("Thông tin đặt hàng");
  for (const row of orderInfoRows(order)) lines.push(`${row.label}: ${row.upper ? row.value.toUpperCase() : row.value}`);
  lines.push("", "Danh sách hàng hóa");
  order.lines.forEach((line, index) => {
    // "1. Tên hàng: 0,3 Kg" trên một dòng — bỏ mã hàng và chữ "Số lượng" (khách 26/10/2026).
    let itemLine = `${index + 1}. ${line.itemName}: ${orderLineQuantity(line)}`;
    if (options.showPrices && line.unitCost > 0) itemLine += ` × ${money(line.unitCost)} đ = ${money(line.totalCost)} đ`;
    lines.push(itemLine);
    if (line.note) lines.push(`Ghi chú: ${line.note}`);
  });
  if (options.showPrices && order.totalAmount > 0) lines.push("", `Tổng giá trị: ${money(order.totalAmount)} đ`);
  // Không kèm dòng "Xem phiếu: <link>" (khách 21/10/2026) — tin nhắn dừng ở danh sách hàng.
  return lines.join("\n");
}

/**
 * Chia danh sách hàng của ẢNH phiếu thành nhiều trang (khách 16/11/2026: đơn 50 món gửi Zalo trên
 * iPhone chữ nhoè, Android rõ). Ảnh dài gấp 5–6 lần bề ngang bị Zalo/iOS thu nhỏ theo cạnh dài nên
 * chữ vỡ; mỗi trang giữ tỷ lệ gần màn điện thoại (~1:2,5) thì gửi đi vẫn đọc rõ.
 * Trang 1 có đủ phần Thông tin đặt hàng nên chứa ít dòng hơn. Dòng có ghi chú / kèm giá cao hơn.
 * Trả về [start, end) theo chỉ số dòng; đơn ngắn chỉ một trang.
 */
export const ORDER_IMAGE_FIRST_PAGE_UNITS = 16;
export const ORDER_IMAGE_NEXT_PAGE_UNITS = 24;
const SINGLE_PAGE_MAX_UNITS = 20;

export function paginateOrderLines(lines: SharedOrderLine[], options: { showPrices?: boolean } = {}) {
  const weight = (line: SharedOrderLine) => 1 + (line.note ? 0.6 : 0) + (options.showPrices && line.unitCost > 0 ? 0.6 : 0);
  const weights = lines.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  if (lines.length === 0 || total <= SINGLE_PAGE_MAX_UNITS) return [{ start: 0, end: lines.length }];
  // Số trang tiếp theo, rồi chia đều phần còn lại để trang cuối không lẻ loi vài dòng.
  const restPages = Math.max(1, Math.ceil((total - ORDER_IMAGE_FIRST_PAGE_UNITS) / ORDER_IMAGE_NEXT_PAGE_UNITS));
  const perRestPage = (total - ORDER_IMAGE_FIRST_PAGE_UNITS) / restPages;
  const pages: Array<{ start: number; end: number }> = [];
  let start = 0;
  let used = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const budget = pages.length === 0 ? ORDER_IMAGE_FIRST_PAGE_UNITS : perRestPage;
    const isLastPage = pages.length === restPages;
    if (!isLastPage && index > start && used + weights[index] > budget + 0.01) {
      pages.push({ start, end: index });
      start = index;
      used = 0;
    }
    used += weights[index];
  }
  pages.push({ start, end: lines.length });
  return pages;
}
