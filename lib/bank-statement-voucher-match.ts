/**
 * Nối dòng sao kê vào chứng từ ngân hàng KẾ TOÁN ĐÃ LẬP TAY, thay vì lập thêm phiếu mới.
 *
 * Tài khoản của khách có những giao dịch phải ghi chú rất nhiều, nên kế toán hay lập phiếu tay
 * ngay lúc phát sinh rồi mới import sao kê sau. Trước đây import luôn lập phiếu mới: một đồng
 * tiền thành hai chứng từ, phiếu tay nằm lại không gắn dòng sao kê nào nên bảng "Tiền về đủ
 * chưa" không đếm (bảng đó đọc sổ sao kê), còn Báo cáo nguồn tiền thì cộng dư đúng số đó.
 * Khách phản hồi 18/09/2026: không phải một phiếu mà rất nhiều phiếu.
 *
 * Luật chọn ở đây cố tình CHẶT: chỉ nối khi có đúng một ứng viên. Hai phiếu cùng số tiền trong
 * cùng vài ngày mà đoán bừa thì tiền nối nhầm chứng từ, sai âm thầm và không ai soát ra — thà
 * để kế toán tự chọn trên màn đối chiếu.
 */

/** Chứng từ do chính luồng import sao kê sinh ra — không bao giờ là "phiếu lập tay". */
export const MACHINE_VOUCHER_SOURCE_SCOPES = ["BANK_STATEMENT_AUTO", "BANK_STATEMENT_SPLIT"];

/** Ngày phiếu tay và ngày ngân hàng ghi sổ lệch nhau bao nhiêu ngày thì vẫn coi là một khoản. */
export const MANUAL_VOUCHER_MATCH_DAY_GAP = 3;

export type ManualVoucherCandidate = {
  id: string;
  code: string;
  voucherType: string;
  documentChannel: string;
  sourceScope: string;
  moneySourceCode: string;
  amount: number;
  voucherDate: Date;
  externalRef: string | null;
  businessEffect: string;
};

export type ManualVoucherTarget = {
  voucherType: string;
  moneySourceCode: string;
  amount: number;
  documentDate: Date;
};

export type ManualVoucherPick =
  | { voucher: ManualVoucherCandidate; reason: null }
  | { voucher: null; reason: "NONE" | "AMBIGUOUS" };

function dayGap(left: Date, right: Date) {
  return Math.abs(left.getTime() - right.getTime()) / 86_400_000;
}

/**
 * Chọn phiếu lập tay cho một dòng sao kê.
 *
 * Gọi sau khi đã lọc ở tầng truy vấn (cùng cửa hàng, chưa gắn dòng sao kê nào); hàm này soát
 * lại toàn bộ điều kiện để chỗ nào gọi cũng ra cùng một kết quả, và để test được không cần DB.
 */
export function pickManualVoucherForStatement(
  candidates: ManualVoucherCandidate[],
  target: ManualVoucherTarget,
  dayGapLimit = MANUAL_VOUCHER_MATCH_DAY_GAP,
): ManualVoucherPick {
  const amount = Math.round(target.amount);
  if (!(amount > 0) || !target.moneySourceCode) return { voucher: null, reason: "NONE" };

  const matched = candidates.filter((row) => row.voucherType === target.voucherType
    // Phiếu tiền mặt không bao giờ là vế đối ứng của một dòng sao kê ngân hàng.
    && row.documentChannel === "BANK"
    && !MACHINE_VOUCHER_SOURCE_SCOPES.includes(row.sourceScope)
    && row.moneySourceCode === target.moneySourceCode
    && Math.round(row.amount) === amount
    && dayGap(row.voucherDate, target.documentDate) <= dayGapLimit);

  if (matched.length === 0) return { voucher: null, reason: "NONE" };
  if (matched.length > 1) return { voucher: null, reason: "AMBIGUOUS" };
  return { voucher: matched[0], reason: null };
}
