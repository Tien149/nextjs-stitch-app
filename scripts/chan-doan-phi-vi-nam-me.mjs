/**
 * CHẨN ĐOÁN + SỬA PHÍ QUYẾT TOÁN VÍ CỦA MỘT CỬA HÀNG TRONG KỲ.
 *
 * Hai câu hỏi phải trả lời bằng số, không đoán (khách hỏi 24/09/2026, Nam Mê tháng 8):
 *
 *  PHẦN 1 — Pivot "Chi phí quẹt thẻ" 24.232.622 đ của kế toán gồm những dòng nào?
 *    Quét MỌI dòng 6428 trên sổ của MỌI cửa hàng (kể cả dòng chưa gán hạng mục), gom theo
 *    ngày bút toán × (cửa hàng · nguồn · hạng mục), rồi dò tổ hợp cột KHỚP TỪNG NGÀY với pivot
 *    (--pivot, mặc định là pivot Nam Mê tháng 8 gửi 24/09). Bản đầu chỉ dò trong một cửa hàng
 *    và chỉ dòng đã gán hạng mục — không khớp, nên mở rộng. Không tổ hợp nào khớp nghĩa là
 *    pivot không lấy từ sổ theo ngày bút toán.
 *
 *  PHẦN 2 — Phiếu QTVI nào đang ghi phí sai, và vì sao?
 *    Với từng phiếu quyết toán ví đã nối dòng sao kê, tính lại phí theo từng ngày doanh thu
 *    bằng computeWalletGrossByDay — ĐÚNG hàm nút "Chạy lại theo doanh thu hiện tại" dùng — và
 *    in: phí đang ghi, phí đúng, doanh thu / đã quyết toán nơi khác / tiền về của từng ngày.
 *    Không tính được thì in nguyên văn lý do KÈM dữ kiện: từng dòng sao kê nối với phiếu, dòng
 *    POS / số thu ngân khai từng ngày, phí của bảng Tiền về đủ chưa cho đúng ngày + ví, và lịch
 *    sử sửa phiếu trên nhật ký thao tác. Phiếu phí đúng mà chỉ ô gross trên dòng sao kê
 *    trống/lệch làm tròn thì liệt kê riêng (không đổi chi phí, --apply không đụng).
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
import { getRevenueSettlementReport } from "../lib/reports.ts";
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

/**
 * Dò nguồn của pivot. Không giả định pivot chỉ lấy cửa hàng này hay chỉ lấy dòng đã gán hạng
 * mục: quét MỌI dòng Nợ/Có 6428 trên sổ của MỌI cửa hàng trong kỳ, gom thành cột
 * (cửa hàng · nguồn phát sinh · hạng mục P&L | "chưa gán"), xếp theo NGÀY BÚT TOÁN đúng như
 * bảng chi tiết Tổng hợp chi phí in ra, rồi dò tổ hợp cột khớp từng ngày với pivot.
 */
