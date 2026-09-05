/**
 * Bút toán doanh thu POS lên báo cáo P&L (spec chị khách 04/09/2026):
 *
 *  - Doanh thu theo NHÓM DOANH THU (Đồ ăn -> Doanh thu bếp, Đồ uống -> Doanh thu bar,
 *    Dịch vụ -> Doanh thu phụ thu) lấy đúng "Doanh thu − Giảm giá" của dòng import.
 *  - Hai dòng doanh thu đứng riêng trên P&L: "Doanh thu SVC" = cột SVC, "Doanh thu thuế GTGT"
 *    = cột Thuế. Trước đây cả ba phần gộp chung vào netAmount trên một dòng Có 511 mang nhóm
 *    doanh thu của món, nên P&L không tách được SVC/thuế và doanh thu bếp/bar bị thổi phồng.
 *  - Doanh thu cắt theo KÊNH BÁN (Tại chỗ / Mang về / Giao hàng qua app) bằng hạng mục P&L,
 *    để dòng Doanh thu của P&L liệt kê được từng loại thay vì một cục "Thu bán hàng".
 *  - Phí quẹt thẻ và phí bán hàng qua app khai trên file là CHI PHÍ của nhà hàng: ghi Nợ 6428
 *    đúng hạng mục P&L, và tiền thực nhận (Nợ 1111/1121) giảm đúng số phí đó. Cột SVC vẫn là
 *    doanh thu — hai thứ khác nhau, đừng nhập phí vào cột SVC.
 *
 * File POS có thêm cột điều chỉnh (hoa hồng, phí ship...) thì Tổng tiền ≠ Doanh thu − Giảm giá
 * + SVC + Thuế; phần chênh đưa vào một dòng doanh thu riêng để bút toán vẫn cân và người xem
 * thấy rõ số điều chỉnh thay vì bị trộn vào doanh thu bếp/bar.
 *
 * Dòng import cũ (file tổng hợp 9 cột không có Doanh thu/SVC/Thuế) chỉ có Tổng tiền: giữ nguyên
 * cách cũ — toàn bộ lên nhóm doanh thu của dòng.
 */

import {
  WALLET_CARD_FEE_CATEGORY_CODE,
  WALLET_CARD_FEE_PNL_ITEM_CODE,
  WALLET_GRAB_EXPENSE_CATEGORY_CODE,
  WALLET_GRAB_EXPENSE_PNL_ITEM_CODE,
} from "@/lib/wallet-settlement-allocation";

/**
 * Hạng mục P&L của kênh bán. Dòng Có 511 mang mã này để bảng P&L tách được "Doanh thu tại chỗ /
 * mang về / giao hàng qua app" — trước đây cả năm chỉ hiện một dòng "Thu bán hàng trong ngày"
 * vì file POS ghi cùng một nhóm doanh thu cho mọi kênh (feedback chị Bình 05/09/2026).
 */
export const REVENUE_CHANNEL_DINE_IN_PNL_ITEM_CODE = "PNL_DT_TAICHO";
export const REVENUE_CHANNEL_TAKEAWAY_PNL_ITEM_CODE = "PNL_DT_MANGVE";
export const REVENUE_CHANNEL_DELIVERY_PNL_ITEM_CODE = "PNL_DT_GRAB";

export const REVENUE_CHANNEL_PNL_ITEMS = [
  { code: REVENUE_CHANNEL_DINE_IN_PNL_ITEM_CODE, name: "Doanh thu tại chỗ" },
  { code: REVENUE_CHANNEL_TAKEAWAY_PNL_ITEM_CODE, name: "Doanh thu mang về" },
  { code: REVENUE_CHANNEL_DELIVERY_PNL_ITEM_CODE, name: "Doanh thu giao hàng (Grab/Shopee)" },
] as const;

const normalizeChannel = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Kênh bán trên file POS -> hạng mục P&L. File của khách ghi tiếng Việt có dấu ("Tại chỗ",
 * "Mang về"), file khác ghi tên app ("GrabFood", "ShopeeFood") hoặc tiếng Anh (dine-in,
 * takeaway, delivery) — nhận cả ba. Chữ lạ trả về null: doanh thu vẫn lên đúng dòng P&L, chỉ
 * không tách được kênh, thay vì bị gán bừa vào một kênh sai.
 */
export function revenueChannelPnlItemCode(channel: unknown): string | null {
  const text = normalizeChannel(channel);
  if (!text) return null;
  const has = (...keywords: string[]) => keywords.some((keyword) => text.includes(keyword));
  // Giao hàng qua app xét TRƯỚC "mang ve": "Grab mang về" là đơn app, không phải khách tự tới lấy.
  if (has("grab", "shopee", "baemin", "gojek", "befood", "be food", "loship", "app", "delivery", "giao hang", "giao di", "online")) {
    return REVENUE_CHANNEL_DELIVERY_PNL_ITEM_CODE;
  }
  if (has("mang ve", "mang di", "take away", "takeaway", "to go", "mang about")) return REVENUE_CHANNEL_TAKEAWAY_PNL_ITEM_CODE;
  if (has("tai cho", "tai quan", "dine in", "dinein", "an tai", "phuc vu tai")) return REVENUE_CHANNEL_DINE_IN_PNL_ITEM_CODE;
  return null;
}

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
  channel?: string | null;
  grossAmount: number;
  discountAmount: number;
  feeAmount: number;
  vatAmount: number;
  /** Phí quẹt thẻ nhà hàng chịu trên dòng này (cột "Phí cà thẻ" của file POS). */
  cardFeeAmount?: number | null;
  /** Phí sàn / hoa hồng app giao hàng (cột "Phí bán hàng qua app" của file POS). */
  appFeeAmount?: number | null;
  netAmount: number;
};

