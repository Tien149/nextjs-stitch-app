import { money, quantity } from "@/lib/format-number";

/**
 * Phiếu đặt hàng gửi NHÀ CUNG CẤP — dữ liệu do /api/public/purchase-orders/[token] trả về.
 * Dùng chung cho trang công khai /po/[token], hộp thoại "Gửi NCC" (xem trước + xuất ảnh) và
 * tin nhắn chữ gửi qua Zalo/SMS/email, để ba nơi luôn ra đúng một bố cục theo phiếu mẫu của
 * khách: Thông tin đặt hàng (Mã đơn, Nhà cung cấp, Nơi nhận, Muốn nhận lúc, Người đặt, Lưu ý)
 * rồi Danh sách hàng hóa ("1. Tên hàng-MÃ" / "Số lượng: 4 Kg").
 */
export type SharedOrderLine = { itemCode: string; itemName: string; unit: string; quantity: number; unitCost: number; totalCost: number };
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
    { label: "Nhà cung cấp", value: order.supplierName, upper: true },
    { label: "Nơi nhận", value: [order.branchName, order.branchAddress].filter(Boolean).join(" - ") },
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
    lines.push(`${index + 1}. ${line.itemName}-${line.itemCode}`);
    let qtyLine = `Số lượng: ${orderLineQuantity(line)}`;
    if (options.showPrices && line.unitCost > 0) qtyLine += ` × ${money(line.unitCost)} đ = ${money(line.totalCost)} đ`;
    lines.push(qtyLine);
  });
  if (options.showPrices && order.totalAmount > 0) lines.push("", `Tổng giá trị: ${money(order.totalAmount)} đ`);
  lines.push("", `Xem phiếu: ${order.publicUrl}`);
  return lines.join("\n");
}
