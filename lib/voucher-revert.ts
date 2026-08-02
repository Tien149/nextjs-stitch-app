import type { RawTxClient } from "@/lib/prisma";

/**
 * Hoàn tác những gì lúc duyệt chứng từ đã sinh ra (xem lib/voucher-side-effects.ts):
 * tiền cọc, thanh toán công nợ và khoản chi phí phân bổ.
 *
 * Nguyên tắc: chỉ bỏ duyệt khi hoàn tác được **trọn vẹn**. Nếu hệ quả đã bị nghiệp vụ
 * khác dùng tiếp (cọc đã trừ thêm, kỳ phân bổ đã ghi nhận) thì từ chối và nói rõ lý do,
 * còn hơn để số dư lệch âm thầm.
 *
 * Dùng client thô (không qua lớp xoá mềm) vì đây là hoàn tác chứ không phải xoá dữ liệu
 * nghiệp vụ: bản ghi phải mất hẳn thì lần duyệt sau mới tạo lại được với cùng mã.
 * Đổi lại, mọi truy vấn ở đây phải tự lọc `deletedAt: null`.
 */

type VoucherForRevert = {
  id: string;
  code: string;
  voucherType: string;
  branchCode: string;
  amount: number;
  depositAction: string | null;
  depositCode: string | null;
  debtAction: string | null;
  debtReference: string | null;
  allocationMonths: number | null;
};

export class VoucherRevertError extends Error {}

function fail(message: string): never {
  throw new VoucherRevertError(message);
}

async function revertDeposit(tx: RawTxClient, voucher: VoucherForRevert) {
  const history = await tx.depositHistory.findFirst({
    where: { voucherId: voucher.id, action: voucher.depositAction || undefined },
  });
  // Không có lịch sử nghĩa là lúc duyệt chưa kịp sinh gì -> không có gì phải trả lại.
  if (!history) return;

  const deposit = await tx.deposit.findFirst({ where: { id: history.depositId, deletedAt: null } });
  if (!deposit) fail("Không tìm thấy khoản tiền cọc gắn với chứng từ này để hoàn tác.");

  // Bất kỳ thao tác nào phát sinh sau chứng từ này đều dựa trên số dư hiện tại,
  // trừ ngược ra sẽ làm sai các bước sau đó.
  const laterHistories = await tx.depositHistory.count({
    where: { depositId: deposit.id, createdAt: { gt: history.createdAt }, NOT: { id: history.id } },
  });
  if (laterHistories > 0) {
    fail(`Tiền cọc ${deposit.code} đã có thao tác phát sinh sau chứng từ này. Hãy xử lý các thao tác đó trước khi bỏ duyệt.`);
  }

  const amount = history.amount ?? voucher.amount;

  if (voucher.depositAction === "COLLECT") {
    if (deposit.remainingAmount !== deposit.amount) {
      fail(`Tiền cọc ${deposit.code} đã được sử dụng một phần, không thể bỏ duyệt chứng từ tạo ra nó.`);
    }
    await tx.depositHistory.delete({ where: { id: history.id } });
    await tx.deposit.delete({ where: { id: deposit.id } });
    return;
  }

  if (voucher.depositAction === "SUPPLEMENT") {
    if (deposit.remainingAmount < amount) {
      fail(`Số dư tiền cọc ${deposit.code} nhỏ hơn khoản bổ sung, không thể hoàn tác.`);
    }
    await tx.depositHistory.delete({ where: { id: history.id } });
    const nextAmount = deposit.amount - amount;
    const nextRemaining = deposit.remainingAmount - amount;
    // Bổ sung vào một khoản cọc chưa từng tồn tại -> lúc duyệt đã tạo mới, giờ xoá hẳn.
    if (nextAmount <= 0) {
      await tx.deposit.delete({ where: { id: deposit.id } });
      return;
    }
    await tx.deposit.update({
      where: { id: deposit.id },
      data: { amount: nextAmount, remainingAmount: nextRemaining, status: "HOLDING" },
    });
    return;
  }

  // DEDUCT / REFUND / REVENUE: trả lại phần đã trừ khỏi số dư cọc.
  const restored = deposit.remainingAmount + amount;
  if (restored > deposit.amount) {
    fail(`Hoàn tác sẽ làm số dư tiền cọc ${deposit.code} vượt quá số đã thu, vui lòng kiểm tra lại.`);
  }
  await tx.depositHistory.delete({ where: { id: history.id } });
  await tx.deposit.update({
    where: { id: deposit.id },
    data: { remainingAmount: restored, status: "HOLDING" },
  });
}

async function revertDebtSettlement(tx: RawTxClient, voucher: VoucherForRevert) {
  const settlement = await tx.debtSettlement.findUnique({ where: { voucherId: voucher.id } });
  if (!settlement) return;

  const debt = await tx.debtRecord.findFirst({ where: { id: settlement.debtId, deletedAt: null } });
  if (!debt) fail("Không tìm thấy khoản công nợ gắn với chứng từ này để hoàn tác.");

  const outstandingAmount = debt.outstandingAmount + settlement.amount;
  if (outstandingAmount > debt.originalAmount) {
    fail(`Hoàn tác sẽ làm dư nợ ${debt.code} vượt quá giá trị gốc, vui lòng kiểm tra lại.`);
  }

  await tx.debtSettlement.delete({ where: { id: settlement.id } });
  await tx.debtRecord.update({
    where: { id: debt.id },
    data: {
      outstandingAmount,
      status: outstandingAmount >= debt.originalAmount ? "OPEN" : "PARTIAL",
    },
  });
}

async function revertAccrual(tx: RawTxClient, voucher: VoucherForRevert) {
  if (voucher.voucherType !== "PAYMENT" || (voucher.allocationMonths || 0) <= 1) return;

  const code = `PB-${voucher.code}`;
  const accrual = await tx.accrual.findFirst({ where: { code, deletedAt: null } });
  if (!accrual) return;

  const postedSchedules = await tx.accrualSchedule.count({
    where: { accrualId: accrual.id, NOT: { status: "PLANNED" } },
  });
  if (postedSchedules > 0) {
    fail(`Khoản phân bổ ${code} đã ghi nhận ${postedSchedules} kỳ, không thể bỏ duyệt chứng từ.`);
  }

  await tx.accrual.delete({ where: { id: accrual.id } });
}

export async function revertVoucherSideEffects(tx: RawTxClient, voucher: VoucherForRevert) {
  if (voucher.depositAction) await revertDeposit(tx, voucher);
  if (voucher.debtAction === "SETTLE") await revertDebtSettlement(tx, voucher);
  await revertAccrual(tx, voucher);
}
