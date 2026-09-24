/**
 * ĐỒNG BỘ GHI SỔ ĐỂ PHÍ QUYẾT TOÁN VÍ CHUYỂN SANG NGÀY DOANH THU (commit 1ee34ee, 24/09/2026).
 *
 * Code mới chỉ có hiệu lực với bút toán được ghi lại, nên sau khi deploy phải Đồng bộ ghi sổ các
 * kỳ có phiếu quyết toán ví. Script gọi ĐÚNG hàm nút "Đồng bộ ghi sổ" trên màn Sổ cái dùng
 * (syncAccountingPeriod) cho từng cửa hàng × từng kỳ, và in số trước / sau để chắc chắn:
 *
 *  - Kỳ nào đang khoá sổ (đồng bộ sẽ bỏ qua bút toán trong kỳ đó).
 *  - Phí thẻ / Grab trên sổ theo loại bút toán: MONEY_TRANSFER (cách cũ, phí ở ngày tiền về) và
 *    MONEY_TRANSFER_FEE (cách mới, phí ở ngày doanh thu). Chạy xong cột cũ phải về 0.
 *  - Phí thẻ trên sổ so với phí thẻ trên bảng Tiền về đủ chưa của cùng kỳ.
 *  - Phiếu quyết toán ví còn ghi phí kiểu cũ sau khi chạy, kèm lý do (kỳ khoá).
 *
 * Mặc định CHẠY THỬ (chỉ in số hiện tại). Ghi thật: --apply.
 *
 *   npm run sync:wallet-fee-dates
 *   npm run sync:wallet-fee-dates -- --apply
 *   npm run sync:wallet-fee-dates -- --branches NME --periods 2026-08,2026-09 --apply
 */
import { prisma } from "../lib/prisma.ts";
import { periodBounds, syncAccountingPeriod } from "../lib/accounting.ts";
import { isPeriodLocked } from "../lib/phase3.ts";
import { getRevenueSettlementReport } from "../lib/reports.ts";
import { isGrabMoneySource } from "../lib/money-sources.ts";
import { writeAuditLog, SYSTEM_ACTOR_ROLE } from "../lib/audit-log.ts";
import { WALLET_CARD_FEE_PNL_ITEM_CODE, WALLET_GRAB_EXPENSE_PNL_ITEM_CODE } from "../lib/wallet-settlement-allocation.ts";

const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : ""; };
const list = (raw, fallback) => (raw ? raw.split(",").map((v) => v.trim()).filter(Boolean) : fallback);
const branches = list(valueOf("--branches").toUpperCase(), ["NME", "ASA"]);
// Kỳ 07: phí doanh thu 31/07 tiền về đầu 08 quay về 07. Kỳ 09: phí doanh thu cuối 08 quay về 08.
const periods = list(valueOf("--periods"), ["2026-07", "2026-08", "2026-09"]);
const apply = args.includes("--apply");

const money = (v) => Math.round(v).toLocaleString("vi-VN");
const pad = (v, n = 14) => money(v).padStart(n);

/** Phí thẻ / Grab trên sổ của một cửa hàng trong kỳ, tách theo loại bút toán. */
async function ledgerFees(branchCode, period) {
  const { start, end } = periodBounds(period);
  const entries = await prisma.journalEntry.findMany({
    where: { branchCode, status: "POSTED", entryDate: { gte: start, lt: end } },
    select: { sourceType: true, lines: { where: { pnlItemCode: { in: [WALLET_CARD_FEE_PNL_ITEM_CODE, WALLET_GRAB_EXPENSE_PNL_ITEM_CODE] } }, select: { debit: true, credit: true, pnlItemCode: true } } },
  });
  const out = { oldCard: 0, newCard: 0, otherCard: 0, oldGrab: 0, newGrab: 0 };
  for (const e of entries) {
    for (const l of e.lines) {
      const amount = l.debit - l.credit;
      const card = l.pnlItemCode === WALLET_CARD_FEE_PNL_ITEM_CODE;
      if (e.sourceType === "MONEY_TRANSFER") { if (card) out.oldCard += amount; else out.oldGrab += amount; }
      else if (e.sourceType === "MONEY_TRANSFER_FEE") { if (card) out.newCard += amount; else out.newGrab += amount; }
      else if (card) out.otherCard += amount;
    }
  }
  return out;
}

async function tableFees(branchCode, period) {
  const report = await getRevenueSettlementReport(period, branchCode);
  const rows = report.rows.filter((r) => r.group === "WALLET" && r.received > 0 && r.remaining > 0);
  const grab = rows.filter((r) => isGrabMoneySource(r.moneySourceCode, r.moneySourceName)).reduce((s, r) => s + r.remaining, 0);
  return { card: rows.reduce((s, r) => s + r.remaining, 0) - grab, grab };
}

