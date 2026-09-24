/**
 * CHẨN ĐOÁN + SỬA PHÍ QUYẾT TOÁN VÍ CỦA MỘT CỬA HÀNG TRONG KỲ.
 *
 * Hai câu hỏi phải trả lời bằng số, không đoán (khách hỏi 24/09/2026, Nam Mê tháng 8):
 *
 *  PHẦN 1 — Pivot "Chi phí quẹt thẻ" 24.232.622 đ của kế toán gồm những dòng nào?
 *    Script dựng lại đúng bảng chi tiết của tab Tổng hợp chi phí (getExpenseSummary — cùng
 *    hàm màn hình gọi), gom từng ngày theo (nguồn phát sinh · hạng mục P&L), rồi dò tổ hợp
 *    cột nào cộng ra KHỚP TỪNG NGÀY với pivot của kế toán (--pivot, mặc định là pivot Nam Mê
 *    tháng 8 gửi 24/09). Khớp đủ mọi ngày thì biết chắc pivot đã lọc những gì.
 *
 *  PHẦN 2 — Phiếu QTVI nào đang ghi phí sai, và vì sao?
 *    Với từng phiếu quyết toán ví đã nối dòng sao kê, tính lại phí theo từng ngày doanh thu
 *    bằng computeWalletGrossByDay — ĐÚNG hàm nút "Chạy lại theo doanh thu hiện tại" dùng — và
 *    in: phí đang ghi, phí đúng, doanh thu / đã quyết toán nơi khác / tiền về của từng ngày.
 *    Không tính được thì in nguyên văn lý do.
 *
 *  --apply --confirm <MÃ>: ghi lại phí cho các phiếu lệch, cùng các bước của nút Chạy lại
 *    (cập nhật gross dòng sao kê → walletFeeFields → ghi lại bút toán ngay → nhật ký SCRIPT).
 *    Bỏ qua phiếu kỳ đã khoá, phiếu không tính được, phiếu phí vượt trần (trừ khi thêm
 *    --acknowledge-high-fee sau khi đã xem số).
 *
 *   npm run diagnose:wallet-fees -- --branch NME --period 2026-08
 *   npm run diagnose:wallet-fees -- --branch NME --period 2026-08 --apply --confirm NME
 */
import { prisma } from "../lib/prisma.ts";
import { periodBounds } from "../lib/accounting.ts";
import { getExpenseSummary } from "../lib/expense-summary.ts";
import { computeWalletGrossByDay } from "../lib/wallet-settlement-by-day.ts";
import { walletFeeFields, repostWalletSettlementJournal, assertWalletCardFeeCategory } from "../lib/wallet-settlement-fee.ts";
import { checkWalletFeeRate, walletFeeRateMessage, WALLET_CARD_FEE_CATEGORY_CODE } from "../lib/wallet-settlement-allocation.ts";
import { effectiveMoneyTransferDate } from "../lib/money-transfer-date.ts";
import { isPeriodLocked } from "../lib/phase3.ts";
import { writeAuditLog, SYSTEM_ACTOR_ROLE } from "../lib/audit-log.ts";
import { vietnamBusinessDayKey } from "../lib/revenue-date.ts";

const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : ""; };
const branchCode = valueOf("--branch").trim().toUpperCase();
const period = valueOf("--period").trim();
const apply = args.includes("--apply");
const confirm = valueOf("--confirm").trim().toUpperCase();
const acknowledgeHighFee = args.includes("--acknowledge-high-fee");

const money = (v) => Math.round(v).toLocaleString("vi-VN");
const pad = (v, n) => money(v).padStart(n);

/** Pivot kế toán Nam Mê gửi 24/09/2026 (Tổng hợp chi phí → Chi phí quẹt thẻ, theo ngày). */
const DEFAULT_PIVOT = {
  "2026-08-03": 2436455, "2026-08-04": 843038, "2026-08-05": 607010, "2026-08-06": 959707, "2026-08-07": 785999,
  "2026-08-10": 2990772, "2026-08-11": 712315, "2026-08-12": 945330, "2026-08-13": 842810, "2026-08-14": 792994,
  "2026-08-17": 3288131, "2026-08-18": 722052, "2026-08-19": 682366, "2026-08-20": 857357, "2026-08-21": 984437,
  "2026-08-22": 1547246, "2026-08-24": 1747485, "2026-08-25": 499615, "2026-08-26": 600372, "2026-08-27": 934516,
  "2026-08-28": 452615,
};

