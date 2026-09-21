/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Soát CHI PHÍ QUẸT THẺ trên P&L đến từ những nguồn nào.
 *
 * BỐI CẢNH (khách hỏi 21/09/2026). Trên Báo cáo nguồn tiền phí quẹt thẻ chỉ ~13 triệu, nhưng
 * Tổng hợp chi phí / P&L lên 97.930.148 đ. Hai báo cáo không mâu thuẫn nhau một cách ngẫu
 * nhiên — chúng đọc hai nguồn khác nhau:
 *
 *   - Báo cáo nguồn tiền đọc phiếu điều tiền (phí quyết toán ví) + sao kê + phiếu thu/chi.
 *     Doanh thu POS KHÔNG vào bảng đó, nên phí khai trên file POS không bao giờ hiện ở đây.
 *   - Tổng hợp chi phí / P&L đọc SỔ NHẬT KÝ: mọi dòng ghi Nợ tài khoản chi phí. Phí quẹt thẻ
 *     vào sổ từ HAI đường và cả hai cùng ghi Nợ 6428 với cùng hạng mục P&L:
 *       * REVENUE_POS     — cột phí cà thẻ trên file doanh thu POS
 *       * MONEY_TRANSFER  — phí trên phiếu quyết toán ví
 *
 * Nên chênh lệch giữa hai báo cáo ĐÚNG BẰNG phần phí khai trên file POS. Đó là giải thích,
 * chưa phải kết luận đúng/sai: nếu MỘT ngày doanh thu có phí ở CẢ HAI đường thì cùng một
 * khoản phí đang được tính hai lần, và số trên P&L bị thổi đúng phần đó.
 *
 * Script CHỈ ĐỌC, không sửa gì.
 *
 * Dùng:
 *   node scripts/audit-card-fee-sources.cjs --branch ASA --period 2026-08
 *   node scripts/audit-card-fee-sources.cjs --branch ASA --period 2026-08 --pnl-item CPBD_CPNH
 *   node scripts/audit-card-fee-sources.cjs --self-test        # không cần DB
 */
const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
};
const branchCode = valueOf("--branch").trim().toUpperCase();
const period = valueOf("--period").trim();
const pnlItemArg = valueOf("--pnl-item").trim().toUpperCase();
const selfTest = args.includes("--self-test");

const money = (value) => Math.round(value).toLocaleString("vi-VN");
const EXPENSE_ACCOUNT_TYPES = new Set(["COGS", "OPEX", "OTHER_EXPENSE"]);
/** Đầu tháng kế tiếp, để lọc [đầu kỳ, đầu kỳ sau). */
function nextMonth(value) {
  const [year, month] = value.split("-").map(Number);
  return month === 12 ? new Date(`${year + 1}-01-01T00:00:00.000Z`) : new Date(`${year}-${String(month + 1).padStart(2, "0")}-01T00:00:00.000Z`);
}
const dayKey = (value) => new Date(value).toISOString().slice(0, 10);

/** Nhãn nguồn phát sinh, đặt đúng tên màn hình mà kế toán đi sửa. */
const SOURCE_LABELS = {
  REVENUE_POS: "File doanh thu POS (cột phí cà thẻ)",
  MONEY_TRANSFER: "Quyết toán ví / điều tiền",
  VOUCHER: "Phiếu chi / chứng từ ngân hàng",
  CASHBOOK_ADJUSTMENT: "Điều chỉnh quỹ",
};

/**
 * Gom các dòng phí theo nguồn phát sinh và theo ngày, rồi chỉ ra ngày nào có phí từ CẢ HAI
 * đường — đó là dấu hiệu cùng một khoản phí bị ghi hai lần.
 *
 * Tách riêng khỏi phần đọc database để tự kiểm được bằng --self-test.
 */
