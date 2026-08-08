import { prisma } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";
import { periodBounds } from "@/lib/accounting";
import { depositDecreaseActions, depositIncreaseActions } from "@/lib/deposit-accounting";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";

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
const cashReportOpeningTypes = ["CASH", "BANK", "WALLET_POS"];
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
 */
export async function getCashSourceReport(months: string[], branchCode: string) {
  const monthCount = months.length;
  const start = new Date(`${months[0]}-01T00:00:00`);
  const end = new Date(`${addPeriod(months[monthCount - 1], 1)}-01T00:00:00`);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const monthIndexOf = (date: Date) => months.indexOf(periodOfDate(date));

  const [vouchers, pendingVouchers, categories, partners, moneySources, posRevenues, manualEntries, adjustments, transfers, openingBalances, depositHistories] =
    await Promise.all([
      prisma.financialVoucher.findMany({
        where: {
          ...branchFilter,
          voucherDate: { gte: start, lt: end },
          voucherType: { in: ["RECEIPT", "PAYMENT"] },
          status: { in: cashReportVoucherStatuses },
        },
        select: { voucherType: true, voucherDate: true, categoryCode: true, partnerCode: true, partnerName: true, moneySourceCode: true, amount: true, depositAction: true },
      }),
      prisma.financialVoucher.groupBy({
        by: ["voucherType"],
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
      prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE" }, select: { code: true, name: true, group: true, branch: true } }),
      // Doanh thu POS có thể tới hàng chục nghìn dòng mỗi năm nên gom sẵn theo ngày bán và danh mục Thu.
      prisma.revenueImportRow.groupBy({
        by: ["saleDate", "revenueSource"],
        where: { ...branchFilter, saleDate: { gte: start, lt: end } },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      prisma.manualRevenueEntry.findMany({
        where: { ...branchFilter, reportDate: { gte: start, lt: end } },
        select: { reportDate: true, totalAmount: true },
      }),
      prisma.cashbookAdjustment.findMany({
        where: { ...branchFilter, entryDate: { gte: start, lt: end } },
        select: { entryDate: true, entryType: true, amount: true, moneySourceCode: true },
      }),
      prisma.moneyTransfer.findMany({
        where: { ...branchFilter, transferDate: { gte: start, lt: end }, status: "APPROVED" },
        select: { transferDate: true, amount: true, feeAmount: true, feeCategoryCode: true, fromMoneySourceCode: true, toMoneySourceCode: true },
      }),
      prisma.openingBalance.findMany({
        where: { period: months[0], ...(branchCode === "ALL" ? {} : { branchCode }), status: "POSTED", balanceType: { in: cashReportOpeningTypes } },
        select: { moneySourceCode: true, amount: true },
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
  const sourceFlows = new Map<string, { code: string; name: string; group: string | null; branchCode: string; opening: number; in: number; out: number; transferIn: number; transferOut: number }>();

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
    if (!isDepositMovement) {
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
  for (const row of manualEntries) {
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
    if (row.feeAmount > 0) {
      const category = resolveCategory(row.feeCategoryCode, "PAYMENT");
      bumpCategory(
        expense,
        category
          ? { key: category.code, name: category.name, group: "PAYMENT" }
          : { key: unclassifiedKey, name: "Chưa phân loại", group: "PAYMENT" },
        monthCount,
        monthIndexOf(row.transferDate),
        row.feeAmount,
      );
      if (!category) unclassifiedExpense += row.feeAmount;
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
  const pendingIn = pendingVouchers.find((row) => row.voucherType === "RECEIPT");
  const pendingOut = pendingVouchers.find((row) => row.voucherType === "PAYMENT");

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
      receiptAmount: pendingIn?._sum.amount || 0,
      receiptCount: pendingIn?._count._all || 0,
      paymentAmount: pendingOut?._sum.amount || 0,
      paymentCount: pendingOut?._count._all || 0,
    },
    internalTransfer: { total: transfers.reduce((sum, row) => sum + row.amount, 0), count: transfers.length },
    deposits: Array.from(depositSummary.values())
      .map((row) => ({ ...row, closing: row.opening + row.increase - row.used }))
      .filter((row) => Math.abs(row.opening) > 0.5 || Math.abs(row.increase) > 0.5 || Math.abs(row.used) > 0.5)
      .sort((a, b) => b.closing - a.closing),
    sources: Array.from(sourceFlows.values())
      .map((row) => ({ ...row, closing: row.opening + row.in - row.out + row.transferIn - row.transferOut }))
      .filter((row) => ["CASH", "BANK"].includes(normalizeMoneySourceGroup(row.group)))
      .filter((row) => moneySourceMatchesBranch({ ...row, branch: row.branchCode }, branchCode))
      .sort((a, b) => a.branchCode.localeCompare(b.branchCode) || b.closing - a.closing || a.name.localeCompare(b.name)),
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
