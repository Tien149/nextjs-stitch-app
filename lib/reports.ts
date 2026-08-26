import { prisma } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";
import { periodBounds } from "@/lib/accounting";
import { depositDecreaseActions, depositIncreaseActions } from "@/lib/deposit-accounting";
import { depositCategoryDirection } from "@/lib/bank-statement-category";
import { isGrabMoneySource, moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { CASH_SOURCE_OPENING_TYPES, OPENING_BALANCE_EFFECTIVE_STATUSES } from "@/lib/opening-balance-rules";
import { effectiveMoneyTransferDate, effectiveMoneyTransferDateFilter } from "@/lib/money-transfer-date";
import { transferLegsForBranch } from "@/lib/internal-transfer";
import { WALLET_CARD_FEE_CATEGORY_CODE, WALLET_GRAB_EXPENSE_CATEGORY_CODE } from "@/lib/wallet-settlement-allocation";
import { vietnamBusinessDayKey } from "@/lib/revenue-date";
import { remainingWalletGross, selectWalletDeclaredRevenue, walletRevenueBucket } from "@/lib/wallet-revenue-reconciliation";

type PnlBucket = {
  revenue: number;
  cogs: number;
  payroll: number;
  depreciation: number;
  otherOpex: number;
  otherIncome: number;
  otherExpense: number;
};

export type PnlItemBreakdown = {
  code: string;
  name: string;
  group: string | null;
  amount: number;
};

function emptyPnl(): PnlBucket {
  return { revenue: 0, cogs: 0, payroll: 0, depreciation: 0, otherOpex: 0, otherIncome: 0, otherExpense: 0 };
}

function addLine(bucket: PnlBucket, line: { debit: number; credit: number; account: { accountType: string; reportGroup: string } }) {
  const expense = line.debit - line.credit;
  const income = line.credit - line.debit;
  if (line.account.accountType === "REVENUE") bucket.revenue += income;
  else if (line.account.accountType === "COGS") bucket.cogs += expense;
  else if (line.account.accountType === "OPEX" && line.account.reportGroup === "PAYROLL") bucket.payroll += expense;
  else if (line.account.accountType === "OPEX" && line.account.reportGroup === "DEPRECIATION") bucket.depreciation += expense;
  else if (line.account.accountType === "OPEX") bucket.otherOpex += expense;
  else if (line.account.accountType === "OTHER_INCOME") bucket.otherIncome += income;
  else if (line.account.accountType === "OTHER_EXPENSE") bucket.otherExpense += expense;
}

export function finalizePnl(bucket: PnlBucket) {
  const grossProfit = bucket.revenue - bucket.cogs;
  const opexBeforeDepreciation = bucket.payroll + bucket.otherOpex;
  const ebitda = grossProfit - opexBeforeDepreciation;
  const operatingProfit = ebitda - bucket.depreciation;
  const netProfit = operatingProfit + bucket.otherIncome - bucket.otherExpense;
  return { ...bucket, grossProfit, opexBeforeDepreciation, ebitda, operatingProfit, netProfit, grossMargin: bucket.revenue ? grossProfit / bucket.revenue : 0, ebitdaMargin: bucket.revenue ? ebitda / bucket.revenue : 0 };
}

export async function getPnl(period: string, branchCode: string) {
  const { start, end } = periodBounds(period);
  const [entries, pnlItems] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { entryDate: { gte: start, lt: end }, status: "POSTED", ...(branchCode === "ALL" ? {} : { branchCode }) },
      include: { lines: { include: { account: true } } },
    }),
    prisma.masterDataItem.findMany({
      where: { type: "PNL_ITEM" },
      select: { code: true, name: true, group: true },
    }),
  ]);
  const pnlItemByCode = new Map(pnlItems.map((item) => [item.code, item]));
  const pnlItemBreakdown = new Map<string, PnlItemBreakdown>();
  const total = emptyPnl();
  const branches = new Map<string, PnlBucket>();
  const departments = new Map<string, PnlBucket>();
  for (const entry of entries) {
    const branch = branches.get(entry.branchCode) || emptyPnl();
    for (const line of entry.lines) {
      addLine(total, line);
      addLine(branch, line);
      if (["COGS", "OPEX", "OTHER_EXPENSE"].includes(line.account.accountType)) {
        const code = line.pnlItemCode || "UNCLASSIFIED";
        const item = line.pnlItemCode ? pnlItemByCode.get(line.pnlItemCode) : null;
        const current = pnlItemBreakdown.get(code) || {
          code,
          name: item?.name || (line.pnlItemCode ? `Hạng mục P&L [${line.pnlItemCode}]` : "Chưa phân loại P&L"),
          group: item?.group || null,
          amount: 0,
        };
        current.amount += line.debit - line.credit;
        pnlItemBreakdown.set(code, current);
      }
      const departmentCode = line.departmentCode || "UNALLOCATED";
      const department = departments.get(departmentCode) || emptyPnl();
      addLine(department, line);
      departments.set(departmentCode, department);
    }
    branches.set(entry.branchCode, branch);
  }
  return {
    total: finalizePnl(total),
    byBranch: Array.from(branches, ([code, bucket]) => ({ code, ...finalizePnl(bucket) })).sort((a, b) => b.revenue - a.revenue),
    byDepartment: Array.from(departments, ([code, bucket]) => ({ code, ...finalizePnl(bucket) })).sort((a, b) => b.payroll + b.otherOpex - (a.payroll + a.otherOpex)),
    byPnlItem: Array.from(pnlItemBreakdown.values())
      .filter((row) => Math.abs(row.amount) > 0.5)
      .sort((a, b) => (a.code === "UNCLASSIFIED" ? 1 : b.code === "UNCLASSIFIED" ? -1 : b.amount - a.amount)),
  };
}

export async function getBalanceSheet(period: string, branchCode: string) {
  const { end } = periodBounds(period);
  const entries = await prisma.journalEntry.findMany({
    where: { entryDate: { lt: end }, status: "POSTED", ...(branchCode === "ALL" ? {} : { branchCode }) },
    include: { lines: { include: { account: true } } },
  });
  const groups = new Map<string, { code: string; name: string; accountType: string; reportGroup: string; amount: number }>();
  let cumulativeProfit = 0;
  for (const entry of entries) for (const line of entry.lines) {
    const account = line.account;
    const amount = account.normalBalance === "DEBIT" ? line.debit - line.credit : line.credit - line.debit;
    const current = groups.get(account.code) || { code: account.code, name: account.name, accountType: account.accountType, reportGroup: account.reportGroup, amount: 0 };
    current.amount += amount;
    groups.set(account.code, current);
    if (["REVENUE", "OTHER_INCOME"].includes(account.accountType)) cumulativeProfit += line.credit - line.debit;
    if (["COGS", "OPEX", "OTHER_EXPENSE"].includes(account.accountType)) cumulativeProfit -= line.debit - line.credit;
  }
  const rows = Array.from(groups.values()).filter((row) => Math.abs(row.amount) > 0.5).sort((a, b) => a.code.localeCompare(b.code));
  const assets = rows.filter((row) => row.accountType === "ASSET").reduce((sum, row) => sum + (row.reportGroup === "ACCUMULATED_DEPRECIATION" ? -row.amount : row.amount), 0);
  const liabilities = rows.filter((row) => row.accountType === "LIABILITY").reduce((sum, row) => sum + row.amount, 0);
  const contributedEquity = rows.filter((row) => row.accountType === "EQUITY").reduce((sum, row) => sum + row.amount, 0);
  const equity = contributedEquity + cumulativeProfit;
  return { rows, assets, liabilities, contributedEquity, retainedEarnings: cumulativeProfit, equity, difference: assets - liabilities - equity, balanced: Math.abs(assets - liabilities - equity) <= 1 };
}

export async function getTrend(period: string, branchCode: string, months = 6) {
  const periods = Array.from({ length: months }, (_, index) => addPeriod(period, index - months + 1));
  return Promise.all(periods.map(async (item) => ({ period: item, ...(await getPnl(item, branchCode)).total })));
}

/* ------------------------------------------------------------------------- *
 * Báo cáo nguồn tiền (thu/chi thực tế theo danh mục)
 * ------------------------------------------------------------------------- */

export type CashCategoryRow = {
  key: string;
  name: string;
  /** Chiều dòng tiền của danh mục: RECEIPT / PAYMENT. */
  group: string | null;
  total: number;
  count: number;
  /** Số tiền của từng tháng trong phạm vi báo cáo, dùng cho bảng năm. */
  months: number[];
  ratio: number;
};

export type CashPartnerRow = { code: string; name: string; partnerType: string | null; total: number; count: number };

/** Chỉ tiền đã thực sự vào/ra sổ quỹ mới lên báo cáo; phiếu nháp/chờ duyệt đếm riêng để cảnh báo. */
const cashReportVoucherStatuses = ["APPROVED", "POSTED"];
const cashReportPendingStatuses = ["DRAFT", "PENDING_REVIEW"];
const cashReportOpeningTypes = [...CASH_SOURCE_OPENING_TYPES];
const supplierPartnerTypes = ["SUPPLIER", "BOTH"];
const unclassifiedKey = "UNCLASSIFIED";
/**
 * Hai dòng cọc trên bảng thu/chi theo danh mục. Chứng từ mang danh mục cọc phải gom về đúng
 * hai dòng này chứ không mọc thêm dòng riêng theo tên khoản mục — cùng một nghiệp vụ mà nằm
 * hai dòng trùng tên thì khách không cộng được.
 */
