/**
 * Trạng thái phiếu kiểm kê HAI BƯỚC (khách yêu cầu 28/09/2026), dùng chung cho kiểm kê kho
 * (StocktakeSession) và kiểm kê CCDC & tài sản (AssetStocktakeSession), cả server lẫn màn hình:
 *
 *   nhà hàng Gửi duyệt ──> PENDING (Chờ duyệt) ──kế toán Duyệt──> APPROVED (ghi sổ)
 *                            │   ▲                                   │
 *                   Trả lại  ▼   │ nhà hàng sửa, gửi lại              │ Mở lại
 *                          RETURNED (Bị trả lại)      PENDING <───────┘
 *
 * Chỉ APPROVED mới đụng tồn kho / số lượng tài sản. DRAFT là trạng thái cũ (mở lại trước khi có
 * luồng duyệt) — coi như bị trả lại: sửa được, gửi lại được.
 */
export const STOCKTAKE_PENDING = "PENDING";
export const STOCKTAKE_RETURNED = "RETURNED";
export const STOCKTAKE_APPROVED = "APPROVED";

/** Nhà hàng còn sửa / gửi lại được phiếu này. */
export function isStocktakeEditable(status: string | null | undefined) {
  return status === STOCKTAKE_PENDING || status === STOCKTAKE_RETURNED || status === "DRAFT";
}

export function stocktakeStatusLabel(status: string | null | undefined) {
  if (status === STOCKTAKE_PENDING) return "Chờ duyệt";
  if (status === STOCKTAKE_RETURNED) return "Bị trả lại";
  if (status === STOCKTAKE_APPROVED) return "Đã duyệt";
  if (status === "DRAFT") return "Nháp";
  return status || "-";
}

/** Màu nhãn trạng thái (lớp Tailwind) cho danh sách phiếu. */
export function stocktakeStatusTone(status: string | null | undefined) {
  if (status === STOCKTAKE_PENDING) return "bg-amber-100 text-amber-800";
  if (status === STOCKTAKE_RETURNED) return "bg-rose-100 text-rose-700";
  if (status === STOCKTAKE_APPROVED) return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-600";
}
