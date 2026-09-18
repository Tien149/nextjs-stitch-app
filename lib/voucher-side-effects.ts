import type { prisma, RawTxClient } from "@/lib/prisma";
import { branchCodeFromInternalPartner } from "@/lib/cost-reallocation";
import { ensureInternalPartner } from "@/lib/internal-partner";
import { buildAllocationSchedules } from "@/lib/phase3";
import { ADVANCE_RECEIVABLE_ACTION } from "@/lib/voucher-rules";

/**
 * Lỗi nghiệp vụ khi áp hệ quả của phiếu (gạch nợ, tiền cọc, chi hộ, phân bổ).
 * Tách riêng khỏi Error thường để route trả đúng 400 kèm câu giải thích cho người dùng,
 * thay vì để lọt xuống catch cuối và hiện "Internal Server Error".
 */
export class VoucherSideEffectError extends Error {}

/** Mã khoản phải thu sinh từ phiếu chi hộ — suy được từ mã phiếu nên duyệt lại không tạo trùng. */
export function advanceReceivableDebtCode(voucherCode: string) {
  return `CNTHU-${voucherCode}`;
}

/**
 * Mã khoản PHẢI TRẢ nội bộ ở sổ nhà hàng được chi hộ — vế đối ứng của `CNTHU-<mã phiếu>`.
 * Cùng quy ước đuôi "-PTR" với phiếu điều tiền và phiếu điều chuyển kho liên nhà hàng.
 */
export function advanceReceivableCounterpartDebtCode(voucherCode: string) {
  return `${advanceReceivableDebtCode(voucherCode)}-PTR`;
}

/**
 * Nhà hàng được chi hộ, khi "đối tác sẽ trả lại tiền" là một nhà hàng trong nhà.
 * Chi hộ cho đối tác BÊN NGOÀI trả null: khoản nợ đó không thuộc sổ của nhà hàng nào khác.
 * `knownBranchCodes` phải là danh mục cửa hàng thật — xem branchCodeFromInternalPartner.
 */
export function advanceReceivableBeneficiaryBranch(voucher: {
  voucherType: string;
  branchCode: string;
  debtAction: string | null;
  receivablePartnerCode?: string | null;
}, knownBranchCodes?: Iterable<string> | null) {
  if (voucher.voucherType !== "PAYMENT" || voucher.debtAction !== ADVANCE_RECEIVABLE_ACTION) return null;
  const beneficiaryBranch = branchCodeFromInternalPartner(voucher.receivablePartnerCode, knownBranchCodes);
  const payerBranch = (voucher.branchCode || "").trim().toUpperCase();
  if (!beneficiaryBranch || !payerBranch || beneficiaryBranch === payerBranch) return null;
  return beneficiaryBranch;
}

const vnd = (value: number) => `${value.toLocaleString("vi-VN")} đ`;

/**
 * Câu gợi ý đi kèm lỗi gạch nợ: chỉ thẳng ra mã nào điền được, hoặc vì sao chưa có mã nào.
 * Người dùng hay bí ở đúng chỗ này — biết "sai" rồi vẫn không biết phải gõ gì vào ô.
 */
async function openDebtHint(
  tx: RawTxClient,
  voucher: { voucherType: string; branchCode: string },
  partnerCode: string | null,
) {
  const debtType = voucher.voucherType === "RECEIPT" ? "RECEIVABLE" : "PAYABLE";
  const label = debtType === "RECEIVABLE" ? "phải thu" : "phải trả";
  if (!partnerCode) {
    return `Chọn đối tác trên phiếu trước, hệ thống sẽ hiện sẵn các khoản ${label} đang mở của họ để bấm chọn.`;
  }
  const open = await tx.debtRecord.findMany({
    where: { partnerCode, branchCode: voucher.branchCode, debtType, outstandingAmount: { gt: 0 }, deletedAt: null },
    orderBy: { documentDate: "desc" },
    take: 5,
    select: { code: true, outstandingAmount: true },
  });
  if (open.length > 0) {
    const list = open.map((item) => `${item.code} (còn ${vnd(item.outstandingAmount)})`).join(", ");
    return `Khoản ${label} đang mở của đối tác này tại ${voucher.branchCode}: ${list}. Chép đúng một trong các mã trên.`;
  }
  // Gặp nhiều nhất: khoản nợ có thật nhưng nằm ở sổ cửa hàng đã bỏ tiền ra, không phải cửa hàng đang lập phiếu.
  const elsewhere = await tx.debtRecord.findMany({
    where: { partnerCode, debtType, outstandingAmount: { gt: 0 }, deletedAt: null, branchCode: { not: voucher.branchCode } },
    take: 3,
    select: { code: true, branchCode: true },
  });
  if (elsewhere.length > 0) {
    const list = elsewhere.map((item) => `${item.code} ở ${item.branchCode}`).join(", ");
    return `Đối tác này không có khoản ${label} nào đang mở tại cửa hàng ${voucher.branchCode}, nhưng có ở cửa hàng khác: ${list}. Đổi ô Cửa hàng của phiếu sang đúng cửa hàng đó.`;
  }
  return voucher.voucherType === "RECEIPT"
    ? `Đối tác này chưa có khoản phải thu nào đang mở. Khoản chi hộ chỉ sinh ra khi phiếu chi đã được DUYỆT — kiểm tra phiếu chi hộ còn đang Nháp/Chờ duyệt không. Nợ có từ trước khi dùng phần mềm thì khai tay ở tab Công nợ rồi quay lại thu.`
    : `Đối tác này chưa có khoản phải trả nào đang mở tại cửa hàng ${voucher.branchCode}. Khai khoản phải trả ở tab Công nợ trước, rồi mới lập phiếu chi để gạch.`;
}

