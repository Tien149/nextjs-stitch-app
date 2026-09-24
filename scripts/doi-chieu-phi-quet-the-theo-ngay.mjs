/**
 * VÌ SAO "TỔNG HỢP CHI PHÍ → CHI PHÍ QUẸT THẺ" KHÁC TAB "TIỀN VỀ ĐỦ CHƯA" — theo từng ngày.
 *
 * BỐI CẢNH (24/09/2026). Kế toán Nam Mê kéo bảng chi tiết dòng "Chi phí quẹt thẻ" trên Tổng hợp
 * chi phí, pivot theo ngày, đặt cạnh cột chênh lệch của Tiền về đủ chưa: tháng 8 ra 24.232.622 đ
 * so với 14.589.504 đ, và từng ngày lệch nhau kiểu "trượt một ngày". Hai bảng đọc hai thứ khác
 * nhau:
 *
 *  - Tổng hợp chi phí đọc SỔ NHẬT KÝ: mọi dòng Nợ 6428 mang hạng mục PNL_CP_QUETTHE, xếp theo
 *    NGÀY BÚT TOÁN. Phí ví đi vào qua phiếu quyết toán ví (QTVI) và phiếu đó ghi sổ theo NGÀY
 *    TIỀN VỀ (transferDate), không phải ngày doanh thu — doanh thu 21/08 tiền về 22/08 thì phí
 *    nằm ở 22/08, doanh thu T6-T7-CN về gộp thứ Hai thì cả ba ngày phí dồn vào thứ Hai.
 *  - Tiền về đủ chưa xếp theo NGÀY DOANH THU, phí = doanh thu POS của ví − tiền thực về, chỉ tính
 *    dòng ví đã có tiền về. Không đọc sổ.
 *
 * Script này dựng lại CẢ HAI con số rồi quy phí trên sổ về đúng ngày doanh thu + ví (qua dòng sao
 * kê nối với phiếu QTVI), để tách chênh lệch thành từng rổ có tên. CHỈ ĐỌC, không sửa gì.
 *
 *   NODE_ENV=production node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs \
 *     scripts/doi-chieu-phi-quet-the-theo-ngay.mjs --branch NME --period 2026-08
 */
import { getRevenueSettlementReport } from "../lib/reports.ts";
import { prisma } from "../lib/prisma.ts";
import { periodBounds } from "../lib/accounting.ts";
import { isGrabMoneySource } from "../lib/money-sources.ts";
import { vietnamBusinessDayKey } from "../lib/revenue-date.ts";
import { WALLET_CARD_FEE_PNL_ITEM_CODE, WALLET_GRAB_EXPENSE_PNL_ITEM_CODE } from "../lib/wallet-settlement-allocation.ts";

const args = process.argv.slice(2);
const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] || "") : ""; };
const branchCode = valueOf("--branch").trim().toUpperCase();
const period = valueOf("--period").trim();

const money = (v) => Math.round(v).toLocaleString("vi-VN");
const pad = (v, n) => money(v).padStart(n);
const add = (map, key, v) => map.set(key, (map.get(key) || 0) + v);

