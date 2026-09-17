/**
 * Tính lại phí của phiếu quyết toán ví theo doanh thu hiện tại ("chạy lại quyết toán").
 *
 * Phiếu quyết toán chỉ lưu KẾT QUẢ: số thực nhận về ngân hàng và phần phí. Gross của nó là
 * doanh thu của ví tại đúng thời điểm lập phiếu. Khi doanh thu ngày đó được nạp lại với số
 * khác (sửa file POS, xoá ngày rồi import lại), phiếu vẫn giữ số cũ và phần chênh nằm lại
 * trên P&L dưới dạng phí — yêu cầu chị Bình 17/09/2026: cần một nút bấm là phiếu tính lại.
 *
 * Nguyên tắc tính:
 *   - SỐ THỰC NHẬN không đổi. Đó là tiền thật đã về tài khoản theo sao kê, không phải số suy
 *     ra từ doanh thu; sửa nó là làm vỡ đối chiếu sao kê và sai số dư ngân hàng.
 *   - Gross mới = doanh thu hiện tại của ví đó trong ngày doanh thu của phiếu.
 *   - Phí mới = Gross mới − Thực nhận.
 *
 * Tính theo NHÓM (cửa hàng × ngày doanh thu × ví) chứ không theo từng phiếu: một ngày Grab có
 * thể trả nhiều đợt, mỗi đợt một phiếu, cộng lại mới bằng doanh thu của ví ngày đó. Tính lẻ
 * từng phiếu sẽ nhân doanh thu lên đúng bằng số đợt trả.
 */

/** Một phiếu quyết toán trong nhóm. Số tiền đều là số nguyên đồng. */
export type WalletSettlementVoucher = {
  id: string;
  code: string;
  /** Tiền thật về ngân hàng — giữ nguyên khi chạy lại. */
  amount: number;
  feeAmount: number;
  /** Phần hoa hồng Grab NẰM TRONG feeAmount; phần còn lại là phí quẹt thẻ. */
  grabExpenseAmount?: number | null;
};

export type WalletSettlementRerunChange = {
  id: string;
  code: string;
  feeBefore: number;
  feeAfter: number;
};

export type WalletSettlementRerunPlan = {
  /** Tổng tiền thật về ngân hàng của cả nhóm. */
  totalAmount: number;
  /** Gross các phiếu đang giữ = thực nhận + phí. */
  currentGross: number;
  /** Doanh thu của ví ngày đó theo dữ liệu hiện tại. */
  nextGross: number;
  currentFee: number;
  nextFee: number;
  /** Tổng hoa hồng Grab đang ghi — luôn được giữ nguyên, chỉ phần phí quẹt thẻ co giãn. */
  grabTotal: number;
  changes: WalletSettlementRerunChange[];
  /** Không có phiếu nào đổi số: phiếu đang khớp doanh thu, bấm chạy lại cũng không làm gì. */
  changed: boolean;
};

export type WalletSettlementRerunResult =
  | { ok: true; plan: WalletSettlementRerunPlan }
  | { ok: false; reason: string };

const money = (value: number) => new Intl.NumberFormat("vi-VN").format(Math.round(value));

/**
 * Chia `total` cho các phiếu theo tỷ trọng số thực nhận, phần dư dồn vào phiếu cuối để tổng
 * chia ra luôn khớp tuyệt đối — lệch một đồng ở đây là bút toán không cân Nợ/Có.
 */
function splitByAmount(total: number, amounts: number[]): number[] {
  const base = amounts.reduce((sum, value) => sum + value, 0);
  if (amounts.length === 0) return [];
  if (base <= 0) return amounts.map((_, index) => (index === 0 ? total : 0));
  const shares = amounts.map((amount) => Math.round((total * amount) / base));
  const drift = total - shares.reduce((sum, value) => sum + value, 0);
  shares[shares.length - 1] += drift;
  return shares;
}

export function planWalletSettlementRerun(input: {
  vouchers: WalletSettlementVoucher[];
  /** Doanh thu hiện tại của ví trong ngày doanh thu của nhóm phiếu. */
  currentRevenue: number;
  /** Tên ví để câu báo lỗi đọc được; không có thì dùng mã. */
  walletLabel?: string;
}): WalletSettlementRerunResult {
  const vouchers = input.vouchers.map((voucher) => ({
    ...voucher,
    amount: Math.round(voucher.amount),
    feeAmount: Math.round(voucher.feeAmount),
    // Hoa hồng Grab không bao giờ lớn hơn phí đang ghi, cũng không âm — chặn ở đây để dữ
    // liệu cũ khai lệch không đẩy phí quẹt thẻ xuống số âm.
    grabExpenseAmount: Math.min(Math.max(0, Math.round(voucher.grabExpenseAmount || 0)), Math.max(0, Math.round(voucher.feeAmount))),
  }));
  if (vouchers.length === 0) return { ok: false, reason: "Không tìm thấy phiếu quyết toán ví nào để chạy lại" };

  const wallet = input.walletLabel || "ví này";
  const totalAmount = vouchers.reduce((sum, voucher) => sum + voucher.amount, 0);
  const currentFee = vouchers.reduce((sum, voucher) => sum + voucher.feeAmount, 0);
  const grabTotal = vouchers.reduce((sum, voucher) => sum + voucher.grabExpenseAmount, 0);
  const nextGross = Math.round(input.currentRevenue);
  const nextFee = nextGross - totalAmount;

  if (nextGross <= 0) {
    return {
      ok: false,
      reason: `Ngày doanh thu của phiếu chưa có đồng doanh thu nào của ${wallet} trong hệ thống. Nạp lại file doanh thu của ngày này rồi mới chạy lại quyết toán.`,
    };
  }
  if (nextFee < 0) {
    return {
      ok: false,
      reason: `Doanh thu hiện tại của ${wallet} (${money(nextGross)} đ) nhỏ hơn số tiền đã về ngân hàng (${money(totalAmount)} đ). Kiểm tra lại file doanh thu vừa nạp — quyết toán không thể ra phí âm.`,
    };
  }
  if (nextFee < grabTotal) {
    return {
      ok: false,
      reason: `Phí mới (${money(nextFee)} đ) nhỏ hơn phần hoa hồng Grab đang ghi trên phiếu (${money(grabTotal)} đ). Số này phải sửa tay theo sao kê, không chạy lại tự động được.`,
    };
  }

  // Giữ nguyên phần Grab của từng phiếu (lấy từ sao kê, không liên quan doanh thu POS), chỉ
  // chia lại phần phí quẹt thẻ theo tỷ trọng tiền về của từng phiếu.
  const cardFees = splitByAmount(nextFee - grabTotal, vouchers.map((voucher) => voucher.amount));
  const changes = vouchers.map((voucher, index) => ({
    id: voucher.id,
    code: voucher.code,
    feeBefore: voucher.feeAmount,
    feeAfter: voucher.grabExpenseAmount + cardFees[index],
  }));

  return {
    ok: true,
    plan: {
      totalAmount,
      currentGross: totalAmount + currentFee,
      nextGross,
      currentFee,
      nextFee,
      grabTotal,
      changes,
      changed: changes.some((change) => change.feeAfter !== change.feeBefore),
    },
  };
}
