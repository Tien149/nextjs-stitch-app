/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Đưa "Ngày thực tế nộp tiền" của phiếu NỘP TIỀN MẶT về đúng NGÀY CHỨNG TỪ của phiếu.
 *
 * Trước 21/09/2026 lúc duyệt kế toán nhập MỘT ngày thực tế cho cả lô phiếu đang tick, nên
 * phiếu của ca ngày 2/8 duyệt ngày 8/8 mang luôn ngày thực tế 8/8. Từ nay sổ quỹ ghi theo ngày
 * chứng từ nên số liệu đã đúng trở lại, nhưng cột "Ngày thực tế nộp tiền" trên màn hình vẫn
 * hiện ngày duyệt — script này dọn nốt cho khớp.
 *
 * BỎ QUA phiếu nằm trong kỳ đã khoá sổ: khoá sổ là cửa duy nhất, không sửa vòng sau lưng.
 *
 * Chạy thử:  node scripts/backfill-cash-deposit-actual-date.cjs
 * Ghi thật:  node scripts/backfill-cash-deposit-actual-date.cjs --apply
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const apply = process.argv.slice(2).includes("--apply");
const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "—");
const periodOf = (value) => new Date(value).toISOString().slice(0, 7);
const money = (value) => new Intl.NumberFormat("vi-VN").format(Math.round(value || 0));

async function main() {
  const transfers = await prisma.moneyTransfer.findMany({
    where: { transferPurpose: "CASH_DEPOSIT", actualTransferDate: { not: null }, deletedAt: null },
    select: { id: true, code: true, branchCode: true, transferDate: true, actualTransferDate: true, amount: true, status: true },
    orderBy: { transferDate: "asc" },
  });
  const mismatched = transfers.filter((row) => day(row.transferDate) !== day(row.actualTransferDate));

  const closed = await prisma.accountingPeriod.findMany({
    where: { status: "CLOSED" },
    select: { period: true, branchCode: true },
  });
  const closedKeys = new Set(closed.map((row) => `${row.period}|${row.branchCode}`));
  const isClosed = (row) => closedKeys.has(`${periodOf(row.transferDate)}|${row.branchCode}`)
    || closedKeys.has(`${periodOf(row.actualTransferDate)}|${row.branchCode}`);

  const todo = mismatched.filter((row) => !isClosed(row));
  const skipped = mismatched.filter((row) => isClosed(row));

  console.log(`Phiếu nộp tiền có ngày thực tế: ${transfers.length}`);
  console.log(`  - lệch với ngày chứng từ: ${mismatched.length}`);
  console.log(`  - nằm trong kỳ đã khoá, bỏ qua: ${skipped.length}`);
  console.log(`  => sẽ sửa: ${todo.length} phiếu\n`);
  for (const row of todo.slice(0, 30)) {
    console.log(`  ${row.code.padEnd(24)} ${row.branchCode.padEnd(6)} chứng từ ${day(row.transferDate)}  thực tế ${day(row.actualTransferDate)} -> ${day(row.transferDate)}  ${money(row.amount).padStart(14)} đ`);
  }
  if (todo.length > 30) console.log(`  … và ${todo.length - 30} phiếu nữa`);
  for (const row of skipped.slice(0, 10)) {
    console.log(`  [KHOÁ SỔ] ${row.code} ${day(row.transferDate)} / ${day(row.actualTransferDate)} — phải mở kỳ mới sửa được`);
  }

  if (!apply) {
    console.log("\nChạy thử — chưa ghi gì. Thêm --apply để ghi thật.");
    return;
  }

  let updated = 0;
  for (const row of todo) {
    await prisma.moneyTransfer.update({ where: { id: row.id }, data: { actualTransferDate: row.transferDate } });
    updated += 1;
  }
  console.log(`\nĐã sửa ${updated} phiếu.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
