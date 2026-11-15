/**
 * PHÍ VÍ TÍNH TỪ MỘT CÔNG THỨC DUY NHẤT (khách 15/11/2026, "việc 1").
 *
 * Trước đây phí ví được tính MỘT LẦN lúc lập phiếu quyết toán (QTVI) rồi lưu cứng trên phiếu; doanh
 * thu nạp lại, sao kê trả gộp nhiều ngày, tách dòng, nạp trùng... làm số đó cũ đi và chỉ nút "Chạy
 * lại" từng phiếu mới sửa — mỗi lần một kiểu sai mới (claimed gross null/0, gom nhóm theo ô ngày trên
 * phiếu, Grab chia sang quẹt thẻ...).
 *
 * Nay phí của từng NGÀY × VÍ = doanh thu − tiền về của đúng ngày đó (`expectedWalletFee`, cùng công
 * thức bảng Tiền về đủ chưa và bảng Kiểm phí ví). Phí ngày được chia cho các dòng sao kê của ngày đó
 * ĐÃ nối phiếu QTVI theo tỷ trọng tiền về; phí phiếu = tổng phần của các dòng của nó. Phiếu chỉ còn
 * là nơi chở con số, không còn là nơi quyết định con số.
 *
 * Phần thuần ở đây; nạp dữ liệu và ghi sổ ở lib/wallet-fee-recalc.ts.
 */
import { expectedWalletFee, type WalletFeeCell } from "@/lib/wallet-fee-check";

export type RecalcLine = {
  id: string;
  /** Ngày doanh thu (YYYY-MM-DD). */
  day: string;
  walletCode: string;
  creditAmount: number;
  grossAmount: number | null;
  /** Phiếu QTVI đang nối với dòng sao kê của dòng này (null = chưa vào sổ). */
  voucherId: string | null;
};

export type RecalcVoucher = {
  id: string;
  code: string;
  walletCode: string;
  feeAmount: number;
  grabExpenseAmount: number;
  isGrab: boolean;
  /** Kỳ của phiếu hoặc của một ngày phí của nó đã khoá — không được đụng. */
  locked: boolean;
};

export type RecalcVoucherChange = {
  id: string;
  code: string;
  feeBefore: number;
  feeAfter: number;
  grabBefore: number;
  grabAfter: number;
};

/** Chia số nguyên theo tỷ trọng, giữ tổng tới đồng (phần dư theo phần lẻ lớn nhất). */
export function allocateByWeight(total: number, weights: number[]) {
  const target = Math.round(total);
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (weights.length === 0) return [];
  if (target === 0 || sum <= 0) return weights.map((_, index) => (index === 0 ? target : 0));
  const exact = weights.map((weight) => (target * Math.max(0, weight)) / sum);
  const out = exact.map(Math.floor);
  let rest = target - out.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let k = 0; rest > 0; k += 1, rest -= 1) out[order[k % order.length].index] += 1;
  return out;
}

