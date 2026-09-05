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
