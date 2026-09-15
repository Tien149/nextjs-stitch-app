import walletFeeLimits from "./wallet-fee-limits.json" with { type: "json" };

export const WALLET_CARD_FEE_CATEGORY_CODE = "CHI_PHI_QUET_THE";
export const WALLET_GRAB_EXPENSE_CATEGORY_CODE = "CHI_PHI_BAN_HANG_GRAB";

/**
 * Hạng mục P&L của hai khoản phí quyết toán ví. Dòng phí trước đây chỉ mang danh mục Thu/Chi
 * (`categoryCode`) — mà bảng P&L gom chi phí theo HẠNG MỤC P&L (`pnlItemCode`), nên phí cà thẻ
 * và phí bán hàng qua app rơi hết vào ô vàng "Chưa phân loại P&L" thay vì đứng tên riêng.
 * Hai tầng danh mục không liên kết nhau trong MasterDataItem nên phải khai cặp đôi ở đây.
 */
export const WALLET_CARD_FEE_PNL_ITEM_CODE = "PNL_CP_QUETTHE";
export const WALLET_GRAB_EXPENSE_PNL_ITEM_CODE = "PNL_CP_BANHANG_GRAB";

export const WALLET_FEE_PNL_ITEMS = [
  { code: WALLET_CARD_FEE_PNL_ITEM_CODE, name: "Chi phí quẹt thẻ / phí ví", categoryCode: WALLET_CARD_FEE_CATEGORY_CODE },
  { code: WALLET_GRAB_EXPENSE_PNL_ITEM_CODE, name: "Chi phí bán hàng qua app", categoryCode: WALLET_GRAB_EXPENSE_CATEGORY_CODE },
] as const;

/** Hạng mục P&L tương ứng với danh mục phí ví; danh mục khác (người dùng tự chọn) giữ nguyên null. */
export function walletFeePnlItemCode(categoryCode: string | null | undefined) {
  const code = String(categoryCode ?? "").trim().toUpperCase();
  return WALLET_FEE_PNL_ITEMS.find((item) => item.categoryCode === code)?.code ?? null;
}

export type WalletSettlementInput = { id: string; netAmount: number };

export type WalletSettlementAllocation = WalletSettlementInput & {
  grossAmount: number;
  feeAmount: number;
  grabExpenseAmount: number;
  cardFeeAmount: number;
};

function allocateInteger(total: number, weights: number[]) {
  const roundedTotal = Math.max(0, Math.round(total));
  const normalized = weights.map((value) => Math.max(0, Math.round(value)));
  const weightTotal = normalized.reduce((sum, value) => sum + value, 0);
  if (roundedTotal === 0 || weightTotal === 0) return normalized.map(() => 0);

  const exact = normalized.map((value) => (roundedTotal * value) / weightTotal);
  const result = exact.map(Math.floor);
  let remainder = roundedTotal - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let cursor = 0; remainder > 0; cursor += 1, remainder -= 1) {
    result[order[cursor % order.length].index] += 1;
  }
  return result;
}

/**
 * Phân bổ gross/phí cho nhiều dòng sao kê cùng cửa hàng + Ngày doanh thu.
 * Tổng được giữ chính xác đến đồng; cách phân bổ theo tỷ trọng tiền thực nhận
 * giúp luồng auto và thủ công cho cùng một kết quả ổn định.
 */
export function allocateWalletSettlementGroup(input: {
  grossAmount: number;
  grabRevenueAmount: number;
  transactions: WalletSettlementInput[];
}): WalletSettlementAllocation[] {
  const transactions = input.transactions.map((row) => ({ ...row, netAmount: Math.round(row.netAmount) }));
  const netTotal = transactions.reduce((sum, row) => sum + row.netAmount, 0);
  const grossAmount = Math.round(input.grossAmount);
  if (transactions.length === 0 || netTotal <= 0) throw new Error("Không có giao dịch Ví hợp lệ để quyết toán.");
  if (grossAmount < netTotal) throw new Error("Tổng gross Ví nhỏ hơn số thực nhận ngân hàng.");

  const feeTotal = grossAmount - netTotal;
  const grabExpenseTotal = Math.min(Math.max(0, Math.round(input.grabRevenueAmount)), feeTotal);
  const feeByTransaction = allocateInteger(feeTotal, transactions.map((row) => row.netAmount));
  const grabByTransaction = allocateInteger(grabExpenseTotal, feeByTransaction);

  return transactions.map((row, index) => ({
    ...row,
    grossAmount: row.netAmount + feeByTransaction[index],
    feeAmount: feeByTransaction[index],
    grabExpenseAmount: grabByTransaction[index],
    cardFeeAmount: feeByTransaction[index] - grabByTransaction[index],
  }));
}

