import { createHash } from "node:crypto";
import { Prisma } from "@prisma/custom-client";
import { prisma, prismaRaw, type RawTxClient, type TxClient } from "@/lib/prisma";
import { addPeriod, isPeriodLocked, periodFromDate } from "@/lib/phase3";
import { ensureDefaultAccounts } from "@/lib/accounting";
import { isMasterDataImportType, normalizeHeader, type ImportType } from "@/lib/import-templates";
import { parseImportDate, type ParsedImportRow } from "@/lib/import-parser";
import { normalizeStockTransactionType, postInventoryTransaction } from "@/lib/inventory-stock";
import { writeAuditLog } from "@/lib/audit-log";
import { ensureRevenuePosReference, revenuePosReferenceKey } from "@/lib/revenue-pos-reference";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { nextSeqFromCodes, voucherCodePrefix } from "@/lib/voucher-code-generator";
import { commonBankValue, groupBankStatementRows } from "@/lib/bank-statement-import";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { evaluateBankStatementAutoApproval } from "@/lib/bank-statement-auto-approval";
import { applyVoucherSideEffects } from "@/lib/voucher-side-effects";
import { applyOpeningDeposit } from "@/lib/opening-balance-deposit";
import { assertAssetCodeAvailable, nextAssetCode } from "@/lib/asset-code-generator";
import { isWarehouseStocktakeItemType } from "@/lib/inventory-scope";
import { nextStockDocCode, nextStocktakeCode } from "@/lib/inventory-stock";
import {
  WALLET_CARD_FEE_CATEGORY_CODE,
  WALLET_GRAB_EXPENSE_CATEGORY_CODE,
} from "@/lib/wallet-settlement-allocation";

/**
 * Một dòng sao kê không đủ điều kiện lập chứng từ tự động.
 *
 * Trước đây mọi trường hợp như vậy đều ném lỗi thường và làm hỏng cả lô: file 580 dòng chỉ cần
 * một dòng sai khoản mục là không ghi được dòng nào, người dùng chỉ nhận một dòng chữ đỏ. Nay
 * tiền vẫn được ghi nhận (nó đã vào ngân hàng thật), chỉ riêng dòng đó không có chứng từ và
 * được đánh dấu kèm lý do để sửa rồi xử lý lại.
 *
 * Chỉ dùng cho lỗi nghiệp vụ của đúng một dòng. Lỗi database vẫn phải làm hỏng cả lô như cũ,
 * nên tuyệt đối không bắt Error chung ở chỗ gọi.
 */
export class BankRowNeedsFixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BankRowNeedsFixError";
  }
}

function asText(value: unknown) {
  return String(value || "").trim();
}

function asNumber(value: unknown) {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function asInteger(value: unknown) {
  return Math.trunc(asNumber(value));
}

function asFlag(value: unknown) {
  if (typeof value === "boolean") return value;
  return ["1", "TRUE", "YES", "Y", "CO", "CÓ", "BAT BUOC", "BẮT BUỘC"].includes(asText(value).toUpperCase());
}

function asDate(value: unknown) {
  const parsed = parseImportDate(value);
  if (!parsed) throw new Error(`Ngày không hợp lệ: ${String(value || "(trống)")}`);
  return parsed;
}

function normalizeInventoryItemType(value: unknown) {
  const raw = asText(value).toUpperCase();
  const normalized = normalizeHeader(asText(value));
  const aliases: Record<string, string> = {
    material: "RAW_MATERIAL",
    raw: "RAW_MATERIAL",
    nvl: "RAW_MATERIAL",
    "nguyen lieu": "RAW_MATERIAL",
    "raw material": "RAW_MATERIAL",
    btp: "SEMI_FINISHED",
    semi: "SEMI_FINISHED",
    "ban thanh pham": "SEMI_FINISHED",
    "semi finished": "SEMI_FINISHED",
    "semi finished good": "SEMI_FINISHED",
    tp: "FINISHED",
    product: "FINISHED",
    "thanh pham": "FINISHED",
    finished: "FINISHED",
    "finished good": "FINISHED",
    packaging: "PACKAGING",
    baobi: "PACKAGING",
    "bao bi": "PACKAGING",
    tool: "TOOL",
    ccdc: "TOOL",
    asset: "ASSET",
    "tai san": "ASSET",
  };
  return aliases[normalized] || raw;
}

function jsonValue(value: unknown) {
  return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item);
}

function rowFingerprint(importType: ImportType, row: ParsedImportRow) {
  return createHash("sha256")
    .update(`${importType}:${jsonValue(row.values)}`)
    .digest("hex");
}

async function nextVoucherCode(
  tx: TxClient,
  voucherType: string,
  voucherDate: Date,
  branchCode: string,
  documentChannel: "CASH" | "BANK",
) {
  // Số thứ tự phải là max + 1 trong ĐÚNG chuỗi mã (loại phiếu + tháng + cửa hàng), không phải
  // COUNT: rollback xoá phiếu làm COUNT tụt xuống và mã cấp lại đâm trúng phiếu còn sống của
  // batch sau — người dùng chỉ thấy "Dữ liệu bị trùng" mà không có cách nào tự gỡ.
  // Hai commit chạy song song vẫn có thể lấy cùng một số; khi đó ràng buộc unique chặn một
  // batch với thông điệp rõ ràng, chạy lại là xong — còn hơn cấp trùng trong im lặng.
  const prefix = voucherCodePrefix({ voucherType, documentChannel, voucherDate, branchCode });
  const issued = await tx.financialVoucher.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  });
  return prefix + String(nextSeqFromCodes(issued.map((row) => row.code), prefix)).padStart(5, "0");
}

/** Cùng luật max + 1 cho mã chuyển tiền (QTVI/CTNB/NOPT nằm ở bảng MoneyTransfer). */
async function nextTransferCode(
  tx: TxClient,
  voucherType: string,
  voucherDate: Date,
  branchCode: string,
) {
  const prefix = voucherCodePrefix({ voucherType, voucherDate, branchCode });
  const issued = await tx.moneyTransfer.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  });
  return prefix + String(nextSeqFromCodes(issued.map((row) => row.code), prefix)).padStart(5, "0");
}

type CommitInput = {
  importType: ImportType;
  templateCode: string;
  fileName: string;
  uploadedBy: string;
  branchCode?: string;
  fileChecksum?: string;
  mapping: Record<string, string>;
  rows: ParsedImportRow[];
  expectedMasterType?: string;
};

type RollbackInput = {
  batchId: string;
  actor: string;
  note?: string;
};

function parseStoredJson(value: string | null) {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function assertPeriodOpen(
  tx: RawTxClient,
  period: string,
  branchCode?: string | null,
  action: "commit" | "rollback" = "rollback",
) {
  if (!period || !branchCode) return;
  const [branchPeriod, allBranchPeriod] = await Promise.all([
    tx.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode } } }),
    tx.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode: "ALL" } } }),
  ]);
  if (branchPeriod?.status === "CLOSED" || allBranchPeriod?.status === "CLOSED") {
    throw new Error(`Kỳ ${period} của cửa hàng ${branchCode} đã khóa, không thể ${action} batch import`);
  }
}

