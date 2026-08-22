import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { allowedMenuTabs, canViewFinancialDashboard } from "@/lib/auth-demo";
import { requestedBranch } from "@/lib/accounting";
import { prisma } from "@/lib/prisma";
import { createMoneySourceMatcher, getBalanceSheet, getCashSourceReport, getCashflowForecast, getPnl, getRevenueSettlementReport, getTrend } from "@/lib/reports";
import { apiError, businessError, cleanText, isPeriodLocked, normalizePeriod, toNumber } from "@/lib/phase3";
import { writeAuditLog } from "@/lib/audit-log";
import { moneySourceDisplayName, normalizeMoneySourceGroup } from "@/lib/money-sources";
import { voucherMatchesShift } from "@/lib/shifts";
import { summarizeDailyDepositHistories } from "@/lib/daily-deposit-report";

const menuHref = "/reports";
const restaurantSalesCategoryCodes = ["THU_BAN_HANG"];

type DailyCashBucket = { total: number; cash: number; transfer: number; card: number; grab: number; other: number };

function monthRange(period: string) {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start, end };
}

function dayRange(dateText: string, shift: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? dateText : new Date().toISOString().slice(0, 10);
  const startHour = shift === "EVENING" ? 15 : 0;
  const endHour = shift === "MORNING" ? 15 : 24;
  return {
    date,
    start: new Date(`${date}T${String(startHour).padStart(2, "0")}:00:00`),
    end: new Date(`${date}T${String(endHour).padStart(2, "0")}:00:00`),
  };
}

function addAmount(bucket: DailyCashBucket, key: keyof Omit<DailyCashBucket, "total">, amount: number) {
  bucket.total += amount;
  bucket[key] += amount;
}

function classifyPayment(paymentMethod: string | null | undefined, channel?: string | null) {
  const method = (paymentMethod || "").toUpperCase();
  const saleChannel = (channel || "").toUpperCase();
  if (saleChannel.includes("GRAB") || method.includes("GRAB")) return "grab" as const;
  if (method.includes("CASH") || method.includes("TIEN MAT") || method.includes("TIỀN MẶT")) return "cash" as const;
  if (method.includes("CARD") || method.includes("POS") || method.includes("QUET") || method.includes("QUẸT")) return "card" as const;
  if (method.includes("BANK") || method.includes("TRANSFER") || method.includes("CHUYEN") || method.includes("CHUYỂN")) return "transfer" as const;
  return "other" as const;
}

/**
 * Xếp một dòng doanh thu POS vào nhóm hình thức thanh toán.
 *
 * Nối về danh mục nguồn tiền trước rồi mới đọc nhóm; chỉ khi không nối được mới đoán bằng chữ.
 * Máy bán hàng ghi mã rút gọn như "MOMO_EDC" — chuỗi này không chứa chữ "quẹt" nào, nên nếu chỉ
 * dò chữ thì toàn bộ doanh thu ví bị dồn vào cột "Khác".
 */
function classifyRevenueRow(
  matchSource: ReturnType<typeof createMoneySourceMatcher>,
  paymentMethod: string | null | undefined,
  revenueSource: string | null | undefined,
  channel: string | null | undefined,
) {
  const saleChannel = (channel || "").toUpperCase();
  if (saleChannel.includes("GRAB")) return "grab" as const;
  const source = matchSource(paymentMethod, revenueSource);
  if (!source) return classifyPayment(paymentMethod, channel);
  // Grab là ví nhưng phải đứng riêng một cột, vì phần chênh gross/net của Grab là chi phí
  // bán hàng chứ không phải phí cà thẻ.
  if (normalizeMoneySourceLabel(`${source.code} ${source.name}`).includes("grab")) return "grab" as const;
  return classifyMoneySource(source.group);
}

function classifyMoneySource(group: string | null | undefined) {
  const normalized = normalizeMoneySourceGroup(group);
  if (normalized === "CASH") return "cash" as const;
  if (normalized === "BANK") return "transfer" as const;
  if (normalized === "WALLET") return "card" as const;
  return "other" as const;
}

function addStatus(statusCounts: Record<string, number>, status: string) {
  statusCounts[status] = (statusCounts[status] || 0) + 1;
}

function departmentLabel(code: string, departments: Map<string, string>) {
  if (!code || code === "UNASSIGNED") return "Chưa gán phòng ban";
  return departments.get(code) || code;
}

function addGroup(
  groups: Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>,
  departmentCode: string,
  departments: Map<string, string>,
  amount: number,
  status: string,
  overdue = false,
) {
  const code = departmentCode || "UNASSIGNED";
  const current = groups.get(code) || {
    departmentCode: code,
    departmentName: departmentLabel(code, departments),
    count: 0,
    amount: 0,
    statusCounts: {},
    overdue: 0,
  };
  current.count += 1;
  current.amount += amount;
  if (overdue) current.overdue = (current.overdue || 0) + 1;
  addStatus(current.statusCounts, status);
  groups.set(code, current);
}

