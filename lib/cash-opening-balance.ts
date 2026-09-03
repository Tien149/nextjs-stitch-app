import { prisma } from "@/lib/prisma";
import { CASH_SOURCE_OPENING_TYPES, OPENING_BALANCE_EFFECTIVE_STATUSES } from "@/lib/opening-balance-rules";
import { effectiveMoneyTransferDate } from "@/lib/money-transfer-date";
import { transferBranches, transferLegsForBranch } from "@/lib/internal-transfer";

/**
 * Số dư đầu kỳ của quỹ/ngân hàng/ví là số KẾ THỪA, không phải số nhập tay từng tháng.
 *
 * Kế toán chỉ khai số dư một lần lúc bắt đầu dùng hệ thống (kỳ gốc). Từ kỳ sau, số dư đầu kỳ
 * bằng đúng số dư cuối kỳ trước, tức là số khai ở kỳ gốc cộng toàn bộ phát sinh thu/chi/điều
 * tiền từ kỳ gốc đến trước ngày đầu kỳ đang xem. Trước đây màn sổ quỹ đọc thẳng bảng
 * `OpeningBalance` theo đúng kỳ đang xem, nên qua tháng mới mà chưa ai nhập lại là ra 0 đ.
 *
 * Mốc gốc tính RIÊNG cho từng (cửa hàng, nguồn tiền): quỹ mở sau — ví mới, tài khoản ngân hàng
 * mới — được khai số dư ở kỳ muộn hơn, và bản khai mới nhất của nguồn đó (kỳ <= kỳ đang xem)
 * luôn thắng. Nhờ vậy khai lại số dư giữa năm vẫn dùng được như một lần chốt lại sổ: phát sinh
 * trước mốc khai coi như đã nằm trong số khai và không bị cộng thêm lần nữa.
 */

export type CashOpeningQuery = {
  /** Kỳ cần lấy số dư đầu kỳ, dạng YYYY-MM. */
  period: string;
  /** "ALL" hoặc mã cửa hàng. */
  branchCode: string;
  /** Danh sách mã nguồn tiền cần bó lại; rỗng = mọi nguồn (xem `limitSources`). */
  moneySourceCodes?: string[];
  /**
   * true = chỉ tính đúng các nguồn trong `moneySourceCodes`, kể cả khi danh sách rỗng.
   * Cần cho vai thu ngân không có quỹ nào hợp lệ: phải ra 0 đ chứ không rơi về "mọi nguồn".
   */
  limitSources?: boolean;
};

export type CashOpeningBalance = {
  /** Tổng số dư đầu kỳ đã kế thừa. */
  total: number;
  /** Số dư đầu kỳ tách theo mã nguồn tiền ("" = chứng từ không gắn nguồn). */
  bySource: Map<string, number>;
  /** Kỳ khai số dư gốc gần nhất (<= kỳ đang xem); null = chưa khai lần nào. */
  anchorPeriod: string | null;
  /** Kỳ đang xem có bản khai tay hay không — dùng để giải thích trên giao diện. */
  declaredThisPeriod: boolean;
};

/**
 * Thu là cộng, chi là trừ; loại khác (nếu dữ liệu cũ có) không đổi số dư — giống đúng cách
 * màn sổ quỹ dựng cột Thu/Chi, để số dư đầu kỳ không lệch với số dư cuối kỳ trước.
 */
function signedAmount(type: string, amount: number) {
  if (type === "RECEIPT") return amount;
  if (type === "PAYMENT") return -amount;
  return 0;
}

function periodStart(period: string) {
  return new Date(`${period}-01T00:00:00`);
}

function sourceKey(branchCode: string, moneySourceCode: string | null) {
  return `${(branchCode || "").toUpperCase()}|${(moneySourceCode || "").toUpperCase()}`;
}

function bump(map: Map<string, number>, moneySourceCode: string | null, amount: number) {
  const code = moneySourceCode || "";
  map.set(code, (map.get(code) || 0) + amount);
}

