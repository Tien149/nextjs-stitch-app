/**
 * Tính lại phí ví của một kỳ theo một công thức duy nhất (lib/wallet-fee-recalc-plan.ts) rồi ghi
 * vào phiếu QTVI + dòng phân bổ sao kê + sổ cái.
 *
 * Chạy tự động ở đầu mỗi lần Đồng bộ ghi sổ, và từ nút "Chạy lại quyết toán ví cả kỳ" /
 * "Chạy lại" một phiếu. Không đụng kỳ đã khoá, ngày chưa có doanh thu POS (giữ phí cũ).
 */
import type { MoneyTransfer } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { getRevenueSettlementReport } from "@/lib/reports";
import { isPeriodLocked } from "@/lib/phase3";
import { effectiveMoneyTransferDate } from "@/lib/money-transfer-date";
import { branchGoLiveDay } from "@/lib/wallet-go-live";
import { vietnamBusinessDayKey } from "@/lib/revenue-date";
import { isGrabMoneySource } from "@/lib/money-sources";
import { assertWalletCardFeeCategory, repostWalletSettlementJournal, walletFeeFields } from "@/lib/wallet-settlement-fee";
import { planWalletFeeRecalc, type RecalcLine, type RecalcVoucher, type RecalcVoucherChange } from "@/lib/wallet-fee-recalc-plan";
import { WALLET_CARD_FEE_CATEGORY_CODE } from "@/lib/wallet-settlement-allocation";

export type WalletFeeRecalcResult = {
  period: string;
  branchCode: string;
  changes: Array<RecalcVoucherChange & { branchCode: string }>;
  skipped: Array<{ code: string; reason: string }>;
  skippedDays: Array<{ day: string; walletCode: string; reason: string }>;
  updated: number;
  journalStatuses: Record<string, string>;
};

