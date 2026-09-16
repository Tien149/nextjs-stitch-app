/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Đưa phí quyết toán ví bị thổi lên về 0.
 *
 * BỐI CẢNH (phát hiện 15/09/2026). Phí ví = Gross khai − tiền ngân hàng thực trả. Công thức
 * đúng, nhưng nó tin tuyệt đối vào Gross: khai Gross bằng doanh thu CẢ NGÀY trong khi ngân
 * hàng mới trả về một đợt thì toàn bộ phần chưa về bị ghi thành phí. Hai ví Momo của ASA
 * tháng 08/2026 ra phí 30–98% theo đúng đường này (ASA-00047: về 328.391 đ, phí 22.286.614 đ).
 * Ví Momo của NAM MÊ cùng loại chạy 1,24% — đó mới là tỷ lệ thật.
 *
 * VÌ SAO ĐẶT VỀ 0 CHỨ KHÔNG "TÍNH LẠI CHO ĐÚNG". Phí đúng chỉ tính được khi biết mỗi đợt tiền
 * về ứng với bao nhiêu doanh thu. Dữ liệu hiện tại không cho biết điều đó: MOMO_EDC_KCF thậm
 * chí có tiền về (429,9tr) LỚN HƠN doanh thu POS đang có (259,9tr), tức doanh thu còn thiếu.
 * Suy ra một con số phí rồi ghi vào sổ là đoán. Đặt về 0 đưa phiếu về đúng trạng thái hệ thống
 * vẫn dùng khi không khai Gross — "chỉ ghi nhận tiền thực về" — rồi ghi nhận phí thật sau khi
 * đối soát đủ doanh thu. Mất vài triệu phí thật còn hơn giữ lại mấy trăm triệu phí ảo.
 *
 * KHÔNG đụng `amount` (tiền về ngân hàng, đã khớp sao kê), không xoá phiếu, không đụng bút toán
 * — chạy xong phải bấm "Đồng bộ ghi sổ" trên màn Sổ cái để bút toán 6428/811 được ghi lại.
 *
 * Mặc định CHẠY THỬ. Ghi thật cần --apply --confirm <BRANCH>.
 *
 *   node scripts/reset-inflated-wallet-fee.cjs --branch ASA --from 2026-08-01 --to 2026-08-31
 *   node scripts/reset-inflated-wallet-fee.cjs --branch ASA --from 2026-08-01 --to 2026-08-31 --apply --confirm ASA
 */
const { PrismaClient } = require("@prisma/custom-client");
const walletFeeLimits = require("../lib/wallet-fee-limits.json");

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
const actor = valueOf("--actor").trim() || "RESET_INFLATED_WALLET_FEE";

const money = (value) => Math.round(value).toLocaleString("vi-VN");
const dayKey = (value) => value.toISOString().slice(0, 10);
const isGrab = (text) => String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes("grab");

function usageError(message) {
  console.error(`LỖI: ${message}`);
  console.error("Cách dùng: --branch <MÃ> --from YYYY-MM-DD --to YYYY-MM-DD [--apply --confirm <MÃ>]");
  process.exit(1);
}

function utcDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || "")) usageError(`Ngày phải có dạng YYYY-MM-DD, nhận được "${text}"`);
  return new Date(`${text}T00:00:00.000Z`);
}