/** Phiếu quyết toán ví có phí mà bút toán tiền vẫn còn dòng 6428 (cách cũ). */
async function legacyTransfers(branchCode, period) {
  const { start, end } = periodBounds(period);
  const entries = await prisma.journalEntry.findMany({
    where: { branchCode, sourceType: "MONEY_TRANSFER", status: "POSTED", entryDate: { gte: start, lt: end }, sourceCode: { startsWith: "QTVI" } },
    select: { sourceCode: true, entryDate: true, lines: { where: { account: { code: "6428" } }, select: { debit: true } } },
  });
  return entries.filter((e) => e.lines.some((l) => l.debit > 0))
    .map((e) => ({ code: e.sourceCode, day: e.entryDate.toISOString().slice(0, 10), fee: e.lines.reduce((s, l) => s + l.debit, 0) }));
}

async function snapshot(label) {
  console.log("");
  console.log(`=== ${label}`);
  console.log("CỬA HÀNG KỲ       KHOÁ   PHÍ THẺ CŨ(ngày về)  PHÍ THẺ MỚI(ngày DT)  THẺ NGUỒN KHÁC   SỔ: TỔNG THẺ    BẢNG: PHÍ THẺ   LỆCH     | GRAB SỔ        GRAB BẢNG");
  for (const branchCode of branches) {
    for (const period of periods) {
      const locked = await isPeriodLocked(periodBounds(period).start, branchCode);
      const l = await ledgerFees(branchCode, period);
      const t = await tableFees(branchCode, period);
      const ledgerCard = l.oldCard + l.newCard + l.otherCard;
      console.log(`${branchCode.padEnd(8)} ${period}  ${(locked ? "KHOÁ" : "mở").padEnd(5)}${pad(l.oldCard, 20)}${pad(l.newCard, 22)}${pad(l.otherCard, 16)}${pad(ledgerCard, 15)}${pad(t.card, 16)}${pad(ledgerCard - t.card, 10)}  |${pad(l.oldGrab + l.newGrab, 14)}${pad(t.grab, 14)}`);
    }
  }
}

async function main() {
  console.log(`Cửa hàng: ${branches.join(", ")} · kỳ: ${periods.join(", ")} · ${apply ? "GHI THẬT" : "CHẠY THỬ"}`);
  await snapshot("HIỆN TẠI");
  if (!apply) {
    console.log("");
    console.log("Chạy thử — chưa ghi gì. Kỳ ghi KHOÁ phải mở trên màn Khoá sổ trước, không thì đồng bộ bỏ qua kỳ đó.");
    console.log("Ghi thật: thêm --apply");
    return;
  }

  console.log("");
  console.log("=== ĐỒNG BỘ GHI SỔ (cùng hàm nút trên màn Sổ cái)");
  for (const branchCode of branches) {
    for (const period of periods) {
      const result = await syncAccountingPeriod(period, branchCode, "Script đồng bộ phí ví theo ngày doanh thu");
      console.log(`  ${branchCode} ${period}: tổng ${result.total} · tạo ${result.created} · cập nhật ${result.updated} · bỏ qua ${result.skipped}`);
      await writeAuditLog({
        actorName: "scripts/dong-bo-phi-vi-theo-ngay.mjs",
        actorRole: SYSTEM_ACTOR_ROLE,
        module: "/accounting",
        action: "SYNC_PERIOD",
        entityType: "AccountingPeriod",
        entityCode: period,
        branchCode,
        message: `Script: đồng bộ ghi sổ ${period} để phí quyết toán ví ghi theo ngày doanh thu`,
        metadata: result,
      });
    }
  }

  await snapshot("SAU KHI ĐỒNG BỘ");
  console.log("");
  let leftover = 0;
  for (const branchCode of branches) {
    for (const period of periods) {
      const rows = await legacyTransfers(branchCode, period);
      if (!rows.length) continue;
      leftover += rows.length;
      const locked = await isPeriodLocked(periodBounds(period).start, branchCode);
      console.log(`CÒN GHI PHÍ KIỂU CŨ — ${branchCode} ${period}${locked ? " (kỳ KHOÁ)" : " (phiếu chạm tới một kỳ khoá khác: ngày doanh thu hoặc bút toán phí cũ)"}:`);
      for (const r of rows) console.log(`  ${r.code}  ghi sổ ${r.day}  phí ${money(r.fee)} đ`);
    }
  }
  console.log(leftover === 0
    ? "KẾT QUẢ: mọi phiếu quyết toán ví đã ghi phí theo ngày doanh thu (cột PHÍ THẺ CŨ = 0)."
    : `KẾT QUẢ: còn ${leftover} phiếu ghi phí kiểu cũ ở trên — mở kỳ khoá liên quan rồi chạy lại.`);
  console.log("Cột LỆCH còn lại = phí thẻ khác QTVI (cột THẺ NGUỒN KHÁC) + phiếu QTVI phí chưa đúng (xem npm run diagnose:wallet-fees).");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
