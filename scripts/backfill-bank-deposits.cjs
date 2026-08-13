/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
};
const branchCode = valueOf("--branch").trim().toUpperCase();
const fromText = valueOf("--from").trim();
const toText = valueOf("--to").trim();
const apply = args.includes("--apply");
const confirmBranch = valueOf("--confirm").trim().toUpperCase();

function usageError(message) {
  throw new Error(`${message}\nDùng: npm run backfill:bank-deposits -- --branch ALL --from 2026-08-01 --to 2026-08-31 [--apply --confirm ALL]`);
}

function utcDate(text, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) usageError(`${label} không hợp lệ: ${text || "(trống)"}`);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) usageError(`${label} không hợp lệ: ${text}`);
  return date;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isDepositCategory(category) {
  const value = normalize(`${category?.code || ""} ${category?.name || ""}`);
  return value.includes("deposit") || (value.includes("tien") && value.includes("coc"));
}

function objectNameFor(voucher, bankTransaction) {
  const explicit = String(voucher.counterpartyAccountName || "").trim();
  if (explicit) return explicit;
  const bankPartner = String(bankTransaction?.partnerHint || "").trim();
  if (bankPartner) return bankPartner;
  const partner = String(voucher.partnerName || "").trim();
  return normalize(partner) === "doi tac theo sao ke" || normalize(partner) === "khach hang mua le" ? null : (partner || null);
}

async function main() {
  if (!branchCode) usageError("Thiếu --branch");
  const from = utcDate(fromText, "--from");
  const to = utcDate(toText, "--to");
  if (to < from) usageError("--to phải lớn hơn hoặc bằng --from");
  const end = new Date(to);
  end.setUTCDate(end.getUTCDate() + 1);
  if (apply && confirmBranch !== branchCode) usageError(`Chế độ --apply yêu cầu --confirm ${branchCode}`);

  const [categories, retailPartner, vouchers] = await Promise.all([
    prisma.masterDataItem.findMany({
      where: { type: "REVENUE_EXPENSE_CATEGORY", status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true },
    }),
    prisma.masterDataItem.findFirst({
      where: { type: "PARTNER", code: "KH_LE", status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true },
    }),
    prisma.financialVoucher.findMany({
      where: {
        ...(branchCode === "ALL" ? {} : { branchCode }),
        voucherDate: { gte: from, lt: end },
        voucherType: "RECEIPT",
        documentChannel: "BANK",
        status: "APPROVED",
        deletedAt: null,
        categoryCode: { not: null },
        OR: [{ importBatchId: { not: null } }, { sourceScope: "BANK_STATEMENT_AUTO" }],
      },
      include: { depositHistories: { select: { id: true, depositId: true, action: true } } },
      orderBy: [{ voucherDate: "asc" }, { code: "asc" }],
    }),
  ]);

  if (!retailPartner) usageError("Không tìm thấy đối tượng mặc định KH_LE đang hoạt động");
  const depositCategoryCodes = new Set(categories.filter(isDepositCategory).map((row) => row.code));
  if (depositCategoryCodes.size === 0) usageError("Không tìm thấy danh mục Thu tiền cọc đang hoạt động");
  const depositVouchers = vouchers.filter((row) => depositCategoryCodes.has(row.categoryCode));
  const matches = depositVouchers.length > 0
    ? await prisma.reconciliationMatch.findMany({
        where: { targetType: "VOUCHER", targetId: { in: depositVouchers.map((row) => row.id) }, deletedAt: null },
        select: { targetId: true, bankTransaction: { select: { partnerHint: true } } },
      })
    : [];
  const bankTransactionByVoucherId = new Map(matches.map((row) => [row.targetId, row.bankTransaction]));

  const rows = [];
  for (const voucher of depositVouchers) {
    const depositCode = voucher.depositCode || `COC-${voucher.code}`;
    let result = "CO_THE_BACKFILL";
    let reason = "Đủ điều kiện";
    if (voucher.depositHistories.length > 0) {
      result = "BO_QUA";
      reason = `Đã liên kết tiền cọc (${voucher.depositHistories[0].action})`;
    } else {
      const existingCode = await prisma.deposit.findUnique({ where: { code: depositCode }, select: { id: true } });
      if (existingCode) {
        result = "XUNG_DOT";
        reason = `Mã tiền cọc ${depositCode} đã tồn tại nhưng chưa liên kết chứng từ`;
      }
    }
    rows.push({
      voucher,
      depositCode,
      objectName: objectNameFor(voucher, bankTransactionByVoucherId.get(voucher.id)),
      result,
      reason,
    });
  }

  console.table(rows.map((row) => ({
    ma_chung_tu: row.voucher.code,
    cua_hang: row.voucher.branchCode,
    ngay: row.voucher.voucherDate.toISOString().slice(0, 10),
    so_tien: row.voucher.amount,
    doi_tuong: row.objectName || "-",
    ma_coc: row.depositCode,
    ket_qua: apply && row.result === "CO_THE_BACKFILL" ? "APPLY" : row.result,
    ly_do: row.reason,
  })));

  const eligible = rows.filter((row) => row.result === "CO_THE_BACKFILL");
  if (!apply) {
    console.log(`DRY-RUN: ${eligible.length} chứng từ có thể backfill; không ghi database.`);
    return;
  }

  let applied = 0;
  for (const row of eligible) {
    await prisma.$transaction(async (tx) => {
      // Kiểm tra lại trong transaction để script chạy lặp vẫn an toàn.
      const linked = await tx.depositHistory.findFirst({ where: { voucherId: row.voucher.id } });
      if (linked) return;
      const collision = await tx.deposit.findUnique({ where: { code: row.depositCode } });
      if (collision) throw new Error(`Mã tiền cọc ${row.depositCode} đã phát sinh trong lúc chạy`);

      const deposit = await tx.deposit.create({
        data: {
          code: row.depositCode,
          receivedDate: row.voucher.voucherDate,
          partnerCode: retailPartner.code,
          partnerName: retailPartner.name,
          objectName: row.objectName,
          branchCode: row.voucher.branchCode,
          moneySourceCode: row.voucher.moneySourceCode,
          amount: row.voucher.amount,
          remainingAmount: row.voucher.amount,
          purpose: row.voucher.description,
          note: `Backfill từ chứng từ ngân hàng ${row.voucher.code}`,
          histories: {
            create: {
              action: "COLLECT",
              amount: row.voucher.amount,
              actionDate: row.voucher.voucherDate,
              treatmentNote: "Thu tiền cọc từ sao kê ngân hàng",
              actor: "BACKFILL_BANK_DEPOSIT",
              voucherId: row.voucher.id,
              note: row.voucher.description,
            },
          },
        },
      });
      await tx.financialVoucher.update({
        where: { id: row.voucher.id },
        data: {
          partnerCode: retailPartner.code,
          partnerName: retailPartner.name,
          counterpartyAccountName: row.objectName,
          depositAction: "COLLECT",
          depositCode: deposit.code,
        },
      });
      applied += 1;
    });
  }
  console.log(`Đã backfill ${applied} chứng từ sang màn hình Tiền cọc.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
