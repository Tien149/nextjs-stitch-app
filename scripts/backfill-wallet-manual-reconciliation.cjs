/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const branchCode = valueOf("--branch").trim().toUpperCase();
const fromText = valueOf("--from");
const toText = valueOf("--to");
const apply = args.includes("--apply");
const confirmBranch = valueOf("--confirm").trim().toUpperCase();
const maxCardFeeRate = Number(valueOf("--max-card-fee-rate") || "0.10");
const maxGrabFeeRate = Number(valueOf("--max-grab-fee-rate") || "0.35");
const selfTest = args.includes("--self-test");

function usageError(message) {
  throw new Error(`${message}\nDùng: node scripts/backfill-wallet-manual-reconciliation.cjs --branch NME --from 2026-07-31 --to 2026-08-08 [--max-card-fee-rate 0.10] [--max-grab-fee-rate 0.35] [--apply --confirm NME]`);
}
function utcDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) usageError(`Ngày không hợp lệ: ${text || "(trống)"}`);
  return new Date(`${text}T00:00:00.000Z`);
}
function dayBounds(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}
function normalize(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();
}
function group(value) {
  const text = normalize(value);
  if (["wallet", "vi", "vi pos", "vi dien tu", "pos", "cong pos"].includes(text)) return "WALLET";
  if (["bank", "ngan hang", "tai khoan ngan hang"].includes(text)) return "BANK";
  return text.toUpperCase();
}
function bucket(source) {
  return normalize(`${source.code} ${source.name}`).includes("grab") ? "GRAB" : "CARD_WALLET";
}
function matchesPos(row, source) {
  const sourceValues = [normalize(source.code), normalize(source.name)];
  const rowValues = [normalize(row.paymentMethod), normalize(row.revenueSource), normalize(row.channel)];
  if (rowValues.some((value) => value && sourceValues.includes(value))) return true;
  return ["momo", "grab", "vnpay", "shopee", "quet the"].some((word) =>
    sourceValues.some((value) => value.includes(word)) && rowValues.some((value) => value.includes(word)));
}
function formatCode(date, branch, sequence) {
  const ym = `${String(date.getUTCFullYear()).slice(-2)}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  const branch3 = branch.replace(/[^A-Z0-9]/g, "").padEnd(3, "0").slice(0, 3);
  return `QTVI-${ym}-${branch3}-${String(sequence).padStart(5, "0")}`;
}
function looksLikeTestData(bank) {
  const code = normalize(bank.transactionCode);
  const description = normalize(bank.description);
  return /^(uat|test|demo)( |$)/.test(code)
    || /\b(uat|test data|du lieu test|demo data|du lieu demo)\b/.test(description);
}
function feeCheck(selectedBucket, gross, net) {
  if (gross <= 0 || net <= 0 || gross < net) {
    return { ok: false, fee: Math.max(0, gross - net), rate: null, limit: selectedBucket === "GRAB" ? maxGrabFeeRate : maxCardFeeRate };
  }
  const fee = gross - net;
  const rate = fee / gross;
  const limit = selectedBucket === "GRAB" ? maxGrabFeeRate : maxCardFeeRate;
  return { ok: rate <= limit, fee, rate, limit };
}
function validateRate(name, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) usageError(`${name} phải nằm trong khoảng 0 đến 1`);
}
function runSelfTest() {
  const assert = require("node:assert/strict");
  assert.equal(looksLikeTestData({ transactionCode: "UAT-MOMO-01", description: "" }), true);
  assert.equal(looksLikeTestData({ transactionCode: "BANK-01", description: "UAT kiểm thử" }), true);
  assert.equal(looksLikeTestData({ transactionCode: "BANK-01", description: "Quyết toán Grab" }), false);
  assert.equal(feeCheck("CARD_WALLET", 1_000_000, 950_000).ok, true);
  assert.equal(feeCheck("CARD_WALLET", 1_000_000, 800_000).ok, false);
  assert.equal(feeCheck("GRAB", 1_000_000, 700_000).ok, true);
  assert.equal(feeCheck("GRAB", 1_000_000, 600_000).ok, false);
  console.log("SELF-TEST: 7/7 điều kiện an toàn đạt.");
}

async function declaredForDay(date, source, walletSources) {
  const { start, end } = dayBounds(date);
  const selectedBucket = bucket(source);
  const bucketSources = walletSources.filter((item) => bucket(item) === selectedBucket);
  const posRows = await prisma.revenueImportRow.findMany({
    where: { branchCode, saleDate: { gte: start, lt: end }, deletedAt: null },
    select: { paymentMethod: true, revenueSource: true, channel: true, netAmount: true },
  });
  if (posRows.length > 0) return { source: "POS", amount: posRows.filter((row) => bucketSources.some((item) => matchesPos(row, item))).reduce((sum, row) => sum + row.netAmount, 0) };
  const manualRows = await prisma.manualRevenueEntry.findMany({
    where: { branchCode, reportDate: { gte: start, lt: end }, deletedAt: null },
    select: { cardAmount: true, grabAmount: true },
  });
  const field = selectedBucket === "GRAB" ? "grabAmount" : "cardAmount";
  return { source: manualRows.length ? "MANUAL" : "NONE", amount: manualRows.reduce((sum, row) => sum + row[field], 0) };
}

async function alreadyAllocated(date, source, walletSources, excludedBankId) {
  const { start, end } = dayBounds(date);
  const codes = walletSources.filter((item) => bucket(item) === bucket(source)).map((item) => item.code);
  const [manualTransfers, allocations] = await Promise.all([
    prisma.moneyTransfer.findMany({
      where: { branchCode, importBatchId: null, transferPurpose: "WALLET_SETTLEMENT", fromMoneySourceCode: { in: codes }, sourceReportDate: { gte: start, lt: end }, status: { in: ["PENDING_REVIEW", "APPROVED"] }, deletedAt: null },
      select: { amount: true, feeAmount: true },
    }),
    prisma.bankStatementAllocation.findMany({
      where: { bankTransactionId: { not: excludedBankId }, revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: codes }, grossAmount: { not: null }, bankTransaction: { branchCode, reconcileStatus: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null } },
      select: { grossAmount: true },
    }),
  ]);
  return manualTransfers.reduce((sum, row) => sum + row.amount + row.feeAmount, 0)
    + allocations.reduce((sum, row) => sum + (row.grossAmount || 0), 0);
}

async function main() {
  validateRate("--max-card-fee-rate", maxCardFeeRate);
  validateRate("--max-grab-fee-rate", maxGrabFeeRate);
  if (selfTest) {
    runSelfTest();
    return;
  }
  if (!branchCode) usageError("Thiếu --branch");
  if (apply && confirmBranch !== branchCode) {
    usageError(`Chế độ --apply yêu cầu --confirm ${branchCode}`);
  }
  const from = utcDate(fromText);
  const toInclusive = utcDate(toText);
  const to = new Date(toInclusive); to.setUTCDate(to.getUTCDate() + 1);
  const sources = await prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", deletedAt: null }, select: { code: true, name: true, group: true, status: true } });
  const categories = await prisma.masterDataItem.findMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", deletedAt: null }, select: { code: true, name: true, status: true } });
  const walletSources = sources.filter((source) => group(source.group) === "WALLET");
  const sourceByCode = new Map(sources.map((source) => [source.code, source]));
  const categoryByCode = new Map(categories.map((category) => [category.code, category]));
  const banks = await prisma.bankStatementTransaction.findMany({
    where: { branchCode, reconcileStatus: "UNMATCHED", deletedAt: null, allocations: { some: { revenueDate: { gte: from, lt: to } } } },
    include: { allocations: { orderBy: { sourceRowNumber: "asc" } } },
    orderBy: [{ transactionDate: "asc" }, { transactionCode: "asc" }],
  });
  const plans = [];
  for (const bank of banks) {
    const rows = bank.allocations.filter((row) => row.revenueDate && row.revenueDate >= from && row.revenueDate < to);
    if (!rows.length || rows.some((row) => !row.revenueDate || !row.decreaseMoneySourceCode)) continue;
    if (looksLikeTestData(bank)) {
      plans.push({ bank, safe: false, reason: "Dữ liệu UAT/test/demo không được backfill", rows: [], grossAmount: 0, bankAmount: Math.round(bank.creditAmount || bank.debitAmount) });
      continue;
    }
    const keys = rows.map((row) => `${row.revenueDate.toISOString().slice(0, 10)}:${bucket(sourceByCode.get(row.decreaseMoneySourceCode) || { code: row.decreaseMoneySourceCode, name: "" })}`);
    if (new Set(keys).size !== keys.length) {
      plans.push({ bank, safe: false, reason: "Nhiều phân bổ cùng ngày/bucket", rows: [] });
      continue;
    }
    const resolvedRows = [];
    for (const row of rows) {
      const source = sourceByCode.get(row.decreaseMoneySourceCode);
      if (!source || group(source.group) !== "WALLET" || source.status !== "ACTIVE") {
        resolvedRows.push({ ...row, error: "Nguồn trừ không phải Ví đang hoạt động" }); continue;
      }
      const declared = await declaredForDay(row.revenueDate, source, walletSources);
      const allocated = await alreadyAllocated(row.revenueDate, source, walletSources, bank.id);
      const gross = Math.max(0, Math.round(declared.amount - allocated));
      const net = Math.round(row.creditAmount || 0);
      const selectedBucket = bucket(source);
      const fee = feeCheck(selectedBucket, gross, net);
      const error = declared.source !== "MANUAL"
        ? `Nguồn ${declared.source}, không thuộc backfill nhập tay`
        : gross < net || gross <= 0
          ? "Gross còn lại không đủ"
          : !fee.ok
            ? `Chênh gross/net ${(fee.rate * 100).toFixed(2)}% vượt ngưỡng ${(fee.limit * 100).toFixed(2)}% của ${selectedBucket}`
            : "";
      resolvedRows.push({ ...row, gross, net, bucket: selectedBucket, feeAmount: fee.fee, feeRate: fee.rate, declaredSource: declared.source, error });
    }
    const bankAmount = Math.round(bank.creditAmount || bank.debitAmount);
    const grossAmount = resolvedRows.reduce((sum, row) => sum + (row.gross || 0), 0);
    const increaseSource = sourceByCode.get(bank.increaseMoneySourceCode || "");
    const category = categoryByCode.get(bank.categoryCode || rows[0]?.categoryCode || "");
    const categoryText = normalize(`${category?.code || ""} ${category?.name || ""}`);
    const salesCategory = category?.status === "ACTIVE" && categoryText.includes("thu") && categoryText.includes("ban hang");
    const safe = resolvedRows.every((row) => !row.error) && grossAmount >= bankAmount && increaseSource?.status === "ACTIVE" && group(increaseSource?.group) === "BANK" && salesCategory;
    plans.push({ bank, rows: resolvedRows, bucketKeys: keys, grossAmount, bankAmount, safe, reason: safe ? "Đủ điều kiện" : resolvedRows.find((row) => row.error)?.error || (!salesCategory ? "Loại thu không phải Thu bán hàng đang hoạt động" : "Nguồn nhận không phải ngân hàng đang hoạt động") });
  }

  const plansByBucketKey = new Map();
  for (const plan of plans) {
    for (const key of plan.bucketKeys || []) plansByBucketKey.set(key, [...(plansByBucketKey.get(key) || []), plan]);
  }
  for (const competingPlans of plansByBucketKey.values()) {
    if (competingPlans.length <= 1) continue;
    for (const plan of competingPlans) {
      plan.safe = false;
      plan.reason = "Nhiều giao dịch cùng ngày/bucket; không thể phân bổ gross chắc chắn";
    }
  }

  console.log(`Ngưỡng an toàn: CARD_WALLET ${(maxCardFeeRate * 100).toFixed(2)}% · GRAB ${(maxGrabFeeRate * 100).toFixed(2)}%`);
  console.table(plans.map((plan) => ({
    ma_giao_dich: plan.bank.transactionCode,
    ngay_gd: plan.bank.transactionDate.toISOString().slice(0, 10),
    tien_ngan_hang: plan.bankAmount || 0,
    gross: plan.grossAmount || 0,
    bucket: plan.rows?.[0]?.bucket || "-",
    phi: Math.max(0, (plan.grossAmount || 0) - (plan.bankAmount || 0)),
    phi_pct: plan.grossAmount >= plan.bankAmount && plan.grossAmount > 0
      ? `${(((plan.grossAmount - plan.bankAmount) / plan.grossAmount) * 100).toFixed(2)}%`
      : "-",
    ket_qua: plan.safe ? (apply ? "APPLY" : "CO_THE_BACKFILL") : "GIU_UNMATCHED",
    ly_do: plan.reason,
  })));
  if (!apply) {
    console.log(`DRY-RUN: ${plans.filter((plan) => plan.safe).length} giao dịch có thể backfill; không ghi database.`);
    return;
  }
  for (const plan of plans.filter((item) => item.safe)) {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.reconciliationMatch.findFirst({ where: { bankTransactionId: plan.bank.id, deletedAt: null } });
      if (existing) throw new Error(`${plan.bank.transactionCode}: đã có reconciliation match`);
      for (const row of plan.rows) await tx.bankStatementAllocation.update({ where: { id: row.id }, data: { grossAmount: row.gross, autoProcessType: "WALLET_SETTLEMENT", autoProcessNote: "Fallback doanh thu nhập tay" } });
      const count = await tx.moneyTransfer.count();
      const sourceCode = plan.rows[0].decreaseMoneySourceCode;
      const code = formatCode(plan.bank.transactionDate, branchCode, count + 1);
      const transfer = await tx.moneyTransfer.create({ data: { importBatchId: plan.bank.importBatchId, code, transferDate: plan.bank.sourceDate || plan.bank.transactionDate, branchCode, fromMoneySourceCode: sourceCode, toMoneySourceCode: plan.bank.increaseMoneySourceCode, amount: plan.bankAmount, feeAmount: plan.grossAmount - plan.bankAmount, externalRef: plan.bank.transactionCode, description: `Backfill quyết toán ví theo doanh thu nhập tay ${plan.bank.transactionCode}`, transferPurpose: "WALLET_SETTLEMENT", sourceReportDate: plan.bank.revenueDate || plan.rows[0].revenueDate, status: "APPROVED", createdBy: "BACKFILL_WALLET_MANUAL", approvedBy: "BACKFILL_WALLET_MANUAL" } });
      await tx.reconciliationMatch.create({ data: { bankTransactionId: plan.bank.id, targetType: "WALLET_SETTLEMENT", targetId: transfer.id, targetCode: transfer.code, targetDate: plan.bank.sourceDate || plan.bank.transactionDate, targetAmount: plan.bankAmount, matchedAmount: plan.bankAmount, status: "MATCHED", note: "Backfill từ doanh thu nhập tay", matchedBy: "BACKFILL_WALLET_MANUAL" } });
      await tx.bankStatementTransaction.update({ where: { id: plan.bank.id }, data: { reconcileStatus: "MATCHED", autoProcessType: "WALLET_SETTLEMENT", autoProcessNote: `Đã backfill bằng doanh thu nhập tay và đối soát với ${transfer.code}` } });
    });
  }
  console.log(`Đã backfill ${plans.filter((plan) => plan.safe).length} giao dịch.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