export async function recalcWalletFees(input: {
  period: string;
  branchCode: string;
  actor: string;
  preview?: boolean;
  /** Chỉ tính lại các ngày doanh thu này (nút Chạy lại một phiếu); trống = cả kỳ. */
  days?: string[];
}): Promise<WalletFeeRecalcResult> {
  const { period, branchCode } = input;
  const dayFilter = input.days && input.days.length > 0 ? new Set(input.days) : null;
  const inScope = (day: string) => day.startsWith(period) && (!dayFilter || dayFilter.has(day));
  const result: WalletFeeRecalcResult = { period, branchCode, changes: [], skipped: [], skippedDays: [], updated: 0, journalStatuses: {} };

  const report = await getRevenueSettlementReport(period, branchCode);
  const cells = report.rows.filter((row) => row.group === "WALLET");
  const walletCodes = [...new Set(cells.map((row) => row.moneySourceCode))];
  if (walletCodes.length === 0) return result;

  // Dòng phân bổ sao kê của kỳ (quét rộng 1 ngày mỗi đầu, lọc lại theo ngày nghiệp vụ) đã nối phiếu QTVI.
  const periodStart = new Date(`${period}-01T00:00:00.000Z`);
  const periodEnd = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1));
  const dayMs = 86_400_000;
  const periodLines = await prisma.bankStatementAllocation.findMany({
    where: {
      revenueDate: { gte: new Date(periodStart.getTime() - dayMs), lt: new Date(periodEnd.getTime() + dayMs) },
      creditAmount: { gt: 0 },
      decreaseMoneySourceCode: { in: walletCodes },
      OR: [{ operationType: null }, { operationType: { not: "OTHER_RECEIPT" } }],
      bankTransaction: { deletedAt: null, ...(branchCode === "ALL" ? {} : { branchCode }) },
    },
    select: { bankTransaction: { select: { matches: { where: { deletedAt: null, targetType: "WALLET_SETTLEMENT" }, select: { targetId: true } } } }, revenueDate: true },
  });
  const voucherIds = [...new Set(periodLines
    .filter((line) => line.revenueDate && inScope(vietnamBusinessDayKey(line.revenueDate)))
    .flatMap((line) => line.bankTransaction.matches.map((match) => match.targetId)))];
  if (voucherIds.length === 0) return result;

  const vouchers = await prisma.moneyTransfer.findMany({
    where: { id: { in: voucherIds }, transferPurpose: "WALLET_SETTLEMENT", status: "APPROVED", deletedAt: null },
  });
  const voucherById = new Map(vouchers.map((row) => [row.id, row]));

  // Mọi dòng của các phiếu này, kể cả ngày ngoài kỳ — phí phiếu là tổng phần của tất cả các dòng.
  const voucherMatches = await prisma.reconciliationMatch.findMany({
    where: { targetType: "WALLET_SETTLEMENT", targetId: { in: vouchers.map((row) => row.id) }, deletedAt: null, bankTransaction: { deletedAt: null } },
    select: {
      targetId: true,
      bankTransactionId: true,
      bankTransaction: { select: { allocations: { select: { id: true, revenueDate: true, creditAmount: true, grossAmount: true, operationType: true, decreaseMoneySourceCode: true } } } },
    },
  });
  // Một dòng sao kê nối hai phiếu QTVI là dữ liệu lạ — không tự chia, để người xem xử lý.
  const vouchersOfBank = new Map<string, Set<string>>();
  for (const match of voucherMatches) vouchersOfBank.set(match.bankTransactionId, new Set([...(vouchersOfBank.get(match.bankTransactionId) || []), match.targetId]));
  const lines: RecalcLine[] = [];
  const seenLine = new Set<string>();
  for (const match of voucherMatches) {
    const voucher = voucherById.get(match.targetId);
    if (!voucher) continue;
    if ((vouchersOfBank.get(match.bankTransactionId)?.size || 0) > 1) {
      result.skipped.push({ code: voucher.code, reason: "Dòng sao kê của phiếu đang nối với nhiều phiếu quyết toán — kiểm tra lại ở Sổ sao kê." });
      continue;
    }
    for (const allocation of match.bankTransaction.allocations) {
      if (seenLine.has(allocation.id) || !allocation.revenueDate || !(allocation.creditAmount > 0)) continue;
      if (allocation.operationType === "OTHER_RECEIPT") continue;
      if (allocation.decreaseMoneySourceCode && allocation.decreaseMoneySourceCode !== voucher.fromMoneySourceCode) continue;
      seenLine.add(allocation.id);
      lines.push({
        id: allocation.id,
        day: vietnamBusinessDayKey(allocation.revenueDate),
        walletCode: voucher.fromMoneySourceCode,
        creditAmount: Math.round(allocation.creditAmount),
        grossAmount: allocation.grossAmount,
        voucherId: voucher.id,
      });
    }
  }
  const skippedVoucherIds = new Set(result.skipped.map((row) => vouchers.find((voucher) => voucher.code === row.code)?.id));

  // Khoá sổ: phiếu bị khoá nếu kỳ ngày tiền về hoặc kỳ của bất kỳ ngày phí nào đã khoá.
  const lockCache = new Map<string, boolean>();
  const lockedAt = async (date: Date, branch: string) => {
    const key = `${date.toISOString().slice(0, 7)}|${branch}`;
    if (!lockCache.has(key)) lockCache.set(key, await isPeriodLocked(date, branch));
    return lockCache.get(key)!;
  };
  const sources = await prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", code: { in: walletCodes } }, select: { code: true, name: true } });
  const sourceName = new Map(sources.map((row) => [row.code, row.name]));
  const recalcVouchers: Array<RecalcVoucher & { branchCode: string }> = [];
  for (const voucher of vouchers) {
    if (skippedVoucherIds.has(voucher.id)) continue;
    const ownDays = [...new Set(lines.filter((line) => line.voucherId === voucher.id).map((line) => line.day))];
    let locked = await lockedAt(effectiveMoneyTransferDate(voucher), voucher.branchCode);
    for (const day of ownDays) {
      if (locked) break;
      locked = await lockedAt(new Date(`${day}T00:00:00.000Z`), voucher.branchCode);
    }
    if (locked) result.skipped.push({ code: voucher.code, reason: "Phiếu thuộc kỳ đã khoá sổ — giữ nguyên phí." });
    recalcVouchers.push({
      id: voucher.id,
      code: voucher.code,
      walletCode: voucher.fromMoneySourceCode,
      feeAmount: voucher.feeAmount,
      grabExpenseAmount: voucher.grabExpenseAmount,
      isGrab: isGrabMoneySource(voucher.fromMoneySourceCode, sourceName.get(voucher.fromMoneySourceCode)),
      locked,
      branchCode: voucher.branchCode,
    });
  }

  // Mỗi cửa hàng một lượt vì ngày lên hệ thống tính theo cửa hàng.
  const branches = [...new Set(recalcVouchers.map((row) => row.branchCode))];
  const plans: Array<ReturnType<typeof planWalletFeeRecalc> & { branchCode: string }> = [];
  for (const branch of branches) {
    const branchVouchers = recalcVouchers.filter((row) => row.branchCode === branch);
    const ids = new Set(branchVouchers.map((row) => row.id));
    const plan = planWalletFeeRecalc({
      // Ô khoá theo ngày × mã ví, mà ví thuộc riêng một cửa hàng — truyền cả bảng không lẫn.
      cells,
      lines: lines.filter((line) => line.voucherId && ids.has(line.voucherId)),
      vouchers: branchVouchers,
      inScope,
      goLiveDay: await branchGoLiveDay(branch),
    });
    plans.push({ ...plan, branchCode: branch });
    result.skippedDays.push(...plan.skippedDays);
  }
  for (const plan of plans) result.changes.push(...plan.changes.map((change) => ({ ...change, branchCode: plan.branchCode })));
  if (input.preview || result.changes.length === 0) return result;

  const needsCardCategory = result.changes.some((change) => change.feeAfter - change.grabAfter > 0 && !voucherById.get(change.id)?.feeCategoryCode);
  if (needsCardCategory && !(await assertWalletCardFeeCategory())) {
    result.skipped.push({ code: "*", reason: `Thiếu khoản mục ${WALLET_CARD_FEE_CATEGORY_CODE} trong danh mục Thu/Chi — khai trước rồi đồng bộ lại.` });
    return result;
  }

  const lineUpdates = plans.flatMap((plan) => plan.lineUpdates);
  const isGrabVoucher = new Map(recalcVouchers.map((row) => [row.id, row.isGrab]));
  const updatedRows: MoneyTransfer[] = [];
  await prisma.$transaction(async (tx) => {
    for (const row of lineUpdates) {
      const grab = isGrabVoucher.get(row.voucherId) || false;
      await tx.bankStatementAllocation.update({
        where: { id: row.id },
        data: { grossAmount: row.grossAmount, grabExpenseAmount: grab ? row.fee : 0, cardFeeAmount: grab ? 0 : row.fee },
      });
    }
    for (const change of result.changes) {
      const voucher = voucherById.get(change.id);
      if (!voucher) continue;
      updatedRows.push(await tx.moneyTransfer.update({ where: { id: voucher.id }, data: walletFeeFields(voucher, change.feeAfter, change.grabAfter) }));
    }
  });
  result.updated = updatedRows.length;
  for (const row of updatedRows) {
    const status = await repostWalletSettlementJournal(row, input.actor);
    if (status) result.journalStatuses[row.code] = status;
  }
  return result;
}
