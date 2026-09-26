/**
 * Số dư ví trên Báo cáo nguồn tiền = doanh thu ĐÃ BÁN mà tiền CHƯA VỀ (khách chốt 26/09/2026).
 *
 * Dựng trên DB (cửa hàng giả ZTV, dọn sạch sau khi chạy) đúng bốn ca kỳ 08/2026 của khách:
 *   - doanh thu 31/7 (trước go-live, phí 0) về 3/8 chung phiếu với 1/8 → đầu kỳ phải trừ hết
 *     trong tháng 8; phí của phiếu gộp nằm hết ở ngày 1/8 (theo ô Gross), không chia cho 31/7
 *   - dòng sao kê Gross = 0 (VNPay NAM MÊ âm 22 triệu)
 *   - dòng sao kê Gross khai phồng (Momo ASA/KCF dư 355 triệu)
 *   - doanh thu 30–31/8 về chung ngày 3/9, Ngày nguồn tiền = ngày về → phải treo ở cuối kỳ 8
 *
 * Chạy: npm run test:wallet-balance
 */
import assert from "node:assert/strict";
import test from "node:test";
import { prismaRaw } from "../lib/prisma.ts";
import { getCashSourceReport } from "../lib/reports.ts";

const BRANCH = "ZTV";
const WALLET = "ZTV_MOMO";
const BANK = "ZTV_BANK";
const d = (day) => new Date(`${day}T00:00:00+07:00`);

async function cleanup() {
  const txns = await prismaRaw.bankStatementTransaction.findMany({ where: { branchCode: BRANCH }, select: { id: true, importBatchId: true } });
  await prismaRaw.reconciliationMatch.deleteMany({ where: { bankTransactionId: { in: txns.map((t) => t.id) } } });
  await prismaRaw.bankStatementAllocation.deleteMany({ where: { bankTransactionId: { in: txns.map((t) => t.id) } } });
  await prismaRaw.bankStatementTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prismaRaw.importBatch.deleteMany({ where: { id: { in: [...new Set(txns.map((t) => t.importBatchId))] } } });
  await prismaRaw.moneyTransfer.deleteMany({ where: { branchCode: BRANCH } });
  await prismaRaw.openingBalance.deleteMany({ where: { branchCode: BRANCH } });
  await prismaRaw.masterDataItem.deleteMany({ where: { type: "MONEY_SOURCE", code: { in: [WALLET, BANK] } } });
}

/** Một giao dịch sao kê tiền ví về + phiếu QTVI của nó, nối bằng cặp đối soát như lúc import. */
async function settlement(batchId, code, arrival, rows, fee) {
  const credit = rows.reduce((sum, row) => sum + row.credit, 0);
  const txn = await prismaRaw.bankStatementTransaction.create({
    data: {
      importBatchId: batchId, transactionDate: d(arrival), bankAccount: BANK, transactionCode: code, description: code,
      creditAmount: credit, branchCode: BRANCH, sourceDate: d(arrival), revenueDate: d(rows[0].revenueDay),
      categoryCode: "THU_BAN_HANG", operationType: "WALLET_SETTLEMENT",
      increaseMoneySourceCode: BANK, decreaseMoneySourceCode: WALLET, reconcileStatus: "MATCHED",
    },
  });
  for (const [index, row] of rows.entries()) {
    await prismaRaw.bankStatementAllocation.create({
      data: {
        bankTransactionId: txn.id, sheetName: "Sao ke", sourceRowNumber: index + 2, description: code,
        creditAmount: row.credit, grossAmount: row.gross, sourceDate: d(arrival), revenueDate: d(row.revenueDay),
        categoryCode: "THU_BAN_HANG", operationType: "WALLET_SETTLEMENT",
        increaseMoneySourceCode: BANK, decreaseMoneySourceCode: WALLET,
      },
    });
  }
  const transfer = await prismaRaw.moneyTransfer.create({
    data: {
      code: `QTVI-${code}`, transferDate: d(arrival), branchCode: BRANCH, fromMoneySourceCode: WALLET, toMoneySourceCode: BANK,
      amount: credit, feeAmount: fee, description: code, transferPurpose: "WALLET_SETTLEMENT",
      sourceReportDate: d(rows[0].revenueDay), status: "APPROVED", externalRef: code,
    },
  });
  await prismaRaw.reconciliationMatch.create({
    data: { bankTransactionId: txn.id, targetType: "WALLET_SETTLEMENT", targetId: transfer.id, targetCode: transfer.code, targetAmount: credit, matchedAmount: credit },
  });
}

