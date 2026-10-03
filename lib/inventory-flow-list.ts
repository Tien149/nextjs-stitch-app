/**
 * Danh sách phiếu của hai màn Nhập kho / Xuất kho (GET /api/inventory → flowTransactions).
 */

/** Trần an toàn của danh sách phiếu Nhập kho / Xuất kho — chạm trần thì màn hình báo chọn khoảng ngày ngắn hơn. */
export const FLOW_DOCUMENT_LIMIT = 20000;
/** Số dòng hàng giữ lại để xem trước trên phiếu chế biến đã rút gọn (bảng chỉ hiện 3 dòng đầu). */
export const FLOW_PREVIEW_LINES = 3;

/**
 * Rút gọn phiếu chế biến sinh từ rã BOM cho danh sách Nhập kho / Xuất kho: chỉ gửi 3 dòng đầu
 * kèm `lineSummary` (số dòng, tổng tiền, tổng SL + ĐVT, chuỗi mã/tên để tìm). Riêng phiếu chế
 * biến đã ~16.000 dòng / 90 ngày; gửi đủ thì một lần tải nặng gấp đôi. Phiếu này khoá sửa/xoá
 * (xử lý ở lần rã gốc) nên màn hình không cần đủ dòng. Phiếu XUẤT BÁN giữ đủ dòng vì màn Xuất kho
 * trải từng mặt hàng của nó ra (khách chốt 03/10/2026).
 */
export function compactFlowDocument<T extends { referenceType: string | null; transactionType: string; lines: Array<{ quantity: number; totalCost: number; vatAmount: number; item: { code: string; name: string; unit: string } }> }>(document: T) {
  if (document.referenceType !== "PRODUCTION" || document.transactionType === "XUAT_BAN" || document.lines.length <= FLOW_PREVIEW_LINES) return document;
  return {
    ...document,
    lines: document.lines.slice(0, FLOW_PREVIEW_LINES),
    lineSummary: {
      count: document.lines.length,
      totalCost: document.lines.reduce((sum, line) => sum + line.totalCost, 0),
      vatAmount: document.lines.reduce((sum, line) => sum + (line.vatAmount || 0), 0),
      quantity: document.lines.reduce((sum, line) => sum + line.quantity, 0),
      units: [...new Set(document.lines.map((line) => line.item.unit))],
      searchText: document.lines.map((line) => `${line.item.code} ${line.item.name}`).join(" | "),
    },
  };
}