function summarize(lines) {
  const bySource = new Map();
  const byDay = new Map();
  for (const line of lines) {
    bySource.set(line.sourceType, (bySource.get(line.sourceType) || 0) + line.amount);
    const day = byDay.get(line.date) || new Map();
    day.set(line.sourceType, (day.get(line.sourceType) || 0) + line.amount);
    byDay.set(line.date, day);
  }
  const overlapDays = [...byDay.entries()]
    .filter(([, sources]) => sources.has("REVENUE_POS") && sources.has("MONEY_TRANSFER"))
    .map(([date, sources]) => ({
      date,
      pos: sources.get("REVENUE_POS") || 0,
      wallet: sources.get("MONEY_TRANSFER") || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    total: lines.reduce((sum, line) => sum + line.amount, 0),
    bySource: [...bySource.entries()].sort((a, b) => b[1] - a[1]),
    overlapDays,
    // Phần nghi ghi đôi: lấy vế NHỎ HƠN của mỗi ngày trùng — vế lớn hơn vẫn có thể là phí thật.
    overlapAmount: overlapDays.reduce((sum, row) => sum + Math.min(row.pos, row.wallet), 0),
  };
}

function runSelfTest() {
  const lines = [
    { date: "2026-08-01", sourceType: "REVENUE_POS", amount: 100 },
    { date: "2026-08-01", sourceType: "MONEY_TRANSFER", amount: 300 },
    { date: "2026-08-02", sourceType: "MONEY_TRANSFER", amount: 50 },
    { date: "2026-08-03", sourceType: "REVENUE_POS", amount: 20 },
  ];
  const result = summarize(lines);
  const assert = (ok, message) => { if (!ok) { console.error(`FAIL: ${message}`); process.exitCode = 1; } };
  assert(result.total === 470, "tổng phải bằng tổng mọi dòng");
  assert(result.overlapDays.length === 1, "chỉ ngày 01/08 có cả hai nguồn");
  assert(result.overlapDays[0].date === "2026-08-01", "ngày trùng phải là 01/08");
  assert(result.overlapAmount === 100, "phần nghi ghi đôi lấy vế nhỏ hơn (100), không phải 300");
  const empty = summarize([]);
  assert(empty.total === 0 && empty.overlapDays.length === 0, "không có dòng nào thì không báo gì");
  if (!process.exitCode) console.log("self-test OK");
}

async function main() {
  if (selfTest) return runSelfTest();
  if (!branchCode || !/^\d{4}-\d{2}$/.test(period)) {
    console.error("Cách dùng: --branch <MÃ> --period YYYY-MM [--pnl-item <MÃ HẠNG MỤC>]");
    process.exit(1);
  }
  const { PrismaClient } = require("@prisma/custom-client");
  const prisma = new PrismaClient();
  try {
    // Hạng mục P&L của phí quẹt thẻ: mỗi khách đặt một mã (mã chuẩn PNL_CP_QUETTHE, khách có
    // thể dùng mã riêng như CPBD_CPNH), nên cho khai thẳng, không khai thì dò theo TÊN.
    let pnlItemCodes = pnlItemArg ? [pnlItemArg] : [];
    if (pnlItemCodes.length === 0) {
      const items = await prisma.masterDataItem.findMany({
        where: { type: "PNL_ITEM", deletedAt: null },
        select: { code: true, name: true },
      });
      pnlItemCodes = items
        .filter((item) => /quet the|quẹt thẻ|ca the|cà thẻ/i.test(`${item.name}`.normalize("NFC")))
        .map((item) => item.code);
      if (pnlItemCodes.length === 0) {
        console.error("Không tìm thấy hạng mục P&L nào tên chứa \"quẹt thẻ\". Khai thẳng bằng --pnl-item <MÃ>.");
        process.exit(1);
      }
    }

    const entries = await prisma.journalEntry.findMany({
      where: { period, branchCode, status: "POSTED", deletedAt: null },
      select: {
        sourceType: true, sourceCode: true, code: true, entryDate: true, description: true,
        lines: { where: { pnlItemCode: { in: pnlItemCodes }, debit: { gt: 0 } }, select: { debit: true } },
      },
    });
    const lines = [];
    for (const entry of entries) {
      for (const line of entry.lines) {
        lines.push({ date: dayKey(entry.entryDate), sourceType: entry.sourceType, amount: line.debit });
      }
    }

    /**
     * ĐỐI CHIẾU BA SỐ. Khách báo 21/09/2026 lệch CẢ HAI CHIỀU — Nam Mê phí thật 16.705.348 mà
     * báo cáo chỉ 7.599.299 (THIẾU), Asa phí thật 13.468.957 mà báo cáo 97.930.148 (THỪA).
     * Một nguyên nhân đơn không gây được cả hai, nên phải đo từng chặng:
     *
     *   (1) Phiếu quyết toán ví  -> phí ghi trên chứng từ, gần nhất với con số kế toán tự cộng
     *   (2) Bút toán ĐÃ gắn hạng mục P&L -> đúng số lên Tổng hợp chi phí và P&L
     *   (3) Bút toán CHƯA gắn hạng mục -> ghi Nợ 6428 thật nhưng BỊ LOẠI khỏi báo cáo
     *
     * Chặng (3) là đường gây THIẾU: `walletFeePnlItemCode` chỉ nhận đúng hai mã khoản mục
     * chuẩn, khách đặt mã riêng là bút toán ra `pnlItemCode = null` và rơi khỏi bảng.
     * Phiếu chưa có bút toán nào là đường gây thiếu thứ hai: chưa bấm Đồng bộ ghi sổ.
     */
    const transfers = await prisma.moneyTransfer.findMany({
      where: {
        branchCode,
        transferPurpose: "WALLET_SETTLEMENT",
        status: "APPROVED",
        deletedAt: null,
        transferDate: { gte: new Date(`${period}-01T00:00:00.000Z`), lt: nextMonth(period) },
      },
      select: { id: true, code: true, feeAmount: true, grabExpenseAmount: true, feeCategoryCode: true },
    });
    const transferFeeTotal = transfers.reduce((sum, row) => sum + (row.feeAmount || 0), 0);
    const postedByTransfer = await prisma.journalEntry.findMany({
      where: { sourceType: "MONEY_TRANSFER", sourceId: { in: transfers.map((row) => row.id) }, deletedAt: null },
      select: { sourceId: true, lines: { select: { debit: true, pnlItemCode: true, account: { select: { reportGroup: true, accountType: true } } } } },
    });
    const postedIds = new Set(postedByTransfer.map((row) => row.sourceId));
    const notPosted = transfers.filter((row) => (row.feeAmount || 0) > 0 && !postedIds.has(row.id));
    let feeWithItem = 0;
    let feeWithoutItem = 0;
    for (const entry of postedByTransfer) {
      for (const line of entry.lines) {
        if (!(line.debit > 0) || !EXPENSE_ACCOUNT_TYPES.has(line.account.accountType)) continue;
        if (line.pnlItemCode) feeWithItem += line.debit;
        else feeWithoutItem += line.debit;
      }
    }

    const result = summarize(lines);
    console.log(`Cửa hàng ${branchCode} · kỳ ${period} · hạng mục: ${pnlItemCodes.join(", ")}`);
    console.log("");
    console.log("ĐỐI CHIẾU PHÍ QUYẾT TOÁN VÍ QUA TỪNG CHẶNG");
    console.log(`  1. Phí ghi trên phiếu quyết toán ví        ${money(transferFeeTotal).padStart(16)} đ  (${transfers.length} phiếu)`);
    console.log(`  2. Bút toán ĐÃ gắn hạng mục P&L            ${money(feeWithItem).padStart(16)} đ  <- số lên báo cáo`);
    console.log(`  3. Bút toán CHƯA gắn hạng mục (bị loại)    ${money(feeWithoutItem).padStart(16)} đ`);
    if (notPosted.length > 0) {
      const missing = notPosted.reduce((sum, row) => sum + (row.feeAmount || 0), 0);
      console.log(`  4. Phiếu CHƯA có bút toán nào              ${money(missing).padStart(16)} đ  (${notPosted.length} phiếu — bấm Đồng bộ ghi sổ)`);
      console.log(`     ${notPosted.slice(0, 10).map((row) => row.code).join(", ")}${notPosted.length > 10 ? ` … và ${notPosted.length - 10} phiếu khác` : ""}`);
    }
    if (feeWithoutItem > 0) {
      const codes = [...new Set(transfers.filter((row) => (row.feeAmount || 0) > 0).map((row) => row.feeCategoryCode || "(trống)"))];
      console.log("");
      console.log(`  => ${money(feeWithoutItem)} đ ghi Nợ tài khoản chi phí THẬT nhưng KHÔNG lên báo cáo vì thiếu hạng mục P&L.`);
      console.log(`     Khoản mục đang khai trên phiếu: ${codes.join(", ")}`);
      console.log("     Sửa: gắn hạng mục P&L cho khoản mục đó trong Danh mục, rồi bấm Đồng bộ ghi sổ.");
    }
    console.log(`TỔNG CHI PHÍ QUẸT THẺ ĐÃ VÀO SỔ: ${money(result.total)} đ trên ${lines.length} dòng bút toán`);
    if (lines.length === 0) return;
    console.log("");
    console.log("NGUỒN PHÁT SINH                            SỐ TIỀN          TỶ TRỌNG");
    for (const [sourceType, amount] of result.bySource) {
      const label = SOURCE_LABELS[sourceType] || sourceType;
      const share = result.total > 0 ? (amount / result.total) * 100 : 0;
      console.log(`${label.padEnd(42)}${money(amount).padStart(14)}  ${share.toFixed(1).padStart(6)}%`);
    }

    console.log("");
    if (result.overlapDays.length === 0) {
      console.log("Không có ngày nào có phí từ CẢ HAI đường — không thấy dấu hiệu ghi hai lần.");
      console.log("Chênh lệch so với Báo cáo nguồn tiền là phần phí khai trên file doanh thu POS (bảng đó không đọc doanh thu POS).");
      return;
    }
    console.log(`NGHI GHI HAI LẦN: ${result.overlapDays.length} ngày có phí từ CẢ file POS LẪN quyết toán ví`);
    console.log("");
    console.log("NGÀY          PHÍ TỪ FILE POS      PHÍ TỪ QUYẾT TOÁN VÍ");
    for (const row of result.overlapDays) {
      console.log(`${row.date}  ${money(row.pos).padStart(16)}  ${money(row.wallet).padStart(22)}`);
    }
    console.log("");
    console.log(`PHẦN NGHI BỊ TÍNH HAI LẦN (lấy vế nhỏ hơn mỗi ngày): ${money(result.overlapAmount)} đ`);
    console.log("");
    console.log("CÁCH XỬ LÝ: chọn MỘT đường ghi phí cho những ngày này.");
    console.log("  - Giữ phí trên file POS  -> chạy lại quyết toán ví cho các ngày đó với phí 0.");
    console.log("  - Giữ phí quyết toán ví  -> xoá cột phí cà thẻ trên file POS rồi import lại ngày đó.");
    console.log("Xong việc nào cũng phải bấm Đồng bộ ghi sổ để sổ cái ghi lại.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
