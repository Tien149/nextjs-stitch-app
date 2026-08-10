/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const applyChanges = process.argv.includes("--apply");

function dayBoundsUtc(value) {
  const date = new Date(value);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function main() {
  const vouchers = await prisma.financialVoucher.findMany({
    where: {
      sourceScope: "BANK_STATEMENT_AUTO",
      documentChannel: "BANK",
      voucherType: "RECEIPT",
      businessEffect: "RECOGNITION",
      deletedAt: null,
    },
    orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
  });

  const review = [];
  for (const voucher of vouchers) {
    const { start, end } = dayBoundsUtc(voucher.voucherDate);
    const candidates = await prisma.revenueImportRow.findMany({
      where: {
        branchCode: voucher.branchCode,
        saleDate: { gte: start, lt: end },
        deletedAt: null,
      },
      select: { id: true, externalRef: true, saleDate: true, netAmount: true },
    });
    const exact = candidates.filter((row) => Math.abs(row.netAmount - voucher.amount) < 1);
    review.push({
      voucherId: voucher.id,
      voucherCode: voucher.code,
      voucherDate: voucher.voucherDate.toISOString().slice(0, 10),
      branchCode: voucher.branchCode,
      amount: voucher.amount,
      status: voucher.status,
      candidateCount: exact.length,
      candidateRef: exact.length === 1 ? exact[0].externalRef : null,
      safeToApply: exact.length === 1,
    });
  }

  console.table(review);
  const safeRows = review.filter((row) => row.safeToApply);
  console.log(`Tổng chứng từ cần rà: ${review.length}; khớp duy nhất: ${safeRows.length}; cần kiểm tra tay: ${review.length - safeRows.length}.`);

  if (!applyChanges) {
    console.log("Chế độ DRY RUN: chưa cập nhật dữ liệu. Sau khi backup và kiểm tra bảng trên, chạy lại với --apply.");
    return;
  }

  for (const row of safeRows) {
    await prisma.financialVoucher.update({
      where: { id: row.voucherId },
      data: {
        businessEffect: "SETTLEMENT",
        sourceDocumentCode: row.candidateRef,
      },
    });
  }
  console.log(`Đã chuyển ${safeRows.length} chứng từ sang SETTLEMENT. Các dòng mơ hồ không bị thay đổi.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
