import type { MoneyTransfer } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { ensureWalletFeePnlItems, postMoneyTransferJournals } from "@/lib/accounting";
import { WALLET_CARD_FEE_CATEGORY_CODE, WALLET_GRAB_EXPENSE_CATEGORY_CODE } from "@/lib/wallet-settlement-allocation";

/**
 * Đổi phí trên phiếu quyết toán ví và ghi lại bút toán — dùng chung cho nút "Chạy lại theo
 * doanh thu hiện tại" và màn Tách dòng tiền về. Số THỰC NHẬN không bao giờ đổi ở đây.
 */

/** Trường cần ghi khi phí đổi: tách phí thành hoa hồng Grab + phí quẹt thẻ, gắn khoản mục chuẩn. */
export function walletFeeFields(
  row: Pick<MoneyTransfer, "grabExpenseCategoryCode" | "feeCategoryCode">,
  feeAmount: number,
  grabExpenseAmount: number,
) {
  const grab = Math.min(Math.max(0, Math.round(grabExpenseAmount)), Math.max(0, Math.round(feeAmount)));
  const cardFee = Math.round(feeAmount) - grab;
  return {
    feeAmount: Math.round(feeAmount),
    grabExpenseAmount: grab,
    grabExpenseCategoryCode: grab > 0 ? (row.grabExpenseCategoryCode || WALLET_GRAB_EXPENSE_CATEGORY_CODE) : null,
    feeCategoryCode: cardFee > 0 ? (row.feeCategoryCode || WALLET_CARD_FEE_CATEGORY_CODE) : null,
  };
}

/** Khoản mục phí quẹt thẻ phải có trong danh mục thì phí mới lên đúng dòng P&L. */
export async function assertWalletCardFeeCategory() {
  const feeCategory = await prisma.masterDataItem.findFirst({
    where: { type: "REVENUE_EXPENSE_CATEGORY", code: WALLET_CARD_FEE_CATEGORY_CODE, group: "PAYMENT", status: "ACTIVE", deletedAt: null },
    select: { code: true },
  });
  return Boolean(feeCategory);
}

/**
 * Ghi lại bút toán ngay nếu phiếu ĐÃ lên sổ cái, để sổ cái không giữ số phí cũ tới lần đồng bộ
 * sau. Chưa lên sổ thì để nút Đồng bộ ghi sổ làm đúng lượt của nó. Trả về trạng thái ghi sổ,
 * hoặc null nếu phiếu chưa lên sổ.
 */
export async function repostWalletSettlementJournal(updated: MoneyTransfer, createdBy: string) {
  const posted = await prisma.journalEntry.findUnique({
    where: { sourceType_sourceId: { sourceType: "MONEY_TRANSFER", sourceId: updated.id } },
    select: { id: true },
  });
  if (!posted) return null;
  await ensureWalletFeePnlItems();
  const sources = await prisma.masterDataItem.findMany({
    where: { type: "MONEY_SOURCE", code: { in: [updated.fromMoneySourceCode, updated.toMoneySourceCode] } },
  });
  const sourceByCode = new Map(sources.map((source) => [source.code, source]));
  // Vế tiền theo ngày tiền về, vế phí theo từng ngày doanh thu — cùng hàm Đồng bộ ghi sổ dùng.
  const statuses = await postMoneyTransferJournals(updated, sourceByCode, createdBy);
  if (statuses.includes("SKIPPED_LOCKED")) return "SKIPPED_LOCKED";
  return statuses.find((status) => status !== "SKIPPED_EXISTS") || "SKIPPED_EXISTS";
}
