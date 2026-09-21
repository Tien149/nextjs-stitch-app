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
    /**
     * Tìm MÃ HẠNG MỤC P&L của phí quẹt thẻ.
     *
     * Bảng Tổng hợp chi phí in dòng theo dạng "<mã NHÓM> - <tên hạng mục>", nên rất dễ tưởng
     * phần đầu là mã hạng mục rồi truyền nhầm vào --pnl-item (khách gặp đúng 21/09/2026: gõ
     * CPBD_CPNH ra "0 đ trên 0 dòng" mà không biết vì sao). Nhận cả ba kiểu khai:
     *   - đúng mã hạng mục   -> dùng luôn
     *   - mã NHÓM P&L        -> lấy mọi hạng mục thuộc nhóm đó
     *   - không khai gì      -> dò theo TÊN hạng mục
     */
    const allItems = await prisma.masterDataItem.findMany({
      where: { type: "PNL_ITEM", deletedAt: null },
      select: { code: true, name: true, subGroup: true },
    });
    const byName = allItems.filter((item) => /quet the|quẹt thẻ|ca the|cà thẻ/i.test(`${item.name}`.normalize("NFC")));
    let pnlItemCodes = [];
    let how = "";
    if (pnlItemArg) {
      const exact = allItems.find((item) => item.code.toUpperCase() === pnlItemArg);
      if (exact) {
        pnlItemCodes = [exact.code];
        how = `hạng mục ${exact.code} (${exact.name})`;
      } else {
        const inGroup = allItems.filter((item) => String(item.subGroup || "").toUpperCase() === pnlItemArg);
        if (inGroup.length > 0) {
          pnlItemCodes = inGroup.map((item) => item.code);
          how = `NHÓM ${pnlItemArg} — gồm ${inGroup.length} hạng mục: ${inGroup.map((item) => `${item.code} (${item.name})`).join(", ")}`;
          console.log(`Lưu ý: "${pnlItemArg}" là mã NHÓM P&L, không phải mã hạng mục — đã tự lấy toàn bộ hạng mục trong nhóm.`);
        } else {
          console.error(`Không có hạng mục P&L nào mã "${pnlItemArg}", cũng không có nhóm P&L nào mã đó.`);
          if (byName.length > 0) {
            console.error("Hạng mục có tên liên quan tới quẹt thẻ:");
            for (const item of byName) console.error(`  ${item.code}  ${item.name}  (nhóm ${item.subGroup || "—"})`);
            console.error("Chạy lại không kèm --pnl-item là script tự dùng những mã trên.");
          }
          process.exit(1);
        }
      }
    } else {
      pnlItemCodes = byName.map((item) => item.code);
      how = byName.map((item) => `${item.code} (${item.name})`).join(", ");
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
    /**
     * TÁCH PHÍ GRAB RA KHỎI PHÍ QUẸT THẺ.
     *
     * `feeAmount` trên phiếu quyết toán ví GỘP cả hai, còn lúc ghi sổ hệ thống tách đôi: phí
     * Grab sang hạng mục "Chi phí bán hàng qua app", phí thẻ sang "Chi phí quẹt thẻ". Bản đầu
     * của script in thẳng số gộp kèm nhãn "số lên báo cáo" nên nhìn như báo cáo bị THIẾU —
     * khách so 17.428.888 (gộp) với 7.599.299 (riêng dòng quẹt thẻ) rồi tưởng mất 9,8 triệu.
     * Không mất đồng nào: phần chênh nằm ở dòng Grab.
     */
    const transferGrabTotal = transfers.reduce((sum, row) => sum + (row.grabExpenseAmount || 0), 0);
    const transferFeeTotal = transfers.reduce((sum, row) => sum + (row.feeAmount || 0), 0);
    const transferCardTotal = transferFeeTotal - transferGrabTotal;
    const postedByTransfer = await prisma.journalEntry.findMany({
      where: { sourceType: "MONEY_TRANSFER", sourceId: { in: transfers.map((row) => row.id) }, deletedAt: null },
      select: { sourceId: true, lines: { select: { debit: true, pnlItemCode: true, account: { select: { reportGroup: true, accountType: true } } } } },
    });
    const postedIds = new Set(postedByTransfer.map((row) => row.sourceId));
    const notPosted = transfers.filter((row) => (row.feeAmount || 0) > 0 && !postedIds.has(row.id));
    let feeWithItem = 0;
    let feeWithoutItem = 0;
    const postedByItem = new Map();
    for (const entry of postedByTransfer) {
      for (const line of entry.lines) {
        if (!(line.debit > 0) || !EXPENSE_ACCOUNT_TYPES.has(line.account.accountType)) continue;
        if (line.pnlItemCode) {
          feeWithItem += line.debit;
          postedByItem.set(line.pnlItemCode, (postedByItem.get(line.pnlItemCode) || 0) + line.debit);
        } else feeWithoutItem += line.debit;
      }
    }
    const itemName = new Map(allItems.map((item) => [item.code, item.name]));

    const result = summarize(lines);
    console.log(`Cửa hàng ${branchCode} · kỳ ${period}`);
    console.log(`Đang soát: ${how}`);
    console.log("");
    console.log("ĐỐI CHIẾU PHÍ QUYẾT TOÁN VÍ QUA TỪNG CHẶNG");
    console.log(`  1. Phí ghi trên phiếu quyết toán ví        ${money(transferFeeTotal).padStart(16)} đ  (${transfers.length} phiếu)`);
    console.log(`       trong đó phí Grab / bán hàng qua app  ${money(transferGrabTotal).padStart(16)} đ  -> lên dòng P&L KHÁC`);
    console.log(`       còn lại là phí quẹt thẻ / phí ví      ${money(transferCardTotal).padStart(16)} đ`);
    console.log(`  2. Bút toán ĐÃ gắn hạng mục P&L            ${money(feeWithItem).padStart(16)} đ  (cả hai loại phí)`);
    for (const [code, amount] of [...postedByItem.entries()].sort((a, b) => b[1] - a[1])) {
      const mine = pnlItemCodes.includes(code) ? "  <- dòng đang soát" : "";
      console.log(`       ${code.padEnd(24)} ${(itemName.get(code) || "").slice(0, 28).padEnd(30)}${money(amount).padStart(14)} đ${mine}`);
    }
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

    /**
     * Phí khai trên FILE DOANH THU POS: đối chiếu với chính doanh thu của kỳ để ra tỷ lệ.
     * Phí cà thẻ thực tế 1–2% doanh thu; ra vài chục phần trăm nghĩa là cột phí trên file
     * đang chứa thứ khác (số tiền quẹt thẻ, doanh thu theo phương thức...), không phải phí.
     */
    const posFee = result.bySource.find(([sourceType]) => sourceType === "REVENUE_POS")?.[1] || 0;
    if (posFee > 0) {
      const revenue = await prisma.revenueImportRow.aggregate({
        where: { branchCode, saleDate: { gte: new Date(`${period}-01T00:00:00.000Z`), lt: nextMonth(period) }, deletedAt: null },
        _sum: { netAmount: true, cardFeeAmount: true, appFeeAmount: true },
      });
      const netRevenue = revenue._sum.netAmount || 0;
      const rate = netRevenue > 0 ? (posFee / netRevenue) * 100 : null;
      console.log("");
      console.log("PHÍ KHAI TRÊN FILE DOANH THU POS");
      console.log(`  Doanh thu thuần của kỳ                    ${money(netRevenue).padStart(16)} đ`);
      console.log(`  Cột phí cà thẻ trên file                  ${money(revenue._sum.cardFeeAmount || 0).padStart(16)} đ`);
      console.log(`  Cột phí bán hàng qua app trên file        ${money(revenue._sum.appFeeAmount || 0).padStart(16)} đ`);
      if (rate !== null) {
        console.log(`  => Phí quẹt thẻ từ file POS bằng ${rate.toFixed(2)}% doanh thu`);
        if (rate > 3) {
          console.log(`     CẢNH BÁO: phí cà thẻ thực tế thường 1–2%. ${rate.toFixed(1)}% gần như chắc chắn là cột phí`);
          console.log("     trên file đang chứa thứ khác (số tiền khách quẹt, doanh thu theo phương thức...).");
          console.log("     Kiểm 1 dòng trên file POS gốc rồi đối chiếu với sao kê của đúng ngày đó.");
        }
      }
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