async function getOperationsReport(period: string, branchCode: string) {
  const { start, end } = monthRange(period);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };
  const departments = await prisma.masterDataItem.findMany({ where: { type: "DEPARTMENT", status: "ACTIVE" } });
  const departmentMap = new Map(departments.map((item) => [item.code, item.name]));

  const [purchaseRequests, purchaseOrders, receipts, workItems, assets] = await Promise.all([
    prisma.purchaseRequest.findMany({
      where: { ...branchWhere, requestDate: { gte: start, lte: end } },
      include: { lines: true },
      orderBy: { requestDate: "desc" },
      take: 200,
    }),
    prisma.purchaseOrder.findMany({
      where: { ...branchWhere, orderDate: { gte: start, lte: end } },
      include: { lines: true, request: true },
      orderBy: { orderDate: "desc" },
      take: 200,
    }),
    prisma.inventoryTransaction.findMany({
      where: { ...branchWhere, transactionType: "RECEIPT", transactionDate: { gte: start, lte: end } },
      include: { lines: true },
      orderBy: { transactionDate: "desc" },
      take: 200,
    }),
    prisma.workItem.findMany({
      where: { ...branchWhere, dueDate: { gte: start, lte: end } },
      orderBy: { dueDate: "asc" },
      take: 200,
    }),
    prisma.assetRecord.findMany({
      where: { ...branchWhere, purchaseDate: { lte: end } },
      orderBy: { purchaseDate: "desc" },
      take: 200,
    }),
  ]);

  const orderDepartmentMap = new Map(purchaseOrders.map((order) => [order.id, order.departmentCode || order.request?.departmentCode || "UNASSIGNED"]));
  const prGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const poGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const receiptGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const workGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();
  const assetGroups = new Map<string, { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number }>();

  const now = new Date();
  const prDetails = purchaseRequests.map((row) => {
    const amount = row.lines.reduce((sum, line) => sum + line.quantity * line.estimatedUnitCost, 0);
    addGroup(prGroups, row.departmentCode || "UNASSIGNED", departmentMap, amount, row.status, !!row.neededDate && row.neededDate < now && !["APPROVED", "ORDERED", "REJECTED"].includes(row.status));
    return { id: row.id, code: row.code, date: row.requestDate, branchCode: row.branchCode, departmentCode: row.departmentCode || "UNASSIGNED", departmentName: departmentLabel(row.departmentCode || "UNASSIGNED", departmentMap), status: row.status, amount, owner: row.requestedBy, note: row.reason };
  });

  const poDetails = purchaseOrders.map((row) => {
    const departmentCode = row.departmentCode || row.request?.departmentCode || "UNASSIGNED";
    addGroup(poGroups, departmentCode, departmentMap, row.totalAmount, row.status, !!row.expectedDate && row.expectedDate < now && !["COMPLETED", "CANCELLED"].includes(row.status));
    return { id: row.id, code: row.code, date: row.orderDate, branchCode: row.branchCode, departmentCode, departmentName: departmentLabel(departmentCode, departmentMap), status: row.status, amount: row.totalAmount, owner: row.supplierName, note: row.warehouseCode };
  });

  const receiptDetails = receipts.map((row) => {
    const amount = row.lines.reduce((sum, line) => sum + line.totalCost, 0);
    const departmentCode = row.referenceType === "PURCHASE_ORDER" && row.referenceId ? orderDepartmentMap.get(row.referenceId) || "UNASSIGNED" : "UNASSIGNED";
    addGroup(receiptGroups, departmentCode, departmentMap, amount, row.status);
    return { id: row.id, code: row.code, date: row.transactionDate, branchCode: row.branchCode, departmentCode, departmentName: departmentLabel(departmentCode, departmentMap), status: row.status, amount, owner: row.warehouseCode, note: row.referenceCode || row.note || "" };
  });

  const workDetails = workItems.map((row) => {
    const overdue = !["COMPLETED", "CANCELLED"].includes(row.status) && row.dueDate < now;
    addGroup(workGroups, row.departmentCode || "UNASSIGNED", departmentMap, 0, row.status, overdue);
    return { id: row.id, code: row.code, date: row.dueDate, branchCode: row.branchCode, departmentCode: row.departmentCode || "UNASSIGNED", departmentName: departmentLabel(row.departmentCode || "UNASSIGNED", departmentMap), status: row.status, amount: 0, owner: row.assigneeName, note: row.title, overdue };
  });

  const assetDetails = assets.map((row) => {
    addGroup(assetGroups, row.departmentCode || "UNASSIGNED", departmentMap, row.currentValue, row.status);
    return { id: row.id, code: row.code, date: row.purchaseDate, branchCode: row.branchCode, departmentCode: row.departmentCode || "UNASSIGNED", departmentName: departmentLabel(row.departmentCode || "UNASSIGNED", departmentMap), status: row.status, amount: row.currentValue, owner: row.supplierName || "", note: row.name };
  });

  const toRows = (groups: typeof prGroups) => Array.from(groups.values()).sort((a, b) => b.count - a.count || b.amount - a.amount);
  const amountOf = (items: Array<{ amount: number }>) => items.reduce((sum, item) => sum + item.amount, 0);

  return {
    period,
    branchCode,
    summary: {
      purchaseRequests: { count: prDetails.length, amount: amountOf(prDetails) },
      purchaseOrders: { count: poDetails.length, amount: amountOf(poDetails) },
      receipts: { count: receiptDetails.length, amount: amountOf(receiptDetails) },
      workItems: { count: workDetails.length, overdue: workDetails.filter((item) => item.overdue).length },
      assets: { count: assetDetails.length, amount: amountOf(assetDetails) },
    },
    groups: {
      purchaseRequests: toRows(prGroups),
      purchaseOrders: toRows(poGroups),
      receipts: toRows(receiptGroups),
      workItems: toRows(workGroups),
      assets: toRows(assetGroups),
    },
    details: {
      purchaseRequests: prDetails,
      purchaseOrders: poDetails,
      receipts: receiptDetails,
      workItems: workDetails,
      assets: assetDetails,
    },
  };
}

const budgetMetrics = [
  { metric: "revenue", label: "Doanh thu", kind: "REVENUE" },
  { metric: "cogs", label: "Giá vốn", kind: "EXPENSE" },
  { metric: "payroll", label: "Chi phí nhân sự", kind: "EXPENSE" },
  { metric: "otherOpex", label: "OPEX khác", kind: "EXPENSE" },
  { metric: "depreciation", label: "Khấu hao", kind: "EXPENSE" },
  { metric: "opexBeforeDepreciation", label: "OPEX trước khấu hao", kind: "EXPENSE" },
  { metric: "ebitda", label: "EBITDA", kind: "PROFIT" },
] as const;

async function getBudgetReport(period: string, branchCode: string) {
  const pnl = await getPnl(period, branchCode);
  const targets = await prisma.reportTarget.findMany({
    where: { period, branchCode },
  });
  const targetMap = new Map(targets.map((target) => [target.metric, target.targetValue]));

  const rows = budgetMetrics.map((item) => {
    const actual = pnl.total[item.metric];
    const target = targetMap.get(item.metric) || 0;
    const variance = actual - target;
    const usageRate = target ? actual / target : null;
    const isGood = item.kind === "REVENUE" || item.kind === "PROFIT" ? variance >= 0 : variance <= 0;
    return { ...item, actual, target, variance, usageRate, isGood };
  });

  return {
    period,
    branchCode,
    rows,
    summary: {
      expenseActual: pnl.total.cogs + pnl.total.payroll + pnl.total.otherOpex + pnl.total.depreciation,
      expenseTarget: rows.filter((row) => row.kind === "EXPENSE").reduce((sum, row) => sum + row.target, 0),
      revenueActual: pnl.total.revenue,
      revenueTarget: targetMap.get("revenue") || 0,
    },
  };
}

// Xem "Cả ngày" phải gộp cả bản ghi ca sáng lẫn ca tối; xem một ca thì chỉ lấy đúng ca đó.
function manualShiftFilter(shift: string) {
  return shift === "FULL" ? {} : { shift };
}

