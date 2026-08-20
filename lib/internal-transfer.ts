/**
 * Điều tiền nội bộ, kể cả LIÊN nhà hàng.
 *
 * Bối cảnh: tiền chạy qua lại giữa hai nhà hàng (Asa rút tiền chi hộ lương cho Nam Mê).
 * Nguồn tiền đi thuộc Asa, nguồn tiền nhận thuộc Nam Mê — trước đây bị chặn ngay ở preview
 * import vì "nguồn nhận không thuộc cửa hàng".
 *
 * Nghiệp vụ đúng phải làm hai việc cùng lúc:
 *  - Sổ quỹ: nguồn của bên chuyển giảm, nguồn của bên nhận tăng — mỗi vế nằm ở sổ của
 *    chính cửa hàng sở hữu nguồn tiền đó, không dồn cả hai vào một cửa hàng.
 *  - Công nợ nội bộ: đứng ở bên chuyển là PHẢI THU bên nhận (1368), đứng ở bên nhận là
 *    PHẢI TRẢ bên chuyển (3368). Xem toàn công ty thì hai vế triệt tiêu nhau.
 *
 * Khi bên kia hoàn tiền thì dùng phiếu thu/chi gạch vào chính mã công nợ nội bộ sinh ra ở
 * đây, y như phiếu phân bổ chi phí liên nhà hàng.
 */

import { INTERNAL_PAYABLE_ACCOUNT, INTERNAL_RECEIVABLE_ACCOUNT, internalPartnerCode } from "@/lib/cost-reallocation";
import { normalizeHeader } from "@/lib/import-templates";

function up(value: string | null | undefined) {
  return (value || "").trim().toUpperCase();
}

export type TransferMoneySource = {
  code: string;
  name: string;
  branch: string | null;
  status: string;
};

/**
 * Tìm nguồn tiền của phiếu điều tiền theo mã hoặc tên.
 *
 * Thứ tự ưu tiên: nguồn của đúng cửa hàng đang khai → nguồn dùng chung → nguồn của cửa
 * hàng khác (điều tiền liên nhà hàng). Bước cuối chỉ nhận khi tất cả ứng viên cùng thuộc
 * một cửa hàng, để hai nhà hàng đặt trùng tên nguồn thì báo lỗi thay vì đoán bừa bên nào.
 */
export function resolveTransferMoneySource(
  sources: TransferMoneySource[],
  rawValue: unknown,
  branchCode: string,
): { source: TransferMoneySource | null; ambiguous: boolean } {
  const value = String(rawValue || "").trim();
  if (!value) return { source: null, ambiguous: false };
  const normalized = normalizeHeader(value);
  const candidates = sources.filter(
    (source) => source.status === "ACTIVE" &&
      (source.code.toUpperCase() === value.toUpperCase() || normalizeHeader(source.name) === normalized),
  );
  if (candidates.length === 0) return { source: null, ambiguous: false };

  const branch = up(branchCode);
  const sourceBranch = (source: TransferMoneySource) => up(source.branch);
  if (branch && branch !== "ALL") {
    const own = candidates.find((source) => sourceBranch(source) === branch);
    if (own) return { source: own, ambiguous: false };
    const shared = candidates.find((source) => !sourceBranch(source) || sourceBranch(source) === "ALL");
    if (shared) return { source: shared, ambiguous: false };
  }
  const branches = new Set(candidates.map(sourceBranch));
  if (branches.size > 1) return { source: null, ambiguous: true };
  return { source: candidates[0], ambiguous: false };
}

/** Cửa hàng sở hữu nguồn tiền; nguồn khai ALL/để trống là nguồn dùng chung của mọi cửa hàng. */
export function moneySourceBranchCode(source: TransferMoneySource | null | undefined, branchCode: string) {
  const sourceBranch = up(source?.branch);
  return !sourceBranch || sourceBranch === "ALL" ? up(branchCode) : sourceBranch;
}

export type TransferBranchInput = {
  branchCode: string;
  fromBranchCode?: string | null;
  toBranchCode?: string | null;
};

/**
 * Cửa hàng hai đầu của phiếu. Cột trống (phiếu cũ, phiếu nộp tiền, quyết toán ví) hiểu là
 * cùng cửa hàng với phiếu, nên mọi nơi đọc được một cách thống nhất.
 */
export function transferBranches(transfer: TransferBranchInput) {
  const branchCode = up(transfer.branchCode);
  const fromBranchCode = up(transfer.fromBranchCode) || branchCode;
  const toBranchCode = up(transfer.toBranchCode) || branchCode;
  return {
    fromBranchCode,
    toBranchCode,
    isCrossBranch: Boolean(fromBranchCode && toBranchCode && fromBranchCode !== toBranchCode),
  };
}

export function isCrossBranchTransfer(transfer: TransferBranchInput) {
  return transferBranches(transfer).isCrossBranch;
}

/**
 * Vế nào của phiếu được tính vào sổ quỹ/báo cáo của một cửa hàng. Phiếu liên nhà hàng chỉ
 * góp một vế cho mỗi bên — tính cả hai là nhân đôi tiền của cửa hàng không sở hữu nguồn.
 * Xem toàn công ty (ALL) thì lấy đủ hai vế.
 */
export function transferLegsForBranch(transfer: TransferBranchInput, branchCode: string | null | undefined) {
  const branch = up(branchCode);
  const { fromBranchCode, toBranchCode } = transferBranches(transfer);
  if (!branch || branch === "ALL") return { out: true, in: true };
  return { out: fromBranchCode === branch, in: toBranchCode === branch };
}

