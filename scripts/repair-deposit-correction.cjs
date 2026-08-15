/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
};
const depositCode = valueOf("--code").trim();
const apply = args.includes("--apply");
const confirmCode = valueOf("--confirm").trim();

function usageError(message) {
  throw new Error(`${message}\nDùng: npm run repair:deposit-correction -- --code PCOC-... [--apply --confirm PCOC-...]`);
}

async function main() {
  if (!depositCode) usageError("Thiếu --code");
  if (apply && confirmCode !== depositCode) {
    usageError(`Chế độ --apply yêu cầu --confirm ${depositCode}`);
  }

  const deposit = await prisma.deposit.findUnique({
    where: { code: depositCode },
    include: { histories: { orderBy: { createdAt: "asc" } } },
  });
  if (!deposit) usageError(`Không tìm thấy phiếu cọc ${depositCode}`);

  const originalHistory = deposit.histories.find((row) =>
    ["CREATE", "COLLECT"].includes(row.action) && !row.voucherId,
  );
  const correctionHistories = deposit.histories.filter((row) =>
    row.action === "UPDATE" && row.amount !== null && Math.abs(row.amount) > 0,
  );
  if (!originalHistory) usageError("Không tìm thấy lịch sử nhận cọc ban đầu không gắn chứng từ");

  const originalAmount = Number(originalHistory.amount || 0);
  const correctionAmount = correctionHistories.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const correctedOriginalAmount = originalAmount + correctionAmount;
  const correctionJournalEntries = correctionHistories.length > 0
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "DEPOSIT_HISTORY", sourceId: { in: correctionHistories.map((row) => row.id) } },
        select: { id: true, code: true, sourceId: true },
      })
    : [];
  const originalJournalEntry = await prisma.journalEntry.findUnique({
    where: { sourceType_sourceId: { sourceType: "DEPOSIT_HISTORY", sourceId: originalHistory.id } },
    include: { lines: true },
  });

  console.table([{
    ma_coc: deposit.code,
    so_tien_phieu_hien_tai: deposit.amount,
    nhan_coc_goc_dang_ghi_so: originalAmount,
    tong_dieu_chinh_sai: correctionAmount,
    nhan_coc_goc_sau_sua: correctedOriginalAmount,
    but_toan_dieu_chinh_can_xoa: correctionJournalEntries.map((row) => row.code).join(", ") || "-",
  }]);

  if (correctionHistories.length === 0) {
    console.log("Không có lịch sử UPDATE mang số tiền cần repair.");
    return;
  }
  if (!originalJournalEntry) usageError("Không tìm thấy bút toán nhận cọc ban đầu");
  if (correctedOriginalAmount <= 0) usageError("Số nhận cọc gốc sau repair không hợp lệ");
  if (Math.abs(correctedOriginalAmount - deposit.amount) > 0.5) {
    usageError("Số nhận cọc sau repair không bằng số tiền hiện tại của phiếu; cần kiểm tra thủ công các nghiệp vụ bổ sung/cấn trừ");
  }

  if (!apply) {
    console.log("DRY-RUN: chưa ghi database.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.depositHistory.update({
      where: { id: originalHistory.id },
      data: { amount: correctedOriginalAmount },
    });
    await tx.depositHistory.updateMany({
      where: { id: { in: correctionHistories.map((row) => row.id) } },
      data: { amount: null },
    });
    if (correctionJournalEntries.length > 0) {
      await tx.journalLine.deleteMany({
        where: { entryId: { in: correctionJournalEntries.map((row) => row.id) } },
      });
      await tx.journalEntry.deleteMany({
        where: { id: { in: correctionJournalEntries.map((row) => row.id) } },
      });
    }
    for (const line of originalJournalEntry.lines) {
      await tx.journalLine.update({
        where: { id: line.id },
        data: {
          debit: line.debit > 0 ? correctedOriginalAmount : 0,
          credit: line.credit > 0 ? correctedOriginalAmount : 0,
        },
      });
    }
  });

  console.log(`Đã repair ${deposit.code}: bút toán nhận cọc gốc còn ${correctedOriginalAmount.toLocaleString("vi-VN")} đ.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