/** Khoản thu/chi không tra được nguồn tiền vẫn phải có chỗ đứng, không thì hai tổng lệch nhau. */
const UNASSIGNED_FLOW_SOURCE = "CHUA_GAN_NGUON_TIEN";
const depositInRow = { key: "DEPOSIT_IN", name: "Thu tiền cọc", group: "RECEIPT" as const };
const depositRefundRow = { key: "DEPOSIT_REFUND", name: "Hoàn cọc cho khách", group: "PAYMENT" as const };

function periodOfDate(value: Date) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function bumpCategory(
  map: Map<string, CashCategoryRow>,
  base: Pick<CashCategoryRow, "key" | "name" | "group">,
  monthCount: number,
  monthIndex: number,
  amount: number,
  count = 1,
) {
  const row = map.get(base.key) || { ...base, total: 0, count: 0, months: Array(monthCount).fill(0), ratio: 0 };
  row.total += amount;
  row.count += count;
  if (monthIndex >= 0) row.months[monthIndex] += amount;
  map.set(base.key, row);
}

function finalizeCategories(map: Map<string, CashCategoryRow>) {
  const rows = Array.from(map.values()).filter((row) => Math.abs(row.total) > 0.5);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return rows
    .map((row) => ({ ...row, ratio: total ? row.total / total : 0 }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Thu/chi thực tế theo danh mục cho một hoặc nhiều tháng liên tiếp (dùng chung cho
 * báo cáo tháng và báo cáo năm).
 *
 * Quy ước số liệu (TIỀN THỰC THU — chốt với khách 19/08/2026):
 * - Thu/Chi theo danh mục: tiền mặt lấy từ phiếu thu/chi đã duyệt, còn lại lấy từ sổ
 *   sao kê ngân hàng theo Loại thu/chi khai trên file — đúng phép SUMIFS khách làm tay.
 *   Doanh thu POS và số nhập tay của thu ngân KHÔNG vào bảng danh mục (đó là doanh thu
 *   ghi nhận, chưa chắc đã về tiền); vì thế bảng này không còn khớp 1-1 với báo cáo
 *   doanh thu, và tháng nào quên import sao kê thì cột thu tụt ngay.
 * - Điều tiền nội bộ (nộp tiền, chuyển quỹ) KHÔNG phải thu/chi nên tách riêng.
 *
 * Bảng biến động nguồn tiền còn kèm hai cột dự kiến, KHÔNG tính vào số dư cuối kỳ:
 * - Dự thu trong kỳ: doanh thu ví/POS đã ghi nhận nhưng chưa quyết toán về ngân hàng,
 *   quy về nguồn ngân hàng mà ví khai ở `settlementBankCode`.
 * - Dự chi trong kỳ: phiếu chi còn ở trạng thái nháp/chờ duyệt của chính nguồn tiền đó.
 */
export async function getCashSourceReport(months: string[], branchCode: string) {
  const monthCount = months.length;
  const start = new Date(`${months[0]}-01T00:00:00`);
  const end = new Date(`${addPeriod(months[monthCount - 1], 1)}-01T00:00:00`);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const monthIndexOf = (date: Date) => months.indexOf(periodOfDate(date));

  const [vouchers, pendingVouchers, categories, partners, moneySources, posRevenues, manualEntries, adjustments, transfers, openingBalances, walletSettlements, depositHistories, bankAllocationRows, legacyBankRows, cashRemainingTargets, voucherPartnerAllocations, reconciledVoucherLinks] =
    await Promise.all([
      prisma.financialVoucher.findMany({
        where: {
          ...branchFilter,
          voucherDate: { gte: start, lt: end },
          voucherType: { in: ["RECEIPT", "PAYMENT"] },
          status: { in: cashReportVoucherStatuses },
        },
        select: { id: true, voucherType: true, voucherDate: true, categoryCode: true, partnerCode: true, partnerName: true, moneySourceCode: true, amount: true, depositAction: true, businessEffect: true },
      }),
      prisma.financialVoucher.groupBy({
        by: ["voucherType", "moneySourceCode"],
        where: {
          ...branchFilter,
          voucherDate: { gte: start, lt: end },
          voucherType: { in: ["RECEIPT", "PAYMENT"] },
          status: { in: cashReportPendingStatuses },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.masterDataItem.findMany({ where: { type: "REVENUE_EXPENSE_CATEGORY" }, select: { code: true, name: true, group: true } }),
      prisma.masterDataItem.findMany({ where: { type: "PARTNER" }, select: { code: true, name: true, group: true, partnerType: true } }),
      prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE" }, select: { code: true, name: true, group: true, branch: true, status: true, settlementBankCode: true, summarySourceName: true } }),
      // Doanh thu POS có thể tới hàng chục nghìn dòng mỗi năm nên gom sẵn theo ngày bán và danh mục Thu.
      prisma.revenueImportRow.groupBy({
        by: ["saleDate", "revenueSource", "paymentMethod", "channel"],
        where: { ...branchFilter, saleDate: { gte: start, lt: end } },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      prisma.manualRevenueEntry.findMany({
        where: { ...branchFilter, reportDate: { gte: start, lt: end } },
        select: { reportDate: true, totalAmount: true, cardAmount: true, grabAmount: true },
      }),
      prisma.cashbookAdjustment.findMany({
        where: { ...branchFilter, entryDate: { gte: start, lt: end } },
        select: { entryDate: true, entryType: true, amount: true, moneySourceCode: true },
      }),
      // Phiếu điều tiền liên nhà hàng do cửa hàng bên kia lập vẫn ảnh hưởng nguồn tiền của
      // cửa hàng đang xem, nên phải lấy theo cả hai đầu rồi mới lọc vế bên dưới.
      prisma.moneyTransfer.findMany({
        where: {
          ...(branchCode === "ALL"
            ? {}
            : { OR: [{ branchCode }, { fromBranchCode: branchCode }, { toBranchCode: branchCode }] }),
          ...effectiveMoneyTransferDateFilter(start, end),
          status: "APPROVED",
        },
        select: { transferDate: true, actualTransferDate: true, amount: true, feeAmount: true, feeCategoryCode: true, grabExpenseAmount: true, grabExpenseCategoryCode: true, transferPurpose: true, fromMoneySourceCode: true, toMoneySourceCode: true, branchCode: true, fromBranchCode: true, toBranchCode: true },
      }),
      prisma.openingBalance.findMany({
        where: { period: months[0], ...(branchCode === "ALL" ? {} : { branchCode }), status: { in: [...OPENING_BALANCE_EFFECTIVE_STATUSES] }, balanceType: { in: cashReportOpeningTypes } },
        select: { moneySourceCode: true, amount: true },
      }),
      // Quyết toán ví bám theo NGÀY DOANH THU chứ không phải ngày tiền về, để doanh thu ví
      // cuối kỳ đã được sao kê ở kỳ sau vẫn trừ đúng vào dự thu của kỳ phát sinh.
      // Lưu ý: một đợt quyết toán gộp nhiều ngày chỉ giữ được ngày doanh thu đầu tiên.
      prisma.moneyTransfer.findMany({
        where: {
          ...branchFilter,
          status: "APPROVED",
          transferPurpose: "WALLET_SETTLEMENT",
          OR: [
            { sourceReportDate: { gte: start, lt: end } },
            { sourceReportDate: null, transferDate: { gte: start, lt: end } },
          ],
        },
        select: { fromMoneySourceCode: true, amount: true, feeAmount: true },
      }),
      // Lấy cả lịch sử trước kỳ để tính được số cọc chưa dùng mang sang.
      prisma.depositHistory.findMany({
        where: {
          deposit: { deletedAt: null, ...(branchCode === "ALL" ? {} : { branchCode }) },
          OR: [{ actionDate: { lt: end } }, { actionDate: null, createdAt: { lt: end } }],
        },
        select: {
          action: true,
          amount: true,
          actionDate: true,
          createdAt: true,
          voucherId: true,
          deposit: { select: { moneySourceCode: true } },
        },
      }),
      // Sổ sao kê ngân hàng: vế "tiền không phải tiền mặt" của bảng thu/chi theo danh mục
      // (tiền thực thu). Dòng có phân bổ đọc theo từng dòng phân bổ vì mỗi dòng mang một
      // Loại thu/chi riêng; kỳ tính theo Ngày nguồn tiền, thiếu thì theo Ngày giao dịch.
      prisma.bankStatementAllocation.findMany({
        where: {
          bankTransaction: { is: { deletedAt: null, ...branchFilter } },
          OR: [
            { sourceDate: { gte: start, lt: end } },
            { sourceDate: null, bankTransaction: { is: { transactionDate: { gte: start, lt: end } } } },
          ],
        },
        select: {
          debitAmount: true,
          creditAmount: true,
          grossAmount: true,
          sourceDate: true,
          categoryCode: true,
          operationType: true,
          depositCode: true,
          summaryMoneySourceCode: true,
          increaseMoneySourceCode: true,
          decreaseMoneySourceCode: true,
          bankTransaction: { select: { transactionDate: true, categoryCode: true, operationType: true, depositCode: true, summaryMoneySourceCode: true, increaseMoneySourceCode: true, decreaseMoneySourceCode: true } },
        },
      }),
      // Dữ liệu lịch sử không có dòng phân bổ thì đọc thẳng giao dịch, tránh cộng trùng.
      prisma.bankStatementTransaction.findMany({
        where: {
          deletedAt: null,
          ...branchFilter,
          allocations: { none: {} },
          OR: [
            { sourceDate: { gte: start, lt: end } },
            { sourceDate: null, transactionDate: { gte: start, lt: end } },
          ],
        },
        select: {
          debitAmount: true,
          creditAmount: true,
          grossAmount: true,
          sourceDate: true,
          transactionDate: true,
          categoryCode: true,
          operationType: true,
          depositCode: true,
          summaryMoneySourceCode: true,
          increaseMoneySourceCode: true,
          decreaseMoneySourceCode: true,
        },
      }),
      // Mục tiêu "Nguồn tiền còn lại" khai theo từng tháng ở màn Ngân sách, để báo cáo
      // năm so được thực tế với mục tiêu như bảng khách theo dõi tay.
      prisma.reportTarget.findMany({
        where: { period: { in: months }, metric: "cashRemaining", ...(branchCode === "ALL" ? {} : { branchCode }), deletedAt: null },
        select: { period: true, targetValue: true },
      }),
      // Dòng phân bổ của phiếu chi đại diện (một người nhận, nhiều đối tác): bảng "Chi theo
      // đối tác" phải đọc theo từng dòng, không thì cả cục tiền đổ về tên người nhận.
      prisma.voucherAllocation.findMany({
        where: {
          voucher: {
            ...(branchCode === "ALL" ? {} : { branchCode }),
            voucherDate: { gte: start, lt: end },
            voucherType: "PAYMENT",
            status: { in: cashReportVoucherStatuses },
            deletedAt: null,
          },
        },
        select: { voucherId: true, partnerCode: true, partnerName: true, amount: true },
      }),
      // Chứng từ ngân hàng ĐÃ khớp với một dòng sao kê thì dòng sao kê mới là bản ghi được
      // tính; chứng từ chỉ là bản đối ứng. Không loại ra là cùng một đồng tiền vào hai lần.
      prisma.reconciliationMatch.findMany({
        where: { deletedAt: null, targetType: "VOUCHER", bankTransaction: { is: { deletedAt: null } } },
        select: { targetId: true },
      }),
    ]);
  const reconciledVoucherIds = new Set(reconciledVoucherLinks.map((row) => row.targetId));

  const categoryByCode = new Map(categories.map((row) => [row.code, row]));
  const categoryByNormalizedCode = new Map(categories.map((row) => [row.code.trim().toUpperCase(), row]));
  const categoryByNormalizedName = new Map(categories.map((row) => [row.name.trim().toUpperCase(), row]));
  const resolveCategory = (value: string | null | undefined, expectedType: "RECEIPT" | "PAYMENT") => {
    const raw = (value || "").trim();
    if (!raw) return null;
    const category = categoryByCode.get(raw)
      || categoryByNormalizedCode.get(raw.toUpperCase())
      || categoryByNormalizedName.get(raw.toUpperCase());
    return category && normalizeCashflowCategoryType(category.group) === expectedType ? category : null;
  };
  const partnerByCode = new Map(partners.map((row) => [row.code, row]));
  const income = new Map<string, CashCategoryRow>();
  const expense = new Map<string, CashCategoryRow>();
  const expenseByPartner = new Map<string, CashPartnerRow>();
  const sourceFlows = new Map<string, { code: string; name: string; group: string | null; branchCode: string; summaryName: string | null; opening: number; in: number; out: number; transferIn: number; transferOut: number; expectedIn: number; expectedOut: number; netByMonth: number[] }>();

  const touchSource = (code: string) => {
    const existing = sourceFlows.get(code);
    if (existing) return existing;
    const master = moneySources.find((row) => row.code === code);
    const created = {
      code,
      name: master?.name || code,
      group: master?.group || null,
      branchCode: master?.branch || "ALL",
      summaryName: master?.summarySourceName || null,
      opening: 0,
      in: 0,
      out: 0,
      transferIn: 0,
      transferOut: 0,
      expectedIn: 0,
      expectedOut: 0,
      // Biến động ròng theo từng tháng, để báo cáo năm dựng được số dư cuối mỗi tháng
      // (đầu kỳ + cộng dồn từng tháng) như bảng khách theo dõi tay.
      netByMonth: Array<number>(monthCount).fill(0),
    };
    sourceFlows.set(code, created);
    return created;
  };
  const bumpSourceMonth = (row: { netByMonth: number[] }, date: Date, delta: number) => {
    const monthIndex = monthIndexOf(date);
    if (monthIndex >= 0) row.netByMonth[monthIndex] += delta;
  };

  // Liệt kê đủ nguồn tiền mặt/ngân hàng của nhà hàng, kể cả nguồn không có số
  // dư hoặc phát sinh trong kỳ. Ví/cổng thanh toán không thuộc bảng này.
  for (const source of moneySources) {
    const group = normalizeMoneySourceGroup(source.group);
    if (!["CASH", "BANK"].includes(group)) continue;
    if (!moneySourceMatchesBranch(source, branchCode)) continue;
    touchSource(source.code);
  }

  for (const row of openingBalances) {
    if (!row.moneySourceCode) continue;
    touchSource(row.moneySourceCode).opening += row.amount;
  }

  let unclassifiedIncome = 0;
  let unclassifiedExpense = 0;
  // Dòng "Chưa phân loại" gom dữ liệu từ nhiều màn khác nhau (phiếu tiền mặt, sổ sao kê ngân
  // hàng, điều chỉnh quỹ, phí điều tiền). Đếm riêng theo từng nguồn để báo cáo chỉ hiện link
  // tới đúng màn đang thực sự có dòng cần bổ sung — trước đây link nào cũng hiện, bấm vào là
  // danh sách rỗng vì tiền nằm ở màn khác.
  const emptyUnclassifiedOrigins = () => ({
    voucher: { count: 0, amount: 0 },
    bankStatement: { count: 0, amount: 0 },
    adjustment: { count: 0, amount: 0 },
    transferFee: { count: 0, amount: 0 },
  });
  const unclassifiedOrigins = { RECEIPT: emptyUnclassifiedOrigins(), PAYMENT: emptyUnclassifiedOrigins() };
  const bumpUnclassified = (
    expectedType: "RECEIPT" | "PAYMENT",
    origin: keyof ReturnType<typeof emptyUnclassifiedOrigins>,
    amount: number,
  ) => {
    if (expectedType === "RECEIPT") unclassifiedIncome += amount;
    else unclassifiedExpense += amount;
    const stat = unclassifiedOrigins[expectedType][origin];
    stat.count += 1;
    stat.amount += amount;
  };
  const moneySourceByCode = new Map(moneySources.map((row) => [row.code, row]));
  /**
   * Ghi MỘT khoản thu/chi vào đồng thời bảng danh mục và cột Thu/Chi của nguồn tiền.
   *
   * Khách dùng dòng TỔNG của bảng nguồn tiền để soi ngược lên Tổng thu/Tổng chi nên hai bên
   * phải bằng nhau. Cách chắc chắn duy nhất là mọi khoản đều đi qua đúng cửa này — không có
   * đường nào ghi riêng một bên — nên hai tổng bằng nhau theo cấu trúc, không phải do trùng.
   * Điều tiền nội bộ KHÔNG đi qua đây: nó không phải thu/chi, nằm ở cột điều tiền riêng.
   */
  const recordFlow = (
    expectedType: "RECEIPT" | "PAYMENT",
    category: { key: string; name: string; group: "RECEIPT" | "PAYMENT" },
    moneySourceCode: string | null | undefined,
    date: Date,
    amount: number,
  ) => {
    if (!amount) return;
    bumpCategory(expectedType === "RECEIPT" ? income : expense, category, monthCount, monthIndexOf(date), amount);
    const source = touchSource(moneySourceCode || UNASSIGNED_FLOW_SOURCE);
    if (expectedType === "RECEIPT") source.in += amount;
    else source.out += amount;
    bumpSourceMonth(source, date, expectedType === "RECEIPT" ? amount : -amount);
  };
  const allocationsByVoucher = new Map<string, typeof voucherPartnerAllocations>();
  for (const line of voucherPartnerAllocations) {
    allocationsByVoucher.set(line.voucherId, [...(allocationsByVoucher.get(line.voucherId) || []), line]);
  }
  for (const voucher of vouchers) {
    const isIncome = voucher.voucherType === "RECEIPT";
    const isDepositMovement = isIncome
      ? ["COLLECT", "SUPPLEMENT"].includes(voucher.depositAction || "")
      : voucher.depositAction === "REFUND";
    // Tiền ngân hàng đếm MỘT lần theo nguyên tắc gộp: sổ sao kê là bản ghi chính, chứng từ
    // ngân hàng chỉ vào bảng khi CHƯA khớp được dòng sao kê nào — nếu không thì hoặc bỏ sót
    // chứng từ chưa có sao kê, hoặc cộng đôi chứng từ đã khớp. Phiếu SETTLEMENT chỉ xác nhận
    // dòng tiền của nghiệp vụ đã ghi nhận nên luôn nhường chỗ cho dòng sao kê.
    const voucherIsCash = normalizeMoneySourceGroup(moneySourceByCode.get(voucher.moneySourceCode)?.group) === "CASH";
    const voucherCountsAsFlow = voucherIsCash || !reconciledVoucherIds.has(voucher.id);
    // Phiếu mang danh mục cọc mà thiếu depositAction (dữ liệu cũ) thì sổ cọc không có nó.
    // Thu cọc vẫn loại như phiếu cọc chuẩn — dòng "Thu tiền cọc" phải bằng đúng cột "Cọc phát
    // sinh thêm trong kỳ" để khách đối chiếu. Hoàn cọc thì gom vào dòng "Hoàn cọc cho khách"
    // sẵn có: loại hẳn là mất tiền khỏi bảng, để riêng là mọc dòng thứ hai trùng tên.
    const voucherCategoryForCheck = resolveCategory(voucher.categoryCode, isIncome ? "RECEIPT" : "PAYMENT");
    const voucherDepositKind = depositCategoryDirection({ code: voucher.categoryCode, name: voucherCategoryForCheck?.name });
    const voucherIsDepositRefund = voucherDepositKind === "REFUND" && !isIncome;
    const skipAsDepositCategory = Boolean(voucherDepositKind) && !voucherIsDepositRefund;
    if (!isDepositMovement && !skipAsDepositCategory && voucher.businessEffect !== "SETTLEMENT" && voucherCountsAsFlow) {
      const expectedType = isIncome ? "RECEIPT" : "PAYMENT";
      const category = resolveCategory(voucher.categoryCode, expectedType);
      recordFlow(
        expectedType,
        voucherIsDepositRefund
          ? depositRefundRow
          : category
            ? { key: category.code, name: category.name, group: expectedType }
            : { key: unclassifiedKey, name: "Chưa phân loại", group: expectedType },
        voucher.moneySourceCode,
        voucher.voucherDate,
        voucher.amount,
      );
      if (!category && !voucherIsDepositRefund) bumpUnclassified(expectedType, "voucher", voucher.amount);
    } else {
      // Phiếu nhường chỗ cho bản ghi khác (sổ sao kê / sổ cọc) vẫn phải hiện ra để nguồn tiền
      // được liệt kê, nhưng không cộng tiền — bản ghi kia mới là nơi ghi khoản đó.
      touchSource(voucher.moneySourceCode);
    }

    if (!isIncome) {
      // Phiếu đại diện chi cho nhiều đối tác: tính theo từng dòng phân bổ, không đổ cả
      // cục tiền về tên người nhận.
      const allocationLines = allocationsByVoucher.get(voucher.id) || [];
      const partnerLines = allocationLines.length > 0
        ? allocationLines.map((line) => ({ code: line.partnerCode, name: line.partnerName, amount: line.amount }))
        : [{ code: voucher.partnerCode || "", name: voucher.partnerName, amount: voucher.amount }];
      for (const line of partnerLines) {
        // Phiếu sao kê không khai Mã đối tác từng mang tên mặc định "Đối tác theo sao kê" —
        // trông như một đối tác thật và dồn cục 80%+ tổng chi. Gom hết về một dòng gọi đúng
        // tên là dữ liệu thiếu, để khách biết phải bổ sung Mã đối tác trên file thay vì
        // tưởng có một nhà cung cấp tên như vậy.
        const isUnknownPartner = !line.code
          && (!line.name || ["Đối tác theo sao kê", "Chưa khai đối tác"].includes(line.name));
        const partnerKey = isUnknownPartner ? "__CHUA_KHAI__" : line.code || line.name || "KHAC";
        const partner = line.code ? partnerByCode.get(line.code) : null;
        const current = expenseByPartner.get(partnerKey) || {
          code: line.code,
          name: isUnknownPartner
            ? "Chưa khai đối tác — bổ sung Mã đối tác trên file sao kê"
            : partner?.name || line.name || "Không ghi đối tượng",
          partnerType: (partner?.partnerType || partner?.group || null),
          total: 0,
          count: 0,
        };
        current.total += line.amount;
        current.count += 1;
        expenseByPartner.set(partnerKey, current);
      }
    }
  }

  // Vế không phải tiền mặt của bảng danh mục: đọc thẳng sổ sao kê ngân hàng theo Loại thu/chi
  // khai trên file — đúng phép SUMIFS khách đang làm tay. Doanh thu POS và số nhập tay của thu
  // ngân KHÔNG còn vào bảng này: đó là doanh thu ghi nhận, không phải tiền đã về; phần ví chưa
  // quyết toán đã có cột Dự thu lo. Nhập tay vì thế cũng hết đổ cục vào "Chưa phân loại".
  const bankLedgerRows = [
    ...bankAllocationRows.map((row) => ({
      debitAmount: row.debitAmount,
      creditAmount: row.creditAmount,
      grossAmount: row.grossAmount,
      effectiveDate: row.sourceDate || row.bankTransaction.transactionDate,
      categoryCode: row.categoryCode || row.bankTransaction.categoryCode,
      operationType: row.operationType || row.bankTransaction.operationType,
      depositCode: row.depositCode || row.bankTransaction.depositCode,
      summaryMoneySourceCode: row.summaryMoneySourceCode || row.bankTransaction.summaryMoneySourceCode,
      increaseMoneySourceCode: row.increaseMoneySourceCode || row.bankTransaction.increaseMoneySourceCode,
      decreaseMoneySourceCode: row.decreaseMoneySourceCode || row.bankTransaction.decreaseMoneySourceCode,
    })),
    ...legacyBankRows.map((row) => ({
      debitAmount: row.debitAmount,
      creditAmount: row.creditAmount,
      grossAmount: row.grossAmount,
      effectiveDate: row.sourceDate || row.transactionDate,
      categoryCode: row.categoryCode,
      operationType: row.operationType,
      depositCode: row.depositCode,
      summaryMoneySourceCode: row.summaryMoneySourceCode,
      increaseMoneySourceCode: row.increaseMoneySourceCode,
      decreaseMoneySourceCode: row.decreaseMoneySourceCode,
    })),
  ];
  for (const row of bankLedgerRows) {
    // Điều tiền giữa các tài khoản không phải thu/chi; nghiệp vụ cọc đã có dòng
    // "Thu tiền cọc"/"Hoàn cọc cho khách" riêng từ lịch sử cọc, cộng nữa là đếm đôi.
    if (row.operationType === "INTERNAL_TRANSFER") continue;
    if (row.depositCode || ["DEPOSIT_RECEIPT", "DEPOSIT_REFUND"].includes(row.operationType || "")) continue;
    const isIncome = row.creditAmount > 0;
    // Thu của ví lấy doanh thu gộp trước phí khi đã suy được; phí thu hộ đã có dòng chi riêng
    // từ các đợt quyết toán ví nên gross + phí mới cân, lấy net là hụt đúng phần phí.
    const amount = isIncome ? (row.grossAmount ?? row.creditAmount) : row.debitAmount;
    if (!amount) continue;
    const expectedType = isIncome ? ("RECEIPT" as const) : ("PAYMENT" as const);
    const category = resolveCategory(row.categoryCode, expectedType);
    // Dòng mang danh mục thu cọc (kể cả dữ liệu cũ thiếu Loại nghiệp vụ đích) bỏ qua: sổ cọc
    // là nguồn sự thật DUY NHẤT cho dòng "Thu tiền cọc", không thì bảng danh mục mọc thêm dòng
    // "Thu Tiền Từ Khách Đặt Cọc" lệch với "Cọc phát sinh thêm trong kỳ". Hoàn cọc thì gom vào
    // dòng "Hoàn cọc cho khách" sẵn có, giống cách xử lý ở vòng phiếu thu/chi.
    const rowDepositKind = depositCategoryDirection({ code: row.categoryCode, name: category?.name });
    const rowIsDepositRefund = rowDepositKind === "REFUND" && !isIncome;
    if (rowDepositKind && !rowIsDepositRefund) continue;
    // Nguồn tiền của dòng sao kê: khoản CHI làm giảm chính tài khoản ngân hàng đó. Khoản THU
    // mà có khai "nguồn giảm" là tiền từ ví/cổng chuyển về — doanh thu thuộc về ví, còn vế
    // tiền vào ngân hàng đã nằm ở phiếu điều tiền nên không lặp lại ở cột Thu của ngân hàng.
    const rowSourceCode = isIncome
      ? row.decreaseMoneySourceCode || row.increaseMoneySourceCode || row.summaryMoneySourceCode
      : row.decreaseMoneySourceCode || row.summaryMoneySourceCode;
    recordFlow(
      expectedType,
      rowIsDepositRefund
        ? depositRefundRow
        : category
          ? { key: category.code, name: category.name, group: expectedType }
          : { key: unclassifiedKey, name: "Chưa phân loại", group: expectedType },
      rowSourceCode,
      row.effectiveDate,
      amount,
    );
    if (!category && !rowIsDepositRefund) bumpUnclassified(expectedType, "bankStatement", amount);
  }

  for (const row of adjustments) {
    const expectedType = row.entryType === "RECEIPT" ? ("RECEIPT" as const) : ("PAYMENT" as const);
    recordFlow(
      expectedType,
      { key: unclassifiedKey, name: "Chưa phân loại", group: expectedType },
      row.moneySourceCode,
      row.entryDate,
      row.amount,
    );
    bumpUnclassified(expectedType, "adjustment", row.amount);
  }

  for (const row of transfers) {
    // Nguồn đi giảm amount + phí/chênh lệch; nguồn nhận chỉ tăng số thực chuyển.
    // Phiếu liên nhà hàng chỉ tính vế thuộc cửa hàng đang xem — vế kia là tiền của cửa
    // hàng khác, cộng vào đây thì bảng nguồn tiền mọc thêm nguồn không phải của mình.
    const legs = transferLegsForBranch(row, branchCode);
    const transferDate = effectiveMoneyTransferDate(row);
    if (legs.out) {
      const fromSource = touchSource(row.fromMoneySourceCode);
      // Phí KHÔNG nằm trong cột điều tiền: bảng danh mục tính nó là một khoản chi, nên cột Chi
      // của nguồn tiền phải nhận nó thì hai tổng mới bằng nhau. Phần phí được ghi ở khối dưới.
      fromSource.transferOut += row.amount;
      bumpSourceMonth(fromSource, transferDate, -row.amount);
    }
    if (legs.in) {
      const toSource = touchSource(row.toMoneySourceCode);
      toSource.transferIn += row.amount;
      bumpSourceMonth(toSource, transferDate, row.amount);
    }
    if (legs.out && row.feeAmount !== 0) {
      const isWalletSettlement = row.transferPurpose === "WALLET_SETTLEMENT";
      // Phí quyết toán ví về đúng khoản mục của khách chứ không gom một dòng "Phí ví/POS":
      // phần chi phí bán hàng Grab tách riêng, phần còn lại là phí quẹt thẻ bán hàng. Ví nào
      // là Grab thì đọc theo nhãn nguồn tiền, giống cách màn Tiền về đủ chưa đang gán phí.
      const fromSourceRow = moneySourceByCode.get(row.fromMoneySourceCode);
      const walletFeeCategoryCode = isGrabMoneySource(row.fromMoneySourceCode, fromSourceRow?.name)
        ? WALLET_GRAB_EXPENSE_CATEGORY_CODE
        : WALLET_CARD_FEE_CATEGORY_CODE;
      /** Khoản mục đã khai trên phiếu; thiếu thì suy theo loại phiếu (quyết toán ví / nộp tiền). */
      const categoryFor = (declaredCode: string | null | undefined, walletCode: string) => {
        const declared = resolveCategory(declaredCode, "PAYMENT");
        if (declared) return { key: declared.code, name: declared.name, group: "PAYMENT" as const };
        if (isWalletSettlement) {
          const walletCategory = resolveCategory(walletCode, "PAYMENT");
          // Danh mục chưa khai hai khoản mục này thì vẫn hiện đúng tên để khách biết đường bổ sung.
          return walletCategory
            ? { key: walletCategory.code, name: walletCategory.name, group: "PAYMENT" as const }
            : {
                key: walletCode,
                name: walletCode === WALLET_GRAB_EXPENSE_CATEGORY_CODE ? "Chi phí bán hàng Grab" : "Chi phí quẹt thẻ bán hàng",
                group: "PAYMENT" as const,
              };
        }
        if (row.transferPurpose === "CASH_DEPOSIT") {
          return { key: "CASH_ROUNDING", name: "Chênh lệch làm tròn tiền nộp", group: "PAYMENT" as const };
        }
        return null;
      };
      const bumpFee = (declaredCode: string | null | undefined, walletCode: string, amount: number) => {
        if (!amount) return;
        const category = categoryFor(declaredCode, walletCode);
        recordFlow(
          "PAYMENT",
          category || { key: unclassifiedKey, name: "Chưa phân loại", group: "PAYMENT" },
          row.fromMoneySourceCode,
          effectiveMoneyTransferDate(row),
          amount,
        );
        if (!category) bumpUnclassified("PAYMENT", "transferFee", amount);
      };
      // grabExpenseAmount là phần Grab NẰM TRONG feeAmount, nên phần quẹt thẻ là số còn lại.
      const grabExpense = isWalletSettlement ? row.grabExpenseAmount : 0;
      bumpFee(row.grabExpenseCategoryCode, WALLET_GRAB_EXPENSE_CATEGORY_CODE, grabExpense);
      bumpFee(row.feeCategoryCode, walletFeeCategoryCode, row.feeAmount - grabExpense);
    }
  }

  /**
   * Tiền cọc: nhận cọc là tiền vào nhưng chưa phải doanh thu, cấn trừ vào bill mới thành
   * doanh thu (và không có tiền chạy). Bảng dưới theo dõi số cọc còn nắm giữ theo từng
   * nguồn tiền: đầu kỳ mang sang - phát sinh thêm - đã dùng - cuối kỳ còn lại.
   *
   * Bảng tổng chỉ gồm nguồn tiền mặt/ngân hàng theo chốt nghiệp vụ: cọc đến từ nhiều nguồn
   * (kể cả ví) nhưng bảng tổng hợp chỉ theo dõi bank và cash; cọc qua ví vẫn xem đủ ở màn
   * Tiền cọc. Cọc chưa gắn nguồn tiền gom về một dòng riêng để không biến mất khỏi tổng.
   */
  const UNASSIGNED_DEPOSIT_SOURCE = "CHUA_GAN_NGUON";
  const depositSummary = new Map<string, { code: string; name: string; opening: number; increase: number; used: number }>();
  const touchDeposit = (code: string) => {
    const existing = depositSummary.get(code);
    if (existing) return existing;
    const name = code === UNASSIGNED_DEPOSIT_SOURCE
      ? "Chưa gắn nguồn tiền"
      : moneySourceByCode.get(code)?.name || code;
    const created = { code, name, opening: 0, increase: 0, used: 0 };
    depositSummary.set(code, created);
    return created;
  };

  for (const history of depositHistories) {
    const amount = history.amount || 0;
    if (!amount) continue;
    const sourceCode = history.deposit?.moneySourceCode;
    const actionDate = history.actionDate || history.createdAt;
    const signed = depositIncreaseActions.includes(history.action)
      ? amount
      : depositDecreaseActions.includes(history.action)
        ? -amount
        : history.action === "UPDATE" ? amount : 0;
    if (!signed) continue;

    const sourceGroup = sourceCode ? normalizeMoneySourceGroup(moneySourceByCode.get(sourceCode)?.group) : "";
    const summaryRow = !sourceCode
      ? touchDeposit(UNASSIGNED_DEPOSIT_SOURCE)
      : sourceGroup === "WALLET" ? null : touchDeposit(sourceCode);
    if (summaryRow) {
      if (actionDate < start) summaryRow.opening += signed;
      else if (signed > 0) summaryRow.increase += signed;
      else summaryRow.used += -signed;
    }

    if (actionDate < start) continue;

    // Dòng "Thu tiền cọc"/"Hoàn cọc cho khách" bump theo ĐÚNG các lịch sử đã vào bảng tổng
    // cọc (summaryRow), để "Thu tiền cọc" luôn bằng tổng cột "Cọc phát sinh thêm trong kỳ"
    // — khách đối chiếu hai số này với nhau. Cấn trừ vào bill không nằm ở đây: nó không
    // phải dòng tiền, chỉ làm tăng cột "Cọc đã sử dụng" và doanh thu đã có bên luồng POS.
    // Sổ cọc là bản ghi DUY NHẤT của tiền cọc: phiếu thu/chi mang thao tác cọc đã nhường chỗ
    // ở vòng chứng từ, kể cả khi lịch sử này sinh ra từ một phiếu (history.voucherId).
    // Cấn trừ/chuyển doanh thu không có tiền chạy nên chỉ hoàn cọc mới là dòng tiền chi.
    if (summaryRow) {
      if (signed > 0) {
        recordFlow("RECEIPT", depositInRow, sourceCode, actionDate, signed);
      } else if (history.action === "REFUND" || history.action === "UPDATE") {
        recordFlow("PAYMENT", depositRefundRow, sourceCode, actionDate, -signed);
      }
    }
  }

  // Dự chi trong kỳ: phiếu chi còn nháp/chờ duyệt, quy về đúng nguồn tiền sẽ chi.
  for (const row of pendingVouchers) {
    if (row.voucherType !== "PAYMENT" || !row.moneySourceCode) continue;
    if (!sourceFlows.has(row.moneySourceCode)) continue;
    touchSource(row.moneySourceCode).expectedOut += row._sum.amount || 0;
  }

  // Dự thu trong kỳ: doanh thu ví/POS đã ghi nhận nhưng chưa quyết toán về ngân hàng.
  // Chỉ ví có khai `settlementBankCode` mới quy được về ngân hàng đích.
  const mappedWallets = moneySources.filter((source) =>
    normalizeMoneySourceGroup(source.group) === "WALLET"
    && source.status === "ACTIVE"
    && source.settlementBankCode
    && sourceFlows.has(source.settlementBankCode)
    && moneySourceMatchesBranch(source, branchCode));

  if (mappedWallets.length > 0) {
    const posByDay = new Map<string, typeof posRevenues>();
    for (const row of posRevenues) {
      const day = row.saleDate.toISOString().slice(0, 10);
      const bucket = posByDay.get(day) || [];
      bucket.push(row);
      posByDay.set(day, bucket);
    }
    const manualByDay = new Map<string, typeof manualEntries>();
    for (const row of manualEntries) {
      const day = row.reportDate.toISOString().slice(0, 10);
      const bucket = manualByDay.get(day) || [];
      bucket.push(row);
      manualByDay.set(day, bucket);
    }

    const settledByWallet = new Map<string, number>();
    for (const row of walletSettlements) {
      // Doanh thu ví là số GỘP trước phí, còn phiếu quyết toán ghi số thực nhận + phí tách riêng.
      const gross = row.amount + row.feeAmount;
      settledByWallet.set(row.fromMoneySourceCode, (settledByWallet.get(row.fromMoneySourceCode) || 0) + gross);
    }

    const declaredByWallet = new Map<string, number>();
    for (const day of new Set([...posByDay.keys(), ...manualByDay.keys()])) {
      const posRows = (posByDay.get(day) || []).map((row) => ({
        paymentMethod: row.paymentMethod,
        revenueSource: row.revenueSource,
        channel: row.channel,
        netAmount: row._sum.netAmount || 0,
      }));
      const manualRows = manualByDay.get(day) || [];
      for (const wallet of mappedWallets) {
        // Ngày có POS thì POS là số chốt cho từng ví. Ngày chỉ có số nhập tay thì không tách
        // được theo từng ví, nên chỉ dùng khi ví đó là ví duy nhất trỏ về ngân hàng đích.
        const sameBankWallets = mappedWallets.filter((row) => row.settlementBankCode === wallet.settlementBankCode);
        const declared = selectWalletDeclaredRevenue({
          posRows,
          manualRows: sameBankWallets.length === 1 ? manualRows : [],
          bucketSources: [wallet],
          bucket: walletRevenueBucket(wallet),
        });
        if (declared.amount > 0) {
          declaredByWallet.set(wallet.code, (declaredByWallet.get(wallet.code) || 0) + declared.amount);
        }
      }
    }

    for (const wallet of mappedWallets) {
      const pending = remainingWalletGross(
        declaredByWallet.get(wallet.code) || 0,
        settledByWallet.get(wallet.code) || 0,
      );
      if (pending > 0) touchSource(wallet.settlementBankCode as string).expectedIn += pending;
    }
  }

  const incomeRows = finalizeCategories(income);
  const expenseRows = finalizeCategories(expense);
  const totalIn = incomeRows.reduce((sum, row) => sum + row.total, 0);
  const totalOut = expenseRows.reduce((sum, row) => sum + row.total, 0);
  const byMonth = months.map((period, index) => {
    const monthIn = incomeRows.reduce((sum, row) => sum + row.months[index], 0);
    const monthOut = expenseRows.reduce((sum, row) => sum + row.months[index], 0);
    return { period, in: monthIn, out: monthOut, net: monthIn - monthOut };
  });

  const partnerRows = Array.from(expenseByPartner.values()).sort((a, b) => b.total - a.total);
  const supplierRows = partnerRows.filter((row) => supplierPartnerTypes.includes((row.partnerType || "").toUpperCase()));
  // groupBy tách theo cả nguồn tiền nên phải cộng lại mới ra tổng phiếu chờ của mỗi chiều.
  const sumPending = (voucherType: string) => pendingVouchers
    .filter((row) => row.voucherType === voucherType)
    .reduce((total, row) => ({
      amount: total.amount + (row._sum.amount || 0),
      count: total.count + row._count._all,
    }), { amount: 0, count: 0 });
  const pendingIn = sumPending("RECEIPT");
  const pendingOut = sumPending("PAYMENT");

  // Mục tiêu "Nguồn tiền còn lại" theo từng tháng; xem Tất cả cửa hàng thì cộng mục tiêu
  // của các cửa hàng lại.
  const targetByMonth = months.map((month) => cashRemainingTargets
    .filter((row) => row.period === month)
    .reduce((sum, row) => sum + row.targetValue, 0));

  return {
    months,
    branchCode,
    totals: {
      in: totalIn,
      out: totalOut,
      net: totalIn - totalOut,
      netRatio: totalIn ? (totalIn - totalOut) / totalIn : 0,
      byMonth,
    },
    cashRemainingTarget: {
      byMonth: targetByMonth,
      total: targetByMonth.reduce((sum, value) => sum + value, 0),
    },
    income: incomeRows,
    expense: expenseRows,
    expenseByPartner: partnerRows.slice(0, 30),
    expensePartnerCount: partnerRows.length,
    supplierExpense: { total: supplierRows.reduce((sum, row) => sum + row.total, 0), count: supplierRows.length },
    unclassified: { income: unclassifiedIncome, expense: unclassifiedExpense, origins: unclassifiedOrigins },
    pending: {
      receiptAmount: pendingIn.amount,
      receiptCount: pendingIn.count,
      paymentAmount: pendingOut.amount,
      paymentCount: pendingOut.count,
    },
    internalTransfer: (() => {
      // Đếm theo vế tiền ĐI để hai cửa hàng không cùng khai một phiếu liên nhà hàng.
      const outgoing = transfers.filter((row) => transferLegsForBranch(row, branchCode).out);
      return { total: outgoing.reduce((sum, row) => sum + row.amount, 0), count: outgoing.length };
    })(),
    deposits: Array.from(depositSummary.values())
      .map((row) => ({ ...row, closing: row.opening + row.increase - row.used }))
      .filter((row) => Math.abs(row.opening) > 0.5 || Math.abs(row.increase) > 0.5 || Math.abs(row.used) > 0.5)
      .sort((a, b) => b.closing - a.closing),
    sources: (() => {
      // Ví/cổng thanh toán vốn không thuộc bảng sổ quỹ, nhưng doanh thu ví là một khoản THU
      // trên bảng danh mục nên phải có chỗ đứng ở đây, không thì dòng TỔNG không bao giờ khớp
      // Tổng thu. Chỉ hiện khi thực sự có phát sinh trong kỳ.
      const detailRows = Array.from(sourceFlows.values())
        .filter((row) => ["CASH", "BANK"].includes(normalizeMoneySourceGroup(row.group))
          || row.in !== 0 || row.out !== 0)
        .filter((row) => moneySourceMatchesBranch({ ...row, branch: row.branchCode }, branchCode));
      // Gộp các nguồn cùng "Nguồn tiền tổng" (khai trên danh mục) thành một dòng; gộp trước khi
      // tính số dư vì mọi cột đều cộng tuyến tính. Nguồn không khai tên tổng giữ nguyên từng dòng.
      const grouped = new Map<string, (typeof detailRows)[number] & { memberCodes: string[] }>();
      for (const row of detailRows) {
        const key = row.summaryName ? `${row.branchCode}|${row.summaryName}` : `${row.branchCode}|#${row.code}`;
        const current = grouped.get(key);
        if (!current) {
          grouped.set(key, { ...row, name: row.summaryName || row.name, memberCodes: [row.code], netByMonth: [...row.netByMonth] });
          continue;
        }
        current.memberCodes.push(row.code);
        current.opening += row.opening;
        current.in += row.in;
        current.out += row.out;
        current.transferIn += row.transferIn;
        current.transferOut += row.transferOut;
        current.expectedIn += row.expectedIn;
        current.expectedOut += row.expectedOut;
        row.netByMonth.forEach((net, index) => { current.netByMonth[index] += net; });
      }
      return Array.from(grouped.values())
        .map((row) => {
          // Dự thu/dự chi là tiền CHƯA vào/ra thật nên không được đụng vào số dư cuối kỳ;
          // chúng chỉ dựng thêm một số dư dự kiến để nhìn trước dòng tiền.
          const closing = row.opening + row.in - row.out + row.transferIn - row.transferOut;
          // Số dư cuối mỗi tháng = đầu kỳ + cộng dồn biến động ròng của các tháng trước đó,
          // cho bảng "Tổng quan nguồn tiền cuối mỗi tháng" của báo cáo năm.
          let running = row.opening;
          const closingByMonth = row.netByMonth.map((net) => (running += net));
          return { ...row, code: row.memberCodes.join(", "), closing, closingByMonth, expectedClosing: closing + row.expectedIn - row.expectedOut };
        })
        // Khách yêu cầu xếp theo tên nguồn tiền để dò bằng mắt cho nhanh.
        .sort((a, b) => a.branchCode.localeCompare(b.branchCode) || a.name.localeCompare(b.name, "vi"));
    })(),
  };
}

export type RevenueSettlementRow = {
  date: string;
  moneySourceCode: string;
  moneySourceName: string;
  group: string;
  /** Doanh thu bán hàng ghi nhận trong ngày theo phương thức thanh toán. */
  revenue: number;
  /** Số tiền thực sự đã về nguồn tiền đó cho đúng ngày doanh thu này. */
  received: number;
  /** Chênh lệch: phí thu hộ, hoặc tiền chưa về. */
  remaining: number;
  feeCategoryCode: string | null;
  feeCategoryName: string | null;
  status: "MATCHED" | "FEE" | "WAITING" | "OVER";
};

/** Chỉ những khoản thu này mới là tiền về của doanh thu bán hàng. */
const revenueSettlementCategoryCodes = ["THU_BAN_HANG"];

/** Tên phương thức thanh toán trên file POS chính là tên nguồn tiền, nên so khớp theo nhãn. */
function normalizeSourceLabel(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type MatchableMoneySource = { code: string; name: string; group?: string | null; branch?: string | null };

/**
 * Nối một phương thức thanh toán trên file POS về đúng nguồn tiền trong danh mục.
 *
 * Máy bán hàng ghi phương thức thanh toán bằng tên hiển thị ("FDS - Quẹt Thẻ Momo") hoặc bằng mã
 * rút gọn ("MOMO_EDC"), nên đoán bằng cách dò chữ trong chuỗi là không đủ: "MOMO_EDC" không chứa
 * chữ "quẹt" nào, và nếu chỉ dò chữ thì toàn bộ doanh thu ví rơi vào nhóm "Khác". Phải nối về
 * danh mục rồi đọc nhóm nguồn tiền mới ra đúng.
 */
export function createMoneySourceMatcher<T extends MatchableMoneySource>(sources: T[], branchCode: string) {
  const visibleSources = sources.filter((row) => moneySourceMatchesBranch({ ...row, group: row.group ?? null, branch: row.branch ?? null }, branchCode));
  const sourceByLabel = new Map<string, T>();
  for (const row of visibleSources) {
    for (const label of [normalizeSourceLabel(row.name), normalizeSourceLabel(row.code)]) {
      if (label && !sourceByLabel.has(label)) sourceByLabel.set(label, row);
    }
  }
  return (...labels: unknown[]) => {
    const keys = labels.map((label) => normalizeSourceLabel(label)).filter(Boolean);
    for (const key of keys) {
      const exact = sourceByLabel.get(key);
      if (exact) return exact;
    }
    // Mã rút gọn "MOMO_EDC" phải nối được về "MOMO_EDC_FDS". Chỉ nhận khi đúng một nguồn tiền của
    // cửa hàng khớp, để không gán nhầm sang ví cùng hãng của cửa hàng khác.
    for (const key of keys) {
      const prefixed = visibleSources.filter((row) => [normalizeSourceLabel(row.code), normalizeSourceLabel(row.name)]
        .some((candidate) => candidate.startsWith(`${key} `)));
      if (prefixed.length === 1) return prefixed[0];
    }
    return null;
  };
}

/**
 * Đối chiếu doanh thu bán hàng với tiền thực về, theo từng Ngày và từng Nguồn tiền.
 *
 * Đây là bảng khách đang theo dõi tay ("Chi tiết DT"): mỗi ngày, mỗi phương thức thanh toán
 * thì doanh thu bao nhiêu, tiền đã về bao nhiêu, còn lại bao nhiêu và phần chênh thuộc chi phí
 * nào. Hai vế lấy từ hai luồng độc lập — doanh thu từ import POS, tiền về từ sổ sao kê — nên
 * bên nào chưa có dữ liệu thì hiện đúng là chưa có, không chặn bên còn lại.
 */
export async function getRevenueSettlementReport(period: string, branchCode: string) {
  const { start, end } = periodBounds(period);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };

  const [moneySources, posRevenues, manualEntries, allocations, cashReceipts, feeCategories] = await Promise.all([
    prisma.masterDataItem.findMany({
      where: { type: "MONEY_SOURCE", status: "ACTIVE" },
      select: { code: true, name: true, group: true, branch: true },
    }),
    prisma.revenueImportRow.groupBy({
      by: ["saleDate", "branchCode", "paymentMethod", "revenueSource", "channel"],
      where: { ...branchFilter, saleDate: { gte: start, lt: end } },
      _sum: { netAmount: true },
    }),
    prisma.manualRevenueEntry.findMany({
      where: { ...branchFilter, reportDate: { gte: start, lt: end } },
      select: { reportDate: true, branchCode: true, cashAmount: true, transferAmount: true, cardAmount: true, grabAmount: true },
    }),
    // Tiền về của đúng Ngày doanh thu, lấy từ sổ sao kê đã ghi nhận.
    prisma.bankStatementAllocation.findMany({
      where: {
        revenueDate: { gte: start, lt: end },
        creditAmount: { gt: 0 },
        // Chỉ tiền về của doanh thu bán hàng. Không lọc loại thì các khoản hoàn thẻ ghi có
        // (Chi phí di chuyển BOD...) cũng nhảy vào đây và làm báo cáo doanh thu sai.
        OR: [
          { categoryCode: { in: revenueSettlementCategoryCodes } },
          { categoryCode: null, bankTransaction: { categoryCode: { in: revenueSettlementCategoryCodes } } },
        ],
        bankTransaction: { deletedAt: null, ...(branchCode === "ALL" ? {} : { branchCode }) },
      },
      select: { revenueDate: true, creditAmount: true, grossAmount: true, decreaseMoneySourceCode: true },
    }),
    // Doanh thu tiền mặt được xác nhận bằng phiếu thu đã duyệt của chính ngày đó.
    prisma.financialVoucher.findMany({
      where: {
        ...branchFilter,
        voucherType: "RECEIPT",
        status: { in: cashReportVoucherStatuses },
        voucherDate: { gte: start, lt: end },
        deletedAt: null,
      },
      select: { voucherDate: true, moneySourceCode: true, amount: true, depositAction: true },
    }),
    prisma.masterDataItem.findMany({
      where: { type: "REVENUE_EXPENSE_CATEGORY", code: { in: [WALLET_CARD_FEE_CATEGORY_CODE, WALLET_GRAB_EXPENSE_CATEGORY_CODE] } },
      select: { code: true, name: true },
    }),
  ]);

  // Doanh thu nhập tay lưu nửa đêm giờ Việt Nam, doanh thu import và sao kê lưu UTC midnight.
  // Quy về cùng ngày nghiệp vụ để hai vế không lệch nhau một ngày.
  const dayKey = vietnamBusinessDayKey;
  const sourceByCode = new Map(moneySources.map((row) => [row.code, row]));
  const visibleSources = moneySources.filter((row) => moneySourceMatchesBranch(row, branchCode));
  // Nối theo cửa hàng của chính dòng doanh thu; lọc theo "ALL" thì mã rút gọn "MOMO_EDC" có nhiều
  // ứng viên nên không phân định được và doanh thu ví bị bỏ ra ngoài.
  const matcherByBranch = new Map<string, ReturnType<typeof createMoneySourceMatcher>>();
  const matchSource = (paymentMethod: unknown, revenueSource: unknown, channel: unknown, rowBranch?: string) => {
    const key = rowBranch || branchCode;
    const current = matcherByBranch.get(key) || createMoneySourceMatcher(moneySources, key);
    matcherByBranch.set(key, current);
    return current(paymentMethod, revenueSource, channel);
  };

  const cells = new Map<string, RevenueSettlementRow>();
  const touch = (date: string, source: { code: string; name: string; group?: string | null }) => {
    const key = `${date}|${source.code}`;
    const current = cells.get(key);
    if (current) return current;
    const created: RevenueSettlementRow = {
      date,
      moneySourceCode: source.code,
      moneySourceName: source.name,
      group: normalizeMoneySourceGroup(source.group),
      revenue: 0,
      received: 0,
      remaining: 0,
      feeCategoryCode: null,
      feeCategoryName: null,
      status: "MATCHED",
    };
    cells.set(key, created);
    return created;
  };

  // Khoá theo cả cửa hàng: xem "Tất cả cửa hàng" mà chỉ khoá theo ngày thì cửa hàng có POS sẽ nuốt
  // luôn số nhập tay của cửa hàng khác, làm doanh thu thiếu hẳn một cửa hàng.
  const posDays = new Set(posRevenues.map((row) => `${row.branchCode}|${dayKey(row.saleDate)}`));
  for (const row of posRevenues) {
    const source = matchSource(row.paymentMethod, row.revenueSource, row.channel, row.branchCode);
    // Không gán được về nguồn tiền nào thì vẫn phải hiện ra, kèm nhãn nói rõ lý do. Bỏ qua
    // lặng lẽ sẽ làm doanh thu biến mất khỏi báo cáo mà không ai biết.
    const target = source || {
      code: String(row.paymentMethod || row.revenueSource || "KHONG RO").trim(),
      name: `${String(row.paymentMethod || row.revenueSource || "Không rõ").trim()} — chưa gán nguồn tiền`,
      group: null,
    };
    touch(dayKey(row.saleDate), target).revenue += row._sum.netAmount || 0;
  }

  // Ngày không có dòng POS nào thì mới dùng số thu ngân nhập tay, tránh cộng chồng.
  //
  // Số nhập tay chỉ có 4 ô tổng (chuyển khoản / thẻ+ví / Grab / tiền mặt), KHÔNG nói tiền thuộc
  // nguồn tiền cụ thể nào. Bản trước đoán nguồn theo tên và đoán sai — từ khoá "vi" (Ví) khớp
  // luôn "Vietinbank", nên tiền thẻ bị gán vào tài khoản ngân hàng, còn tiền chuyển khoản gán
  // vào tài khoản đứng đầu danh sách; khách nhìn thấy Chưa về / Về dư giả trong khi tiền không
  // hề sai. Ngày dùng số nhập tay thì so ở ĐÚNG độ mịn của dữ liệu: mỗi ô một dòng gộp, tiền về
  // của cả nhóm nguồn đổ vào dòng đó — khớp từng số với màn Thu chi ngày.
  const manualBucketDays = new Set<string>();
  const manualBucketSource = (branch: string, bucket: "bank" | "card" | "grab" | "cash") => ({
    bank: { code: `NHAPTAY_CK_${branch}`, name: `Chuyển khoản — thu ngân khai (${branch})`, group: "BANK" },
    card: { code: `NHAPTAY_THEVI_${branch}`, name: `Quẹt thẻ / Ví — thu ngân khai (${branch})`, group: "WALLET" },
    grab: { code: `NHAPTAY_GRAB_${branch}`, name: `Grab — thu ngân khai (${branch})`, group: "WALLET" },
    cash: { code: `NHAPTAY_TM_${branch}`, name: `Tiền mặt — thu ngân khai (${branch})`, group: "CASH" },
  }[bucket]);
  for (const row of manualEntries) {
    const day = dayKey(row.reportDate);
    if (posDays.has(`${row.branchCode}|${day}`)) continue;
    manualBucketDays.add(`${row.branchCode}|${day}`);
    if (row.transferAmount) touch(day, manualBucketSource(row.branchCode, "bank")).revenue += row.transferAmount;
    if (row.cardAmount) touch(day, manualBucketSource(row.branchCode, "card")).revenue += row.cardAmount;
    if (row.grabAmount) touch(day, manualBucketSource(row.branchCode, "grab")).revenue += row.grabAmount;
    // Tiền mặt không cộng ở đây: ô tiền mặt của thu ngân bị khoá (luôn 0), cả hai vế của dòng
    // tiền mặt cùng lấy từ phiếu thu đã duyệt ở vòng phiếu thu bên dưới.
  }
  // Ngày nhập tay thì tiền về cũng phải gộp theo nhóm, không thì vế khai nằm ở dòng gộp còn vế
  // tiền về nằm ở dòng nguồn cụ thể — hai vế không bao giờ gặp nhau.
  const bucketFor = (source: { code: string; name: string; group?: string | null }) => {
    const group = normalizeMoneySourceGroup(source.group);
    if (group === "CASH") return "cash" as const;
    if (group === "BANK") return "bank" as const;
    if (group !== "WALLET") return null;
    return isGrabMoneySource(source.code, source.name) ? ("grab" as const) : ("card" as const);
  };

  for (const row of allocations) {
    if (!row.revenueDate || !row.decreaseMoneySourceCode) continue;
    const source = sourceByCode.get(row.decreaseMoneySourceCode);
    if (!source || !moneySourceMatchesBranch(source, branchCode)) continue;
    // Đúng như bảng khách theo dõi tay: cột "đã vô" là số tiền THỰC NHẬN, nên phần chênh
    // so với doanh thu chính là phí thu hộ (ví) hoặc phần tiền chưa về (ngân hàng).
    const day = dayKey(row.revenueDate);
    const bucket = source.branch && source.branch !== "ALL" && manualBucketDays.has(`${source.branch}|${day}`)
      ? bucketFor(source)
      : null;
    touch(day, bucket ? manualBucketSource(source.branch as string, bucket) : source).received += row.creditAmount;
  }

  for (const row of cashReceipts) {
    if (row.depositAction) continue;
    const source = sourceByCode.get(row.moneySourceCode);
    if (!source || normalizeMoneySourceGroup(source.group) !== "CASH") continue;
    if (!moneySourceMatchesBranch(source, branchCode)) continue;
    const day = dayKey(row.voucherDate);
    if (source.branch && source.branch !== "ALL" && manualBucketDays.has(`${source.branch}|${day}`)) {
      // Thu ngân không gõ ô tiền mặt (bị khoá) nên vế khai cũng lấy từ phiếu thu — dòng tiền mặt
      // của ngày nhập tay luôn ĐỦ; hiện ra để khách thấy đã đối chiếu, không phải để bắt lệch.
      const cell = touch(day, manualBucketSource(source.branch, "cash"));
      cell.revenue += row.amount;
      cell.received += row.amount;
    } else {
      touch(day, source).received += row.amount;
    }
  }

  const feeNameByCode = new Map(feeCategories.map((row) => [row.code, row.name]));
  const rows = [...cells.values()]
    .filter((row) => Math.abs(row.revenue) > 0.5 || Math.abs(row.received) > 0.5)
    .map((row) => {
      const remaining = Math.round(row.revenue - row.received);
      const isGrab = isGrabMoneySource(row.moneySourceCode, row.moneySourceName);
      const feeCategoryCode = row.group === "WALLET" && remaining > 0
        ? (isGrab ? WALLET_GRAB_EXPENSE_CATEGORY_CODE : WALLET_CARD_FEE_CATEGORY_CODE)
        : null;
      return {
        ...row,
        revenue: Math.round(row.revenue),
        received: Math.round(row.received),
        remaining,
        feeCategoryCode,
        feeCategoryName: feeCategoryCode ? feeNameByCode.get(feeCategoryCode) || feeCategoryCode : null,
        status: Math.abs(remaining) < 1000
          ? ("MATCHED" as const)
          // Tiền về nhiều hơn doanh thu ghi nhận là chuyện khác hẳn thiếu tiền: có thể ngân hàng
          // trả gộp nhiều ngày, hoặc doanh thu ngày đó chưa nhập. Phải gọi đúng tên.
          : remaining < 0
            ? ("OVER" as const)
            : row.received === 0
              ? ("WAITING" as const)
              : ("FEE" as const),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.moneySourceName.localeCompare(b.moneySourceName, "vi"));

  return {
    period,
    branchCode,
    rows,
    totals: {
      revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
      received: rows.reduce((sum, row) => sum + row.received, 0),
      remaining: rows.reduce((sum, row) => sum + row.remaining, 0),
      waiting: rows.filter((row) => row.status === "WAITING").reduce((sum, row) => sum + row.remaining, 0),
      // Chỉ phần chênh dương của ví ĐÃ CÓ tiền về mới là phí thu hộ. Ví chưa về đồng nào
      // (WAITING) là tiền đang trên đường, không phải phí — gộp vào đây thì mấy ngày cuối kỳ
      // (ví chưa kịp quyết toán) thổi phí lên hàng trăm triệu. Dòng ngân hàng hay dòng về dư
      // cũng không được tính, ra một con số vô nghĩa, có khi âm.
      fee: rows.filter((row) => row.group === "WALLET" && row.remaining > 0 && row.received > 0)
        .reduce((sum, row) => sum + row.remaining, 0),
      over: rows.filter((row) => row.status === "OVER").reduce((sum, row) => sum - row.remaining, 0),
    },
  };
}

export async function getCashflowForecast(period: string, branchCode: string, scenario: string) {
  const balance = await getBalanceSheet(period, branchCode);
  const cash = balance.rows.filter((row) => row.reportGroup === "CASH").reduce((sum, row) => sum + row.amount, 0);
  const futurePeriods = Array.from({ length: 3 }, (_, index) => addPeriod(period, index + 1));
  const [payables, accruals, assumptions] = await Promise.all([
    prisma.supplierPayable.aggregate({ where: { status: "OPEN", ...(branchCode === "ALL" ? {} : { purchaseOrder: { branchCode } }) }, _sum: { outstandingAmount: true } }),
    prisma.accrualSchedule.findMany({ where: { period: { in: futurePeriods }, status: "PLANNED", ...(branchCode === "ALL" ? {} : { accrual: { branchCode } }) }, include: { accrual: true } }),
    prisma.forecastAssumption.findMany({ where: { period: { in: futurePeriods }, scenario, ...(branchCode === "ALL" ? {} : { branchCode }) } }),
  ]);
  let runningCash = cash;
  const schedule = futurePeriods.map((futurePeriod, index) => {
    const planned = assumptions.filter((row) => row.period === futurePeriod);
    const inflow = planned.filter((row) => row.assumptionType === "INFLOW").reduce((sum, row) => sum + row.amount, 0);
    const manualOutflow = planned.filter((row) => row.assumptionType === "OUTFLOW").reduce((sum, row) => sum + row.amount, 0);
    const accrualOutflow = accruals.filter((row) => row.period === futurePeriod).reduce((sum, row) => sum + row.amount, 0);
    const payableOutflow = index === 0 ? payables._sum.outstandingAmount || 0 : 0;
    const outflow = manualOutflow + accrualOutflow + payableOutflow;
    runningCash += inflow - outflow;
    return { period: futurePeriod, openingCash: index === 0 ? cash : 0, inflow, outflow, closingCash: runningCash, risk: runningCash < 0 };
  });
  return { scenario, startingCash: cash, schedule };
}
