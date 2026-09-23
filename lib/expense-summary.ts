import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { createPnlItemRefLookup, depreciationCatalogItemCode, payrollCatalogItemCode, pnlLineKeyOf, resolvePnlItemCode, type PnlLineKey } from "@/lib/reports";
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
 * Tab này chỉ nhận chi phí ĐÃ GÁN HẠNG MỤC P&L. Dòng chi chưa phân loại mới chỉ là một
 * khoản chi tiền, chưa biết thuộc dòng chi phí nào, để lẫn vào đây thì bảng phân bổ bị thổi
 * bằng chính tiền chưa phân loại. Số bị loại ra vẫn trả về ở `unclassifiedTotal` để màn hình
 * nói rõ còn bao nhiêu chờ phân loại chứ không giấu đi.
 *
 * Phần "chờ hạch toán" liệt kê những bản ghi gốc đã có nhưng chưa thành bút toán, để người
 * xem hiểu vì sao số trên tab này và số bản ghi gốc lệch nhau.
 */

const EXPENSE_ACCOUNT_TYPES = new Set(["COGS", "OPEX", "OTHER_EXPENSE"]);

export type ExpenseSourceRow = { key: string; label: string; hint: string; href: string; entries: number; amount: number };
export type ExpenseItemRow = { code: string; name: string; amount: number };
export type ExpenseLineRow = { key: PnlLineKey; label: string; amount: number; items: ExpenseItemRow[] };
export type ExpensePendingRow = { key: string; label: string; hint: string; href: string; count: number; amount: number };
/**
 * Một dòng Nợ tài khoản chi phí trên sổ nhật ký, kèm đủ nhãn để bảng chi tiết lọc được theo
 * loại phiếu (nguồn phát sinh) và hạng mục P&L. Cộng hết `details` ra đúng postedTotal.
 */
export type ExpenseDetailRow = {
  id: string;
  entryCode: string;
  date: string;
  sourceKey: string;
  sourceLabel: string;
  sourceCode: string | null;
  href: string;
  description: string;
  lineKey: PnlLineKey;
  lineLabel: string;
  itemCode: string;
  itemName: string;
  accountCode: string;
  accountName: string;
  partnerCode: string | null;
  departmentCode: string | null;
  amount: number;
};
export type ExpenseSummary = {
  period: string;
  branchCode: string;
  postedTotal: number;
  pendingTotal: number;
  /** Chi phí đã vào sổ nhưng chưa gán hạng mục P&L — không nằm trong postedTotal. */
  unclassifiedTotal: number;
  unclassifiedLines: number;
  bySource: ExpenseSourceRow[];
  byLine: ExpenseLineRow[];
  pending: ExpensePendingRow[];
  details: ExpenseDetailRow[];
};

export const EXPENSE_LINE_LABELS: Record<PnlLineKey, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn hàng bán",
  payroll: "Chi phí nhân sự",
  otherOpex: "Chi phí vận hành (OPEX, gồm khấu hao)",
  otherIncome: "Thu nhập khác",
  otherExpense: "Chi phí khác",
  capex: "Chi phí đầu tư ban đầu",
};
const EXPENSE_LINE_ORDER: PnlLineKey[] = ["cogs", "payroll", "otherOpex", "otherExpense"];

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
  DEBT_PAYABLE: { key: "DEBT_PAYABLE", label: "Công nợ phải trả", hint: "Chi phí đã phát sinh, ghi nhận bên Công nợ Đối tác và chưa trả tiền", href: () => "/debts" },
  INVENTORY: { key: "INVENTORY", label: "Xuất kho / hủy hàng", hint: "Giá vốn xuất kho và hàng hủy đã vào sổ", href: () => "/inventory" },
  ASSET: { key: "ASSET", label: "Sửa chữa / thanh lý tài sản", hint: "Chi phí phát sinh từ nghiệp vụ tài sản", href: () => "/assets/operations" },
  REVENUE_POS: { key: "REVENUE_POS", label: "Phí kèm doanh thu POS", hint: "Chi phí tách ra khi ghi nhận doanh thu POS", href: () => "/imports" },
  MANUAL: { key: "MANUAL", label: "Bút toán tay", hint: "Kế toán ghi trực tiếp trên Sổ cái", href: () => "/accounting" },
  OTHER: { key: "OTHER", label: "Nguồn khác", hint: "Bút toán chi phí từ nguồn chưa đặt tên riêng", href: () => "/accounting" },
};