async function partPivot() {
  const pivot = readPivot();
  const { start, end } = periodBounds(period);
  const [entries, items] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { entryDate: { gte: start, lt: end }, status: "POSTED" },
      select: { branchCode: true, entryDate: true, sourceType: true, lines: { where: { account: { code: { startsWith: "6428" } } }, select: { debit: true, credit: true, pnlItemCode: true } } },
    }),
    prisma.masterDataItem.findMany({ where: { type: "PNL_ITEM" }, select: { code: true, name: true } }),
  ]);
  const itemName = new Map(items.map((i) => [i.code, i.name]));
  const cols = new Map();
  for (const e of entries) {
    for (const l of e.lines) {
      const amount = l.debit - l.credit;
      if (!amount) continue;
      const key = `${e.branchCode} · ${e.sourceType} · ${l.pnlItemCode ? itemName.get(l.pnlItemCode) || l.pnlItemCode : "(chưa gán hạng mục)"}`;
      const byDay = cols.get(key) || new Map();
      const day = e.entryDate.toISOString().slice(0, 10); // đúng cách bảng chi tiết Tổng hợp chi phí in ngày
      byDay.set(day, (byDay.get(day) || 0) + amount);
      cols.set(key, byDay);
    }
  }
  const total = (byDay) => [...byDay.values()].reduce((s, v) => s + v, 0);
  const all = [...cols.entries()].sort((a, b) => Math.abs(total(b[1])) - Math.abs(total(a[1])));
  console.log("PHẦN 1 — MỌI DÒNG 6428 TRÊN SỔ KỲ NÀY, MỌI CỬA HÀNG (cửa hàng · nguồn · hạng mục)");
  for (const [key, byDay] of all) console.log(`  ${key.padEnd(78)}${pad(total(byDay), 14)} đ`);
  if (!pivot) { console.log("  (không có --pivot để dò)"); return; }

  const pivotDays = Object.keys(pivot).sort();
  console.log(`  Pivot của kế toán: ${pivotDays.length} ngày, tổng ${money(Object.values(pivot).reduce((s, v) => s + v, 0))} đ`);
  // Chỉ dò cột chạm ít nhất một ngày của pivot và không ngày nào vượt số pivot của ngày đó (cột
  // lương, thuê nhà... tự loại). Tối đa 16 cột (65.536 tổ hợp).
  const candidates = all
    .filter(([, byDay]) => pivotDays.some((d) => byDay.has(d)) && pivotDays.every((d) => (byDay.get(d) || 0) <= pivot[d] + 1))
    .slice(0, 16);
  console.log(`  Cột có thể nằm trong pivot (${candidates.length}): ${candidates.map(([k]) => k).join(" | ") || "không có"}`);
  let best = null;
  for (let mask = 1; mask < 1 << candidates.length; mask += 1) {
    const picked = candidates.filter((_, i) => mask & (1 << i));
    const sumOf = (day) => picked.reduce((s, [, byDay]) => s + (byDay.get(day) || 0), 0);
    let miss = 0;
    for (const day of pivotDays) if (Math.abs(sumOf(day) - pivot[day]) >= 1) miss += 1;
    if (!best || miss < best.miss || (miss === best.miss && picked.length < best.picked.length)) best = { picked, miss, sumOf };
  }
  console.log("");
  console.log(best.miss === 0
    ? `  => KHỚP CẢ ${pivotDays.length} NGÀY, TỚI ĐỒNG. Pivot = tổng các cột:`
    : `  => KHÔNG tổ hợp nào khớp đủ. Gần nhất còn ${best.miss}/${pivotDays.length} ngày lệch — pivot KHÔNG lấy từ sổ theo ngày bút toán:`);
  for (const [key] of best.picked) console.log(`       + ${key}`);
  console.log("");
  console.log("  NGÀY        PIVOT          TỔ HỢP TRÊN     LỆCH");
  for (const day of pivotDays) {
    const mine = best.sumOf(day);
    console.log(`  ${day}  ${pad(pivot[day], 12)}  ${pad(mine, 14)}  ${Math.abs(mine - pivot[day]) < 1 ? "" : pad(mine - pivot[day], 12)}`);
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
    if (!computed.ok) { failed.push({ t, reason: computed.reason, lines }); continue; }
    const plan = computed.plan;
    const allocationStale = lines.some((row, i) => Math.round(row.grossAmount || 0) !== plan.lineGross[i]);
    if (plan.totalFee === Math.round(t.feeAmount) && !allocationStale) continue;
    wrong.push({ t, computed, plan, lines, bank: match.bankTransaction });
  }

  // Phí đúng rồi, chỉ ô gross trên dòng sao kê trống / lệch làm tròn: không đổi chi phí đồng nào.
  const feeWrong = wrong.filter((w) => w.plan.totalFee !== Math.round(w.t.feeAmount));
  const grossOnly = wrong.filter((w) => w.plan.totalFee === Math.round(w.t.feeAmount));
  const totalDelta = feeWrong.reduce((s, w) => s + w.plan.totalFee - Math.round(w.t.feeAmount), 0);
  console.log(`  Phí đúng: ${transfers.length - feeWrong.length - failed.length - unlinked.length} · PHÍ SAI: ${feeWrong.length} (tổng chênh ${money(totalDelta)} đ) · không tính được: ${failed.length} · chưa nối sao kê: ${unlinked.length}`);
  if (grossOnly.length) console.log(`  (${grossOnly.length} phiếu phí đúng nhưng ô gross trên dòng sao kê trống/lệch làm tròn — không ảnh hưởng chi phí: ${grossOnly.map((w) => w.t.code).join(", ")})`);
  for (const w of feeWrong) {
    console.log("");
    console.log(`  ${w.t.code}  ${w.computed.walletLabel}${w.computed.isGrab ? " [GRAB]" : ""}  tiền về ${vietnamBusinessDayKey(w.t.transferDate)}  sao kê ${w.bank.transactionCode}`);
    console.log(`    Phí đang ghi ${pad(w.t.feeAmount, 12)} đ  →  phí đúng ${pad(w.plan.totalFee, 12)} đ  (chênh ${money(w.plan.totalFee - w.t.feeAmount)} đ)`);
    console.log("    NGÀY DT     DOANH THU VÍ    ĐÃ QT NƠI KHÁC   GROSS NGÀY      TIỀN VỀ         PHÍ");
    for (const d of w.plan.days) {
      console.log(`    ${d.day}  ${pad(d.revenue, 14)}  ${pad(d.claimedElsewhere, 14)}  ${pad(d.grossAmount, 14)}  ${pad(d.netAmount, 14)}  ${pad(d.feeAmount, 12)}`);
    }
  }
  for (const f of failed) await explainFailed(f);
  if (unlinked.length) {
    console.log("");
    console.log("  CÓ PHÍ NHƯNG CHƯA NỐI DÒNG SAO KÊ (không tự tính được):");
    for (const t of unlinked) console.log(`    ${t.code}  ${t.fromMoneySourceCode}  phí ${money(t.feeAmount)} đ`);
  }
  return feeWrong;
}