async function assertImportPeriodsOpen(tx: RawTxClient, batchId: string, importType: string, action: "commit" | "rollback" = "rollback") {
  if (importType === "BANK_STATEMENT") {
    const rows = await tx.bankStatementTransaction.findMany({ where: { importBatchId: batchId }, select: { transactionDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.transactionDate), row.branchCode);
  }
  if (importType === "PAYROLL") {
    const rows = await tx.payrollImportRow.findMany({ where: { importBatchId: batchId }, select: { period: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, row.period, row.branchCode);
  }
  if (importType === "VOUCHER") {
    const rows = await tx.financialVoucher.findMany({ where: { importBatchId: batchId }, select: { voucherDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.voucherDate), row.branchCode);
  }
  if (importType === "INTERNAL_TRANSFER") {
    const rows = await tx.moneyTransfer.findMany({ where: { importBatchId: batchId }, select: { transferDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.transferDate), row.branchCode);
  }
  if (importType === "DEBT_OPENING") {
    const rows = await tx.debtRecord.findMany({ where: { importBatchId: batchId }, select: { documentDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.documentDate), row.branchCode);
  }
  if (importType === "OPENING_BALANCE") {
    const rows = await tx.importRow.findMany({ where: { importBatchId: batchId }, select: { normalizedJson: true } });
    for (const row of rows) {
      const values = parseStoredJson(row.normalizedJson);
      await assertPeriodOpen(tx, asText(values.period), asText(values.branch_code));
    }
  }
  // Mọi loại import sinh phiếu kho đều chung luật khoá kỳ — kiểm kê/chế biến/hủy trước đây
  // không có nhánh nào nên ghi được vào tháng đã chốt sổ.
  if (["INVENTORY_TRANSACTION", "STOCKTAKE", "PRODUCTION", "WASTE"].includes(importType)) {
    const rows = await tx.inventoryTransaction.findMany({ where: { importBatchId: batchId }, select: { transactionDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.transactionDate), row.branchCode, action);
  }
  if (importType === "REVENUE_POS") {
    const rows = await tx.revenueImportRow.findMany({ where: { importBatchId: batchId }, select: { saleDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.saleDate), row.branchCode, action);
  }
  if (importType === "ASSET") {
    const rows = await tx.importRow.findMany({ where: { importBatchId: batchId, targetType: "ASSET" }, select: { normalizedJson: true } });
    for (const row of rows) {
      const values = parseStoredJson(row.normalizedJson);
      const purchaseDate = values.purchase_date ? asDate(values.purchase_date) : null;
      if (purchaseDate) await assertPeriodOpen(tx, periodFromDate(purchaseDate), asText(values.branch_code));
    }
  }
}

async function createStagingRows(
  tx: TxClient,
  batchId: string,
  importType: ImportType,
  rows: ParsedImportRow[],
) {
  await tx.importRow.createMany({
    data: rows.map((row) => ({
      importBatchId: batchId,
      sheetName: row.sheetName,
      sourceRowNumber: row.rowNumber,
      rawJson: jsonValue(row.rawValues),
      normalizedJson: jsonValue(row.values),
      errorJson: row.errors.length ? jsonValue(row.errors) : null,
      rowFingerprint: rowFingerprint(importType, row),
    })),
  });
  const stagingRows = await tx.importRow.findMany({ where: { importBatchId: batchId } });
  return new Map(stagingRows.map((row) => [`${row.sheetName}:${row.sourceRowNumber}`, row.id]));
}

async function setImportTarget(
  tx: TxClient,
  staging: Map<string, string>,
  row: ParsedImportRow,
  targetType: string,
  targetId: string,
) {
  const importRowId = staging.get(`${row.sheetName}:${row.rowNumber}`);
  if (!importRowId) return;
  await tx.importRow.update({ where: { id: importRowId }, data: { targetType, targetId } });
}

export async function commitImport(input: CommitInput) {
  if (input.importType === "MASTER_DATA") {
    const expectedMasterType = asText(input.expectedMasterType).toUpperCase();
    if (expectedMasterType && !isMasterDataImportType(expectedMasterType)) {
      throw new Error(`Loại danh mục yêu cầu [${expectedMasterType}] không được hỗ trợ import`);
    }
    for (const row of input.rows) {
      const masterType = asText(row.values.type).toUpperCase();
      if (!isMasterDataImportType(masterType)) {
        throw new Error(`Dòng ${row.rowNumber}: Loại danh mục [${masterType || "trống"}] không hợp lệ`);
      }
      if (expectedMasterType && masterType !== expectedMasterType) {
        throw new Error(`Dòng ${row.rowNumber}: Chỉ được import loại ${expectedMasterType}, không chấp nhận ${masterType}`);
      }
    }
  }
  if (input.importType === "REVENUE_POS") {
    const referenceKeys = input.rows.map((row) => {
      ensureRevenuePosReference(row.values);
      return revenuePosReferenceKey(row.values);
    });
    if (new Set(referenceKeys).size !== referenceKeys.length) {
      throw new Error("File có các dòng doanh thu trùng Mã tham chiếu POS");
    }
  }
  const errorRows = input.rows.filter((row) => row.errors.length > 0);
  if (errorRows.length > 0) throw new Error("File còn dòng lỗi, vui lòng sửa trước khi commit");
  if (input.rows.length === 0) throw new Error("File không có dòng dữ liệu để commit");

  const payableAssetRows = input.importType === "ASSET"
    ? input.rows.filter((row) => asText(row.values.payment_status).toUpperCase() === "PAYABLE")
    : [];
  for (const row of payableAssetRows) {
    const purchaseDate = asDate(row.values.purchase_date);
    const branchCode = asText(row.values.branch_code);
    if (await isPeriodLocked(purchaseDate, branchCode)) {
      throw new Error(`Kỳ ${periodFromDate(purchaseDate)} của ${branchCode} đã khóa, không thể import công nợ tài sản`);
    }
  }
  const assetAccounts = payableAssetRows.length > 0 ? await ensureDefaultAccounts() : [];
  const assetAccountByCode = new Map(assetAccounts.map((account) => [account.code, account.id]));

  const batchResult = await prisma.$transaction(async (tx) => {
    if (input.fileChecksum) {
      const duplicateBatch = await tx.importBatch.findFirst({
        where: {
          fileChecksum: input.fileChecksum,
          templateCode: input.templateCode,
          branchCode: input.branchCode || null,
          status: { in: ["COMMITTED", "APPROVED"] },
        },
        select: { id: true, fileName: true },
      });
      if (duplicateBatch) throw new Error(`File này đã được commit trong batch ${duplicateBatch.id} (${duplicateBatch.fileName})`);
    }

    // BANK_STATEMENT được kiểm tra theo nhóm khi ghi: dòng trùng trong file có thể là
    // phân bổ hợp lệ, còn giao dịch đã tồn tại sẽ được bỏ qua thay vì rollback cả batch.

    if (input.importType === "REVENUE_POS") {
      const duplicateKeys = await Promise.all(input.rows.map((row) => tx.revenueImportRow.findUnique({
        where: {
          branchCode_saleDate_externalRef: {
            branchCode: asText(row.values.branch_code),
            saleDate: asDate(row.values.sale_date),
            externalRef: asText(row.values.external_ref),
          },
        },
        select: { id: true },
      })));
      if (duplicateKeys.some(Boolean)) throw new Error("File có dòng doanh thu trùng với dữ liệu đã import");
    }

    if (input.importType === "PAYROLL") {
      const duplicateKeys = await Promise.all(input.rows.map((row) => tx.payrollImportRow.findUnique({
        where: {
          period_employeeCode_branchCode: {
            period: asText(row.values.period),
            employeeCode: asText(row.values.employee_code),
            branchCode: asText(row.values.branch_code),
          },
        },
        select: { id: true },
      })));
      if (duplicateKeys.some(Boolean)) throw new Error("File có nhân viên trùng kỳ lương và chi nhánh");
    }

    if (["VOUCHER", "INTERNAL_TRANSFER", "DEBT_OPENING", "INVENTORY_TRANSACTION", "BOM", "STOCKTAKE", "ASSET"].includes(input.importType)) {
      const fingerprints = input.rows.map((row) => rowFingerprint(input.importType, row));
      if (new Set(fingerprints).size !== fingerprints.length) throw new Error("File có các dòng nghiệp vụ bị trùng nhau");
      const existing = await tx.importRow.findFirst({
        where: {
          rowFingerprint: { in: fingerprints },
          targetType: input.importType,
          importBatch: { status: { in: ["COMMITTED", "APPROVED"] } },
        },
        select: { importBatchId: true, sourceRowNumber: true },
      });
      if (existing) throw new Error(`Dữ liệu đã tồn tại trong batch ${existing.importBatchId}, dòng ${existing.sourceRowNumber}`);
    }

    if (input.importType === "ASSET") {
      const explicitCodes = input.rows.map((row) => asText(row.values.asset_code).toUpperCase()).filter(Boolean);
      if (new Set(explicitCodes).size !== explicitCodes.length) throw new Error("File co ma tai san/CCDC bi trung nhau");
      if (explicitCodes.length > 0) {
        const existingAsset = await tx.assetRecord.findFirst({
          where: { code: { in: explicitCodes }, deletedAt: undefined },
          select: { code: true },
        });
        if (existingAsset) throw new Error(`Ma tai san ${existingAsset.code} da ton tai, khong tu ghi de khi import hang loat`);
      }
    }

    if (input.importType === "VOUCHER") {
      const referenceRows = input.rows.filter((row) => asText(row.values.external_ref));
      const referenceKeys = referenceRows.map((row) => [
        asText(row.values.branch_code).toUpperCase(),
        asText(row.values.voucher_type).toUpperCase(),
        asText(row.values.external_ref).toUpperCase(),
      ].join(":"));
      if (new Set(referenceKeys).size !== referenceKeys.length) {
        throw new Error("File có Số giao dịch Thu/Chi bị trùng nhau");
      }
      const existingReference = await tx.financialVoucher.findFirst({
        where: {
          OR: referenceRows.map((row) => ({
            branchCode: asText(row.values.branch_code),
            voucherType: asText(row.values.voucher_type),
            externalRef: { equals: asText(row.values.external_ref), mode: "insensitive" },
          })),
        },
        select: { code: true, externalRef: true },
      });
      if (existingReference) {
        throw new Error(`Số giao dịch ${existingReference.externalRef} đã tồn tại ở chứng từ ${existingReference.code}`);
      }
    }

    if (input.importType === "INTERNAL_TRANSFER") {
      const referenceRows = input.rows.filter((row) => asText(row.values.external_ref));
      const referenceKeys = referenceRows.map((row) => [
        asText(row.values.branch_code).toUpperCase(),
        asText(row.values.external_ref).toUpperCase(),
      ].join(":"));
      if (new Set(referenceKeys).size !== referenceKeys.length) {
        throw new Error("File có Số giao dịch điều tiền bị trùng nhau");
      }
      const existingReference = await tx.moneyTransfer.findFirst({
        where: {
          OR: referenceRows.map((row) => ({
            branchCode: asText(row.values.branch_code),
            externalRef: { equals: asText(row.values.external_ref), mode: "insensitive" },
          })),
        },
        select: { code: true, externalRef: true },
      });
      if (existingReference) {
        throw new Error(`Số giao dịch ${existingReference.externalRef} đã tồn tại ở lệnh điều tiền ${existingReference.code}`);
      }
    }

    const batch = await tx.importBatch.create({
      data: {
        importType: input.importType,
        templateCode: input.templateCode,
        fileName: input.fileName,
        branchCode: input.branchCode || null,
        fileChecksum: input.fileChecksum || null,
        uploadedBy: input.uploadedBy,
        status: "COMMITTED",
        totalRows: input.rows.length,
        validRows: input.rows.length,
        errorRows: 0,
        mappingJson: JSON.stringify(input.mapping),
        committedAt: new Date(),
      },
    });
    const staging = await createStagingRows(tx, batch.id, input.importType, input.rows);

    if (input.importType === "BANK_STATEMENT") {
      const groups = groupBankStatementRows(input.rows);

      for (const group of groups) {
        const firstRow = group.rows[0];
        const bankAccount = asText(firstRow.values.bank_account);
        const transactionCode = asText(firstRow.values.transaction_code);
        const existing = await tx.bankStatementTransaction.findFirst({
          where: { bankAccount, transactionCode },
          select: { id: true },
        });
        if (existing) {
          for (const row of group.rows) await setImportTarget(tx, staging, row, "BANK_STATEMENT_EXISTING", existing.id);
          continue;
        }

        const sourceDateText = commonBankValue(group.rows, "source_date");
        const revenueDateText = commonBankValue(group.rows, "revenue_date");
        const sourceDate = sourceDateText ? asDate(sourceDateText) : null;
        const revenueDate = revenueDateText ? asDate(revenueDateText) : null;
        const statementDate = asDate(firstRow.values.transaction_date);
        const accountingDateValue = commonBankValue(group.rows, "accounting_date")
          ? asDate(commonBankValue(group.rows, "accounting_date"))
          : statementDate;
        const branchCodeForPeriod = asText(firstRow.values.branch_code);
        await assertPeriodOpen(tx as unknown as RawTxClient, periodFromDate(statementDate), branchCodeForPeriod, "commit");
        if (sourceDate && periodFromDate(sourceDate) !== periodFromDate(statementDate)) {
          await assertPeriodOpen(tx as unknown as RawTxClient, periodFromDate(sourceDate), branchCodeForPeriod, "commit");
        }
        if (periodFromDate(accountingDateValue) !== periodFromDate(statementDate)) {
          await assertPeriodOpen(tx as unknown as RawTxClient, periodFromDate(accountingDateValue), branchCodeForPeriod, "commit");
        }
        const operationType = commonBankValue(group.rows, "operation_type");
        const autoProcessType = group.isNetZero
          ? "NET_ZERO"
          : commonBankValue(group.rows, "auto_process_type");
        if (!group.isNetZero && !autoProcessType) throw new Error(`Giao dịch ${transactionCode} thiếu Loại nghiệp vụ đích hợp lệ`);
        let autoProcessNote = group.isNetZero
          ? "Cặp Nợ/Có đảo nhau, giá trị ròng 0 đ — không tạo phiếu"
          : commonBankValue(group.rows, "auto_process_note") || null;

        const bankTransaction = await tx.bankStatementTransaction.create({
          data: {
            importBatchId: batch.id,
            transactionDate: statementDate,
            bankAccount,
            transactionCode,
            description: group.rows.length === 1
              ? asText(firstRow.values.description)
              : `${asText(firstRow.values.description)} (${group.rows.length} dòng phân bổ)`,
            debitAmount: group.debitAmount,
            creditAmount: group.creditAmount,
            balanceAfter: group.rows.length === 1 && firstRow.values.balance_after !== null
              ? asNumber(firstRow.values.balance_after)
              : null,
            branchCode: asText(firstRow.values.branch_code) || null,
            partnerHint: commonBankValue(group.rows, "partner_hint") || null,
            categoryCode: commonBankValue(group.rows, "category_code") || null,
            sourceDate,
            revenueDate,
            summaryMoneySourceCode: commonBankValue(group.rows, "summary_money_source_code") || null,
            increaseMoneySourceCode: commonBankValue(group.rows, "increase_money_source_code") || null,
            decreaseMoneySourceCode: commonBankValue(group.rows, "decrease_money_source_code") || null,
            operationType: operationType || null,
            accountingDate: accountingDateValue,
            partnerCode: commonBankValue(group.rows, "partner_code") || null,
            pnlItemCode: commonBankValue(group.rows, "pnl_item_code") || null,
            debtReference: commonBankValue(group.rows, "debt_reference") || null,
            depositCode: commonBankValue(group.rows, "deposit_code") || null,
            grossAmount: group.rows.reduce((sum, row) => sum + asNumber(row.values.gross_amount), 0) || null,
            grabExpenseAmount: group.rows.reduce((sum, row) => sum + asNumber(row.values.grab_expense_amount), 0),
            cardFeeAmount: group.rows.reduce((sum, row) => sum + asNumber(row.values.card_fee_amount), 0),
            autoProcessType,
            autoProcessNote,
            reconcileStatus: group.isNetZero ? "MATCHED" : "UNMATCHED",
          },
        });
        await tx.bankStatementAllocation.createMany({
          data: group.rows.map((row) => ({
            bankTransactionId: bankTransaction.id,
            sourceRowNumber: row.rowNumber,
            sheetName: row.sheetName,
            description: asText(row.values.description),
            debitAmount: asNumber(row.values.debit_amount),
            creditAmount: asNumber(row.values.credit_amount),
            sourceDate: row.values.source_date ? asDate(row.values.source_date) : null,
            revenueDate: row.values.revenue_date ? asDate(row.values.revenue_date) : null,
            categoryCode: asText(row.values.category_code) || null,
            summaryMoneySourceCode: asText(row.values.summary_money_source_code) || null,
            increaseMoneySourceCode: asText(row.values.increase_money_source_code) || null,
            decreaseMoneySourceCode: asText(row.values.decrease_money_source_code) || null,
            operationType: asText(row.values.operation_type) || null,
            accountingDate: row.values.accounting_date ? asDate(row.values.accounting_date) : asDate(row.values.transaction_date),
            partnerCode: asText(row.values.partner_code) || null,
            pnlItemCode: asText(row.values.pnl_item_code) || null,
            debtReference: asText(row.values.debt_reference) || null,
            depositCode: asText(row.values.deposit_code) || null,
            grossAmount: asNumber(row.values.gross_amount) || null,
            grabExpenseAmount: asNumber(row.values.grab_expense_amount),
            cardFeeAmount: asNumber(row.values.card_fee_amount),
            autoProcessType: asText(row.values.auto_process_type) || null,
            autoProcessNote: asText(row.values.auto_process_note) || null,
          })),
        });
        for (const row of group.rows) await setImportTarget(tx, staging, row, "BANK_STATEMENT", bankTransaction.id);

        if (autoProcessType === "NET_ZERO") continue;
        try {
        if (autoProcessType === "MANUAL_REQUIRED") throw new BankRowNeedsFixError("Dòng này cần khảo sát tay: Preview đã đánh dấu không tự lập được chứng từ");
        const branchCode = asText(firstRow.values.branch_code);
        const transactionDate = asDate(firstRow.values.transaction_date);
        const accountingDateText = commonBankValue(group.rows, "accounting_date");
        const documentDate = accountingDateText ? asDate(accountingDateText) : transactionDate;
        const bankAmount = Math.round(group.creditAmount || group.debitAmount);
        const increaseSourceCode = commonBankValue(group.rows, "increase_money_source_code");
        const decreaseSourceCode = commonBankValue(group.rows, "decrease_money_source_code");
        const categoryCode = commonBankValue(group.rows, "category_code");
        const [increaseSource, decreaseSource, category] = await Promise.all([
          increaseSourceCode
            ? tx.masterDataItem.findFirst({
                where: { type: "MONEY_SOURCE", code: increaseSourceCode, deletedAt: null },
                select: { code: true, name: true, group: true, status: true },
              })
            : null,
          decreaseSourceCode
            ? tx.masterDataItem.findFirst({
                where: { type: "MONEY_SOURCE", code: decreaseSourceCode, deletedAt: null },
                select: { code: true, name: true, group: true, status: true },
              })
            : null,
          categoryCode
            ? tx.masterDataItem.findFirst({
                where: { type: "REVENUE_EXPENSE_CATEGORY", code: categoryCode, deletedAt: null },
                select: { code: true, name: true, group: true, status: true },
              })
            : null,
        ]);
        let targetType = "VOUCHER";
        let targetId = "";
        let targetCode = "";

        if (autoProcessType === "WALLET_SETTLEMENT") {
          const walletSourceCode = decreaseSourceCode;
          const bankSourceCode = increaseSourceCode;
          const allocationGross = group.rows.map((row) => {
            const rowRevenueDate = row.values.revenue_date ? asDate(row.values.revenue_date) : null;
            const rowBankAmount = Math.round(asNumber(row.values.credit_amount));
            return {
              row,
              rowRevenueDate,
              rowBankAmount,
              grossAmount: Math.round(asNumber(row.values.gross_amount)),
              grabExpenseAmount: Math.round(asNumber(row.values.grab_expense_amount)),
              cardFeeAmount: Math.round(asNumber(row.values.card_fee_amount)),
            };
          });
          // File có thể không khai Gross ví (số này thuộc luồng doanh thu POS). Khi đó vẫn ghi
          // nhận đủ tiền đã về ngân hàng, coi gross bằng đúng số thực nhận và để phí bằng 0;
          // phần chênh sẽ lộ ra ở bảng đối chiếu khi doanh thu POS của ngày đó được import.
          const declaredGross = allocationGross.some((item) => item.grossAmount > 0);
          const invalidAllocation = allocationGross.find((item) => !item.rowRevenueDate
            || (declaredGross && (item.grossAmount < item.rowBankAmount || item.grossAmount <= 0)));
          const grossAmount = declaredGross
            ? allocationGross.reduce((sum, item) => sum + item.grossAmount, 0)
            : bankAmount;
          if (invalidAllocation || grossAmount < bankAmount) throw new BankRowNeedsFixError("Gross ví khai trên file không cân với số tiền ngân hàng ghi có — sửa cột Gross/Phí trên file rồi import lại, hoặc để trống để hệ thống tự suy từ doanh thu POS");
          for (const allocation of allocationGross) {
            await tx.bankStatementAllocation.updateMany({
              where: {
                bankTransactionId: bankTransaction.id,
                sheetName: allocation.row.sheetName,
                sourceRowNumber: allocation.row.rowNumber,
              },
              data: { grossAmount: allocation.grossAmount },
            });
          }
          const feeAmount = grossAmount - bankAmount;
          const grabExpenseAmount = allocationGross.reduce((sum, item) => sum + item.grabExpenseAmount, 0);
          const cardFeeAmount = allocationGross.reduce((sum, item) => sum + item.cardFeeAmount, 0);
          if (declaredGross && Math.abs(feeAmount - grabExpenseAmount - cardFeeAmount) > 1) {
            throw new BankRowNeedsFixError("Tổng phí ví không bằng Phí Grab cộng Phí cà thẻ — sửa hai cột phí trên file cho khớp");
          }
          const approval = evaluateBankStatementAutoApproval({
            autoProcessType,
            debitAmount: group.debitAmount,
            creditAmount: group.creditAmount,
            branchCode,
            revenueDate,
            increaseSource,
            decreaseSource,
            category,
            walletGrossAmount: grossAmount,
            categoryCodeText: categoryCode,
            increaseSourceCodeText: increaseSourceCode,
            decreaseSourceCodeText: decreaseSourceCode,
          });
          if (!approval.autoApprove) {
            throw new BankRowNeedsFixError(approval.reason);
          }
          const transfer = await tx.moneyTransfer.create({
            data: {
              importBatchId: batch.id,
              code: await nextTransferCode(tx, "QTVI", documentDate, branchCode),
              transferDate: documentDate,
              branchCode,
              fromMoneySourceCode: walletSourceCode,
              toMoneySourceCode: bankSourceCode,
              amount: bankAmount,
              feeAmount,
              feeCategoryCode: cardFeeAmount > 0 ? WALLET_CARD_FEE_CATEGORY_CODE : null,
              grabExpenseAmount,
              grabExpenseCategoryCode: grabExpenseAmount > 0 ? WALLET_GRAB_EXPENSE_CATEGORY_CODE : null,
              externalRef: transactionCode,
              description: `Quyết toán ví theo sao kê ${transactionCode}${group.rows.length > 1 ? ` (${group.rows.length} ngày doanh thu)` : ""}${feeAmount > 0 ? ` (phí ${feeAmount.toLocaleString("vi-VN")} đ)` : ""}${declaredGross ? "" : " — chưa có doanh thu ví để tính phí"}`,
              transferPurpose: "WALLET_SETTLEMENT",
              sourceReportDate: revenueDate,
              status: "APPROVED",
              createdBy: input.uploadedBy,
              approvedBy: input.uploadedBy,
            },
          });
          targetType = "WALLET_SETTLEMENT";
          targetId = transfer.id;
          targetCode = transfer.code;
          autoProcessNote = declaredGross
            ? `Đã ghi nhận quyết toán Ví theo gross/phí khách khai trên file với ${targetCode}`
            : `Đã ghi nhận ${targetCode} theo số tiền ngân hàng thực nhận; phí ví đối chiếu sau khi có doanh thu POS`;
        } else if (operationType === "INTERNAL_TRANSFER") {
          const transfer = await tx.moneyTransfer.create({
            data: {
              importBatchId: batch.id,
              code: await nextTransferCode(tx, "CTNB", documentDate, branchCode),
              transferDate: documentDate,
              branchCode,
              fromMoneySourceCode: decreaseSourceCode,
              toMoneySourceCode: increaseSourceCode,
              amount: bankAmount,
              externalRef: transactionCode,
              description: asText(firstRow.values.description),
              transferPurpose: "INTERNAL_TRANSFER",
              sourceReportDate: sourceDate || transactionDate,
              status: "APPROVED",
              createdBy: input.uploadedBy,
              approvedBy: input.uploadedBy,
              approvedAt: new Date(),
            },
          });
          targetType = "INTERNAL_TRANSFER";
          targetId = transfer.id;
          targetCode = transfer.code;
        } else {
          const voucherType = autoProcessType === "PAYMENT" ? "PAYMENT" : "RECEIPT";
          const moneySourceCode = voucherType === "RECEIPT"
            ? increaseSourceCode
            : decreaseSourceCode;
          const approval = evaluateBankStatementAutoApproval({
            autoProcessType,
            debitAmount: group.debitAmount,
            creditAmount: group.creditAmount,
            branchCode,
            revenueDate,
            increaseSource,
            decreaseSource,
            category,
            categoryCodeText: categoryCode,
            increaseSourceCodeText: increaseSourceCode,
            decreaseSourceCodeText: decreaseSourceCode,
          });
          if (!approval.autoApprove) {
            throw new BankRowNeedsFixError(approval.reason);
          }
          const partnerCode = commonBankValue(group.rows, "partner_code") || null;
          const partner = partnerCode
            ? await tx.masterDataItem.findFirst({
                where: { type: "PARTNER", code: partnerCode, status: "ACTIVE", deletedAt: null },
                select: { code: true, name: true },
              })
            : null;
          // Một mã giao dịch trả cho nhiều đối tác: các dòng file khác đối tác/mã công nợ
          // thành bảng phân bổ trên chứng từ, gạch nợ từng dòng — commonBankValue lúc này
          // trả rỗng nên partner tổng của phiếu để trống, tên phiếu ghi số đối tác.
          const rowPartnerCodes = group.rows.map((row) => asText(row.values.partner_code)).filter(Boolean);
          const isMultiPartnerGroup = group.rows.length > 1 && !partnerCode && rowPartnerCodes.length > 0;
          const multiPartnerByCode = isMultiPartnerGroup
            ? new Map((await tx.masterDataItem.findMany({
                where: { type: "PARTNER", code: { in: [...new Set(rowPartnerCodes)] }, deletedAt: null },
                select: { code: true, name: true },
              })).map((row) => [row.code, row.name]))
            : new Map<string, string>();
          const isSalesReceipt = operationType === "REVENUE_RECEIPT";
          const businessEffect = isSalesReceipt ? "SETTLEMENT" : "RECOGNITION";
          const counterpartyName = commonBankValue(group.rows, "partner_hint") || null;
          const depositAction = operationType === "DEPOSIT_RECEIPT" ? "COLLECT"
            : operationType === "DEPOSIT_REFUND" ? "REFUND"
            : null;
          // Chỉ gạch sổ nợ (SETTLE) khi file khai Mã công nợ cụ thể. Khai mỗi Mã đối tác
          // phải thu/phải trả thì chứng từ vẫn lập và gắn đối tác — trước đây các dòng này
          // kẹt lại vì SETTLE bắt buộc có mã công nợ, đúng case "thanh toán công nợ chưa
          // bắt hết" khách báo.
          const debtAction = ["AR_COLLECTION", "AP_PAYMENT"].includes(operationType)
            && commonBankValue(group.rows, "debt_reference") ? "SETTLE" : null;
          const voucher = await tx.financialVoucher.create({
            data: {
              importBatchId: batch.id,
              code: await nextVoucherCode(tx, voucherType, documentDate, branchCode, "BANK"),
              sourceDocumentCode: null,
              voucherType,
              voucherDate: documentDate,
              partnerCode: partner?.code || null,
              partnerName: partner?.name
                || (isMultiPartnerGroup ? `${new Set(rowPartnerCodes).size} đối tác theo sao kê` : null)
                || counterpartyName
                // Tên trung thực thay cho "Đối tác theo sao kê" cũ: dòng này thiếu Mã đối tác
                // thật trên file (chỉ còn xảy ra với loại chi phí không bắt buộc đối tác).
                || "Chưa khai đối tác",
              branchCode,
              sourceScope: "BANK_STATEMENT_AUTO",
              documentChannel: "BANK",
              businessEffect,
              moneySourceCode,
              categoryCode: categoryCode || null,
              pnlItemCode: commonBankValue(group.rows, "pnl_item_code") || null,
              counterpartyAccountName: counterpartyName,
              depositAction,
              depositCode: commonBankValue(group.rows, "deposit_code") || null,
              debtAction,
              debtReference: commonBankValue(group.rows, "debt_reference") || null,
              externalRef: transactionCode,
              amount: bankAmount,
              description: group.rows.length === 1
                ? asText(firstRow.values.description)
                : `${asText(firstRow.values.description)} (${group.rows.length} dòng phân bổ)`,
              status: "APPROVED",
              createdBy: input.uploadedBy,
              approvedBy: input.uploadedBy,
            },
          });
          if (isMultiPartnerGroup) {
            await tx.voucherAllocation.createMany({
              data: group.rows
                .filter((row) => asText(row.values.partner_code))
                .map((row) => ({
                  voucherId: voucher.id,
                  partnerCode: asText(row.values.partner_code),
                  partnerName: multiPartnerByCode.get(asText(row.values.partner_code)) || asText(row.values.partner_code),
                  amount: asNumber(row.values.credit_amount) || asNumber(row.values.debit_amount),
                  debtReference: asText(row.values.debt_reference) || null,
                  note: asText(row.values.description) || null,
                })),
            });
          }
          if (depositAction || debtAction || isMultiPartnerGroup) {
            await applyVoucherSideEffects(tx as unknown as RawTxClient, voucher, input.uploadedBy);
          }
          targetId = voucher.id;
          targetCode = voucher.code;
          autoProcessNote = `Đã tạo ${targetCode} theo Loại nghiệp vụ đích ${operationType}`;
        }

        autoProcessNote = autoProcessType === "WALLET_SETTLEMENT" && autoProcessNote
          ? autoProcessNote
          : `Đã tự động duyệt và đối soát với ${targetCode}`;
        await tx.reconciliationMatch.create({
          data: {
            bankTransactionId: bankTransaction.id,
            targetType,
            targetId,
            targetCode,
            targetDate: documentDate,
            targetAmount: bankAmount,
            matchedAmount: bankAmount,
            status: "MATCHED",
            note: "Tạo tự động từ các cột nghiệp vụ trên file sao kê",
            matchedBy: input.uploadedBy,
          },
        });
        await tx.bankStatementTransaction.update({
          where: { id: bankTransaction.id },
          data: {
            reconcileStatus: "MATCHED",
            autoProcessNote: autoProcessNote || `Đã tạo chứng từ ${targetCode}`,
          },
        });
        } catch (error) {
          // Chỉ dòng này hỏng, không phải cả lô. Tiền vẫn được ghi nhận; chỉ thiếu chứng từ.
          // Lý do lưu lại nguyên văn để màn hình hiển thị đúng việc phải làm.
          if (!(error instanceof BankRowNeedsFixError)) throw error;
          await tx.bankStatementTransaction.update({
            where: { id: bankTransaction.id },
            data: {
              reconcileStatus: "UNMATCHED",
              autoProcessType: "MANUAL_REQUIRED",
              autoProcessNote: error.message,
            },
          });
        }
      }
    }

    if (input.importType === "REVENUE_POS") {
      for (const row of input.rows) {
        const productCode = asText(row.values.product_code).toUpperCase();
        const productQuantity = asNumber(row.values.product_quantity);
        const revenueRow = await tx.revenueImportRow.create({
          data: {
            importBatchId: batch.id,
            saleDate: asDate(row.values.sale_date),
            branchCode: asText(row.values.branch_code),
            channel: row.values.channel === null ? null : asText(row.values.channel),
            revenueSource: asText(row.values.revenue_source),
            paymentMethod: asText(row.values.payment_method),
            orderCount: row.values.order_count === null ? null : asInteger(row.values.order_count),
            grossAmount: asNumber(row.values.gross_amount),
            discountAmount: asNumber(row.values.discount_amount),
            vatAmount: asNumber(row.values.vat_amount),
            feeAmount: asNumber(row.values.fee_amount),
            netAmount: asNumber(row.values.net_amount),
            externalRef: asText(row.values.external_ref),
            productCode: productCode || null,
            productQuantity: productQuantity > 0 ? productQuantity : null,
            inventoryStatus: productCode && productQuantity > 0 ? "PENDING" : "NOT_REQUIRED",
          },
        });

        if (productCode) {
          const productName = asText(row.values.product_name) || `Mặt hàng ${productCode}`;
          const unit = asText(row.values.unit) || "Cái";
          await tx.inventoryItem.upsert({
            where: { code: productCode },
            create: {
              code: productCode,
              name: productName,
              unit,
              itemType: "FINISHED",
              minStock: 0,
            },
            update: {},
          });
        }

        await setImportTarget(tx, staging, row, "REVENUE_POS", revenueRow.id);
        if (productCode && productQuantity > 0) {
          const saleDate = asDate(row.values.sale_date);
          const posWarehouseCode = asText(row.values.warehouse_code);
          if (!posWarehouseCode) {
            // Trước đây rơi về "KHO_HCM" cứng — file thiếu cột kho là trừ nhầm kho của cửa hàng khác.
            throw new Error(`Dòng ${row.rowNumber}: dòng POS có trừ kho bắt buộc khai Kho xuất`);
          }
          // Công thức đúng là bản có hiệu lực TẠI NGÀY BÁN: import lại file POS của tháng trước
          // phải trừ kho theo công thức của tháng trước, không phải công thức vừa đổi hôm nay.
          const recipe = await tx.recipe.findFirst({
            where: { productCode, effectiveFrom: { lte: saleDate } },
            include: { lines: true },
            orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
          });
          if (recipe) {
            await postInventoryTransaction(tx, {
              importBatchId: batch.id,
              code: `XB-${asText(row.values.external_ref)}`,
              transactionType: "XUAT_BAN",
              transactionDate: saleDate,
              branchCode: asText(row.values.branch_code),
              warehouseCode: posWarehouseCode,
              referenceType: "REVENUE_POS",
              referenceId: revenueRow.id,
              referenceCode: asText(row.values.external_ref),
              note: `Tu dong tru kho POS ${productCode}`,
              createdBy: input.uploadedBy,
              lines: recipe.lines.map((line) => ({
                itemId: line.itemId,
                inputQuantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity,
                inputUnitCode: "",
                inputUnitCost: 0,
              })),
            });
          } else {
            const item = await tx.inventoryItem.findUnique({ where: { code: productCode } });
            if (item) {
              await postInventoryTransaction(tx, {
                importBatchId: batch.id,
                code: `XB-${asText(row.values.external_ref)}`,
                transactionType: "XUAT_BAN",
                transactionDate: saleDate,
                branchCode: asText(row.values.branch_code),
                warehouseCode: posWarehouseCode,
                referenceType: "REVENUE_POS",
                referenceId: revenueRow.id,
                referenceCode: asText(row.values.external_ref),
                note: `Tru kho truc tiep mat hang POS ${productCode}`,
                createdBy: input.uploadedBy,
                lines: [{
                  itemId: item.id,
                  inputQuantity: productQuantity,
                  inputUnitCode: item.unit,
                  inputUnitCost: 0,
                }],
              });
            }
          }
          await tx.revenueImportRow.update({
            where: { id: revenueRow.id },
            data: { inventoryStatus: "POSTED" },
          });
        }
      }
    }

    if (input.importType === "PAYROLL") {
      await tx.payrollImportRow.createMany({
        data: input.rows.map((row) => ({
          importBatchId: batch.id,
          period: asText(row.values.period),
          employeeCode: asText(row.values.employee_code),
          employeeName: asText(row.values.employee_name),
          branchCode: asText(row.values.branch_code),
          departmentCode: asText(row.values.department_code),
          baseSalary: asNumber(row.values.base_salary),
          allowanceAmount: asNumber(row.values.allowance_amount),
          bonusAmount: asNumber(row.values.bonus_amount),
          insuranceAmount: asNumber(row.values.insurance_amount),
          taxAmount: asNumber(row.values.tax_amount),
          deductionAmount: asNumber(row.values.deduction_amount),
          netAmount: asNumber(row.values.net_amount),
          externalRef: row.values.external_ref === null ? null : asText(row.values.external_ref),
        })),
      });
    }

    if (input.importType === "MASTER_DATA") {
      for (const row of input.rows) {
        const type = asText(row.values.type).toUpperCase();
        const code = asText(row.values.code).toUpperCase();
        const name = asText(row.values.name);
        const rawGroup = row.values.group ? asText(row.values.group).toUpperCase() : null;
        const group = type === "REVENUE_EXPENSE_CATEGORY"
          ? normalizeCashflowCategoryType(rawGroup)
          : rawGroup;
        const partnerGroup = row.values.partner_group ? asText(row.values.partner_group).toUpperCase() : "EXTERNAL";
        const branch = row.values.branch ? asText(row.values.branch).toUpperCase() : null;
        if (type === "PARTNER" && (!group || !["CUSTOMER", "SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(group))) {
          throw new Error(`Dòng ${row.rowNumber}: Nhóm đối tác không hợp lệ`);
        }
        if (type === "PARTNER" && !["EXTERNAL", "INTERNAL"].includes(partnerGroup)) {
          throw new Error(`Dòng ${row.rowNumber}: Nhóm đối tượng không hợp lệ`);
        }
        if (type === "MONEY_SOURCE" && (!group || !["CASH", "BANK", "WALLET"].includes(group))) {
          throw new Error(`Dòng ${row.rowNumber}: Nhóm nguồn tiền không hợp lệ`);
        }
        if (type === "REVENUE_EXPENSE_CATEGORY" && !["RECEIPT", "PAYMENT"].includes(group || "")) {
          throw new Error(`Dòng ${row.rowNumber}: Loại Thu/Chi phải là Thu hoặc Chi`);
        }
        const masterStatus = asText(row.values.status).toUpperCase();
        if (masterStatus && !["ACTIVE", "INACTIVE"].includes(masterStatus)) {
          throw new Error(`Dòng ${row.rowNumber}: Trạng thái chỉ nhận ACTIVE hoặc INACTIVE`);
        }
        // Cột không map thì không ghi đè — cùng luật với INVENTORY_ITEM.
        const hasMasterColumn = (field: string) => Boolean(input.mapping[field]);
        const item = await tx.masterDataItem.upsert({
          where: { type_code: { type, code } },
          create: {
            type, code, name, group, partnerType: type === "PARTNER" ? group : null, partnerGroup: type === "PARTNER" ? partnerGroup : null, branch,
            taxCode: row.values.tax_code ? asText(row.values.tax_code) : null,
            accountNo: row.values.account_no ? asText(row.values.account_no) : null,
            contactName: asText(row.values.contact_name) || null,
            phone: asText(row.values.phone) || null,
            email: asText(row.values.email) || null,
            note: asText(row.values.note) || null,
            status: masterStatus || "ACTIVE",
          },
          update: {
            name, group, partnerType: type === "PARTNER" ? group : null, partnerGroup: type === "PARTNER" ? partnerGroup : null, branch,
            taxCode: row.values.tax_code ? asText(row.values.tax_code) : null,
            accountNo: row.values.account_no ? asText(row.values.account_no) : null,
            ...(hasMasterColumn("contact_name") ? { contactName: asText(row.values.contact_name) || null } : {}),
            ...(hasMasterColumn("phone") ? { phone: asText(row.values.phone) || null } : {}),
            ...(hasMasterColumn("email") ? { email: asText(row.values.email) || null } : {}),
            ...(hasMasterColumn("note") ? { note: asText(row.values.note) || null } : {}),
            ...(hasMasterColumn("status") && masterStatus ? { status: masterStatus } : {}),
          },
        });
        await setImportTarget(tx, staging, row, "MASTER_DATA", item.id);
      }
    }

    if (input.importType === "INVENTORY_ITEM") {
      // Cột không được map thì KHÔNG ghi đè giá trị đang có: file thiếu cột "Yêu cầu hình ảnh"
      // mà cứ ghi asFlag(undefined) = false là mọi lần re-import đều reset cờ của item cũ.
      const hasColumn = (field: string) => Boolean(input.mapping[field]);
      // Nhiều dòng cùng mã = khai nhiều ĐVT quy đổi. Chỉ dòng ĐẦU TIÊN (hoặc dòng cắm cờ
      // "ĐVT mua mặc định") được isDefaultPurchase — trước đây mọi dòng đều true, mặc định
      // thành ngẫu nhiên theo thứ tự alphabet.
      const seenDefaultPurchase = new Set<string>();
      const upsertedItemIds = new Map<string, string>();
      for (const row of input.rows) {
        const code = asText(row.values.code).toUpperCase();
        const name = asText(row.values.name);
        const itemType = normalizeInventoryItemType(row.values.item_type);
        const category = asText(row.values.category).toUpperCase() || null;
        const unit = asText(row.values.unit);
        if (!['RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED', 'PACKAGING', 'TOOL', 'ASSET'].includes(itemType)) {
          throw new Error(`Dòng ${row.rowNumber}: Loại hàng không hợp lệ`);
        }
        const statusValue = asText(row.values.status).toUpperCase();
        if (statusValue && !["ACTIVE", "INACTIVE"].includes(statusValue)) {
          throw new Error(`Dòng ${row.rowNumber}: Trạng thái chỉ nhận ACTIVE hoặc INACTIVE`);
        }
        // Dòng LẶP MÃ trong cùng file chỉ để khai thêm ĐVT quy đổi — không đụng master data
        // lần nữa, nếu không ô trống của dòng sau sẽ đè giá trị dòng đầu (note, tồn tối thiểu...).
        const repeatedItemId = upsertedItemIds.get(code);
        if (repeatedItemId) {
          const purchaseUnitRepeat = row.values.purchase_unit ? asText(row.values.purchase_unit) : "";
          const conversionRateRepeat = row.values.conversion_rate ? asNumber(row.values.conversion_rate) : 0;
          if (purchaseUnitRepeat || conversionRateRepeat) {
            if (!purchaseUnitRepeat || conversionRateRepeat < 1) throw new Error(`Dòng ${row.rowNumber}: ĐVT mua và tỷ lệ quy đổi phải hợp lệ`);
            const explicitDefaultRepeat = hasColumn("is_default_purchase") ? asFlag(row.values.is_default_purchase) : !seenDefaultPurchase.has(code);
            const isDefaultRepeat = explicitDefaultRepeat && !seenDefaultPurchase.has(code);
            if (isDefaultRepeat) seenDefaultPurchase.add(code);
            await tx.itemUnitConversion.upsert({
              where: { itemId_unitCode: { itemId: repeatedItemId, unitCode: purchaseUnitRepeat.toUpperCase() } },
              create: { itemId: repeatedItemId, unitCode: purchaseUnitRepeat.toUpperCase(), unitName: purchaseUnitRepeat, conversionRate: conversionRateRepeat, isDefaultPurchase: isDefaultRepeat, note: asText(row.values.conversion_note) || null },
              update: { unitName: purchaseUnitRepeat, conversionRate: conversionRateRepeat, isDefaultPurchase: isDefaultRepeat, note: asText(row.values.conversion_note) || null },
            });
          }
          await setImportTarget(tx, staging, row, "INVENTORY_ITEM", repeatedItemId);
          continue;
        }
        const item = await tx.inventoryItem.upsert({
          where: { code },
          create: {
            code, name, itemType, category, unit,
            minStock: asNumber(row.values.min_stock),
            requiresImage: asFlag(row.values.requires_image),
            note: asText(row.values.note) || null,
            status: statusValue || "ACTIVE",
          },
          update: {
            name, itemType, category, unit,
            ...(hasColumn("min_stock") ? { minStock: asNumber(row.values.min_stock) } : {}),
            ...(hasColumn("requires_image") ? { requiresImage: asFlag(row.values.requires_image) } : {}),
            ...(hasColumn("note") ? { note: asText(row.values.note) || null } : {}),
            ...(hasColumn("status") && statusValue ? { status: statusValue } : {}),
          },
        });
        await tx.itemUnitConversion.upsert({
          where: { itemId_unitCode: { itemId: item.id, unitCode: unit.toUpperCase() } },
          create: { itemId: item.id, unitCode: unit.toUpperCase(), unitName: unit, conversionRate: 1, note: "ĐVT cơ bản" },
          update: { unitName: unit, conversionRate: 1 },
        });
        const purchaseUnit = row.values.purchase_unit ? asText(row.values.purchase_unit) : "";
        const conversionRate = row.values.conversion_rate ? asNumber(row.values.conversion_rate) : 0;
        if (purchaseUnit || conversionRate) {
          if (!purchaseUnit || conversionRate < 1) throw new Error(`Dòng ${row.rowNumber}: ĐVT mua và tỷ lệ quy đổi phải hợp lệ`);
          const explicitDefault = hasColumn("is_default_purchase") ? asFlag(row.values.is_default_purchase) : !seenDefaultPurchase.has(code);
          const isDefaultPurchase = explicitDefault && !seenDefaultPurchase.has(code);
          if (isDefaultPurchase) seenDefaultPurchase.add(code);
          await tx.itemUnitConversion.upsert({
            where: { itemId_unitCode: { itemId: item.id, unitCode: purchaseUnit.toUpperCase() } },
            create: { itemId: item.id, unitCode: purchaseUnit.toUpperCase(), unitName: purchaseUnit, conversionRate, isDefaultPurchase, note: asText(row.values.conversion_note) || null },
            update: { unitName: purchaseUnit, conversionRate, isDefaultPurchase, note: asText(row.values.conversion_note) || null },
          });
        }
        upsertedItemIds.set(code, item.id);
        await setImportTarget(tx, staging, row, "INVENTORY_ITEM", item.id);
      }
    }

    if (input.importType === "INVENTORY_TRANSACTION") {
      const groups = new Map<string, ParsedImportRow[]>();
      for (const row of input.rows) {
        const transactionType = normalizeStockTransactionType(row.values.transaction_type);
        const referenceCode = asText(row.values.reference_code) || `ROW-${row.rowNumber}`;
        const key = [
          referenceCode,
          transactionType,
          asText(row.values.branch_code).toUpperCase(),
          asText(row.values.warehouse_code).toUpperCase(),
          asText(row.values.to_warehouse_code).toUpperCase(),
        ].join("|");
        groups.set(key, [...(groups.get(key) || []), row]);
      }
      for (const rows of groups.values()) {
        const first = rows[0];
        const transactionDate = asDate(first.values.transaction_date);
        const transactionType = normalizeStockTransactionType(first.values.transaction_type);
        const prefix = transactionType === "NHAP_MUA" ? "NM" : transactionType === "NHAP_KHAC" ? "NK" : transactionType === "XUAT_HUY" ? "HH" : transactionType === "DIEU_CHUYEN" ? "DCK" : "XK";
        const transaction = await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: asText(first.values.reference_code) || await nextStockDocCode(tx, prefix, transactionDate),
          transactionType,
          transactionDate,
          branchCode: asText(first.values.branch_code),
          warehouseCode: asText(first.values.warehouse_code),
          toWarehouseCode: asText(first.values.to_warehouse_code) || null,
          referenceType: "IMPORT",
          referenceCode: asText(first.values.reference_code) || null,
          partnerCode: asText(first.values.partner_code) || null,
          note: asText(first.values.note) || null,
          createdBy: input.uploadedBy,
          lines: rows.map((row) => ({
            itemCode: asText(row.values.item_code).toUpperCase(),
            inputQuantity: asNumber(row.values.quantity),
            inputUnitCode: asText(row.values.unit_code),
            inputUnitCost: asNumber(row.values.unit_cost),
          })),
        });
        for (const row of rows) await setImportTarget(tx, staging, row, "INVENTORY_TRANSACTION", transaction.id);
      }
    }

    if (input.importType === "BOM") {
      // Gom theo MÓN + NGÀY HIỆU LỰC: một file được phép chứa nhiều phiên bản công thức của
      // cùng một món (V1 hiệu lực 01/07, V2 hiệu lực 01/08). Gom chỉ theo mã món như trước
      // là hai phiên bản dính thành một công thức cộng dồn nguyên liệu — trừ kho gấp đôi.
      const groups = new Map<string, ParsedImportRow[]>();
      for (const row of input.rows) {
        const productCode = asText(row.values.product_code).toUpperCase();
        const effective = asDate(row.values.effective_date).toISOString().slice(0, 10);
        groups.set(`${productCode}|${effective}`, [...(groups.get(`${productCode}|${effective}`) || []), row]);
      }
      // Tạo theo thứ tự ngày hiệu lực tăng dần để version tăng cùng chiều thời gian.
      const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [groupKey, rows] of orderedGroups) {
        const productCode = groupKey.split("|")[0];
        const latest = await tx.recipe.findFirst({ where: { productCode }, orderBy: { version: "desc" } });
        await tx.recipe.updateMany({ where: { productCode, status: "ACTIVE" }, data: { status: "INACTIVE" } });
        const recipe = await tx.recipe.create({
          data: {
            code: `${productCode}-V${(latest?.version || 0) + 1}`,
            productCode,
            productName: asText(rows[0].values.product_name),
            unit: "phan",
            sellingPrice: asNumber(rows[0].values.selling_price),
            version: (latest?.version || 0) + 1,
            effectiveFrom: asDate(rows[0].values.effective_date),
            note: asText(rows[0].values.note) || null,
            status: "ACTIVE",
            lines: {
              create: await Promise.all(rows.map(async (row) => {
                const item = await tx.inventoryItem.findUnique({ where: { code: asText(row.values.ingredient_code).toUpperCase() } });
                if (!item) throw new Error(`Dong ${row.rowNumber}: Khong tim thay nguyen lieu ${asText(row.values.ingredient_code)}`);
                return { itemId: item.id, quantity: asNumber(row.values.quantity), wasteRate: asNumber(row.values.waste_rate) };
              })),
            },
          },
        });
        for (const row of rows) await setImportTarget(tx, staging, row, "BOM", recipe.id);
      }
    }

    if (input.importType === "STOCKTAKE") {
      const groups = new Map<string, ParsedImportRow[]>();
      for (const row of input.rows) {
        const key = [
          asDate(row.values.stocktake_date).toISOString().slice(0, 10),
          asText(row.values.branch_code).toUpperCase(),
          asText(row.values.warehouse_code).toUpperCase(),
        ].join("|");
        groups.set(key, [...(groups.get(key) || []), row]);
      }
      for (const rows of groups.values()) {
        const first = rows[0];
        const stocktakeDate = asDate(first.values.stocktake_date);
        const stocktake = await tx.stocktakeSession.create({
          data: {
            code: asText(first.values.code) || await nextStocktakeCode(tx, stocktakeDate),
            stocktakeDate,
            branchCode: asText(first.values.branch_code),
            warehouseCode: asText(first.values.warehouse_code),
            status: "APPROVED",
            approvedBy: input.uploadedBy,
            approvedAt: new Date(),
            note: asText(first.values.note) || null,
            createdBy: input.uploadedBy,
          },
        });
        const inboundLines = [];
        const outboundLines = [];
        for (const row of rows) {
          const item = await tx.inventoryItem.findUnique({ where: { code: asText(row.values.item_code).toUpperCase() } });
          if (!item) throw new Error(`Dong ${row.rowNumber}: Khong tim thay mat hang ${asText(row.values.item_code)}`);
          if (!isWarehouseStocktakeItemType(item.itemType)) {
            throw new Error(`Dong ${row.rowNumber}: ${item.code} la CCDC/Tai san; hay kiem ke tai phan he Tai san & khau hao`);
          }
          const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: asText(first.values.warehouse_code) } } });
          const systemQuantity = balance?.quantity || 0;
          const actualQuantity = asNumber(row.values.actual_quantity);
          const varianceQuantity = actualQuantity - systemQuantity;
          await tx.stocktakeLine.create({
            data: { stocktakeId: stocktake.id, itemId: item.id, systemQuantity, actualQuantity, varianceQuantity, reason: asText(row.values.reason) || null },
          });
          await setImportTarget(tx, staging, row, "STOCKTAKE", stocktake.id);
          // Hàng đếm THỪA mà kho chưa có giá vốn thì phải khai "Đơn giá" trên file —
          // nhập giá 0 là giá trị kho sai và giá vốn món ăn theo sai vĩnh viễn.
          const declaredUnitCost = asNumber(row.values.unit_cost);
          const surplusUnitCost = (balance?.averageCost || 0) > 0 ? balance?.averageCost || 0 : declaredUnitCost;
          if (varianceQuantity > 0 && surplusUnitCost <= 0) {
            throw new Error(`Dong ${row.rowNumber}: ${item.code} chua co gia von trong kho — khai cot "Don gia" de ghi nhan phan thua`);
          }
          if (varianceQuantity > 0) inboundLines.push({ itemId: item.id, inputQuantity: varianceQuantity, inputUnitCode: item.unit, inputUnitCost: surplusUnitCost });
          if (varianceQuantity < 0) outboundLines.push({ itemId: item.id, inputQuantity: Math.abs(varianceQuantity), inputUnitCode: item.unit, inputUnitCost: 0 });
        }
        if (inboundLines.length > 0) await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: `${stocktake.code}-N`,
          transactionType: "NHAP_KIEM_KE",
          transactionDate: stocktakeDate,
          branchCode: asText(first.values.branch_code),
          warehouseCode: asText(first.values.warehouse_code),
          referenceType: "STOCKTAKE",
          referenceId: stocktake.id,
          referenceCode: stocktake.code,
          createdBy: input.uploadedBy,
          lines: inboundLines,
        });
        if (outboundLines.length > 0) await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: `${stocktake.code}-X`,
          transactionType: "XUAT_KIEM_KE",
          transactionDate: stocktakeDate,
          branchCode: asText(first.values.branch_code),
          warehouseCode: asText(first.values.warehouse_code),
          referenceType: "STOCKTAKE",
          referenceId: stocktake.id,
          referenceCode: stocktake.code,
          createdBy: input.uploadedBy,
          lines: outboundLines,
        });
      }
    }

    if (input.importType === "PRODUCTION") {
      for (const row of input.rows) {
        const productionDate = asDate(row.values.production_date);
        const productCode = asText(row.values.product_code).toUpperCase();
        const branchCode = asText(row.values.branch_code);
        const warehouseCode = asText(row.values.warehouse_code);
        const toWarehouseCode = asText(row.values.to_warehouse_code) || warehouseCode;
        const productQuantity = asNumber(row.values.product_quantity);
        const productItem = await tx.inventoryItem.findUnique({ where: { code: productCode } });
        if (!productItem) throw new Error(`Dong ${row.rowNumber}: Khong tim thay ban thanh pham ${productCode}`);
        // Cong thuc hieu luc TAI NGAY CHE BIEN — cung luat voi POS va man Che bien.
        const recipe = await tx.recipe.findFirst({
          where: { productCode, effectiveFrom: { lte: productionDate } },
          include: { lines: true },
          orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
        });
        if (!recipe || recipe.lines.length === 0) throw new Error(`Dong ${row.rowNumber}: Chua co BOM hieu luc tai ngay ${asText(row.values.production_date)} cho ${productCode}`);
        const referenceCode = asText(row.values.reference_code) || await nextStockDocCode(tx, "CB", productionDate);
        const issue = await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: `${referenceCode}-X`,
          transactionType: "XUAT_CHE_BIEN",
          transactionDate: productionDate,
          branchCode,
          warehouseCode,
          referenceType: "PRODUCTION",
          referenceCode,
          note: asText(row.values.note) || null,
          createdBy: input.uploadedBy,
          lines: recipe.lines.map((line) => ({
            itemId: line.itemId,
            inputQuantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity,
            inputUnitCode: "",
            inputUnitCost: 0,
          })),
        });
        const totalCost = issue.lines.reduce((sum, line) => sum + line.totalCost, 0);
        await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: `${referenceCode}-N`,
          transactionType: "NHAP_CHE_BIEN",
          transactionDate: productionDate,
          branchCode,
          warehouseCode: toWarehouseCode,
          referenceType: "PRODUCTION",
          referenceCode,
          note: asText(row.values.note) || null,
          createdBy: input.uploadedBy,
          lines: [{
            itemId: productItem.id,
            inputQuantity: productQuantity,
            inputUnitCode: productItem.unit,
            inputUnitCost: productQuantity > 0 ? totalCost / productQuantity : 0,
          }],
        });
        await setImportTarget(tx, staging, row, "PRODUCTION", issue.id);
      }
    }

    if (input.importType === "WASTE") {
      for (const row of input.rows) {
        const wasteDate = asDate(row.values.waste_date);
        const productCode = asText(row.values.product_code).toUpperCase();
        const productQuantity = asNumber(row.values.product_quantity);
        const recipe = await tx.recipe.findFirst({
          where: { productCode, effectiveFrom: { lte: wasteDate } },
          include: { lines: true },
          orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
        });
        if (!recipe || recipe.lines.length === 0) throw new Error(`Dong ${row.rowNumber}: Chua co BOM hieu luc tai ngay ${asText(row.values.waste_date)} cho ${productCode}`);
        const transaction = await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: await nextStockDocCode(tx, "HH", wasteDate),
          transactionType: "XUAT_HUY",
          transactionDate: wasteDate,
          branchCode: asText(row.values.branch_code),
          warehouseCode: asText(row.values.warehouse_code),
          referenceType: "POS_WASTE",
          referenceCode: productCode,
          note: `Huy ${productQuantity} x ${productCode}: ${asText(row.values.reason)}`,
          createdBy: input.uploadedBy,
          lines: recipe.lines.map((line) => ({
            itemId: line.itemId,
            inputQuantity: line.quantity * (1 + line.wasteRate / 100) * productQuantity,
            inputUnitCode: "",
            inputUnitCost: 0,
          })),
        });
        await setImportTarget(tx, staging, row, "WASTE", transaction.id);
      }
    }

    if (input.importType === "ASSET_STOCKTAKE") {
      const groups = new Map<string, ParsedImportRow[]>();
      for (const row of input.rows) {
        const key = [asDate(row.values.stocktake_date).toISOString().slice(0, 10), asText(row.values.branch_code).toUpperCase()].join("|");
        groups.set(key, [...(groups.get(key) || []), row]);
      }
      for (const rows of groups.values()) {
        const first = rows[0];
        const stocktakeDate = asDate(first.values.stocktake_date);
        const head = `KKTS-${stocktakeDate.getUTCFullYear()}-`;
        const issued = await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "AssetStocktakeSession" WHERE "code" LIKE ${head + "%"}`;
        const session = await tx.assetStocktakeSession.create({
          data: {
            importBatchId: batch.id,
            code: head + String(nextSeqFromCodes(issued.map((row) => row.code), head)).padStart(4, "0"),
            stocktakeDate,
            branchCode: asText(first.values.branch_code),
            status: "APPROVED",
            approvedBy: input.uploadedBy,
            approvedAt: new Date(),
            createdBy: input.uploadedBy,
          },
        });
        for (const row of rows) {
          const assetCode = asText(row.values.asset_code).toUpperCase();
          const asset = await tx.assetRecord.findUnique({ where: { code: assetCode } });
          if (!asset) throw new Error(`Dong ${row.rowNumber}: Khong tim thay tai san ${assetCode}`);
          const actualQuantity = asNumber(row.values.actual_quantity);
          await tx.assetStocktakeLine.create({
            data: {
              sessionId: session.id,
              assetId: asset.id,
              systemQuantity: asset.quantity,
              actualQuantity,
              varianceQuantity: actualQuantity - asset.quantity,
              condition: asText(row.values.condition) || null,
              note: asText(row.values.note) || null,
            },
          });
          // Duyệt kiểm kê = số đếm là số chốt: cập nhật số lượng sổ sách theo thực tế.
          await tx.assetRecord.update({ where: { id: asset.id }, data: { quantity: actualQuantity } });
          await setImportTarget(tx, staging, row, "ASSET_STOCKTAKE", session.id);
        }
      }
    }

    if (input.importType === "OPENING_BALANCE") {
      const openingKeys = Array.from(new Map(input.rows.map((row) => {
        const values = row.values;
        const key = [
          asText(values.period),
          asText(values.branch_code),
          asText(values.balance_type).toUpperCase(),
          asText(values.object_code).toUpperCase(),
          asText(values.money_source_code).toUpperCase(),
          asText(values.warehouse_code).toUpperCase(),
          asText(values.department_code).toUpperCase(),
        ].join("|");
        return [key, values];
      })).values());
      await tx.openingBalance.deleteMany({
        where: {
          OR: openingKeys.map((values) => ({
            period: asText(values.period),
            branchCode: asText(values.branch_code),
            balanceType: asText(values.balance_type).toUpperCase(),
            objectCode: asText(values.object_code) || null,
            moneySourceCode: asText(values.money_source_code) || null,
            warehouseCode: asText(values.warehouse_code) || null,
            departmentCode: asText(values.department_code) || null,
          })),
        },
      });
      for (const row of input.rows) {
        const opening = await tx.openingBalance.create({
          data: {
            period: asText(row.values.period),
            branchCode: asText(row.values.branch_code),
            balanceType: asText(row.values.balance_type).toUpperCase(),
            objectCode: row.values.object_code ? asText(row.values.object_code) : null,
            objectName: row.values.object_name ? asText(row.values.object_name) : null,
            moneySourceCode: row.values.money_source_code ? asText(row.values.money_source_code) : null,
            warehouseCode: row.values.warehouse_code ? asText(row.values.warehouse_code) : null,
            departmentCode: row.values.department_code ? asText(row.values.department_code) : null,
            quantity: row.values.quantity ? asNumber(row.values.quantity) : null,
            unitCost: row.values.unit_cost ? asNumber(row.values.unit_cost) : null,
            allocationMonths: row.values.allocation_months ? asInteger(row.values.allocation_months) : null,
            allocationStartPeriod: row.values.allocation_start_period ? asText(row.values.allocation_start_period) : null,
            amount: asNumber(row.values.amount),
            note: row.values.note ? asText(row.values.note) : null,
            status: "POSTED",
          },
        });
        await setImportTarget(tx, staging, row, "OPENING_BALANCE", opening.id);

        const balanceType = asText(row.values.balance_type).toUpperCase();
        if (balanceType === "DEPOSIT" && row.values.object_code) {
          const deposit = await applyOpeningDeposit(tx as Prisma.TransactionClient, {
            id: opening.id,
            period: opening.period,
            branchCode: opening.branchCode,
            objectCode: opening.objectCode,
            objectName: opening.objectName,
            moneySourceCode: opening.moneySourceCode,
            amount: opening.amount,
            note: opening.note,
          }, input.uploadedBy);
          await setImportTarget(tx, staging, row, "DEPOSIT", deposit.id);
        }

        if (balanceType === "INVENTORY" && row.values.object_code && row.values.warehouse_code) {
          const item = await tx.inventoryItem.findUnique({ where: { code: asText(row.values.object_code).toUpperCase() } });
          if (!item) throw new Error(`Dòng ${row.rowNumber}: Không tìm thấy mặt hàng ${asText(row.values.object_code)}`);
          const quantity = asNumber(row.values.quantity);
          const unitCost = row.values.unit_cost ? asNumber(row.values.unit_cost) : Math.abs(asNumber(row.values.amount) / quantity);
          await tx.inventoryBalance.upsert({
            where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: asText(row.values.warehouse_code) } },
            create: { itemId: item.id, warehouseCode: asText(row.values.warehouse_code), quantity, averageCost: unitCost },
            update: { quantity, averageCost: unitCost },
          });
          await setImportTarget(tx, staging, row, "INVENTORY_BALANCE", item.id);
        }

        if (balanceType === "ASSET" && row.values.object_code) {
          const code = asText(row.values.object_code).toUpperCase();
          const asset = await tx.assetRecord.upsert({
            where: { code },
            create: {
              code,
              name: asText(row.values.object_name) || code,
              branchCode: asText(row.values.branch_code),
              departmentCode: asText(row.values.department_code) || null,
              assetGroup: asText(row.values.money_source_code) || "ASSET",
              purchaseDate: new Date(`${asText(row.values.period)}-01T00:00:00Z`),
              originalCost: asNumber(row.values.amount),
              currentValue: asNumber(row.values.amount),
              quantity: row.values.quantity ? asNumber(row.values.quantity) : 1,
              note: asText(row.values.note) || "Tạo từ số dư đầu kỳ",
            },
            update: {
              name: asText(row.values.object_name) || code,
              branchCode: asText(row.values.branch_code),
              departmentCode: asText(row.values.department_code) || null,
              originalCost: asNumber(row.values.amount),
              currentValue: asNumber(row.values.amount),
              quantity: row.values.quantity ? asNumber(row.values.quantity) : 1,
              note: asText(row.values.note) || "Cập nhật từ số dư đầu kỳ",
            },
          });
          await setImportTarget(tx, staging, row, "ASSET", asset.id);
        }

        if (balanceType === "PREPAID_EXPENSE" && row.values.object_code) {
          const months = asInteger(row.values.allocation_months);
          const startPeriod = asText(row.values.allocation_start_period);
          const code = `PB-DK-${asText(row.values.object_code).toUpperCase()}`;
          const amount = asNumber(row.values.amount);
          const existing = await tx.accrual.findUnique({ where: { code } });
          if (existing) {
            await tx.accrualSchedule.deleteMany({ where: { accrualId: existing.id } });
            await tx.accrual.update({
              where: { id: existing.id },
              data: {
                name: asText(row.values.object_name) || code,
                branchCode: asText(row.values.branch_code),
                categoryCode: asText(row.values.money_source_code) || "OPEX",
                totalAmount: amount,
                startPeriod,
                numberOfPeriods: months,
                note: asText(row.values.note) || "Cập nhật từ chi phí phân bổ đầu kỳ",
                schedules: { create: Array.from({ length: months }, (_, index) => ({ period: addPeriod(startPeriod, index), amount: amount / months })) },
              },
            });
            await setImportTarget(tx, staging, row, "ACCRUAL", existing.id);
          } else {
            const accrual = await tx.accrual.create({
              data: {
                code,
                name: asText(row.values.object_name) || code,
                branchCode: asText(row.values.branch_code),
                categoryCode: asText(row.values.money_source_code) || "OPEX",
                totalAmount: amount,
                startPeriod,
                numberOfPeriods: months,
                note: asText(row.values.note) || "Tạo từ chi phí phân bổ đầu kỳ",
                createdBy: input.uploadedBy,
                schedules: { create: Array.from({ length: months }, (_, index) => ({ period: addPeriod(startPeriod, index), amount: amount / months })) },
              },
            });
            await setImportTarget(tx, staging, row, "ACCRUAL", accrual.id);
          }
        }
      }
    }

    if (input.importType === "ASSET") {
      for (const row of input.rows) {
        let code = asText(row.values.asset_code).toUpperCase();
        code = code
          ? await assertAssetCodeAvailable(tx, code)
          : await nextAssetCode(tx, asText(row.values.asset_group), asText(row.values.department_code));
        const originalCost = asNumber(row.values.original_cost);
        const paymentStatus = asText(row.values.payment_status).toUpperCase() || "PAID";
        const payableAmount = paymentStatus === "PAYABLE" ? (asNumber(row.values.payable_amount) || originalCost) : 0;
        const purchaseDate = asDate(row.values.purchase_date);
        const asset = await tx.assetRecord.create({
          data: {
            code,
            name: asText(row.values.asset_name),
            branchCode: asText(row.values.branch_code),
            departmentCode: asText(row.values.department_code) || null,
            assetGroup: asText(row.values.asset_group),
            imageUrl: asText(row.values.image_url) || null,
            location: asText(row.values.warehouse_code) || null,
            warehouseCode: asText(row.values.warehouse_code) || null,
            quantity: asNumber(row.values.quantity) || 1,
            purchaseDate,
            originalCost,
            currentValue: originalCost,
            usefulLifeMonths: row.values.useful_life_months ? asInteger(row.values.useful_life_months) : null,
            depreciationStartDate: row.values.depreciation_start_date ? asDate(row.values.depreciation_start_date) : null,
            residualValue: row.values.residual_value ? asNumber(row.values.residual_value) : 0,
            supplierCode: asText(row.values.supplier_code) || null,
            supplierName: asText(row.values.supplier_name) || null,
            paymentStatus,
            payableAmount,
            paymentDueDate: row.values.payment_due_date ? asDate(row.values.payment_due_date) : null,
            status: asText(row.values.status) || "IN_USE",
            note: asText(row.values.note) || null,
          },
        });
        if (paymentStatus === "PAYABLE") {
          const assetGroupItem = await tx.masterDataItem.findFirst({
            where: { type: "ASSET_GROUP", code: asText(row.values.asset_group), status: "ACTIVE" },
            select: { group: true },
          });
          const debitAccountCode = ["CCDC", "TOOL"].includes(asText(assetGroupItem?.group).toUpperCase()) ? "242" : "211";
          const debitAccountId = assetAccountByCode.get(debitAccountCode);
          const payableAccountId = assetAccountByCode.get("331");
          if (!debitAccountId || !payableAccountId) throw new Error("Thiếu tài khoản kế toán 211/242 hoặc 331");
          await tx.debtRecord.create({ data: {
            importBatchId: batch.id,
            code: `CN-${asset.code}`,
            debtType: "PAYABLE",
            partnerGroup: "SUPPLIER",
            partnerCode: asText(row.values.supplier_code),
            partnerName: asText(row.values.supplier_name) || asText(row.values.supplier_code),
            branchCode: asset.branchCode,
            documentDate: purchaseDate,
            dueDate: row.values.payment_due_date ? asDate(row.values.payment_due_date) : null,
            originalAmount: payableAmount,
            outstandingAmount: payableAmount,
            description: `Công nợ mua tài sản/CCDC ${asset.code} - ${asset.name}`,
            sourceType: "ASSET",
            sourceId: asset.id,
            status: "OPEN",
          } });
          await tx.journalEntry.create({ data: {
            code: `JE-ASSET-${asset.code}`,
            entryDate: purchaseDate,
            period: periodFromDate(purchaseDate),
            branchCode: asset.branchCode,
            sourceType: "ASSET_ACQUISITION",
            sourceId: asset.id,
            sourceCode: asset.code,
            description: `Ghi nhận mua tài sản/CCDC công nợ ${asset.code}`,
            status: "POSTED",
            createdBy: input.uploadedBy,
            lines: { create: [
              { accountId: debitAccountId, debit: originalCost, credit: 0, departmentCode: asset.departmentCode, description: asset.name },
              { accountId: payableAccountId, debit: 0, credit: payableAmount, partnerCode: asset.supplierCode, description: asset.name },
            ] },
          } });
        }
        await setImportTarget(tx, staging, row, "ASSET", asset.id);
      }
    }

    if (input.importType === "VOUCHER") {
      for (const row of input.rows) {
        const voucherType = asText(row.values.voucher_type).toUpperCase();
        const voucherDate = asDate(row.values.voucher_date);
        const branchCode = asText(row.values.branch_code);
        const moneySourceCode = asText(row.values.money_source_code);
        const moneySource = await tx.masterDataItem.findFirst({
          where: { type: "MONEY_SOURCE", code: moneySourceCode, deletedAt: null },
          select: { group: true },
        });
        const documentChannel = normalizeMoneySourceGroup(moneySource?.group) === "BANK" ? "BANK" : "CASH";
        const voucher = await tx.financialVoucher.create({
          data: {
            importBatchId: batch.id,
            code: await nextVoucherCode(tx, voucherType, voucherDate, branchCode, documentChannel),
            sourceDocumentCode: asText(row.values.source_document_code) || null,
            voucherType,
            voucherDate,
            partnerCode: asText(row.values.partner_code) || null,
            partnerName: asText(row.values.partner_name),
            branchCode,
            sourceScope: asText(row.values.source_scope) || "EXTERNAL",
            documentChannel,
            businessEffect: "RECOGNITION",
            moneySourceCode,
            categoryCode: asText(row.values.category_code) || null,
            externalRef: asText(row.values.external_ref) || null,
            counterpartyAccountNo: asText(row.values.counterparty_account_no) || null,
            counterpartyAccountName: asText(row.values.counterparty_account_name) || null,
            depositAction: asText(row.values.deposit_action) || null,
            depositCode: asText(row.values.deposit_code) || null,
            debtAction: asText(row.values.debt_action) || null,
            debtReference: asText(row.values.debt_reference) || null,
            allocationMonths: row.values.allocation_months ? asInteger(row.values.allocation_months) : null,
            allocationStartPeriod: asText(row.values.allocation_start_period) || null,
            amount: asNumber(row.values.amount),
            description: asText(row.values.description),
            status: "PENDING_REVIEW",
            createdBy: input.uploadedBy,
          },
        });
        await setImportTarget(tx, staging, row, "VOUCHER", voucher.id);
      }
    }

    if (input.importType === "INTERNAL_TRANSFER") {
      for (let index = 0; index < input.rows.length; index += 1) {
        const row = input.rows[index];
        const transferDate = asDate(row.values.transfer_date);
        const branchCode = asText(row.values.branch_code);
        const transfer = await tx.moneyTransfer.create({
          data: {
            importBatchId: batch.id,
            // Trước đây mã tự chế bằng COUNT toàn bảng MoneyTransfer — đếm lẫn cả QTVI/NOPT và
            // CTNB của tháng/cửa hàng khác nên số thứ tự không thuộc chuỗi mã nào, lại tụt khi
            // rollback và cấp trúng mã đang sống. Dùng chung nextTransferCode như luồng sao kê:
            // max + 1 trong ĐÚNG chuỗi CTNB + tháng + cửa hàng, và đúng quy tắc mã đã chốt.
            code: await nextTransferCode(tx, "CTNB", transferDate, branchCode),
            transferDate,
            branchCode,
            // Điều tiền liên nhà hàng: nhớ cửa hàng của TỪNG nguồn để lúc duyệt ghi sổ đúng
            // bên và sinh công nợ nội bộ. Cùng cửa hàng thì hai cột này bằng branchCode.
            fromBranchCode: asText(row.values.from_branch_code) || branchCode,
            toBranchCode: asText(row.values.to_branch_code) || branchCode,
            fromMoneySourceCode: asText(row.values.from_money_source_code),
            toMoneySourceCode: asText(row.values.to_money_source_code),
            amount: asNumber(row.values.amount),
            externalRef: asText(row.values.external_ref) || null,
            description: asText(row.values.description),
            status: "PENDING_REVIEW",
            createdBy: input.uploadedBy,
          },
        });
        await setImportTarget(tx, staging, row, "INTERNAL_TRANSFER", transfer.id);
      }
    }

    if (input.importType === "DEBT_OPENING") {
      for (let index = 0; index < input.rows.length; index += 1) {
        const row = input.rows[index];
        const documentDate = asDate(row.values.document_date);
        const debtType = asText(row.values.debt_type);
        // Cùng lý do với mã chuyển tiền: COUNT toàn bảng DebtRecord không thuộc chuỗi mã này
        // và tụt sau rollback. Lấy max + 1 trong đúng chuỗi CN-PT/PP + ngày chứng từ.
        const debtPrefix = `CN-${debtType === "RECEIVABLE" ? "PT" : "PP"}-${documentDate.toISOString().slice(0, 10).replace(/-/g, "")}-`;
        const issuedDebtCodes = await tx.debtRecord.findMany({
          where: { code: { startsWith: debtPrefix } },
          select: { code: true },
        });
        const code = asText(row.values.document_code) ||
          debtPrefix + String(nextSeqFromCodes(issuedDebtCodes.map((item) => item.code), debtPrefix)).padStart(4, "0");
        const debt = await tx.debtRecord.create({
          data: {
            importBatchId: batch.id,
            code,
            debtType,
            partnerGroup: asText(row.values.partner_group),
            partnerCode: asText(row.values.partner_code),
            partnerName: asText(row.values.partner_name),
            branchCode: asText(row.values.branch_code),
            documentDate,
            dueDate: row.values.due_date ? asDate(row.values.due_date) : null,
            categoryCode: asText(row.values.category_code) || null,
            originalAmount: asNumber(row.values.amount),
            outstandingAmount: asNumber(row.values.amount),
            allocationMonths: row.values.allocation_months ? asInteger(row.values.allocation_months) : null,
            allocationStartPeriod: asText(row.values.allocation_start_period) || null,
            description: asText(row.values.description),
            sourceType: "IMPORT",
            status: "OPEN",
          },
        });
        await setImportTarget(tx, staging, row, "DEBT_OPENING", debt.id);

        const allocationMonths = asInteger(row.values.allocation_months);
        if (debtType === "PAYABLE" && allocationMonths > 1) {
          const startPeriod = asText(row.values.allocation_start_period);
          await tx.accrual.create({
            data: {
              code: `PB-${code}`,
              name: asText(row.values.description),
              branchCode: asText(row.values.branch_code),
              categoryCode: asText(row.values.category_code) || "OPEX",
              totalAmount: asNumber(row.values.amount),
              startPeriod,
              numberOfPeriods: allocationMonths,
              note: `Tạo từ công nợ đầu kỳ ${code}`,
              createdBy: input.uploadedBy,
              schedules: {
                create: Array.from({ length: allocationMonths }, (_, scheduleIndex) => ({
                  period: addPeriod(startPeriod, scheduleIndex),
                  amount: asNumber(row.values.amount) / allocationMonths,
                })),
              },
            },
          });
        }
      }
    }

    // Khoá kỳ kế toán kiểm ở CUỐI, khi mọi bản ghi của batch đã nằm trong transaction:
    // một dòng rơi vào kỳ đã chốt là huỷ sạch cả batch. Trước đây import kho/kiểm kê/POS
    // không kiểm gì và ghi thẳng vào tháng đã chốt sổ được.
    await assertImportPeriodsOpen(tx as unknown as RawTxClient, batch.id, input.importType, "commit");

    return tx.importBatch.findUnique({
      where: { id: batch.id },
      include: {
        bankTransactions: input.importType === "BANK_STATEMENT"
          ? { include: { allocations: { orderBy: { sourceRowNumber: "asc" } } } }
          : false,
        revenueRows: input.importType === "REVENUE_POS",
        payrollRows: input.importType === "PAYROLL",
        importRows: { orderBy: [{ sheetName: "asc" }, { sourceRowNumber: "asc" }] },
        vouchers: ["VOUCHER", "BANK_STATEMENT"].includes(input.importType),
        moneyTransfers: ["INTERNAL_TRANSFER", "BANK_STATEMENT"].includes(input.importType),
        debtRecords: input.importType === "DEBT_OPENING",
        inventoryTransactions: ["INVENTORY_TRANSACTION", "PRODUCTION", "WASTE"].includes(input.importType),
        assetStocktakes: input.importType === "ASSET_STOCKTAKE" ? { include: { lines: { include: { asset: true } } } } : false,
      },
    });
  }, {
    maxWait: 10_000,
    timeout: 120_000,
  });
  const bankAutoApproved = input.importType === "BANK_STATEMENT"
    ? (batchResult?.bankTransactions || []).filter((row) => row.reconcileStatus === "MATCHED" && row.autoProcessType !== "NET_ZERO").length
    : 0;
  // Dòng đã ghi được tiền nhưng chưa lập được chứng từ. Trả về ngay để màn Import nói rõ còn
  // bao nhiêu tiền chưa vào sổ, thay vì để người dùng phát hiện sau nhiều tuần.
  const bankNeedsFix = (batchResult?.bankTransactions || [])
    .filter((row) => row.autoProcessType === "MANUAL_REQUIRED")
    .map((row) => ({
      transactionCode: row.transactionCode,
      transactionDate: row.transactionDate,
      amount: Math.round(row.creditAmount || row.debitAmount),
      reason: row.autoProcessNote || "Chưa rõ lý do",
    }));
  await writeAuditLog({
    actorName: input.uploadedBy,
    module: "IMPORT",
    action: "COMMIT_IMPORT",
    entityType: "ImportBatch",
    entityId: batchResult?.id || null,
    entityCode: input.fileName,
    branchCode: input.branchCode || null,
    metadata: {
      importType: input.importType,
      templateCode: input.templateCode,
      totalRows: input.rows.length,
      bankAutoApproved,
      bankNeedsFix: bankNeedsFix.length,
      bankRecordingMode: input.importType === "BANK_STATEMENT" ? "DIRECT_INGESTION" : null,
    },
  });
  return batchResult ? { ...batchResult, needsFix: bankNeedsFix } : batchResult;
}

async function rollbackBankStatement(tx: RawTxClient, batchId: string) {
  const bankRows = await tx.bankStatementTransaction.findMany({ where: { importBatchId: batchId }, select: { id: true } });
  const bankIds = bankRows.map((row) => row.id);
  if (bankIds.length > 0) await tx.reconciliationMatch.deleteMany({ where: { bankTransactionId: { in: bankIds } } });
  await rollbackVouchers(tx, batchId);
  await rollbackTransfers(tx, batchId);
  await tx.bankStatementTransaction.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackRevenue(tx: RawTxClient, batchId: string) {
  await rollbackInventoryTransactions(tx, batchId);
  const rows = await tx.revenueImportRow.findMany({ where: { importBatchId: batchId }, select: { id: true } });
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx.journalEntry.deleteMany({ where: { sourceType: "REVENUE_POS", sourceId: { in: ids } } });
  }
  await tx.revenueImportRow.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackPayroll(tx: RawTxClient, batchId: string) {
  const rows = await tx.payrollImportRow.findMany({ where: { importBatchId: batchId }, select: { id: true } });
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx.journalEntry.deleteMany({ where: { sourceType: "PAYROLL", sourceId: { in: ids } } });
  }
  await tx.payrollImportRow.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackVouchers(tx: RawTxClient, batchId: string) {
  const vouchers = await tx.financialVoucher.findMany({ where: { importBatchId: batchId }, select: { id: true, code: true } });
  const voucherIds = vouchers.map((voucher) => voucher.id);
  if (voucherIds.length === 0) return;

  await tx.journalEntry.deleteMany({ where: { sourceType: "VOUCHER", sourceId: { in: voucherIds } } });

  const histories = await tx.depositHistory.findMany({
    where: { voucherId: { in: voucherIds } },
    include: { deposit: { include: { histories: true } } },
  });
  for (const history of histories) {
    if (history.action === "COLLECT") {
      if (history.deposit.histories.length > 1) {
        throw new Error(`Tiền cọc ${history.deposit.code} đã phát sinh xử lý sau khi thu, không thể rollback tự động`);
      }
      await tx.deposit.delete({ where: { id: history.depositId } });
    } else if (history.action === "SUPPLEMENT") {
      if (history.deposit.histories.length === 1) {
        await tx.deposit.delete({ where: { id: history.depositId } });
      } else {
        const amount = history.amount || 0;
        await tx.deposit.update({
          where: { id: history.depositId },
          data: {
            amount: history.deposit.amount - amount,
            remainingAmount: history.deposit.remainingAmount - amount,
            status: "HOLDING",
          },
        });
        await tx.depositHistory.delete({ where: { id: history.id } });
      }
    } else {
      const remainingAmount = history.deposit.remainingAmount + (history.amount || 0);
      await tx.deposit.update({
        where: { id: history.depositId },
        data: { remainingAmount, status: "HOLDING" },
      });
      await tx.depositHistory.delete({ where: { id: history.id } });
    }
  }

  const settlements = await tx.debtSettlement.findMany({ where: { voucherId: { in: voucherIds } }, include: { debt: true } });
  for (const settlement of settlements) {
    const outstandingAmount = settlement.debt.outstandingAmount + settlement.amount;
    await tx.debtRecord.update({
      where: { id: settlement.debtId },
      data: {
        outstandingAmount,
        status: outstandingAmount >= settlement.debt.originalAmount ? "OPEN" : "PARTIAL",
      },
    });
    await tx.debtSettlement.delete({ where: { id: settlement.id } });
  }

  const accrualCodes = vouchers.map((voucher) => `PB-${voucher.code}`);
  const postedSchedules = await tx.accrualSchedule.count({
    where: { accrual: { code: { in: accrualCodes } }, status: "POSTED" },
  });
  if (postedSchedules > 0) throw new Error("Batch đã tạo chi phí phân bổ và có kỳ đã ghi nhận, không thể rollback");
  await tx.accrual.deleteMany({ where: { code: { in: accrualCodes } } });
  await tx.financialVoucher.deleteMany({ where: { id: { in: voucherIds } } });
}

async function rollbackTransfers(tx: RawTxClient, batchId: string) {
  const transfers = await tx.moneyTransfer.findMany({
    where: { importBatchId: batchId },
    select: { id: true, internalReceivableDebtCode: true, internalPayableDebtCode: true },
  });
  if (transfers.length === 0) return;
  // Phiếu liên nhà hàng đã duyệt để lại công nợ nội bộ hai đầu và bút toán ở cả hai cửa
  // hàng; xoá phiếu mà bỏ lại hai thứ đó thì sổ của cửa hàng bên kia treo số vĩnh viễn.
  const debtCodes = transfers
    .flatMap((transfer) => [transfer.internalReceivableDebtCode, transfer.internalPayableDebtCode])
    .filter((code): code is string => Boolean(code));
  if (debtCodes.length > 0) {
    const settled = await tx.debtSettlement.count({ where: { debt: { code: { in: debtCodes } } } });
    if (settled > 0) throw new Error("Công nợ nội bộ của phiếu điều tiền đã có thanh toán, không thể rollback tự động");
    await tx.debtRecord.deleteMany({ where: { code: { in: debtCodes } } });
  }
  const transferIds = transfers.map((transfer) => transfer.id);
  await tx.journalEntry.deleteMany({
    where: { sourceType: { in: ["MONEY_TRANSFER", "MONEY_TRANSFER_COUNTERPART"] }, sourceId: { in: transferIds } },
  });
  await tx.moneyTransfer.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackDebtOpening(tx: RawTxClient, batchId: string) {
  const debts = await tx.debtRecord.findMany({ where: { importBatchId: batchId }, select: { id: true, code: true } });
  const debtIds = debts.map((debt) => debt.id);
  if (debtIds.length === 0) return;
  const settled = await tx.debtSettlement.count({ where: { debtId: { in: debtIds } } });
  if (settled > 0) throw new Error("Batch công nợ đã có thanh toán, không thể rollback tự động");
  const accrualCodes = debts.map((debt) => `PB-${debt.code}`);
  const postedSchedules = await tx.accrualSchedule.count({ where: { accrual: { code: { in: accrualCodes } }, status: "POSTED" } });
  if (postedSchedules > 0) throw new Error("Batch công nợ đã tạo phân bổ và có kỳ đã ghi nhận, không thể rollback");
  await tx.accrual.deleteMany({ where: { code: { in: accrualCodes } } });
  await tx.debtRecord.deleteMany({ where: { id: { in: debtIds } } });
}

async function rollbackMasterData(tx: RawTxClient, batchId: string) {
  const rows = await tx.importRow.findMany({ where: { importBatchId: batchId, targetType: "MASTER_DATA" }, select: { targetId: true } });
  const ids = rows.map((row) => row.targetId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  const batch = await tx.importBatch.findUnique({ where: { id: batchId }, select: { createdAt: true } });
  const existingBeforeBatch = await tx.masterDataItem.count({
    where: { id: { in: ids }, createdAt: { lt: batch?.createdAt || new Date(0) } },
  });
  if (existingBeforeBatch > 0) {
    throw new Error("Batch có cập nhật danh mục đã tồn tại trước đó, cần rollback thủ công để không làm mất cấu hình đang dùng");
  }
  await tx.masterDataItem.updateMany({
    where: { id: { in: ids } },
    data: { status: "INACTIVE", note: "Rollback từ batch import" },
  });
}

async function rollbackInventoryItems(tx: RawTxClient, batchId: string) {
  const rows = await tx.importRow.findMany({ where: { importBatchId: batchId, targetType: "INVENTORY_ITEM" }, select: { targetId: true } });
  const ids = rows.map((row) => row.targetId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  const batch = await tx.importBatch.findUnique({ where: { id: batchId }, select: { createdAt: true } });
  const existingBeforeBatch = await tx.inventoryItem.count({
    where: { id: { in: ids }, createdAt: { lt: batch?.createdAt || new Date(0) } },
  });
  if (existingBeforeBatch > 0) {
    throw new Error("Batch có cập nhật mặt hàng đã tồn tại trước đó, cần rollback thủ công để không làm mất danh mục đang dùng");
  }
  const usedBalances = await tx.inventoryBalance.count({ where: { itemId: { in: ids }, quantity: { not: 0 } } });
  const usedLines = await tx.inventoryTransactionLine.count({ where: { itemId: { in: ids } } });
  if (usedBalances > 0 || usedLines > 0) throw new Error("Mặt hàng import đã phát sinh tồn kho/giao dịch, không thể rollback tự động");
  await tx.inventoryItem.updateMany({ where: { id: { in: ids } }, data: { status: "INACTIVE" } });
}

async function adjustInventoryBalanceForRollback(
  tx: RawTxClient,
  itemId: string,
  warehouseCode: string,
  quantityDelta: number,
  valueDelta: number,
) {
  const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode } } });
  const currentQuantity = balance?.quantity || 0;
  const currentAverage = balance?.averageCost || 0;
  const nextQuantity = currentQuantity + quantityDelta;
  if (nextQuantity < -0.000001) throw new Error("Rollback import kho se lam am ton kho, can kiem tra thu cong");
  // Hoàn cả GIÁ TRỊ theo totalCost của từng dòng phiếu, không chỉ số lượng: chỉ trả số lượng
  // thì giá vốn bình quân kẹt ở mức phiếu import đã kéo lên/xuống, và mọi phiếu xuất sau
  // ăn giá vốn sai vĩnh viễn (nhập 100 chai @40k vào kho @20k rồi rollback -> kẹt @30k).
  const nextValue = currentQuantity * currentAverage + valueDelta;
  const averageCost = nextQuantity > 0.000001 ? Math.max(nextValue / nextQuantity, 0) : currentAverage;
  if (!balance) {
    await tx.inventoryBalance.create({ data: { itemId, warehouseCode, quantity: Math.max(nextQuantity, 0), averageCost: nextQuantity > 0.000001 ? Math.max(valueDelta / nextQuantity, 0) : 0 } });
  } else {
    await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantity: Math.max(nextQuantity, 0), averageCost } });
  }
}

async function rollbackInventoryTransactions(tx: RawTxClient, batchId: string) {
  const transactions = await tx.inventoryTransaction.findMany({
    where: { importBatchId: batchId },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });
  for (const transaction of transactions) {
    for (const line of transaction.lines) {
      if (transaction.transactionType.startsWith("NHAP_")) {
        await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.warehouseCode, -line.quantity, -line.totalCost);
      } else if (transaction.transactionType.startsWith("XUAT_")) {
        await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.warehouseCode, line.quantity, line.totalCost);
      } else if (transaction.transactionType === "DIEU_CHUYEN") {
        await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.warehouseCode, line.quantity, line.totalCost);
        if (transaction.toWarehouseCode) await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.toWarehouseCode, -line.quantity, -line.totalCost);
      }
    }
  }
  await tx.inventoryTransaction.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackBom(tx: RawTxClient, batchId: string) {
  const targets = await tx.importRow.findMany({
    where: { importBatchId: batchId, targetType: "BOM", targetId: { not: null } },
    select: { targetId: true },
  });
  const recipeIds = Array.from(new Set(targets.map((target) => target.targetId).filter(Boolean))) as string[];
  if (recipeIds.length === 0) return;

  await tx.recipe.deleteMany({ where: { id: { in: recipeIds } } });

  const affectedProducts = await tx.importRow.findMany({
    where: { importBatchId: batchId, targetType: "BOM" },
    select: { normalizedJson: true },
  });
  const productCodes = Array.from(new Set(affectedProducts.map((row) => asText(parseStoredJson(row.normalizedJson).product_code).toUpperCase()).filter(Boolean)));
  for (const productCode of productCodes) {
    const latest = await tx.recipe.findFirst({ where: { productCode }, orderBy: { version: "desc" } });
    if (latest) await tx.recipe.update({ where: { id: latest.id }, data: { status: "ACTIVE" } });
  }
}

async function rollbackStocktake(tx: RawTxClient, batchId: string) {
  await rollbackInventoryTransactions(tx, batchId);
  const targets = await tx.importRow.findMany({
    where: { importBatchId: batchId, targetType: "STOCKTAKE", targetId: { not: null } },
    select: { targetId: true },
  });
  const stocktakeIds = Array.from(new Set(targets.map((target) => target.targetId).filter(Boolean))) as string[];
  if (stocktakeIds.length > 0) {
    await tx.stocktakeSession.deleteMany({ where: { id: { in: stocktakeIds } } });
  }
}

async function rollbackAssetStocktake(tx: RawTxClient, batchId: string) {
  const targets = await tx.importRow.findMany({
    where: { importBatchId: batchId, targetType: "ASSET_STOCKTAKE", targetId: { not: null } },
    select: { targetId: true },
  });
  const sessionIds = Array.from(new Set(targets.map((target) => target.targetId).filter(Boolean))) as string[];
  if (sessionIds.length === 0) return;
  // Trả số lượng sổ sách về số TRƯỚC kiểm kê rồi mới xoá phiên — thứ tự ngược sẽ mất dấu.
  const lines = await tx.assetStocktakeLine.findMany({ where: { sessionId: { in: sessionIds } } });
  for (const line of lines) {
    await tx.assetRecord.update({ where: { id: line.assetId }, data: { quantity: line.systemQuantity } });
  }
  await tx.assetStocktakeSession.deleteMany({ where: { id: { in: sessionIds } } });
}

async function rollbackAssets(tx: RawTxClient, batchId: string) {
  const targets = await tx.importRow.findMany({
    where: { importBatchId: batchId, targetType: "ASSET", targetId: { not: null } },
    select: { targetId: true },
  });
  const assetIds = Array.from(new Set(targets.map((target) => target.targetId).filter(Boolean))) as string[];
  if (assetIds.length === 0) return;

  const assets = await tx.assetRecord.findMany({
    where: { id: { in: assetIds } },
    select: { id: true, code: true, disposalStatus: true, disposalDate: true },
  });
  for (const asset of assets) {
    const used = await Promise.all([
      tx.assetDepreciation.count({ where: { assetId: asset.id } }),
      tx.assetMaintenance.count({ where: { assetId: asset.id } }),
      tx.assetDamageReport.count({ where: { assetId: asset.id } }),
      tx.debtSettlement.count({ where: { debt: { sourceType: "ASSET", sourceId: asset.id } } }),
    ]);
    if (used.some((count) => count > 0) || asset.disposalStatus || asset.disposalDate) {
      throw new Error(`Tai san ${asset.code} da phat sinh nghiep vu, khong the rollback tu dong`);
    }
  }

  await tx.journalEntry.deleteMany({ where: { sourceType: "ASSET_ACQUISITION", sourceId: { in: assetIds } } });
  await tx.debtRecord.deleteMany({ where: { sourceType: "ASSET", sourceId: { in: assetIds } } });
  await tx.assetRecord.deleteMany({ where: { id: { in: assetIds } } });
}

async function rollbackOpeningBalances(tx: RawTxClient, batchId: string) {
  const rows = await tx.importRow.findMany({ where: { importBatchId: batchId }, select: { normalizedJson: true } });
  const openingFilters: Prisma.OpeningBalanceWhereInput[] = [];
  for (const row of rows) {
    const values = parseStoredJson(row.normalizedJson);
    const period = asText(values.period);
    const branchCode = asText(values.branch_code);
    const balanceType = asText(values.balance_type).toUpperCase();
    const objectCode = asText(values.object_code) || null;
    const moneySourceCode = asText(values.money_source_code) || null;
    openingFilters.push({
      period,
      branchCode,
      balanceType,
      objectCode,
      moneySourceCode,
      amount: asNumber(values.amount),
    });

    if (balanceType === "DEPOSIT" && objectCode) {
      const code = `COC-DK-${period.replace("-", "")}-${branchCode}-${objectCode}`;
      const deposit = await tx.deposit.findUnique({ where: { code }, include: { histories: true } });
      if (deposit) {
        if (deposit.histories.length > 1 || Math.abs(deposit.remainingAmount - deposit.amount) > 0.0001) {
          throw new Error(`Tiền cọc ${code} đã phát sinh xử lý sau import, không thể rollback tự động`);
        }
        await tx.deposit.delete({ where: { id: deposit.id } });
      }
    }

    if (balanceType === "PREPAID_EXPENSE" && objectCode) {
      const code = `PB-DK-${objectCode.toUpperCase()}`;
      const postedSchedules = await tx.accrualSchedule.count({ where: { accrual: { code }, status: "POSTED" } });
      if (postedSchedules > 0) throw new Error(`Chi phí phân bổ ${code} đã ghi nhận kỳ, không thể rollback`);
      await tx.accrual.deleteMany({ where: { code } });
    }

    if (balanceType === "ASSET" && objectCode) {
      const asset = await tx.assetRecord.findUnique({ where: { code: objectCode.toUpperCase() } });
      if (asset) {
        const used = await Promise.all([
          tx.assetDepreciation.count({ where: { assetId: asset.id } }),
          tx.assetMaintenance.count({ where: { assetId: asset.id } }),
          tx.assetDamageReport.count({ where: { assetId: asset.id } }),
        ]);
        if (used.some((count) => count > 0)) throw new Error(`Tài sản ${asset.code} đã phát sinh nghiệp vụ, không thể rollback`);
        await tx.journalEntry.deleteMany({ where: { sourceType: "ASSET_ACQUISITION", sourceId: asset.id } });
        await tx.assetRecord.delete({ where: { id: asset.id } });
      }
    }

    if (balanceType === "INVENTORY" && objectCode && asText(values.warehouse_code)) {
      const item = await tx.inventoryItem.findUnique({ where: { code: objectCode.toUpperCase() } });
      if (item) {
        const quantity = asNumber(values.quantity);
        const unitCost = values.unit_cost ? asNumber(values.unit_cost) : Math.abs(asNumber(values.amount) / quantity);
        const balance = await tx.inventoryBalance.findUnique({
          where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: asText(values.warehouse_code) } },
        });
        if (balance && (Math.abs(balance.quantity - quantity) > 0.0001 || Math.abs(balance.averageCost - unitCost) > 0.0001)) {
          throw new Error(`Tồn kho ${objectCode} đã thay đổi sau import, không thể rollback tự động`);
        }
        if (balance) await tx.inventoryBalance.delete({ where: { id: balance.id } });
      }
    }
  }

  if (openingFilters.length > 0) {
    const openings = await tx.openingBalance.findMany({ where: { OR: openingFilters }, select: { id: true } });
    const ids = openings.map((opening) => opening.id);
    if (ids.length > 0) {
      await tx.journalEntry.deleteMany({ where: { sourceType: "OPENING_BALANCE", sourceId: { in: ids } } });
      await tx.openingBalance.deleteMany({ where: { id: { in: ids } } });
    }
  }
}

export async function rollbackImportBatch(input: RollbackInput) {
  // Rollback là hoàn tác một lần import máy sinh, không phải người dùng xoá dữ liệu:
  // phải xoá cứng để giải phóng các mã unique, nếu không import lại cùng file sẽ báo trùng mã.
  // Vì vậy dùng prismaRaw (bỏ qua lớp xoá mềm) và mọi thao tác nằm gọn trong 1 transaction.
  const result = await prismaRaw.$transaction(async (tx) => {
    const batch = await tx.importBatch.findUnique({ where: { id: input.batchId } });
    if (!batch) throw new Error("Không tìm thấy batch import");
    if (!["COMMITTED", "APPROVED", "COMMITTED_WITH_ERRORS", "ROLLBACK_FAILED"].includes(batch.status)) {
      throw new Error(`Batch trạng thái ${batch.status} không thể rollback`);
    }

    await assertImportPeriodsOpen(tx, batch.id, batch.importType);

    if (batch.importType === "BANK_STATEMENT") await rollbackBankStatement(tx, batch.id);
    else if (batch.importType === "REVENUE_POS") await rollbackRevenue(tx, batch.id);
    else if (batch.importType === "PAYROLL") await rollbackPayroll(tx, batch.id);
    else if (batch.importType === "VOUCHER") await rollbackVouchers(tx, batch.id);
    else if (batch.importType === "INTERNAL_TRANSFER") await rollbackTransfers(tx, batch.id);
    else if (batch.importType === "DEBT_OPENING") await rollbackDebtOpening(tx, batch.id);
    else if (batch.importType === "MASTER_DATA") await rollbackMasterData(tx, batch.id);
    else if (batch.importType === "INVENTORY_ITEM") await rollbackInventoryItems(tx, batch.id);
    else if (batch.importType === "INVENTORY_TRANSACTION") await rollbackInventoryTransactions(tx, batch.id);
    else if (batch.importType === "PRODUCTION" || batch.importType === "WASTE") await rollbackInventoryTransactions(tx, batch.id);
    else if (batch.importType === "ASSET_STOCKTAKE") await rollbackAssetStocktake(tx, batch.id);
    else if (batch.importType === "BOM") await rollbackBom(tx, batch.id);
    else if (batch.importType === "STOCKTAKE") await rollbackStocktake(tx, batch.id);
    else if (batch.importType === "ASSET") await rollbackAssets(tx, batch.id);
    else if (batch.importType === "OPENING_BALANCE") await rollbackOpeningBalances(tx, batch.id);
    else throw new Error(`Chưa hỗ trợ rollback loại import ${batch.importType}`);

    return tx.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "ROLLED_BACK",
        rolledBackAt: new Date(),
        rolledBackBy: input.actor,
        rollbackNote: input.note || null,
      },
    });
  }, {
    maxWait: 10_000,
    timeout: 120_000,
  });
  await writeAuditLog({
    actorName: input.actor,
    module: "IMPORT",
    action: "ROLLBACK_IMPORT",
    entityType: "ImportBatch",
    entityId: result.id,
    entityCode: result.fileName,
    branchCode: result.branchCode || null,
    message: input.note || null,
    metadata: { importType: result.importType, totalRows: result.totalRows },
  });
  return result;
}

export function isUniqueConstraintError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
