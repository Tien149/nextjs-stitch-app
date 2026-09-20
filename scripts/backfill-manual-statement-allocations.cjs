/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Bù dòng PHÂN BỔ cho các dòng sao kê "Dựng tay từ phiếu thu" đã tạo trước khi sửa lỗi.
 *
 * Nút "Dựng dòng sao kê" bản đầu chỉ tạo BankStatementTransaction mà không tạo
 * BankStatementAllocation — trong khi "Tiền về đủ chưa" và Báo cáo nguồn tiền đều cộng tiền
 * theo DÒNG PHÂN BỔ. Hậu quả: dòng nằm trong Sổ sao kê, đã nối chứng từ, mà bảng vẫn báo
 * CHƯA VỀ (khách báo 20/09/2026). Script cũng bù luôn Loại nghiệp vụ đích còn trống, vốn làm
 * Sổ sao kê hiện "Dữ liệu cũ".
 *
 * Chạy thử:  node scripts/backfill-manual-statement-allocations.cjs
 * Ghi thật:  node scripts/backfill-manual-statement-allocations.cjs --apply
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes("--apply");

/** Giữ khớp với SALES_RECEIPT_CATEGORY_CODES trong lib/voucher-rules.ts. */
const SALES_RECEIPT_CATEGORY_CODES = ["THU_BAN_HANG"];
const money = (value) => new Intl.NumberFormat("vi-VN").format(Math.round(value || 0));

async function main() {
  const rows = await prisma.bankStatementTransaction.findMany({
    where: { entrySource: "MANUAL_VOUCHER", deletedAt: null, allocations: { none: {} } },
    select: {
      id: true, transactionCode: true, transactionDate: true, description: true,
      creditAmount: true, revenueDate: true, accountingDate: true, categoryCode: true,
      increaseMoneySourceCode: true, decreaseMoneySourceCode: true, operationType: true,
    },
    orderBy: { transactionDate: "asc" },
  });

  if (rows.length === 0) {
    console.log("Không có dòng dựng tay nào thiếu dòng phân bổ.");
    return;
  }

  console.log(`${rows.length} dòng dựng tay thiếu dòng phân bổ${apply ? "" : " (chạy thử, chưa ghi gì)"}:`);
  for (const row of rows) {
    const moneySource = row.decreaseMoneySourceCode || row.increaseMoneySourceCode || null;
    const operationType = row.operationType
      || (SALES_RECEIPT_CATEGORY_CODES.includes(row.categoryCode || "") ? "REVENUE_RECEIPT" : "OTHER_RECEIPT");
    console.log(`  ${row.transactionCode} · ${row.transactionDate.toISOString().slice(0, 10)} · ${money(row.creditAmount)} đ · ${moneySource || "(chưa có nguồn tiền)"}`);
    if (!apply) continue;
    await prisma.$transaction(async (tx) => {
      const patch = {};
      if (!row.operationType) patch.operationType = operationType;
      if (!row.increaseMoneySourceCode && moneySource) patch.increaseMoneySourceCode = moneySource;
      if (Object.keys(patch).length > 0) {
        await tx.bankStatementTransaction.update({ where: { id: row.id }, data: patch });
      }
      await tx.bankStatementAllocation.create({
        data: {
          bankTransactionId: row.id,
          sourceRowNumber: 1,
          sheetName: "Dựng tay",
          description: row.description,
          creditAmount: row.creditAmount,
          revenueDate: row.revenueDate || row.transactionDate,
          accountingDate: row.accountingDate || row.transactionDate,
          categoryCode: row.categoryCode,
          increaseMoneySourceCode: moneySource,
          decreaseMoneySourceCode: moneySource,
          operationType,
          autoProcessType: "RECEIPT",
        },
      });
    });
  }
  console.log(apply ? "Đã bù xong." : "Chạy lại kèm --apply để ghi.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
