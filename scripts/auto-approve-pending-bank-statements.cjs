/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const applyChanges = process.argv.includes("--apply");
const actor = "BANK_STATEMENT_AUTO_MIGRATION";

function periodFromDate(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isSpecialCategory(category) {
  const value = normalize(`${category?.code || ""} ${category?.name || ""}`);
  return ["tien coc", "cong no", "phan bo", "tra truoc"].some((keyword) => value.includes(keyword));
}

async function periodIsOpen(date, branchCode) {
  const period = periodFromDate(date);
  const periods = await prisma.accountingPeriod.findMany({
    where: { period, branchCode: { in: [branchCode, "ALL"] } },
    select: { status: true },
  });
  return periods.every((row) => row.status !== "CLOSED");
}

async function evaluate(row) {
  if (!(await periodIsOpen(row.transactionDate, row.branchCode))) return { safe: false, reason: "Kỳ kế toán đã khóa" };
  if (row.matches.length !== 1) return { safe: false, reason: "Không có đúng một liên kết đối soát" };
  const match = row.matches[0];

  if (match.targetType === "WALLET_SETTLEMENT") {
    const transfer = await prisma.moneyTransfer.findFirst({
      where: { id: match.targetId, importBatchId: row.importBatchId, status: "PENDING_REVIEW", deletedAt: null },
    });
    if (!transfer || transfer.transferPurpose !== "WALLET_SETTLEMENT") return { safe: false, reason: "Phiếu quyết toán ví không còn ở trạng thái chờ duyệt" };
    const [fromSource, toSource, allocations] = await Promise.all([
      prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: transfer.fromMoneySourceCode, status: "ACTIVE", deletedAt: null } }),
      prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: transfer.toMoneySourceCode, status: "ACTIVE", deletedAt: null } }),
      prisma.bankStatementAllocation.findMany({ where: { bankTransactionId: row.id }, select: { grossAmount: true } }),
    ]);
    const gross = allocations.reduce((sum, item) => sum + (item.grossAmount || 0), 0);
    if (fromSource?.group !== "WALLET" || toSource?.group !== "BANK" || gross < transfer.amount) {
      return { safe: false, reason: "Nguồn ví/ngân hàng hoặc số gross chưa hợp lệ" };
    }
    return { safe: true, target: "TRANSFER", targetId: transfer.id, targetCode: transfer.code };
  }

  const voucher = await prisma.financialVoucher.findFirst({
    where: {
      id: match.targetId,
      importBatchId: row.importBatchId,
      sourceScope: "BANK_STATEMENT_AUTO",
      documentChannel: "BANK",
      status: "PENDING_REVIEW",
      deletedAt: null,
    },
  });
  if (!voucher || voucher.depositAction || voucher.debtAction || (voucher.allocationMonths || 0) > 1) {
    return { safe: false, reason: "Chứng từ không còn thuần nghiệp vụ ngân hàng chờ duyệt" };
  }
  const [source, category] = await Promise.all([
    prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: voucher.moneySourceCode, status: "ACTIVE", deletedAt: null } }),
    voucher.categoryCode
      ? prisma.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: voucher.categoryCode, status: "ACTIVE", deletedAt: null } })
      : null,
  ]);
  if (source?.group !== "BANK" || !category || category.group !== voucher.voucherType || isSpecialCategory(category)) {
    return { safe: false, reason: "Nguồn tiền/khoản mục không đủ điều kiện tự động duyệt" };
  }
  return { safe: true, target: "VOUCHER", targetId: voucher.id, targetCode: voucher.code };
}

async function main() {
  const rows = await prisma.bankStatementTransaction.findMany({
    where: { reconcileStatus: "PENDING_REVIEW", importBatchId: { not: "" }, deletedAt: null },
    include: { matches: { where: { status: "PENDING_REVIEW", deletedAt: null } } },
    orderBy: [{ transactionDate: "asc" }, { transactionCode: "asc" }],
  });
  const review = [];
  for (const row of rows) review.push({ row, decision: await evaluate(row) });

  console.table(review.map(({ row, decision }) => ({
    transactionCode: row.transactionCode,
    date: row.transactionDate.toISOString().slice(0, 10),
    branch: row.branchCode,
    target: decision.targetCode || "-",
    safeToApply: decision.safe,
    reason: decision.reason || "Đủ điều kiện",
  })));
  const safeRows = review.filter(({ decision }) => decision.safe);
  console.log(`Tổng chờ duyệt: ${review.length}; đủ điều kiện: ${safeRows.length}; cần kiểm tra tay: ${review.length - safeRows.length}.`);
  if (!applyChanges) {
    console.log("DRY RUN: chưa thay đổi dữ liệu. Sau khi backup và kiểm tra danh sách, chạy lại với --apply.");
    return;
  }

  for (const { row, decision } of safeRows) {
    await prisma.$transaction(async (tx) => {
      if (decision.target === "VOUCHER") {
        await tx.financialVoucher.update({ where: { id: decision.targetId }, data: { status: "APPROVED", approvedBy: actor } });
      } else {
        await tx.moneyTransfer.update({ where: { id: decision.targetId }, data: { status: "APPROVED", approvedBy: actor } });
      }
      await tx.reconciliationMatch.updateMany({
        where: { bankTransactionId: row.id, targetId: decision.targetId, status: "PENDING_REVIEW" },
        data: { status: "MATCHED", matchedBy: actor, note: "Tự động duyệt dữ liệu lịch sử sau khi rà soát" },
      });
      await tx.bankStatementTransaction.update({
        where: { id: row.id },
        data: { reconcileStatus: "MATCHED", autoProcessNote: `Đã tự động duyệt dữ liệu lịch sử với ${decision.targetCode}` },
      });
    });
  }
  console.log(`Đã tự động duyệt ${safeRows.length} giao dịch. Các dòng không chắc chắn được giữ nguyên.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
