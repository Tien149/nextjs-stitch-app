/**
 * CHẨN ĐOÁN SỐ DƯ CUỐI KỲ CỦA VÍ TRÊN BÁO CÁO NGUỒN TIỀN — CHỈ ĐỌC, KHÔNG SỬA GÌ.
 *
 * Khách báo 26/09/2026 (kỳ 08/2026): cột Cuối kỳ của ví sai.
 *   - NAM MÊ  FDS - GrabFood 2.301.999 đ   → phải = doanh thu 31/8 (tiền về 1/9)
 *   - NAM MÊ  FDS - Momo     24.607.444 đ  → phải = 0 (Momo trả trong ngày)
 *   - NAM MÊ  FDS - VNPAY   -22.228.493 đ  → phải = doanh thu 31/8 (tiền về 3/9)
 *   - ASA     Momo ASA 222.583.571 đ, Momo KCF 153.898.138 đ → phải = doanh thu 31/8
 *
 * Luật khách chốt: số dư ví cuối kỳ = doanh thu ĐÃ BÁN mà tiền CHƯA VỀ ngân hàng tính tới hết
 * kỳ. Script tính con số đó từ Ngày doanh thu trên dòng sao kê (vế ví của phiếu QTVI) rồi đặt
 * cạnh số báo cáo đang ra, kèm từng dòng sao kê / phiếu QTVI để thấy phần chênh nằm ở đâu:
 *
 *   [A] Dòng sao kê báo cáo đang cộng vào cột Thu của ví (lọc theo Ngày nguồn tiền, thiếu thì
 *       ngày giao dịch — đúng luật lib/reports.ts). Cờ "CHƯA QTVI" = tiền vào Thu của ví mà
 *       không có phiếu quyết toán kéo ra → ví phình. Cờ "NDT≠kỳ" = ngày doanh thu khác kỳ.
 *   [B] Phiếu QTVI ra khỏi ví trong kỳ (cột Chi = phí, điều tiền ra = số về ngân hàng). Cờ
 *       "NNT≠kỳ" = dòng sao kê của phiếu lại cộng Thu ở kỳ khác → ví lệch giữa hai kỳ.
 *   [C] Doanh thu còn treo ở hai mốc đầu kỳ / cuối kỳ theo Ngày doanh thu → số khách kỳ vọng.
 *   [D] Doanh thu POS và tiền về 5 ngày cuối kỳ (bảng Tiền về đủ chưa) để so bằng mắt.
 *
 *   npm run -s diagnose:wallet-balance -- --period 2026-08 --branch NME,ASA
 *   npm run -s diagnose:wallet-balance -- --period 2026-08 --branch ASA --wallet MOMO_EDC_ASA
 *   (thiếu --branch thì in danh sách mã cửa hàng có ví; kết quả in thẳng ra màn hình để copy)
 */
import { prisma } from "../lib/prisma.ts";
import { periodBounds } from "../lib/accounting.ts";
import { getCashSourceReport, getRevenueSettlementReport } from "../lib/reports.ts";
import { normalizeMoneySourceGroup } from "../lib/money-sources.ts";
import { vietnamBusinessDayKey } from "../lib/revenue-date.ts";

// lib/prisma.ts luôn bật log câu SQL — nuốt dòng "prisma:query" để màn hình chỉ còn kết quả,
// copy thẳng được mà không phải lọc bằng grep.
const printLine = console.log.bind(console);
console.log = (...parts) => {
  if (typeof parts[0] === "string" && parts[0].startsWith("prisma:query")) return;
  printLine(...parts);
};

const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : ""; };
const period = valueOf("--period").trim();
const branches = valueOf("--branch").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);
const walletFilter = valueOf("--wallet").split(",").map((v) => v.trim().toUpperCase()).filter(Boolean);

const money = (v) => Math.round(v || 0).toLocaleString("vi-VN");
const pad = (v, n = 14) => money(v).padStart(n);
const day = (d) => (d ? vietnamBusinessDayKey(d).slice(5).split("-").reverse().join("/") : "  —  ");
const DAY_MS = 24 * 60 * 60 * 1000;

if (!/^\d{4}-\d{2}$/.test(period)) {
  console.error("Thiếu --period YYYY-MM, ví dụ: npm run diagnose:wallet-balance -- --period 2026-08 --branch NME");
  process.exit(1);
}

const allSources = await prisma.masterDataItem.findMany({
  where: { type: "MONEY_SOURCE" },
  select: { code: true, name: true, group: true, branch: true, status: true, settlementBankCode: true, summarySourceName: true },
});
const wallets = allSources.filter((s) => normalizeMoneySourceGroup(s.group) === "WALLET");

