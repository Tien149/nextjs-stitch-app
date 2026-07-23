import { createHash } from "node:crypto";
import { Prisma } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { addPeriod, periodFromDate } from "@/lib/phase3";
import { type ImportType } from "@/lib/import-templates";
import { type ParsedImportRow } from "@/lib/import-parser";
import { normalizeStockTransactionType, postInventoryTransaction } from "@/lib/inventory-stock";
import { writeAuditLog } from "@/lib/audit-log";

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

function asDate(value: unknown) {
  return value instanceof Date ? value : new Date(String(value));
}

function normalizeInventoryItemType(value: unknown) {
  const raw = asText(value).toUpperCase();
  if (!raw || raw === "MATERIAL" || raw === "RAW" || raw === "NVL") return "RAW_MATERIAL";
  if (raw === "BTP" || raw === "SEMI" || raw === "SEMI_FINISHED_GOOD") return "SEMI_FINISHED";
  if (raw === "TP" || raw === "PRODUCT" || raw === "FINISHED_GOOD") return "FINISHED";
  return raw;
}

function jsonValue(value: unknown) {
  return JSON.stringify(value, (_key, item) => item instanceof Date ? item.toISOString() : item);
}

function rowFingerprint(importType: ImportType, row: ParsedImportRow) {
  return createHash("sha256")
    .update(`${importType}:${jsonValue(row.values)}`)
    .digest("hex");
}

function monthBounds(value: Date) {
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
  return { start, end };
}