export type RevenuePosJournalLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  categoryCode?: string | null;
  pnlItemCode?: string | null;
  departmentCode?: string | null;
  description?: string | null;
};

const round = (value: number) => Math.round((value || 0) * 100) / 100;

/** Tài khoản tiền nhận: nguồn tiền có chữ CASH là tiền mặt, còn lại coi là ngân hàng/ví. */
export function revenuePosCashAccount(paymentMethod: string) {
  return String(paymentMethod || "").toUpperCase().includes("CASH") ? "1111" : "1121";
}

/** Phí trên dòng doanh thu đã làm tròn và chặn số âm — phí âm là lỗi nhập, không phải doanh thu. */
export function revenuePosFees(row: RevenuePosRowLike) {
  const cardFee = Math.max(0, round(row.cardFeeAmount || 0));
  const appFee = Math.max(0, round(row.appFeeAmount || 0));
  return { cardFee, appFee, total: round(cardFee + appFee) };
}

/**
 * Các dòng bút toán của một dòng doanh thu POS. Luôn cân: tổng Có = netAmount, tổng Nợ = tiền
 * thực nhận + phí. Dòng bằng 0 không sinh ra để bút toán không rác; dòng nhóm doanh thu vẫn giữ
 * cả khi bằng 0 nếu không còn dòng Có nào khác (dòng import 0 đồng).
 *
 * Phí quẹt thẻ / phí app là tiền sàn giữ lại: khách trả đủ `netAmount` nên vế Có 511 không đổi,
 * còn nhà hàng chỉ nhận về `netAmount − phí` nên vế Nợ tách làm hai. Ghi theo cùng tài khoản và
 * cùng hạng mục P&L với phí quyết toán ví để hai nguồn cộng chung một dòng trên P&L.
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
  const channelPnlItem = revenueChannelPnlItemCode(row.channel);
  // Phí chỉ tách được trong phạm vi tiền khách trả. Khai phí lớn hơn cả Tổng tiền là lỗi nhập
  // liệu; cắt về net để bút toán không sinh dòng tiền âm, phần thừa lộ ra khi đối chiếu.
  const { cardFee, appFee } = revenuePosFees(row);
  const feeCap = Math.max(0, net);
  const cardFeeAmount = Math.min(cardFee, feeCap);
  const appFeeAmount = Math.min(appFee, round(feeCap - cardFeeAmount));
  const cashAmount = round(net - cardFeeAmount - appFeeAmount);

  const lines: RevenuePosJournalLine[] = [
    { accountCode: revenuePosCashAccount(row.paymentMethod), debit: cashAmount },
  ];
  if (cardFeeAmount > 0) {
    lines.push({ accountCode: "6428", debit: cardFeeAmount, categoryCode: WALLET_CARD_FEE_CATEGORY_CODE, pnlItemCode: WALLET_CARD_FEE_PNL_ITEM_CODE, departmentCode: department, description: "Phí quẹt thẻ theo file doanh thu" });
  }
  if (appFeeAmount > 0) {
    lines.push({ accountCode: "6428", debit: appFeeAmount, categoryCode: WALLET_GRAB_EXPENSE_CATEGORY_CODE, pnlItemCode: WALLET_GRAB_EXPENSE_PNL_ITEM_CODE, departmentCode: department, description: "Phí bán hàng qua app theo file doanh thu" });
  }
  const credits: RevenuePosJournalLine[] = [];
  if (groupRevenue !== 0 || (svc === 0 && vat === 0 && adjust === 0)) {
    credits.push({ accountCode: "511", credit: groupRevenue, categoryCode: row.revenueSource || null, pnlItemCode: channelPnlItem, departmentCode: department });
  }
  if (svc !== 0) credits.push({ accountCode: "511", credit: svc, categoryCode: REVENUE_SVC_CATEGORY_CODE, pnlItemCode: channelPnlItem, departmentCode: department, description: "Phí dịch vụ (SVC)" });
  if (vat !== 0) credits.push({ accountCode: "511", credit: vat, categoryCode: REVENUE_VAT_CATEGORY_CODE, pnlItemCode: channelPnlItem, departmentCode: department, description: "Thuế GTGT" });
  if (adjust !== 0) credits.push({ accountCode: "511", credit: adjust, categoryCode: REVENUE_ADJUST_CATEGORY_CODE, pnlItemCode: channelPnlItem, departmentCode: department, description: "Chênh lệch Tổng tiền so với Doanh thu − Giảm giá + SVC + Thuế" });
  return [...lines, ...credits];
}