/**
 * TRẦN TỶ LỆ PHÍ QUYẾT TOÁN VÍ.
 *
 * Phí ví = Gross khai − số tiền ngân hàng thực trả. Công thức đúng, nhưng nó tin tuyệt đối vào
 * Gross: khai Gross bằng doanh thu CẢ NGÀY trong khi ngân hàng mới trả về một phần thì toàn bộ
 * phần chưa về bị ghi thành phí. Tháng 08/2026 hai ví Momo của ASA ra phí 30–98% theo đúng
 * đường này (phiếu ASA-00047: về 328.391 đ, phí 22.286.614 đ) — gần 466 triệu chi phí không có
 * thật nằm trên P&L mà không có một dòng cảnh báo nào.
 *
 * Trần này vốn đã có trong scripts/backfill-wallet-manual-reconciliation.cjs, nhưng script chỉ
 * là công cụ chạy tay — hai cửa mà người dùng thực sự đi (import sao kê, form Ghi nhận quyết
 * toán ví) thì không kiểm gì ngoài "Gross ≥ tiền về". Đưa về đây để cả ba nơi dùng chung một
 * luật, sửa một chỗ là cả ba đổi theo.
 *
 * Ngưỡng: thẻ/ví 10%, Grab 35% (hoa hồng Grab thực tế 24–25%). Đây là số script đặt sẵn từ
 * trước, đủ rộng để không chặn nhầm giao dịch thật.
 */

export const WALLET_FEE_RATE_LIMITS: { CARD_WALLET: number; GRAB: number } = walletFeeLimits;

export type WalletFeeBucket = keyof typeof WALLET_FEE_RATE_LIMITS;

export type WalletFeeCheck = {
  ok: boolean;
  /** Tỷ lệ phí trên gross; null khi số liệu không tính được tỷ lệ (gross ≤ 0). */
  rate: number | null;
  limit: number;
  feeAmount: number;
};

/** Phí có nằm trong ngưỡng an toàn của nhóm ví không. Gross ≤ 0 hoặc gross < net là số sai, không ok. */
export function checkWalletFeeRate(bucket: WalletFeeBucket, grossAmount: number, netAmount: number): WalletFeeCheck {
  const limit = WALLET_FEE_RATE_LIMITS[bucket];
  const fee = Math.round(grossAmount - netAmount);
  if (!(grossAmount > 0) || !(netAmount > 0) || grossAmount < netAmount) {
    return { ok: false, rate: null, limit, feeAmount: Math.max(0, fee) };
  }
  const rate = fee / grossAmount;
  return { ok: rate <= limit, rate, limit, feeAmount: fee };
}

/**
 * Câu báo lỗi cho người nhập: nói đúng số, đúng ngưỡng, và chỉ ra nguyên nhân hay gặp nhất
 * (tiền về nhiều đợt) thay vì chỉ "số không hợp lệ".
 */
export function walletFeeRateMessage(check: WalletFeeCheck, grossAmount: number, netAmount: number) {
  const money = (value: number) => Math.round(value).toLocaleString("vi-VN");
  if (check.rate === null) {
    return `Số gốc ở ví (${money(grossAmount)} đ) phải lớn hơn 0 và không được nhỏ hơn số thực nhận (${money(netAmount)} đ).`;
  }
  return `Phí ${money(check.feeAmount)} đ trên số gốc ${money(grossAmount)} đ là ${(check.rate * 100).toFixed(1)}%, vượt ngưỡng ${(check.limit * 100).toFixed(0)}%. `
    + `Thường là do tiền về làm nhiều đợt mà Gross lại khai cho cả ngày — hãy khai Gross đúng phần tương ứng với ${money(netAmount)} đ đã về, `
    + `hoặc để trống Gross để hệ thống chỉ ghi nhận tiền thực về và tính phí sau khi có đủ doanh thu.`;
}