async function getDailyCashReport(period: string, branchCode: string, reportDate: string, shift: string) {
  const { date, start, end } = dayRange(reportDate || `${period}-01`, shift);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T24:00:00`);

  const [revenues, depositHistories, allPaymentVouchers, allReceiptVouchers, moneySources, manualEntries] = await Promise.all([
    prisma.revenueImportRow.findMany({
      where: { ...branchWhere, saleDate: { gte: start, lt: end } },
      orderBy: [{ saleDate: "asc" }, { externalRef: "asc" }],
      take: 1000,
    }),
    prisma.depositHistory.findMany({
      // Dùng đúng ngày phát sinh của từng thao tác. Không đọc Deposit.amount vì số này tăng dần
      // sau mỗi lần bổ sung và sẽ làm toàn bộ tiền bổ sung bị dồn ngược về ngày nhận cọc đầu tiên.
      where: {
        action: { in: ["CREATE", "COLLECT", "SUPPLEMENT", "OFFSET", "REFUND", "TRANSFER_REVENUE", "UPDATE"] },
        OR: [
          { actionDate: { gte: start, lt: end } },
          { actionDate: null, createdAt: { gte: start, lt: end } },
        ],
        // Phiếu cọc đầu kỳ có lịch sử OPENING nên tự bị loại bởi danh sách action ở trên;
        // các lần bổ sung/hoàn phát sinh thật sau đó vẫn phải được đưa vào báo cáo.
        deposit: { is: { ...branchWhere, deletedAt: null } },
      },
      select: {
        id: true,
        action: true,
        amount: true,
        actionDate: true,
        createdAt: true,
        treatmentNote: true,
        voucherId: true,
        deposit: {
          select: {
            code: true,
            partnerName: true,
            moneySourceCode: true,
          },
        },
      },
      orderBy: [{ actionDate: "asc" }, { createdAt: "asc" }],
      take: 1000,
    }),
    prisma.financialVoucher.findMany({
      where: {
        ...branchWhere,
        voucherType: "PAYMENT",
        documentChannel: "CASH",
        voucherDate: { gte: dayStart, lt: dayEnd },
        status: { in: ["APPROVED", "POSTED"] },
        deletedAt: null,
      },
      orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
      take: 500,
    }),
    prisma.financialVoucher.findMany({
      where: {
        ...branchWhere,
        voucherType: "RECEIPT",
        documentChannel: "CASH",
        voucherDate: { gte: dayStart, lt: dayEnd },
        status: { in: ["APPROVED", "POSTED"] },
        deletedAt: null,
      },
      orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
      take: 500,
    }),
    // Báo cáo lịch sử vẫn cần tên/phân loại của nguồn đã ngừng hoạt động.
    prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE" } }),
    prisma.manualRevenueEntry.findMany({
      where: { ...branchWhere, reportDate: { gte: dayStart, lt: dayEnd }, ...manualShiftFilter(shift) },
      orderBy: [{ reportDate: "asc" }, { shift: "asc" }],
    }),
  ]);

  // Phiếu khai ca nào thì thuộc ca đó; phiếu cũ chưa khai vẫn xét theo giờ lập như trước.
  const vouchers = allPaymentVouchers.filter((row) => voucherMatchesShift(row.shift, row.voucherDate, shift));
  const receiptVouchers = allReceiptVouchers.filter((row) => voucherMatchesShift(row.shift, row.voucherDate, shift));

  const sourceByCode = new Map(moneySources.map((source) => [source.code, source]));
  const dailyDepositMovement = summarizeDailyDepositHistories(depositHistories.map((row) => {
    const source = sourceByCode.get(row.deposit.moneySourceCode || "");
    return {
      action: row.action,
      amount: row.amount,
      voucherId: row.voucherId,
      moneySourceGroup: source?.group,
      moneySourceCode: source?.code || row.deposit.moneySourceCode,
      moneySourceName: source?.name,
    };
  }));
  // Ba nguồn doanh thu đổ chung vào một dòng "Doanh thu bán hàng"; vẫn giữ tổng riêng
  // từng nguồn để cảnh báo trùng và để các bảng chi tiết đối chiếu.
  const revenue = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const posRevenue = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const manual = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const receipt = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
  const deposit = { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };

  // Nối nguồn tiền theo cửa hàng CỦA CHÍNH DÒNG đó, không theo bộ lọc của báo cáo. Xem "Tất cả
  // cửa hàng" thì mã rút gọn "MOMO_EDC" có 3 ứng viên (FDS, ASA, KCF) nên không phân định được,
  // và toàn bộ doanh thu ví rơi vào cột "Khác" — đúng lỗi vừa thấy trên màn tổng.
  const matcherByBranch = new Map<string, ReturnType<typeof createMoneySourceMatcher>>();
  const matcherFor = (rowBranch: string) => {
    const key = rowBranch || branchCode;
    const current = matcherByBranch.get(key);
    if (current) return current;
    const created = createMoneySourceMatcher(moneySources, key);
    matcherByBranch.set(key, created);
    return created;
  };
  const posCashByBranch = new Map<string, number>();
  /**
   * Tiền mặt cần nộp tách theo từng nguồn tiền mặt.
   *
   * Một cửa hàng có thể bán qua nhiều quỹ tiền mặt trong cùng một ngày (thu ngân giữ, quản lý
   * giữ). Mỗi quỹ là một số dư độc lập nên phải nộp một phiếu riêng — gộp chung một cục rồi
   * trừ hết vào một quỹ sẽ làm quỹ đó âm còn quỹ kia không bao giờ được clear.
   * Khóa rỗng là phần chưa xác định được nguồn (doanh thu nhập tay, phương thức thanh toán
   * không nối được về danh mục).
   */
  const cashToDepositBySource = new Map<string, number>();
  const addCashToDeposit = (moneySourceCode: string | null | undefined, amount: number) => {
    const key = (moneySourceCode || "").trim();
    cashToDepositBySource.set(key, (cashToDepositBySource.get(key) || 0) + amount);
  };
  for (const row of revenues) {
    const matchSource = matcherFor(row.branchCode);
    const bucketKey = classifyRevenueRow(matchSource, row.paymentMethod, row.revenueSource, row.channel);
    addAmount(posRevenue, bucketKey, row.netAmount);
    addAmount(revenue, bucketKey, row.netAmount);
    if (bucketKey === "cash") {
      posCashByBranch.set(row.branchCode, (posCashByBranch.get(row.branchCode) || 0) + row.netAmount);
      addCashToDeposit(matchSource(row.paymentMethod, row.revenueSource)?.code, row.netAmount);
    }
  }

  // POS là nguồn doanh thu chuẩn. Nhập tay chỉ là phương án dự phòng khi ca/ngày đó
  // chưa có dữ liệu POS; vẫn trả các dòng nhập tay về UI để người dùng thấy cảnh báo và xoá.
  //
  // Xét theo TỪNG cửa hàng. Trước đây chỉ cần một cửa hàng có POS là bỏ hết số nhập tay của mọi
  // cửa hàng: xem "Tất cả cửa hàng" thì NAM MÊ có POS đã nuốt luôn phần khai của ASA, làm cột
  // "Thu ngân khai" thiếu hẳn một cửa hàng trong khi "Đã về" vẫn đủ cả hai -> báo THỪA giả.
  const branchesWithPos = new Set(revenues.map((row) => row.branchCode));
  const effectiveManualEntries = manualEntries.filter((row) => !branchesWithPos.has(row.branchCode));
  for (const row of effectiveManualEntries) {
    for (const [key, value] of [
      ["cash", row.cashAmount],
      ["transfer", row.transferAmount],
      ["card", row.cardAmount],
      ["grab", row.grabAmount],
      ["other", row.otherAmount],
    ] as const) {
      addAmount(manual, key, value);
      addAmount(revenue, key, value);
    }
    // Doanh thu nhập tay chỉ khai theo hình thức thanh toán, không gắn nguồn tiền cụ thể.
    addCashToDeposit("", row.cashAmount);
  }

  // Phiếu thu là chứng từ thu tiền thật trên hệ thống -> xếp theo nhóm nguồn tiền của phiếu.
  const receipts = receiptVouchers.map((row) => {
    const source = sourceByCode.get(row.moneySourceCode || "");
    return {
      id: row.id,
      code: row.code,
      date: row.voucherDate,
      shift: row.shift,
      description: row.description,
      partnerName: row.partnerName,
      status: row.status,
      moneySourceCode: row.moneySourceCode,
      moneySourceName: source ? moneySourceDisplayName(source) : row.moneySourceCode,
      moneySourceGroup: source?.group || null,
      amount: row.amount,
      isCash: normalizeMoneySourceGroup(source?.group) === "CASH",
    };
  });

  // Phiếu thu là dòng tiền độc lập, không mặc định là doanh thu bán hàng. Khoản thu cọc
  // đã được tổng hợp từ bảng Deposit nên không cộng lại vào nhóm "Thu khác".
  for (const row of receiptVouchers) {
    if (["COLLECT", "SUPPLEMENT"].includes(row.depositAction || "")) continue;
    const source = sourceByCode.get(row.moneySourceCode);
    const bucketKey = classifyMoneySource(source?.group);
    addAmount(receipt, bucketKey, row.amount);
    if (bucketKey === "cash") addCashToDeposit(row.moneySourceCode, row.amount);
  }

  // Phiếu thu tiền mặt loại "Thu bán hàng" chính là chứng từ của khoản doanh thu tiền mặt mà file
  // POS đã ghi trong cùng ngày, không phải một khoản doanh thu thứ hai. Cộng cả hai vào dòng
  // "Doanh thu bán hàng" là đếm một khoản tiền hai lần, và số "Tiền mặt cần nộp" cũng gấp đôi
  // số thu ngân thật sự đang giữ. Vẫn giữ nguyên `receipt` cho bảng đối chiếu tiền vào, vì bảng
  // đó cố ý lấy phiếu thu làm số đã xác nhận của tiền mặt.
  //
  // Khử trùng theo TẪT CẢ cửa hàng thì sai: xem "Tất cả cửa hàng", NAM MÊ có POS tiền mặt sẽ kéo
  // theo việc trừ luôn phiếu thu tiền mặt của ASA — mất hẳn 24,8 triệu khỏi ô Tổng thu. Phải xét
  // riêng từng cửa hàng: chỉ cửa hàng nào có POS tiền mặt mới khử phiếu thu tiền mặt của chính nó.
  const salesCashReceiptByBranch = new Map<string, number>();
  const salesCashReceiptRows: Array<{ branchCode: string; moneySourceCode: string; amount: number }> = [];
  for (const row of receiptVouchers) {
    if (["COLLECT", "SUPPLEMENT"].includes(row.depositAction || "")) continue;
    if (!restaurantSalesCategoryCodes.includes(row.categoryCode || "")) continue;
    if (normalizeMoneySourceGroup(sourceByCode.get(row.moneySourceCode)?.group) !== "CASH") continue;
    salesCashReceiptByBranch.set(row.branchCode, (salesCashReceiptByBranch.get(row.branchCode) || 0) + row.amount);
    salesCashReceiptRows.push({ branchCode: row.branchCode, moneySourceCode: row.moneySourceCode, amount: row.amount });
  }
  const branchesWithPosCash = new Set([...posCashByBranch].filter(([, amount]) => amount > 0).map(([branch]) => branch));
  const duplicatedCashReceipts = [...branchesWithPosCash]
    .reduce((sum, branch) => sum + (salesCashReceiptByBranch.get(branch) || 0), 0);
  // Khử trùng cũng phải trừ đúng nguồn tiền của phiếu thu, không trừ vào một cục chung.
  for (const row of salesCashReceiptRows) {
    if (branchesWithPosCash.has(row.branchCode)) addCashToDeposit(row.moneySourceCode, -row.amount);
  }
  const receiptRevenue: DailyCashBucket = {
    ...receipt,
    cash: receipt.cash - duplicatedCashReceipts,
    total: receipt.total - duplicatedCashReceipts,
  };

  for (const key of ["cash", "transfer", "card", "grab", "other"] as const) {
    addAmount(deposit, key, dailyDepositMovement.depositIn[key]);
  }
  for (const [code, amount] of Object.entries(dailyDepositMovement.depositInCashBySource)) {
    addCashToDeposit(code, amount);
  }

  const voucherExpenses = vouchers.map((row) => {
    const source = sourceByCode.get(row.moneySourceCode);
    return {
      id: row.id,
      code: row.code,
      date: row.voucherDate,
      shift: row.shift,
      description: row.description,
      partnerName: row.partnerName,
      moneySourceCode: row.moneySourceCode,
      moneySourceName: source ? moneySourceDisplayName(source) : row.moneySourceCode,
      moneySourceGroup: source?.group || null,
      amount: row.amount,
      isCash: normalizeMoneySourceGroup(source?.group) === "CASH",
    };
  });

  // Hoàn cọc thao tác trực tiếp không sinh FinancialVoucher, nhưng vẫn là tiền ra trong ngày.
  // Lịch sử đã gắn voucher bị loại ở helper vì phiếu chi tương ứng đã có trong voucherExpenses.
  const directDepositRefunds = depositHistories
    .filter((row) => !row.voucherId && (row.action === "REFUND" || (row.action === "UPDATE" && (row.amount || 0) < 0)))
    .map((row) => {
      const source = sourceByCode.get(row.deposit.moneySourceCode || "");
      return {
        id: row.id,
        code: row.deposit.code,
        date: row.actionDate || row.createdAt,
        shift: null,
        description: row.treatmentNote || "Hoàn tiền cọc cho khách",
        partnerName: row.deposit.partnerName,
        moneySourceCode: row.deposit.moneySourceCode || "",
        moneySourceName: source ? moneySourceDisplayName(source) : row.deposit.moneySourceCode,
        moneySourceGroup: source?.group || null,
        amount: Math.abs(row.amount || 0),
        isCash: normalizeMoneySourceGroup(source?.group) === "CASH",
      };
    });
  const expenses = [...voucherExpenses, ...directDepositRefunds];

  const expenseTotal = expenses.reduce((sum, row) => sum + row.amount, 0);
  const cashExpenseTotal = expenses.filter((row) => row.isCash).reduce((sum, row) => sum + row.amount, 0);
  for (const row of expenses) {
    if (row.isCash) addCashToDeposit(row.moneySourceCode, -row.amount);
  }
  // Tổng thu hiển thị đủ dòng tiền nhưng giữ ba bản chất tách biệt: doanh thu,
  // thu khác và tiền cọc. Nhờ đó phiếu thu không làm tăng doanh thu bán hàng.
  const total = {
    total: revenue.total + receiptRevenue.total + deposit.total,
    cash: revenue.cash + receiptRevenue.cash + deposit.cash,
    transfer: revenue.transfer + receiptRevenue.transfer + deposit.transfer,
    card: revenue.card + receiptRevenue.card + deposit.card,
    grab: revenue.grab + receiptRevenue.grab + deposit.grab,
    other: revenue.other + receiptRevenue.other + deposit.other,
  };
  // "Thu ngân khai" ở dòng tiền mặt lấy đúng tổng phiếu thu tiền mặt chi tiết phía dưới
  // cộng phần cọc đã cấn trừ vào bill đúng ngày. Tiền cọc mới nhận thuộc dòng Đặt cọc,
  // còn chi tiền mặt chỉ tham gia công thức Nộp tiền = Thu - Chi; cả hai không được
  // cộng/trừ vào số doanh thu tiền mặt dùng để đối chiếu tiền vào.
  const reconciliationDeclared = {
    total: 0,
    cash: receipt.cash + dailyDepositMovement.offsetDeclared.cash,
    transfer: revenue.transfer - deposit.transfer + dailyDepositMovement.offsetDeclared.transfer,
    card: revenue.card - deposit.card + dailyDepositMovement.offsetDeclared.card,
    grab: revenue.grab - deposit.grab + dailyDepositMovement.offsetDeclared.grab,
    other: revenue.other - deposit.other + dailyDepositMovement.offsetDeclared.other,
  };
  reconciliationDeclared.total = reconciliationDeclared.cash
    + reconciliationDeclared.transfer
    + reconciliationDeclared.card
    + reconciliationDeclared.grab
    + reconciliationDeclared.other;
  const reconciledDepositOffset: DailyCashBucket = {
    total: Object.values(dailyDepositMovement.offsetDeclared).reduce((sum, amount) => sum + amount, 0),
    cash: dailyDepositMovement.offsetDeclared.cash,
    transfer: dailyDepositMovement.offsetDeclared.transfer,
    card: dailyDepositMovement.offsetDeclared.card,
    grab: dailyDepositMovement.offsetDeclared.grab,
    other: dailyDepositMovement.offsetDeclared.other,
  };

  const cashToDeposit = total.cash - cashExpenseTotal;
  // Phần tách theo nguồn phải cộng lại đúng bằng số tổng. Chênh lệch (làm tròn, hoặc luồng
  // tiền chưa gắn được nguồn) dồn vào dòng "chưa xác định" để nhìn thấy, thay vì mất lặng lẽ.
  const attributedCash = [...cashToDepositBySource.values()].reduce((sum, amount) => sum + amount, 0);
  if (Math.abs(cashToDeposit - attributedCash) >= 1) addCashToDeposit("", cashToDeposit - attributedCash);
  const cashToDepositSources = [...cashToDepositBySource]
    .map(([code, amount]) => {
      const source = code ? sourceByCode.get(code) : undefined;
      return {
        code,
        name: source ? moneySourceDisplayName(source) : (code || "Chưa xác định nguồn tiền mặt"),
        amount: Math.round(amount),
      };
    })
    .filter((row) => row.amount !== 0)
    .sort((left, right) => right.amount - left.amount);

  // Phiếu nộp tiền đã lập trong ngày, để màn hình biết quỹ nào đã nộp và quỹ nào còn treo.
  const cashDepositTransfers = await prisma.moneyTransfer.findMany({
    where: {
      ...branchWhere,
      transferPurpose: "CASH_DEPOSIT",
      sourceReportDate: { gte: dayStart, lt: dayEnd },
      status: { in: ["PENDING_REVIEW", "APPROVED"] },
    },
    orderBy: [{ createdAt: "asc" }],
  });

  return {
    period,
    branchCode,
    reportDate: date,
    shift,
    summary: { revenue, posRevenue, manual, receipt, receiptRevenue, deposit, total, expenseTotal, cashExpenseTotal, cashToDeposit },
    cashToDepositSources,
    cashDeposits: cashDepositTransfers.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      sourceShift: row.sourceShift,
      depositTargetType: row.depositTargetType,
      fromMoneySourceCode: row.fromMoneySourceCode,
      toMoneySourceCode: row.toMoneySourceCode,
      amount: row.amount,
      feeAmount: row.feeAmount,
    })),
    expenses,
    receipts,
    manualEntries: manualEntries.map((row) => ({
      id: row.id,
      shift: row.shift,
      branchCode: row.branchCode,
      cashAmount: row.cashAmount,
      transferAmount: row.transferAmount,
      cardAmount: row.cardAmount,
      grabAmount: row.grabAmount,
      otherAmount: row.otherAmount,
      totalAmount: row.totalAmount,
      note: row.note,
      updatedBy: row.updatedBy || row.createdBy,
      updatedAt: row.updatedAt,
    })),
    // Cùng một ngày/ca mà có cả doanh thu import lẫn doanh thu nhập tay thì rất dễ tính trùng.
    // Chỉ cảnh báo khi CÙNG một cửa hàng có cả hai nguồn, vì đó mới là chỗ tính trùng được.
    duplicateRevenueWarning: manualEntries.some((row) => branchesWithPos.has(row.branchCode)),
    moneyInReconciliation: await buildMoneyInReconciliation(
      reconciliationDeclared,
      branchCode,
      dayStart,
      dayEnd,
      new Map(moneySources.map((source) => [source.code, source.group])),
      new Map(moneySources.map((source) => [source.code, `${source.code} ${source.name}`])),
      reconciledDepositOffset,
      receipt.cash + dailyDepositMovement.offsetDeclared.cash,
    ),
  };
}

/**
 * Đối chiếu "tiền vô đã đủ chưa" cho kế toán.
 *
 * Thu ngân khai doanh thu theo hình thức thanh toán; kế toán chỉ biết tiền thật khi
 * sao kê ngân hàng về. Bảng này đặt hai con số cạnh nhau cho từng hình thức:
 * - Chuyển khoản: khai bao nhiêu vs sao kê ngân hàng ghi có bấy nhiêu trong ngày.
 * - Quẹt thẻ/ví: khai bao nhiêu vs số đã quyết toán từ ví về ngân hàng (gồm cả phí),
 *   vì cổng thanh toán thường trả tiền sau vài ngày nên phần chưa về vẫn nằm ở ví.
 * - Tiền mặt: cả số thu ngân khai và số đã xác nhận đều lấy từ các phiếu thu tiền mặt
 *   đã duyệt trong ngày, cộng phần cọc đã cấn trừ vào bill. Đây là quy tắc dùng chung
 *   cho mọi cửa hàng; phiếu chi và cọc mới nhận không tham gia đối soát doanh thu.
 */
async function buildMoneyInReconciliation(
  declared: DailyCashBucket,
  branchCode: string,
  dayStart: Date,
  dayEnd: Date,
  moneySourceGroupByCode: Map<string, string | null>,
  moneySourceLabelByCode: Map<string, string>,
  reconciledDepositOffset: DailyCashBucket,
  confirmedCashReceipts: number,
) {
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };
  const [legacyBankCandidates, bankAllocations, postedBankRows, needsFixRows] = await Promise.all([
    prisma.bankStatementTransaction.findMany({
      where: {
        ...branchWhere,
        creditAmount: { gt: 0 },
        revenueDate: { gte: dayStart, lt: dayEnd },
        categoryCode: { in: restaurantSalesCategoryCodes },
        deletedAt: null,
        // Dữ liệu import mới luôn có allocation, nên chỉ đọc transaction trực tiếp
        // cho dữ liệu lịch sử để không cộng trùng với các dòng phân bổ bên dưới.
        allocations: { none: {} },
      },
      select: {
        creditAmount: true,
        reconcileStatus: true,
        decreaseMoneySourceCode: true,
      },
    }),
    prisma.bankStatementAllocation.findMany({
      where: {
        creditAmount: { gt: 0 },
        revenueDate: { gte: dayStart, lt: dayEnd },
        categoryCode: { in: restaurantSalesCategoryCodes },
        bankTransaction: { is: { ...branchWhere, deletedAt: null } },
      },
      select: {
        creditAmount: true,
        grossAmount: true,
        autoProcessType: true,
        decreaseMoneySourceCode: true,
        bankTransaction: { select: { reconcileStatus: true } },
      },
    }),
    prisma.bankStatementTransaction.findMany({
      where: { ...branchWhere, transactionDate: { gte: dayStart, lt: dayEnd }, creditAmount: { gt: 0 }, deletedAt: null },
      select: { categoryCode: true },
    }),
    // Dòng đã ghi được tiền nhưng chưa lập được chứng từ. Phải hiện ra ở màn dùng hằng ngày, vì
    // một màn riêng thì phải nhớ mới mở — và đó chính là cách 22 phiếu cũ tồn suốt nhiều tuần.
    prisma.bankStatementTransaction.findMany({
      where: {
        ...branchWhere,
        autoProcessType: "MANUAL_REQUIRED",
        deletedAt: null,
        // Chỉ theo ngày giao dịch, không OR thêm ngày doanh thu: ví trả tiền của ngày hôm trước
        // nên một dòng sẽ hiện ở hai ngày, ai cộng qua các ngày là đếm đôi. Ngày doanh thu vẫn
        // được trả về để hiển thị, đủ để biết dòng đó thuộc doanh thu ngày nào.
        transactionDate: { gte: dayStart, lt: dayEnd },
      },
      select: {
        id: true, transactionCode: true, transactionDate: true, revenueDate: true, description: true,
        creditAmount: true, debitAmount: true, autoProcessNote: true,
      },
      orderBy: { transactionDate: "asc" },
      take: 50,
    }),
  ]);

  // SUMIFS trên file sao kê phải chạy theo từng dòng import/phân bổ, đúng Ngày doanh thu
  // và đúng Loại thu bán hàng. Không dùng Ngày giao dịch thay thế khi thiếu Ngày doanh thu.
  const bankCandidates = [
    ...legacyBankCandidates.map((row) => ({ ...row, grossAmount: null as number | null })),
    ...bankAllocations.map((row) => ({
      creditAmount: row.creditAmount,
      grossAmount: row.grossAmount,
      reconcileStatus: row.autoProcessType === "WALLET_SETTLEMENT_PARTIAL"
        ? "MATCHED"
        : row.bankTransaction.reconcileStatus,
      decreaseMoneySourceCode: row.decreaseMoneySourceCode,
    })),
  ];

  // The customer's SUMIFS classifies each imported row by its "Tru nguon tien" column.
  // Do not infer a source from the receiving bank account because wallet settlements also land there.
  const directBankRows = bankCandidates.filter((row) => {
    const decreaseGroup = normalizeMoneySourceGroup(moneySourceGroupByCode.get(row.decreaseMoneySourceCode || ""));
    return decreaseGroup === "BANK";
  });
  const walletRows = bankCandidates.filter((row) => {
    const decreaseGroup = normalizeMoneySourceGroup(moneySourceGroupByCode.get(row.decreaseMoneySourceCode || ""));
    return decreaseGroup === "WALLET";
  });
  // Tiền đã ghi có trên sao kê là tiền đã về, bất kể dòng đó đã được đối soát hay chưa.
  //
  // Trước đây báo cáo chỉ đếm dòng MATCHED, vì luồng cũ bắt kế toán vào màn Đối soát bấm duyệt
  // từng giao dịch. Luồng đó đã bỏ: import sao kê tự đặt MATCHED cho những dòng đủ căn cứ hạch
  // toán, phần còn lại không còn ai bấm duyệt nữa. Giữ bộ lọc MATCHED đồng nghĩa với việc số
  // tiền đó treo vĩnh viễn và biến mất khỏi màn hình dùng hằng ngày — hiện đang là 175,9 triệu
  // của NAM MÊ. Phần chưa đối soát vẫn được trả về riêng để kế toán biết chỗ nào còn dở.
  const bankReceived = directBankRows.reduce((sum, row) => sum + row.creditAmount, 0)
    + reconciledDepositOffset.transfer;

  // Card/wallet is compared at gross value (before fees); legacy rows without grossAmount
  // fall back to the credited amount because no better historical value exists.
  const walletSettled = walletRows
    .reduce((sum, row) => sum + (row.grossAmount ?? row.creditAmount), 0)
    + reconciledDepositOffset.card
    + reconciledDepositOffset.grab;
  // Tiền ví đã về nhưng chưa biết doanh thu gốc là bao nhiêu, nên chưa tách được phí. Đây mới
  // là số đáng hiện: nó nói thẳng phải đi xin file POS ngày nào.
  const walletMissingGross = walletRows
    .filter((row) => row.grossAmount == null)
    .reduce((sum, row) => sum + row.creditAmount, 0);
  const walletFee = walletRows
    .reduce((sum, row) => sum + Math.max(0, (row.grossAmount ?? row.creditAmount) - row.creditAmount), 0);
  // Grab vẫn thuộc nhóm Quẹt thẻ/Ví. Theo nghiệp vụ đã chốt, phần Grab trong chênh lệch
  // gross/net là Chi phí bán hàng Grab; phần phí còn lại là Phí cà thẻ.
  const walletGrabExpense = walletRows
    .filter((row) => normalizeMoneySourceLabel(moneySourceLabelByCode.get(row.decreaseMoneySourceCode || "")).includes("grab"))
    .reduce((sum, row) => sum + Math.max(0, (row.grossAmount ?? row.creditAmount) - row.creditAmount), 0);
  const walletCardFee = Math.max(0, walletFee - walletGrabExpense);
  const rows = [
    { key: "cash", label: "Tiền mặt", declared: declared.cash, received: confirmedCashReceipts, note: "Thu ngân khai và Đã về cùng lấy tổng phiếu thu tiền mặt đã duyệt ở bảng chi tiết phía dưới + cọc cấn trừ vào bill. Không trừ phiếu chi; cọc mới nhận không đi vào đối soát doanh thu." },
    { key: "transfer", label: "Chuyển khoản", declared: declared.transfer, received: bankReceived, note: "Đã về theo SUMIFS sao kê: đúng Ngày doanh thu, loại Thu bán hàng và Trừ nguồn tiền thuộc ngân hàng." },
    { key: "card", label: "Quẹt thẻ / Ví", declared: declared.card + declared.grab, received: walletSettled, note: "Đã về theo SUMIFS sao kê, lấy doanh thu gộp trước phí từ nguồn ví; phí được hiển thị riêng bên dưới." },
  ].map((row) => {
    const difference = row.received - row.declared;
    // Ví trả tiền sau vài ngày, nên thiếu nhiều là "chưa clear" chứ không phải mất tiền; thiếu ít
    // là phần phí thu hộ chưa suy được Gross. Mốc 10% tách hai trường hợp đó.
    const status = Math.abs(difference) < 1000
      ? "MATCHED"
      : difference > 0
        ? "OVER"
        : row.key === "card" && row.declared > 0 && Math.abs(difference) > row.declared * 0.1
          ? "PENDING_CLEAR"
          : "SHORT";
    // Lệch dưới 1.000 đ coi như khớp: chênh lẻ do làm tròn phí, không phải thiếu tiền.
    return { ...row, difference, status };
  });

  return {
    rows,
    walletFee,
    walletGrabExpense,
    walletCardFee,
    walletMissingGross,
    bankRowCount: postedBankRows.length,
    unclassifiedBankRows: postedBankRows.filter((row) => !row.categoryCode).length,
    // Tiền đã vào ngân hàng nhưng chưa có chứng từ. Đã nằm trong cột "Đã về" ở trên; liệt kê riêng để
    // nói rõ phải đi sửa cái gì, không để số tiền nằm im không ai biết.
    needsFix: needsFixRows.map((row) => ({
      id: row.id,
      transactionCode: row.transactionCode,
      date: row.transactionDate,
      revenueDate: row.revenueDate,
      description: row.description,
      amount: Math.round(row.creditAmount || row.debitAmount),
      reason: row.autoProcessNote || "Chưa rõ lý do",
    })),
    needsFixTotal: needsFixRows.reduce((sum, row) => sum + Math.round(row.creditAmount || row.debitAmount), 0),
  };
}

function normalizeMoneySourceLabel(value: string | null | undefined) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function getActivityReport(period: string, branchCode: string) {
  const { start, end } = monthRange(period);
  const branchWhere = branchCode === "ALL" ? {} : { branchCode };

  const [accountingPeriod, periods, auditLogs, importBatches, journalEntries, workHistories] = await Promise.all([
    prisma.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode } } }),
    prisma.accountingPeriod.findMany({
      where: { period, ...(branchCode === "ALL" ? {} : { branchCode }) },
      orderBy: [{ branchCode: "asc" }, { updatedAt: "desc" }],
    }),
    prisma.auditLog.findMany({
      where: {
        occurredAt: { gte: start, lte: end },
        ...(branchCode === "ALL" ? {} : { OR: [{ branchCode }, { branchCode: null }] }),
      },
      orderBy: { occurredAt: "desc" },
      take: 200,
    }),
    prisma.importBatch.findMany({
      where: { createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
    prisma.journalEntry.findMany({
      where: { ...branchWhere, createdAt: { gte: start, lte: end } },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
    prisma.workItemHistory.findMany({
      where: { createdAt: { gte: start, lte: end }, ...(branchCode === "ALL" ? {} : { workItem: { branchCode } }) },
      include: { workItem: true },
      orderBy: { createdAt: "desc" },
      take: 80,
    }),
  ]);

  const logs = [
    ...auditLogs.map((row) => ({
      id: row.id,
      time: row.occurredAt,
      module: row.module,
      action: row.action,
      actor: row.actorName || "-",
      branchCode: row.branchCode || "ALL",
      code: row.entityCode || row.entityId || row.entityType,
      note: row.message || row.entityType,
    })),
    ...importBatches.map((row) => ({
      id: row.id,
      time: row.createdAt,
      module: "IMPORT",
      action: row.status,
      actor: row.uploadedBy,
      branchCode: "ALL",
      code: row.fileName,
      note: `${row.importType} - ${row.totalRows} dòng`,
    })),
    ...journalEntries.map((row) => ({
      id: row.id,
      time: row.createdAt,
      module: "ACCOUNTING",
      action: row.status,
      actor: row.createdBy || "-",
      branchCode: row.branchCode,
      code: row.code,
      note: `${row.sourceType} - ${row.description}`,
    })),
    ...workHistories.map((row) => ({
      id: row.id,
      time: row.createdAt,
      module: "WORKFLOW",
      action: row.action,
      actor: row.actor || "-",
      branchCode: row.workItem.branchCode,
      code: row.workItem.code,
      note: `${row.fromStatus || "-"} -> ${row.toStatus || "-"} ${row.note || ""}`.trim(),
    })),
    ...periods.flatMap((row) => [
      row.closedAt ? {
        id: `${row.id}-closed`,
        time: row.closedAt,
        module: "PERIOD",
        action: "CLOSED",
        actor: row.closedBy || "-",
        branchCode: row.branchCode,
        code: row.period,
        note: "Khóa kỳ kế toán",
      } : null,
      row.reopenedAt ? {
        id: `${row.id}-reopened`,
        time: row.reopenedAt,
        module: "PERIOD",
        action: "REOPENED",
        actor: row.reopenedBy || "-",
        branchCode: row.branchCode,
        code: row.period,
        note: row.reason || "Mở lại kỳ kế toán",
      } : null,
    ]).filter((row): row is { id: string; time: Date; module: string; action: string; actor: string; branchCode: string; code: string; note: string } => row !== null),
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 160);

  return {
    period,
    branchCode,
    accountingPeriod: accountingPeriod || { period, branchCode, status: "OPEN", reason: null, closedBy: null, closedAt: null, reopenedBy: null, reopenedAt: null },
    periods,
    logs,
  };
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, menuHref);
    if (!auth.ok) return auth.response;
    if (!canViewFinancialDashboard(auth.session.role)) {
      return NextResponse.json({ error: "Bạn không có quyền xem Dashboard/Báo cáo tài chính" }, { status: 403 });
    }
    const params = new URL(request.url).searchParams;
    const type = cleanText(params.get("type")) || "dashboard";
    const period = normalizePeriod(params.get("period")) || new Date().toISOString().slice(0, 7);
    const branchCode = requestedBranch(auth.session, cleanText(params.get("branchCode")) || "ALL");

    // Ẩn tab ở giao diện là chưa đủ: gõ thẳng URL vẫn lấy được số liệu nếu API không chặn.
    // Riêng tab Tiền về đủ chưa mượn số liệu thu chi ngày cho bảng "Đối chiếu tiền vào đã
    // đủ chưa" (chuyển từ tab Thu chi ngày sang 22/08/2026), nên quyền tab đó mở luôn
    // được type=daily-cash.
    const permittedTabs = allowedMenuTabs(auth.session, menuHref);
    const effectiveType = type === "daily-cash" && permittedTabs?.includes("revenue-settlement") ? "revenue-settlement" : type;
    if (permittedTabs && !permittedTabs.includes(type) && !permittedTabs.includes(effectiveType)) {
      return NextResponse.json({ error: "Bạn không có quyền xem báo cáo này" }, { status: 403 });
    }
    if (type === "operations") return NextResponse.json(await getOperationsReport(period, branchCode));
    if (type === "budget") return NextResponse.json(await getBudgetReport(period, branchCode));
    if (type === "daily-cash") return NextResponse.json(await getDailyCashReport(period, branchCode, cleanText(params.get("reportDate")) || `${period}-01`, cleanText(params.get("shift")) || "FULL"));
    if (type === "activity") return NextResponse.json(await getActivityReport(period, branchCode));
    if (type === "pnl") return NextResponse.json({ period, branchCode, ...(await getPnl(period, branchCode)) });
    if (type === "yoy") {
      const previousPeriod = `${Number(period.slice(0, 4)) - 1}${period.slice(4)}`;
      const [current, previous] = await Promise.all([getPnl(period, branchCode), getPnl(previousPeriod, branchCode)]);
      const metrics = ["revenue", "cogs", "grossProfit", "opexBeforeDepreciation", "ebitda", "netProfit"] as const;
      return NextResponse.json({ period, previousPeriod, branchCode, rows: metrics.map((metric) => { const currentValue = current.total[metric]; const previousValue = previous.total[metric]; return { metric, currentValue, previousValue, variance: currentValue - previousValue, varianceRate: previousValue ? (currentValue - previousValue) / Math.abs(previousValue) : null }; }) });
    }
    if (type === "cash-source") {
      // Xem theo năm thì trải 12 tháng của năm đang chọn, xem theo tháng thì chỉ một kỳ.
      const view = cleanText(params.get("view")) === "year" ? "year" : "month";
      const year = period.slice(0, 4);
      const months = view === "year"
        ? Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`)
        : [period];
      return NextResponse.json({ period, view, year, ...(await getCashSourceReport(months, branchCode)) });
    }
    if (type === "revenue-settlement") return NextResponse.json(await getRevenueSettlementReport(period, branchCode));
    if (type === "cashflow") return NextResponse.json({ period, branchCode, ...(await getCashflowForecast(period, branchCode, cleanText(params.get("scenario")) || "BASE")) });
    if (type === "balance") return NextResponse.json({ period, branchCode, ...(await getBalanceSheet(period, branchCode)) });
    const [pnl, trend, balance, targets] = await Promise.all([getPnl(period, branchCode), getTrend(period, branchCode), getBalanceSheet(period, branchCode), prisma.reportTarget.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { branchCode }) } })]);
    return NextResponse.json({ period, branchCode, pnl, trend, balance, targets });
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, menuHref, "create");
    if (!auth.ok) return auth.response;
    const body = await request.json();
    const action = cleanText(body.action);
    const period = normalizePeriod(body.period);
    const branchCode = requestedBranch(auth.session, cleanText(body.branchCode));
    if (!period || !branchCode) businessError("Thiếu kỳ hoặc chi nhánh");

    // Thu ngân kết ca tự nhập doanh thu khi chưa kịp import file POS.
    if (action === "UPSERT_MANUAL_REVENUE") {
      const reportDateText = cleanText(body.reportDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDateText)) businessError("Ngày báo cáo không hợp lệ.");
      const shift = (cleanText(body.shift) || "FULL").toUpperCase();
      if (!["FULL", "MORNING", "EVENING"].includes(shift)) businessError("Ca làm việc không hợp lệ.");
      if (branchCode === "ALL") businessError("Chọn một cửa hàng cụ thể trước khi nhập doanh thu.");

      const reportDate = new Date(`${reportDateText}T00:00:00`);
      if (await isPeriodLocked(reportDate, branchCode)) {
        businessError(`Kỳ kế toán của ngày ${reportDateText} đã chốt sổ, không nhập thêm doanh thu được.`);
      }

      const amounts = {
        cashAmount: toNumber(body.cashAmount),
        transferAmount: toNumber(body.transferAmount),
        cardAmount: toNumber(body.cardAmount),
        grabAmount: toNumber(body.grabAmount),
        otherAmount: toNumber(body.otherAmount),
      };
      if (Object.values(amounts).some((value) => value < 0)) businessError("Số tiền không được âm.");
      const totalAmount = Object.values(amounts).reduce((sum, value) => sum + value, 0);
      if (totalAmount <= 0) businessError("Phải nhập ít nhất một khoản tiền lớn hơn 0.");

      // Nhập "Cả ngày" rồi lại nhập từng ca (hoặc ngược lại) sẽ cộng trùng khi xem báo cáo.
      const conflictShifts = shift === "FULL" ? ["MORNING", "EVENING"] : ["FULL"];
      const conflict = await prisma.manualRevenueEntry.findFirst({
        where: { branchCode, reportDate, shift: { in: conflictShifts } },
      });
      if (conflict) {
        const conflictLabel = conflict.shift === "FULL" ? "Cả ngày" : conflict.shift === "MORNING" ? "Ca sáng" : "Ca tối";
        businessError(
          shift === "FULL"
            ? `Ngày này đã có doanh thu nhập tay cho ${conflictLabel}. Hãy sửa bản ghi theo ca thay vì nhập thêm cho cả ngày.`
            : `Ngày này đã có doanh thu nhập tay cho ${conflictLabel}. Hãy sửa bản ghi đó thay vì nhập thêm theo ca.`
        );
      }

      const result = await prisma.manualRevenueEntry.upsert({
        where: { branchCode_reportDate_shift: { branchCode, reportDate, shift } },
        create: { branchCode, reportDate, shift, ...amounts, totalAmount, note: cleanText(body.note) || null, createdBy: auth.session.name, updatedBy: auth.session.name },
        update: { ...amounts, totalAmount, note: cleanText(body.note) || null, updatedBy: auth.session.name },
      });

      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "UPSERT_MANUAL_REVENUE",
        entityType: "ManualRevenueEntry",
        entityId: result.id,
        entityCode: `${reportDateText}-${branchCode}-${shift}`,
        branchCode,
        metadata: { reportDate: reportDateText, shift, ...amounts, totalAmount },
      });
      return NextResponse.json(result);
    }

    if (action === "DELETE_MANUAL_REVENUE") {
      const entryId = cleanText(body.entryId);
      if (!entryId) businessError("Thiếu bản ghi cần xoá.");
      const existing = await prisma.manualRevenueEntry.findUnique({ where: { id: entryId } });
      if (!existing) businessError("Không tìm thấy bản ghi doanh thu nhập tay.");
      if (branchCode !== "ALL" && existing.branchCode !== branchCode) businessError("Bản ghi không thuộc cửa hàng đã chọn.");
      if (await isPeriodLocked(existing.reportDate, existing.branchCode)) {
        businessError("Kỳ kế toán của bản ghi này đã chốt sổ, không xoá được.");
      }

      await prisma.manualRevenueEntry.delete({ where: { id: entryId } });
      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "DELETE_MANUAL_REVENUE",
        entityType: "ManualRevenueEntry",
        entityId: existing.id,
        entityCode: `${existing.reportDate.toISOString().slice(0, 10)}-${existing.branchCode}-${existing.shift}`,
        branchCode: existing.branchCode,
        metadata: { totalAmount: existing.totalAmount },
      });
      return NextResponse.json({ ok: true });
    }

    if (!canViewFinancialDashboard(auth.session.role)) {
      return NextResponse.json({ error: "Bạn không có quyền cấu hình báo cáo tài chính" }, { status: 403 });
    }
    if (action === "UPSERT_FORECAST") {
      const result = await prisma.forecastAssumption.upsert({
        where: { period_branchCode_scenario_assumptionType: { period, branchCode, scenario: cleanText(body.scenario) || "BASE", assumptionType: cleanText(body.assumptionType) || "INFLOW" } },
        create: { period, branchCode, scenario: cleanText(body.scenario) || "BASE", assumptionType: cleanText(body.assumptionType) || "INFLOW", amount: toNumber(body.amount), note: cleanText(body.note) || null, createdBy: auth.session.name },
        update: { amount: toNumber(body.amount), note: cleanText(body.note) || null, createdBy: auth.session.name },
      });
      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "UPSERT_FORECAST",
        entityType: "ForecastAssumption",
        entityId: result.id,
        entityCode: `${result.period}-${result.scenario}-${result.assumptionType}`,
        branchCode,
        metadata: { period, scenario: result.scenario, assumptionType: result.assumptionType, amount: result.amount },
      });
      return NextResponse.json(result);
    }
    if (action === "UPSERT_TARGET") {
      const metric = cleanText(body.metric);
      if (!metric) businessError("Thiếu chỉ tiêu KPI");
      const result = await prisma.reportTarget.upsert({ where: { period_branchCode_metric: { period, branchCode, metric } }, create: { period, branchCode, metric, targetValue: toNumber(body.targetValue) }, update: { targetValue: toNumber(body.targetValue) } });
      await writeAuditLog({
        session: auth.session,
        module: "REPORTS",
        action: "UPSERT_TARGET",
        entityType: "ReportTarget",
        entityId: result.id,
        entityCode: `${result.period}-${result.metric}`,
        branchCode,
        metadata: { period, metric, targetValue: result.targetValue },
      });
      return NextResponse.json(result);
    }
    businessError("Thao tác báo cáo không hợp lệ");
  } catch (error) {
    const result = apiError(error);
    return NextResponse.json({ error: result.message }, { status: result.status });
  }
}
