import { Prisma } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { type ImportType } from "@/lib/import-templates";
import { type ParsedImportRow } from "@/lib/import-parser";

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

type CommitInput = {
  importType: ImportType;
  templateCode: string;
  fileName: string;
  uploadedBy: string;
  mapping: Record<string, string>;
  rows: ParsedImportRow[];
};

export async function commitImport(input: CommitInput) {
  const errorRows = input.rows.filter((row) => row.errors.length > 0);
  if (errorRows.length > 0) {
    throw new Error("File còn dòng lỗi, vui lòng sửa trước khi commit");
  }

  return prisma.$transaction(async (tx) => {
    if (input.importType === "BANK_STATEMENT") {
      const duplicateKeys = await Promise.all(
        input.rows.map((row) =>
          tx.bankStatementTransaction.findUnique({
            where: {
              bankAccount_transactionCode: {
                bankAccount: asText(row.values.bank_account),
                transactionCode: asText(row.values.transaction_code),
              },
            },
            select: { id: true },
          }),
        ),
      );
      if (duplicateKeys.some(Boolean)) {
        throw new Error("File có giao dịch trùng với dữ liệu đã import, vui lòng kiểm tra lại trước khi commit");
      }
    }

    if (input.importType === "REVENUE_POS") {
      const duplicateKeys = await Promise.all(
        input.rows.map((row) =>
          tx.revenueImportRow.findUnique({
            where: {
              branchCode_saleDate_externalRef: {
                branchCode: asText(row.values.branch_code),
                saleDate: asDate(row.values.sale_date),
                externalRef: asText(row.values.external_ref),
              },
            },
            select: { id: true },
          }),
        ),
      );
      if (duplicateKeys.some(Boolean)) {
        throw new Error("File có dòng doanh thu trùng với dữ liệu đã import, vui lòng kiểm tra lại trước khi commit");
      }
    }

    if (input.importType === "PAYROLL") {
      const duplicateKeys = await Promise.all(
        input.rows.map((row) => tx.payrollImportRow.findUnique({
          where: {
            period_employeeCode_branchCode: {
              period: asText(row.values.period),
              employeeCode: asText(row.values.employee_code),
              branchCode: asText(row.values.branch_code),
            },
          },
          select: { id: true },
        })),
      );
      if (duplicateKeys.some(Boolean)) throw new Error("File có nhân viên trùng kỳ lương và chi nhánh");
    }

    const batch = await tx.importBatch.create({
      data: {
        importType: input.importType,
        templateCode: input.templateCode,
        fileName: input.fileName,
        uploadedBy: input.uploadedBy,
        status: "COMMITTED",
        totalRows: input.rows.length,
        validRows: input.rows.length,
        errorRows: 0,
        mappingJson: JSON.stringify(input.mapping),
        committedAt: new Date(),
      },
    });

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
      await tx.revenueImportRow.createMany({
        data: input.rows.map((row) => ({
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
        })),
      });
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

    return tx.importBatch.findUnique({
      where: { id: batch.id },
      include: {
        bankTransactions: input.importType === "BANK_STATEMENT",
        revenueRows: input.importType === "REVENUE_POS",
        payrollRows: input.importType === "PAYROLL",
      },
    });
  });
}

export function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
