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
const transactionCode = valueOf("--transaction").trim().toUpperCase();
const selfTest = args.includes("--self-test");
const BUSINESS_TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000;

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
function businessDateKey(date) {
  return new Date(date.getTime() + BUSINESS_TIMEZONE_OFFSET_MS).toISOString().slice(0, 10);
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
/**
 * Dòng doanh thu chỉ đích danh một ví: ghi đúng tên, đúng mã, hoặc ghi mã rút gọn mà mã nguồn
 * tiền nối dài thêm ("MOMO_EDC" so với "MOMO_EDC_FDS"). Chắc chắn hơn hẳn kiểu đoán theo từ khoá.
 */
function matchesPosDefinitely(row, source) {
  const sourceValues = [normalize(source.code), normalize(source.name)];
  const rowValues = [normalize(row.paymentMethod), normalize(row.revenueSource), normalize(row.channel)];
  return rowValues.some((value) => value
    && (sourceValues.includes(value) || sourceValues.some((candidate) => candidate.startsWith(`${value} `))));
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

  const momoAsa = { code: "MOMO_EDC_ASA", name: "ASA - Quẹt Thẻ Momo" };
  const momoKcf = { code: "MOMO_EDC_KCF", name: "KCF - Quẹt Thẻ Momo" };
  const posRow = (pttt) => ({ paymentMethod: pttt, revenueSource: pttt, channel: "TAI CHO" });
  // Ghi đúng tên ví thì chỉ thuộc về ví đó.
  assert.equal(matchesPosDefinitely(posRow("ASA - Quẹt Thẻ Momo"), momoAsa), true);
  assert.equal(matchesPosDefinitely(posRow("ASA - Quẹt Thẻ Momo"), momoKcf), false);
  // Mã rút gọn khớp được mã dài hơn.
  assert.equal(matchesPosDefinitely(posRow("MOMO_EDC"), { code: "MOMO_EDC_FDS", name: "FDS - Quẹt Thẻ Momo" }), true);
  // Nhưng không được khớp sang ví của cửa hàng khác chỉ vì cùng hãng.
  assert.equal(matchesPosDefinitely(posRow("MOMO_EDC"), { code: "NME_MOMO_FDS", name: "Nam Mê_Momo" }), false);
  // Kiểu đoán theo từ khoá vẫn khớp cả hai - đó là lý do phải có mức đích danh ở trên.
  assert.equal(matchesPos(posRow("MOMO_EDC"), momoKcf), true);

  // --- Quyết toán theo từng ngày ---
  const day = (text) => new Date(`${text}T00:00:00.000Z`);
  const ok = (date, gross, net) => ({ revenueDate: day(date), decreaseMoneySourceCode: "MOMO_EDC_FDS", bucket: "CARD_WALLET", gross, net, error: "" });
  const bad = (date, why) => ({ revenueDate: day(date), decreaseMoneySourceCode: "MOMO_EDC_FDS", error: why });

  // Đúng ca của khách: ví trả gộp 3 ngày, thiếu file POS ngày 31/07.
  const mixed = planSettlement([
    bad("2026-07-31", "Chưa có doanh thu cho ngày này"),
    ok("2026-08-01", 47_443_998, 46_661_172),
    ok("2026-08-02", 43_710_681, 42_989_455),
  ]);
  assert.equal(mixed.settled.length, 2, "hai ngày đủ căn cứ phải được quyết toán");
  assert.equal(mixed.partial, true, "vẫn còn ngày chờ nên là quyết toán một phần");
  assert.equal(mixed.settledNet, 89_650_627, "chỉ nhận số tiền của hai ngày đã quyết toán");
  assert.equal(mixed.feeAmount, 1_504_052, "phí đúng bằng tổng phí của riêng hai ngày đó");
  assert.equal(mixed.pending[0].revenueDate.toISOString().slice(0, 10), "2026-07-31");

  // Không ngày nào đủ căn cứ thì không được sinh phiếu nào.
  const none = planSettlement([bad("2026-07-31", "Chưa có doanh thu cho ngày này")]);
  assert.equal(none.settled.length, 0);
  assert.equal(none.feeAmount, 0, "không có ngày nào thì phí phải bằng 0, không được đoán");

  // Dòng đã quyết toán lần trước không được tính lại, nếu không phí vào sổ hai lần.
  const rerun = planSettlement([
    { ...ok("2026-08-01", 47_443_998, 46_661_172), alreadySettled: true },
    ok("2026-08-02", 43_710_681, 42_989_455),
  ]);
  assert.equal(rerun.settled.length, 1, "chỉ còn đúng ngày chưa quyết toán");
  assert.equal(rerun.feeAmount, 721_226, "phí chỉ tính cho ngày mới, không cộng lại ngày cũ");
  assert.equal(rerun.alreadySettled.length, 1);

  // Đủ cả thì không còn phần chờ, giao dịch mới được đóng lại.
  const full = planSettlement([ok("2026-08-01", 47_443_998, 46_661_172)]);
  assert.equal(full.partial, false);

  // Một phiếu điều tiền chỉ mang được một ví; trộn hai ví thì phí gán sai chỗ.
  assert.equal(planSettlement([
    ok("2026-08-01", 2_153_000, 1_624_706),
    { ...ok("2026-08-01", 47_443_998, 46_661_172), decreaseMoneySourceCode: "FDSGRABFOOD" },
  ]).mixedWallets, true);
  assert.equal(mixed.mixedWallets, false, "cùng một ví thì không phải trộn");

  // --- Quyết toán cả nhóm ví khi không tách riêng được ---
  const alloc = (id, credit, gross = null) => ({ id, creditAmount: credit, grossAmount: gross });

  // Đúng ca NAM MÊ 06/08: khai gộp 26.157.075, hai ví Momo + VNPAY, ngân hàng trả 25.723.518.
  const nme = planBucketSettlement([alloc("momo", 24_437_324), alloc("vnpay", 1_286_194)], 26_157_075, "CARD_WALLET", feeCheck);
  assert.equal(nme.ok, true, "khai đủ phủ tiền về thì phải quyết toán được cả nhóm");
  assert.equal(nme.feeAmount, 433_557, "tổng phí đúng bằng khai trừ về");
  assert.equal(nme.rows.reduce((sum, row) => sum + row.gross, 0), 26_157_075, "tổng gross chia ra phải khớp tuyệt đối số khai");
  assert.equal(nme.rows.reduce((sum, row) => sum + row.feeAmount, 0), 433_557, "tổng phí sau khi chia không được lệch");
  assert.ok(nme.rows.every((row) => row.gross >= row.net), "không ví nào được nhận gross nhỏ hơn tiền đã về");

  // Ngân hàng trả làm nhiều lần trong ngày cũng gom chung được.
  const many = planBucketSettlement(
    [alloc("a", 2_400_000), alloc("b", 12_720_240), alloc("c", 2_106_000), alloc("d", 745_438), alloc("e", 1_140_000), alloc("f", 5_573_994)],
    25_000_000, "CARD_WALLET", feeCheck,
  );
  assert.equal(many.ok, true, "6 giao dịch cùng ngày cùng nhóm vẫn quyết toán được");
  assert.equal(many.rows.length, 6);
  assert.equal(many.rows.reduce((sum, row) => sum + row.gross, 0), 25_000_000, "chia hết, không rơi rớt đồng nào");

  // Khai ít hơn tiền về thì tuyệt đối không quyết toán - đó là số liệu sai, không phải phí.
  const short = planBucketSettlement([alloc("momo", 31_931_344), alloc("vnpay", 2_415_000)], 24_720_081, "CARD_WALLET", feeCheck);
  assert.equal(short.ok, false, "khai 24,7tr mà về 34,3tr thì phải từ chối");
  assert.match(short.reason, /nhỏ hơn tiền đã về/);

  // Ngưỡng phí vẫn chặn như cũ, gom nhóm không được nới lỏng an toàn.
  assert.equal(planBucketSettlement([alloc("x", 1_000_000)], 2_000_000, "CARD_WALLET", feeCheck).ok, false, "phí 50% phải bị chặn");
  assert.equal(planBucketSettlement([alloc("x", 700_000)], 1_000_000, "GRAB", feeCheck).ok, true, "Grab 30% vẫn trong ngưỡng");

  // Chưa có doanh thu thì không được đoán.
  assert.equal(planBucketSettlement([alloc("x", 1_000_000)], 0, "CARD_WALLET", feeCheck).ok, false);
  // Dòng đã có gross rồi thì không nằm trong nhóm cần quyết toán nữa.
  assert.equal(planBucketSettlement([alloc("x", 1_000_000, 1_010_000)], 5_000_000, "CARD_WALLET", feeCheck).ok, false);

  console.log("SELF-TEST: 34/34 điều kiện an toàn đạt.");
}

/**
 * Chọn những ngày doanh thu đủ căn cứ để quyết toán, và tính phí trên đúng những ngày đó.
 *
 * Một lần ví trả tiền về thường gộp nhiều ngày doanh thu. Trước đây chỉ cần thiếu file POS của
 * một ngày là cả cụm bị giữ lại, kéo theo cả những ngày đã có đủ số liệu — ví Momo của NAM MÊ
 * ngày 03/08 gộp 31/07 + 01/08 + 02/08, thiếu mỗi 31/07 mà 1.504.052đ phí của hai ngày kia cũng
 * không vào được chi phí.
 *
 * Giờ mỗi ngày tự đứng độc lập: ngày nào chứng minh được Gross ≥ tiền về và phí trong ngưỡng thì
 * quyết toán ngày đó, ngày còn thiếu để nguyên chờ file. Phí chỉ tính trên phần đã quyết toán nên
 * không có chỗ nào phải đoán.
 */
function planSettlement(resolvedRows) {
  const alreadySettled = resolvedRows.filter((row) => row.alreadySettled);
  const settled = resolvedRows.filter((row) => !row.alreadySettled && !row.error);
  const pending = resolvedRows.filter((row) => !row.alreadySettled && row.error);
  const settledNet = settled.reduce((sum, row) => sum + row.net, 0);
  const settledGross = settled.reduce((sum, row) => sum + row.gross, 0);
  return {
    alreadySettled,
    settled,
    pending,
    settledNet,
    settledGross,
    feeAmount: settledGross - settledNet,
    // Một phiếu điều tiền chỉ mang được một ví; trộn hai ví thì phí gán sai chỗ.
    mixedWallets: new Set(settled.map((row) => row.decreaseMoneySourceCode)).size > 1,
    partial: pending.length > 0,
  };
}

/**
 * Quyết toán cả một nhóm ví trong ngày như một khối, khi không tách riêng được từng ví.
 *
 * Khách khai doanh thu quẹt thẻ bằng MỘT con số gộp, mà một ngày có thể có nhiều ví (Momo,
 * VNPAY...) và ngân hàng có thể trả làm nhiều lần. Đòi quy được riêng từng ví thì không ngày nào
 * quyết toán nổi — ASA đang treo cả 8 giao dịch vì lý do này.
 *
 * Nhưng con số quan trọng nhất lại luôn chính xác: TỔNG phí của cả nhóm = tổng khai − tổng về.
 * Chia phí đó cho từng ví theo tỷ trọng tiền về không làm sai P&L một đồng, vì mọi ví trong cùng
 * nhóm đều đổ về cùng một khoản mục chi phí. Grab có ô khai riêng nên không bao giờ lẫn vào đây.
 *
 * Vẫn giữ nguyên hai chốt chặn: tổng khai phải đủ phủ tổng về, và tỷ lệ phí phải trong ngưỡng.
 */
function planBucketSettlement(rows, available, selectedBucket, checkFee) {
  const pending = rows.filter((row) => row.grossAmount == null);
  if (!pending.length) return { ok: false, reason: "Không còn dòng nào cần quyết toán", rows: [] };
  const received = pending.reduce((sum, row) => sum + Math.round(row.creditAmount || 0), 0);
  if (available <= 0) return { ok: false, reason: "Chưa có doanh thu cho nhóm ví này", rows: [] };
  if (available < received) {
    return {
      ok: false,
      rows: [],
      reason: `Doanh thu khai cho nhóm ví (${available.toLocaleString("vi-VN")}) nhỏ hơn tiền đã về (${received.toLocaleString("vi-VN")})`,
    };
  }
  const fee = checkFee(selectedBucket, available, received);
  if (!fee.ok) {
    return { ok: false, rows: [], reason: `Chênh gross/net cả nhóm ${(fee.rate * 100).toFixed(2)}% vượt ngưỡng ${(fee.limit * 100).toFixed(2)}%` };
  }
  // Chia theo tỷ trọng tiền về; dòng cuối nhận phần dư để tổng luôn khớp tuyệt đối, không lệch
  // một đồng do làm tròn.
  let remaining = available;
  const assigned = pending.map((row, index) => {
    const net = Math.round(row.creditAmount || 0);
    const gross = index === pending.length - 1 ? remaining : Math.round((available * net) / received);
    remaining -= gross;
    return { ...row, gross, net, bucket: selectedBucket, feeAmount: Math.max(0, gross - net), error: "" };
  });
  return { ok: true, reason: "Quyết toán cả nhóm ví", rows: assigned, available, received, feeAmount: available - received };
}

async function declaredForDay(date, source, walletSources) {
  const { start, end } = dayBounds(date);
  const queryStart = new Date(start.getTime() - BUSINESS_TIMEZONE_OFFSET_MS);
  const dateKey = businessDateKey(date);
  const selectedBucket = bucket(source);
  const bucketSources = walletSources.filter((item) => bucket(item) === selectedBucket);
  const posRows = await prisma.revenueImportRow.findMany({
    where: { branchCode, saleDate: { gte: queryStart, lt: end }, deletedAt: null },
    select: { saleDate: true, paymentMethod: true, revenueSource: true, channel: true, netAmount: true },
  });
  const businessDayPosRows = posRows.filter((row) => businessDateKey(row.saleDate) === dateKey);
  if (businessDayPosRows.length > 0) {
    // Có doanh thu POS thì quy về đúng từng ví: mỗi phương thức thanh toán là một ví riêng.
    // Dòng nào bị hai ví cùng nhận thì báo là không phân định được, không chia đại.
    const rivals = walletSources.filter((item) => item.code !== source.code);
    let amount = 0;
    let contested = false;
    for (const row of businessDayPosRows) {
      const mineDefinite = matchesPosDefinitely(row, source);
      const rivalDefinite = rivals.some((item) => matchesPosDefinitely(row, item));
      const mine = mineDefinite || rivalDefinite ? mineDefinite : matchesPos(row, source);
      const rival = mineDefinite || rivalDefinite ? rivalDefinite : rivals.some((item) => matchesPos(row, item));
      if (!mine) continue;
      if (rival) contested = true;
      amount += row.netAmount;
    }
    return { source: "POS", amount, contested, perWallet: true };
  }
  const manualRows = await prisma.manualRevenueEntry.findMany({
    where: { branchCode, reportDate: { gte: queryStart, lt: end }, deletedAt: null },
    select: { reportDate: true, cardAmount: true, grabAmount: true },
  });
  const businessDayManualRows = manualRows.filter((row) => businessDateKey(row.reportDate) === dateKey);
  const field = selectedBucket === "GRAB" ? "grabAmount" : "cardAmount";
  // Số thu ngân khai chỉ có tổng theo nhóm, nên nhiều ví cùng nhóm là không tách được.
  return {
    source: businessDayManualRows.length ? "MANUAL" : "NONE",
    amount: businessDayManualRows.reduce((sum, row) => sum + row[field], 0),
    contested: bucketSources.length > 1,
    perWallet: false,
  };
}

/**
 * Doanh thu khai cho CẢ NHÓM ví trong ngày, không tách theo từng ví.
 *
 * Dùng khi không quy riêng được từng ví. POS thì cộng mọi dòng thuộc nhóm (mỗi dòng đúng một
 * lần); không có POS thì lấy đúng ô thu ngân khai của nhóm đó.
 */
async function declaredForBucket(date, selectedBucket, walletSources) {
  const { start, end } = dayBounds(date);
  const queryStart = new Date(start.getTime() - BUSINESS_TIMEZONE_OFFSET_MS);
  const dateKey = businessDateKey(date);
  const bucketSources = walletSources.filter((item) => bucket(item) === selectedBucket);
  const posRows = await prisma.revenueImportRow.findMany({
    where: { branchCode, saleDate: { gte: queryStart, lt: end }, deletedAt: null },
    select: { saleDate: true, paymentMethod: true, revenueSource: true, channel: true, netAmount: true },
  });
  const dayPosRows = posRows.filter((row) => businessDateKey(row.saleDate) === dateKey);
  if (dayPosRows.length > 0) {
    // Mỗi dòng POS chỉ được cộng một lần dù nhiều ví cùng nhận ra nó.
    const amount = dayPosRows
      .filter((row) => bucketSources.some((item) => matchesPos(row, item)))
      .reduce((sum, row) => sum + row.netAmount, 0);
    return { source: "POS", amount };
  }
  const manualRows = await prisma.manualRevenueEntry.findMany({
    where: { branchCode, reportDate: { gte: queryStart, lt: end }, deletedAt: null },
    select: { reportDate: true, cardAmount: true, grabAmount: true },
  });
  const dayManualRows = manualRows.filter((row) => businessDateKey(row.reportDate) === dateKey);
  const field = selectedBucket === "GRAB" ? "grabAmount" : "cardAmount";
  return {
    source: dayManualRows.length ? "MANUAL" : "NONE",
    amount: dayManualRows.reduce((sum, row) => sum + row[field], 0),
  };
}

/** Phần doanh thu của nhóm ví đã được ghi ở các lần quyết toán trước, để không dùng lại hai lần. */
async function alreadyAllocatedForBucket(date, selectedBucket, walletSources, excludedBankIds) {
  const { start, end } = dayBounds(date);
  const queryStart = new Date(start.getTime() - BUSINESS_TIMEZONE_OFFSET_MS);
  const dateKey = businessDateKey(date);
  const codes = walletSources.filter((item) => bucket(item) === selectedBucket).map((item) => item.code);
  const [manualTransfers, allocations] = await Promise.all([
    prisma.moneyTransfer.findMany({
      where: { branchCode, importBatchId: null, transferPurpose: "WALLET_SETTLEMENT", fromMoneySourceCode: { in: codes }, sourceReportDate: { gte: queryStart, lt: end }, status: { in: ["PENDING_REVIEW", "APPROVED"] }, deletedAt: null },
      select: { amount: true, feeAmount: true, sourceReportDate: true },
    }),
    prisma.bankStatementAllocation.findMany({
      where: { bankTransactionId: { notIn: excludedBankIds }, revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: codes }, grossAmount: { not: null }, bankTransaction: { branchCode, deletedAt: null } },
      select: { grossAmount: true, revenueDate: true },
    }),
  ]);
  return manualTransfers.filter((row) => row.sourceReportDate && businessDateKey(row.sourceReportDate) === dateKey)
      .reduce((sum, row) => sum + row.amount + row.feeAmount, 0)
    + allocations.filter((row) => row.revenueDate && businessDateKey(row.revenueDate) === dateKey)
      .reduce((sum, row) => sum + (row.grossAmount || 0), 0);
}

