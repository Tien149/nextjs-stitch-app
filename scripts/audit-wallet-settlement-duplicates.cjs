/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Soát tiền về ngân hàng bị ghi hai lần: một lần bằng phiếu thu lập từ dòng sao kê, một lần
 * nữa bằng phiếu quyết toán ví (QTVI).
 *
 * Vì sao lọt: Sổ sao kê đọc bảng BankStatementTransaction — đúng những gì ngân hàng báo. Sổ quỹ
 * đọc phiếu thu/chi + phiếu điều tiền + điều chỉnh quỹ (app/api/finance-operations/route.ts).
 * Phiếu QTVI là phiếu điều tiền: vế IN cộng thẳng tiền vào ngân hàng trong sổ quỹ nhưng không
 * sinh dòng sao kê mới, nó chỉ trỏ về dòng sao kê cũ qua externalRef. Nên nếu dòng sao kê đó đã
 * được lập thành phiếu thu rồi thì sổ quỹ cộng tiền hai lần, còn sao kê vẫn một lần.
 *
 * Luồng đúng theo thiết kế là Đối chiếu tiền vào > Quyết toán nhóm ví: nó đánh dấu dòng sao kê
 * MATCHED/WALLET_SETTLEMENT rồi mới tạo QTVI và KHÔNG lập phiếu thu.
 *
 * Script CHỈ ĐỌC, không sửa gì. Sửa phải làm tay trên giao diện vì mỗi ca một cách xử lý khác
 * nhau (xem phần "Cách xử lý" cuối báo cáo).
 *
 * Dùng:
 *   node scripts/audit-wallet-settlement-duplicates.cjs --branch NME --period 2026-08
 *   node scripts/audit-wallet-settlement-duplicates.cjs --branch NME --period 2026-08 --json
 *   node scripts/audit-wallet-settlement-duplicates.cjs --self-test        # không cần DB
 */
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
};
const branchCode = valueOf("--branch").trim().toUpperCase();
const period = valueOf("--period").trim();
const asJson = args.includes("--json");
const selfTest = args.includes("--self-test");
/** Phiếu thu lập tay thường lệch ngày so với phiếu quyết toán vài hôm. */
const dayTolerance = Number(valueOf("--day-tolerance") || "3");
/** Soi chi tiết vài ngày: bóc từng dòng sổ quỹ đối lấy từng dòng sao kê. */
const explainDays = valueOf("--explain").split(",").map((value) => value.trim()).filter(Boolean);

function usageError(message) {
  throw new Error(`${message}\nDùng: node scripts/audit-wallet-settlement-duplicates.cjs --branch NME --period 2026-08 [--explain 2026-08-25,2026-08-06] [--day-tolerance 3] [--json]`);
}

// ---------------------------------------------------------------------------
// Phần thuần logic — tách riêng để --self-test chạy được mà không cần DB.
// ---------------------------------------------------------------------------

/** Cùng luật với lib/accounting.ts > periodBounds: mốc giờ địa phương, không phải UTC. */
function periodBounds(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) usageError(`Kỳ không hợp lệ: ${value || "(trống)"}`);
  const [year, month] = value.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: new Date(`${value}-01T00:00:00`),
    end: new Date(`${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01T00:00:00`),
  };
}

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayDistance(a, b) {
  return Math.abs(Math.round((new Date(dayKey(a)).getTime() - new Date(dayKey(b)).getTime()) / 86400000));
}

/** Cùng luật với lib/money-sources.ts > normalizeMoneySourceGroup. */
function normalizeMoneySourceGroup(group) {
  const raw = String(group || "").trim().toUpperCase();
  const normalized = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/Đ/g, "D");
  if (["CASH", "TIEN MAT", "QUY TIEN MAT"].includes(normalized)) return "CASH";
  if (["BANK", "NGAN HANG", "TAI KHOAN NGAN HANG"].includes(normalized)) return "BANK";
  if (["WALLET", "VI", "VI/POS", "VI DIEN TU", "POS", "CONG POS"].includes(normalized)) return "WALLET";
  return raw;
}

