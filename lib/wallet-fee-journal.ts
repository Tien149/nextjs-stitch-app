/**
 * PHÍ QUYẾT TOÁN VÍ GHI SỔ THEO NGÀY DOANH THU.
 *
 * Chốt 24/09/2026 (Nam Mê tháng 8): kế toán đối chiếu "Chi phí quẹt thẻ" trên Tổng hợp chi phí
 * với tab Tiền về đủ chưa. Bảng đó xếp phí theo NGÀY DOANH THU, còn sổ ghi cả phiếu quyết toán
 * ví theo NGÀY TIỀN VỀ — nên so từng ngày luôn trượt (T6-T7-CN dồn về thứ Hai) và phí doanh thu
 * cuối tháng rơi sang P&L tháng sau.
 *
 * Tách bút toán phiếu quyết toán ví làm hai:
 *  - Vế TIỀN (Nợ tiền nhận / Có ví theo số thực về) giữ NGÀY TIỀN VỀ — sổ quỹ vẫn khớp sao kê.
 *  - Vế PHÍ (Nợ 6428 / Có ví theo phần phí) ghi ở TỪNG NGÀY DOANH THU của các dòng sao kê nối
 *    với phiếu, mỗi ngày một bút toán `MONEY_TRANSFER_FEE` mã nguồn `<id phiếu>:<ngày>`.
 * Cộng hai vế lại vẫn đúng bằng bút toán một cục trước đây: ví giảm đủ gross.
 *
 * Số phí KHÔNG đổi ở đây — vẫn là phí trên phiếu (đã tính theo từng ngày từ 23/09). Chỉ đổi ngày.
 */
import type { MoneyTransferJournalInput, TransferJournalLine } from "@/lib/internal-transfer";
import { walletFeePnlItemCode } from "@/lib/wallet-settlement-allocation";

export const WALLET_FEE_SOURCE_TYPE = "MONEY_TRANSFER_FEE";

export const walletFeeSourceId = (transferId: string, day: string) => `${transferId}:${day}`;

/** Tiền tố mã nguồn của mọi bút toán phí thuộc một phiếu — để dọn khi xoá / rollback. */
export const walletFeeSourcePrefix = (transferId: string) => `${transferId}:`;

export type WalletFeeDayLine = {
  /** Ngày doanh thu (YYYY-MM-DD, ngày nghiệp vụ Việt Nam). */
  day: string;
  /** Tiền thực về của dòng sao kê. */
  netAmount: number;
  /** Gross của dòng; null/0 khi dòng cũ chưa được điền. */
  grossAmount: number | null;
};

export type WalletFeeDay = { day: string; cardFee: number; grabFee: number };

/** Chia một số nguyên theo tỷ trọng, giữ tổng tới đồng (phần dư theo phần lẻ lớn nhất). */
function allocateInteger(total: number, weights: number[]) {
  const target = Math.round(total);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (target === 0 || sum <= 0) return weights.map((_, index) => (index === 0 ? target : 0));
  const exact = weights.map((weight) => (target * weight) / sum);
  const out = exact.map(Math.floor);
  let rest = target - out.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, frac: value - Math.floor(value) })).sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (let k = 0; rest > 0; k += 1, rest -= 1) out[order[k % order.length].index] += 1;
  return out;
}

/**
 * Chia phí trên phiếu (phần thẻ + phần Grab) về từng ngày doanh thu.
 *
 * Tỷ trọng mỗi ngày: phí của chính dòng sao kê ngày đó (gross − thực về) khi MỌI dòng đều đã
 * có gross — trường hợp chuẩn sau khi tính theo từng ngày, khớp bảng Tiền về đủ chưa tới đồng.
 * Dòng cũ thiếu gross thì chia theo tiền thực về. Không nối dòng sao kê nào thì cả phí về
 * `fallbackDay` (Ngày doanh thu ghi trên phiếu, hoặc ngày tiền về).
 */
export function splitWalletFeeByDay(input: {
  feeAmount: number;
  grabExpenseAmount: number;
  lines: WalletFeeDayLine[];
  fallbackDay: string;
}): WalletFeeDay[] {
  const fee = Math.max(0, Math.round(input.feeAmount));
  const grab = Math.min(Math.max(0, Math.round(input.grabExpenseAmount || 0)), fee);
  const card = fee - grab;

  const byDay = new Map<string, { net: number; lineFee: number; complete: boolean }>();
  for (const line of input.lines) {
    const current = byDay.get(line.day) || { net: 0, lineFee: 0, complete: true };
    current.net += Math.max(0, line.netAmount);
    if (line.grossAmount && line.grossAmount > 0) current.lineFee += Math.max(0, line.grossAmount - line.netAmount);
    else current.complete = false;
    byDay.set(line.day, current);
  }
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return [{ day: input.fallbackDay, cardFee: card, grabFee: grab }];

  const useLineFee = days.every((day) => byDay.get(day)!.complete)
    && days.reduce((sum, day) => sum + byDay.get(day)!.lineFee, 0) > 0;
  const weights = days.map((day) => (useLineFee ? byDay.get(day)!.lineFee : byDay.get(day)!.net));
  const cardParts = allocateInteger(card, weights);
  const grabParts = allocateInteger(grab, weights);
  return days
    .map((day, index) => ({ day, cardFee: cardParts[index], grabFee: grabParts[index] }))
    .filter((row) => row.cardFee !== 0 || row.grabFee !== 0);
}

/** Dòng bút toán của vế phí một ngày: Nợ 6428 (Grab / thẻ tách dòng) / Có ví. */
export function walletFeeDayLines(
  day: WalletFeeDay,
  input: Pick<MoneyTransferJournalInput, "feeCategoryCode" | "grabExpenseCategoryCode" | "fromAccountCode">,
): TransferJournalLine[] {
  const lines: TransferJournalLine[] = [];
  if (day.grabFee > 0) lines.push({ accountCode: "6428", debit: day.grabFee, categoryCode: input.grabExpenseCategoryCode, pnlItemCode: walletFeePnlItemCode(input.grabExpenseCategoryCode) });
  if (day.cardFee > 0) lines.push({ accountCode: "6428", debit: day.cardFee, categoryCode: input.feeCategoryCode, pnlItemCode: walletFeePnlItemCode(input.feeCategoryCode) });
  lines.push({ accountCode: input.fromAccountCode, credit: day.grabFee + day.cardFee });
  return lines;
}