async function alreadyAllocated(date, source, walletSources, excludedBankId, perWallet) {
  const { start, end } = dayBounds(date);
  const queryStart = new Date(start.getTime() - BUSINESS_TIMEZONE_OFFSET_MS);
  const dateKey = businessDateKey(date);
  // Tách được theo ví thì phần đã ghi cũng chỉ tính của đúng ví đó; ngược lại tính cả nhóm.
  const codes = perWallet
    ? [source.code]
    : walletSources.filter((item) => bucket(item) === bucket(source)).map((item) => item.code);
  const [manualTransfers, allocations] = await Promise.all([
    prisma.moneyTransfer.findMany({
      where: { branchCode, importBatchId: null, transferPurpose: "WALLET_SETTLEMENT", fromMoneySourceCode: { in: codes }, sourceReportDate: { gte: queryStart, lt: end }, status: { in: ["PENDING_REVIEW", "APPROVED"] }, deletedAt: null },
      select: { amount: true, feeAmount: true, sourceReportDate: true },
    }),
    prisma.bankStatementAllocation.findMany({
      where: { bankTransactionId: { not: excludedBankId }, revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: codes }, grossAmount: { not: null }, bankTransaction: { branchCode, reconcileStatus: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null } },
      select: { grossAmount: true, revenueDate: true },
    }),
  ]);
  return manualTransfers.filter((row) => row.sourceReportDate && businessDateKey(row.sourceReportDate) === dateKey)
      .reduce((sum, row) => sum + row.amount + row.feeAmount, 0)
    + allocations.filter((row) => row.revenueDate && businessDateKey(row.revenueDate) === dateKey)
      .reduce((sum, row) => sum + (row.grossAmount || 0), 0);
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
  const sources = await prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", deletedAt: null }, select: { code: true, name: true, group: true, status: true, branch: true } });
  const categories = await prisma.masterDataItem.findMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", deletedAt: null }, select: { code: true, name: true, status: true } });
  // Chỉ ví của đúng cửa hàng đang xử lý mới được coi là tranh chấp. Nếu lấy cả cửa hàng khác
  // thì "MOMO_EDC_ASA" sẽ tranh với "MOMO_EDC_FDS" và không ví nào tách được doanh thu.
  const walletSources = sources.filter((source) => group(source.group) === "WALLET"
    && (!source.branch || source.branch.toUpperCase() === "ALL" || source.branch.toUpperCase() === branchCode));
  const sourceByCode = new Map(sources.map((source) => [source.code, source]));
  const categoryByCode = new Map(categories.map((category) => [category.code, category]));
  const banks = await prisma.bankStatementTransaction.findMany({
    where: { branchCode, ...(transactionCode ? { transactionCode } : {}), reconcileStatus: "UNMATCHED", deletedAt: null, allocations: { some: { revenueDate: { gte: from, lt: to } } } },
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
    const keys = rows.map((row) => `${businessDateKey(row.revenueDate)}:${row.decreaseMoneySourceCode}`);
    if (new Set(keys).size !== keys.length) {
      plans.push({ bank, safe: false, reason: "Nhiều phân bổ cùng ngày/ví", rows: [] });
      continue;
    }
    const resolvedRows = [];
    for (const row of rows) {
      // Dòng đã có gross là đã quyết toán ở lần chạy trước. Không tính lại, nếu không sẽ sinh
      // phiếu điều tiền thứ hai cho cùng một khoản và ghi phí hai lần vào chi phí.
      if (row.grossAmount != null) {
        resolvedRows.push({ ...row, alreadySettled: true, gross: row.grossAmount, net: Math.round(row.creditAmount || 0), error: "" });
        continue;
      }
      const source = sourceByCode.get(row.decreaseMoneySourceCode);
      if (!source || group(source.group) !== "WALLET" || source.status !== "ACTIVE") {
        resolvedRows.push({ ...row, error: "Nguồn trừ không phải Ví đang hoạt động" }); continue;
      }
      const declared = await declaredForDay(row.revenueDate, source, walletSources);
      const allocated = await alreadyAllocated(row.revenueDate, source, walletSources, bank.id, declared.perWallet);
      const gross = Math.max(0, Math.round(declared.amount - allocated));
      const net = Math.round(row.creditAmount || 0);
      const selectedBucket = bucket(source);
      const fee = feeCheck(selectedBucket, gross, net);
      const error = declared.source === "NONE"
        ? "Chưa có doanh thu cho ngày này"
        : declared.contested
          ? "Doanh thu không tách riêng được cho ví này"
          : gross < net || gross <= 0
            ? "Gross còn lại không đủ"
            : !fee.ok
              ? `Chênh gross/net ${(fee.rate * 100).toFixed(2)}% vượt ngưỡng ${(fee.limit * 100).toFixed(2)}% của ${selectedBucket}`
              : "";
      // Không quy riêng được cho từng ví thì chưa bỏ cuộc: bước 2 sẽ thử quyết toán cả nhóm.
      const retryable = Boolean(error) && declared.source !== "NONE";
      resolvedRows.push({ ...row, gross, net, bucket: selectedBucket, feeAmount: fee.fee, feeRate: fee.rate, declaredSource: declared.source, error, retryable });
    }
    const bankAmount = Math.round(bank.creditAmount || bank.debitAmount);
    const increaseSource = sourceByCode.get(bank.increaseMoneySourceCode || "");
    const category = categoryByCode.get(bank.categoryCode || rows[0]?.categoryCode || "");
    const categoryText = normalize(`${category?.code || ""} ${category?.name || ""}`);
    const salesCategory = category?.status === "ACTIVE" && categoryText.includes("thu") && categoryText.includes("ban hang");
    const bankSourceOk = increaseSource?.status === "ACTIVE" && group(increaseSource?.group) === "BANK";
    const settlement = planSettlement(resolvedRows);
    const safe = settlement.settled.length > 0 && !settlement.mixedWallets && bankSourceOk && salesCategory;
    // Báo đúng điều kiện nào hỏng. Trước đây mọi lý do còn lại đều bị gán nhầm thành "nguồn nhận
    // không phải ngân hàng", làm người đọc đi sửa danh mục trong khi thật ra chỉ thiếu file POS.
    const reason = safe
      ? (settlement.partial
        ? `Quyết toán ${settlement.settled.length} ngày đủ căn cứ; còn ${settlement.pending.length} ngày chờ: ${settlement.pending.map((row) => `${businessDateKey(row.revenueDate)} (${row.error})`).join("; ")}`
        : "Đủ điều kiện")
      : settlement.mixedWallets
        ? "Nhiều ví khác nhau trong cùng giao dịch; một phiếu điều tiền không mang được hai ví"
        : settlement.pending[0]?.error
          || (!salesCategory
            ? "Loại thu không phải Thu bán hàng đang hoạt động"
            : !bankSourceOk
              ? "Nguồn nhận không phải ngân hàng đang hoạt động"
              : "Không còn dòng nào cần quyết toán");
    plans.push({ bank, rows: resolvedRows, bucketKeys: keys, settlement, grossAmount: settlement.settledGross, bankAmount, safe, reason, bankSourceOk, salesCategory });
  }

  // ===== Bước 2: quyết toán cả nhóm ví cho những dòng không quy riêng được =====
  //
  // Trước đây hễ hai giao dịch cùng ngày/cùng ví là giết cả hai. Cách đó an toàn nhưng làm ASA
  // treo trọn 8 giao dịch: ngân hàng trả làm 6 lần trong một ngày, và thu ngân chỉ khai một số
  // quẹt thẻ gộp. Giờ gom lại tính chung: tổng phí của cả nhóm là con số chính xác, chia cho
  // từng dòng theo tỷ trọng tiền về, tất cả đều vào cùng một khoản mục chi phí.
  const bucketGroups = new Map();
  for (const plan of plans) {
    if (!plan.rows) continue;
    for (const row of plan.rows) {
      if (row.alreadySettled || !row.retryable || !row.bucket || !row.revenueDate) continue;
      const key = `${businessDateKey(row.revenueDate)}|${row.bucket}`;
      const current = bucketGroups.get(key) || { date: row.revenueDate, bucket: row.bucket, entries: [] };
      current.entries.push({ plan, row });
      bucketGroups.set(key, current);
    }
  }

  for (const groupInfo of bucketGroups.values()) {
    const bankIds = [...new Set(groupInfo.entries.map((entry) => entry.plan.bank.id))];
    const declared = await declaredForBucket(groupInfo.date, groupInfo.bucket, walletSources);
    const allocated = await alreadyAllocatedForBucket(groupInfo.date, groupInfo.bucket, walletSources, bankIds);
    const available = Math.max(0, Math.round(declared.amount - allocated));
    const result = planBucketSettlement(
      groupInfo.entries.map((entry) => entry.row),
      available,
      groupInfo.bucket,
      feeCheck,
    );
    if (!result.ok) {
      for (const entry of groupInfo.entries) entry.row.error = result.reason;
      continue;
    }
    // Ghi kết quả ngược lại vào từng plan rồi tính lại độ an toàn của giao dịch đó.
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    for (const entry of groupInfo.entries) {
      const settled = byId.get(entry.row.id);
      if (!settled) continue;
      Object.assign(entry.row, settled, { bucketSettled: true });
    }
    for (const plan of new Set(groupInfo.entries.map((entry) => entry.plan))) {
      plan.settlement = planSettlement(plan.rows);
      plan.grossAmount = plan.settlement.settledGross;
      plan.safe = plan.settlement.settled.length > 0 && !plan.settlement.mixedWallets && plan.bankSourceOk && plan.salesCategory;
      if (plan.safe) {
        plan.reason = plan.settlement.partial
          ? `Quyết toán cả nhóm ví ${groupInfo.bucket}; còn ${plan.settlement.pending.length} ngày chờ`
          : `Quyết toán cả nhóm ví ${groupInfo.bucket} ngày ${businessDateKey(groupInfo.date)}`;
      }
    }
  }

  console.log(`Ngưỡng an toàn: CARD_WALLET ${(maxCardFeeRate * 100).toFixed(2)}% · GRAB ${(maxGrabFeeRate * 100).toFixed(2)}%`);
  console.table(plans.map((plan) => {
    const s = plan.settlement;
    return {
      ma_giao_dich: plan.bank.transactionCode,
      ngay_gd: plan.bank.transactionDate.toISOString().slice(0, 10),
      tien_ngan_hang: plan.bankAmount || 0,
      ngay_quyet_toan: s ? `${s.settled.length}/${s.settled.length + s.pending.length}` : "-",
      tien_quyet_toan: s?.settledNet || 0,
      gross: s?.settledGross || 0,
      bucket: s?.settled[0]?.bucket || plan.rows?.[0]?.bucket || "-",
      phi: s?.feeAmount || 0,
      phi_pct: s?.settledGross > 0 ? `${((s.feeAmount / s.settledGross) * 100).toFixed(2)}%` : "-",
      ket_qua: plan.safe
        ? (apply ? (s.partial ? "APPLY_MOT_PHAN" : "APPLY") : (s.partial ? "BACKFILL_MOT_PHAN" : "CO_THE_BACKFILL"))
        : "GIU_UNMATCHED",
      ly_do: plan.reason,
    };
  }));
  if (!apply) {
    console.log(`DRY-RUN: ${plans.filter((plan) => plan.safe).length} giao dịch có thể backfill; không ghi database.`);
    return;
  }
  for (const plan of plans.filter((item) => item.safe)) {
    const { settled, settledNet, feeAmount, partial } = plan.settlement;
    await prisma.$transaction(async (tx) => {
      // Đọc lại ngay trong transaction: nếu dòng đã được ai đó quyết toán xong ở giữa chừng thì
      // dừng, tuyệt đối không ghi phí lần hai.
      const fresh = await tx.bankStatementAllocation.findMany({ where: { id: { in: settled.map((row) => row.id) } }, select: { id: true, grossAmount: true } });
      if (fresh.some((row) => row.grossAmount != null)) {
        throw new Error(`${plan.bank.transactionCode}: có dòng đã được quyết toán bởi tiến trình khác`);
      }
      const settledDays = settled.map((row) => businessDateKey(row.revenueDate)).join(", ");
      for (const row of settled) {
        await tx.bankStatementAllocation.update({ where: { id: row.id }, data: { grossAmount: row.gross, autoProcessType: "WALLET_SETTLEMENT", autoProcessNote: "Fallback doanh thu nhập tay" } });
      }
      const count = await tx.moneyTransfer.count();
      const sourceCode = settled[0].decreaseMoneySourceCode;
      const selectedBucket = settled[0].bucket;
      const code = formatCode(plan.bank.transactionDate, branchCode, count + 1);
      const transfer = await tx.moneyTransfer.create({ data: { importBatchId: plan.bank.importBatchId, code, transferDate: plan.bank.sourceDate || plan.bank.transactionDate, branchCode, fromMoneySourceCode: sourceCode, toMoneySourceCode: plan.bank.increaseMoneySourceCode, amount: settledNet, feeAmount, feeCategoryCode: selectedBucket === "CARD_WALLET" && feeAmount > 0 ? "CHI_PHI_QUET_THE" : null, grabExpenseAmount: selectedBucket === "GRAB" ? feeAmount : 0, grabExpenseCategoryCode: selectedBucket === "GRAB" && feeAmount > 0 ? "CHI_PHI_BAN_HANG_GRAB" : null, externalRef: plan.bank.transactionCode, description: `Backfill quyết toán ví ${sourceCode} cho ngày doanh thu ${settledDays} (${plan.bank.transactionCode})`, transferPurpose: "WALLET_SETTLEMENT", sourceReportDate: settled[0].revenueDate, status: "APPROVED", createdBy: "BACKFILL_WALLET_MANUAL", approvedBy: "BACKFILL_WALLET_MANUAL" } });
      await tx.reconciliationMatch.create({ data: { bankTransactionId: plan.bank.id, targetType: "WALLET_SETTLEMENT", targetId: transfer.id, targetCode: transfer.code, targetDate: plan.bank.sourceDate || plan.bank.transactionDate, targetAmount: settledNet, matchedAmount: settledNet, status: "MATCHED", note: `Backfill từ doanh thu ngày ${settledDays}`, matchedBy: "BACKFILL_WALLET_MANUAL" } });
      // Còn ngày chưa đủ căn cứ thì giữ nguyên UNMATCHED để lần chạy sau quyết toán nốt; đánh
      // MATCHED lúc này là khoá luôn phần phí của những ngày đó, không bao giờ vào sổ được nữa.
      await tx.bankStatementTransaction.update({
        where: { id: plan.bank.id },
        data: {
          reconcileStatus: partial ? "UNMATCHED" : "MATCHED",
          autoProcessType: "WALLET_SETTLEMENT",
          autoProcessNote: partial
            ? `Đã quyết toán ngày ${settledDays} bằng ${transfer.code}; còn ${plan.settlement.pending.map((row) => businessDateKey(row.revenueDate)).join(", ")} chờ đủ doanh thu`
            : `Đã backfill bằng doanh thu nhập tay và đối soát với ${transfer.code}`,
        },
      });
    });
  }
  const applied = plans.filter((plan) => plan.safe);
  const stillPartial = applied.filter((plan) => plan.settlement.partial);
  console.log(`Đã backfill ${applied.length} giao dịch, tổng phí ghi nhận ${applied.reduce((sum, plan) => sum + plan.settlement.feeAmount, 0).toLocaleString("vi-VN")} đ.`);
  if (stillPartial.length) {
    console.log(`${stillPartial.length} giao dịch mới quyết toán một phần, vẫn để UNMATCHED để chạy tiếp khi có đủ file POS:`);
    for (const plan of stillPartial) {
      console.log(`  ${plan.bank.transactionCode}: còn ${plan.settlement.pending.map((row) => businessDateKey(row.revenueDate)).join(", ")}`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