/** Cùng luật với lib/money-transfer-date.ts > effectiveMoneyTransferDate. */
function effectiveMoneyTransferDate(row) {
  return row.transferPurpose === "CASH_DEPOSIT" ? (row.actualTransferDate ?? row.transferDate) : row.transferDate;
}

/**
 * Cùng luật với lib/internal-transfer.ts > transferLegsForBranch: phiếu liên nhà hàng chỉ góp
 * một vế cho mỗi cửa hàng, tính cả hai là nhân đôi tiền của cửa hàng không sở hữu nguồn.
 */
function transferLegsForBranch(transfer, branch) {
  const target = String(branch || "").trim().toUpperCase();
  const from = String(transfer.fromBranchCode || transfer.branchCode || "").trim().toUpperCase();
  const to = String(transfer.toBranchCode || transfer.branchCode || "").trim().toUpperCase();
  if (!target || target === "ALL") return { out: true, in: true };
  return { out: from === target, in: to === target };
}

function normalizeRef(value) {
  return String(value || "").trim().toUpperCase();
}

/**
 * Một phiếu quyết toán ví cộng tiền vào ngân hàng. Phiếu thu nào dưới đây cũng đang cộng đúng
 * khoản tiền đó lần nữa?
 *
 * TRUNG_THAM_CHIEU: phiếu thu mang đúng số tham chiếu sao kê mà phiếu quyết toán đang trỏ tới —
 * chắc chắn cùng một lần tiền về, không phải trùng ngẫu nhiên.
 * TRUNG_SO_TIEN: cùng tài khoản ngân hàng, cùng số tiền, lệch ngày trong ngưỡng cho phép. Bắt
 * được ca phiếu thu lập tay (externalRef để trống) — phải soi mắt trước khi kết luận.
 */
function findDuplicateReceipts(transfer, receipts, options = {}) {
  const tolerance = Number.isFinite(options.dayTolerance) ? options.dayTolerance : 3;
  const transferRef = normalizeRef(transfer.externalRef);
  const bankSource = normalizeRef(transfer.toMoneySourceCode);
  const transferDate = effectiveMoneyTransferDate(transfer);
  const hits = [];
  for (const receipt of receipts) {
    if (normalizeRef(receipt.moneySourceCode) !== bankSource) continue;
    if (transferRef && normalizeRef(receipt.externalRef) === transferRef) {
      hits.push({ receipt, reason: "TRUNG_THAM_CHIEU", confidence: "CHAC_CHAN" });
      continue;
    }
    if (Math.abs(receipt.amount - transfer.amount) < 1 && dayDistance(receipt.voucherDate, transferDate) <= tolerance) {
      hits.push({ receipt, reason: "TRUNG_SO_TIEN", confidence: "NGHI_NGO" });
    }
  }
  // Chắc chắn xếp trước để người đọc xử lý từ trên xuống.
  return hits.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "CHAC_CHAN" ? -1 : 1));
}

/**
 * Soi một ngày: ghép từng dòng tiền vào của sổ quỹ với từng dòng Có của sao kê.
 *
 * Ghép hai vòng, vòng sau chỉ xét những dòng vòng trước chưa dùng:
 *   1. theo số tham chiếu sao kê — chắc chắn cùng một lần tiền về;
 *   2. theo cùng tài khoản + cùng số tiền, mỗi dòng sao kê chỉ được dùng một lần.
 *
 * Dòng sổ quỹ còn trơ lại = sổ quỹ ghi tiền vào mà ngân hàng không báo (nghi thừa).
 * Dòng sao kê còn trơ lại = ngân hàng báo tiền vào mà chưa lập chứng từ (nghi thiếu).
 */
