import {
  branchCodeFromInternalPartner,
  INTERNAL_PAYABLE_ACCOUNT,
  INTERNAL_RECEIVABLE_ACCOUNT,
  internalPartnerCode,
  isInternalPartnerCode,
} from "@/lib/cost-reallocation";
import { ADVANCE_RECEIVABLE_ACTION, PREPAID_ALLOCATION_ACTION } from "@/lib/voucher-rules";

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
  /** Chi hộ: đối tác sẽ hoàn lại tiền — vế Nợ 131 mang mã này, không mang mã người nhận tiền. */
  receivablePartnerCode?: string | null;
  categoryCode: string | null;
  pnlItemCode: string | null;
  depositAction: string | null;
  debtAction: string | null;
};

export type JournalLineInput = {
  accountCode: string;
  debit?: number;
  credit?: number;
  partnerCode?: string | null;
  categoryCode?: string | null;
  pnlItemCode?: string | null;
};

export function cashAccountFor(moneySourceCode: string) {
  return moneySourceCode.toUpperCase().includes("CASH") ? "1111" : "1121";
}

/**
 * Tài khoản đối ứng của phiếu THU, kèm lý do để hiển thị/kiểm thử.
 *
 * `pnlItemGroup` là nhóm lớn của Hạng mục P&L kế toán chọn trên phiếu. Chọn hạng mục thuộc
 * nhóm Thu nhập khác là khai rõ "khoản này là thu nhập khác" (lãi ngân hàng, thanh lý tài sản,
 * bồi thường...), nên nó thắng cái fallback "có đối tác thì treo 131" bên dưới — nếu không,
 * khoản thu nhập khác có ghi tên đối tác sẽ nằm im ở phải thu và không bao giờ lên dòng
 * "7. Thu nhập khác" của P&L.
 */