async function main() {
  if (!branchCode || !/^\d{4}-\d{2}$/.test(period)) {
    console.error("Cách dùng: --branch <MÃ CỬA HÀNG> --period YYYY-MM");
    process.exit(1);
  }
  const { start, end } = periodBounds(period);
  const inPeriod = (day) => day >= period && day < `${period}-99`;

  // ---------- Vế 1: đúng như Tổng hợp chi phí ----------
  const entries = await prisma.journalEntry.findMany({
    where: { entryDate: { gte: start, lt: end }, status: "POSTED", branchCode },
    select: {
      entryDate: true, sourceType: true, sourceId: true, sourceCode: true,
      lines: {
        where: { pnlItemCode: { in: [WALLET_CARD_FEE_PNL_ITEM_CODE, WALLET_GRAB_EXPENSE_PNL_ITEM_CODE] } },
        select: { debit: true, credit: true, pnlItemCode: true, account: { select: { accountType: true } } },
      },
    },
  });
  const ledgerCardByDay = new Map();
  const ledgerCardBySource = new Map();
  let ledgerGrab = 0;
  /** Phí trên sổ của từng phiếu QTVI, tách thẻ / Grab — để quy về ngày doanh thu ở dưới. */
  const transferFee = new Map();
  const feeByDay = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!["COGS", "OPEX", "OTHER_EXPENSE"].includes(line.account.accountType)) continue;
      const amount = line.debit - line.credit;
      if (!amount) continue;
      const isCard = line.pnlItemCode === WALLET_CARD_FEE_PNL_ITEM_CODE;
      if (isCard) {
        add(ledgerCardByDay, entry.entryDate.toISOString().slice(0, 10), amount);
        add(ledgerCardBySource, entry.sourceType, amount);
      } else ledgerGrab += amount;
      // Từ 24/09/2026 vế phí ghi riêng theo từng ngày doanh thu, mã nguồn "<id phiếu>:<ngày>".
      if (entry.sourceType === "MONEY_TRANSFER_FEE") {
        const [transferId, day] = entry.sourceId.split(":");
        feeByDay.push({ transferId, day, code: entry.sourceCode, entryDay: entry.entryDate.toISOString().slice(0, 10), card: isCard ? amount : 0, grab: isCard ? 0 : amount });
      } else if (entry.sourceType === "MONEY_TRANSFER") {
        const cur = transferFee.get(entry.sourceId) || { code: entry.sourceCode, entryDay: entry.entryDate.toISOString().slice(0, 10), card: 0, grab: 0 };
        if (isCard) cur.card += amount; else cur.grab += amount;
        transferFee.set(entry.sourceId, cur);
      }
    }
  }
  const ledgerCard = [...ledgerCardByDay.values()].reduce((s, v) => s + v, 0);

  // ---------- Vế 2: đúng như Tiền về đủ chưa ----------
  const report = await getRevenueSettlementReport(period, branchCode);
  const tableFee = new Map(); // `${day}|${source}` -> { fee, isGrab, name }
  for (const row of report.rows) {
    if (row.group !== "WALLET" || row.received <= 0 || row.remaining <= 0) continue;
    tableFee.set(`${row.date}|${row.moneySourceCode}`, { fee: row.remaining, isGrab: isGrabMoneySource(row.moneySourceCode, row.moneySourceName), name: row.moneySourceName, writtenOff: row.writtenOff });
  }
  const tableIn = [...tableFee.entries()];
  const tableCard = tableIn.filter(([, v]) => !v.isGrab).reduce((s, [, v]) => s + v.fee, 0);
  const tableGrab = tableIn.filter(([, v]) => v.isGrab).reduce((s, [, v]) => s + v.fee, 0);
  const writtenOffCard = report.rows.filter((r) => r.group === "WALLET" && !isGrabMoneySource(r.moneySourceCode, r.moneySourceName)).reduce((s, r) => s + r.writtenOff, 0);

  // ---------- Quy phí trên sổ của từng QTVI về ngày doanh thu + ví ----------
  const ids = [...new Set([...transferFee.keys(), ...feeByDay.map((f) => f.transferId)])];
  const [transfers, matches, sources] = await Promise.all([
    prisma.moneyTransfer.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, fromMoneySourceCode: true, transferDate: true, sourceReportDate: true } }),
    prisma.reconciliationMatch.findMany({
      where: { targetType: "WALLET_SETTLEMENT", targetId: { in: ids }, deletedAt: null },
      select: { targetId: true, bankTransaction: { select: { deletedAt: true, allocations: { select: { revenueDate: true, creditAmount: true, grossAmount: true, decreaseMoneySourceCode: true } } } } },
    }),
    prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE" }, select: { code: true, name: true } }),
  ]);
  const sourceName = new Map(sources.map((s) => [s.code, s.name]));
  const allocsOf = new Map();
  for (const m of matches) {
    if (m.bankTransaction.deletedAt) continue;
    allocsOf.set(m.targetId, [...(allocsOf.get(m.targetId) || []), ...m.bankTransaction.allocations]);
  }
  const ledgerByKey = new Map(); // `${day}|${source}` -> { card, grab, codes:Set, entryDays:Set }
  const noRevenueDay = [];
  const sourceOfTransfer = new Map(transfers.map((t) => [t.id, t.fromMoneySourceCode]));
  // Bút toán phí đã mang sẵn ngày doanh thu: không phải đoán tỷ trọng.
  for (const f of feeByDay) {
    const key = `${f.day}|${sourceOfTransfer.get(f.transferId) || "?"}`;
    const cur = ledgerByKey.get(key) || { card: 0, grab: 0, codes: new Set(), entryDays: new Set() };
    cur.card += f.card; cur.grab += f.grab; cur.codes.add(f.code); cur.entryDays.add(f.entryDay);
    ledgerByKey.set(key, cur);
  }
  for (const t of transfers) {
    const fee = transferFee.get(t.id);
    if (!fee) continue;
    const allocs = (allocsOf.get(t.id) || []).filter((a) => a.revenueDate && a.creditAmount > 0 && (!a.decreaseMoneySourceCode || a.decreaseMoneySourceCode === t.fromMoneySourceCode));
    // Trọng số từng ngày = phí của dòng sao kê ngày đó (gross − thực về); không có gross thì theo tiền về.
    let parts = allocs.map((a) => ({ day: vietnamBusinessDayKey(a.revenueDate), w: a.grossAmount != null ? Math.max(0, a.grossAmount - a.creditAmount) : 0, net: a.creditAmount }));
    if (parts.length && parts.every((p) => p.w === 0)) parts = parts.map((p) => ({ ...p, w: p.net }));
    if (!parts.length) {
      const day = t.sourceReportDate ? vietnamBusinessDayKey(t.sourceReportDate) : null;
      if (!day) { noRevenueDay.push({ ...fee, source: t.fromMoneySourceCode }); continue; }
      parts = [{ day, w: 1 }];
    }
    const totalW = parts.reduce((s, p) => s + p.w, 0) || 1;
    for (const p of parts) {
      const key = `${p.day}|${t.fromMoneySourceCode}`;
      const cur = ledgerByKey.get(key) || { card: 0, grab: 0, codes: new Set(), entryDays: new Set() };
      cur.card += (fee.card * p.w) / totalW;
      cur.grab += (fee.grab * p.w) / totalW;
      cur.codes.add(fee.code);
      cur.entryDays.add(fee.entryDay);
      ledgerByKey.set(key, cur);
    }
  }

  // ---------- Xếp chênh vào rổ ----------
  const buckets = {
    prevPeriod: 0, // phí của doanh thu kỳ trước, tiền về + ghi sổ kỳ này
    grabAsCard: 0, // ví Grab nhưng phí lên dòng quẹt thẻ
    feeDiff: 0, // cùng ngày doanh thu + ví, phí QTVI khác phí trên bảng
    tableNoLedger: 0, // bảng có phí, sổ chưa có (thường: tiền về đầu tháng sau, hoặc chưa đồng bộ ghi sổ)
    ledgerNoTable: 0, // sổ có phí, bảng không thấy dòng ví đó (chưa có doanh thu POS / về dư / chưa về)
  };
  const detail = [];
  const keys = new Set([...ledgerByKey.keys(), ...tableIn.map(([k]) => k)]);
  for (const key of [...keys].sort()) {
    const [day, source] = key.split("|");
    const led = ledgerByKey.get(key);
    const tab = tableFee.get(key);
    const isGrab = tab ? tab.isGrab : isGrabMoneySource(source, sourceName.get(source));
    const ledCard = led ? led.card : 0;
    const expectedCard = tab && !tab.isGrab ? tab.fee : 0;
    if (!inPeriod(day)) { buckets.prevPeriod += ledCard; continue; }
    if (isGrab && ledCard) buckets.grabAsCard += ledCard;
    const cardSide = isGrab ? 0 : ledCard;
    if (!led && expectedCard) buckets.tableNoLedger -= expectedCard;
    else if (!tab && cardSide) buckets.ledgerNoTable += cardSide;
    else buckets.feeDiff += cardSide - expectedCard;
    if (Math.abs((isGrab ? ledCard : ledCard - expectedCard)) >= 1) {
      detail.push({ day, source, name: sourceName.get(source) || source, isGrab, expectedCard, ledCard, codes: led ? [...led.codes].join(",") : "", entryDays: led ? [...led.entryDays].join(",") : "" });
    }
  }
  const nonTransfer = [...ledgerCardBySource.entries()].filter(([k]) => k !== "MONEY_TRANSFER" && k !== "MONEY_TRANSFER_FEE");
  const noDayCard = noRevenueDay.reduce((s, r) => s + r.card, 0);

  console.log(`Cửa hàng ${branchCode} · kỳ ${period} · CHỈ ĐỌC`);
  console.log("");
  console.log(`A. Tổng hợp chi phí → Chi phí quẹt thẻ (theo ngày bút toán)   ${pad(ledgerCard, 14)} đ`);
  for (const [k, v] of [...ledgerCardBySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${k.padEnd(28)}${pad(v, 32)} đ`);
  console.log(`   (Chi phí bán hàng Grab — dòng P&L riêng, không nằm trong A)    ${pad(ledgerGrab, 14)} đ`);
  console.log(`B. Tiền về đủ chưa: phí ví THẺ (không gồm Grab), ngày DT trong kỳ ${pad(tableCard, 14)} đ`);
  console.log(`   (phí ví Grab trên bảng                                          ${pad(tableGrab, 14)} đ)`);
  if (writtenOffCard) console.log(`   (khoản chênh đã "đưa vào chi phí" ngay trên bảng — bảng đã trừ khỏi phí: ${money(writtenOffCard)} đ)`);
  console.log(`CHÊNH A − B                                                       ${pad(ledgerCard - tableCard, 14)} đ`);
  console.log("");
  console.log("GIẢI THÍCH CHÊNH (cộng lại đúng bằng A − B):");
  console.log(`  1. Phí của doanh thu KỲ TRƯỚC, tiền về & ghi sổ kỳ này         ${pad(buckets.prevPeriod, 14)} đ`);
  console.log(`  2. Ví GRAB nhưng phí lên dòng QUẸT THẺ                         ${pad(buckets.grabAsCard, 14)} đ`);
  console.log(`  3. Cùng ngày DT + ví, phí trên QTVI ≠ phí trên bảng            ${pad(buckets.feeDiff, 14)} đ`);
  console.log(`  4. Sổ có phí, bảng không có dòng ví đó (chưa có DT/về dư)      ${pad(buckets.ledgerNoTable, 14)} đ`);
  console.log(`  5. Bảng có phí, sổ chưa ghi (về đầu kỳ sau / chưa đồng bộ)     ${pad(buckets.tableNoLedger, 14)} đ`);
  console.log(`  6. QTVI không quy được về ngày DT (sao kê chưa gắn ngày)        ${pad(noDayCard, 14)} đ`);
  for (const [k, v] of nonTransfer) console.log(`  7. Phí không qua QTVI: ${k.padEnd(38)}${pad(v, 14)} đ`);
  const explained = buckets.prevPeriod + buckets.grabAsCard + buckets.feeDiff + buckets.ledgerNoTable + buckets.tableNoLedger + noDayCard + nonTransfer.reduce((s, [, v]) => s + v, 0);
  console.log(`     Cộng                                                        ${pad(explained, 14)} đ`);
  console.log("");
  console.log("Lưu ý đọc theo ngày: từ 24/09/2026 phí QTVI ghi theo NGÀY DOANH THU (bút toán MONEY_TRANSFER_FEE) —");
  console.log("phiếu chưa Đồng bộ ghi sổ lại vẫn còn phí nằm ở NGÀY TIỀN VỀ (bút toán MONEY_TRANSFER) cho tới khi đồng bộ.");
  console.log("");
  console.log("CHI TIẾT CÁC DÒNG LỆCH (ngày DOANH THU + ví):");
  console.log("NGÀY DT     VÍ                                  BẢNG (thẻ)     SỔ (quẹt thẻ)   LỆCH           GHI SỔ NGÀY   PHIẾU");
  for (const d of detail) {
    const label = `${d.name}${d.isGrab ? " [GRAB]" : ""}`.slice(0, 34).padEnd(34);
    console.log(`${d.day}  ${label} ${pad(d.expectedCard, 12)}  ${pad(d.ledCard, 14)}  ${pad(d.ledCard - d.expectedCard, 12)}   ${d.entryDays.padEnd(12)}  ${d.codes}`);
  }
  if (noRevenueDay.length) {
    console.log("");
    console.log("QTVI KHÔNG QUY ĐƯỢC VỀ NGÀY DOANH THU:");
    for (const r of noRevenueDay) console.log(`  ${r.code}  ghi sổ ${r.entryDay}  ${r.source}  phí thẻ ${money(r.card)} đ`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
