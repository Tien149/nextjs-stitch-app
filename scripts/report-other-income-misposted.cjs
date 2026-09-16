/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Rà phiếu THU đáng lẽ là THU NHẬP KHÁC nhưng bút toán đang nằm ở tài khoản khác.
 *
 * Hai luật mới (16/09/2026) chỉ áp cho bút toán ghi sổ TỪ NAY:
 *   - khoản mục thu trong OTHER_INCOME_CATEGORY_ITEMS (lãi ngân hàng) luôn ghi Có 711;
 *   - phiếu thu khai hạng mục P&L nhóm Thu nhập khác cũng ghi Có 711.
 * Phiếu ghi sổ trước đó rơi vào 511 (nhóm "Thu khác" bị gộp về nhóm doanh thu) hoặc 131
 * (có mã đối tác), nên dòng "7. Thu nhập khác" trên P&L thiếu đúng bằng số này.
 *
 * Script CHỈ ĐỌC — in ra danh sách để kế toán quyết, không sửa gì.
 *   node scripts/report-other-income-misposted.cjs [--period=2026-09] [--branch=HN]
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();

/** Giữ khớp với OTHER_INCOME_CATEGORY_ITEMS ở lib/pnl-ordering.ts. */
const OTHER_INCOME_CATEGORY_CODES = ["THU_LAI_NGAN_HANG"];

function argValue(name) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
}

function periodBounds(period) {
  if (!/^\d{4}-\d{2}$/.test(period)) return null;
  const [year, month] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

const money = (value) => new Intl.NumberFormat("vi-VN").format(Math.round(value));

async function main() {
  const period = argValue("period");
  const branch = argValue("branch");
  const bounds = period ? periodBounds(period) : null;
  if (period && !bounds) throw new Error("--period phải có dạng YYYY-MM, ví dụ --period=2026-09");

  const otherIncomeItems = await prisma.masterDataItem.findMany({
    where: { type: "PNL_ITEM", group: "OTHER_INCOME" },
    select: { code: true, name: true },
  });
  const otherIncomeItemCodes = otherIncomeItems.map((item) => item.code);

  const vouchers = await prisma.financialVoucher.findMany({
    where: {
      voucherType: "RECEIPT",
      status: "APPROVED",
      deletedAt: null,
      ...(bounds ? { voucherDate: { gte: bounds.start, lt: bounds.end } } : {}),
      ...(branch && branch.toUpperCase() !== "ALL" ? { branchCode: branch.toUpperCase() } : {}),
      OR: [
        { categoryCode: { in: OTHER_INCOME_CATEGORY_CODES } },
        ...(otherIncomeItemCodes.length > 0 ? [{ pnlItemCode: { in: otherIncomeItemCodes } }] : []),
      ],
    },
    orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
  });

  if (vouchers.length === 0) {
    console.log("Không có phiếu thu nào thuộc diện Thu nhập khác trong phạm vi đã lọc.");
    return;
  }

  const entries = await prisma.journalEntry.findMany({
    where: { sourceType: "VOUCHER", sourceId: { in: vouchers.map((row) => row.id) } },
    include: { lines: { include: { account: { select: { code: true, accountType: true } } } } },
  });
  const entryBySource = new Map(entries.map((entry) => [entry.sourceId, entry]));

  const misposted = [];
  let okCount = 0;
  let unpostedCount = 0;
  for (const voucher of vouchers) {
    const entry = entryBySource.get(voucher.id);
    if (!entry) {
      unpostedCount += 1;
      continue;
    }
    // Vế Có của phiếu thu: đúng thì phải là 711 (accountType OTHER_INCOME).
    const creditLine = entry.lines.find((line) => line.credit > 0);
    if (!creditLine) continue;
    if (creditLine.account.accountType === "OTHER_INCOME") {
      okCount += 1;
      continue;
    }
    misposted.push({ voucher, account: creditLine.account.code, amount: creditLine.credit });
  }

  console.log(`Đã soát ${vouchers.length} phiếu thu thuộc diện Thu nhập khác.`);
  console.log(`  - đã đúng (Có 711): ${okCount}`);
  console.log(`  - chưa ghi sổ:      ${unpostedCount}`);
  console.log(`  - ghi nhầm chỗ:     ${misposted.length}`);
  if (misposted.length === 0) return;

  console.log("");
  console.log("MÃ PHIẾU            NGÀY        CH   TK   SỐ TIỀN            KHOẢN MỤC / HẠNG MỤC   DIỄN GIẢI");
  let total = 0;
  for (const row of misposted) {
    total += row.amount;
    const date = row.voucher.voucherDate.toISOString().slice(0, 10);
    const tag = `${row.voucher.categoryCode || "-"}${row.voucher.pnlItemCode ? ` / ${row.voucher.pnlItemCode}` : ""}`;
    console.log(
      `${row.voucher.code.padEnd(20)}${date}  ${(row.voucher.branchCode || "").padEnd(5)}${row.account.padEnd(5)}`
      + `${money(row.amount).padStart(15)}    ${tag.padEnd(22)} ${row.voucher.description}`,
    );
  }
  console.log("");
  console.log(`Tổng tiền đang nằm sai chỗ: ${money(total)} đ — đây là phần dòng "7. Thu nhập khác" trên P&L đang thiếu.`);
  console.log('Muốn đưa về đúng: mở từng phiếu ở màn Phiếu thu, bấm Sửa rồi Lưu (phiếu tự duyệt lại), sau đó bấm "Đồng bộ ghi sổ" ở màn Sổ cái Kế toán cho kỳ tương ứng.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