function matchDayEntries(cashRows, statementRows) {
  const pool = statementRows.map((row) => ({ row, used: false }));
  const matched = [];
  const pending = [];

  for (const cash of cashRows) {
    const ref = normalizeRef(cash.externalRef);
    const hit = ref && pool.find((item) => !item.used
      && normalizeRef(item.row.bankAccount) === normalizeRef(cash.moneySourceCode)
      && normalizeRef(item.row.transactionCode) === ref);
    if (hit) {
      hit.used = true;
      matched.push({ cash, statement: hit.row, reason: "THAM_CHIEU" });
    } else {
      pending.push(cash);
    }
  }

  const unmatchedCash = [];
  for (const cash of pending) {
    const hit = pool.find((item) => !item.used
      && normalizeRef(item.row.bankAccount) === normalizeRef(cash.moneySourceCode)
      && Math.abs(item.row.creditAmount - cash.amount) < 1);
    if (hit) {
      hit.used = true;
      matched.push({ cash, statement: hit.row, reason: "SO_TIEN" });
    } else {
      unmatchedCash.push(cash);
    }
  }

  return { matched, unmatchedCash, unmatchedStatement: pool.filter((item) => !item.used).map((item) => item.row) };
}

function money(value) {
  return Math.round(value || 0).toLocaleString("vi-VN");
}

