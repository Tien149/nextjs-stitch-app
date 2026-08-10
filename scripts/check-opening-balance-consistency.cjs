/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();

async function main() {
  const [retailCustomer, effectiveDeposits, eligibleDeposits, legacyDepositsMissingObject, linkedDeposits, invalidLinks, confirmedCashSources] = await Promise.all([
    prisma.masterDataItem.findUnique({
      where: { type_code: { type: "PARTNER", code: "KH_LE" } },
      select: { code: true, name: true, status: true },
    }),
    prisma.openingBalance.count({
      where: { balanceType: "DEPOSIT", status: { in: ["POSTED", "CONFIRMED"] }, deletedAt: null },
    }),
    prisma.openingBalance.count({
      where: {
        balanceType: "DEPOSIT", status: { in: ["POSTED", "CONFIRMED"] }, deletedAt: null,
        objectCode: { not: null },
      },
    }),
    prisma.openingBalance.findMany({
      where: {
        balanceType: "DEPOSIT", status: { in: ["POSTED", "CONFIRMED"] }, deletedAt: null,
        objectCode: null,
      },
      select: { id: true, period: true, branchCode: true, objectCode: true, moneySourceCode: true, amount: true },
    }),
    prisma.deposit.count({
      where: { sourceOpeningBalanceId: { not: null }, deletedAt: null },
    }),
    prisma.deposit.count({
      where: {
        sourceOpeningBalanceId: { not: null },
        deletedAt: null,
        OR: [
          { sourceOpeningBalance: { is: { balanceType: { not: "DEPOSIT" } } } },
          { sourceOpeningBalance: { is: { status: { notIn: ["POSTED", "CONFIRMED"] } } } },
        ],
      },
    }),
    prisma.openingBalance.count({
      where: {
        balanceType: { in: ["CASH", "BANK", "WALLET_POS"] },
        status: "CONFIRMED",
        deletedAt: null,
      },
    }),
  ]);

  const result = { retailCustomer, effectiveDeposits, eligibleDeposits, legacyDepositsMissingObject, linkedDeposits, invalidLinks, confirmedCashSources };
  console.log(JSON.stringify(result, null, 2));
  if (!retailCustomer || retailCustomer.status !== "ACTIVE") throw new Error("Thiếu đối tượng KH_LE đang hoạt động");
  if (linkedDeposits < eligibleDeposits) throw new Error("Còn số dư tiền cọc đủ thông tin nhưng chưa sinh sổ cọc");
  if (invalidLinks > 0) throw new Error("Có liên kết số dư đầu kỳ và tiền cọc không hợp lệ");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
