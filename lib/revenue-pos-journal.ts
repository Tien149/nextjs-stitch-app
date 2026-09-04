/**
 * Bút toán doanh thu POS lên báo cáo P&L (spec chị khách 04/09/2026):
 *
 *  - Doanh thu theo NHÓM DOANH THU (Đồ ăn -> Doanh thu bếp, Đồ uống -> Doanh thu bar,
 *    Dịch vụ -> Doanh thu phụ thu) lấy đúng "Doanh thu − Giảm giá" của dòng import.
 *  - Hai dòng doanh thu đứng riêng trên P&L: "Doanh thu SVC" = cột SVC, "Doanh thu thuế GTGT"
 *    = cột Thuế. Trước đây cả ba phần gộp chung vào netAmount trên một dòng Có 511 mang nhóm
 *    doanh thu của món, nên P&L không tách được SVC/thuế và doanh thu bếp/bar bị thổi phồng.
 *  - Tiền về (Nợ 1111/1121) vẫn là "Tổng tiền" khách trả — số lên báo cáo Tiền về đủ chưa.
 *
 * File POS có thêm cột điều chỉnh (hoa hồng, phí ship...) thì Tổng tiền ≠ Doanh thu − Giảm giá
 * + SVC + Thuế; phần chênh đưa vào một dòng doanh thu riêng để bút toán vẫn cân và người xem
 * thấy rõ số điều chỉnh thay vì bị trộn vào doanh thu bếp/bar.
 *
 * Dòng import cũ (file tổng hợp 9 cột không có Doanh thu/SVC/Thuế) chỉ có Tổng tiền: giữ nguyên
 * cách cũ — toàn bộ lên nhóm doanh thu của dòng.
 */

/** Mã danh mục Thu cho hai dòng doanh thu tách riêng và dòng điều chỉnh. */
export const REVENUE_SVC_CATEGORY_CODE = "REV_SVC";
export const REVENUE_VAT_CATEGORY_CODE = "REV_VAT";
export const REVENUE_ADJUST_CATEGORY_CODE = "REV_ADJUST";

/**
 * Danh mục Thu mặc định cho các dòng tách riêng. Là NHÓM DOANH THU (lên dòng 1 của P&L) nhưng
 * không theo dõi tồn kho: không có mã hàng nào thuộc về chúng.
 */
export const REVENUE_COMPONENT_CATEGORIES = [
  { code: REVENUE_SVC_CATEGORY_CODE, name: "Doanh thu SVC", note: "Phí dịch vụ (cột SVC file POS) — tự tách khi ghi sổ doanh thu" },
  { code: REVENUE_VAT_CATEGORY_CODE, name: "Doanh thu thuế GTGT", note: "Thuế GTGT (cột Thuế file POS) — tự tách khi ghi sổ doanh thu" },
  { code: REVENUE_ADJUST_CATEGORY_CODE, name: "Điều chỉnh doanh thu POS", note: "Chênh lệch Tổng tiền so với Doanh thu − Giảm giá + SVC + Thuế (hoa hồng, phí ship...)" },
] as const;

const componentCodes = new Set<string>(REVENUE_COMPONENT_CATEGORIES.map((category) => category.code));

/** Dòng Có 511 mang mã này là phần SVC / thuế / điều chỉnh, KHÔNG phải nhóm doanh thu của món. */
export function isRevenueComponentCategory(categoryCode: string | null | undefined) {
  return componentCodes.has(String(categoryCode ?? "").trim().toUpperCase());
}

export type RevenuePosRowLike = {
  paymentMethod: string;
  revenueSource: string | null;
  departmentCode?: string | null;
  grossAmount: number;
  discountAmount: number;
  feeAmount: number;
  vatAmount: number;
  netAmount: number;
};

export type RevenuePosJournalLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  categoryCode?: string | null;
  departmentCode?: string | null;
  description?: string | null;
};

const round = (value: number) => Math.round((value || 0) * 100) / 100;

/** Tài khoản tiền nhận: nguồn tiền có chữ CASH là tiền mặt, còn lại coi là ngân hàng/ví. */
export function revenuePosCashAccount(paymentMethod: string) {
  return String(paymentMethod || "").toUpperCase().includes("CASH") ? "1111" : "1121";
}

/**
 * Các dòng bút toán của một dòng doanh thu POS. Luôn cân: tổng Có = netAmount = Nợ tiền.
 * Dòng bằng 0 không sinh ra để bút toán không rác; dòng nhóm doanh thu vẫn giữ cả khi bằng 0
 * nếu không còn dòng Có nào khác (dòng import 0 đồng).
 */
export function revenuePosJournalLines(row: RevenuePosRowLike): RevenuePosJournalLine[] {
  const net = round(row.netAmount);
  const gross = round(row.grossAmount);
  const discount = round(row.discountAmount);
  const svc = round(row.feeAmount);
  const vat = round(row.vatAmount);
  const hasBreakdown = gross !== 0 || svc !== 0 || vat !== 0;
  const groupRevenue = hasBreakdown ? round(gross - discount) : net;
  const adjust = hasBreakdown ? round(net - groupRevenue - svc - vat) : 0;
  const department = row.departmentCode || null;

  const lines: RevenuePosJournalLine[] = [
    { accountCode: revenuePosCashAccount(row.paymentMethod), debit: net },
  ];
  const credits: RevenuePosJournalLine[] = [];
  if (groupRevenue !== 0 || (svc === 0 && vat === 0 && adjust === 0)) {
    credits.push({ accountCode: "511", credit: groupRevenue, categoryCode: row.revenueSource || null, departmentCode: department });
  }
  if (svc !== 0) credits.push({ accountCode: "511", credit: svc, categoryCode: REVENUE_SVC_CATEGORY_CODE, departmentCode: department, description: "Phí dịch vụ (SVC)" });
  if (vat !== 0) credits.push({ accountCode: "511", credit: vat, categoryCode: REVENUE_VAT_CATEGORY_CODE, departmentCode: department, description: "Thuế GTGT" });
  if (adjust !== 0) credits.push({ accountCode: "511", credit: adjust, categoryCode: REVENUE_ADJUST_CATEGORY_CODE, departmentCode: department, description: "Chênh lệch Tổng tiền so với Doanh thu − Giảm giá + SVC + Thuế" });
  return [...lines, ...credits];
}
