import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { pnlLineKeyOf, type PnlItemRef, type PnlLineKey } from "@/lib/reports";
import { comparePnlItems } from "@/lib/pnl-ordering";

/**
 * Tổng hợp chi phí của một kỳ cho tab "Tổng hợp chi phí" trên màn Sổ quỹ.
 *
 * Chi phí được nhập rải rác ở nhiều màn (phiếu chi, chứng từ ngân hàng, lương, khấu hao,
 * trích trước, điều chuyển chi phí, kho...) nhưng mọi nguồn đều kết thúc bằng bút toán
 * ghi Nợ tài khoản chi phí (COGS / OPEX / OTHER_EXPENSE). Tab này chỉ ĐỌC lại sổ nhật ký
 * và nhóm theo nguồn phát sinh + hạng mục P&L; việc nhập/sửa vẫn ở màn gốc vì mỗi loại
 * có luật riêng (phiếu chi chạm quỹ, khấu hao chạm tài sản, lương sinh phải trả).
 *
 * Con số "đã vào sổ" ở đây đúng bằng phần chi phí trên báo cáo KQKD cùng kỳ/cửa hàng
 * (cùng nguồn JournalLine, cùng luật xếp dòng pnlLineKeyOf). Phần "chờ hạch toán" liệt kê
 * những bản ghi gốc đã có nhưng chưa thành bút toán, để người xem hiểu vì sao hai số lệch.
 */

const EXPENSE_ACCOUNT_TYPES = new Set(["COGS", "OPEX", "OTHER_EXPENSE"]);

export type ExpenseSourceRow = { key: string; label: string; hint: string; href: string; entries: number; amount: number };
export type ExpenseItemRow = { code: string; name: string; amount: number };
export type ExpenseLineRow = { key: PnlLineKey; label: string; amount: number; items: ExpenseItemRow[] };
export type ExpensePendingRow = { key: string; label: string; hint: string; href: string; count: number; amount: number };
export type ExpenseSummary = {
  period: string;
  branchCode: string;
  postedTotal: number;
  pendingTotal: number;
  bySource: ExpenseSourceRow[];
  byLine: ExpenseLineRow[];
  pending: ExpensePendingRow[];
};

export const EXPENSE_LINE_LABELS: Record<PnlLineKey, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn hàng bán",
  payroll: "Chi phí nhân sự",
  depreciation: "Chi phí khấu hao",
  otherOpex: "Chi phí vận hành khác",
  otherIncome: "Thu nhập khác",
  otherExpense: "Chi phí khác",
};
const EXPENSE_LINE_ORDER: PnlLineKey[] = ["cogs", "payroll", "depreciation", "otherOpex", "otherExpense"];

type SourceGroup = { key: string; label: string; hint: string; href: (branchCode: string) => string };

const branchQuery = (branchCode: string, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams(extra);
  if (branchCode !== "ALL") params.set("branchCode", branchCode);
  const query = params.toString();
  return query ? `?${query}` : "";
};

/** Nguồn phát sinh -> màn hình gốc để sửa. Nhãn mới thêm chưa khai ở đây rơi vào "Khác". */
const SOURCE_GROUPS: Record<string, SourceGroup> = {
  VOUCHER_CASH: { key: "VOUCHER_CASH", label: "Phiếu chi tiền mặt", hint: "Phiếu chi đã duyệt, hạch toán theo khoản mục / hạng mục P&L", href: (b) => `/vouchers${branchQuery(b, { voucherType: "PAYMENT" })}` },
  VOUCHER_BANK: { key: "VOUCHER_BANK", label: "Chứng từ ngân hàng", hint: "Phiếu chi qua tài khoản ngân hàng đã duyệt", href: (b) => `/bank-vouchers${branchQuery(b)}` },
  MONEY_TRANSFER: { key: "MONEY_TRANSFER", label: "Phí điều tiền / quyết toán ví", hint: "Chi phí bán hàng Grab, phí quẹt thẻ, chênh lệch làm tròn khi nộp tiền", href: () => "/finance-operations?tab=cashbook" },
  ACCRUAL: { key: "ACCRUAL", label: "Trích trước & phân bổ", hint: "Lịch phân bổ chi phí trả trước đã ghi nhận trong kỳ", href: () => "/finance-operations?tab=accruals" },
  DEPRECIATION: { key: "DEPRECIATION", label: "Khấu hao tài sản", hint: "Khấu hao đã chạy cho kỳ này", href: () => "/assets/operations" },
  PAYROLL: { key: "PAYROLL", label: "Lương nhân sự", hint: "Bảng lương đã import cho kỳ này", href: () => "/imports?tab=payroll" },
  COST_REALLOCATION: { key: "COST_REALLOCATION", label: "Điều chuyển chi phí liên nhà hàng", hint: "Nhà hàng nhận chi phí tăng, nhà hàng gánh hộ giảm", href: () => "/cost-reallocations" },
  INVENTORY: { key: "INVENTORY", label: "Xuất kho / hủy hàng", hint: "Giá vốn xuất kho và hàng hủy đã vào sổ", href: () => "/inventory" },
  ASSET: { key: "ASSET", label: "Sửa chữa / thanh lý tài sản", hint: "Chi phí phát sinh từ nghiệp vụ tài sản", href: () => "/assets/operations" },
  REVENUE_POS: { key: "REVENUE_POS", label: "Phí kèm doanh thu POS", hint: "Chi phí tách ra khi ghi nhận doanh thu POS", href: () => "/imports" },
  MANUAL: { key: "MANUAL", label: "Bút toán tay", hint: "Kế toán ghi trực tiếp trên Sổ cái", href: () => "/accounting" },
  OTHER: { key: "OTHER", label: "Nguồn khác", hint: "Bút toán chi phí từ nguồn chưa đặt tên riêng", href: () => "/accounting" },
};

