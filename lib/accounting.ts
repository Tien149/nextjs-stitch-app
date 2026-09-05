import { prisma } from "@/lib/prisma";
import { addPeriod, businessError, isPeriodLocked, periodFromDate } from "@/lib/phase3";
import type { DemoSession } from "@/lib/auth-demo";
import { voucherJournalLines } from "@/lib/voucher-accounting";
import { normalizeCategoryGroup } from "@/lib/voucher-rules";
import { moneySourceAccountCode } from "@/lib/money-sources";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { effectiveMoneyTransferDate, effectiveMoneyTransferDateFilter } from "@/lib/money-transfer-date";
import { planMoneyTransferJournals } from "@/lib/internal-transfer";
import { revenuePosJournalLines } from "@/lib/revenue-pos-journal";
import { ensureRevenueCategories, type CategoryLookupClient } from "@/lib/revenue-source";

export const defaultAccounts = [
  { code: "1111", name: "Tiền mặt", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "CASH" },
  { code: "1121", name: "Tiền gửi ngân hàng", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "CASH" },
  { code: "131", name: "Phải thu đối tác", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "RECEIVABLE" },
  { code: "152", name: "Nguyên liệu và hàng tồn kho", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "INVENTORY" },
  { code: "211", name: "Tài sản cố định", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "FIXED_ASSET" },
  { code: "214", name: "Khấu hao lũy kế", accountType: "ASSET", normalBalance: "CREDIT", reportGroup: "ACCUMULATED_DEPRECIATION" },
  { code: "242", name: "Chi phí trả trước / CCDC", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "PREPAID_EXPENSE" },
  // Hai tài khoản nội bộ dùng cho phân bổ chi phí liên nhà hàng: nhà hàng trả hộ ghi 1368,
  // nhà hàng nhận chi phí ghi 3368. Xem toàn công ty thì hai vế triệt tiêu nhau.
  { code: "1368", name: "Phải thu nội bộ giữa các nhà hàng", accountType: "ASSET", normalBalance: "DEBIT", reportGroup: "RECEIVABLE" },
  { code: "331", name: "Phải trả nhà cung cấp", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYABLE" },
  { code: "3368", name: "Phải trả nội bộ giữa các nhà hàng", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYABLE" },
  { code: "334", name: "Phải trả người lao động", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYROLL_PAYABLE" },
  { code: "335", name: "Chi phí phải trả", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "ACCRUAL" },
  { code: "338", name: "Bảo hiểm phải nộp", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "PAYROLL_PAYABLE" },
  { code: "3387", name: "Khách hàng ứng trước (tiền cọc)", accountType: "LIABILITY", normalBalance: "CREDIT", reportGroup: "CUSTOMER_ADVANCE" },
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

export function getAllowedBranches(session: DemoSession) {
  if (session.allowedBranches?.includes("ALL")) {
    return ["ALL", "TEMP_BYPASS"];
  }
  return session.allowedBranches || [];
}

export function canUseAllBranches(session: DemoSession) {
  if (session.allowedBranches?.includes("ALL")) return true;
  return (session.allowedBranches || []).length > 1;
}

export function requestedBranch(session: DemoSession, value: string) {
  const requested = (value || "ALL").trim().toUpperCase();
  if (session.allowedBranches?.includes("ALL")) {
    return requested;
  }
  const allowed = session.allowedBranches || [];
  if (requested === "ALL") {
    // Không trả "ALL" cho tài khoản bị giới hạn: các API hiểu "ALL" là bỏ lọc chi nhánh,
    // nên người được gán 2 cửa hàng sẽ nhìn thấy luôn cửa hàng thứ ba chưa được gán.
    return allowed[0] || "ALL";
  }
  return allowed.includes(requested) ? requested : (allowed[0] || "ALL");
}

export function assertBranchAccess(session: DemoSession, payloadBranch: string) {
  const requested = (payloadBranch || "").trim().toUpperCase();
  if (session.allowedBranches?.includes("ALL")) return;
  const allowedBranches = session.allowedBranches || [];
  if (!requested || requested === "ALL") return;
  if (!allowedBranches.includes(requested)) {
    // Ném BUSINESS để người dùng nhận đúng câu giải thích. Ném Error thường thì apiError coi là
    // lỗi hệ thống và trả "Internal Server Error" 500 — người bị chặn không hiểu vì sao.
    businessError(`Bạn không có quyền thao tác ngoài cửa hàng được phân công (${allowedBranches.join(", ")}).`);
  }
}

export function branchFilterForSession(session: DemoSession, value?: string) {
  const requested = (value || "ALL").trim().toUpperCase();
  if (session.allowedBranches?.includes("ALL")) {
    return requested === "ALL" ? {} : { branchCode: requested };
  }
  const allowed = session.allowedBranches || [];
  if (requested === "ALL") {
    return allowed.length > 1 ? { branchCode: { in: allowed } } : { branchCode: allowed[0] || "ALL" };
  }
  return allowed.includes(requested) ? { branchCode: requested } : { branchCode: allowed[0] || "ALL" };
}


type EntryLine = {
  accountCode: string;
  debit?: number;
  credit?: number;
  departmentCode?: string | null;
  partnerCode?: string | null;
  categoryCode?: string | null;
  pnlItemCode?: string | null;
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
    return { accountId, debit: line.debit || 0, credit: line.credit || 0, departmentCode: line.departmentCode || null, partnerCode: line.partnerCode || null, categoryCode: line.categoryCode || null, pnlItemCode: line.pnlItemCode || null, description: line.description || null };
  });
  if (existing) {
    const existingDebit = existing.lines.reduce((sum, line) => sum + line.debit, 0);
    const isSameLines = existing.lines.length === input.lines.length &&
      existing.lines.every((el) => {
        const matchingInput = input.lines.find((il) => {
          const accountId = accountMap.get(il.accountCode);
          return accountId === el.accountId
            && (il.debit || 0) === el.debit
            && (il.credit || 0) === el.credit
            && (il.departmentCode || null) === el.departmentCode
            && (il.partnerCode || null) === el.partnerCode
            && (il.categoryCode || null) === el.categoryCode
            && (il.pnlItemCode || null) === el.pnlItemCode;
        });
        return !!matchingInput;
      });
    if (Math.abs(existingDebit - debit) <= 0.5 && existing.period === period && isSameLines) return "SKIPPED_EXISTS";
    await prisma.$transaction(async (tx) => {
      await tx.journalLine.deleteMany({ where: { entryId: existing.id } });
      await tx.journalEntry.update({
        where: { id: existing.id },
        data: { entryDate: input.entryDate, period, branchCode: input.branchCode, sourceCode: input.sourceCode, description: input.description, lines: { create: lineData } },
      });
    });
    return "UPDATED";
  }
  // Bút toán bị xoá cứng ở nhiều luồng (bỏ duyệt phiếu, xoá phiếu phân bổ, rollback import)
  // nên COUNT tụt xuống sau mỗi lần xoá và cấp lại mã đang còn sống. Lấy max + 1 trong đúng
  // chuỗi "JE-": mã đã xoá để lại lỗ trống, nhưng không bao giờ đâm trúng mã đang tồn tại.
  const issuedEntryCodes = await prisma.journalEntry.findMany({
    where: { code: { startsWith: "JE-" } },
    select: { code: true },
  });
  await prisma.journalEntry.create({
    data: {
      code: `JE-${String(nextSeqFromCodes(issuedEntryCodes.map((row) => row.code), "JE-")).padStart(6, "0")}`,
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

/**
 * Danh mục Thu cho các dòng doanh thu tách riêng khi ghi sổ (Doanh thu SVC, Doanh thu thuế
 * GTGT, Điều chỉnh). Là nhóm doanh thu để lên dòng 1 của P&L, nhưng không theo dõi tồn kho.
 * Chỉ tạo khi thiếu; người dùng đã đổi tên trên màn Danh mục thì giữ nguyên tên của họ.
 */
export async function ensureRevenueComponentCategories() {
  // Cùng một bộ với import doanh thu (lib/revenue-source.ts) để hai chỗ không lệch danh mục.
  await ensureRevenueCategories(prisma as unknown as CategoryLookupClient);
}

export async function syncAccountingPeriod(period: string, branchCode: string, actor: string) {
  const { start, end } = periodBounds(period);
  const branchFilter = branchCode === "ALL" ? {} : { branchCode };
  const results: string[] = [];
  const openingBalances = await prisma.openingBalance.findMany({ where: { period, status: { in: ["POSTED", "CONFIRMED"] }, ...(branchCode === "ALL" ? {} : { branchCode }) } });
  const openingSourceCodes = [...new Set(openingBalances.map((row) => row.moneySourceCode).filter((code): code is string => Boolean(code)))];
  const openingSources = openingSourceCodes.length > 0
    ? await prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", code: { in: openingSourceCodes } }, select: { code: true, group: true } })
    : [];
  const openingSourceGroups = new Map(openingSources.map((source) => [source.code, (source.group || "").toUpperCase()]));
  for (const row of openingBalances) {
    const sourceAccount = openingSourceGroups.get(row.moneySourceCode || "") === "BANK" ? "1121" : "1111";
    const assetAccount = row.balanceType === "AR" ? "131" : row.balanceType === "INVENTORY" ? "152" : row.balanceType === "ASSET" ? "211" : sourceAccount;
    const isLiability = row.balanceType === "AP";
    const isCustomerDeposit = row.balanceType === "DEPOSIT";
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
        : isCustomerDeposit
          // Cọc đầu kỳ là số nợ khách còn treo từ trước; tiền thực tế đã nằm trong số dư quỹ/ngân hàng nhập riêng.
          // Chỉ tái phân loại nguồn vốn, không ghi tăng tiền lần thứ hai.
          ? [{ accountCode: "411", debit: row.amount }, { accountCode: "3387", credit: row.amount, partnerCode: row.objectCode }]
        : [{ accountCode: assetAccount, debit: row.amount, partnerCode: row.objectCode }, { accountCode: "411", credit: row.amount }],
    }));
  }

  const assets = await prisma.assetRecord.findMany({ where: { ...branchFilter, purchaseDate: { gte: start, lt: end } } });
  const assetGroups = await prisma.masterDataItem.findMany({ where: { type: "ASSET_GROUP" }, select: { code: true, group: true } });
  const assetGroupType = new Map(assetGroups.map((item) => [item.code, (item.group || "").toUpperCase()]));
  for (const row of assets) {
    const isTool = ["CCDC", "TOOL"].includes(assetGroupType.get(row.assetGroup) || "");
    const payable = row.paymentStatus === "PAYABLE" || (row.paymentStatus === "UNSPECIFIED" && Boolean(row.supplierCode));
    results.push(await postJournalEntry({ entryDate: row.purchaseDate, branchCode: row.branchCode, sourceType: "ASSET_ACQUISITION", sourceId: row.id, sourceCode: row.code, description: `Ghi tăng tài sản ${row.name}`, createdBy: actor, lines: [{ accountCode: isTool ? "242" : "211", debit: row.originalCost, partnerCode: row.supplierCode }, { accountCode: payable ? "331" : "411", credit: row.originalCost, partnerCode: payable ? row.supplierCode : null }] }));
  }

  const revenues = await prisma.revenueImportRow.findMany({ where: { ...branchFilter, saleDate: { gte: start, lt: end } } });
  // Dòng doanh thu mang bộ phận (Bếp/Bar/FOH) sang bút toán 511 để P&L cắt được doanh thu
  // theo phòng ban — nền của báo cáo ngân sách nhân sự (feedback chị Bình 26/08/2026).
  // Có 511 tách ba phần: nhóm doanh thu của món = Doanh thu − Giảm giá, "Doanh thu SVC" = cột
  // SVC, "Doanh thu thuế GTGT" = cột Thuế (lib/revenue-pos-journal.ts). Danh mục cho hai dòng
  // tách riêng phải có sẵn, nếu không P&L hiện mã trơ "Nguồn thu [REV_SVC]".
  if (revenues.length > 0) await ensureRevenueComponentCategories();
  for (const row of revenues) {
    const lines = revenuePosJournalLines(row);
    // Dòng 0 đồng (đá, cà phê free, món tặng kèm...) có số lượng để rã kho nhưng không có tiền
    // để ghi sổ: bút toán Nợ 0 / Có 0 bị postJournalEntry chặn là "không cân" và làm hỏng cả
    // kỳ, nên bỏ qua thay vì đổ lỗi cho file POS.
    if (!lines.some((line) => (line.debit || 0) > 0)) {
      results.push("SKIPPED_ZERO");
      continue;
    }
    results.push(await postJournalEntry({ entryDate: row.saleDate, branchCode: row.branchCode, sourceType: "REVENUE_POS", sourceId: row.id, sourceCode: row.externalRef, description: `Doanh thu ${row.externalRef}`, createdBy: actor, lines }));
  }

  const vouchers = await prisma.financialVoucher.findMany({ where: { ...branchFilter, voucherDate: { gte: start, lt: end }, status: "APPROVED" } });
  // Nhóm khoản mục quyết định phiếu chi vào chi phí, giá vốn hay tài sản.
  const [voucherCategories, pnlItems] = await Promise.all([
    prisma.masterDataItem.findMany({ where: { type: "REVENUE_EXPENSE_CATEGORY" } }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" } }),
  ]);
  const categoryGroupByCode = new Map(voucherCategories.map((item) => [item.code, normalizeCategoryGroup(item.group)]));
  const pnlItemGroupByCode = new Map(pnlItems.map((item) => [item.code, normalizeCategoryGroup(item.group)]));
  for (const row of vouchers) {
    // Sao kê khớp doanh thu POS chỉ xác nhận dòng tiền; doanh thu và bút toán đối ứng
    // đã được ghi từ RevenueImportRow nên không được tạo thêm bút toán voucher.
    if (row.businessEffect === "SETTLEMENT") continue;
    const { lines } = voucherJournalLines(
      row,
      row.categoryCode ? categoryGroupByCode.get(row.categoryCode) ?? null : null,
      row.pnlItemCode ? pnlItemGroupByCode.get(row.pnlItemCode) ?? null : null,
    );
    results.push(await postJournalEntry({ entryDate: row.voucherDate, branchCode: row.branchCode, sourceType: "VOUCHER", sourceId: row.id, sourceCode: row.code, description: row.description, createdBy: actor, lines }));
  }

  // Điều chuyển có chênh lệch phải giảm đủ nguồn đi, tăng nguồn nhận theo số thực chuyển
  // và đưa phần chênh vào chi phí. Cùng một logic áp dụng cho phí ví và làm tròn tiền nộp.
  //
  // Phiếu liên nhà hàng ghi sổ ở CẢ hai cửa hàng nên phải lấy cả phiếu do cửa hàng bên kia
  // lập; mỗi bút toán tự kiểm kỳ khóa theo cửa hàng của chính nó trong postJournalEntry.
  const transferBranchFilter = branchCode === "ALL"
    ? {}
    : { OR: [{ branchCode }, { fromBranchCode: branchCode }, { toBranchCode: branchCode }] };
  const [moneyTransfers, transferMoneySources] = await Promise.all([
    prisma.moneyTransfer.findMany({ where: { ...transferBranchFilter, ...effectiveMoneyTransferDateFilter(start, end), status: "APPROVED" } }),
    prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE" } }),
  ]);
  const transferSourceByCode = new Map(transferMoneySources.map((source) => [source.code, source]));
  for (const row of moneyTransfers) {
    const grossAmount = row.amount + row.feeAmount;
    if (grossAmount <= 0) continue;
    const journals = planMoneyTransferJournals({
      branchCode: row.branchCode,
      fromBranchCode: row.fromBranchCode,
      toBranchCode: row.toBranchCode,
      amount: row.amount,
      feeAmount: row.feeAmount,
      grabExpenseAmount: row.grabExpenseAmount,
      feeCategoryCode: row.feeCategoryCode,
      grabExpenseCategoryCode: row.grabExpenseCategoryCode,
      fromAccountCode: moneySourceAccountCode(transferSourceByCode.get(row.fromMoneySourceCode)),
      toAccountCode: moneySourceAccountCode(transferSourceByCode.get(row.toMoneySourceCode)),
      description: row.description,
    });
    for (const journal of journals) {
      results.push(await postJournalEntry({
        entryDate: effectiveMoneyTransferDate(row),
        branchCode: journal.branchCode,
        sourceType: journal.sourceType,
        sourceId: row.id,
        sourceCode: row.code,
        description: journal.description || row.description,
        createdBy: actor,
        lines: journal.lines as EntryLine[],
      }));
    }
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