/** Mã công nợ nội bộ sinh khi duyệt phiếu điều tiền liên nhà hàng. */
export function internalTransferDebtCodes(transferCode: string) {
  const code = (transferCode || "").trim();
  return { receivableCode: `${code}-PT`, payableCode: `${code}-PTR` };
}

export function internalTransferDebtDescriptions(input: { code: string; fromBranchCode: string; toBranchCode: string }) {
  const { code } = input;
  return {
    receivable: `${up(input.toBranchCode)} hoàn lại tiền đã nhận theo phiếu điều tiền ${code}`,
    payable: `Hoàn lại ${up(input.fromBranchCode)} tiền đã nhận theo phiếu điều tiền ${code}`,
  };
}

export type TransferJournalLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  partnerCode?: string | null;
  categoryCode?: string | null;
};

export type TransferJournal = {
  /** Cửa hàng ghi sổ bút toán này. */
  branchCode: string;
  /** Phiếu liên nhà hàng có hai bút toán nên phải khác sourceType mới lưu được cả hai. */
  sourceType: "MONEY_TRANSFER" | "MONEY_TRANSFER_COUNTERPART";
  description: string;
  lines: TransferJournalLine[];
};

export type MoneyTransferJournalInput = TransferBranchInput & {
  amount: number;
  feeAmount: number;
  grabExpenseAmount?: number | null;
  feeCategoryCode?: string | null;
  grabExpenseCategoryCode?: string | null;
  /** Tài khoản 1111/1121 của nguồn đi và nguồn nhận. */
  fromAccountCode: string;
  toAccountCode: string;
  description?: string | null;
};

/**
 * Dựng bút toán của phiếu điều tiền.
 *
 * Cùng cửa hàng: một bút toán như cũ — nguồn đi giảm cả phần phí, nguồn nhận tăng số thực
 * chuyển, phần chênh vào chi phí.
 *
 * Liên nhà hàng: tách làm hai. Bên chuyển thay vế "tăng nguồn nhận" bằng phải thu nội bộ,
 * bên nhận ghi tăng nguồn tiền đối ứng phải trả nội bộ. Phí/chênh lệch luôn nằm ở bên
 * chuyển vì tiền rời quỹ của bên đó.
 */
export function planMoneyTransferJournals(input: MoneyTransferJournalInput): TransferJournal[] {
  const { fromBranchCode, toBranchCode, isCrossBranch } = transferBranches(input);
  const amount = input.amount;
  const feeAmount = input.feeAmount || 0;
  const grossAmount = amount + feeAmount;
  const description = (input.description || "").trim();

  const grabExpenseAmount = Math.min(Math.max(0, input.grabExpenseAmount || 0), Math.max(0, feeAmount));
  const cardFeeAmount = Math.max(0, feeAmount - grabExpenseAmount);
  const feeLines: TransferJournalLine[] = [];
  if (grabExpenseAmount > 0) feeLines.push({ accountCode: "6428", debit: grabExpenseAmount, categoryCode: input.grabExpenseCategoryCode });
  if (cardFeeAmount > 0) feeLines.push({ accountCode: "6428", debit: cardFeeAmount, categoryCode: input.feeCategoryCode });
  if (feeAmount < 0) feeLines.push({ accountCode: "6428", credit: -feeAmount, categoryCode: input.feeCategoryCode });

  if (!isCrossBranch) {
    const lines: TransferJournalLine[] = [];
    if (amount > 0) lines.push({ accountCode: input.toAccountCode, debit: amount });
    lines.push(...feeLines);
    lines.push({ accountCode: input.fromAccountCode, credit: grossAmount });
    return [{ branchCode: fromBranchCode, sourceType: "MONEY_TRANSFER", description, lines }];
  }

  const outLines: TransferJournalLine[] = [];
  if (amount > 0) {
    outLines.push({ accountCode: INTERNAL_RECEIVABLE_ACCOUNT, debit: amount, partnerCode: internalPartnerCode(toBranchCode) });
  }
  outLines.push(...feeLines);
  outLines.push({ accountCode: input.fromAccountCode, credit: grossAmount });

  const journals: TransferJournal[] = [{
    branchCode: fromBranchCode,
    sourceType: "MONEY_TRANSFER",
    description: description ? `${description} — chuyển tiền cho ${toBranchCode}` : `Chuyển tiền cho ${toBranchCode}`,
    lines: outLines,
  }];

  if (amount > 0) {
    journals.push({
      branchCode: toBranchCode,
      sourceType: "MONEY_TRANSFER_COUNTERPART",
      description: description ? `${description} — nhận tiền từ ${fromBranchCode}` : `Nhận tiền từ ${fromBranchCode}`,
      lines: [
        { accountCode: input.toAccountCode, debit: amount },
        { accountCode: INTERNAL_PAYABLE_ACCOUNT, credit: amount, partnerCode: internalPartnerCode(fromBranchCode) },
      ],
    });
  }

  return journals;
}

export function transferJournalIsBalanced(journal: TransferJournal) {
  const debit = journal.lines.reduce((sum, line) => sum + (line.debit || 0), 0);
  const credit = journal.lines.reduce((sum, line) => sum + (line.credit || 0), 0);
  return Math.abs(debit - credit) < 0.5;
}
