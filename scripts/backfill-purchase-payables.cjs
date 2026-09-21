/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Dựng công nợ phải trả NCC cho các phiếu NHẬP MUA đã ghi trước ngày 21/09/2026.
 *
 * Trước đó phiếu nhập mua (import file Nhập/Xuất kho hoặc ghi tay) chỉ tăng tồn kho, không
 * sinh khoản phải trả nào — khách đẩy nhập mua lên rồi không thấy công nợ NCC đâu. Từ nay
 * lib/purchase-payable.ts sinh khoản nợ ngay lúc ghi phiếu; script này bù cho phiếu cũ.
 *
 * KHÔNG đụng tới:
 *   - phiếu nhận hàng theo Đơn mua hàng (referenceType = PURCHASE_ORDER): đã có SupplierPayable,
 *     dựng thêm là nợ gấp đôi;
 *   - phiếu không khai NCC (không biết nợ ai) và phiếu giá trị 0 (hàng khuyến mãi);
 *   - phiếu đã có khoản nợ mang đúng mã CN-<mã phiếu>.
 *
 * Chạy thử:  node scripts/backfill-purchase-payables.cjs
 * Ghi thật:  node scripts/backfill-purchase-payables.cjs --apply
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes("--apply");
const money = (value) => new Intl.NumberFormat("vi-VN").format(Math.round(value || 0));

async function main() {
  const transactions = await prisma.inventoryTransaction.findMany({
    where: {
      transactionType: "NHAP_MUA",
      partnerCode: { not: null },
      deletedAt: null,
      NOT: { referenceType: "PURCHASE_ORDER" },
    },
    include: { lines: { select: { totalCost: true } } },
    orderBy: { transactionDate: "asc" },
  });

  const existing = await prisma.debtRecord.findMany({
    where: { code: { in: transactions.map((transaction) => `CN-${transaction.code}`) } },
    select: { code: true },
  });
  const existingCodes = new Set(existing.map((debt) => debt.code));

  const partners = await prisma.masterDataItem.findMany({
    where: { type: "PARTNER" },
    select: { code: true, name: true, partnerGroup: true },
  });
  const partnerByCode = new Map(partners.map((partner) => [partner.code, partner]));

  const todo = [];
  const skipped = { daCo: 0, giaTriKhong: 0, ncCLa: 0 };
  for (const transaction of transactions) {
    if (existingCodes.has(`CN-${transaction.code}`)) { skipped.daCo += 1; continue; }
    // Script chạy bằng client thô nên không có lớp làm tròn của lib/prisma.ts — tròn tay ở đây.
    const amount = Math.round(transaction.lines.reduce((sum, line) => sum + line.totalCost, 0));
    if (amount <= 0) { skipped.giaTriKhong += 1; continue; }
    const partner = partnerByCode.get(transaction.partnerCode);
    if (!partner) { skipped.ncCLa += 1; continue; }
    todo.push({ transaction, amount, partner });
  }

  const byPartner = new Map();
  for (const item of todo) {
    const current = byPartner.get(item.partner.code) || { name: item.partner.name, amount: 0, count: 0 };
    current.amount += item.amount;
    current.count += 1;
    byPartner.set(item.partner.code, current);
  }

  console.log(`Phiếu nhập mua có NCC (ngoài PO): ${transactions.length}`);
  console.log(`  - đã có công nợ: ${skipped.daCo}`);
  console.log(`  - giá trị 0, bỏ qua: ${skipped.giaTriKhong}`);
  console.log(`  - NCC không còn trong danh mục, bỏ qua: ${skipped.ncCLa}`);
  console.log(`  => sẽ dựng: ${todo.length} khoản, tổng ${money(todo.reduce((sum, item) => sum + item.amount, 0))} đ`);
  console.log("");
  for (const [code, row] of [...byPartner.entries()].sort((left, right) => right[1].amount - left[1].amount).slice(0, 20)) {
    console.log(`  ${code.padEnd(14)} ${String(row.count).padStart(4)} phiếu  ${money(row.amount).padStart(16)} đ  ${row.name}`);
  }
  if (byPartner.size > 20) console.log(`  … và ${byPartner.size - 20} đối tác khác`);

  if (!apply) {
    console.log("\nChạy thử — chưa ghi gì. Thêm --apply để ghi thật.");
    return;
  }

  let created = 0;
  for (const { transaction, amount, partner } of todo) {
    const reference = transaction.referenceCode ? ` (chứng từ ${transaction.referenceCode})` : "";
    await prisma.debtRecord.create({
      data: {
        code: `CN-${transaction.code}`,
        debtType: "PAYABLE",
        partnerGroup: partner.partnerGroup || (transaction.partnerCode.startsWith("NB-") ? "INTERNAL" : "EXTERNAL"),
        partnerCode: transaction.partnerCode,
        partnerName: partner.name,
        branchCode: transaction.branchCode,
        documentDate: transaction.transactionDate,
        originalAmount: amount,
        outstandingAmount: amount,
        description: `Công nợ mua hàng theo phiếu nhập ${transaction.code}${reference}`,
        sourceType: "INVENTORY_PURCHASE",
        sourceId: transaction.id,
        recognizeExpense: false,
        status: "OPEN",
      },
    });
    created += 1;
  }
  console.log(`\nĐã dựng ${created} khoản công nợ phải trả.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