function sourceGroupOf(sourceType: string, voucherChannel: string | undefined): SourceGroup {
  if (sourceType === "VOUCHER" || sourceType === "IMPORT") return voucherChannel === "BANK" ? SOURCE_GROUPS.VOUCHER_BANK : SOURCE_GROUPS.VOUCHER_CASH;
  // PAYROLL (mẫu theo nhân viên) và PAYROLL_DEPARTMENT (mẫu theo bộ phận) cùng là lương.
  if (sourceType.startsWith("PAYROLL")) return SOURCE_GROUPS.PAYROLL;
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
  const [entries, pnlItems, pnlGroups, draftVouchers, approvedVouchers, plannedSchedules, depreciations, payrollRows, payrollDeptRows, manualPayables] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { entryDate: { gte: start, lt: end }, status: "POSTED", ...branchFilter },
      select: {
        id: true,
        code: true,
        entryDate: true,
        sourceType: true,
        sourceId: true,
        sourceCode: true,
        description: true,
        lines: {
          select: {
            id: true,
            debit: true,
            credit: true,
            pnlItemCode: true,
            description: true,
            partnerCode: true,
            departmentCode: true,
            account: { select: { code: true, name: true, accountType: true, reportGroup: true } },
          },
        },
      },
      orderBy: [{ entryDate: "asc" }, { code: "asc" }],
    }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true, group: true, subGroup: true, status: true } }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_GROUP" }, select: { code: true, name: true, group: true } }),
    // Phiếu chi còn nháp: chưa duyệt nên chưa có bút toán. Chỉ đếm phiếu ghi nhận nghiệp vụ
    // mới; phiếu SETTLEMENT (sao kê khớp doanh thu) không bao giờ thành chi phí.
    prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherType: "PAYMENT", businessEffect: "RECOGNITION", voucherDate: { gte: start, lt: end }, status: { not: "APPROVED" } }, select: { amount: true } }),
    prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherType: "PAYMENT", businessEffect: "RECOGNITION", voucherDate: { gte: start, lt: end }, status: "APPROVED" }, select: { id: true, amount: true, documentChannel: true } }),
    prisma.accrualSchedule.findMany({ where: { period, status: "PLANNED", ...(branchCode === "ALL" ? {} : { accrual: { branchCode } }) }, select: { amount: true } }),
    prisma.assetDepreciation.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { asset: { branchCode } }) }, select: { id: true, depreciationAmount: true } }),
    prisma.payrollImportRow.findMany({ where: { period, ...branchFilter }, select: { id: true, baseSalary: true, allowanceAmount: true, bonusAmount: true } }),
    prisma.payrollDepartmentRow.findMany({ where: { period, ...branchFilter }, select: { id: true, totalCompanyCost: true } }),
    // Công nợ phải trả khai tay là chi phí đã phát sinh; chỉ thành bút toán sau khi Đồng bộ ghi
    // sổ, nên khoản chưa ghi sổ phải hiện ở khối chờ hạch toán chứ không im lặng biến mất.
    prisma.debtRecord.findMany({ where: { ...branchFilter, debtType: "PAYABLE", sourceType: "MANUAL", documentDate: { gte: start, lt: end } }, select: { id: true, originalAmount: true } }),
  ]);

  const pnlItemByCode = new Map(pnlItems.map((item) => [item.code, item]));
  const depreciationItemCode = depreciationCatalogItemCode(pnlItems);
  const payrollItemCode = payrollCatalogItemCode(pnlItems);
  const pnlItemRefOf = createPnlItemRefLookup(pnlItems, pnlGroups);
  // Phiếu chi tiền mặt và chứng từ ngân hàng cùng mang nhãn VOUCHER trên sổ; tách theo kênh
  // của phiếu gốc để mỗi dòng trỏ đúng màn hình sửa.
  const voucherChannelById = new Map(approvedVouchers.map((row) => [row.id, row.documentChannel]));
  const postedSourceIds = new Set(entries.map((entry) => `${entry.sourceType}:${entry.sourceId}`));

  const sourceTotals = new Map<string, { entries: number; amount: number }>();
  const lineTotals = new Map<PnlLineKey, { amount: number; items: Map<string, ExpenseItemRow> }>();
  const details: ExpenseDetailRow[] = [];
  let postedTotal = 0;
  let unclassifiedTotal = 0;
  let unclassifiedLines = 0;
  for (const entry of entries) {
    const group = sourceGroupOf(entry.sourceType, voucherChannelById.get(entry.sourceId));
    let entryAmount = 0;
    for (const line of entry.lines) {
      if (!EXPENSE_ACCOUNT_TYPES.has(line.account.accountType)) continue;
      const amount = line.debit - line.credit;
      if (amount === 0) continue;
      // Bút toán máy tự sinh (khấu hao 6424, lương 6421) không có chỗ khai hạng mục nên suy
      // theo tài khoản, đúng như cách chúng lên dòng chi phí trên P&L.
      const pnlItemCode = resolvePnlItemCode(line, depreciationItemCode, payrollItemCode);
      // Chưa gán hạng mục P&L thì mới là khoản chi tiền, chưa phân bổ được vào dòng chi phí
      // nào — đếm riêng và để màn hình nhắc đi phân loại, không cộng vào bảng.
      if (!pnlItemCode) {
        unclassifiedTotal += amount;
        unclassifiedLines += 1;
        continue;
      }
      const lineKey = pnlLineKeyOf(line.account, pnlItemRefOf(line.pnlItemCode));
      if (!lineKey) continue;
      entryAmount += amount;
      const bucket = lineTotals.get(lineKey) || { amount: 0, items: new Map<string, ExpenseItemRow>() };
      bucket.amount += amount;
      const code = pnlItemCode;
      const item = bucket.items.get(code) || { code, name: pnlItemByCode.get(code)?.name || `Hạng mục P&L [${pnlItemCode}]`, amount: 0 };
      item.amount += amount;
      bucket.items.set(code, item);
      lineTotals.set(lineKey, bucket);
      // Cùng một vòng lặp với số tổng nên bảng chi tiết không bao giờ lệch hai bảng gom.
      details.push({
        id: line.id,
        entryCode: entry.code,
        date: entry.entryDate.toISOString().slice(0, 10),
        sourceKey: group.key,
        sourceLabel: group.label,
        sourceCode: entry.sourceCode,
        href: group.href(branchCode),
        description: line.description || entry.description,
        lineKey,
        lineLabel: EXPENSE_LINE_LABELS[lineKey],
        itemCode: code,
        itemName: item.name,
        accountCode: line.account.code,
        accountName: line.account.name,
        partnerCode: line.partnerCode,
        departmentCode: line.departmentCode,
        amount: round(amount),
      });
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
        .map((item) => ({ ...item, amount: round(item.amount) }))
        .sort((a, b) => comparePnlItems(a, b))
        .map((item) => ({ code: item.code, name: item.name, amount: item.amount }));
      return { key, label: EXPENSE_LINE_LABELS[key], amount: round(bucket.amount), items };
    });

  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const unpostedApproved = approvedVouchers.filter((row) => !postedSourceIds.has(`VOUCHER:${row.id}`));
  const unpostedDepreciation = depreciations.filter((row) => !postedSourceIds.has(`DEPRECIATION:${row.id}`));
  const unpostedPayroll = payrollRows.filter((row) => !postedSourceIds.has(`PAYROLL:${row.id}`));
  const unpostedDeptPayroll = payrollDeptRows.filter((row) => !postedSourceIds.has(`PAYROLL_DEPARTMENT:${row.id}`));
  const unpostedPayables = manualPayables.filter((row) => !postedSourceIds.has(`DEBT_PAYABLE:${row.id}`));
  const pendingCandidates: ExpensePendingRow[] = [
    { key: "VOUCHER_DRAFT", label: "Phiếu chi chưa duyệt", hint: "Phiếu chi còn nháp / chờ duyệt; duyệt xong mới thành chi phí", href: SOURCE_GROUPS.VOUCHER_CASH.href(branchCode), count: draftVouchers.length, amount: round(sum(draftVouchers.map((row) => row.amount))) },
    { key: "VOUCHER_UNPOSTED", label: "Phiếu chi đã duyệt nhưng chưa ghi sổ", hint: "Chạy hạch toán kỳ trên Sổ cái để đưa vào bút toán", href: "/accounting", count: unpostedApproved.length, amount: round(sum(unpostedApproved.map((row) => row.amount))) },
    { key: "ACCRUAL_PLANNED", label: "Lịch phân bổ chờ ghi nhận", hint: "Bấm ghi nhận từng kỳ ở tab Trích trước & Phân bổ", href: "/finance-operations?tab=accruals", count: plannedSchedules.length, amount: round(sum(plannedSchedules.map((row) => row.amount))) },
    { key: "DEPRECIATION_UNPOSTED", label: "Khấu hao đã chạy nhưng chưa ghi sổ", hint: "Chạy hạch toán kỳ trên Sổ cái", href: "/accounting", count: unpostedDepreciation.length, amount: round(sum(unpostedDepreciation.map((row) => row.depreciationAmount))) },
    {
      key: "PAYROLL_UNPOSTED",
      label: "Bảng lương đã import nhưng chưa ghi sổ",
      hint: "Chạy hạch toán kỳ trên Sổ cái",
      href: "/accounting",
      count: unpostedPayroll.length + unpostedDeptPayroll.length,
      // Mẫu theo bộ phận vào chi phí bằng TỔNG CHI PHÍ CÔNG TY, mẫu cũ bằng lương + phụ cấp + thưởng.
      amount: round(
        sum(unpostedPayroll.map((row) => row.baseSalary + row.allowanceAmount + row.bonusAmount))
        + sum(unpostedDeptPayroll.map((row) => row.totalCompanyCost)),
      ),
    },
    {
      key: "DEBT_PAYABLE_UNPOSTED",
      label: "Công nợ phải trả chưa ghi sổ",
      hint: "Khoản phải trả khai tay đã ghi nhận chi phí; chạy hạch toán kỳ trên Sổ cái để vào bút toán",
      href: "/accounting",
      count: unpostedPayables.length,
      amount: round(sum(unpostedPayables.map((row) => row.originalAmount))),
    },
  ];
  const pending = pendingCandidates.filter((row) => row.count > 0);

  return {
    period,
    branchCode,
    postedTotal: round(postedTotal),
    pendingTotal: round(sum(pending.map((row) => row.amount))),
    unclassifiedTotal: round(unclassifiedTotal),
    unclassifiedLines,
    bySource,
    byLine,
    pending,
    details,
  };
}