function runSelfTest() {
  const assert = require("node:assert/strict");

  assert.equal(dayKey(new Date("2026-08-01T03:00:00")), "2026-08-01");
  assert.equal(dayDistance(new Date("2026-08-01T23:00:00"), new Date("2026-08-04T01:00:00")), 3);
  assert.equal(normalizeMoneySourceGroup("Ngân hàng"), "BANK");
  assert.equal(normalizeMoneySourceGroup("VÍ"), "WALLET");

  const bounds = periodBounds("2026-12");
  assert.equal(dayKey(bounds.start), "2026-12-01");
  assert.equal(dayKey(bounds.end), "2027-01-01");

  // Phiếu nộp tiền mặt ghi theo ngày thực nộp, loại khác giữ ngày phiếu.
  assert.equal(dayKey(effectiveMoneyTransferDate({ transferPurpose: "CASH_DEPOSIT", transferDate: new Date("2026-08-01T00:00:00"), actualTransferDate: new Date("2026-08-03T00:00:00") })), "2026-08-03");
  assert.equal(dayKey(effectiveMoneyTransferDate({ transferPurpose: "WALLET_SETTLEMENT", transferDate: new Date("2026-08-01T00:00:00"), actualTransferDate: new Date("2026-08-03T00:00:00") })), "2026-08-01");

  // Phiếu liên nhà hàng: mỗi bên chỉ một vế.
  assert.deepEqual(transferLegsForBranch({ branchCode: "NME", fromBranchCode: "ASA", toBranchCode: "NME" }, "NME"), { out: false, in: true });
  assert.deepEqual(transferLegsForBranch({ branchCode: "NME", fromBranchCode: "ASA", toBranchCode: "NME" }, "ALL"), { out: true, in: true });

  const transfer = {
    code: "QTVI-2608-NME-00020",
    externalRef: "TH5A-8B1MSPREA",
    toMoneySourceCode: "FDSCHKHVIET",
    amount: 1977869,
    transferDate: new Date("2026-08-01T00:00:00"),
    transferPurpose: "WALLET_SETTLEMENT",
  };
  const byRef = { code: "UNT-2608-NME-00679", moneySourceCode: "FDSCHKHVIET", externalRef: "TH5A-8B1MSPREA", amount: 1977869, voucherDate: new Date("2026-08-01T00:00:00") };
  const byAmount = { code: "UNT-2608-NME-00679", moneySourceCode: "FDSCHKHVIET", externalRef: null, amount: 1977869, voucherDate: new Date("2026-08-03T00:00:00") };
  const otherBank = { code: "UNT-2608-NME-00700", moneySourceCode: "KHAC", externalRef: "TH5A-8B1MSPREA", amount: 1977869, voucherDate: new Date("2026-08-01T00:00:00") };
  const otherAmount = { code: "UNT-2608-NME-00701", moneySourceCode: "FDSCHKHVIET", externalRef: null, amount: 999999, voucherDate: new Date("2026-08-01T00:00:00") };
  const tooFar = { code: "UNT-2608-NME-00702", moneySourceCode: "FDSCHKHVIET", externalRef: null, amount: 1977869, voucherDate: new Date("2026-08-20T00:00:00") };

  // Đúng ca của Nam Mê ngày 1/8: phiếu thu và phiếu quyết toán cùng trỏ một dòng sao kê.
  assert.deepEqual(findDuplicateReceipts(transfer, [byRef]).map((hit) => hit.reason), ["TRUNG_THAM_CHIEU"]);
  // Phiếu thu lập tay không khai tham chiếu vẫn bắt được bằng số tiền + ngày.
  assert.deepEqual(findDuplicateReceipts(transfer, [byAmount]).map((hit) => hit.reason), ["TRUNG_SO_TIEN"]);
  // Không bắt nhầm sang tài khoản khác, số tiền khác, hay ngày quá xa.
  assert.deepEqual(findDuplicateReceipts(transfer, [otherBank, otherAmount, tooFar]), []);
  // Mỗi phiếu thu chỉ tính một lý do, chắc chắn xếp trước.
  const mixed = findDuplicateReceipts(transfer, [byAmount, byRef]);
  assert.equal(mixed.length, 2);
  assert.equal(mixed[0].confidence, "CHAC_CHAN");

  // --- Soi một ngày ---
  const stm = (code, amount, bank = "FDSCHKHVIET") => ({ transactionCode: code, bankAccount: bank, creditAmount: amount, description: code });
  const cash = (code, amount, ref = null, bank = "FDSCHKHVIET") => ({ kind: "PHIEU_THU", code, moneySourceCode: bank, amount, externalRef: ref, description: code });

  // Tham chiếu được ưu tiên: dòng sao kê cùng số tiền không được "cướp" mất của dòng có ref.
  const byRefFirst = matchDayEntries(
    [cash("PT-A", 1000000), cash("PT-B", 1000000, "REF-B")],
    [stm("REF-B", 1000000), stm("REF-C", 1000000)],
  );
  assert.equal(byRefFirst.matched.length, 2);
  assert.equal(byRefFirst.matched.find((row) => row.cash.code === "PT-B").reason, "THAM_CHIEU");
  assert.equal(byRefFirst.matched.find((row) => row.cash.code === "PT-A").statement.transactionCode, "REF-C");

  // Mỗi dòng sao kê chỉ gánh được một chứng từ: hai phiếu cùng số tiền mà sao kê chỉ báo một lần
  // thì phiếu thứ hai phải trơ ra — đúng dạng ghi hai lần.
  const doubled = matchDayEntries([cash("PT-A", 1977869), cash("PT-B", 1977869)], [stm("REF-A", 1977869)]);
  assert.equal(doubled.matched.length, 1);
  assert.deepEqual(doubled.unmatchedCash.map((row) => row.code), ["PT-B"]);
  assert.deepEqual(doubled.unmatchedStatement, []);

  // Ngân hàng báo mà chưa lập chứng từ.
  const missing = matchDayEntries([], [stm("REF-A", 500000)]);
  assert.deepEqual(missing.unmatchedStatement.map((row) => row.transactionCode), ["REF-A"]);

  // Khác tài khoản thì không ghép.
  const otherAccount = matchDayEntries([cash("PT-A", 500000, null, "BANK_X")], [stm("REF-A", 500000)]);
  assert.equal(otherAccount.matched.length, 0);
  assert.equal(otherAccount.unmatchedCash.length, 1);
  assert.equal(otherAccount.unmatchedStatement.length, 1);

  console.log("Self-test OK");
}

// ---------------------------------------------------------------------------
// Phần đọc DB
// ---------------------------------------------------------------------------