/** --pivot "2026-08-03=2436455,2026-08-04=843038,..." để dò pivot khác. */
function readPivot() {
  const raw = valueOf("--pivot");
  if (!raw) return branchCode === "NME" && period === "2026-08" ? DEFAULT_PIVOT : null;
  return Object.fromEntries(raw.split(",").map((pair) => { const [d, v] = pair.split("="); return [d.trim(), Number(v)]; }));
}

async function partPivot() {
  const pivot = readPivot();
  const summary = await getExpenseSummary(period, branchCode);
  const cols = new Map(); // "nguồn · hạng mục" -> Map(day -> amount)
  for (const d of summary.details) {
    const key = `${d.sourceLabel} · ${d.itemName}`;
    const byDay = cols.get(key) || new Map();
    byDay.set(d.date, (byDay.get(d.date) || 0) + d.amount);
    cols.set(key, byDay);
  }
  // Chỉ những cột có chạm ngày nào của pivot mới đáng dò.
  const pivotDays = pivot ? Object.keys(pivot).sort() : [];
  const relevant = [...cols.entries()]
    .filter(([key]) => /quẹt thẻ|phí ví|grab|bán hàng qua app|điều tiền|quyết toán ví/i.test(key))
    .sort((a, b) => a[0].localeCompare(b[0], "vi"));

  console.log("PHẦN 1 — TỔNG HỢP CHI PHÍ: các cột liên quan phí thẻ / ví / Grab (tổng cả kỳ)");
  for (const [key, byDay] of relevant) console.log(`  ${key.padEnd(70)}${pad([...byDay.values()].reduce((s, v) => s + v, 0), 14)} đ`);
  if (!pivot) { console.log("  (không có --pivot để dò)"); return; }

  const pivotTotal = Object.values(pivot).reduce((s, v) => s + v, 0);
  console.log(`  Pivot của kế toán: ${pivotDays.length} ngày, tổng ${money(pivotTotal)} đ`);
  // Dò mọi tổ hợp cột (tối đa 12 cột = 4096 tổ hợp), chấm theo số ngày khớp tới đồng.
  const candidates = relevant.slice(0, 12);
  let best = null;
  for (let mask = 1; mask < 1 << candidates.length; mask += 1) {
    const picked = candidates.filter((_, i) => mask & (1 << i));
    const sumOf = (day) => picked.reduce((s, [, byDay]) => s + (byDay.get(day) || 0), 0);
    const allDays = new Set([...pivotDays, ...picked.flatMap(([, byDay]) => [...byDay.keys()])]);
    let hit = 0; let miss = 0;
    for (const day of allDays) { if (Math.abs(sumOf(day) - (pivot[day] || 0)) < 1) hit += 1; else miss += 1; }
    if (!best || miss < best.miss || (miss === best.miss && picked.length < best.picked.length)) best = { picked, miss, hit, sumOf, allDays };
  }
  console.log("");
  console.log(best.miss === 0
    ? "  => KHỚP TỪNG NGÀY, TỚI ĐỒNG. Pivot đã lấy đúng các cột:"
    : `  => Tổ hợp gần nhất (còn ${best.miss} ngày lệch):`);
  for (const [key] of best.picked) console.log(`       + ${key}`);
  console.log("");
  console.log("  NGÀY        PIVOT          TỔ HỢP TRÊN     LỆCH");
  for (const day of [...best.allDays].sort()) {
    const mine = best.sumOf(day); const theirs = pivot[day] || 0;
    console.log(`  ${day}  ${pad(theirs, 12)}  ${pad(mine, 14)}  ${Math.abs(mine - theirs) < 1 ? "" : pad(mine - theirs, 12)}`);
  }
}

