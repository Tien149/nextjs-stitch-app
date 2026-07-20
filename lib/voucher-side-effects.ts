import { Prisma } from "@prisma/custom-client";
import { addPeriod } from "@/lib/phase3";

type VoucherForSideEffects = {
  id: string;
  code: string;
  voucherType: string;
  voucherDate: Date;
  partnerCode: string | null;
  partnerName: string;
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
  tx: Prisma.TransactionClient,
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
        const deposit = await tx.deposit.findUnique({ where: { code } });
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
    const previousSettlement = await tx.debtSettlement.findUnique({ where: { voucherId: voucher.id } });
    if (!previousSettlement) {
      const debt = await tx.debtRecord.findUnique({ where: { code: voucher.debtReference } });
      if (!debt || debt.branchCode !== voucher.branchCode) throw new Error(`Không tìm thấy công nợ ${voucher.debtReference} trong chi nhánh`);
      const expectedDebtType = voucher.voucherType === "RECEIPT" ? "RECEIVABLE" : "PAYABLE";
      if (debt.debtType !== expectedDebtType) throw new Error(`Phiếu ${voucher.voucherType === "RECEIPT" ? "Thu" : "Chi"} không khớp loại công nợ ${debt.code}`);
      if (voucher.partnerCode && voucher.partnerCode !== debt.partnerCode) throw new Error(`Đối tượng không khớp công nợ ${debt.code}`);
      if (voucher.amount > debt.outstandingAmount) throw new Error(`Số tiền thanh toán vượt dư nợ ${debt.code}`);
      const outstandingAmount = debt.outstandingAmount - voucher.amount;
      await tx.debtSettlement.create({
        data: { debtId: debt.id, voucherId: voucher.id, settlementDate: voucher.voucherDate, amount: voucher.amount, createdBy: actor },
      });
      await tx.debtRecord.update({
        where: { id: debt.id },
        data: { outstandingAmount, status: outstandingAmount === 0 ? "SETTLED" : "PARTIAL" },
      });
    }
  }

  if (voucher.voucherType === "PAYMENT" && (voucher.allocationMonths || 0) > 1) {
    if (!voucher.allocationStartPeriod) throw new Error("Chi phí phân bổ bắt buộc có kỳ bắt đầu");
    const code = `PB-${voucher.code}`;
    const existing = await tx.accrual.findUnique({ where: { code } });
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
