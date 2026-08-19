import type { RawTxClient } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";

/** Gạch một khoản công nợ cho phiếu: dùng chung cho phiếu 1 đối tác lẫn từng dòng phân bổ. */
async function settleDebtLine(
  tx: RawTxClient,
  voucher: { id: string; voucherType: string; voucherDate: Date; branchCode: string },
  line: { debtReference: string; partnerCode: string | null; amount: number },
  actor: string,
) {
  const debt = await tx.debtRecord.findFirst({ where: { code: line.debtReference, deletedAt: null } });
  if (!debt || debt.branchCode !== voucher.branchCode) throw new Error(`Không tìm thấy công nợ ${line.debtReference} trong chi nhánh`);
  const expectedDebtType = voucher.voucherType === "RECEIPT" ? "RECEIVABLE" : "PAYABLE";
  if (debt.debtType !== expectedDebtType) throw new Error(`Phiếu ${voucher.voucherType === "RECEIPT" ? "Thu" : "Chi"} không khớp loại công nợ ${debt.code}`);
  if (line.partnerCode && line.partnerCode !== debt.partnerCode) throw new Error(`Đối tượng không khớp công nợ ${debt.code}`);
  if (line.amount > debt.outstandingAmount) throw new Error(`Số tiền thanh toán vượt dư nợ ${debt.code}`);
  const outstandingAmount = debt.outstandingAmount - line.amount;
  await tx.debtSettlement.create({
    data: { debtId: debt.id, voucherId: voucher.id, settlementDate: voucher.voucherDate, amount: line.amount, createdBy: actor },
  });
  await tx.debtRecord.update({
    where: { id: debt.id },
    data: { outstandingAmount, status: outstandingAmount === 0 ? "SETTLED" : "PARTIAL" },
  });
}

type VoucherForSideEffects = {
  id: string;
  code: string;
  voucherType: string;
  voucherDate: Date;
  partnerCode: string | null;
  partnerName: string;
  counterpartyAccountName?: string | null;
  branchCode: string;
  moneySourceCode: string;
  categoryCode: string | null;
  amount: number;
  description: string;
  depositAction: string | null;
  depositCode: string | null;
  debtAction: string | null;
  debtReference: string | null;
  allocationMonths: number | null;
  allocationStartPeriod: string | null;
};