async function main() {
  if (!branchCode) usageError("Thiếu --branch");
  if (apply && confirmBranch !== branchCode) usageError(`Chế độ --apply yêu cầu --confirm ${branchCode}`);
  const from = utcDate(fromText);
  const to = new Date(utcDate(toText));
  to.setUTCDate(to.getUTCDate() + 1);

  const [transfers, sources] = await Promise.all([
    prisma.moneyTransfer.findMany({
      where: {
        branchCode,
        transferPurpose: "WALLET_SETTLEMENT",
        status: "APPROVED",
        deletedAt: null,
        feeAmount: { gt: 0 },
        transferDate: { gte: from, lt: to },
      },
      orderBy: [{ transferDate: "asc" }, { code: "asc" }],
    }),
    prisma.masterDataItem.findMany({ where: { type: "MONEY_SOURCE", deletedAt: null }, select: { code: true, name: true } }),
  ]);
  const sourceName = new Map(sources.map((row) => [row.code, row.name]));

  // Kỳ đã khoá sổ thì tuyệt đối không đụng — mở kỳ là quyết định của kế toán trưởng.
  const periods = await prisma.accountingPeriod.findMany({ where: { branchCode }, select: { period: true, status: true } });
  const lockedPeriods = new Set(periods.filter((row) => row.status !== "OPEN").map((row) => row.period));

  const targets = [];
  const skipped = [];
  for (const row of transfers) {
    const gross = row.amount + row.feeAmount;
    const rate = gross > 0 ? row.feeAmount / gross : null;
    const limit = isGrab(`${row.fromMoneySourceCode} ${sourceName.get(row.fromMoneySourceCode) || ""}`)
      ? walletFeeLimits.GRAB
      : walletFeeLimits.CARD_WALLET;
    if (rate === null || rate <= limit) continue;
    const period = dayKey(row.transferDate).slice(0, 7);
    if (lockedPeriods.has(period)) {
      skipped.push({ code: row.code, reason: `kỳ ${period} đã khoá sổ` });
      continue;
    }
    targets.push({ row, gross, rate, limit, period });
  }

  console.log(`Cửa hàng ${branchCode} · ${fromText} → ${toText} · ngưỡng thẻ ${(walletFeeLimits.CARD_WALLET * 100).toFixed(0)}% · Grab ${(walletFeeLimits.GRAB * 100).toFixed(0)}%`);
  console.log(`Phiếu quyết toán có phí trong khoảng: ${transfers.length} · vượt ngưỡng: ${targets.length} · bỏ qua do khoá sổ: ${skipped.length}`);
  if (skipped.length) for (const row of skipped) console.log(`  BỎ QUA ${row.code}: ${row.reason}`);
  if (targets.length === 0) {
    console.log("Không có phiếu nào cần xử lý.");
    return;
  }

  console.log("");
  console.log("MÃ PHIẾU            NGÀY        VÍ              TIỀN VỀ         PHÍ SẼ GỠ      TỶ LỆ");
  for (const target of targets) {
    console.log(
      `${target.row.code.padEnd(20)}${dayKey(target.row.transferDate)}  ${target.row.fromMoneySourceCode.padEnd(15)}`
      + `${money(target.row.amount).padStart(14)}  ${money(target.row.feeAmount).padStart(14)}  ${(target.rate * 100).toFixed(1).padStart(6)}%`,
    );
  }
  const totalFee = targets.reduce((sum, target) => sum + target.row.feeAmount, 0);
  console.log("");
  console.log(`TỔNG PHÍ SẼ GỠ KHỎI CHI PHÍ: ${money(totalFee)} đ trên ${targets.length} phiếu`);

  if (!apply) {
    console.log("");
    console.log("CHẠY THỬ — chưa ghi gì. Ghi thật:");
    console.log(`  node scripts/reset-inflated-wallet-fee.cjs --branch ${branchCode} --from ${fromText} --to ${toText} --apply --confirm ${branchCode}`);
    return;
  }

  // Sao lưu nguyên trạng trước khi ghi, để lùi lại được mà không cần backup cả database.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_backup_wallet_fee_reset" (
      "id" text PRIMARY KEY,
      "code" text NOT NULL,
      "amount" double precision NOT NULL,
      "feeAmount" double precision NOT NULL,
      "feeCategoryCode" text,
      "grabExpenseAmount" double precision NOT NULL,
      "grabExpenseCategoryCode" text,
      "resetAt" timestamptz NOT NULL DEFAULT now(),
      "resetBy" text
    )`);

  let done = 0;
  for (const target of targets) {
    const row = target.row;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "_backup_wallet_fee_reset" ("id","code","amount","feeAmount","feeCategoryCode","grabExpenseAmount","grabExpenseCategoryCode","resetBy")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("id") DO NOTHING`,
        row.id, row.code, row.amount, row.feeAmount, row.feeCategoryCode,
        row.grabExpenseAmount, row.grabExpenseCategoryCode, actor,
      );
      // Khoá theo đúng số cũ: phiếu đã bị ai đó sửa trong lúc chạy thì bỏ qua, không ghi đè.
      const updated = await tx.moneyTransfer.updateMany({
        where: { id: row.id, feeAmount: row.feeAmount, amount: row.amount, deletedAt: null },
        data: { feeAmount: 0, feeCategoryCode: null, grabExpenseAmount: 0, grabExpenseCategoryCode: null },
      });
      if (updated.count !== 1) throw new Error(`Phiếu ${row.code} đã thay đổi trong lúc chạy — dừng để không ghi đè`);
      await tx.auditLog.create({
        data: {
          actorName: actor,
          branchCode,
          module: "/finance-operations",
          action: "RESET_INFLATED_WALLET_FEE",
          entityType: "MoneyTransfer",
          entityId: row.id,
          entityCode: row.code,
          message: `Gỡ phí ví thổi ${(target.rate * 100).toFixed(1)}% về 0`,
          metadataJson: JSON.stringify({
            wallet: row.fromMoneySourceCode,
            amount: row.amount,
            feeBefore: row.feeAmount,
            grabExpenseBefore: row.grabExpenseAmount,
            grossBefore: target.gross,
            rate: target.rate,
            limit: target.limit,
          }),
        },
      });
    });
    done += 1;
  }

  console.log("");
  console.log(`ĐÃ GỠ PHÍ TRÊN ${done} PHIẾU · ${money(totalFee)} đ`);
  console.log("Số cũ lưu ở bảng \"_backup_wallet_fee_reset\".");
  console.log("BƯỚC CUỐI: vào Sổ cái Kế toán → chọn kỳ → cửa hàng → bấm \"Đồng bộ ghi sổ\" để bút toán được ghi lại.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
