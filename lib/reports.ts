import { prisma } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";
import { periodBounds } from "@/lib/accounting";
import { depositDecreaseActions, depositIncreaseActions } from "@/lib/deposit-accounting";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { CASH_SOURCE_OPENING_TYPES, OPENING_BALANCE_EFFECTIVE_STATUSES } from "@/lib/opening-balance-rules";
import { effectiveMoneyTransferDate, effectiveMoneyTransferDateFilter } from "@/lib/money-transfer-date";
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
 * Quy ước số liệu:
 * - Thu = phiếu thu đã duyệt (theo khoản mục) + doanh thu POS đã import + doanh thu
 *   nhập tay, đúng bằng cách "Báo cáo thu chi ngày" đang cộng, để báo cáo tháng khớp
 *   tổng các báo cáo ngày.
 * - Chi = phiếu chi đã duyệt theo khoản mục.
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

  const [vouchers, pendingVouchers, categories, partners, moneySources, posRevenues, manualEntries, adjustments, transfers, openingBalances, walletSettlements, depositHistories] =
    await Promise.all([
      prisma.financialVoucher.findMany({
        where: {
          ...branchFilter,
          voucherDate: { gte: start, lt: end },
          voucherType: { in: ["RECEIPT", "PAYMENT"] },
          status: { in: cashReportVoucherStatuses },
        },
        select: { voucherType: true, voucherDate: true, categoryCode: true, partnerCode: true, partnerName: true, moneySourceCode: true, amount: true, depositAction: true, businessEffect: true },
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
      prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE" }, select: { code: true, name: true, group: true, branch: true, status: true, settlementBankCode: true } }),
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
      prisma.moneyTransfer.findMany({
        where: { ...branchFilter, ...effectiveMoneyTransferDateFilter(start, end), status: "APPROVED" },
        select: { transferDate: true, actualTransferDate: true, amount: true, feeAmount: true, feeCategoryCode: true, transferPurpose: true, fromMoneySourceCode: true, toMoneySourceCode: true },
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
    ]);

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
  const sourceFlows = new Map<string, { code: string; name: string; group: string | null; branchCode: string; opening: number; in: number; out: number; transferIn: number; transferOut: number; expectedIn: number; expectedOut: number }>();

  const touchSource = (code: string) => {
    const existing = sourceFlows.get(code);
    if (existing) return existing;
    const master = moneySources.find((row) => row.code === code);
    const created = {
      code,
      name: master?.name || code,
      group: master?.group || null,
      branchCode: master?.branch || "ALL",
      opening: 0,
      in: 0,
      out: 0,
      transferIn: 0,
      transferOut: 0,
      expectedIn: 0,
      expectedOut: 0,
    };
    sourceFlows.set(code, created);
    return created;
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
  for (const voucher of vouchers) {
    const monthIndex = monthIndexOf(voucher.voucherDate);
    const isIncome = voucher.voucherType === "RECEIPT";
    const isDepositMovement = isIncome
      ? ["COLLECT", "SUPPLEMENT"].includes(voucher.depositAction || "")
      : voucher.depositAction === "REFUND";
    if (!isDepositMovement && voucher.businessEffect !== "SETTLEMENT") {
      const expectedType = isIncome ? "RECEIPT" : "PAYMENT";
      const category = resolveCategory(voucher.categoryCode, expectedType);
      bumpCategory(
        isIncome ? income : expense,
        category
          ? { key: category.code, name: category.name, group: expectedType }
          : { key: unclassifiedKey, name: "Chưa phân loại", group: expectedType },
        monthCount,
        monthIndex,
        voucher.amount,
      );
      if (!category) {
        if (isIncome) unclassifiedIncome += voucher.amount;
        else unclassifiedExpense += voucher.amount;
      }
    }

    const source = touchSource(voucher.moneySourceCode);
    if (isIncome) source.in += voucher.amount;
    else source.out += voucher.amount;

    if (!isIncome) {
      const partnerKey = voucher.partnerCode || voucher.partnerName || "KHAC";
      const partner = voucher.partnerCode ? partnerByCode.get(voucher.partnerCode) : null;
      const current = expenseByPartner.get(partnerKey) || {
        code: voucher.partnerCode || "",
        name: partner?.name || voucher.partnerName || "Không ghi đối tượng",
        partnerType: (partner?.partnerType || partner?.group || null),
        total: 0,
        count: 0,
      };
      current.total += voucher.amount;
      current.count += 1;
      expenseByPartner.set(partnerKey, current);
    }
  }

  for (const row of posRevenues) {
    const category = resolveCategory(row.revenueSource, "RECEIPT");
    const amount = row._sum.netAmount || 0;
    bumpCategory(
      income,
      category
        ? { key: category.code, name: category.name, group: "RECEIPT" }
        : { key: unclassifiedKey, name: "Chưa phân loại", group: "RECEIPT" },
      monthCount,
      monthIndexOf(row.saleDate),
      amount,
      row._count._all,
    );
    if (!category) unclassifiedIncome += amount;
  }
  const posRevenueDays = new Set(posRevenues.map((row) => row.saleDate.toISOString().slice(0, 10)));
  for (const row of manualEntries) {
    if (posRevenueDays.has(row.reportDate.toISOString().slice(0, 10))) continue;
    bumpCategory(income, { key: unclassifiedKey, name: "Chưa phân loại", group: "RECEIPT" }, monthCount, monthIndexOf(row.reportDate), row.totalAmount);
    unclassifiedIncome += row.totalAmount;
  }

  for (const row of adjustments) {
    const monthIndex = monthIndexOf(row.entryDate);
    const source = touchSource(row.moneySourceCode);
    if (row.entryType === "RECEIPT") {
      bumpCategory(income, { key: unclassifiedKey, name: "Chưa phân loại", group: "RECEIPT" }, monthCount, monthIndex, row.amount);
      unclassifiedIncome += row.amount;
      source.in += row.amount;
    } else {
      bumpCategory(expense, { key: unclassifiedKey, name: "Chưa phân loại", group: "PAYMENT" }, monthCount, monthIndex, row.amount);
      unclassifiedExpense += row.amount;
      source.out += row.amount;
    }
  }

  for (const row of transfers) {
    // Nguồn đi giảm amount + phí/chênh lệch; nguồn nhận chỉ tăng số thực chuyển.
    touchSource(row.fromMoneySourceCode).transferOut += row.amount + row.feeAmount;
    touchSource(row.toMoneySourceCode).transferIn += row.amount;
    if (row.feeAmount !== 0) {
      const category = resolveCategory(row.feeCategoryCode, "PAYMENT");
      const fallbackCategory = row.transferPurpose === "CASH_DEPOSIT"
        ? { key: "CASH_ROUNDING", name: "Chênh lệch làm tròn tiền nộp", group: "PAYMENT" as const }
        : row.transferPurpose === "WALLET_SETTLEMENT"
          ? { key: "WALLET_FEE", name: "Phí ví/POS", group: "PAYMENT" as const }
          : { key: unclassifiedKey, name: "Chưa phân loại", group: "PAYMENT" as const };
      bumpCategory(
        expense,
        category
          ? { key: category.code, name: category.name, group: "PAYMENT" }
          : fallbackCategory,
        monthCount,
        monthIndexOf(effectiveMoneyTransferDate(row)),
        row.feeAmount,
      );
      if (!category && !["CASH_DEPOSIT", "WALLET_SETTLEMENT"].includes(row.transferPurpose || "")) unclassifiedExpense += row.feeAmount;
    }
  }

  /**
   * Tiền cọc: nhận cọc là tiền vào nhưng chưa phải doanh thu, cấn trừ vào bill mới thành
   * doanh thu (và không có tiền chạy). Bảng dưới theo dõi số cọc còn nắm giữ theo từng
   * nguồn tiền: đầu kỳ mang sang - phát sinh thêm - đã dùng - cuối kỳ còn lại.
   */
  const depositSummary = new Map<string, { code: string; name: string; opening: number; increase: number; used: number }>();
  const touchDeposit = (code: string) => {
    const existing = depositSummary.get(code);
    if (existing) return existing;
    const created = { code, name: moneySources.find((row) => row.code === code)?.name || code, opening: 0, increase: 0, used: 0 };
    depositSummary.set(code, created);
    return created;
  };

  for (const history of depositHistories) {
    const amount = history.amount || 0;
    if (!amount) continue;
    const sourceCode = history.deposit?.moneySourceCode;
    if (!sourceCode) continue;
    const actionDate = history.actionDate || history.createdAt;
    const signed = depositIncreaseActions.includes(history.action)
      ? amount
      : depositDecreaseActions.includes(history.action)
        ? -amount
        : history.action === "UPDATE" ? amount : 0;
    if (!signed) continue;

    const row = touchDeposit(sourceCode);
    if (actionDate < start) {
      row.opening += signed;
      continue;
    }
    if (signed > 0) row.increase += signed;
    else row.used += -signed;

    const monthIndex = monthIndexOf(actionDate);
    if (signed > 0) {
      // Dòng này dùng đúng cùng lịch sử với cột "Cọc phát sinh thêm trong kỳ",
      // nên hai tổng luôn khớp và không phụ thuộc cọc được tạo trực tiếp hay qua phiếu thu.
      bumpCategory(income, { key: "DEPOSIT_IN", name: "Thu tiền cọc", group: "RECEIPT" }, monthCount, monthIndex, signed);
    } else if (history.action === "REFUND" || history.action === "UPDATE") {
      bumpCategory(expense, { key: "DEPOSIT_REFUND", name: "Hoàn cọc cho khách", group: "PAYMENT" }, monthCount, monthIndex, -signed);
    }

    // Chỉ thao tác làm trực tiếp trên màn Tiền cọc mới cần cộng vào dòng tiền ở đây;
    // thao tác đi kèm phiếu thu/chi đã nằm trong phần chứng từ phía trên.
    if (history.voucherId) continue;
    const source = touchSource(sourceCode);
    if (signed > 0) {
      source.in += signed;
    } else if (history.action === "REFUND" || history.action === "UPDATE") {
      // Cấn trừ/chuyển doanh thu không có tiền ra; chỉ hoàn cọc mới là dòng tiền chi.
      source.out += -signed;
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
    income: incomeRows,
    expense: expenseRows,
    expenseByPartner: partnerRows.slice(0, 30),
    expensePartnerCount: partnerRows.length,
    supplierExpense: { total: supplierRows.reduce((sum, row) => sum + row.total, 0), count: supplierRows.length },
    unclassified: { income: unclassifiedIncome, expense: unclassifiedExpense },
    pending: {
      receiptAmount: pendingIn.amount,
      receiptCount: pendingIn.count,
      paymentAmount: pendingOut.amount,
      paymentCount: pendingOut.count,
    },
    internalTransfer: { total: transfers.reduce((sum, row) => sum + row.amount, 0), count: transfers.length },
    deposits: Array.from(depositSummary.values())
      .map((row) => ({ ...row, closing: row.opening + row.increase - row.used }))
      .filter((row) => Math.abs(row.opening) > 0.5 || Math.abs(row.increase) > 0.5 || Math.abs(row.used) > 0.5)
      .sort((a, b) => b.closing - a.closing),
    sources: Array.from(sourceFlows.values())
      .map((row) => {
        // Dự thu/dự chi là tiền CHƯA vào/ra thật nên không được đụng vào số dư cuối kỳ;
        // chúng chỉ dựng thêm một số dư dự kiến để nhìn trước dòng tiền.
        const closing = row.opening + row.in - row.out + row.transferIn - row.transferOut;
        return { ...row, closing, expectedClosing: closing + row.expectedIn - row.expectedOut };
      })
      .filter((row) => ["CASH", "BANK"].includes(normalizeMoneySourceGroup(row.group)))
      .filter((row) => moneySourceMatchesBranch({ ...row, branch: row.branchCode }, branchCode))
      // Khách yêu cầu xếp theo tên nguồn tiền để dò bằng mắt cho nhanh.
      .sort((a, b) => a.branchCode.localeCompare(b.branchCode) || a.name.localeCompare(b.name, "vi")),
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
    return normalizeSourceLabel(`${source.code} ${source.name}`).includes("grab") ? ("grab" as const) : ("card" as const);
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
      const isGrab = normalizeSourceLabel(`${row.moneySourceCode} ${row.moneySourceName}`).includes("grab");
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