async function partTransfers() {
  const { start, end } = periodBounds(period);
  const transfers = await prisma.moneyTransfer.findMany({
    where: { branchCode, transferPurpose: "WALLET_SETTLEMENT", status: "APPROVED", transferDate: { gte: start, lt: end } },
    orderBy: { code: "asc" },
  });
  const matches = await prisma.reconciliationMatch.findMany({
    where: { targetType: "WALLET_SETTLEMENT", targetId: { in: transfers.map((t) => t.id) }, deletedAt: null, bankTransaction: { deletedAt: null } },
    include: { bankTransaction: { include: { allocations: { orderBy: { sourceRowNumber: "asc" } } } } },
  });
  const matchOf = new Map(matches.map((m) => [m.targetId, m]));

  console.log("");
  console.log(`PHẦN 2 — ${transfers.length} PHIẾU QUYẾT TOÁN VÍ, tính lại phí theo từng ngày doanh thu (cùng hàm nút "Chạy lại")`);
  const wrong = []; const failed = []; const unlinked = [];
  for (const t of transfers) {
    const match = matchOf.get(t.id);
    const lines = (match?.bankTransaction.allocations || [])
      .filter((row) => row.creditAmount > 0 && row.revenueDate && row.operationType !== "OTHER_RECEIPT");
    if (!match || lines.length === 0) { if (t.feeAmount) unlinked.push(t); continue; }
    const computed = await computeWalletGrossByDay({
      branchCode: t.branchCode,
      walletCode: t.fromMoneySourceCode,
      lines: lines.map((row) => ({ revenueDate: row.revenueDate, netAmount: row.creditAmount })),
      excludeBankTransactionId: match.bankTransaction.id,
    });
    if (!computed.ok) { failed.push({ t, reason: computed.reason }); continue; }
    const plan = computed.plan;
    const allocationStale = lines.some((row, i) => Math.round(row.grossAmount || 0) !== plan.lineGross[i]);
    if (plan.totalFee === Math.round(t.feeAmount) && !allocationStale) continue;
    wrong.push({ t, computed, plan, lines, bank: match.bankTransaction });
  }

  const totalDelta = wrong.reduce((s, w) => s + w.plan.totalFee - Math.round(w.t.feeAmount), 0);
  console.log(`  Đúng: ${transfers.length - wrong.length - failed.length - unlinked.length} · LỆCH: ${wrong.length} (tổng chênh ${money(totalDelta)} đ) · không tính được: ${failed.length} · chưa nối sao kê: ${unlinked.length}`);
  for (const w of wrong) {
    console.log("");
    console.log(`  ${w.t.code}  ${w.computed.walletLabel}${w.computed.isGrab ? " [GRAB]" : ""}  tiền về ${vietnamBusinessDayKey(w.t.transferDate)}  sao kê ${w.bank.transactionCode}`);
    console.log(`    Phí đang ghi ${pad(w.t.feeAmount, 12)} đ  →  phí đúng ${pad(w.plan.totalFee, 12)} đ  (chênh ${money(w.plan.totalFee - w.t.feeAmount)} đ)`);
    console.log("    NGÀY DT     DOANH THU VÍ    ĐÃ QT NƠI KHÁC   GROSS NGÀY      TIỀN VỀ         PHÍ");
    for (const d of w.plan.days) {
      console.log(`    ${d.day}  ${pad(d.revenue, 14)}  ${pad(d.claimedElsewhere, 14)}  ${pad(d.grossAmount, 14)}  ${pad(d.netAmount, 14)}  ${pad(d.feeAmount, 12)}`);
    }
    console.log(`    Gross đang ghi trên dòng sao kê: ${w.lines.map((row) => `${vietnamBusinessDayKey(row.revenueDate)}=${money(row.grossAmount || 0)}`).join(", ")}`);
  }
  if (failed.length) {
    console.log("");
    console.log("  KHÔNG TÍNH ĐƯỢC (giữ nguyên, lý do nguyên văn):");
    for (const f of failed) console.log(`    ${f.t.code}  phí đang ghi ${money(f.t.feeAmount)} đ — ${f.reason}`);
  }
  if (unlinked.length) {
    console.log("");
    console.log("  CÓ PHÍ NHƯNG CHƯA NỐI DÒNG SAO KÊ (không tự tính được):");
    for (const t of unlinked) console.log(`    ${t.code}  ${t.fromMoneySourceCode}  phí ${money(t.feeAmount)} đ`);
  }
  return wrong;
}