export async function cashOpeningBalance(query: CashOpeningQuery): Promise<CashOpeningBalance> {
  const { period, branchCode } = query;
  const moneySourceCodes = query.moneySourceCodes || [];
  const limitSources = query.limitSources ?? moneySourceCodes.length > 0;
  const start = periodStart(period);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const sourceFilter = limitSources ? { moneySourceCode: { in: moneySourceCodes } } : {};
  const scopedCodes = new Set(moneySourceCodes);
  const inScope = (code: string | null) => !limitSources || scopedCodes.has(code || "");

  const declared = await prisma.openingBalance.findMany({
    where: {
      // Cột `period` là chuỗi YYYY-MM nên so sánh chuỗi cũng đúng thứ tự thời gian.
      period: { lte: period },
      ...branchFilter,
      ...sourceFilter,
      status: { in: [...OPENING_BALANCE_EFFECTIVE_STATUSES] },
      balanceType: { in: [...CASH_SOURCE_OPENING_TYPES] },
    },
    select: { period: true, branchCode: true, moneySourceCode: true, amount: true },
  });

  const anchors = new Map<string, { period: string; moneySourceCode: string | null; amount: number }>();
  for (const row of declared) {
    const key = sourceKey(row.branchCode, row.moneySourceCode);
    const current = anchors.get(key);
    if (!current || row.period > current.period) {
      anchors.set(key, { period: row.period, moneySourceCode: row.moneySourceCode, amount: row.amount });
    } else if (row.period === current.period) {
      current.amount += row.amount;
    }
  }

  const anchorPeriods = [...anchors.values()].map((anchor) => anchor.period).sort();
  // Chặn dưới của khoảng phát sinh cần quét: kỳ khai sớm nhất chính là mốc bắt đầu dùng hệ
  // thống. Chưa khai kỳ nào thì lấy toàn bộ lịch sử trước kỳ đang xem.
  const floor = anchorPeriods.length ? periodStart(anchorPeriods[0]) : null;
  const bySource = new Map<string, number>();
  for (const anchor of anchors.values()) bump(bySource, anchor.moneySourceCode, anchor.amount);

  const needsMovements = !floor || floor < start;
  if (needsMovements) {
    const dateRange = floor ? { gte: floor, lt: start } : { lt: start };
    const [vouchers, adjustments, transfers] = await Promise.all([
      prisma.financialVoucher.findMany({
        where: { ...branchFilter, ...sourceFilter, status: "APPROVED", voucherDate: dateRange },
        select: { voucherDate: true, voucherType: true, amount: true, moneySourceCode: true, branchCode: true },
      }),
      prisma.cashbookAdjustment.findMany({
        where: { ...branchFilter, ...sourceFilter, entryDate: dateRange },
        select: { entryDate: true, entryType: true, amount: true, moneySourceCode: true, branchCode: true },
      }),
      prisma.moneyTransfer.findMany({
        where: {
          status: "APPROVED",
          AND: [
            // Phiếu điều tiền liên nhà hàng do cửa hàng bên kia lập vẫn đổi số dư của cửa hàng
            // đang xem, nên phải lấy theo cả hai đầu rồi mới lọc vế bên dưới.
            ...(branchCode === "ALL"
              ? []
              : [{ OR: [{ branchCode }, { fromBranchCode: branchCode }, { toBranchCode: branchCode }] }]),
            // Lọc thô theo cả hai cột ngày, ngày hiệu lực được kẹp lại bằng JS bên dưới.
            { OR: [{ transferDate: dateRange }, { actualTransferDate: dateRange }] },
          ],
        },
        select: {
          transferDate: true, actualTransferDate: true, transferPurpose: true, amount: true, feeAmount: true,
          fromMoneySourceCode: true, toMoneySourceCode: true, branchCode: true, fromBranchCode: true, toBranchCode: true,
        },
      }),
    ]);

    /** Phát sinh trước mốc khai của chính nguồn đó đã nằm trong số khai — bỏ qua, tránh cộng đôi. */
    const add = (branch: string, code: string | null, date: Date, amount: number) => {
      if (!amount) return;
      if (!inScope(code)) return;
      if (!(date < start)) return;
      if (floor && date < floor) return;
      const anchor = anchors.get(sourceKey(branch, code));
      if (anchor && date < periodStart(anchor.period)) return;
      bump(bySource, code, amount);
    };

    for (const row of vouchers) {
      add(row.branchCode, row.moneySourceCode, row.voucherDate, signedAmount(row.voucherType, row.amount));
    }
    for (const row of adjustments) {
      add(row.branchCode, row.moneySourceCode, row.entryDate, signedAmount(row.entryType, row.amount));
    }
    for (const row of transfers) {
      const date = effectiveMoneyTransferDate(row);
      const legs = transferLegsForBranch(row, branchCode);
      const branches = transferBranches(row);
      // Quyết toán ví: tiền rời ví = số về ngân hàng + phí, nên số dư ví mới về đúng 0.
      if (legs.out) add(branches.fromBranchCode, row.fromMoneySourceCode, date, -(row.amount + row.feeAmount));
      if (legs.in) add(branches.toBranchCode, row.toMoneySourceCode, date, row.amount);
    }
  }

  let total = 0;
  for (const amount of bySource.values()) total += amount;

  return {
    total,
    bySource,
    anchorPeriod: anchorPeriods.length ? anchorPeriods[anchorPeriods.length - 1] : null,
    declaredThisPeriod: anchorPeriods.includes(period),
  };
}
