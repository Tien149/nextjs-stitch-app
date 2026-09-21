/**
 * Khoản chênh "khách trả thiếu" được đẩy từ bảng "Tiền về đủ chưa" vào chi phí.
 *
 * Bản ghi nằm chung bảng với phiếu Điều chỉnh quỹ (cùng mã DCQ, cùng chỗ sửa/xoá) nhưng
 * KHÔNG phải một khoản tiền ra khỏi quỹ, nên phải đứng ngoài mọi phép tính số dư nguồn tiền.
 *
 * Lý do (khách chốt 21/09/2026): trên Báo cáo nguồn tiền và Sổ quỹ, tiền vào của nguồn ngân
 * hàng/ví đọc THẲNG SỔ SAO KÊ — tức là đã ghi đúng số thực nhận (2.424.042 đ), chứ không lấy
 * doanh thu ghi nhận (2.425.645 đ). Phần chênh 1.603 đ chưa bao giờ vào quỹ, nên trừ nó ra
 * lần nữa là trừ khống: số dư tụt xuống dưới cả sao kê. Đúng như khách nói — "không có tiền
 * vào sao trừ ra được".
 *
 * Ngược lại trên SỔ CÁI thì vẫn phải trừ: bút toán doanh thu POS ghi Nợ 1121 theo số doanh
 * thu, nên 1121 đang thừa đúng 1.603 đ so với sao kê. Bút toán Nợ 6428 / Có 1121 kéo sổ cái
 * về khớp sao kê và đưa khoản chênh lên Tổng hợp chi phí + P&L. Hai luồng số này độc lập với
 * nhau, đừng "thống nhất" chúng bằng cách bỏ một bên.
 */
export const REVENUE_SETTLEMENT_WRITEOFF_SOURCE = "REVENUE_SETTLEMENT";

/** Phiếu điều chỉnh quỹ này có thật sự làm đổi số dư nguồn tiền không. */
export function adjustmentMovesCash(row: { sourceType?: string | null }) {
  return row.sourceType !== REVENUE_SETTLEMENT_WRITEOFF_SOURCE;
}

/** Điều kiện Prisma cho những truy vấn chỉ lấy phiếu THẬT SỰ chạm quỹ. */
export const CASH_MOVING_ADJUSTMENT_FILTER = {
  OR: [{ sourceType: null }, { sourceType: { not: REVENUE_SETTLEMENT_WRITEOFF_SOURCE } }],
};
