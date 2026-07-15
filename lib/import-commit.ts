import { Prisma } from "@prisma/client";
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
        skipDuplicates: true,
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
        skipDuplicates: true,
      });
    }

    return tx.importBatch.findUnique({
      where: { id: batch.id },
      include: {
        bankTransactions: input.importType === "BANK_STATEMENT",
        revenueRows: input.importType === "REVENUE_POS",
      },
    });
  });
}

export function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