export function receiptCounterAccount(voucher: VoucherForPosting, categoryGroup: string | null, pnlItemGroup: string | null = null) {
  if (voucher.depositAction === "COLLECT" || voucher.depositAction === "SUPPLEMENT") {
    return { account: "3387", reason: "Nhận tiền cọc — khách ứng trước, chưa phải doanh thu" };
  }
  if (voucher.depositAction === "REVENUE") {
    return { account: "511", reason: "Chuyển tiền cọc thành doanh thu" };
  }
  if (voucher.debtAction === "SETTLE") {
    return { account: "131", reason: "Thu hồi công nợ phải thu — không phát sinh doanh thu mới" };
  }
  // Khoản mục thu/chi là tầng chốt: khai nhóm doanh thu thì đó là doanh thu bán hàng, dù ai đó
  // lỡ gắn thêm hạng mục P&L thu nhập khác. Để hạng mục thắng ở đây thì một khoản doanh thu
  // rơi xuống dòng 7 và biến mất khỏi doanh thu thuần — sai lệch nặng hơn nhiều so với việc bỏ
  // qua một hạng mục khai nhầm.
  if (categoryGroup === "REVENUE_SOURCE") {
    return { account: "511", reason: "Doanh thu bán hàng" };
  }
  if (pnlItemGroup === "OTHER_INCOME") {
    return { account: "711", reason: "Thu nhập khác theo hạng mục P&L đã chọn" };
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
  if (voucher.debtAction === ADVANCE_RECEIVABLE_ACTION) {
    // Chi hộ một nhà hàng khác là công nợ NỘI BỘ: để ở 131 thì toàn công ty thấy một khoản
    // phải thu bên ngoài không bao giờ triệt tiêu, trong khi 1368 khớp thẳng với 3368 mà nhà
    // hàng thụ hưởng ghi ở bút toán đối ứng.
    if (isInternalPartnerCode(voucher.receivablePartnerCode)) {
      return { account: INTERNAL_RECEIVABLE_ACCOUNT, reason: "Chi hộ nhà hàng khác — treo phải thu nội bộ, không phải chi phí" };
    }
    return { account: "131", reason: "Chi hộ — treo phải thu của đối tác sẽ hoàn lại, không phải chi phí" };
  }
  // Chi trả trước: tiền ra một cục nhưng chi phí thuộc về nhiều kỳ sau. Vào chi phí ngay ở đây
  // thì lịch phân bổ sinh từ chính phiếu này sẽ ghi chi phí lần thứ hai.
  if (voucher.debtAction === PREPAID_ALLOCATION_ACTION) {
    return { account: "242", reason: "Chi trả trước — treo chi phí trả trước, vào P&L dần theo lịch phân bổ" };
  }
  if (categoryGroup === "CAPEX") {
    return { account: "211", reason: "Chi đầu tư tài sản — ghi tăng tài sản, không vào P&L" };
  }
  if (categoryGroup === "COGS") {
    return { account: "632", reason: "Giá vốn hàng bán" };
  }
  // Chi phí khác (811) không phải chi phí vận hành: phạt, bồi thường, lỗ thanh lý tài sản...
  // Đứng ở dòng "8. Chi phí khác" dưới lợi nhuận hoạt động, không làm hỏng tỷ lệ OPEX/doanh thu.
  if (categoryGroup === "OTHER_EXPENSE") {
    return { account: "811", reason: "Chi phí khác" };
  }
  return { account: "6428", reason: "Chi phí vận hành" };
}

export function voucherJournalLines(voucher: VoucherForPosting, categoryGroup: string | null, pnlItemGroup: string | null = null) {
  const cashAccount = cashAccountFor(voucher.moneySourceCode);
  if (voucher.voucherType === "RECEIPT") {
    const { account, reason } = receiptCounterAccount(voucher, categoryGroup, pnlItemGroup);
    return {
      reason,
      lines: [
        { accountCode: cashAccount, debit: voucher.amount },
        { accountCode: account, credit: voucher.amount, partnerCode: voucher.partnerCode, categoryCode: voucher.categoryCode, pnlItemCode: voucher.pnlItemCode },
      ] as JournalLineInput[],
    };
  }
  // Khi kế toán chọn Hạng mục P&L riêng, nhóm của hạng mục đó quyết định dòng P&L.
  // Nếu để trống, giữ cách hạch toán cũ theo Khoản mục thu/chi để dữ liệu lịch sử không đổi.
  const { account, reason } = paymentCounterAccount(voucher, pnlItemGroup || categoryGroup);
  // Chi hộ: khoản nợ thuộc về đối tác sẽ hoàn tiền, và phiếu không có mặt trên P&L nên
  // hạng mục P&L (nếu ai đó lỡ khai) không được đi kèm dòng 131.
  const isAdvanceReceivable = voucher.debtAction === ADVANCE_RECEIVABLE_ACTION;
  // Chi trả trước cũng chưa có mặt trên P&L ở kỳ này: hạng mục P&L của phiếu là hạng mục mà
  // LỊCH PHÂN BỔ sẽ mang, không phải của dòng 242, nên không đi kèm bút toán này.
  const isPrepaidAllocation = voucher.debtAction === PREPAID_ALLOCATION_ACTION;
  return {
    reason,
    lines: [
      {
        accountCode: account,
        debit: voucher.amount,
        partnerCode: isAdvanceReceivable ? (voucher.receivablePartnerCode || voucher.partnerCode) : voucher.partnerCode,
        categoryCode: voucher.categoryCode,
        pnlItemCode: isAdvanceReceivable || isPrepaidAllocation ? null : voucher.pnlItemCode,
      },
      { accountCode: cashAccount, credit: voucher.amount },
    ] as JournalLineInput[],
  };
}

/**
 * Bút toán ĐỐI ỨNG của phiếu chi hộ nhà hàng khác, ghi ở sổ của nhà hàng được chi hộ.
 *
 * Nam Mê trả tiền cho NCC thay Asa thì bên Nam Mê chỉ có "tiền ra, treo phải thu nội bộ".
 * Nếu dừng ở đó, khoản NCC mà Asa đang nợ vẫn nằm nguyên trên sổ Asa dù tiền đã trả — đúng
 * lỗi khách báo. Vế còn lại của nghiệp vụ nằm ở sổ Asa: GIẢM phải trả NCC, chuyển sang PHẢI
 * TRẢ NỘI BỘ Nam Mê. Hai tài khoản 1368/3368 triệt tiêu nhau khi xem toàn công ty.
 *
 * Trả null khi phiếu không phải chi hộ nội bộ (chi hộ đối tác bên ngoài giữ nguyên như cũ).
 */
export function advanceReceivableCounterpartJournal(voucher: {
  voucherType: string;
  amount: number;
  branchCode: string;
  partnerCode: string | null;
  receivablePartnerCode?: string | null;
  debtAction: string | null;
}) {
  if (voucher.voucherType !== "PAYMENT" || voucher.debtAction !== ADVANCE_RECEIVABLE_ACTION) return null;
  const beneficiaryBranch = branchCodeFromInternalPartner(voucher.receivablePartnerCode);
  const payerBranch = (voucher.branchCode || "").trim().toUpperCase();
  if (!beneficiaryBranch || !payerBranch || beneficiaryBranch === payerBranch) return null;
  if (!(voucher.amount > 0)) return null;
  return {
    branchCode: beneficiaryBranch,
    lines: [
      { accountCode: "331", debit: voucher.amount, partnerCode: voucher.partnerCode },
      { accountCode: INTERNAL_PAYABLE_ACCOUNT, credit: voucher.amount, partnerCode: internalPartnerCode(payerBranch) },
    ] as JournalLineInput[],
  };
}
