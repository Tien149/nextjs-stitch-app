/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ""; };
const branch = value("--branch").toUpperCase();
const dateText = value("--date");
const apply = args.includes("--apply");
const confirm = value("--confirm").toUpperCase();
const grossOverrideText = value("--gross");
const grabOverrideText = value("--grab");

function optionalAmount(raw, optionName) {
  if (!raw) return null;
  const amount = Number(String(raw).replace(/[.,\s]/g, ""));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`${optionName} phải là số nguyên không âm.`);
  return amount;
}

function allocate(total, weights) {
  const exact = weights.map((weight) => total * weight / weights.reduce((sum, item) => sum + item, 0));
  const result = exact.map(Math.floor);
  let remainder = total - result.reduce((sum, item) => sum + item, 0);
  const order = exact.map((item, index) => ({ index, fraction: item - Math.floor(item) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let cursor = 0; remainder > 0; cursor += 1, remainder -= 1) result[order[cursor % order.length].index] += 1;
  return result;
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function main() {
  if (!branch || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error("Dùng --branch ASA --date 2026-08-01");
  if (apply && confirm !== branch) throw new Error(`Muốn ghi database phải thêm --confirm ${branch}`);
  const grossOverride = optionalAmount(grossOverrideText, "--gross");
  const grabOverride = optionalAmount(grabOverrideText, "--grab");
  if ((grossOverride === null) !== (grabOverride === null)) throw new Error("Phải truyền đồng thời cả --gross và --grab.");
  const start = new Date(`${dateText}T00:00:00+07:00`);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
  const walletSources = (await prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", status: "ACTIVE", deletedAt: null } }))
    .filter((row) => String(row.group || "").toUpperCase() === "WALLET");
  const walletCodes = walletSources.map((row) => row.code);
  const [posRows, manualRows, banks] = await Promise.all([
    prisma.revenueImportRow.findMany({ where: { branchCode: branch, saleDate: { gte: start, lt: end }, deletedAt: null } }),
    prisma.manualRevenueEntry.findMany({ where: { branchCode: branch, reportDate: { gte: start, lt: end }, deletedAt: null } }),
    prisma.bankStatementTransaction.findMany({
      where: {
        branchCode: branch,
        reconcileStatus: "MATCHED",
        deletedAt: null,
        allocations: { some: { revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: walletCodes } } },
        matches: { some: { targetType: "WALLET_SETTLEMENT", deletedAt: null } },
      },
      include: { allocations: true, matches: { where: { targetType: "WALLET_SETTLEMENT", deletedAt: null }, take: 1 } },
      orderBy: { transactionCode: "asc" },
    }),
  ]);
  const declared = posRows.length > 0
    ? posRows.reduce((totals, row) => {
        const text = normalized(`${row.paymentMethod} ${row.revenueSource} ${row.channel || ""}`);
        if (text.includes("grab")) totals.grab += Math.round(row.netAmount);
        else if (["momo", "vnpay", "wallet", "vi", "quet the", "card"].some((key) => text.includes(key))) totals.card += Math.round(row.netAmount);
        return totals;
      }, { card: 0, grab: 0 })
    : manualRows.reduce((totals, row) => ({ card: totals.card + Math.round(row.cardAmount), grab: totals.grab + Math.round(row.grabAmount) }), { card: 0, grab: 0 });
  const transactions = banks.map((bank) => ({ bank, net: Math.round(bank.creditAmount) }));
  const netTotal = transactions.reduce((sum, row) => sum + row.net, 0);
  const currentGrossTotal = declared.card + declared.grab;
  const grossTotal = grossOverride ?? currentGrossTotal;
  const declaredGrab = grabOverride ?? declared.grab;
  if (transactions.length === 0) throw new Error("Không tìm thấy phiếu QTVI đã match trong ngày.");
  if (grossTotal < netTotal) throw new Error(`Gross ${grossTotal} nhỏ hơn net ${netTotal}; không tự sửa.`);
  if (declaredGrab > grossTotal) throw new Error(`Grab ${declaredGrab} lớn hơn gross ${grossTotal}; không tự sửa.`);
  const feeTotal = grossTotal - netTotal;
  const grabTotal = Math.min(declaredGrab, feeTotal);
  const feeParts = allocate(feeTotal, transactions.map((row) => row.net));
  const grabParts = allocate(grabTotal, feeParts);
  const plan = transactions.map((row, index) => ({
    bank: row.bank,
    net: row.net,
    fee: feeParts[index],
    gross: row.net + feeParts[index],
    grab: grabParts[index],
    card: feeParts[index] - grabParts[index],
  }));
  console.log(`Nguồn gross/Grab: ${grossOverride === null ? "dữ liệu doanh thu hiện tại" : "giá trị đã xác nhận qua --gross/--grab"}.`);
  if (grossOverride !== null && (currentGrossTotal !== grossTotal || declared.grab !== declaredGrab)) {
    console.log(`Dữ liệu hiện tại: gross ${currentGrossTotal.toLocaleString("vi-VN")} · Grab ${declared.grab.toLocaleString("vi-VN")}.`);
  }
  console.table(plan.map((row) => ({ ma_giao_dich: row.bank.transactionCode, net: row.net, gross: row.gross, chi_phi_grab: row.grab, phi_ca_the: row.card, phieu: row.bank.matches[0]?.targetCode })));
  console.log(`TỔNG: gross ${grossTotal.toLocaleString("vi-VN")} · net ${netTotal.toLocaleString("vi-VN")} · Grab ${grabTotal.toLocaleString("vi-VN")} · phí cà thẻ ${(feeTotal - grabTotal).toLocaleString("vi-VN")}`);
  if (!apply) return console.log("DRY-RUN: chưa ghi database.");

  await prisma.$transaction(async (tx) => {
    const [cardCategory, grabCategory, expenseAccount] = await Promise.all([
      tx.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: "CHI_PHI_QUET_THE", status: "ACTIVE", deletedAt: null } }),
      tx.masterDataItem.findFirst({ where: { type: "REVENUE_EXPENSE_CATEGORY", code: "CHI_PHI_BAN_HANG_GRAB", status: "ACTIVE", deletedAt: null } }),
      tx.accountingAccount.findFirst({ where: { code: "6428", deletedAt: null } }),
    ]);
    if (!cardCategory || !grabCategory) throw new Error("Thiếu danh mục phí cà thẻ hoặc chi phí bán hàng Grab.");
    for (const row of plan) {
      const match = row.bank.matches[0];
      const transfer = await tx.moneyTransfer.findUnique({ where: { id: match.targetId } });
      if (!transfer || transfer.transferPurpose !== "WALLET_SETTLEMENT") throw new Error(`${row.bank.transactionCode}: không tìm thấy QTVI.`);
      await tx.moneyTransfer.update({ where: { id: transfer.id }, data: {
        feeAmount: row.fee,
        feeCategoryCode: row.card > 0 ? cardCategory.code : null,
        grabExpenseAmount: row.grab,
        grabExpenseCategoryCode: row.grab > 0 ? grabCategory.code : null,
        description: `Quyết toán Ví theo sao kê ${row.bank.transactionCode} (gross ${row.gross.toLocaleString("vi-VN")} đ; phí ${row.fee.toLocaleString("vi-VN")} đ)`,
      } });
      const positive = row.bank.allocations.filter((item) => item.creditAmount > 0);
      const allocationGross = allocate(row.gross, positive.map((item) => Math.round(item.creditAmount)));
      for (const [index, allocation] of positive.entries()) await tx.bankStatementAllocation.update({ where: { id: allocation.id }, data: { grossAmount: allocationGross[index] } });
      await tx.bankStatementTransaction.update({ where: { id: row.bank.id }, data: { autoProcessType: "WALLET_SETTLEMENT", autoProcessNote: `Đã sửa gross/phí theo nhóm ngày ${dateText}` } });

      const journal = await tx.journalEntry.findUnique({ where: { sourceType_sourceId: { sourceType: "MONEY_TRANSFER", sourceId: transfer.id } }, include: { lines: true } });
      if (journal) {
        const creditLine = journal.lines.find((line) => line.credit > 0);
        if (!creditLine || !expenseAccount) throw new Error(`${transfer.code}: không cập nhật được bút toán đã phát sinh.`);
        await tx.journalLine.update({ where: { id: creditLine.id }, data: { credit: row.gross } });
        await tx.journalLine.deleteMany({ where: { entryId: journal.id, accountId: expenseAccount.id } });
        if (row.grab > 0) await tx.journalLine.create({ data: { entryId: journal.id, accountId: expenseAccount.id, debit: row.grab, categoryCode: grabCategory.code, description: "Chi phí bán hàng Grab" } });
        if (row.card > 0) await tx.journalLine.create({ data: { entryId: journal.id, accountId: expenseAccount.id, debit: row.card, categoryCode: cardCategory.code, description: "Phí cà thẻ" } });
      }
    }
  }, { maxWait: 10_000, timeout: 120_000 });
  console.log(`Đã sửa ${plan.length} phiếu quyết toán Ví.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
