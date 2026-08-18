/**
 * Nhập doanh thu ví ngày 31/07/2026 cho NAM MÊ và ASA — số do chị Bình gửi qua Zalo 17/08.
 *
 * Vì sao có script này thay vì gõ trên giao diện: gõ tay thì bản ghi mang tên tài khoản
 * "Admin Kế toán", nhìn lại không biết số ở đâu ra. Script ghi thẳng nguồn gốc vào
 * createdBy/note/audit log nên truy vết rõ hơn, không phải để né vết.
 *
 * Giữ nguyên MỌI kiểm tra mà API giao diện có:
 *   - chặn khi kỳ kế toán đã chốt sổ
 *   - chặn khi ngày đó đã có bản ghi theo ca (tránh cộng trùng với bản "Cả ngày")
 *   - ghi AuditLog cho từng bản ghi
 *
 * Xem trước:  node scripts/seed-manual-revenue-20260731.cjs
 * Ghi thật :  node scripts/seed-manual-revenue-20260731.cjs --apply --confirm 31-07
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM = args[args.indexOf("--confirm") + 1];
const ACTOR = "Script nhập doanh thu ví 31/07 (số chị Bình gửi Zalo 17/08)";
const NOTE = "Doanh thu ví 31/07 chị Bình cung cấp (Zalo 17/08)";
const REPORT_DATE_TEXT = "2026-07-31";
const SHIFT = "FULL";

// cardAmount = tổng các ví quẹt thẻ; grabAmount = các kênh Grab. Tiền mặt và chuyển khoản
// để 0 theo đúng lời chị Bình: "Ví thôi e, do chuyển khoản với tiền mặt đã vô đủ trong ngày rồi".
const ENTRIES = [
  {
    branchCode: "NME",
    cardAmount: 24_607_443, // MOMO_EDC_NME
    grabAmount: 2_627_000, // FDSGRABFOOD
    chiTiet: ["MOMO_EDC_NME 24.607.443", "FDSGRABFOOD 2.627.000"],
  },
  {
    branchCode: "ASA",
    cardAmount: 21_091_560, // MOMO_EDC_ASA 19.262.460 + MOMO_EDC_KCF 1.829.100
    grabAmount: 268_000, // ASAGRABFOOD
    chiTiet: ["MOMO_EDC_ASA 19.262.460", "MOMO_EDC_KCF 1.829.100", "ASAGRABFOOD 268.000"],
  },
];

const vnd = (n) => Math.round(Number(n || 0)).toLocaleString("vi-VN");

/** Cùng quy ước với `isPeriodLocked` của API: kỳ của cửa hàng hoặc kỳ "ALL" đã CLOSED thì chặn. */
async function periodLocked(branchCode) {
  const period = REPORT_DATE_TEXT.slice(0, 7);
  const rows = await prisma.accountingPeriod.findMany({
    where: { period, branchCode: { in: [branchCode, "ALL"] }, status: "CLOSED" },
    select: { period: true, branchCode: true },
  });
  return rows[0] || null;
}