/**
 * Chi phí ĐÃ VÀO SỔ của một hạng mục P&L ở một nhà hàng trong kỳ.
 *
 * Dùng chung luật với bảng "Theo hạng mục P&L" ở trên — kể cả phần suy hạng mục cho bút toán
 * máy tự sinh (khấu hao 6424, lương 6421 không mang mã hạng mục) — nên số dùng để chặn phiếu
 * phân bổ luôn đúng bằng con số người dùng đang nhìn trên tab Tổng hợp chi phí, không phải
 * một cách đếm thứ hai.
 *
 * Khoản giảm do phiếu phân bổ trước đó đã trừ sẵn trong số này (bút toán ghi Có), nên phân bổ
 * nhiều lần cho cùng một hạng mục vẫn bị chặn đúng ở phần còn lại.
 */
/**
 * TIỀN CỦA HẠNG MỤC NÀY ĐANG NẰM Ở ĐÂU.
 *
 * Dùng cho câu báo lỗi của phiếu phân bổ chi phí: báo "không đủ chi phí để phân bổ" mà không
 * nói tiền ở đâu thì kế toán phải tự mò ba ô (ngày chứng từ / nhà hàng / hạng mục), và hay
 * kết luận là phần mềm chặn nhầm rồi xin bỏ chặn (khách 21/09/2026).
 *
 * Ba chỗ tiền hay nằm, theo đúng thứ tự hay gặp:
 *  - KỲ KHÁC: form mặc định ngày hôm nay trong khi kế toán đang soát kỳ trước.
 *  - NHÀ HÀNG KHÁC: chọn nhầm nhà hàng đã trả.
 *  - PHIẾU CHI CHƯA VÀO SỔ: phiếu đã lập/đã duyệt nhưng kỳ chưa bấm Đồng bộ ghi sổ, nên chi
 *    phí chưa có trên sổ dù chứng từ đã có. Đây là ca nhìn "vô lý" nhất với người dùng vì họ
 *    vừa nhập phiếu xong.
 */