const reportCache = new Map();
async function reportOf(p) {
  if (!reportCache.has(p)) reportCache.set(p, await getRevenueSettlementReport(p, branchCode));
  return reportCache.get(p);
}

/**
 * Phiếu không tính lại được: in đủ dữ kiện để biết CHẮC vì sao phí đang là con số đó, thay vì
 * suy luận. Gồm từng dòng sao kê nối với phiếu, dữ liệu doanh thu từng ngày (POS / thu ngân
 * khai), số của bảng Tiền về đủ chưa cho đúng ngày + ví, và lịch sử sửa phiếu.
 */
async function explainFailed({ t, reason, lines }) {
  console.log("");
  console.log(`  KHÔNG TÍNH ĐƯỢC ${t.code}  ${t.fromMoneySourceCode}  tiền về ${vietnamBusinessDayKey(t.transferDate)}  phí đang ghi ${money(t.feeAmount)} đ (Grab ${money(t.grabExpenseAmount)} đ)`);
  console.log(`    Lý do: ${reason}`);
  console.log(`    Ngày doanh thu ghi trên phiếu (sourceReportDate): ${t.sourceReportDate ? vietnamBusinessDayKey(t.sourceReportDate) : "(trống)"} · tạo ${t.createdAt.toISOString()} · sửa lần cuối ${t.updatedAt.toISOString()}`);
  console.log("    NGÀY DT     TIỀN VỀ (sao kê)  GROSS TRÊN DÒNG  | DÒNG POS  DT POS CỦA VÍ (bảng)  THU NGÂN KHAI thẻ/Grab | BẢNG: PHÍ");
  let tableSum = 0; const missing = [];
  for (const row of lines) {
    const day = vietnamBusinessDayKey(row.revenueDate);
    const [dayStart, dayEnd] = [new Date(`${day}T00:00:00.000Z`), new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000)];
    const [posCount, manual] = await Promise.all([
      prisma.revenueImportRow.count({ where: { branchCode, saleDate: { gte: new Date(dayStart.getTime() - 7 * 3_600_000), lt: dayEnd } } }),
      prisma.manualRevenueEntry.findMany({ where: { branchCode, reportDate: { gte: new Date(dayStart.getTime() - 7 * 3_600_000), lt: dayEnd } }, select: { cardAmount: true, grabAmount: true } }),
    ]);
    const report = await reportOf(day.slice(0, 7));
    const cell = report.rows.find((r) => r.date === day && r.moneySourceCode === t.fromMoneySourceCode);
    const fee = cell && cell.revenue > 0 ? cell.revenue - cell.received - cell.writtenOff : null;
    if (fee === null) missing.push(day); else tableSum += fee;
    const manualText = manual.length ? `${money(manual.reduce((s, m) => s + m.cardAmount, 0))}/${money(manual.reduce((s, m) => s + m.grabAmount, 0))}` : "—";
    console.log(`    ${day}  ${pad(row.creditAmount, 16)}  ${pad(row.grossAmount || 0, 15)}  | ${String(posCount).padStart(8)}  ${pad(cell?.revenue || 0, 21)}  ${manualText.padStart(22)} | ${fee === null ? "không có DT" : pad(fee, 10)}`);
  }
  console.log(`    => Theo bảng Tiền về đủ chưa, phí các ngày có doanh thu cộng lại: ${money(tableSum)} đ${missing.length ? ` · ngày KHÔNG có doanh thu POS: ${missing.join(", ")}` : ""}`);
  const logs = await prisma.auditLog.findMany({ where: { entityId: t.id }, orderBy: { occurredAt: "asc" }, select: { occurredAt: true, actorName: true, action: true, message: true } });
  console.log(`    Lịch sử trên nhật ký thao tác (${logs.length}):`);
  for (const l of logs) console.log(`      ${l.occurredAt.toISOString()}  ${l.action}  ${l.actorName || ""}  ${l.message || ""}`);
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