function sourceGroupOf(sourceType: string, voucherChannel: string | undefined): SourceGroup {
  if (sourceType === "VOUCHER" || sourceType === "IMPORT") return voucherChannel === "BANK" ? SOURCE_GROUPS.VOUCHER_BANK : SOURCE_GROUPS.VOUCHER_CASH;
  if (sourceType.startsWith("MONEY_TRANSFER")) return SOURCE_GROUPS.MONEY_TRANSFER;
  if (sourceType.startsWith("COST_REALLOCATION")) return SOURCE_GROUPS.COST_REALLOCATION;
  if (sourceType.startsWith("INVENTORY")) return SOURCE_GROUPS.INVENTORY;
  if (sourceType.startsWith("ASSET")) return SOURCE_GROUPS.ASSET;
  return SOURCE_GROUPS[sourceType] || SOURCE_GROUPS.OTHER;
}

const round = (value: number) => Math.round(value);

export async function getExpenseSummary(period: string, branchCode: string): Promise<ExpenseSummary> {
  const { start, end } = periodBounds(period);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const [entries, pnlItems, pnlGroups, draftVouchers, approvedVouchers, plannedSchedules, depreciations, payrollRows] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { entryDate: { gte: start, lt: end }, status: "POSTED", ...branchFilter },
      select: { sourceType: true, sourceId: true, lines: { select: { debit: true, credit: true, pnlItemCode: true, account: { select: { accountType: true, reportGroup: true } } } } },
    }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true, subGroup: true } }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_GROUP" }, select: { code: true, name: true } }),
    // Phiếu chi còn nháp: chưa duyệt nên chưa có bút toán. Chỉ đếm phiếu ghi nhận nghiệp vụ
    // mới; phiếu SETTLEMENT (sao kê khớp doanh thu) không bao giờ thành chi phí.
    prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherType: "PAYMENT", businessEffect: "RECOGNITION", voucherDate: { gte: start, lt: end }, status: { not: "APPROVED" } }, select: { amount: true } }),
    prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherType: "PAYMENT", businessEffect: "RECOGNITION", voucherDate: { gte: start, lt: end }, status: "APPROVED" }, select: { id: true, amount: true, documentChannel: true } }),
    prisma.accrualSchedule.findMany({ where: { period, status: "PLANNED", ...(branchCode === "ALL" ? {} : { accrual: { branchCode } }) }, select: { amount: true } }),
    prisma.assetDepreciation.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { asset: { branchCode } }) }, select: { id: true, depreciationAmount: true } }),
    prisma.payrollImportRow.findMany({ where: { period, ...branchFilter }, select: { id: true, baseSalary: true, allowanceAmount: true, bonusAmount: true } }),
  ]);

  const pnlItemByCode = new Map(pnlItems.map((item) => [item.code, item]));
  const pnlGroupName = new Map(pnlGroups.map((group) => [group.code, group.name]));
  const pnlItemRefOf = (code: string | null): PnlItemRef => {
    const item = code ? pnlItemByCode.get(code) : null;
    if (!item) return null;
    return { name: item.name, groupName: item.subGroup ? pnlGroupName.get(item.subGroup) || null : null };
  };
  // Phiếu chi tiền mặt và chứng từ ngân hàng cùng mang nhãn VOUCHER trên sổ; tách theo kênh
  // của phiếu gốc để mỗi dòng trỏ đúng màn hình sửa.
  const voucherChannelById = new Map(approvedVouchers.map((row) => [row.id, row.documentChannel]));
  const postedSourceIds = new Set(entries.map((entry) => `${entry.sourceType}:${entry.sourceId}`));

  const sourceTotals = new Map<string, { entries: number; amount: number }>();
  const lineTotals = new Map<PnlLineKey, { amount: number; items: Map<string, ExpenseItemRow> }>();
  let postedTotal = 0;
  for (const entry of entries) {
    const group = sourceGroupOf(entry.sourceType, voucherChannelById.get(entry.sourceId));
    let entryAmount = 0;
    for (const line of entry.lines) {
      if (!EXPENSE_ACCOUNT_TYPES.has(line.account.accountType)) continue;
      const amount = line.debit - line.credit;
      if (amount === 0) continue;
      const lineKey = pnlLineKeyOf(line.account, pnlItemRefOf(line.pnlItemCode));
      if (!lineKey) continue;
      entryAmount += amount;
      const bucket = lineTotals.get(lineKey) || { amount: 0, items: new Map<string, ExpenseItemRow>() };
      bucket.amount += amount;
      const code = line.pnlItemCode || "UNCLASSIFIED";
      const item = bucket.items.get(code) || { code, name: pnlItemByCode.get(code)?.name || (line.pnlItemCode ? `Hạng mục P&L [${line.pnlItemCode}]` : "Chưa phân loại hạng mục P&L"), amount: 0 };
      item.amount += amount;
      bucket.items.set(code, item);
      lineTotals.set(lineKey, bucket);
    }
    if (entryAmount === 0) continue;
    postedTotal += entryAmount;
    const current = sourceTotals.get(group.key) || { entries: 0, amount: 0 };
    current.entries += 1;
    current.amount += entryAmount;
    sourceTotals.set(group.key, current);
  }

  const bySource: ExpenseSourceRow[] = Object.values(SOURCE_GROUPS)
    .filter((group) => sourceTotals.has(group.key))
    .map((group) => {
      const total = sourceTotals.get(group.key)!;
      return { key: group.key, label: group.label, hint: group.hint, href: group.href(branchCode), entries: total.entries, amount: round(total.amount) };
    })
    .sort((a, b) => b.amount - a.amount);

  const byLine: ExpenseLineRow[] = EXPENSE_LINE_ORDER
    .filter((key) => lineTotals.has(key))
    .map((key) => {
      const bucket = lineTotals.get(key)!;
      const items = Array.from(bucket.items.values())
        .map((item) => ({ ...item, amount: round(item.amount), last: item.code === "UNCLASSIFIED" }))
        .sort((a, b) => comparePnlItems(a, b))
        .map((item) => ({ code: item.code, name: item.name, amount: item.amount }));
      return { key, label: EXPENSE_LINE_LABELS[key], amount: round(bucket.amount), items };
    });

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const unpostedApproved = approvedVouchers.filter((row) => !postedSourceIds.has(`VOUCHER:${row.id}`));
  const unpostedDepreciation = depreciations.filter((row) => !postedSourceIds.has(`DEPRECIATION:${row.id}`));
  const unpostedPayroll = payrollRows.filter((row) => !postedSourceIds.has(`PAYROLL:${row.id}`));
  const pendingCandidates: ExpensePendingRow[] = [
    { key: "VOUCHER_DRAFT", label: "Phiếu chi chưa duyệt", hint: "Phiếu chi còn nháp / chờ duyệt; duyệt xong mới thành chi phí", href: SOURCE_GROUPS.VOUCHER_CASH.href(branchCode), count: draftVouchers.length, amount: round(sum(draftVouchers.map((row) => row.amount))) },
    { key: "VOUCHER_UNPOSTED", label: "Phiếu chi đã duyệt nhưng chưa ghi sổ", hint: "Chạy hạch toán kỳ trên Sổ cái để đưa vào bút toán", href: "/accounting", count: unpostedApproved.length, amount: round(sum(unpostedApproved.map((row) => row.amount))) },
    { key: "ACCRUAL_PLANNED", label: "Lịch phân bổ chờ ghi nhận", hint: "Bấm ghi nhận từng kỳ ở tab Trích trước & Phân bổ", href: "/finance-operations?tab=accruals", count: plannedSchedules.length, amount: round(sum(plannedSchedules.map((row) => row.amount))) },
    { key: "DEPRECIATION_UNPOSTED", label: "Khấu hao đã chạy nhưng chưa ghi sổ", hint: "Chạy hạch toán kỳ trên Sổ cái", href: "/accounting", count: unpostedDepreciation.length, amount: round(sum(unpostedDepreciation.map((row) => row.depreciationAmount))) },
    { key: "PAYROLL_UNPOSTED", label: "Bảng lương đã import nhưng chưa ghi sổ", hint: "Chạy hạch toán kỳ trên Sổ cái", href: "/accounting", count: unpostedPayroll.length, amount: round(sum(unpostedPayroll.map((row) => row.baseSalary + row.allowanceAmount + row.bonusAmount))) },
  ];
  const pending = pendingCandidates.filter((row) => row.count > 0);

  return {
    period,
    branchCode,
    postedTotal: round(postedTotal),
    pendingTotal: round(sum(pending.map((row) => row.amount))),
    bySource,
    byLine,
    pending,
  };
}
