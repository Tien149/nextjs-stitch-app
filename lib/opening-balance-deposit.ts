import type { Prisma } from "@prisma/custom-client";

type OpeningDeposit = {
  id: string;
  period: string;
  branchCode: string;
  objectCode: string | null;
  objectName: string | null;
  moneySourceCode: string | null;
  amount: number;
  note: string | null;
};

export async function applyOpeningDeposit(tx: Prisma.TransactionClient, opening: OpeningDeposit, actor?: string | null) {
  if (!opening.objectCode) throw new Error("Tiền cọc đầu kỳ thiếu đối tượng");
  const existing = await tx.deposit.findUnique({ where: { sourceOpeningBalanceId: opening.id } });
  if (existing) return existing;

  return tx.deposit.create({
    data: {
      code: `COC-DK-${opening.period.replace("-", "")}-${opening.id.slice(0, 8).toUpperCase()}`,
      receivedDate: new Date(`${opening.period}-01T00:00:00Z`),
      partnerCode: opening.objectCode,
      partnerName: opening.objectName || opening.objectCode,
      branchCode: opening.branchCode,
      moneySourceCode: opening.moneySourceCode,
      amount: opening.amount,
      remainingAmount: opening.amount,
      purpose: "Tiền cọc đầu kỳ",
      note: opening.note,
      sourceOpeningBalanceId: opening.id,
      histories: { create: {
        action: "OPENING",
        amount: opening.amount,
        actionDate: new Date(`${opening.period}-01T00:00:00Z`),
        treatmentNote: "Số dư tiền cọc đầu kỳ",
        actor: actor || null,
      } },
    },
  });
}

export async function revertOpeningDeposit(tx: Prisma.TransactionClient, openingBalanceId: string) {
  const deposit = await tx.deposit.findUnique({
    where: { sourceOpeningBalanceId: openingBalanceId },
    include: { histories: true },
  });
  if (!deposit) return;
  const untouched = deposit.status === "HOLDING"
    && deposit.remainingAmount === deposit.amount
    && deposit.histories.length === 1
    && deposit.histories[0].action === "OPENING"
    && !deposit.histories[0].voucherId;
  if (!untouched) throw new Error("Tiền cọc đã phát sinh sử dụng/hoàn hoặc chứng từ liên quan, không thể mở lại số dư đầu kỳ");
  await tx.deposit.delete({ where: { id: deposit.id } });
}
