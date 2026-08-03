/**
 * Định khoản cho phiếu thu/chi.
 *
 * Tiền vào không đồng nghĩa với doanh thu, tiền ra không đồng nghĩa với chi phí.
 * Trước đây mọi phiếu thu đều ghi Có 511 và mọi phiếu chi đều ghi Nợ 6428, khiến báo cáo
 * P&L bị thổi lên bằng chính các khoản chỉ là dịch chuyển dòng tiền (nhận cọc, trả nợ,
 * mua tài sản). Bảng dưới đây tách hai việc đó ra.
 */

export type VoucherForPosting = {
  voucherType: string;
  amount: number;
  moneySourceCode: string;
  partnerCode: string | null;
  categoryCode: string | null;
  depositAction: string | null;
  debtAction: string | null;
};

export type JournalLineInput = {
  accountCode: string;
  debit?: number;
  credit?: number;
  partnerCode?: string | null;
  categoryCode?: string | null;
};

export function cashAccountFor(moneySourceCode: string) {
  return moneySourceCode.toUpperCase().includes("CASH") ? "1111" : "1121";
}

/** Tài khoản đối ứng của phiếu THU, kèm lý do để hiển thị/kiểm thử. */
export function receiptCounterAccount(voucher: VoucherForPosting, categoryGroup: string | null) {
  if (voucher.depositAction === "COLLECT" || voucher.depositAction === "SUPPLEMENT") {
    return { account: "3387", reason: "Nhận tiền cọc — khách ứng trước, chưa phải doanh thu" };
  }
  if (voucher.depositAction === "REVENUE") {
    return { account: "511", reason: "Chuyển tiền cọc thành doanh thu" };
  }
  if (voucher.debtAction === "SETTLE") {
    return { account: "131", reason: "Thu hồi công nợ phải thu — không phát sinh doanh thu mới" };
  }
  if (categoryGroup === "REVENUE_SOURCE") {
    return { account: "511", reason: "Doanh thu bán hàng" };
  }
  if (voucher.partnerCode) {
    return { account: "131", reason: "Thu của đối tác, chưa gán khoản mục doanh thu" };
  }
  return { account: "711", reason: "Thu nhập khác" };
}

/** Tài khoản đối ứng của phiếu CHI, kèm lý do. */
export function paymentCounterAccount(voucher: VoucherForPosting, categoryGroup: string | null) {
  if (voucher.depositAction === "REFUND") {
    return { account: "3387", reason: "Hoàn tiền cọc — giảm khoản khách ứng trước, không phải chi phí" };
  }
  if (voucher.debtAction === "SETTLE") {
    return { account: "331", reason: "Trả nợ nhà cung cấp — không phải chi phí phát sinh mới" };
  }
  if (categoryGroup === "CAPEX") {
    return { account: "211", reason: "Chi đầu tư tài sản — ghi tăng tài sản, không vào P&L" };
  }
  if (categoryGroup === "COGS") {
    return { account: "632", reason: "Giá vốn hàng bán" };
  }
  return { account: "6428", reason: "Chi phí vận hành" };
}

export function voucherJournalLines(voucher: VoucherForPosting, categoryGroup: string | null) {
  const cashAccount = cashAccountFor(voucher.moneySourceCode);
  if (voucher.voucherType === "RECEIPT") {
    const { account, reason } = receiptCounterAccount(voucher, categoryGroup);
    return {
      reason,
      lines: [
        { accountCode: cashAccount, debit: voucher.amount },
        { accountCode: account, credit: voucher.amount, partnerCode: voucher.partnerCode, categoryCode: voucher.categoryCode },
      ] as JournalLineInput[],
    };
  }
  const { account, reason } = paymentCounterAccount(voucher, categoryGroup);
  return {
    reason,
    lines: [
      { accountCode: account, debit: voucher.amount, partnerCode: voucher.partnerCode, categoryCode: voucher.categoryCode },
      { accountCode: cashAccount, credit: voucher.amount },
    ] as JournalLineInput[],
  };
}
