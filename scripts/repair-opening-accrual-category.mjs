/**
 * Nắn lại Nhóm chi phí (và Hạng mục P&L) của một khoản phân bổ sinh từ Số dư đầu kỳ.
 *
 * Vì sao cần: màn Số dư đầu kỳ trước đây cắt mất ô "Nhóm chi phí/Tài khoản" khi gửi lên server
 * (app/opening-balances/page.tsx), nên chọn CAPEX xong lưu lại vẫn ra OPEX — số dư đầu kỳ không
 * lưu gì và khoản phân bổ rơi về mặc định "OPEX". Mã nguồn đã vá, nhưng các khoản đã CHỐT từ
 * trước vẫn đang mang khoản mục sai và không tự sửa được: muốn đổi phải Mở lại số dư -> sửa ->
 * chốt lại, thao tác đó xoá khoản phân bổ cũ rồi dựng lại (mất id, mất lịch phân bổ đang có).
 * Script này sửa tại chỗ, giữ nguyên id và lịch phân bổ.
 *
 * Sửa đồng thời ba nơi để chúng không lệch nhau:
 *  - Accrual.categoryCode / pnlItemCode — cái đang hiện trên tab Trích trước & Phân bổ.
 *  - OpeningBalance.moneySourceCode / pnlItemCode — nguồn gốc, để lần sau Mở lại -> chốt lại
 *    dựng đúng khoản mục chứ không rơi về OPEX lần nữa.
 *  - JournalLine của các kỳ ĐÃ ghi nhận — bút toán cũ vẫn mang khoản mục sai, không sửa thì
 *    báo cáo các kỳ đó vẫn đứng sai chỗ.
 *
 * Kỳ đã khoá sổ thì dừng, không sửa (luật chung ở lib/phase3).
 *
 * Chạy thử (không ghi gì):
 *   npm run repair:opening-accrual -- --code PB-DK-CAPEX2501001 --category CAPEX
 * Ghi thật:
 *   npm run repair:opening-accrual -- --code PB-DK-CAPEX2501001 --category CAPEX --apply --confirm PB-DK-CAPEX2501001
 *
 * Tuỳ chọn --pnl-item CAPEX_DTDB để đổi luôn hạng mục P&L; bỏ trống thì giữ nguyên mã đang có.
 */
import { createRequire } from "node:module";
import { findClosedPeriod } from "../lib/phase3.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
};
const hasFlag = (name) => args.includes(name);

const accrualCode = valueOf("--code").trim().toUpperCase();
const targetCategory = valueOf("--category").trim().toUpperCase();
const pnlItemGiven = hasFlag("--pnl-item");
const targetPnlItem = valueOf("--pnl-item").trim().toUpperCase() || null;
const apply = hasFlag("--apply");
const confirmCode = valueOf("--confirm").trim().toUpperCase();

const USAGE = "Dùng: npm run repair:opening-accrual -- --code PB-DK-... --category CAPEX [--pnl-item MA_HANG_MUC] [--apply --confirm PB-DK-...]";

function usageError(message) {
  throw new Error(`${message}\n${USAGE}`);
}

