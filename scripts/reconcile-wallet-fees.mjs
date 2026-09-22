/**
 * ĐƯA PHÍ VÍ / PHÍ THẺ TRÊN SỔ VỀ ĐÚNG BẢNG "TIỀN VỀ ĐỦ CHƯA".
 *
 * BỐI CẢNH (22/09/2026). Kế toán chốt tháng 8 theo bảng "Tiền về đủ chưa": phí ví = doanh thu
 * POS − tiền thực về ngân hàng, tách Grab / thẻ theo nguồn tiền. Số đó dựa trên sao kê nên là
 * số chị tin: Nam Mê thẻ 16.705.348 · Grab 9.906.037; Asa thẻ 13.468.957 · Grab 601.078.
 *
 * Sổ cái lại ghi phí từ hai đường khác — phí trên phiếu quyết toán ví (QTVI) và cột phí trên
 * file doanh thu POS — nên lệch cả hai chiều: Nam Mê thiếu ~9,1tr (QTVI ghi thiếu phí), Asa
 * thừa ~84tr (file POS khai phí sai). Script này đối chiếu TỪNG NGÀY + TỪNG NGUỒN VÍ giữa hai
 * bên, in bảng chênh để kế toán duyệt, rồi (khi --apply) ghi lại phí trên đúng phiếu QTVI của
 * ngày đó để tổng trên sổ bằng đúng bảng đối chiếu.
 *
 * Luật:
 *  - Chỉ dòng ví ĐÃ CÓ TIỀN VỀ (received > 0). Dòng chưa về đồng nào là tiền chưa thu, không
 *    phải phí — liệt kê riêng, không ghi.
 *  - Phí kỳ vọng = `remaining` của bảng (đã trừ phần kế toán tự đưa vào chi phí trước đó).
 *    Về dư (remaining < 0) không phải phí — liệt kê riêng.
 *  - Ghi lên phiếu QTVI cùng ngày doanh thu + cùng nguồn ví. Nhiều phiếu thì chia theo tỷ
 *    trọng tiền về. Không có phiếu nào thì KHÔNG tự tạo — liệt kê để xử tay.
 *  - --clear-pos-fee: đặt cột phí cà thẻ / phí app trên file POS của kỳ về 0. Chỉ dùng khi kế
 *    toán xác nhận cột đó sai (Asa tháng 8). Sau đó phí chỉ còn một đường là QTVI.
 *  - Không đụng bút toán: chạy xong PHẢI bấm Đồng bộ ghi sổ kỳ đó.
 *
 * Mặc định CHẠY THỬ. Ghi thật cần --apply --confirm <MÃ CỬA HÀNG>.
 *
 *   NODE_ENV=production node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs \
 *     scripts/reconcile-wallet-fees.mjs --branch ASA --period 2026-08
 *   ... --branch ASA --period 2026-08 --clear-pos-fee --apply --confirm ASA
 */
import { getRevenueSettlementReport } from "../lib/reports.ts";
import { prisma } from "../lib/prisma.ts";
import { WALLET_CARD_FEE_CATEGORY_CODE, WALLET_GRAB_EXPENSE_CATEGORY_CODE } from "../lib/wallet-settlement-allocation.ts";

const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : ""; };
const branchCode = valueOf("--branch").trim().toUpperCase();
const period = valueOf("--period").trim();
const apply = args.includes("--apply");
const confirm = valueOf("--confirm").trim().toUpperCase();
const clearPosFee = args.includes("--clear-pos-fee");

const money = (v) => Math.round(v).toLocaleString("vi-VN");
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const nextMonth = (p) => { const [y, m] = p.split("-").map(Number); return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)); };

/** Chia một số nguyên theo tỷ trọng, giữ tổng chính xác tới đồng. */
function allocate(total, weights) {
  const t = Math.round(total);
  const w = weights.map((x) => Math.max(0, Math.round(x)));
  const sum = w.reduce((a, b) => a + b, 0);
  if (t === 0 || sum === 0) return w.map((_, i) => (i === 0 ? t : 0));
  const exact = w.map((x) => (t * x) / sum);
  const out = exact.map(Math.floor);
  let rem = t - out.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rem > 0; k += 1, rem -= 1) out[order[k % order.length].i] += 1;
  return out;
}

