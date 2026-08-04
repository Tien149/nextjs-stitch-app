/**
 * Định khoản cho vòng đời tiền cọc.
 *
 * Nhận cọc KHÔNG phải doanh thu: tiền vào nhưng ghi Có 3387 (khách ứng trước). Chỉ khi
 * cấn trừ vào bill (hoặc chuyển thẳng thành doanh thu) thì khoản cọc mới thành doanh thu
 * của đúng ngày cấn trừ — lúc đó không có tiền nào chạy, chỉ chuyển 3387 sang 511.
 *
 * Lịch sử cọc sinh ra từ phiếu thu/chi đã được chính phiếu đó định khoản, nên chỉ những
 * lịch sử KHÔNG gắn chứng từ (thao tác trực tiếp trên màn Tiền cọc) mới dùng bảng này.
 */
import { cashAccountFor } from "@/lib/voucher-accounting";

/** Làm tăng số cọc đang giữ. */
export const depositIncreaseActions = ["CREATE", "COLLECT", "SUPPLEMENT"];
/** Làm giảm số cọc đang giữ. */
export const depositDecreaseActions = ["OFFSET", "REFUND", "TRANSFER_REVENUE", "CANCEL"];
/** Cấn trừ/chuyển doanh thu: cọc biến thành doanh thu, không phải dòng tiền. */
export const depositRevenueActions = ["OFFSET", "TRANSFER_REVENUE"];

export type DepositHistoryForPosting = {
  action: string;
  amount: number;
  moneySourceCode: string;
  partnerCode: string | null;
};

export type DepositJournalResult = {
  reason: string;
  lines: Array<{ accountCode: string; debit?: number; credit?: number; partnerCode?: string | null }>;
};

export function depositJournalLines(input: DepositHistoryForPosting): DepositJournalResult | null {
  const amount = Math.abs(input.amount);
  if (amount <= 0) return null;
  const cashAccount = cashAccountFor(input.moneySourceCode);

  if (depositIncreaseActions.includes(input.action) || (input.action === "UPDATE" && input.amount > 0)) {
    return {
      reason: "Nhận tiền cọc — khách ứng trước, chưa phải doanh thu",
      lines: [
        { accountCode: cashAccount, debit: amount },
        { accountCode: "3387", credit: amount, partnerCode: input.partnerCode },
      ],
    };
  }

  if (depositRevenueActions.includes(input.action)) {
    return {
      reason: input.action === "OFFSET"
        ? "Cấn trừ tiền cọc vào bill — ghi nhận doanh thu ngày cấn trừ"
        : "Chuyển tiền cọc thành doanh thu",
      lines: [
        { accountCode: "3387", debit: amount, partnerCode: input.partnerCode },
        { accountCode: "511", credit: amount, partnerCode: input.partnerCode },
      ],
    };
  }

  if (input.action === "REFUND" || (input.action === "UPDATE" && input.amount < 0)) {
    return {
      reason: "Hoàn tiền cọc — giảm khoản khách ứng trước, không phải chi phí",
      lines: [
        { accountCode: "3387", debit: amount, partnerCode: input.partnerCode },
        { accountCode: cashAccount, credit: amount },
      ],
    };
  }

  // Huỷ phiếu cọc chỉ là đóng theo dõi, chưa quyết định tiền đi đâu -> không định khoản.
  return null;
}