test.before(async () => {
  await cleanup();
  await prismaRaw.masterDataItem.createMany({
    data: [
      { type: "MONEY_SOURCE", code: WALLET, name: "ZTV - Momo", group: "WALLET", branch: BRANCH, status: "ACTIVE" },
      { type: "MONEY_SOURCE", code: BANK, name: "ZTV - Ngân hàng", group: "BANK", branch: BRANCH, status: "ACTIVE" },
    ],
  });
  // Số dư đầu kỳ ví = doanh thu 31/7 chưa về, theo đúng số Momo trả (ngày trước go-live phí 0).
  await prismaRaw.openingBalance.create({
    data: { period: "2026-08", branchCode: BRANCH, balanceType: "WALLET_POS", moneySourceCode: WALLET, amount: 990_000, status: "CONFIRMED" },
  });
  const batch = await prismaRaw.importBatch.create({ data: { importType: "BANK_STATEMENT", templateCode: "TEST", fileName: "ztv.xlsx" } });
  // Doanh thu 31/7 + 1/8 về chung 3/8 (như NME-00087) — Ngày nguồn tiền = ngày về như NAM MÊ điền.
  // Chia phí theo tỉ lệ tiền về thì 31/7 gánh 13.424 đ phí, đầu kỳ không trừ hết.
  await settlement(batch.id, "ZTV-0308", "2026-08-03", [
    { revenueDay: "2026-07-31", credit: 990_000, gross: 990_000 },
    { revenueDay: "2026-08-01", credit: 1_960_000, gross: 2_000_000 },
  ], 40_000);
  // Ô Gross để 0 — trước đây cột Thu nhận 0, ví âm đúng bằng tiền về + phí.
  await settlement(batch.id, "ZTV-1008", "2026-08-10", [{ revenueDay: "2026-08-09", credit: 2_000_000, gross: 0 }], 40_000);
  // Ô Gross khai phồng gấp 10 lần tiền về.
  await settlement(batch.id, "ZTV-1208", "2026-08-12", [{ revenueDay: "2026-08-11", credit: 500_000, gross: 5_000_000 }], 10_000);
  // Doanh thu 30 + 31/8 về chung ngày 3/9 (nghỉ lễ 1–2/9).
  await settlement(batch.id, "ZTV-0309", "2026-09-03", [
    { revenueDay: "2026-08-30", credit: 1_000_000, gross: 1_020_000 },
    { revenueDay: "2026-08-31", credit: 1_500_000, gross: 1_530_000 },
  ], 50_000);
});

test.after(async () => {
  await cleanup();
  await prismaRaw.$disconnect();
});

const walletRow = (report) => report.sources.find((row) => row.code === WALLET);

test("tháng 8: ví còn đúng doanh thu 30–31/8 chưa về, đầu kỳ khai tay được trừ hết", async () => {
  const report = await getCashSourceReport(["2026-08"], BRANCH);
  const row = walletRow(report);
  assert.ok(row, "ví phải có dòng trên báo cáo");
  assert.equal(Math.round(row.opening), 990_000);
  // Thu = tiền về + phí của QTVI, theo ngày doanh thu trong tháng 8: 1/8, 9/8, 11/8, 30/8, 31/8.
  assert.equal(Math.round(row.in), 2_000_000 + 2_040_000 + 510_000 + 1_020_000 + 1_530_000);
  assert.equal(Math.round(row.out), 40_000 + 40_000 + 10_000);
  assert.equal(Math.round(row.transferOut), 2_950_000 + 2_000_000 + 500_000);
  assert.equal(Math.round(row.closing), 2_550_000);
});

test("tháng 9: đầu kỳ = cuối kỳ tháng 8, về hết ngày 3/9 thì cuối kỳ về 0", async () => {
  const report = await getCashSourceReport(["2026-09"], BRANCH);
  const row = walletRow(report);
  assert.equal(Math.round(row.opening), 2_550_000);
  assert.equal(Math.round(row.in), 0);
  assert.equal(Math.round(row.closing), 0);
});

test("dòng TỔNG cột Thu vẫn bằng Tổng thu theo danh mục", async () => {
  for (const period of ["2026-08", "2026-09"]) {
    const report = await getCashSourceReport([period], BRANCH);
    const sourceIn = report.sources.reduce((sum, row) => sum + row.in, 0);
    const sourceOut = report.sources.reduce((sum, row) => sum + row.out, 0);
    assert.equal(Math.round(report.totals.in - sourceIn), 0, `${period} lệch Thu`);
    assert.equal(Math.round(report.totals.out - sourceOut), 0, `${period} lệch Chi`);
  }
});
