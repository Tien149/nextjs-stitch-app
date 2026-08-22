export type DailyDepositBucketKey = "cash" | "transfer" | "card" | "grab" | "other";

export type DailyDepositHistoryInput = {
  action: string;
  amount: number | null;
  voucherId?: string | null;
  moneySourceGroup?: string | null;
  moneySourceCode?: string | null;
  moneySourceName?: string | null;
};

export type DailyDepositMovement = {
  depositIn: Record<DailyDepositBucketKey, number>;
  directRefundOut: Record<DailyDepositBucketKey, number>;
  offsetDeclared: Record<DailyDepositBucketKey, number>;
  /**
   * Tiền cọc mặt thực nhận, tách theo từng mã nguồn tiền mặt (mã rỗng = chưa khai nguồn).
   * Một ngày có thể nhận cọc vào nhiều quỹ tiền mặt khác nhau, mà mỗi quỹ phải nộp một
   * phiếu riêng nên số cần nộp không thể để chung một cục.
   */
  depositInCashBySource: Record<string, number>;
};

const emptyBuckets = (): Record<DailyDepositBucketKey, number> => ({
  cash: 0,
  transfer: 0,
  card: 0,
  grab: 0,
  other: 0,
});

function bucketForSource(row: DailyDepositHistoryInput): DailyDepositBucketKey {
  const sourceText = `${row.moneySourceCode || ""} ${row.moneySourceName || ""}`.toUpperCase();
  const value = (row.moneySourceGroup || "").trim().toUpperCase();
  if (["CASH", "TIEN MAT", "TIỀN MẶT"].includes(value)) return "cash";
  if (["BANK", "NGAN HANG", "NGÂN HÀNG", "TAI KHOAN NGAN HANG", "TÀI KHOẢN NGÂN HÀNG"].includes(value)) return "transfer";
  if (["WALLET", "VI", "VÍ", "POS", "VI DIEN TU", "VÍ ĐIỆN TỬ"].includes(value)) {
    return sourceText.includes("GRAB") ? "grab" : "card";
  }
  return "other";
}

/**
 * Quy đổi lịch sử cọc thành ba đại lượng độc lập của báo cáo Thu chi ngày:
 * - depositIn: tiền mới thực nhận, làm tăng dòng Đặt cọc và số tiền cần nộp;
 * - directRefundOut: tiền hoàn trực tiếp trên màn Tiền cọc, là tiền ra nhưng không phải chi phí P&L;
 * - offsetDeclared: cọc dùng thanh toán bill, cộng Thu ngân khai nhưng không tạo thêm tiền cần nộp.
 *
 * Chuyển doanh thu không nằm trong ba nhóm vì chỉ chuyển 3387 sang 511, không phải dòng tiền
 * và theo xác nhận nghiệp vụ cũng không đưa vào đối soát thu ngân.
 */
export function summarizeDailyDepositHistories(rows: DailyDepositHistoryInput[]): DailyDepositMovement {
  const result: DailyDepositMovement = {
    depositIn: emptyBuckets(),
    directRefundOut: emptyBuckets(),
    offsetDeclared: emptyBuckets(),
    depositInCashBySource: {},
  };
  const addDepositInCash = (row: DailyDepositHistoryInput, bucket: DailyDepositBucketKey, amount: number) => {
    if (bucket !== "cash") return;
    const code = (row.moneySourceCode || "").trim();
    result.depositInCashBySource[code] = (result.depositInCashBySource[code] || 0) + amount;
  };

  for (const row of rows) {
    const amount = Number(row.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const bucket = bucketForSource(row);

    if (["CREATE", "COLLECT", "SUPPLEMENT"].includes(row.action)) {
      result.depositIn[bucket] += Math.abs(amount);
      addDepositInCash(row, bucket, Math.abs(amount));
    } else if (row.action === "UPDATE") {
      if (amount > 0) {
        result.depositIn[bucket] += amount;
        addDepositInCash(row, bucket, amount);
      }
      // UPDATE âm được ghi sổ giống hoàn cọc; chỉ cộng tại đây nếu không có phiếu chi riêng.
      else if (!row.voucherId) result.directRefundOut[bucket] += Math.abs(amount);
    } else if (row.action === "REFUND") {
      // Lịch sử gắn voucher đã được danh sách phiếu chi tổng hợp, tránh cộng hai lần.
      if (!row.voucherId) result.directRefundOut[bucket] += Math.abs(amount);
    } else if (row.action === "OFFSET") {
      result.offsetDeclared[bucket] += Math.abs(amount);
    }
  }

  return result;
}