async function nextVoucherCode(
  tx: Prisma.TransactionClient,
  voucherType: string,
  voucherDate: Date,
) {
  const prefix = voucherType === "RECEIPT" ? "PT" : "PC";
  const ym = `${voucherDate.getUTCFullYear()}${String(voucherDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const { start, end } = monthBounds(voucherDate);
  const count = await tx.financialVoucher.count({
    where: { voucherType, voucherDate: { gte: start, lt: end } },
  });
  return `${prefix}-${ym}-${String(count + 1).padStart(4, "0")}`;
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

async function assertPeriodOpen(tx: Prisma.TransactionClient, period: string, branchCode?: string | null) {
  if (!period || !branchCode) return;
  const [branchPeriod, allBranchPeriod] = await Promise.all([
    tx.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode } } }),
    tx.accountingPeriod.findUnique({ where: { period_branchCode: { period, branchCode: "ALL" } } }),
  ]);
  if (branchPeriod?.status === "CLOSED" || allBranchPeriod?.status === "CLOSED") {
    throw new Error(`Kỳ ${period} của cửa hàng ${branchCode} đã khóa, không thể rollback batch import`);
  }
}

async function assertImportPeriodsOpen(tx: Prisma.TransactionClient, batchId: string, importType: string) {
  if (importType === "BANK_STATEMENT") {
    const rows = await tx.bankStatementTransaction.findMany({ where: { importBatchId: batchId }, select: { transactionDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.transactionDate), row.branchCode);
  }
  if (importType === "REVENUE_POS") {
    const rows = await tx.revenueImportRow.findMany({ where: { importBatchId: batchId }, select: { saleDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.saleDate), row.branchCode);
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
  if (importType === "INVENTORY_TRANSACTION") {
    const rows = await tx.inventoryTransaction.findMany({ where: { importBatchId: batchId }, select: { transactionDate: true, branchCode: true } });
    for (const row of rows) await assertPeriodOpen(tx, periodFromDate(row.transactionDate), row.branchCode);
  }
}

async function createStagingRows(
  tx: Prisma.TransactionClient,
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
  tx: Prisma.TransactionClient,
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
  const errorRows = input.rows.filter((row) => row.errors.length > 0);
  if (errorRows.length > 0) throw new Error("File còn dòng lỗi, vui lòng sửa trước khi commit");
  if (input.rows.length === 0) throw new Error("File không có dòng dữ liệu để commit");

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

    if (input.importType === "BANK_STATEMENT") {
      const duplicateKeys = await Promise.all(input.rows.map((row) => tx.bankStatementTransaction.findUnique({
        where: {
          bankAccount_transactionCode: {
            bankAccount: asText(row.values.bank_account),
            transactionCode: asText(row.values.transaction_code),
          },
        },
        select: { id: true },
      })));
      if (duplicateKeys.some(Boolean)) throw new Error("File có giao dịch trùng với dữ liệu đã import");
    }

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

    if (["VOUCHER", "INTERNAL_TRANSFER", "DEBT_OPENING", "INVENTORY_TRANSACTION", "BOM", "STOCKTAKE"].includes(input.importType)) {
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
      await tx.bankStatementTransaction.createMany({
        data: input.rows.map((row) => ({
          importBatchId: batch.id,
          transactionDate: asDate(row.values.transaction_date),
          bankAccount: asText(row.values.bank_account),
          transactionCode: asText(row.values.transaction_code),
          description: asText(row.values.description),
          debitAmount: asNumber(row.values.debit_amount),
          creditAmount: asNumber(row.values.credit_amount),
          balanceAfter: row.values.balance_after === null ? null : asNumber(row.values.balance_after),
          branchCode: row.values.branch_code === null ? null : asText(row.values.branch_code),
          partnerHint: row.values.partner_hint === null ? null : asText(row.values.partner_hint),
        })),
      });
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
        await setImportTarget(tx, staging, row, "REVENUE_POS", revenueRow.id);
        if (productCode && productQuantity > 0) {
          const recipe = await tx.recipe.findFirst({
            where: { productCode, status: "ACTIVE" },
            include: { lines: true },
            orderBy: { version: "desc" },
          });
          if (!recipe) throw new Error(`Dong ${row.rowNumber}: Chua co BOM active cho ${productCode}`);
          await postInventoryTransaction(tx, {
            importBatchId: batch.id,
            code: `XB-${asText(row.values.external_ref)}`,
            transactionType: "XUAT_BAN",
            transactionDate: asDate(row.values.sale_date),
            branchCode: asText(row.values.branch_code),
            warehouseCode: asText(row.values.warehouse_code) || "KHO_HCM",
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
        const group = row.values.group ? asText(row.values.group).toUpperCase() : null;
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
        const item = await tx.masterDataItem.upsert({
          where: { type_code: { type, code } },
          create: {
            type, code, name, group, partnerType: type === "PARTNER" ? group : null, partnerGroup: type === "PARTNER" ? partnerGroup : null, branch,
            taxCode: row.values.tax_code ? asText(row.values.tax_code) : null,
            accountNo: row.values.account_no ? asText(row.values.account_no) : null,
            status: "ACTIVE",
          },
          update: {
            name, group, partnerType: type === "PARTNER" ? group : null, partnerGroup: type === "PARTNER" ? partnerGroup : null, branch,
            taxCode: row.values.tax_code ? asText(row.values.tax_code) : null,
            accountNo: row.values.account_no ? asText(row.values.account_no) : null,
          },
        });
        await setImportTarget(tx, staging, row, "MASTER_DATA", item.id);
      }
    }

    if (input.importType === "INVENTORY_ITEM") {
      for (const row of input.rows) {
        const code = asText(row.values.code).toUpperCase();
        const name = asText(row.values.name);
        const itemType = normalizeInventoryItemType(row.values.item_type);
        const unit = asText(row.values.unit);
        if (!['RAW_MATERIAL', 'SEMI_FINISHED', 'FINISHED', 'PACKAGING', 'TOOL', 'ASSET'].includes(itemType)) {
          throw new Error(`Dòng ${row.rowNumber}: Loại hàng không hợp lệ`);
        }
        const item = await tx.inventoryItem.upsert({
          where: { code },
          create: { code, name, itemType, unit, minStock: asNumber(row.values.min_stock), status: "ACTIVE" },
          update: { name, itemType, unit, minStock: asNumber(row.values.min_stock) },
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
          await tx.itemUnitConversion.upsert({
            where: { itemId_unitCode: { itemId: item.id, unitCode: purchaseUnit.toUpperCase() } },
            create: { itemId: item.id, unitCode: purchaseUnit.toUpperCase(), unitName: purchaseUnit, conversionRate, isDefaultPurchase: true },
            update: { unitName: purchaseUnit, conversionRate, isDefaultPurchase: true },
          });
        }
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
      let sequence = await tx.inventoryTransaction.count();
      for (const rows of groups.values()) {
        const first = rows[0];
        const transactionDate = asDate(first.values.transaction_date);
        const transactionType = normalizeStockTransactionType(first.values.transaction_type);
        const prefix = transactionType === "NHAP_MUA" ? "NM" : transactionType === "NHAP_KHAC" ? "NK" : transactionType === "XUAT_HUY" ? "HH" : transactionType === "DIEU_CHUYEN" ? "DCK" : "XK";
        sequence += 1;
        const transaction = await postInventoryTransaction(tx, {
          importBatchId: batch.id,
          code: asText(first.values.reference_code) || `${prefix}-${transactionDate.getUTCFullYear()}-${String(sequence).padStart(4, "0")}`,
          transactionType,
          transactionDate,
          branchCode: asText(first.values.branch_code),
          warehouseCode: asText(first.values.warehouse_code),
          toWarehouseCode: asText(first.values.to_warehouse_code) || null,
          referenceType: "IMPORT",
          referenceCode: asText(first.values.reference_code) || null,
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
      const groups = new Map<string, ParsedImportRow[]>();
      for (const row of input.rows) {
        const productCode = asText(row.values.product_code).toUpperCase();
        groups.set(productCode, [...(groups.get(productCode) || []), row]);
      }
      for (const [productCode, rows] of groups) {
        const latest = await tx.recipe.findFirst({ where: { productCode }, orderBy: { version: "desc" } });
        await tx.recipe.updateMany({ where: { productCode, status: "ACTIVE" }, data: { status: "INACTIVE" } });
        const recipe = await tx.recipe.create({
          data: {
            code: `${productCode}-V${(latest?.version || 0) + 1}`,
            productCode,
            productName: asText(rows[0].values.product_name),
            unit: "phan",
            sellingPrice: 0,
            version: (latest?.version || 0) + 1,
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
      let sequence = await tx.stocktakeSession.count();
      for (const rows of groups.values()) {
        const first = rows[0];
        const stocktakeDate = asDate(first.values.stocktake_date);
        sequence += 1;
        const stocktake = await tx.stocktakeSession.create({
          data: {
            code: `KK-${stocktakeDate.getUTCFullYear()}-${String(sequence).padStart(4, "0")}`,
            stocktakeDate,
            branchCode: asText(first.values.branch_code),
            warehouseCode: asText(first.values.warehouse_code),
            status: "APPROVED",
            approvedBy: input.uploadedBy,
            approvedAt: new Date(),
            createdBy: input.uploadedBy,
          },
        });
        const inboundLines = [];
        const outboundLines = [];
        for (const row of rows) {
          const item = await tx.inventoryItem.findUnique({ where: { code: asText(row.values.item_code).toUpperCase() } });
          if (!item) throw new Error(`Dong ${row.rowNumber}: Khong tim thay mat hang ${asText(row.values.item_code)}`);
          const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: asText(first.values.warehouse_code) } } });
          const systemQuantity = balance?.quantity || 0;
          const actualQuantity = asNumber(row.values.actual_quantity);
          const varianceQuantity = actualQuantity - systemQuantity;
          await tx.stocktakeLine.create({
            data: { stocktakeId: stocktake.id, itemId: item.id, systemQuantity, actualQuantity, varianceQuantity, reason: asText(row.values.reason) || null },
          });
          await setImportTarget(tx, staging, row, "STOCKTAKE", stocktake.id);
          if (varianceQuantity > 0) inboundLines.push({ itemId: item.id, inputQuantity: varianceQuantity, inputUnitCode: item.unit, inputUnitCost: balance?.averageCost || 0 });
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
          const depositCode = `COC-DK-${asText(row.values.period).replace("-", "")}-${asText(row.values.branch_code)}-${asText(row.values.object_code)}`;
          const existingDeposit = await tx.deposit.findUnique({ where: { code: depositCode } });
          const deposit = existingDeposit
            ? await tx.deposit.update({
                where: { code: depositCode },
                data: { amount: asNumber(row.values.amount), remainingAmount: asNumber(row.values.amount), note: asText(row.values.note) || null },
              })
            : await tx.deposit.create({
                data: {
                  code: depositCode,
                  receivedDate: new Date(`${asText(row.values.period)}-01T00:00:00Z`),
                  partnerCode: asText(row.values.object_code),
                  partnerName: asText(row.values.object_name) || asText(row.values.object_code),
                  branchCode: asText(row.values.branch_code),
                  moneySourceCode: asText(row.values.money_source_code),
                  amount: asNumber(row.values.amount),
                  remainingAmount: asNumber(row.values.amount),
                  purpose: "Tiền cọc đầu kỳ",
                  note: asText(row.values.note) || null,
                  histories: {
                    create: {
                      action: "OPENING",
                      amount: asNumber(row.values.amount),
                      actionDate: new Date(`${asText(row.values.period)}-01T00:00:00Z`),
                      treatmentNote: "Số dư tiền cọc đầu kỳ",
                      actor: input.uploadedBy,
                    },
                  },
                },
              });
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

    if (input.importType === "VOUCHER") {
      for (const row of input.rows) {
        const voucherType = asText(row.values.voucher_type).toUpperCase();
        const voucherDate = asDate(row.values.voucher_date);
        const voucher = await tx.financialVoucher.create({
          data: {
            importBatchId: batch.id,
            code: await nextVoucherCode(tx, voucherType, voucherDate),
            sourceDocumentCode: asText(row.values.source_document_code) || null,
            voucherType,
            voucherDate,
            partnerCode: asText(row.values.partner_code) || null,
            partnerName: asText(row.values.partner_name),
            branchCode: asText(row.values.branch_code),
            sourceScope: asText(row.values.source_scope) || "EXTERNAL",
            moneySourceCode: asText(row.values.money_source_code),
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
      const transferSequence = await tx.moneyTransfer.count();
      for (let index = 0; index < input.rows.length; index += 1) {
        const row = input.rows[index];
        const transferDate = asDate(row.values.transfer_date);
        const ym = `${transferDate.getUTCFullYear()}${String(transferDate.getUTCMonth() + 1).padStart(2, "0")}`;
        const transfer = await tx.moneyTransfer.create({
          data: {
            importBatchId: batch.id,
            code: `CTNB-${ym}-${String(transferSequence + index + 1).padStart(4, "0")}`,
            transferDate,
            branchCode: asText(row.values.branch_code),
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
      const debtSequence = await tx.debtRecord.count();
      for (let index = 0; index < input.rows.length; index += 1) {
        const row = input.rows[index];
        const documentDate = asDate(row.values.document_date);
        const debtType = asText(row.values.debt_type);
        const code = asText(row.values.document_code) ||
          `CN-${debtType === "RECEIVABLE" ? "PT" : "PP"}-${documentDate.toISOString().slice(0, 10).replace(/-/g, "")}-${String(debtSequence + index + 1).padStart(4, "0")}`;
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

    return tx.importBatch.findUnique({
      where: { id: batch.id },
      include: {
        bankTransactions: input.importType === "BANK_STATEMENT",
        revenueRows: input.importType === "REVENUE_POS",
        payrollRows: input.importType === "PAYROLL",
        importRows: { orderBy: [{ sheetName: "asc" }, { sourceRowNumber: "asc" }] },
        vouchers: input.importType === "VOUCHER",
        moneyTransfers: input.importType === "INTERNAL_TRANSFER",
        debtRecords: input.importType === "DEBT_OPENING",
        inventoryTransactions: input.importType === "INVENTORY_TRANSACTION",
      },
    });
  });
  await writeAuditLog({
    actorName: input.uploadedBy,
    module: "IMPORT",
    action: "COMMIT_IMPORT",
    entityType: "ImportBatch",
    entityId: batchResult?.id || null,
    entityCode: input.fileName,
    branchCode: input.branchCode || null,
    metadata: { importType: input.importType, templateCode: input.templateCode, totalRows: input.rows.length },
  });
  return batchResult;
}

async function rollbackBankStatement(tx: Prisma.TransactionClient, batchId: string) {
  const lockedRows = await tx.bankStatementTransaction.count({
    where: {
      importBatchId: batchId,
      OR: [{ reconcileStatus: { not: "UNMATCHED" } }, { matches: { some: {} } }],
    },
  });
  if (lockedRows > 0) throw new Error("Batch sao kê đã có dòng đối soát, cần hủy đối soát trước khi rollback");
  await tx.bankStatementTransaction.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackRevenue(tx: Prisma.TransactionClient, batchId: string) {
  await rollbackInventoryTransactions(tx, batchId);
  const rows = await tx.revenueImportRow.findMany({ where: { importBatchId: batchId }, select: { id: true } });
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx.journalEntry.deleteMany({ where: { sourceType: "REVENUE_POS", sourceId: { in: ids } } });
  }
  await tx.revenueImportRow.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackPayroll(tx: Prisma.TransactionClient, batchId: string) {
  const rows = await tx.payrollImportRow.findMany({ where: { importBatchId: batchId }, select: { id: true } });
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx.journalEntry.deleteMany({ where: { sourceType: "PAYROLL", sourceId: { in: ids } } });
  }
  await tx.payrollImportRow.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackVouchers(tx: Prisma.TransactionClient, batchId: string) {
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

async function rollbackTransfers(tx: Prisma.TransactionClient, batchId: string) {
  await tx.moneyTransfer.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackDebtOpening(tx: Prisma.TransactionClient, batchId: string) {
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

async function rollbackMasterData(tx: Prisma.TransactionClient, batchId: string) {
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

async function rollbackInventoryItems(tx: Prisma.TransactionClient, batchId: string) {
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
  tx: Prisma.TransactionClient,
  itemId: string,
  warehouseCode: string,
  quantityDelta: number,
) {
  const balance = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseCode: { itemId, warehouseCode } } });
  const nextQuantity = (balance?.quantity || 0) + quantityDelta;
  if (nextQuantity < -0.000001) throw new Error("Rollback import kho se lam am ton kho, can kiem tra thu cong");
  if (!balance) {
    await tx.inventoryBalance.create({ data: { itemId, warehouseCode, quantity: nextQuantity, averageCost: 0 } });
  } else {
    await tx.inventoryBalance.update({ where: { id: balance.id }, data: { quantity: nextQuantity } });
  }
}

async function rollbackInventoryTransactions(tx: Prisma.TransactionClient, batchId: string) {
  const transactions = await tx.inventoryTransaction.findMany({
    where: { importBatchId: batchId },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });
  for (const transaction of transactions) {
    for (const line of transaction.lines) {
      if (transaction.transactionType.startsWith("NHAP_")) {
        await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.warehouseCode, -line.quantity);
      } else if (transaction.transactionType.startsWith("XUAT_")) {
        await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.warehouseCode, line.quantity);
      } else if (transaction.transactionType === "DIEU_CHUYEN") {
        await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.warehouseCode, line.quantity);
        if (transaction.toWarehouseCode) await adjustInventoryBalanceForRollback(tx, line.itemId, transaction.toWarehouseCode, -line.quantity);
      }
    }
  }
  await tx.inventoryTransaction.deleteMany({ where: { importBatchId: batchId } });
}

async function rollbackBom(tx: Prisma.TransactionClient, batchId: string) {
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

async function rollbackStocktake(tx: Prisma.TransactionClient, batchId: string) {
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

async function rollbackOpeningBalances(tx: Prisma.TransactionClient, batchId: string) {
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
  const result = await prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.findUnique({ where: { id: input.batchId } });
    if (!batch) throw new Error("Không tìm thấy batch import");
    if (!["COMMITTED", "APPROVED", "COMMITTED_WITH_ERRORS"].includes(batch.status)) {
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
    else if (batch.importType === "BOM") await rollbackBom(tx, batch.id);
    else if (batch.importType === "STOCKTAKE") await rollbackStocktake(tx, batch.id);
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