if (branches.length === 0) {
  const byBranch = new Map();
  for (const w of wallets) byBranch.set(w.branch || "?", [...(byBranch.get(w.branch || "?") || []), w.code]);
  console.log("Thiếu --branch. Các cửa hàng có ví:");
  for (const [b, codes] of byBranch) console.log(`  ${b.padEnd(8)} ${codes.join(", ")}`);
  process.exit(0);
}

const { start, end } = periodBounds(period);
const inPeriod = (d) => Boolean(d) && d >= start && d < end;
const windowStart = new Date(start.getTime() - 62 * DAY_MS);
const windowEnd = new Date(end.getTime() + 62 * DAY_MS);

for (const branchCode of branches) {
  const branchWallets = wallets.filter((w) => w.branch === branchCode && (walletFilter.length === 0 || walletFilter.includes(w.code)));
  console.log(`\n################ CỬA HÀNG ${branchCode} — KỲ ${period} ################`);
  if (branchWallets.length === 0) { console.log("  Không có ví nào khớp."); continue; }
  const codes = branchWallets.map((w) => w.code);

  const [report, settlementReport, openings, allocations, legacyRows, transfers] = await Promise.all([
    getCashSourceReport([period], branchCode),
    getRevenueSettlementReport(period, branchCode).catch((e) => ({ rows: [], error: e.message })),
    prisma.openingBalance.findMany({
      where: { moneySourceCode: { in: codes } },
      select: { period: true, moneySourceCode: true, amount: true, status: true, balanceType: true, branchCode: true },
      orderBy: { period: "asc" },
    }),
    prisma.bankStatementAllocation.findMany({
      where: {
        creditAmount: { gt: 0 },
        bankTransaction: { is: { deletedAt: null } },
        AND: [
          { OR: [
            { decreaseMoneySourceCode: { in: codes } },
            { decreaseMoneySourceCode: null, bankTransaction: { is: { decreaseMoneySourceCode: { in: codes } } } },
            { decreaseMoneySourceCode: null, increaseMoneySourceCode: { in: codes } },
            { decreaseMoneySourceCode: null, increaseMoneySourceCode: null, summaryMoneySourceCode: { in: codes } },
          ] },
          { OR: [
            { revenueDate: { gte: windowStart, lt: windowEnd } },
            { sourceDate: { gte: windowStart, lt: windowEnd } },
            { bankTransaction: { is: { transactionDate: { gte: windowStart, lt: windowEnd } } } },
          ] },
        ],
      },
      include: { bankTransaction: { include: { matches: { where: { deletedAt: null }, select: { targetType: true, targetId: true, targetCode: true } } } } },
    }),
    prisma.bankStatementTransaction.findMany({
      where: {
        deletedAt: null,
        creditAmount: { gt: 0 },
        allocations: { none: {} },
        OR: [
          { decreaseMoneySourceCode: { in: codes } },
          { decreaseMoneySourceCode: null, increaseMoneySourceCode: { in: codes } },
          { decreaseMoneySourceCode: null, increaseMoneySourceCode: null, summaryMoneySourceCode: { in: codes } },
        ],
        AND: [{ OR: [
          { revenueDate: { gte: windowStart, lt: windowEnd } },
          { sourceDate: { gte: windowStart, lt: windowEnd } },
          { transactionDate: { gte: windowStart, lt: windowEnd } },
        ] }],
      },
      include: { matches: { where: { deletedAt: null }, select: { targetType: true, targetId: true, targetCode: true } } },
    }),
    prisma.moneyTransfer.findMany({
      where: { fromMoneySourceCode: { in: codes }, status: "APPROVED", transferDate: { gte: windowStart, lt: windowEnd } },
      select: { id: true, code: true, fromMoneySourceCode: true, transferDate: true, sourceReportDate: true, amount: true, feeAmount: true, externalRef: true, transferPurpose: true, toMoneySourceCode: true, branchCode: true, fromBranchCode: true },
      orderBy: { transferDate: "asc" },
    }),
  ]);

  const transferById = new Map(transfers.map((t) => [t.id, t]));
  const transfersByRef = new Map();
  for (const t of transfers) if (t.externalRef) transfersByRef.set(t.externalRef, [...(transfersByRef.get(t.externalRef) || []), t]);

  /** Chuẩn hoá dòng phân bổ + dòng sao kê cũ về một dạng, gắn đúng ví như báo cáo đang gắn. */
  const rows = [
    ...allocations.map((a) => {
      const t = a.bankTransaction;
      return {
        txnCode: t.transactionCode, bankAccount: t.bankAccount, transactionDate: t.transactionDate, accountingDate: t.accountingDate,
        sourceDate: a.sourceDate || null, revenueDate: a.revenueDate || t.revenueDate || null,
        credit: a.creditAmount, gross: a.grossAmount, categoryCode: a.categoryCode || t.categoryCode,
        operationType: a.operationType || t.operationType, depositCode: a.depositCode || t.depositCode,
        wallet: a.decreaseMoneySourceCode || t.decreaseMoneySourceCode || a.increaseMoneySourceCode || t.increaseMoneySourceCode || a.summaryMoneySourceCode || t.summaryMoneySourceCode,
        autoProcessType: t.autoProcessType, reconcileStatus: t.reconcileStatus, entrySource: t.entrySource, matches: t.matches,
        // Báo cáo lấy Ngày nguồn tiền của dòng phân bổ, thiếu thì NGÀY GIAO DỊCH (không lấy Ngày nguồn tiền của dòng cha).
        reportDate: a.sourceDate || t.transactionDate,
      };
    }),
    ...legacyRows.map((t) => ({
      txnCode: t.transactionCode, bankAccount: t.bankAccount, transactionDate: t.transactionDate, accountingDate: t.accountingDate,
      sourceDate: t.sourceDate, revenueDate: t.revenueDate, credit: t.creditAmount, gross: t.grossAmount,
      categoryCode: t.categoryCode, operationType: t.operationType, depositCode: t.depositCode,
      wallet: t.decreaseMoneySourceCode || t.increaseMoneySourceCode || t.summaryMoneySourceCode,
      autoProcessType: t.autoProcessType, reconcileStatus: t.reconcileStatus, entrySource: t.entrySource, matches: t.matches,
      reportDate: t.sourceDate || t.transactionDate,
    })),
  ].map((r) => {
    const qtvi = r.matches.filter((m) => m.targetType === "WALLET_SETTLEMENT").map((m) => transferById.get(m.targetId) || { code: m.targetCode, transferDate: null });
    const byRef = transfersByRef.get(r.txnCode) || [];
    const linked = qtvi.length ? qtvi : byRef.filter((t) => t.transferPurpose === "WALLET_SETTLEMENT");
    const arrival = linked[0]?.transferDate || r.accountingDate || r.transactionDate;
    return { ...r, qtvi: linked, arrival, amount: r.gross ?? r.credit, revenueKey: r.revenueDate || r.reportDate };
  });

  for (const wallet of branchWallets) {
    const reportRow = report.sources.find((s) => String(s.code).split(", ").includes(wallet.code));
    const walletRows = rows.filter((r) => r.wallet === wallet.code);
    const counted = walletRows
      .filter((r) => inPeriod(r.reportDate) && r.operationType !== "INTERNAL_TRANSFER" && !r.depositCode && !["DEPOSIT_RECEIPT", "DEPOSIT_REFUND"].includes(r.operationType || ""))
      .sort((a, b) => a.reportDate - b.reportDate);
    const periodTransfers = transfers.filter((t) => t.fromMoneySourceCode === wallet.code && inPeriod(t.transferDate));

    const pendingAt = (boundary) => walletRows
      .filter((r) => r.revenueKey < boundary && r.arrival >= boundary && r.operationType !== "INTERNAL_TRANSFER")
      .sort((a, b) => a.revenueKey - b.revenueKey);
    const pendingStart = pendingAt(start);
    const pendingEnd = pendingAt(end);
    const sum = (list, f = (r) => r.amount) => list.reduce((s, r) => s + (f(r) || 0), 0);

    console.log(`\n=== ${wallet.code} — ${wallet.name}${wallet.summarySourceName ? ` (gộp dòng "${wallet.summarySourceName}")` : ""} · ngân hàng đích ${wallet.settlementBankCode || "—"} · ${wallet.status || ""}`);
    if (reportRow) {
      console.log(`Báo cáo đang ra${reportRow.code !== wallet.code ? ` (dòng gộp ${reportRow.code})` : ""}: đầu kỳ ${money(reportRow.opening)} | thu ${money(reportRow.in)} | chi ${money(reportRow.out)} | điều vào ${money(reportRow.transferIn)} | điều ra ${money(reportRow.transferOut)} | CUỐI KỲ ${money(reportRow.closing)}`);
    } else {
      console.log("Báo cáo đang ra: ví không có dòng trên báo cáo kỳ này.");
    }
    const declared = openings.filter((o) => o.moneySourceCode === wallet.code);
    console.log(`Số dư đầu kỳ khai tay: ${declared.length ? declared.map((o) => `kỳ ${o.period} ${money(o.amount)} (${o.status}, ${o.balanceType})`).join("; ") : "không khai"}`);
    console.log(`Doanh thu chưa về theo NGÀY DOANH THU: đầu kỳ ${money(sum(pendingStart))} | CUỐI KỲ ${money(sum(pendingEnd))}   ← số khách kỳ vọng`);
    if (reportRow) console.log(`Chênh cuối kỳ (báo cáo − kỳ vọng): ${money(reportRow.closing - sum(pendingEnd))}`);

    const noQtvi = counted.filter((r) => r.qtvi.length === 0);
    const revenueOutside = counted.filter((r) => r.revenueDate && !inPeriod(r.revenueDate));
    const qtviRowsOutside = periodTransfers.filter((t) => {
      const src = walletRows.find((r) => r.qtvi.some((q) => q.code === t.code));
      return src && !inPeriod(src.reportDate);
    });
    console.log("Tóm tắt nguyên nhân có thể:");
    console.log(`  - Dòng sao kê cộng vào Thu của ví mà KHÔNG có phiếu QTVI kéo ra: ${noQtvi.length} dòng, ${money(sum(noQtvi))} đ`);
    console.log(`  - Dòng cộng Thu trong kỳ nhưng NGÀY DOANH THU ngoài kỳ: ${revenueOutside.length} dòng, ${money(sum(revenueOutside))} đ`);
    console.log(`  - Phiếu QTVI ghi trong kỳ mà dòng sao kê của nó cộng Thu ở kỳ khác: ${qtviRowsOutside.length} phiếu, ${money(sum(qtviRowsOutside, (t) => t.amount + t.feeAmount))} đ`);
    console.log(`  - Thu trên báo cáo không đến từ sao kê (phiếu thu/điều chỉnh ghi thẳng vào ví): ${money((reportRow?.in || 0) - sum(counted))} đ`);

    console.log(`[A] Dòng sao kê báo cáo cộng vào Thu của ví (${counted.length} dòng, ${money(sum(counted))} đ):`);
    console.log("    NgàyGD  NNT    NDT    NgàyVề  TK/Mã giao dịch                      Có tiền        Gross          Loại NV / Khoản mục        QTVI");
    for (const r of counted) {
      const flags = [r.qtvi.length ? "" : "CHƯA QTVI", r.revenueDate && !inPeriod(r.revenueDate) ? "NDT≠kỳ" : "", r.revenueDate ? "" : "thiếu NDT", r.entrySource ? r.entrySource : ""].filter(Boolean).join(" ");
      console.log(`    ${day(r.transactionDate)}  ${day(r.sourceDate)}  ${day(r.revenueDate)}  ${day(r.arrival)}  ${`${r.bankAccount}/${r.txnCode}`.slice(0, 36).padEnd(36)} ${pad(r.credit)} ${pad(r.gross ?? r.credit)}  ${`${r.operationType || "—"}/${r.categoryCode || "—"}`.slice(0, 26).padEnd(26)} ${r.qtvi.map((q) => q.code).join(",") || "—"} ${flags ? ` <${flags}>` : ""}${r.qtvi.length ? "" : ` [${r.autoProcessType || "?"}/${r.reconcileStatus}]`}`);
    }

    console.log(`[B] Phiếu rút tiền khỏi ví ghi trong kỳ (${periodTransfers.length} phiếu, về NH ${money(sum(periodTransfers, (t) => t.amount))} + phí ${money(sum(periodTransfers, (t) => t.feeAmount))}):`);
    for (const t of periodTransfers) {
      const src = walletRows.filter((r) => r.qtvi.some((q) => q.code === t.code));
      const srcInfo = src.length
        ? src.map((r) => `NNT ${day(r.sourceDate)} NDT ${day(r.revenueDate)} gross ${money(r.amount)}${inPeriod(r.reportDate) ? "" : " <NNT≠kỳ: Thu nằm kỳ khác>"}`).join(" · ")
        : "không tìm thấy dòng sao kê nối";
      console.log(`    ${t.code.padEnd(22)} ${day(t.transferDate)} NDT ${day(t.sourceReportDate)} ${t.transferPurpose.padEnd(18)} về ${pad(t.amount, 12)} phí ${pad(t.feeAmount, 10)} → ${t.toMoneySourceCode} | ${srcInfo}`);
    }

    for (const [label, list] of [["đầu kỳ", pendingStart], ["cuối kỳ", pendingEnd]]) {
      console.log(`[C] Doanh thu treo ở mốc ${label} (${list.length} dòng, ${money(sum(list))} đ):`);
      for (const r of list) console.log(`    NDT ${day(r.revenueKey)} → về ${day(r.arrival)}  ${r.txnCode.padEnd(24)} gross ${pad(r.amount)}  ${r.qtvi.map((q) => q.code).join(",") || "CHƯA QTVI"}`);
    }

    const lastDays = (settlementReport.rows || [])
      .filter((r) => r.moneySourceCode === wallet.code)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-5);
    console.log(`[D] Tiền về đủ chưa — 5 ngày cuối kỳ${settlementReport.error ? ` (lỗi: ${settlementReport.error})` : ""}:`);
    for (const r of lastDays) console.log(`    ${r.date}  doanh thu ${pad(r.revenue)}  đã về ${pad(r.received)}  còn ${pad(r.remaining)}  ${r.status}`);
  }
}

await prisma.$disconnect();