async function applyFixes(wrong) {
  console.log("");
  console.log(`GHI THẬT: ${wrong.length} phiếu`);
  for (const w of wrong) {
    const { t, computed, plan, lines } = w;
    const nextFee = plan.totalFee;
    const grabAfter = computed.isGrab ? nextFee : 0;
    if (await isPeriodLocked(effectiveMoneyTransferDate(t), t.branchCode)) { console.log(`  BỎ QUA ${t.code}: kỳ đã khoá sổ`); continue; }
    const feeCheck = nextFee > 0 ? checkWalletFeeRate(computed.isGrab ? "GRAB" : "CARD_WALLET", plan.totalGross, plan.totalNet) : null;
    if (feeCheck && !feeCheck.ok && !acknowledgeHighFee) {
      console.log(`  BỎ QUA ${t.code}: ${walletFeeRateMessage(feeCheck, plan.totalGross, plan.totalNet)} (xem số rồi thêm --acknowledge-high-fee nếu đúng)`);
      continue;
    }
    if (nextFee - grabAfter > 0 && !t.feeCategoryCode && !(await assertWalletCardFeeCategory())) {
      console.log(`  BỎ QUA ${t.code}: thiếu khoản mục ${WALLET_CARD_FEE_CATEGORY_CODE} trong danh mục Thu/Chi`);
      continue;
    }
    const updated = await prisma.$transaction(async (tx) => {
      for (const [i, row] of lines.entries()) {
        const fee = plan.lineGross[i] - Math.round(row.creditAmount);
        await tx.bankStatementAllocation.update({
          where: { id: row.id },
          data: { grossAmount: plan.lineGross[i], grabExpenseAmount: computed.isGrab ? fee : 0, cardFeeAmount: computed.isGrab ? 0 : fee },
        });
      }
      return tx.moneyTransfer.update({ where: { id: t.id }, data: walletFeeFields(t, nextFee, grabAfter) });
    });
    const journal = await repostWalletSettlementJournal(updated, "Script chẩn đoán phí ví");
    await writeAuditLog({
      actorName: "scripts/chan-doan-phi-vi-nam-me.mjs",
      actorRole: SYSTEM_ACTOR_ROLE,
      module: "/finance-operations",
      action: "RERUN_WALLET_SETTLEMENT",
      entityType: "MoneyTransfer",
      entityId: t.id,
      entityCode: t.code,
      branchCode: t.branchCode,
      message: `Script: tính lại phí ${computed.walletLabel} theo từng ngày doanh thu ${plan.days.map((d) => d.day).join(", ")}`,
      metadata: { feeBefore: Math.round(t.feeAmount), feeAfter: nextFee, days: plan.days, journal },
    });
    console.log(`  ĐÃ SỬA ${t.code}: ${money(t.feeAmount)} → ${money(nextFee)} đ · bút toán: ${journal ?? "phiếu chưa lên sổ — bấm Đồng bộ ghi sổ"}`);
  }
}

async function main() {
  if (!branchCode || !/^\d{4}-\d{2}$/.test(period)) {
    console.error("Cách dùng: --branch <MÃ> --period YYYY-MM [--pivot d=v,...] [--apply --confirm <MÃ>] [--acknowledge-high-fee]");
    process.exit(1);
  }
  if (apply && confirm !== branchCode) { console.error(`--apply cần --confirm ${branchCode}`); process.exit(1); }
  console.log(`Cửa hàng ${branchCode} · kỳ ${period} · ${apply ? "GHI THẬT" : "CHỈ ĐỌC"}`);
  console.log("");
  await partPivot();
  const wrong = await partTransfers();
  if (!apply) {
    if (wrong.length) { console.log(""); console.log(`Chưa ghi gì. Sửa các phiếu LỆCH ở trên: thêm --apply --confirm ${branchCode}`); }
    return;
  }
  await applyFixes(wrong);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
