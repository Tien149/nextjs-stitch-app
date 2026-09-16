/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Bù vế công nợ NỘI BỘ còn thiếu của các phiếu CHI HỘ NHÀ HÀNG KHÁC đã duyệt từ trước.
 *
 * Trước 15/09/2026 phiếu chi hộ chỉ sinh MỘT vế: khoản phải thu `CNTHU-<mã phiếu>` ở sổ nhà
 * hàng đã ứng tiền. Vế còn lại — nhà hàng được chi hộ thôi nợ NCC và quay sang nợ nhà hàng
 * đã ứng tiền — không được ghi, nên bên đó treo công nợ NCC mãi dù tiền đã trả.
 *
 * Script chỉ TẠO khoản `CNTHU-<mã phiếu>-PTR` còn thiếu; không sửa, không xoá gì khác. Phần
 * giảm công nợ NCC là do màn Công nợ đọc thẳng phiếu chi hộ theo nhà hàng được chi hộ nên
 * tự đúng, không cần bù dữ liệu.
 *
 * CHỈ nhận mã đối tác NB-<X> khi X có thật trong danh mục Cửa hàng. Khách đã tự đặt mã kiểu
 * NB-THOA, NB-CHAU cho cá nhân; hiểu nhầm là nhà hàng thì khoản phải trả đối ứng rơi vào một
 * cửa hàng không tồn tại, không màn hình nào nhìn thấy để sửa.
 *
 * Chạy thử:   node scripts/backfill-advance-receivable-counterpart.cjs
 * Ghi thật:   node scripts/backfill-advance-receivable-counterpart.cjs --apply
 * Dọn nhầm:   node scripts/backfill-advance-receivable-counterpart.cjs --clean-orphans [--apply]
 *   (xoá các khoản CNTHU-*-PTR đã tạo cho một "cửa hàng" không có trong danh mục; chỉ xoá
 *    khoản chưa bị gạch nợ lần nào)
 */
const { PrismaClient } = require("@prisma/custom-client");

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const cleanOrphans = args.includes("--clean-orphans");

const INTERNAL_PARTNER_PREFIX = "NB-";
const internalPartnerCode = (branchCode) => `${INTERNAL_PARTNER_PREFIX}${String(branchCode || "").trim().toUpperCase()}`;
function branchCodeFromInternalPartner(partnerCode, knownBranchCodes) {
  const code = String(partnerCode || "").trim().toUpperCase();
  if (!code.startsWith(INTERNAL_PARTNER_PREFIX)) return null;
  const branchCode = code.slice(INTERNAL_PARTNER_PREFIX.length) || null;
  if (!branchCode) return null;
  return knownBranchCodes.has(branchCode) ? branchCode : null;
}

async function loadBranchCodes() {
  const branches = await prisma.masterDataItem.findMany({ where: { type: "BRANCH" }, select: { code: true } });
  return new Set(branches.map((row) => String(row.code || "").trim().toUpperCase()));
}

/**
 * Dọn các khoản phải trả đối ứng đã tạo cho một "cửa hàng" không có trong danh mục — hệ quả
 * của lần chạy trước khi script biết kiểm tra danh mục Cửa hàng.
 */
async function cleanOrphanCounterparts(knownBranchCodes) {
  const suspects = await prisma.debtRecord.findMany({
    where: { code: { startsWith: "CNTHU-", endsWith: "-PTR" }, deletedAt: null },
  });
  const orphans = suspects.filter((row) => !knownBranchCodes.has(String(row.branchCode || "").trim().toUpperCase()));
  if (orphans.length === 0) {
    console.log("Không có khoản phải trả nội bộ nào nằm ở cửa hàng lạ.");
    return;
  }
  let removed = 0;
  for (const debt of orphans) {
    const settlements = await prisma.debtSettlement.count({ where: { debtId: debt.id } });
    if (settlements > 0) {
      console.log(`GIỮ LẠI ${debt.code} (cửa hàng lạ "${debt.branchCode}") — đã bị gạch ${settlements} lần, phải bỏ duyệt phiếu gạch trước rồi xoá tay.`);
      continue;
    }
    console.log(`${apply ? "XOÁ" : "SẼ XOÁ"} ${debt.code}: cửa hàng lạ "${debt.branchCode}", ${debt.outstandingAmount.toLocaleString("vi-VN")} đ`);
    removed += 1;
    if (apply) await prisma.debtRecord.delete({ where: { id: debt.id } });
  }
  console.log(`\nTổng: ${orphans.length} khoản nằm ở cửa hàng lạ · ${removed} khoản ${apply ? "đã xoá" : "sẽ xoá"}`);
  if (!apply) console.log("Chạy thử — thêm --apply để xoá thật.");
}