export async function findExpenseForPnlItem(period: string, branchCode: string, pnlItemCode: string) {
  const { start, end } = periodBounds(period);
  const [otherPeriods, otherBranches, pendingVouchers] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { branchCode, status: "POSTED", entryDate: { lt: start } },
      select: { period: true, lines: { where: { pnlItemCode, debit: { gt: 0 } }, select: { debit: true } } },
      orderBy: { entryDate: "desc" },
      take: 400,
    }),
    prisma.journalEntry.findMany({
      where: { branchCode: { not: branchCode }, status: "POSTED", entryDate: { gte: start, lt: end } },
      select: { branchCode: true, lines: { where: { pnlItemCode, debit: { gt: 0 } }, select: { debit: true } } },
      take: 400,
    }),
    // Phiếu chi mang đúng hạng mục, đúng kỳ, đúng nhà hàng nhưng CHƯA thành bút toán.
    prisma.financialVoucher.findMany({
      where: { branchCode, voucherType: "PAYMENT", pnlItemCode, voucherDate: { gte: start, lt: end }, deletedAt: null },
      select: { id: true, code: true, amount: true, status: true, voucherDate: true },
      orderBy: { voucherDate: "asc" },
      take: 50,
    }),
  ]);

  const byPeriod = new Map<string, number>();
  for (const entry of otherPeriods) {
    const amount = entry.lines.reduce((sum, line) => sum + line.debit, 0);
    if (amount > 0) byPeriod.set(entry.period, (byPeriod.get(entry.period) || 0) + amount);
  }
  const byBranch = new Map<string, number>();
  for (const entry of otherBranches) {
    const amount = entry.lines.reduce((sum, line) => sum + line.debit, 0);
    if (amount > 0) byBranch.set(entry.branchCode, (byBranch.get(entry.branchCode) || 0) + amount);
  }
  const postedVoucherIds = new Set(
    (await prisma.journalEntry.findMany({
      where: { sourceType: "VOUCHER", sourceId: { in: pendingVouchers.map((row) => row.id) } },
      select: { sourceId: true },
    })).map((row) => row.sourceId),
  );
  const notPosted = pendingVouchers.filter((row) => !postedVoucherIds.has(row.id));

  return {
    otherPeriods: [...byPeriod.entries()].map(([key, amount]) => ({ period: key, amount: round(amount) })).sort((a, b) => b.period.localeCompare(a.period)).slice(0, 3),
    otherBranches: [...byBranch.entries()].map(([key, amount]) => ({ branchCode: key, amount: round(amount) })).sort((a, b) => b.amount - a.amount).slice(0, 3),
    notPostedVouchers: notPosted.map((row) => ({ code: row.code, amount: round(row.amount), status: row.status })),
    notPostedTotal: round(notPosted.reduce((sum, row) => sum + row.amount, 0)),
  };
}

export type ExpenseWhereabouts = Awaited<ReturnType<typeof findExpenseForPnlItem>>;

export async function postedExpenseForPnlItem(period: string, branchCode: string, pnlItemCode: string) {
  const { start, end } = periodBounds(period);
  const [entries, pnlItems] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { entryDate: { gte: start, lt: end }, status: "POSTED", branchCode },
      select: { lines: { select: { debit: true, credit: true, pnlItemCode: true, account: { select: { accountType: true, reportGroup: true } } } } },
    }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true, subGroup: true, status: true } }),
  ]);
  const depreciationItemCode = depreciationCatalogItemCode(pnlItems);
  const payrollItemCode = payrollCatalogItemCode(pnlItems);
  let total = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!EXPENSE_ACCOUNT_TYPES.has(line.account.accountType)) continue;
      if (resolvePnlItemCode(line, depreciationItemCode, payrollItemCode) !== pnlItemCode) continue;
      total += line.debit - line.credit;
    }
  }
  return round(total);
}
