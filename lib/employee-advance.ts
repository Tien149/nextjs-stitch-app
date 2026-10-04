/**
 * Tạm ứng & hoàn ứng nhân viên (khách hỏi 04/10/2026).
 *
 * - Tạm ứng: phiếu chi (tiền mặt / ngân hàng) mang khoản mục tạm ứng (CHI_TAM_UNG...) — tiền ra
 *   quỹ nhưng CHƯA phải chi phí: treo Nợ 141 theo nhân viên nhận tiền. Trước đây khoản mục này
 *   rơi vào nhánh "chi thường" và ghi thẳng Nợ 6428, nên 7 triệu tạm ứng team MKT thành chi phí
 *   chưa phân loại ngay ngày chi.
 * - Hoàn ứng: nhân viên mua hàng về nộp chứng từ — KHÔNG có tiền nào đi qua quỹ, chỉ giảm số
 *   nhân viên còn tạm ứng và đưa từng khoản vào hạng mục chi phí. Lập ở Công nợ Đối tác, loại
 *   "Hoàn ứng nhân viên": mỗi dòng hạng mục một khoản công nợ sourceType ADVANCE_SETTLEMENT,
 *   ghi sổ Nợ chi phí (theo nhóm hạng mục, cùng luật công nợ phải trả khai tay) / Có 141.
 * - Nhân viên nộp lại tiền thừa: phiếu thu khoản mục hoàn tạm ứng (THU_HOAN_UNG) — Có 141,
 *   không phải doanh thu.
 *
 * Trên bảng Công nợ, số dư của nhân viên = tạm ứng (phiếu chi, phải thu) − hoàn ứng − tiền nộp lại.
 * Phần thuần để kiểm thử và để client dùng chung (không kéo prisma).
 */
export const EMPLOYEE_ADVANCE_ACCOUNT = "141";

/** sourceType của khoản công nợ sinh từ phiếu hoàn ứng. */
export const ADVANCE_SETTLEMENT_SOURCE = "ADVANCE_SETTLEMENT";

/** Giá trị ô "Loại công nợ" trên popup Thêm công nợ (API quy về PAYABLE + sourceType trên). */
export const ADVANCE_SETTLEMENT_DEBT_TYPE = "ADVANCE_SETTLEMENT";

/** Tiền tố mã phiếu hoàn ứng: HU-<yyyymm>-<số>. */
export const ADVANCE_SETTLEMENT_CODE_PREFIX = "HU";

/** Khoản mục thu nhân viên nộp lại tiền tạm ứng thừa (migration tạo sẵn). */
export const ADVANCE_REFUND_CATEGORY_CODE = "THU_HOAN_UNG";

/**
 * Khoản mục thu/chi có phải tạm ứng / hoàn tạm ứng nhân viên không — nhận theo MÃ (CHI_TAM_UNG,
 * THU_HOAN_UNG, THU_HOAN_TAM_UNG...), giống SALES_RECEIPT_CATEGORY_CODES: định khoản chỉ có mã.
 */
export function isEmployeeAdvanceCategory(categoryCode: string | null | undefined) {
  const code = (categoryCode || "").trim().toUpperCase();
  return /(^|_)(TAM_?UNG|HOAN_?UNG)($|_)/.test(code);
}

export function isAdvanceSettlementDebt(sourceType: string | null | undefined) {
  return (sourceType || "").trim().toUpperCase() === ADVANCE_SETTLEMENT_SOURCE;
}