async function ensureInternalPartner(branchCode) {
  const code = internalPartnerCode(branchCode);
  const existing = await prisma.masterDataItem.findFirst({ where: { type: "PARTNER", code } });
  if (existing) return existing;
  const branch = await prisma.masterDataItem.findFirst({ where: { type: "BRANCH", code: branchCode }, select: { name: true } });
  if (!apply) return { code, name: `${branch?.name || branchCode} (nội bộ)` };
  return prisma.masterDataItem.create({
    data: {
      type: "PARTNER",
      code,
      name: `${branch?.name || branchCode} (nội bộ)`,
      group: "OTHER_PARTNER",
      partnerType: "OTHER_PARTNER",
      partnerGroup: "INTERNAL",
      status: "ACTIVE",
      note: "Tự tạo cho công nợ nội bộ giữa các nhà hàng",
    },
  });
}

async function main() {
  const knownBranchCodes = await loadBranchCodes();
  if (cleanOrphans) return cleanOrphanCounterparts(knownBranchCodes);

  const vouchers = await prisma.financialVoucher.findMany({
    where: {
      voucherType: "PAYMENT",
      status: "APPROVED",
      debtAction: "ACCRUE_RECEIVABLE",
      receivablePartnerCode: { startsWith: INTERNAL_PARTNER_PREFIX },
      deletedAt: null,
    },
    orderBy: { code: "asc" },
  });

  let created = 0;
  let skipped = 0;
  let notBranch = 0;
  for (const voucher of vouchers) {
    const beneficiaryBranch = branchCodeFromInternalPartner(voucher.receivablePartnerCode, knownBranchCodes);
    const payerBranch = String(voucher.branchCode || "").trim().toUpperCase();
    if (!beneficiaryBranch) {
      // Mã NB-<gì đó> nhưng không phải cửa hàng: chi hộ đối tác bên ngoài, một vế là đủ.
      console.log(`BỎ QUA ${voucher.code}: đối tác thu lại [${voucher.receivablePartnerCode}] không có trong danh mục Cửa hàng`);
      notBranch += 1;
      continue;
    }
    if (beneficiaryBranch === payerBranch) { skipped += 1; continue; }

    const code = `CNTHU-${voucher.code}-PTR`;
    const existing = await prisma.debtRecord.findUnique({ where: { code } });
    if (existing) { skipped += 1; continue; }

    const payerPartner = await ensureInternalPartner(payerBranch);
    console.log(`${apply ? "TẠO" : "SẼ TẠO"} ${code}: ${beneficiaryBranch} phải trả ${payerPartner.code} ${voucher.amount.toLocaleString("vi-VN")} đ (phiếu ${voucher.code})`);
    created += 1;
    if (!apply) continue;

    await prisma.debtRecord.create({
      data: {
        code,
        debtType: "PAYABLE",
        partnerGroup: "INTERNAL",
        partnerCode: payerPartner.code,
        partnerName: payerPartner.name,
        branchCode: beneficiaryBranch,
        documentDate: voucher.voucherDate,
        categoryCode: voucher.categoryCode,
        originalAmount: voucher.amount,
        outstandingAmount: voucher.amount,
        description: `Hoàn lại ${payerBranch} khoản đã chi hộ theo chứng từ ${voucher.code}: ${voucher.description}`,
        sourceType: "VOUCHER",
        sourceId: voucher.id,
        status: "OPEN",
      },
    });
  }

  // Khoản CNTHU cũ bị gắn nhãn EXTERNAL nên màn Công nợ xếp nhà hàng nhà mình vào nhóm
  // "Bên ngoài" và bộ lọc Nội bộ không thấy.
  const mislabeled = (await prisma.debtRecord.findMany({
    where: { code: { startsWith: "CNTHU-" }, partnerGroup: "EXTERNAL", partnerCode: { startsWith: INTERNAL_PARTNER_PREFIX }, deletedAt: null },
    select: { id: true, code: true, partnerCode: true },
  })).filter((row) => branchCodeFromInternalPartner(row.partnerCode, knownBranchCodes));
  if (mislabeled.length > 0) {
    console.log(`${apply ? "SỬA" : "SẼ SỬA"} nhãn nội bộ cho ${mislabeled.length} khoản CNTHU: ${mislabeled.map((row) => row.code).join(", ")}`);
    if (apply) {
      await prisma.debtRecord.updateMany({ where: { id: { in: mislabeled.map((row) => row.id) } }, data: { partnerGroup: "INTERNAL" } });
    }
  }

  console.log(`\nTổng: ${vouchers.length} phiếu · ${created} khoản phải trả ${apply ? "đã tạo" : "sẽ tạo"} · ${skipped} phiếu bỏ qua (đã có hoặc không liên nhà hàng) · ${notBranch} phiếu chi hộ đối tác không phải nhà hàng`);
  if (!apply) console.log("Chạy thử — thêm --apply để ghi thật.");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