async function main() {
  console.log(`Ngày báo cáo: ${REPORT_DATE_TEXT} · ca ${SHIFT === "FULL" ? "Cả ngày" : SHIFT}`);
  console.log(APPLY ? "CHẾ ĐỘ: GHI THẬT\n" : "CHẾ ĐỘ: chỉ xem, không ghi gì\n");

  // Giờ Việt Nam nửa đêm, đúng như giao diện lưu (`new Date("2026-07-31T00:00:00")` chạy trên
  // máy chủ đặt múi giờ VN). Ghi lệch múi giờ thì báo cáo lệch nguyên một ngày.
  const reportDate = new Date(`${REPORT_DATE_TEXT}T00:00:00+07:00`);

  let willWrite = 0;
  for (const entry of ENTRIES) {
    const { branchCode, cardAmount, grabAmount, chiTiet } = entry;
    const totalAmount = cardAmount + grabAmount;

    const branch = await prisma.masterDataItem.findFirst({
      where: { type: "BRANCH", code: branchCode, status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true },
    });
    console.log(`── ${branchCode}${branch ? ` (${branch.name})` : ""} ──`);
    console.log(`   Quẹt thẻ/Ví ${vnd(cardAmount).padStart(14)}   Grab ${vnd(grabAmount).padStart(11)}   Tổng ${vnd(totalAmount)}`);
    console.log(`   chi tiết: ${chiTiet.join(" · ")}`);

    if (!branch) {
      console.log(`   BỎ QUA: không có cửa hàng mã ${branchCode} đang hoạt động\n`);
      continue;
    }

    const locked = await periodLocked(branchCode);
    if (locked) {
      console.log(`   BỎ QUA: kỳ ${locked.period} đã chốt sổ\n`);
      continue;
    }

    // Đã có bản ghi theo ca thì cộng "Cả ngày" vào sẽ đếm hai lần — đúng luật của API.
    const conflict = await prisma.manualRevenueEntry.findFirst({
      where: { branchCode, reportDate, shift: { in: ["MORNING", "EVENING"] }, deletedAt: null },
      select: { shift: true },
    });
    if (conflict) {
      console.log(`   BỎ QUA: ngày này đã có bản ghi ca ${conflict.shift}, sửa tay trên giao diện\n`);
      continue;
    }

    const existing = await prisma.manualRevenueEntry.findUnique({
      where: { branchCode_reportDate_shift: { branchCode, reportDate, shift: SHIFT } },
      select: { id: true, cardAmount: true, grabAmount: true, totalAmount: true, createdBy: true },
    });
    if (existing) {
      const same = existing.cardAmount === cardAmount && existing.grabAmount === grabAmount;
      console.log(`   ĐÃ CÓ (${existing.createdBy || "?"}): thẻ/ví ${vnd(existing.cardAmount)}, grab ${vnd(existing.grabAmount)}`);
      console.log(same ? "   -> trùng khớp, không cần ghi lại\n" : "   -> KHÁC số trên, sẽ ghi đè\n");
      if (same) continue;
    } else {
      console.log("   -> sẽ tạo mới\n");
    }
    willWrite += 1;

    if (!APPLY) continue;

    const saved = await prisma.manualRevenueEntry.upsert({
      where: { branchCode_reportDate_shift: { branchCode, reportDate, shift: SHIFT } },
      create: {
        branchCode, reportDate, shift: SHIFT,
        cashAmount: 0, transferAmount: 0, otherAmount: 0,
        cardAmount, grabAmount, totalAmount,
        note: NOTE, createdBy: ACTOR, updatedBy: ACTOR,
      },
      update: { cardAmount, grabAmount, totalAmount, note: NOTE, updatedBy: ACTOR },
    });

    await prisma.auditLog.create({
      data: {
        actorName: ACTOR,
        actorRole: "SCRIPT",
        branchCode,
        module: "REPORTS",
        action: "UPSERT_MANUAL_REVENUE",
        entityType: "ManualRevenueEntry",
        entityId: saved.id,
        entityCode: `${REPORT_DATE_TEXT}-${branchCode}-${SHIFT}`,
        message: NOTE,
        metadataJson: JSON.stringify({
          reportDate: REPORT_DATE_TEXT, shift: SHIFT,
          cashAmount: 0, transferAmount: 0, otherAmount: 0,
          cardAmount, grabAmount, totalAmount,
          nguon: "Zalo chị Bình 17/08/2026", chiTiet,
        }),
      },
    });
    console.log(`   ĐÃ GHI: ${saved.id}\n`);
  }

  if (!APPLY) {
    console.log(`Tổng cộng ${willWrite} bản ghi sẽ được tạo/cập nhật.`);
    console.log("Ghi thật: node scripts/seed-manual-revenue-20260731.cjs --apply --confirm 31-07");
    return;
  }
  console.log("Xong. Bước tiếp theo: npm run backfill:wallet-manual (xem trước) rồi mới --apply.");
}

if (APPLY && CONFIRM !== "31-07") {
  console.error("Cần --confirm 31-07 để ghi thật. Dừng, chưa đụng vào database.");
  process.exit(1);
}

main()
  .catch((error) => { console.error("LỖI:", error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