async function main() {
  if (!branchCode || !/^\d{4}-\d{2}$/.test(period)) {
    console.error("Cách dùng: --branch <MÃ> --period YYYY-MM [--clear-pos-fee] [--apply --confirm <MÃ>]");
    process.exit(1);
  }
  if (apply && confirm !== branchCode) {
    console.error(`Chế độ --apply yêu cầu --confirm ${branchCode}`);
    process.exit(1);
  }
  const start = new Date(`${period}-01T00:00:00.000Z`);
  const end = nextMonth(period);

  // Kỳ đã khoá sổ thì tuyệt đối không đụng.
  const locked = await prisma.accountingPeriod.findFirst({ where: { period, branchCode, status: { not: "OPEN" } } });
  if (locked) { console.error(`Kỳ ${period} của ${branchCode} đã khoá sổ (${locked.status}). Mở kỳ rồi chạy lại.`); process.exit(1); }

  const report = await getRevenueSettlementReport(period, branchCode);
  const walletRows = report.rows.filter((r) => r.group === "WALLET" && r.branchCode === branchCode);

  const transfers = await prisma.moneyTransfer.findMany({
    where: { branchCode, transferPurpose: "WALLET_SETTLEMENT", status: "APPROVED", deletedAt: null,
      OR: [{ sourceReportDate: { gte: start, lt: end } }, { sourceReportDate: null, transferDate: { gte: start, lt: end } }] },
    select: { id: true, code: true, amount: true, feeAmount: true, grabExpenseAmount: true, feeCategoryCode: true, grabExpenseCategoryCode: true, fromMoneySourceCode: true, transferDate: true, sourceReportDate: true },
  });
  const byKey = new Map();
  for (const t of transfers) {
    const key = `${dayOf(t.sourceReportDate || t.transferDate)}|${t.fromMoneySourceCode}`;
    byKey.set(key, [...(byKey.get(key) || []), t]);
  }

  const posFee = await prisma.revenueImportRow.aggregate({
    where: { branchCode, saleDate: { gte: start, lt: end }, deletedAt: null },
    _sum: { cardFeeAmount: true, appFeeAmount: true },
  });
  const posCard = posFee._sum.cardFeeAmount || 0;
  const posApp = posFee._sum.appFeeAmount || 0;

  const plan = []; const waiting = []; const over = []; const noTransfer = []; const unseen = [];
  const touched = new Set();
  for (const r of walletRows) {
    const isGrab = r.feeCategoryCode === WALLET_GRAB_EXPENSE_CATEGORY_CODE;
    const key = `${r.date}|${r.moneySourceCode}`;
    const docs = byKey.get(key) || [];
    docs.forEach((d) => touched.add(d.id));
    const recorded = docs.reduce((s, d) => s + d.feeAmount, 0);
    if (r.received <= 0) {
      // Bảng bảo chưa về đồng nào mà ngày đó ĐÃ CÓ phiếu QTVI: sao kê chưa gắn ngày doanh thu
      // nên bảng không thấy tiền. Không được lặng lẽ giữ phí cũ — liệt kê để kiểm tay.
      if (docs.length > 0) unseen.push({ ...r, recorded, docs }); else waiting.push({ ...r, recorded });
      continue;
    }
    if (r.remaining < 0) { over.push({ ...r, recorded }); continue; }
    const expected = Math.round(r.remaining);
    if (docs.length === 0) { if (expected > 0) noTransfer.push({ ...r, expected }); continue; }
    if (expected === Math.round(recorded)) continue;
    plan.push({ row: r, docs, expected, recorded, isGrab });
  }
  // Phiếu QTVI có phí nhưng ngày đó không có dòng nào trên bảng (không có doanh thu POS ghi nhận).
  const orphanFee = transfers.filter((t) => !touched.has(t.id) && t.feeAmount > 0);

  const expectedGrab = walletRows.filter((r) => r.received > 0 && r.remaining > 0 && r.feeCategoryCode === WALLET_GRAB_EXPENSE_CATEGORY_CODE).reduce((s, r) => s + r.remaining, 0);
  const expectedCard = walletRows.filter((r) => r.received > 0 && r.remaining > 0 && r.feeCategoryCode !== WALLET_GRAB_EXPENSE_CATEGORY_CODE).reduce((s, r) => s + r.remaining, 0);
  const recordedGrab = transfers.reduce((s, t) => s + t.grabExpenseAmount, 0);
  const recordedCard = transfers.reduce((s, t) => s + (t.feeAmount - t.grabExpenseAmount), 0);

  console.log(`Cửa hàng ${branchCode} · kỳ ${period} · ${apply ? "GHI THẬT" : "CHẠY THỬ"}`);
  console.log("");
  console.log("TỔNG PHÍ                       THEO BẢNG TIỀN VỀ ĐỦ CHƯA     ĐANG GHI TRÊN QTVI     PHÍ TRÊN FILE POS");
  console.log(`  Phí Grab / bán hàng qua app   ${money(expectedGrab).padStart(16)} đ     ${money(recordedGrab).padStart(14)} đ     ${money(posApp).padStart(14)} đ`);
  console.log(`  Phí quẹt thẻ / ví khác        ${money(expectedCard).padStart(16)} đ     ${money(recordedCard).padStart(14)} đ     ${money(posCard).padStart(14)} đ`);
  console.log("");
  if (posCard + posApp > 0) {
    console.log(clearPosFee
      ? `Cột phí trên file POS (${money(posCard + posApp)} đ) SẼ ĐƯỢC ĐẶT VỀ 0 (--clear-pos-fee) — phí chỉ còn một đường là QTVI.`
      : `CHÚ Ý: file POS đang khai ${money(posCard + posApp)} đ phí. Không có --clear-pos-fee thì phần này VẪN cộng thêm vào P&L ngoài phí QTVI.`);
    console.log("");
  }

  console.log(`DÒNG CẦN SỬA PHÍ TRÊN QTVI: ${plan.length}`);
  if (plan.length) {
    console.log("NGÀY        NGUỒN VÍ          LOẠI   TIỀN VỀ         PHÍ KỲ VỌNG     ĐANG GHI        CHÊNH           PHIẾU");
    for (const p of plan) {
      console.log(`${p.row.date}  ${p.row.moneySourceCode.padEnd(17)} ${(p.isGrab ? "Grab" : "Thẻ").padEnd(6)} ${money(p.row.received).padStart(14)}  ${money(p.expected).padStart(14)}  ${money(p.recorded).padStart(14)}  ${money(p.expected - p.recorded).padStart(14)}  ${p.docs.map((d) => d.code).join(",")}`);
    }
  }
  if (noTransfer.length) {
    console.log("");
    console.log(`KHÔNG CÓ PHIẾU QTVI ĐỂ GHI (xử tay — tiền đã về nhưng chưa quyết toán ví): ${noTransfer.length} dòng, ${money(noTransfer.reduce((s, r) => s + r.expected, 0))} đ`);
    for (const r of noTransfer) console.log(`  ${r.date}  ${r.moneySourceCode.padEnd(17)} tiền về ${money(r.received)} đ · phí ${money(r.expected)} đ`);
  }
  if (orphanFee.length) {
    console.log("");
    console.log(`PHIẾU QTVI CÓ PHÍ NHƯNG NGÀY ĐÓ KHÔNG CÓ DOANH THU POS (giữ nguyên, kiểm tay): ${orphanFee.length}`);
    for (const t of orphanFee) console.log(`  ${t.code}  ${dayOf(t.sourceReportDate || t.transferDate)}  ${t.fromMoneySourceCode}  phí ${money(t.feeAmount)} đ`);
  }
  if (unseen.length) {
    console.log("");
    console.log(`BẢNG CHƯA THẤY TIỀN VỀ NHƯNG ĐÃ CÓ PHIẾU QTVI (sao kê chưa gắn Ngày doanh thu — giữ nguyên phí, kiểm tay): ${unseen.length}`);
    for (const r of unseen) console.log(`  ${r.date}  ${r.moneySourceCode.padEnd(17)} doanh thu ${money(r.revenue)} đ · phí đang ghi ${money(r.recorded)} đ · ${r.docs.map((d) => d.code).join(",")}`);
  }
  if (waiting.length) {
    console.log("");
    console.log(`TIỀN CHƯA VỀ (không phải phí, không ghi): ${waiting.length} dòng, ${money(waiting.reduce((s, r) => s + r.revenue, 0))} đ doanh thu`);
  }
  if (over.length) {
    console.log("");
    console.log(`VỀ DƯ (không phải phí, không ghi): ${over.length} dòng`);
    for (const r of over) console.log(`  ${r.date}  ${r.moneySourceCode.padEnd(17)} dư ${money(-r.remaining)} đ`);
  }

  // Phí trên phiếu mà script GIỮ NGUYÊN (bảng không thấy / không có doanh thu POS) vẫn nằm trên
  // P&L sau khi chạy — phải cộng vào dự báo, nếu không kế toán so với số của mình thấy lệch.
  const kept = [...orphanFee, ...unseen.flatMap((r) => r.docs)];
  const keptGrab = kept.reduce((s, t) => s + t.grabExpenseAmount, 0);
  const keptCard = kept.reduce((s, t) => s + (t.feeAmount - t.grabExpenseAmount), 0);
  const afterGrab = expectedGrab + keptGrab + (clearPosFee ? 0 : posApp);
  const afterCard = expectedCard + keptCard + (clearPosFee ? 0 : posCard);
  console.log("");
  console.log("SAU KHI GHI VÀ ĐỒNG BỘ GHI SỔ, P&L SẼ CÓ:");
  console.log(`  Phí Grab / bán hàng qua app   ${money(afterGrab).padStart(16)} đ`);
  console.log(`  Phí quẹt thẻ / ví khác        ${money(afterCard).padStart(16)} đ`);
  if (kept.length) console.log(`  (đã gồm ${money(keptGrab + keptCard)} đ phí giữ nguyên trên ${kept.length} phiếu cần kiểm tay ở trên)`);
  if (noTransfer.length) console.log(`  (chưa gồm ${money(noTransfer.reduce((s, r) => s + r.expected, 0))} đ của các dòng không có phiếu QTVI)`);

  if (!apply) { console.log(""); console.log("Chạy thử — chưa ghi gì. Thêm --apply --confirm " + branchCode + " để ghi thật."); return; }

  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const p of plan) {
      const parts = allocate(p.expected, p.docs.map((d) => d.amount));
      for (let i = 0; i < p.docs.length; i += 1) {
        const d = p.docs[i]; const fee = parts[i];
        await tx.moneyTransfer.update({ where: { id: d.id }, data: {
          feeAmount: fee,
          grabExpenseAmount: p.isGrab ? fee : 0,
          grabExpenseCategoryCode: p.isGrab && fee > 0 ? (d.grabExpenseCategoryCode || WALLET_GRAB_EXPENSE_CATEGORY_CODE) : null,
          feeCategoryCode: !p.isGrab && fee > 0 ? (d.feeCategoryCode || WALLET_CARD_FEE_CATEGORY_CODE) : null,
        } });
        updated += 1;
      }
    }
    if (clearPosFee) {
      const res = await tx.revenueImportRow.updateMany({ where: { branchCode, saleDate: { gte: start, lt: end }, deletedAt: null, OR: [{ cardFeeAmount: { gt: 0 } }, { appFeeAmount: { gt: 0 } }] }, data: { cardFeeAmount: 0, appFeeAmount: 0 } });
      console.log(`Đã đặt phí về 0 trên ${res.count} dòng doanh thu POS.`);
    }
  });
  console.log(`Đã ghi lại phí trên ${updated} phiếu QTVI.`);
  console.log(`VIỆC TIẾP THEO: Sổ cái Kế toán → kỳ ${period} → cửa hàng ${branchCode} → Đồng bộ ghi sổ.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
