import type { RawTxClient } from "@/lib/prisma";
import { advanceReceivableCounterpartDebtCode, advanceReceivableDebtCode } from "@/lib/voucher-side-effects";
import { ADVANCE_RECEIVABLE_ACTION } from "@/lib/voucher-rules";

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
  receivablePartnerCode?: string | null;
  allocationMonths: number | null;
};

/**
 * Bản mới của phiếu khi hoàn tác chỉ là bước giữa của thao tác SỬA (hoàn tác - cập nhật -
 * áp lại, trong đúng một transaction). Bỏ trống nghĩa là hoàn tác thật: bỏ duyệt hoặc xoá.
 */
type NextVoucherForRevert = {
  branchCode: string;
  debtAction: string | null;
  receivablePartnerCode: string | null;
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
  // Phiếu đại diện có thể gạch nhiều khoản nợ trong một lần duyệt — hoàn tác phải trả lại đủ.
  const settlements = await tx.debtSettlement.findMany({ where: { voucherId: voucher.id } });
  for (const settlement of settlements) {
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
}

/**
 * Phiếu chi hộ: trả lại khoản phải thu đã sinh lúc duyệt.
 * Chi hộ nhà hàng khác còn có vế phải trả nội bộ ở sổ bên kia — gỡ luôn, nếu không bên đó
 * còn treo một khoản nợ của phiếu không còn tồn tại.
 *
 * Khoản đã được thu lại một phần thì KHÔNG xoá được: DebtSettlement gắn onDelete Cascade nên
 * xoá khoản nợ là mất luôn các lần gạch, phiếu thu bên kia treo lơ lửng. Nhưng khi SỬA phiếu
 * mà cửa hàng, đối tác sẽ trả lại tiền và nội dung chi hộ vẫn y nguyên thì đó vẫn đúng khoản
 * nợ ấy — giữ nguyên bản ghi, bước áp hệ quả ngay sau đó đồng bộ lại số tiền/hạng mục/diễn
 * giải. Nhờ vậy sửa hạng mục hay diễn giải của phiếu chi hộ đã thu lại một phần vẫn lưu được.
 */
async function revertAdvanceReceivable(tx: RawTxClient, voucher: VoucherForRevert, next?: NextVoucherForRevert | null) {
  if (voucher.voucherType !== "PAYMENT" || voucher.debtAction !== ADVANCE_RECEIVABLE_ACTION) return;

  const keepSettled = Boolean(next)
    && next!.debtAction === ADVANCE_RECEIVABLE_ACTION
    && next!.branchCode === voucher.branchCode
    && (next!.receivablePartnerCode || null) === (voucher.receivablePartnerCode || null);

  for (const [code, label] of [
    [advanceReceivableDebtCode(voucher.code), "phải thu"],
    [advanceReceivableCounterpartDebtCode(voucher.code), "phải trả nội bộ"],
  ] as const) {
    const debt = await tx.debtRecord.findFirst({ where: { code, deletedAt: null } });
    if (!debt) continue;

    const settlements = await tx.debtSettlement.count({ where: { debtId: debt.id } });
    if (settlements > 0) {
      if (keepSettled) continue;
      fail(next
        ? `Khoản ${label} ${code} đã được thu lại một phần nên không đổi được Cửa hàng, Đối tác sẽ trả lại tiền hay Nội dung chi của phiếu chi hộ. Hãy bỏ duyệt phiếu thu đã gạch khoản này trước. Sửa hạng mục, diễn giải hoặc số tiền (không thấp hơn phần đã thu) thì lưu bình thường.`
        : `Khoản ${label} ${code} đã được gạch một phần. Hãy bỏ duyệt phiếu gạch nợ đó trước khi bỏ duyệt/xoá phiếu chi hộ.`);
    }

    await tx.debtRecord.delete({ where: { id: debt.id } });
  }
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

export async function revertVoucherSideEffects(
  tx: RawTxClient,
  voucher: VoucherForRevert,
  next?: NextVoucherForRevert | null,
) {
  if (voucher.depositAction) await revertDeposit(tx, voucher);
  // Không chỉ dựa vào debtAction: phiếu đại diện gạch nợ theo dòng phân bổ có debtAction rỗng.
  await revertDebtSettlement(tx, voucher);
  await revertAdvanceReceivable(tx, voucher, next);
  await revertAccrual(tx, voucher);
}