/** Kỳ kế toán của một bút toán: ngày ghi sổ nằm ở tháng nào. */
function periodOfDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  if (!accrualCode) usageError("Thiếu --code");
  if (!targetCategory) usageError("Thiếu --category (VD: CAPEX)");
  if (apply && confirmCode !== accrualCode) {
    usageError(`Chế độ --apply yêu cầu --confirm ${accrualCode}`);
  }

  const accrual = await prisma.accrual.findUnique({
    where: { code: accrualCode },
    include: { schedules: { orderBy: { period: "asc" } } },
  });
  if (!accrual || accrual.deletedAt) usageError(`Không tìm thấy khoản phân bổ ${accrualCode}`);
  if (accrual.sourceType !== "OPENING_BALANCE") {
    usageError(`${accrualCode} không sinh từ Số dư đầu kỳ (sourceType=${accrual.sourceType || "trống"}). Khoản tạo tay sửa thẳng trên màn Trích trước & Phân bổ.`);
  }

  // Khoản mục phải có thật: OPEX/CAPEX là hai lựa chọn của form Số dư đầu kỳ, ngoài ra chấp
  // nhận mọi Khoản mục thu/chi đang hoạt động để còn nắn được dữ liệu nhập bằng import.
  if (!["OPEX", "CAPEX"].includes(targetCategory)) {
    const category = await prisma.masterDataItem.findFirst({
      where: { type: "REVENUE_EXPENSE_CATEGORY", code: targetCategory, status: "ACTIVE", deletedAt: null },
      select: { code: true },
    });
    if (!category) usageError(`Khoản mục [${targetCategory}] không phải OPEX/CAPEX và cũng không có trong danh mục Khoản mục thu/chi`);
  }
  if (pnlItemGiven && targetPnlItem) {
    const pnlItem = await prisma.masterDataItem.findFirst({
      where: { type: "PNL_ITEM", code: targetPnlItem, status: "ACTIVE", deletedAt: null },
      select: { code: true },
    });
    if (!pnlItem) usageError(`Hạng mục P&L [${targetPnlItem}] không tồn tại hoặc đã ngừng hoạt động`);
  }

  const nextPnlItem = pnlItemGiven ? targetPnlItem : accrual.pnlItemCode;
  const openingBalance = accrual.sourceId
    ? await prisma.openingBalance.findUnique({ where: { id: accrual.sourceId } })
    : null;

  const postedSchedules = accrual.schedules.filter((row) => row.status === "POSTED");
  const postedEntries = postedSchedules.length > 0
    ? await prisma.journalEntry.findMany({
        where: { sourceType: "ACCRUAL", sourceId: { in: postedSchedules.map((row) => row.id) } },
        include: { lines: { include: { account: true } } },
      })
    : [];
  // Chỉ dòng chi phí mới mang khoản mục; vế đối ứng (242/335) để trống như lúc ghi sổ.
  const expenseLines = postedEntries.flatMap((entry) =>
    entry.lines.filter((line) => ["COGS", "OPEX", "OTHER_EXPENSE"].includes(line.account.accountType)),
  );

  console.table([{
    ma_khoan: accrual.code,
    ten: accrual.name,
    cua_hang: accrual.branchCode,
    khoan_muc_hien_tai: accrual.categoryCode,
    khoan_muc_sau_sua: targetCategory,
    hang_muc_pl_hien_tai: accrual.pnlItemCode || "-",
    hang_muc_pl_sau_sua: nextPnlItem || "-",
    so_ky: accrual.numberOfPeriods,
    ky_da_ghi_nhan: postedSchedules.length,
    dong_but_toan_can_nan: expenseLines.length,
    so_du_dau_ky_goc: openingBalance ? `${openingBalance.objectCode} (${openingBalance.status})` : "KHÔNG TÌM THẤY",
    so_du_dau_ky_dang_luu: openingBalance ? (openingBalance.moneySourceCode || "trống -> hiện OPEX") : "-",
  }]);

  if (!openingBalance) {
    console.log("Cảnh báo: không tìm thấy số dư đầu kỳ gốc, chỉ nắn được khoản phân bổ và bút toán.");
  }

  // Khoá sổ là cửa duy nhất: kỳ của số dư đầu kỳ và kỳ của mọi bút toán sắp nắn đều phải còn mở.
  const targets = [
    ...(openingBalance ? [{ period: openingBalance.period, branchCode: openingBalance.branchCode }] : []),
    ...postedEntries.map((entry) => ({ period: periodOfDate(entry.entryDate), branchCode: entry.branchCode })),
  ];
  const closed = targets.length > 0 ? await findClosedPeriod(targets, prisma) : null;
  if (closed) {
    usageError(`Kỳ ${closed.period} của ${closed.branchCode === "ALL" ? "toàn hệ thống" : `cửa hàng ${closed.branchCode}`} đã khoá sổ nên không sửa được. Mở lại kỳ ở màn Sổ cái Kế toán rồi chạy lại.`);
  }

  const nothingToDo = accrual.categoryCode === targetCategory
    && (accrual.pnlItemCode || null) === (nextPnlItem || null)
    && expenseLines.every((line) => line.categoryCode === targetCategory && (line.pnlItemCode || null) === (nextPnlItem || null))
    && (!openingBalance || (openingBalance.moneySourceCode === targetCategory && (openingBalance.pnlItemCode || null) === (nextPnlItem || null)));
  if (nothingToDo) {
    console.log("Dữ liệu đã đúng, không có gì để sửa.");
    return;
  }

  if (!apply) {
    console.log("DRY-RUN: chưa ghi database. Thêm --apply --confirm " + accrualCode + " để ghi thật.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.accrual.update({
      where: { id: accrual.id },
      data: { categoryCode: targetCategory, pnlItemCode: nextPnlItem },
    });
    if (openingBalance) {
      await tx.openingBalance.update({
        where: { id: openingBalance.id },
        data: { moneySourceCode: targetCategory, pnlItemCode: nextPnlItem },
      });
    }
    for (const line of expenseLines) {
      await tx.journalLine.update({
        where: { id: line.id },
        data: { categoryCode: targetCategory, pnlItemCode: nextPnlItem },
      });
    }
    await tx.auditLog.create({
      data: {
        module: "OPENING_BALANCE",
        action: "REPAIR",
        entityType: "Accrual",
        entityId: accrual.id,
        entityCode: accrual.code,
        branchCode: accrual.branchCode,
        actorName: "scripts/repair-opening-accrual-category",
        message: `Nắn khoản mục ${accrual.categoryCode} -> ${targetCategory}, hạng mục P&L ${accrual.pnlItemCode || "trống"} -> ${nextPnlItem || "trống"}`,
        metadataJson: JSON.stringify({
          before: { categoryCode: accrual.categoryCode, pnlItemCode: accrual.pnlItemCode, openingBalanceMoneySourceCode: openingBalance?.moneySourceCode ?? null },
          after: { categoryCode: targetCategory, pnlItemCode: nextPnlItem },
          journalLineIds: expenseLines.map((line) => line.id),
        }),
      },
    });
  });

  console.log(`Đã sửa ${accrual.code}: khoản mục ${targetCategory}, hạng mục P&L ${nextPnlItem || "trống"}, nắn ${expenseLines.length} dòng bút toán đã ghi.`);
  if (postedSchedules.length > 0) {
    console.log("Các kỳ đã ghi nhận đã được nắn tại chỗ, không cần bỏ ghi nhận rồi ghi lại.");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