export function planWalletFeeRecalc(input: {
  /** Ô ngày × ví của bảng Tiền về đủ chưa trong phạm vi tính (đã lọc ví). */
  cells: WalletFeeCell[];
  /** Mọi dòng phân bổ sao kê (của ví) mà phiếu trong `vouchers` đang nối — kể cả ngày ngoài phạm vi. */
  lines: RecalcLine[];
  vouchers: RecalcVoucher[];
  /** Ngày trong phạm vi được tính lại (các ngày khác giữ phí đang lưu trên dòng). */
  inScope: (day: string) => boolean;
  /** Ngày lên hệ thống của cửa hàng: doanh thu trước ngày này phí = 0. */
  goLiveDay?: string | null;
}) {
  const voucherById = new Map(input.vouchers.map((row) => [row.id, row]));
  const cellByKey = new Map(input.cells.map((cell) => [`${cell.date}|${cell.moneySourceCode}`, cell]));
  const usable = (line: RecalcLine) => Boolean(line.voucherId && voucherById.has(line.voucherId) && !voucherById.get(line.voucherId)!.locked);

  // Phần phí của từng dòng trong phạm vi.
  const lineFee = new Map<string, number>();
  const skippedDays: Array<{ day: string; walletCode: string; reason: string }> = [];
  const linesByCell = new Map<string, RecalcLine[]>();
  for (const line of input.lines) {
    if (!input.inScope(line.day)) continue;
    const key = `${line.day}|${line.walletCode}`;
    linesByCell.set(key, [...(linesByCell.get(key) || []), line]);
  }
  for (const [key, cellLines] of linesByCell) {
    const [day, walletCode] = key.split("|");
    const cell = cellByKey.get(key);
    const beforeGoLive = Boolean(input.goLiveDay && day < input.goLiveDay);
    // Ngày chưa nạp doanh thu POS: không có gì để tính — giữ nguyên phí đang lưu.
    if (!beforeGoLive && (!cell || !(cell.revenue > 0))) {
      skippedDays.push({ day, walletCode, reason: "Chưa có doanh thu POS của ví trong ngày" });
      continue;
    }
    const dayFee = beforeGoLive || !cell ? 0 : expectedWalletFee(cell);
    const carriers = cellLines.filter(usable);
    if (carriers.length === 0) continue;
    // Dòng của phiếu đang khoá giữ phí cũ; phần còn lại của ngày chia cho các dòng mở.
    const lockedFee = cellLines
      .filter((line) => line.voucherId && voucherById.get(line.voucherId)?.locked)
      .reduce((sum, line) => sum + Math.max(0, (line.grossAmount || line.creditAmount) - line.creditAmount), 0);
    const shares = allocateByWeight(Math.max(0, dayFee - lockedFee), carriers.map((line) => line.creditAmount));
    carriers.forEach((line, index) => lineFee.set(line.id, shares[index]));
  }

  // Phí phiếu = tổng phần của các dòng; dòng ngoài phạm vi (hoặc ngày bị bỏ qua) giữ phí đang lưu.
  const lineUpdates: Array<{ id: string; grossAmount: number; fee: number; voucherId: string }> = [];
  const voucherFee = new Map<string, number>();
  for (const line of input.lines) {
    if (!line.voucherId || !voucherById.has(line.voucherId)) continue;
    const voucher = voucherById.get(line.voucherId)!;
    if (voucher.locked) continue;
    const recalculated = lineFee.get(line.id);
    const storedFee = Math.max(0, Math.round((line.grossAmount || line.creditAmount) - line.creditAmount));
    const fee = recalculated ?? storedFee;
    voucherFee.set(voucher.id, (voucherFee.get(voucher.id) || 0) + fee);
    const gross = Math.round(line.creditAmount) + fee;
    if (line.grossAmount === null || Math.round(line.grossAmount) !== gross) {
      lineUpdates.push({ id: line.id, grossAmount: gross, fee, voucherId: voucher.id });
    }
  }

  const changes: RecalcVoucherChange[] = [];
  for (const voucher of input.vouchers) {
    if (voucher.locked || !voucherFee.has(voucher.id)) continue;
    const feeAfter = voucherFee.get(voucher.id)!;
    // Ví Grab: toàn bộ phí là Chi phí bán hàng Grab; ví khác: toàn bộ là phí quẹt thẻ.
    const grabAfter = voucher.isGrab ? feeAfter : 0;
    const feeBefore = Math.round(voucher.feeAmount);
    const grabBefore = Math.round(voucher.grabExpenseAmount || 0);
    if (feeAfter !== feeBefore || grabAfter !== grabBefore || lineUpdates.some((row) => row.voucherId === voucher.id)) {
      changes.push({ id: voucher.id, code: voucher.code, feeBefore, feeAfter, grabBefore, grabAfter });
    }
  }
  return { changes, lineUpdates, skippedDays };
}