export async function applyVoucherSideEffects(
  tx: RawTxClient,
  voucher: VoucherForSideEffects,
  actor: string,
) {
  if (voucher.depositAction) {
    const previousHistory = await tx.depositHistory.findFirst({
      where: { voucherId: voucher.id, action: voucher.depositAction },
    });
    if (!previousHistory) {
      if (voucher.depositAction === "COLLECT") {
        if (!voucher.partnerCode) throw new Error("Thu tiền cọc bắt buộc có mã khách hàng");
        const code = voucher.depositCode || `COC-${voucher.code}`;
        await tx.deposit.create({
          data: {
            code,
            receivedDate: voucher.voucherDate,
            partnerCode: voucher.partnerCode,
            partnerName: voucher.partnerName,
            objectName: voucher.counterpartyAccountName || null,
            branchCode: voucher.branchCode,
            moneySourceCode: voucher.moneySourceCode,
            amount: voucher.amount,
            remainingAmount: voucher.amount,
            purpose: voucher.description,
            histories: {
              create: { action: "COLLECT", amount: voucher.amount, actionDate: voucher.voucherDate, treatmentNote: "Thu tiền cọc", actor, voucherId: voucher.id },
            },
          },
        });
      } else if (voucher.depositAction === "SUPPLEMENT") {
        if (!voucher.partnerCode) throw new Error("Khách chuyển bổ sung tiền cọc bắt buộc có mã khách hàng");
        const code = voucher.depositCode || `COC-${voucher.code}`;
        const deposit = await tx.deposit.findFirst({ where: { code, deletedAt: null } });
        if (deposit) {
          if (deposit.branchCode !== voucher.branchCode) throw new Error(`Tiền cọc ${code} không thuộc chi nhánh chứng từ`);
          await tx.deposit.update({
            where: { id: deposit.id },
            data: {
              amount: deposit.amount + voucher.amount,
              remainingAmount: deposit.remainingAmount + voucher.amount,
              status: "HOLDING",
              histories: {
                create: { action: "SUPPLEMENT", amount: voucher.amount, actionDate: voucher.voucherDate, treatmentNote: "Khách chuyển bổ sung", actor, voucherId: voucher.id, note: voucher.description },
              },
            },
          });
        } else {
          await tx.deposit.create({
            data: {
              code,
              receivedDate: voucher.voucherDate,
              partnerCode: voucher.partnerCode,
              partnerName: voucher.partnerName,
              objectName: voucher.counterpartyAccountName || null,
              branchCode: voucher.branchCode,
              moneySourceCode: voucher.moneySourceCode,
              amount: voucher.amount,
              remainingAmount: voucher.amount,
              purpose: voucher.description,
              histories: {
                create: { action: "SUPPLEMENT", amount: voucher.amount, actionDate: voucher.voucherDate, treatmentNote: "Khách chuyển bổ sung", actor, voucherId: voucher.id },
              },
            },
          });
        }
      } else {
        if (!voucher.depositCode) throw new Error("Trừ/hoàn/chuyển doanh thu tiền cọc bắt buộc có mã tiền cọc");
        const deposit = await tx.deposit.findUnique({ where: { code: voucher.depositCode } });
        if (!deposit || deposit.branchCode !== voucher.branchCode) throw new Error(`Không tìm thấy tiền cọc ${voucher.depositCode} trong chi nhánh`);
        if (voucher.amount > deposit.remainingAmount) throw new Error(`Số tiền xử lý vượt số dư cọc ${voucher.depositCode}`);
        const remainingAmount = deposit.remainingAmount - voucher.amount;
        await tx.deposit.update({
          where: { id: deposit.id },
          data: {
            remainingAmount,
            status: remainingAmount === 0
              ? (voucher.depositAction === "REFUND" ? "REFUNDED" : voucher.depositAction === "REVENUE" ? "REVENUE" : "OFFSET")
              : "HOLDING",
            histories: {
              create: {
                action: voucher.depositAction,
                amount: voucher.amount,
                actionDate: voucher.voucherDate,
                treatmentNote: voucher.depositAction === "REFUND" ? "Hoàn cọc" : voucher.depositAction === "REVENUE" ? "Chuyển doanh thu" : "Cấn trừ vào bill",
                actor,
                voucherId: voucher.id,
                note: voucher.description,
              },
            },
          },
        });
      }
    }
  }

  if (voucher.debtAction === "SETTLE") {
    if (!voucher.debtReference) throw new Error("Thanh toán công nợ bắt buộc có mã công nợ");
    const previousSettlement = await tx.debtSettlement.findFirst({ where: { voucherId: voucher.id } });
    if (!previousSettlement) {
      await settleDebtLine(tx, voucher, {
        debtReference: voucher.debtReference,
        partnerCode: voucher.partnerCode,
        amount: voucher.amount,
      }, actor);
    }
  }

  // Phiếu đại diện (một người nhận, nhiều đối tác): gạch nợ theo từng dòng phân bổ.
  // Idempotent theo (voucherId, debtId) để duyệt lại không gạch đôi.
  const partnerAllocations = await tx.voucherAllocation.findMany({ where: { voucherId: voucher.id } });
  if (partnerAllocations.length > 0) {
    const existingSettlements = await tx.debtSettlement.findMany({
      where: { voucherId: voucher.id },
      select: { debtId: true },
    });
    const settledDebtIds = new Set(existingSettlements.map((row) => row.debtId));
    for (const line of partnerAllocations) {
      if (!line.debtReference) continue;
      const debt = await tx.debtRecord.findFirst({ where: { code: line.debtReference, deletedAt: null }, select: { id: true } });
      if (debt && settledDebtIds.has(debt.id)) continue;
      await settleDebtLine(tx, voucher, {
        debtReference: line.debtReference,
        partnerCode: line.partnerCode,
        amount: line.amount,
      }, actor);
    }
  }

  if (voucher.voucherType === "PAYMENT" && (voucher.allocationMonths || 0) > 1) {
    if (!voucher.allocationStartPeriod) throw new Error("Chi phí phân bổ bắt buộc có kỳ bắt đầu");
    const code = `PB-${voucher.code}`;
    const existing = await tx.accrual.findFirst({ where: { code, deletedAt: null } });
    if (!existing) {
      const numberOfPeriods = voucher.allocationMonths || 0;
      await tx.accrual.create({
        data: {
          code,
          name: voucher.description,
          branchCode: voucher.branchCode,
          categoryCode: voucher.categoryCode || "OPEX",
          totalAmount: voucher.amount,
          actualAmount: voucher.amount,
          startPeriod: voucher.allocationStartPeriod,
          numberOfPeriods,
          note: `Tạo từ chứng từ ${voucher.code}`,
          createdBy: actor,
          schedules: {
            create: Array.from({ length: numberOfPeriods }, (_, index) => ({
              period: addPeriod(voucher.allocationStartPeriod || "", index),
              amount: voucher.amount / numberOfPeriods,
            })),
          },
        },
      });
    }
  }
}
