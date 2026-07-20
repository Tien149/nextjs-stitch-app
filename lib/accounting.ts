import { prisma } from "@/lib/prisma";
import { addPeriod, businessError, isPeriodLocked, periodFromDate } from "@/lib/phase3";
import type { DemoSession } from "@/lib/auth-demo";

export const defaultAccounts = [
  { code: "1111", name: "Tiền mặt", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "CASH" },
  { code: "1121", name: "Tiền gửi ngân hàng", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "CASH" },
  { code: "131", name: "Phải thu đối tác", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "RECEIVABLE" },
  { code: "152", name: "Nguyên liệu và hàng tồn kho", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "INVENTORY" },
  { code: "211", name: "Tài sản cố định", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "FIXED_ASSET" },
  { code: "214", name: "Khấu hao lũy kế", accountType: "ASSET", normalBalance: "CREDIT", reportGroup: "ACCUMULATED_DEPRECIATION" },
  { code: "331", name: "Phải trả nhà cung cấp", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYABLE" },
  { code: "334", name: "Phải trả người lao động", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYROLL_PAYABLE" },
  { code: "335", name: "Chi phí phải trả", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "ACCRUAL" },
  { code: "338", name: "Bảo hiểm phải nộp", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYROLL_PAYABLE" },
  { code: "3388", name: "Khấu trừ khác phải trả", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "OTHER_PAYABLE" },
  { code: "3335", name: "Thuế TNCN phải nộp", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "TAX_PAYABLE" },
  { code: "411", name: "Vốn chủ sở hữu", accountType: "EQUITY", normalBalance: "CREDIT", reportGroup: "EQUITY" },
  { code: "511", name: "Doanh thu bán hàng", accountType: "REVENUE", normalBalance: "CREDIT", reportGroup: "REVENUE" },
  { code: "632", name: "Giá vốn hàng bán", accountType: "COGS", normalBalance: "DEBIT", reportGroup: "COGS" },
  { code: "6421", name: "Chi phí nhân sự", accountType: "OPEX", normalBalance: "DEBIT", reportGroup: "PAYROLL" },
  { code: "6424", name: "Chi phí khấu hao", accountType: "OPEX", normalBalance: "DEBIT", reportGroup: "DEPRECIATION" },
  { code: "6428", name: "Chi phí vận hành khác", accountType: "OPEX", normalBalance: "DEBIT", reportGroup: "OPEX" },
  { code: "711", name: "Thu nhập khác", accountType: "OTHER_INCOME", normalBalance: "CREDIT", reportGroup: "OTHER_INCOME" },
];

export async function ensureDefaultAccounts() {
  await prisma.accountingAccount.createMany({ data: defaultAccounts, skipDuplicates: true });
  return prisma.accountingAccount.findMany({ where: { status: "ACTIVE" }, orderBy: { code: "asc" } });
}

export function periodBounds(period: string) {
  return { start: new Date(`${period}-01T00:00:00`), end: new Date(`${addPeriod(period, 1)}-01T00:00:00`) };
}

export const managedBranches = ["HCM", "HN"] as const;

export function getAllowedBranches(session: DemoSession) {
  if (session.allowedBranches?.includes("ALL")) return [...managedBranches];
  if (session.allowedBranches?.length) {
    return session.allowedBranches.filter((branch) => managedBranches.includes(branch as typeof managedBranches[number]));
  }
  if (session.branch.includes("HCM")) return ["HCM"];
  if (session.branch.includes("Hà Nội") || session.branch.includes("HN")) return ["HN"];
  return [...managedBranches];
}

export function canUseAllBranches(session: DemoSession) {
  return getAllowedBranches(session).length > 1;
}

export function requestedBranch(session: DemoSession, value: string) {
  const requested = (value || "ALL").trim().toUpperCase();
  const allowed = getAllowedBranches(session);
  if (requested === "ALL") return canUseAllBranches(session) ? "ALL" : allowed[0];
  return allowed.includes(requested) ? requested : allowed[0];
}

export function assertBranchAccess(session: DemoSession, payloadBranch: string) {
  const requested = (payloadBranch || "").trim().toUpperCase();
  const allowedBranches = getAllowedBranches(session);
  if (!requested || (requested === "ALL" && canUseAllBranches(session))) return;
  if (requested === "ALL" || !allowedBranches.includes(requested)) {
    throw new Error(`Bạn không có quyền thao tác ngoài cửa hàng được phân công (${allowedBranches.join(", ")}).`);
  }
}

export function branchFilterForSession(session: DemoSession, value?: string) {
  const allowed = getAllowedBranches(session);
  const isAll = canUseAllBranches(session);
  const requested = (value || "ALL").trim().toUpperCase();

  if (requested === "ALL") {
    return isAll ? {} : { branchCode: { in: allowed } };
  }
  return allowed.includes(requested) ? { branchCode: requested } : { branchCode: allowed[0] };
}

type EntryLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  departmentCode?: string | null;
  partnerCode?: string | null;
  categoryCode?: string | null;
  description?: string | null;
};

type EntryInput = {
  entryDate: Date;
  branchCode: string;
  sourceType: string;
  sourceId: string;
  sourceCode?: string | null;
  description: string;
  createdBy: string;
  lines: EntryLine[];
};

export async function postJournalEntry(input: EntryInput) {
  const debit = input.lines.reduce((sum, line) => sum + (line.debit || 0), 0);
  const credit = input.lines.reduce((sum, line) => sum + (line.credit || 0), 0);
  if (Math.abs(debit - credit) > 0.5 || debit <= 0) businessError(`Bút toán ${input.sourceCode || input.sourceId} không cân Nợ/Có`);
  if (await isPeriodLocked(input.entryDate, input.branchCode)) return "SKIPPED_LOCKED";
  const accounts = await ensureDefaultAccounts();
  const accountMap = new Map(accounts.map((account) => [account.code, account.id]));
  const period = periodFromDate(input.entryDate);
  const existing = await prisma.journalEntry.findUnique({ where: { sourceType_sourceId: { sourceType: input.sourceType, sourceId: input.sourceId } }, include: { lines: true } });
  const lineData = input.lines.map((line) => {
    const accountId = accountMap.get(line.accountCode);
    if (!accountId) businessError(`Thiếu tài khoản ${line.accountCode}`);
    return { accountId, debit: line.debit || 0, credit: line.credit || 0, departmentCode: line.departmentCode || null, partnerCode: line.partnerCode || null, categoryCode: line.categoryCode || null, description: line.description || null };
  });
  if (existing) {
    const existingDebit = existing.lines.reduce((sum, line) => sum + line.debit, 0);
    if (Math.abs(existingDebit - debit) <= 0.5 && existing.period === period) return "SKIPPED_EXISTS";
    await prisma.$transaction(async (tx) => {
      await tx.journalLine.deleteMany({ where: { entryId: existing.id } });
      await tx.journalEntry.update({
        where: { id: existing.id },
        data: { entryDate: input.entryDate, period, branchCode: input.branchCode, sourceCode: input.sourceCode, description: input.description, lines: { create: lineData } },
      });
    });
    return "UPDATED";
  }
  const sequence = await prisma.journalEntry.count();
  await prisma.journalEntry.create({
    data: {
      code: `JE-${String(sequence + 1).padStart(6, "0")}`,
      entryDate: input.entryDate,
      period,
      branchCode: input.branchCode,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceCode: input.sourceCode,
      description: input.description,
      createdBy: input.createdBy,
      lines: { create: lineData },
    },
  });
  return "CREATED";
}

export async function syncAccountingPeriod(period: string, branchCode: string, actor: string) {
  const { start, end } = periodBounds(period);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const results: string[] = [];
  const openingBalances = await prisma.openingBalance.findMany({ where: { period, status: { in: ["POSTED", "CONFIRMED"] }, ...(branchCode === "ALL" ? {} : { branchCode }) } });
  for (const row of openingBalances) {
    const assetAccount = row.balanceType === "AR" ? "131" : row.balanceType === "INVENTORY" ? "152" : row.balanceType === "ASSET" ? "211" : (row.moneySourceCode || "").toUpperCase().includes("BANK") || (row.moneySourceCode || "").toUpperCase().includes("VCB") ? "1121" : "1111";
    const isLiability = row.balanceType === "AP";
    results.push(await postJournalEntry({
      entryDate: start,
      branchCode: row.branchCode,
      sourceType: "OPENING_BALANCE",
      sourceId: row.id,
      sourceCode: `${row.period}-${row.balanceType}`,
      description: row.note || `Số dư đầu kỳ ${row.balanceType}`,
      createdBy: actor,
      lines: isLiability
        ? [{ accountCode: "411", debit: row.amount }, { accountCode: "331", credit: row.amount, partnerCode: row.objectCode }]
        : [{ accountCode: assetAccount, debit: row.amount, partnerCode: row.objectCode }, { accountCode: "411", credit: row.amount }],
    }));
  }

  const assets = await prisma.assetRecord.findMany({ where: { ...branchFilter, purchaseDate: { gte: start, lt: end } } });
  for (const row of assets) results.push(await postJournalEntry({ entryDate: row.purchaseDate, branchCode: row.branchCode, sourceType: "ASSET_ACQUISITION", sourceId: row.id, sourceCode: row.code, description: `Ghi tăng tài sản ${row.name}`, createdBy: actor, lines: [{ accountCode: "211", debit: row.originalCost, partnerCode: row.supplierCode }, { accountCode: row.supplierCode ? "331" : "411", credit: row.originalCost, partnerCode: row.supplierCode }] }));

  const revenues = await prisma.revenueImportRow.findMany({ where: { ...branchFilter, saleDate: { gte: start, lt: end } } });
  for (const row of revenues) results.push(await postJournalEntry({ entryDate: row.saleDate, branchCode: row.branchCode, sourceType: "REVENUE_POS", sourceId: row.id, sourceCode: row.externalRef, description: `Doanh thu ${row.externalRef}`, createdBy: actor, lines: [{ accountCode: row.paymentMethod.toUpperCase().includes("CASH") ? "1111" : "1121", debit: row.netAmount }, { accountCode: "511", credit: row.netAmount, categoryCode: row.revenueSource }] }));

  const vouchers = await prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherDate: { gte: start, lt: end }, status: "APPROVED" } });
  for (const row of vouchers) {
    const cashAccount = row.moneySourceCode.toUpperCase().includes("CASH") ? "1111" : "1121";
    const lines = row.voucherType === "RECEIPT"
      ? [{ accountCode: cashAccount, debit: row.amount }, { accountCode: row.partnerCode ? "131" : "711", credit: row.amount, partnerCode: row.partnerCode, categoryCode: row.categoryCode }]
      : [{ accountCode: "6428", debit: row.amount, partnerCode: row.partnerCode, categoryCode: row.categoryCode }, { accountCode: cashAccount, credit: row.amount }];
    results.push(await postJournalEntry({ entryDate: row.voucherDate, branchCode: row.branchCode, sourceType: "VOUCHER", sourceId: row.id, sourceCode: row.code, description: row.description, createdBy: actor, lines }));
  }

  const payables = await prisma.supplierPayable.findMany({ where: { recognizedDate: { gte: start, lt: end }, ...(branchCode === "ALL" ? {} : { purchaseOrder: { branchCode } }) }, include: { purchaseOrder: true } });
  for (const row of payables) results.push(await postJournalEntry({ entryDate: row.recognizedDate, branchCode: row.purchaseOrder.branchCode, sourceType: "SUPPLIER_PAYABLE", sourceId: row.id, sourceCode: row.purchaseOrder.code, description: `Nhập hàng ${row.purchaseOrder.code}`, createdBy: actor, lines: [{ accountCode: "152", debit: row.originalAmount, partnerCode: row.supplierCode }, { accountCode: "331", credit: row.originalAmount, partnerCode: row.supplierCode }] }));

  const stockIssues = await prisma.inventoryTransaction.findMany({ where: { ...branchFilter, transactionDate: { gte: start, lt: end }, transactionType: { in: ["ISSUE", "WASTE"] } }, include: { lines: true } });
  for (const row of stockIssues) {
    const amount = row.lines.reduce((sum, line) => sum + line.totalCost, 0);
    if (amount > 0) results.push(await postJournalEntry({ entryDate: row.transactionDate, branchCode: row.branchCode, sourceType: "INVENTORY_ISSUE", sourceId: row.id, sourceCode: row.code, description: row.note || `Xuất kho ${row.code}`, createdBy: actor, lines: [{ accountCode: row.transactionType === "WASTE" ? "6428" : "632", debit: amount }, { accountCode: "152", credit: amount }] }));
  }

  const depreciation = await prisma.assetDepreciation.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { asset: { branchCode } }) }, include: { asset: true } });
  for (const row of depreciation) results.push(await postJournalEntry({ entryDate: new Date(`${period}-28T00:00:00`), branchCode: row.asset.branchCode, sourceType: "DEPRECIATION", sourceId: row.id, sourceCode: row.asset.code, description: `Khấu hao ${row.asset.name}`, createdBy: actor, lines: [{ accountCode: "6424", debit: row.depreciationAmount }, { accountCode: "214", credit: row.depreciationAmount }] }));

  const accruals = await prisma.accrualSchedule.findMany({ where: { period, status: "POSTED", ...(branchCode === "ALL" ? {} : { accrual: { branchCode } }) }, include: { accrual: true } });
  for (const row of accruals) results.push(await postJournalEntry({ entryDate: row.postedAt || new Date(`${period}-28T00:00:00`), branchCode: row.accrual.branchCode, sourceType: "ACCRUAL", sourceId: row.id, sourceCode: row.accrual.code, description: `Phân bổ ${row.accrual.name}`, createdBy: actor, lines: [{ accountCode: "6428", debit: row.amount, categoryCode: row.accrual.categoryCode }, { accountCode: "335", credit: row.amount }] }));

  const payroll = await prisma.payrollImportRow.findMany({ where: { period, ...(branchCode === "ALL" ? {} : { branchCode }) } });
  for (const row of payroll) {
    const gross = row.baseSalary + row.allowanceAmount + row.bonusAmount;
    results.push(await postJournalEntry({ entryDate: new Date(`${period}-28T00:00:00`), branchCode: row.branchCode, sourceType: "PAYROLL", sourceId: row.id, sourceCode: row.externalRef || row.employeeCode, description: `Lương ${row.employeeName} ${period}`, createdBy: actor, lines: [{ accountCode: "6421", debit: gross, departmentCode: row.departmentCode }, { accountCode: "334", credit: row.netAmount, departmentCode: row.departmentCode }, { accountCode: "338", credit: row.insuranceAmount, departmentCode: row.departmentCode }, { accountCode: "3335", credit: row.taxAmount, departmentCode: row.departmentCode }, { accountCode: "3388", credit: row.deductionAmount, departmentCode: row.departmentCode }] }));
  }

  return {
    total: results.length,
    created: results.filter((value) => value === "CREATED").length,
    updated: results.filter((value) => value === "UPDATED").length,
    skipped: results.filter((value) => value.startsWith("SKIPPED")).length,
  };
}