async function main() {
  if (selfTest) return runSelfTest();
  if (!branchCode) usageError("Thiếu --branch");
  if (branchCode === "ALL") usageError("--branch phải là một cửa hàng cụ thể, không dùng ALL.");
  const { start, end } = periodBounds(period);

  const { PrismaClient } = require("@prisma/custom-client");
  const prisma = new PrismaClient();
  try {
    // deletedAt lọc tường minh vì script chạy PrismaClient thô, không qua extension xoá mềm.
    const moneySources = await prisma.masterDataItem.findMany({
      where: { type: "MONEY_SOURCE", deletedAt: null },
      select: { code: true, name: true, group: true, branch: true },
    });
    const groupByCode = new Map(moneySources.map((row) => [normalizeRef(row.code), normalizeMoneySourceGroup(row.group)]));
    const nameByCode = new Map(moneySources.map((row) => [normalizeRef(row.code), row.name]));
    const isBank = (code) => groupByCode.get(normalizeRef(code)) === "BANK";

    const [vouchers, adjustments, transfers, statements] = await Promise.all([
      prisma.financialVoucher.findMany({
        where: { branchCode, voucherDate: { gte: start, lt: end }, status: "APPROVED", deletedAt: null },
        select: { code: true, voucherType: true, voucherDate: true, moneySourceCode: true, amount: true, externalRef: true, description: true, sourceScope: true, businessEffect: true, categoryCode: true, documentChannel: true, createdBy: true, partnerName: true },
        orderBy: { voucherDate: "asc" },
      }),
      prisma.cashbookAdjustment.findMany({
        where: { branchCode, entryDate: { gte: start, lt: end }, deletedAt: null },
        select: { code: true, entryDate: true, entryType: true, moneySourceCode: true, amount: true, description: true },
      }),
      prisma.moneyTransfer.findMany({
        where: {
          status: "APPROVED",
          deletedAt: null,
          transferDate: { gte: new Date(start.getTime() - 40 * 86400000), lt: new Date(end.getTime() + 40 * 86400000) },
          OR: [{ branchCode }, { fromBranchCode: branchCode }, { toBranchCode: branchCode }],
        },
        select: { code: true, transferDate: true, actualTransferDate: true, transferPurpose: true, branchCode: true, fromBranchCode: true, toBranchCode: true, fromMoneySourceCode: true, toMoneySourceCode: true, amount: true, feeAmount: true, grabExpenseAmount: true, externalRef: true, description: true, createdBy: true, sourceReportDate: true },
      }),
      prisma.bankStatementTransaction.findMany({
        where: { branchCode, transactionDate: { gte: start, lt: end }, deletedAt: null },
        select: { transactionCode: true, transactionDate: true, bankAccount: true, creditAmount: true, debitAmount: true, description: true, reconcileStatus: true, autoProcessType: true, revenueDate: true },
        orderBy: { transactionDate: "asc" },
      }),
    ]);

    // --- Phần A: cân sổ quỹ với sao kê theo ngày, chỉ nguồn tiền nhóm Ngân hàng ---
    const transfersInPeriod = transfers.filter((row) => {
      const date = effectiveMoneyTransferDate(row);
      return date >= start && date < end;
    });
    /** Mọi dòng làm tiền VÀO một tài khoản ngân hàng trong sổ quỹ, cùng một hình dạng. */
    const cashRows = [
      ...vouchers
        .filter((row) => row.voucherType === "RECEIPT" && isBank(row.moneySourceCode))
        .map((row) => ({ kind: "PHIEU_THU", day: dayKey(row.voucherDate), code: row.code, moneySourceCode: row.moneySourceCode, amount: row.amount, externalRef: row.externalRef, description: row.description, note: `${row.categoryCode || "(trống khoản mục)"} · ${row.sourceScope} · ${row.businessEffect} · ${row.partnerName} · người lập ${row.createdBy || "?"}` })),
      ...adjustments
        .filter((row) => row.entryType === "RECEIPT" && isBank(row.moneySourceCode))
        .map((row) => ({ kind: "DIEU_CHINH", day: dayKey(row.entryDate), code: row.code, moneySourceCode: row.moneySourceCode, amount: row.amount, externalRef: null, description: row.description || "", note: "điều chỉnh quỹ" })),
      ...transfersInPeriod
        .filter((row) => transferLegsForBranch(row, branchCode).in && isBank(row.toMoneySourceCode))
        .map((row) => ({ kind: "DIEU_TIEN", day: dayKey(effectiveMoneyTransferDate(row)), code: row.code, moneySourceCode: row.toMoneySourceCode, amount: row.amount, externalRef: row.externalRef, description: row.description, note: `${row.transferPurpose || "điều tiền"} · từ ${row.fromMoneySourceCode} · người lập ${row.createdBy || "?"}` })),
    ];
    const statementRows = statements.filter((row) => row.creditAmount > 0).map((row) => ({ ...row, day: dayKey(row.transactionDate) }));

    const days = new Map();
    const touch = (key) => {
      if (!days.has(key)) days.set(key, { day: key, cashbook: 0, statement: 0, fromReceipts: 0, fromTransfers: 0, fromAdjustments: 0 });
      return days.get(key);
    };
    const bucketOf = { PHIEU_THU: "fromReceipts", DIEU_TIEN: "fromTransfers", DIEU_CHINH: "fromAdjustments" };
    for (const row of cashRows) {
      const day = touch(row.day);
      day.cashbook += row.amount;
      day[bucketOf[row.kind]] += row.amount;
    }
    for (const row of statementRows) touch(row.day).statement += row.creditAmount;
    const daily = [...days.values()]
      .map((row) => ({ ...row, diff: Math.round(row.cashbook - row.statement) }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // --- Phần B: phiếu quyết toán ví nào đang trùng với một phiếu thu ---
    const receipts = vouchers.filter((row) => row.voucherType === "RECEIPT");
    const statementByKey = new Map(statements.map((row) => [`${normalizeRef(row.bankAccount)}|${normalizeRef(row.transactionCode)}`, row]));
    const walletSettlements = transfersInPeriod.filter((row) => row.transferPurpose === "WALLET_SETTLEMENT" && transferLegsForBranch(row, branchCode).in);
    const findings = [];
    for (const transfer of walletSettlements) {
      const hits = findDuplicateReceipts(transfer, receipts, { dayTolerance });
      if (!hits.length) continue;
      const statement = statementByKey.get(`${normalizeRef(transfer.toMoneySourceCode)}|${normalizeRef(transfer.externalRef)}`) || null;
      findings.push({
        transferCode: transfer.code,
        transferDate: dayKey(effectiveMoneyTransferDate(transfer)),
        wallet: transfer.fromMoneySourceCode,
        bank: transfer.toMoneySourceCode,
        amount: transfer.amount,
        feeAmount: transfer.feeAmount,
        grabExpenseAmount: transfer.grabExpenseAmount,
        externalRef: transfer.externalRef,
        createdBy: transfer.createdBy,
        transferDescription: transfer.description,
        statement: statement
          ? { transactionCode: statement.transactionCode, date: dayKey(statement.transactionDate), creditAmount: statement.creditAmount, reconcileStatus: statement.reconcileStatus, autoProcessType: statement.autoProcessType }
          : null,
        receipts: hits.map((hit) => ({
          code: hit.receipt.code,
          date: dayKey(hit.receipt.voucherDate),
          amount: hit.receipt.amount,
          externalRef: hit.receipt.externalRef,
          categoryCode: hit.receipt.categoryCode,
          sourceScope: hit.receipt.sourceScope,
          businessEffect: hit.receipt.businessEffect,
          description: hit.receipt.description,
          reason: hit.reason,
          confidence: hit.confidence,
        })),
      });
    }

    const certain = findings.filter((row) => row.receipts.some((hit) => hit.confidence === "CHAC_CHAN"));
    const suspect = findings.filter((row) => !row.receipts.some((hit) => hit.confidence === "CHAC_CHAN"));
    const overstated = findings.reduce((sum, row) => sum + row.amount, 0);

    // --- Phần C: soi từng ngày được chỉ đích danh ---
    const explained = explainDays.map((day) => {
      const dayCash = cashRows.filter((row) => row.day === day).sort((a, b) => b.amount - a.amount);
      const dayStatement = statementRows.filter((row) => row.day === day).sort((a, b) => b.creditAmount - a.creditAmount);
      const result = matchDayEntries(dayCash, dayStatement);
      // Dòng trơ ra có thể chỉ là lệch ngày: tiền về hôm sau, hoặc phiếu ghi trước ngày sao kê.
      const nearby = statementRows.filter((row) => row.day !== day && dayDistance(new Date(row.day), new Date(day)) <= dayTolerance);
      return {
        day,
        ...result,
        unmatchedCash: result.unmatchedCash.map((cash) => ({
          ...cash,
          nearbyStatement: nearby.filter((row) => normalizeRef(row.bankAccount) === normalizeRef(cash.moneySourceCode) && Math.abs(row.creditAmount - cash.amount) < 1),
        })),
        cashTotal: dayCash.reduce((sum, row) => sum + row.amount, 0),
        statementTotal: dayStatement.reduce((sum, row) => sum + row.creditAmount, 0),
      };
    });

    if (asJson) {
      console.log(JSON.stringify({ branchCode, period, daily, findings, explained, summary: { walletSettlements: walletSettlements.length, certain: certain.length, suspect: suspect.length, overstated } }, null, 2));
      return;
    }

    console.log(`\n=== SOÁT TIỀN VỀ NGÂN HÀNG GHI HAI LẦN — ${branchCode} kỳ ${period} ===\n`);

    console.log("A. Cân theo ngày (chỉ nguồn tiền nhóm Ngân hàng)");
    console.log("   Ngày         Sổ quỹ thu      Sao kê Có        Chênh   (trong đó: phiếu thu / điều tiền / điều chỉnh)");
    let totalCashbook = 0;
    let totalStatement = 0;
    for (const row of daily) {
      totalCashbook += row.cashbook;
      totalStatement += row.statement;
      const flag = row.diff === 0 ? "  " : row.diff > 0 ? "↑ " : "↓ ";
      console.log(`   ${row.day}  ${money(row.cashbook).padStart(13)}  ${money(row.statement).padStart(13)}  ${flag}${money(row.diff).padStart(11)}   ${money(row.fromReceipts)} / ${money(row.fromTransfers)} / ${money(row.fromAdjustments)}`);
    }
    console.log(`   ${"TỔNG".padEnd(10)}  ${money(totalCashbook).padStart(13)}  ${money(totalStatement).padStart(13)}  ${money(totalCashbook - totalStatement).padStart(13)}`);
    console.log("   Chênh dương = sổ quỹ nhiều hơn ngân hàng báo. Không phải chênh nào cũng là trùng:");
    console.log("   phiếu thu tiền mặt nộp vào tài khoản, hay dòng sao kê chưa lập phiếu, cũng làm lệch.\n");

    console.log(`B. Phiếu quyết toán ví (QTVI) trong kỳ: ${walletSettlements.length}`);
    console.log(`   Trùng chắc chắn: ${certain.length} — Nghi ngờ: ${suspect.length} — Tiền đang bị cộng thừa: ${money(overstated)} đ\n`);
    if (!findings.length) {
      console.log("   Không thấy phiếu quyết toán ví nào trùng với phiếu thu.\n");
    }
    for (const row of findings) {
      const worst = row.receipts.some((hit) => hit.confidence === "CHAC_CHAN") ? "TRÙNG CHẮC CHẮN" : "NGHI NGỜ";
      console.log(`   [${worst}] ${row.transferCode}  ${row.transferDate}  ${money(row.amount)} đ`);
      console.log(`      Ví ${row.wallet} → Ngân hàng ${row.bank} (${nameByCode.get(normalizeRef(row.bank)) || "?"})`);
      console.log(`      Phí: ${money(row.feeAmount)} đ (trong đó chi phí Grab ${money(row.grabExpenseAmount)} đ) — người lập: ${row.createdBy || "?"}`);
      console.log(`      Diễn giải: ${row.transferDescription}`);
      if (row.statement) {
        console.log(`      Dòng sao kê ${row.statement.transactionCode} ${row.statement.date} Có ${money(row.statement.creditAmount)} đ — trạng thái ${row.statement.reconcileStatus}${row.statement.autoProcessType ? ` / ${row.statement.autoProcessType}` : ""}`);
        if (row.statement.reconcileStatus === "UNMATCHED") {
          console.log("      ⚠ Dòng sao kê vẫn UNMATCHED dù đã có phiếu quyết toán — đây là chỗ hở để lập thêm phiếu thu.");
        }
      } else if (row.externalRef) {
        console.log(`      Không tìm thấy dòng sao kê ${row.externalRef} trong kỳ (có thể nằm ở kỳ khác).`);
      } else {
        console.log("      Phiếu quyết toán không khai số tham chiếu sao kê.");
      }
      for (const hit of row.receipts) {
        console.log(`      ↳ Phiếu thu ${hit.code}  ${hit.date}  ${money(hit.amount)} đ  [${hit.reason}]`);
        console.log(`         khoản mục ${hit.categoryCode || "(trống)"} · ${hit.sourceScope} · ${hit.businessEffect} · ref ${hit.externalRef || "(trống)"}`);
        console.log(`         ${hit.description}`);
        if (hit.businessEffect === "RECOGNITION") {
          console.log("         ⚠ RECOGNITION: phiếu này ghi nhận nghiệp vụ mới, nên có thể doanh thu cũng bị ghi thêm lần nữa.");
        }
      }
      console.log("");
    }

    for (const detail of explained) {
      console.log(`C. Soi ngày ${detail.day} — sổ quỹ ${money(detail.cashTotal)} đ / sao kê ${money(detail.statementTotal)} đ / chênh ${money(detail.cashTotal - detail.statementTotal)} đ\n`);

      const unmatchedCashTotal = detail.unmatchedCash.reduce((sum, row) => sum + row.amount, 0);
      console.log(`   C1. Sổ quỹ ghi tiền vào mà sao kê ngày đó không báo: ${detail.unmatchedCash.length} dòng, ${money(unmatchedCashTotal)} đ`);
      if (!detail.unmatchedCash.length) console.log("       (không có)");
      for (const row of detail.unmatchedCash) {
        console.log(`       [${row.kind}] ${row.code}  ${money(row.amount)} đ  → ${row.moneySourceCode} (${nameByCode.get(normalizeRef(row.moneySourceCode)) || "?"})`);
        console.log(`          ${row.note}`);
        console.log(`          ${row.description}`);
        for (const near of row.nearbyStatement) {
          console.log(`          ↔ có thể là dòng sao kê ${near.transactionCode} ngày ${near.day} Có ${money(near.creditAmount)} đ (lệch ngày, không phải thừa tiền)`);
        }
      }
      console.log("");

      const unmatchedStatementTotal = detail.unmatchedStatement.reduce((sum, row) => sum + row.creditAmount, 0);
      console.log(`   C2. Sao kê báo tiền vào mà sổ quỹ chưa ghi: ${detail.unmatchedStatement.length} dòng, ${money(unmatchedStatementTotal)} đ`);
      if (!detail.unmatchedStatement.length) console.log("       (không có)");
      for (const row of detail.unmatchedStatement) {
        console.log(`       ${row.transactionCode}  ${money(row.creditAmount)} đ  → ${row.bankAccount}  [${row.reconcileStatus}${row.autoProcessType ? ` / ${row.autoProcessType}` : ""}]`);
        console.log(`          ${row.description}`);
      }
      console.log("");

      console.log(`   C3. Đã khớp được: ${detail.matched.length} cặp, ${money(detail.matched.reduce((sum, row) => sum + row.cash.amount, 0))} đ`);
      console.log("");
    }

    console.log("Cách xử lý (làm tay trên giao diện, script này không sửa gì):");
    console.log("  - Theo thiết kế thì GIỮ phiếu quyết toán ví, XOÁ phiếu thu: phiếu quyết toán làm ba việc một");
    console.log("    lúc — cộng tiền vào ngân hàng, rút số treo ở ví về 0, đẩy phí lên P&L. Xoá nó thay vì xoá");
    console.log("    phiếu thu thì ví treo mãi và phí biến mất khỏi P&L.");
    if (findings.some((row) => row.statement && row.statement.reconcileStatus !== "MATCHED")) {
      console.log("  - Xoá phiếu thu xong nhớ đưa dòng sao kê về đúng trạng thái ở màn Đối chiếu tiền vào");
      console.log("    (Quyết toán nhóm ví) để lần import sau không lập lại phiếu thu cho chính dòng đó.");
    }
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