/** Gạch một khoản công nợ cho phiếu: dùng chung cho phiếu 1 đối tác lẫn từng dòng phân bổ. */
async function settleDebtLine(
  tx: RawTxClient,
  voucher: { id: string; voucherType: string; voucherDate: Date; branchCode: string },
  line: { debtReference: string; partnerCode: string | null; amount: number },
  actor: string,
) {
  const debt = await tx.debtRecord.findFirst({ where: { code: line.debtReference, deletedAt: null } });
  if (!debt) {
    const hint = await openDebtHint(tx, voucher, line.partnerCode);
    // Ô "Mã công nợ cần gạch" hay bị điền nhầm mã đối tác. Nhận ra được thì nói thẳng tên
    // đối tác đó ra, người dùng hiểu ngay mình vừa chép nhầm ô nào.
    const partner = await tx.masterDataItem.findFirst({
      where: { type: "PARTNER", code: line.debtReference },
      select: { name: true },
    });
    if (partner) {
      throw new VoucherSideEffectError(
        `[${line.debtReference}] là MÃ ĐỐI TÁC (${partner.name}), không phải mã khoản nợ. Ô này cần mã của từng KHOẢN NỢ — mỗi lần phát sinh một mã riêng, dạng CNTHU-<mã phiếu chi>. ${hint}`,
      );
    }
    const trashed = await tx.debtRecord.findFirst({
      where: { code: line.debtReference, deletedAt: { not: null } },
      select: { code: true },
    });
    if (trashed) {
      throw new VoucherSideEffectError(
        `Khoản nợ ${trashed.code} đang nằm trong Thùng rác nên không gạch được. Vào tab Công nợ khôi phục lại, rồi lưu phiếu này lần nữa.`,
      );
    }
    throw new VoucherSideEffectError(
      `Không có khoản nợ nào mang mã [${line.debtReference}]. Ô này cần mã KHOẢN NỢ lấy ở tab Công nợ (dạng CNTHU-<mã phiếu chi>), không phải mã đối tác hay mã phiếu. ${hint}`,
    );
  }
  if (debt.branchCode !== voucher.branchCode) {
    throw new VoucherSideEffectError(
      `Khoản nợ ${debt.code} nằm ở sổ cửa hàng ${debt.branchCode}, còn phiếu này lập ở ${voucher.branchCode} — tiền của hai cửa hàng không gạch chéo nhau được. Đổi ô Cửa hàng của phiếu sang ${debt.branchCode}, hoặc chọn khoản nợ của ${voucher.branchCode}.`,
    );
  }
  const expectedDebtType = voucher.voucherType === "RECEIPT" ? "RECEIVABLE" : "PAYABLE";
  if (debt.debtType !== expectedDebtType) {
    throw new VoucherSideEffectError(
      voucher.voucherType === "RECEIPT"
        ? `Khoản ${debt.code} là khoản PHẢI TRẢ — mình đang nợ ${debt.partnerName}, không phải họ nợ mình. Phiếu THU chỉ gạch được khoản phải thu; muốn trả tiền cho họ thì lập phiếu CHI.`
        : `Khoản ${debt.code} là khoản PHẢI THU — ${debt.partnerName} đang nợ mình, không phải mình nợ họ. Phiếu CHI chỉ gạch được khoản phải trả; muốn thu tiền về thì lập phiếu THU, nội dung "Thu lại công nợ phải thu".`,
    );
  }
  if (line.partnerCode && line.partnerCode !== debt.partnerCode) {
    throw new VoucherSideEffectError(
      `Khoản nợ ${debt.code} đứng tên ${debt.partnerCode} — ${debt.partnerName}, còn phiếu đang chọn đối tác ${line.partnerCode}. Sửa ô Tên đối tác trên phiếu thành ${debt.partnerName}, hoặc chọn khoản nợ khác đúng của ${line.partnerCode}.`,
    );
  }
  if (debt.outstandingAmount <= 0) {
    throw new VoucherSideEffectError(
      `Khoản nợ ${debt.code} đã tất toán (không còn dư nợ), gạch thêm lần nữa là trừ khống. Mở tab Công nợ xem khoản này đã được gạch bằng phiếu nào trước đó.`,
    );
  }
  if (line.amount > debt.outstandingAmount) {
    throw new VoucherSideEffectError(
      `Phiếu ghi ${vnd(line.amount)} nhưng khoản nợ ${debt.code} chỉ còn ${vnd(debt.outstandingAmount)} (phần còn lại đã gạch bằng phiếu khác). Hạ số tiền xuống tối đa ${vnd(debt.outstandingAmount)}; ${vnd(line.amount - debt.outstandingAmount)} dôi ra thì tách sang phiếu riêng hoặc gạch vào khoản nợ khác.`,
    );
  }
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
  pnlItemCode?: string | null;
  amount: number;
  description: string;
  depositAction: string | null;
  depositCode: string | null;
  debtAction: string | null;
  debtReference: string | null;
  receivablePartnerCode?: string | null;
  receivablePartnerName?: string | null;
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
        if (!voucher.partnerCode) throw new VoucherSideEffectError("Thu tiền cọc bắt buộc có mã khách hàng");
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
        if (!voucher.partnerCode) throw new VoucherSideEffectError("Khách chuyển bổ sung tiền cọc bắt buộc có mã khách hàng");
        const code = voucher.depositCode || `COC-${voucher.code}`;
        const deposit = await tx.deposit.findFirst({ where: { code, deletedAt: null } });
        if (deposit) {
          if (deposit.branchCode !== voucher.branchCode) throw new VoucherSideEffectError(`Tiền cọc ${code} không thuộc chi nhánh chứng từ`);
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
        if (!voucher.depositCode) throw new VoucherSideEffectError("Trừ/hoàn/chuyển doanh thu tiền cọc bắt buộc có mã tiền cọc");
        const deposit = await tx.deposit.findUnique({ where: { code: voucher.depositCode } });
        if (!deposit || deposit.branchCode !== voucher.branchCode) throw new VoucherSideEffectError(`Không tìm thấy tiền cọc ${voucher.depositCode} trong chi nhánh`);
        if (voucher.amount > deposit.remainingAmount) throw new VoucherSideEffectError(`Số tiền xử lý vượt số dư cọc ${voucher.depositCode}`);
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
    if (!voucher.debtReference) throw new VoucherSideEffectError("Phiếu gạch công nợ phải điền ô \"Mã công nợ cần gạch\" — chọn đối tác rồi bấm vào khoản nợ hiện ra bên dưới ô, hoặc chép mã ở tab Công nợ.");
    const previousSettlement = await tx.debtSettlement.findFirst({ where: { voucherId: voucher.id } });
    if (!previousSettlement) {
      await settleDebtLine(tx, voucher, {
        debtReference: voucher.debtReference,
        partnerCode: voucher.partnerCode,
        amount: voucher.amount,
      }, actor);
    }
  }

  // Chi hộ: tiền ra nhưng một đối tác khác sẽ trả lại -> sinh luôn khoản phải thu để tab
  // Công nợ đòi được và phiếu thu sau này gạch bằng mã này. Idempotent theo mã sinh từ mã
  // phiếu: duyệt lại hoặc sửa phiếu không được tạo thành hai khoản nợ.
  if (voucher.voucherType === "PAYMENT" && voucher.debtAction === ADVANCE_RECEIVABLE_ACTION) {
    if (!voucher.receivablePartnerCode) throw new VoucherSideEffectError("Phiếu chi hộ phải khai ô \"Đối tác sẽ trả lại tiền\" — khoản phải thu sẽ đứng tên người đó, sau này thu lại mới gạch được.");
    // Danh mục cửa hàng quyết định "đối tác sẽ trả lại tiền" có phải nhà hàng trong nhà không.
    // Đọc từ DB chứ không tin tiền tố NB- của mã đối tác: mã đó người dùng tự đặt được.
    const branchCodes = (await tx.masterDataItem.findMany({ where: { type: "BRANCH" }, select: { code: true } }))
      .map((row) => row.code);
    const beneficiaryBranch = advanceReceivableBeneficiaryBranch(voucher, branchCodes);
    const code = advanceReceivableDebtCode(voucher.code);
    const existing = await tx.debtRecord.findUnique({ where: { code } });
    if (existing?.deletedAt) {
      throw new VoucherSideEffectError(`Khoản phải thu ${code} đang nằm trong Thùng rác. Hãy khôi phục hoặc xóa hẳn trước khi duyệt lại phiếu.`);
    }
    if (!existing) {
      await tx.debtRecord.create({
        data: {
          code,
          debtType: "RECEIVABLE",
          // Chi hộ một nhà hàng khác là công nợ nội bộ; để EXTERNAL thì màn Công nợ xếp nhà
          // hàng nhà mình vào nhóm "Bên ngoài" và bộ lọc Nội bộ không thấy khoản này.
          partnerGroup: beneficiaryBranch ? "INTERNAL" : "EXTERNAL",
          partnerCode: voucher.receivablePartnerCode,
          partnerName: voucher.receivablePartnerName || voucher.receivablePartnerCode,
          branchCode: voucher.branchCode,
          documentDate: voucher.voucherDate,
          categoryCode: voucher.categoryCode,
          originalAmount: voucher.amount,
          outstandingAmount: voucher.amount,
          description: `Chi hộ theo chứng từ ${voucher.code}: ${voucher.description}`,
          sourceType: "VOUCHER",
          sourceId: voucher.id,
          status: "OPEN",
        },
      });
    }

    // Vế còn lại nằm ở sổ nhà hàng được chi hộ: nó thôi nợ NCC (tiền đã trả rồi) và quay
    // sang nợ nhà hàng đã ứng tiền. Thiếu khoản này thì công nợ NCC bên đó treo mãi, còn
    // nhìn toàn công ty thì khoản phải thu nội bộ không có gì triệt tiêu.
    if (beneficiaryBranch) {
      const counterpartCode = advanceReceivableCounterpartDebtCode(voucher.code);
      const existingCounterpart = await tx.debtRecord.findUnique({ where: { code: counterpartCode } });
      if (existingCounterpart?.deletedAt) {
        throw new VoucherSideEffectError(`Khoản phải trả nội bộ ${counterpartCode} đang nằm trong Thùng rác. Hãy khôi phục hoặc xóa hẳn trước khi duyệt lại phiếu.`);
      }
      if (!existingCounterpart) {
        const payerPartner = await ensureInternalPartner(tx as unknown as typeof prisma, voucher.branchCode);
        await tx.debtRecord.create({
          data: {
            code: counterpartCode,
            debtType: "PAYABLE",
            partnerGroup: "INTERNAL",
            partnerCode: payerPartner.code,
            partnerName: payerPartner.name,
            branchCode: beneficiaryBranch,
            documentDate: voucher.voucherDate,
            categoryCode: voucher.categoryCode,
            originalAmount: voucher.amount,
            outstandingAmount: voucher.amount,
            description: `Hoàn lại ${voucher.branchCode} khoản đã chi hộ theo chứng từ ${voucher.code}: ${voucher.description}`,
            sourceType: "VOUCHER",
            sourceId: voucher.id,
            status: "OPEN",
          },
        });
      }
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

  // Chi trả trước: phiếu khai sẵn số kỳ nên lịch phân bổ sinh thẳng từ số liệu của phiếu,
  // kế toán không phải gõ lại ở tab Trích trước & Phân bổ. Idempotent theo mã sinh từ mã phiếu.
  if (voucher.voucherType === "PAYMENT" && (voucher.allocationMonths || 0) > 1) {
    if (!voucher.allocationStartPeriod) throw new VoucherSideEffectError("Chi phí phân bổ bắt buộc có kỳ bắt đầu");
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
          // Giữ đúng hạng mục P&L của phiếu để từng kỳ phân bổ lên đúng dòng chi phí,
          // thay vì thành bút toán 6428 không phân loại được.
          pnlItemCode: voucher.pnlItemCode || null,
          totalAmount: voucher.amount,
          actualAmount: voucher.amount,
          startPeriod: voucher.allocationStartPeriod,
          numberOfPeriods,
          note: `Tạo từ chứng từ ${voucher.code}`,
          // Nguồn gốc quyết định vế Có của bút toán phân bổ hàng kỳ: khoản sinh từ phiếu chi
          // đã trả tiền nên rút dần 242, khoản khai tay chưa trả tiền thì treo 335.
          sourceType: "VOUCHER",
          sourceId: voucher.id,
          createdBy: actor,
          schedules: { create: buildAllocationSchedules(voucher.allocationStartPeriod || "", voucher.amount, numberOfPeriods) },
        },
      });
    }
  }
}
