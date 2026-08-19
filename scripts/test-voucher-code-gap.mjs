/**
 * Chốt lỗi "Dữ liệu bị trùng với bản ghi đã tồn tại" khi import sao kê (chị Bình báo 18/08/2026):
 * mã phiếu từng sinh bằng COUNT + 1, nên sau một lần rollback xoá phiếu giữa chuỗi, mã cấp lại
 * đâm trúng phiếu còn sống của batch sau. Test dựng đúng cái lỗ hổng đó (có 00001 và 00003,
 * thiếu 00002) rồi import thật: mã mới phải là 00004 — nối sau max, không rơi vào lỗ.
 *
 * Chạy: npm run test:voucher-code-gap
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport, rollbackImportBatch } from "../lib/import-commit.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const session = { name: "test-code-gap", role: "Admin", allowedBranches: ["ALL"] };
const template = getImportTemplate("BANK_STATEMENT", "BANK_STATEMENT_STANDARD_V1");

// Tháng 01/2099: chắc chắn không đụng dữ liệu thật, không có kỳ kế toán nào bị khóa.
const PREFIX = "UNC-9901-NME-";
const SEEDED = [`${PREFIX}00001`, `${PREFIX}00003`]; // thiếu 00002 — như sau một lần rollback
const TXN_CODE = "TESTGAP0001";

/** Một dòng chi trả NCC đúng hình dạng file sao kê chuẩn của khách. */
function bankFile() {
  const header = [
    "Ngày giao dịch", "Tài khoản", "Số tham chiếu", "Diễn giải", "Ghi nợ", "Ghi có", "Số dư",
    "Cửa hàng", "Gợi ý đối tác", "Loại thu/chi", "Ngày nguồn tiền", "Ngày doanh thu",
    "Nguồn tiền tổng", "Cộng nguồn tiền chi tiết", "Trừ nguồn tiền chi tiết", "Loại nghiệp vụ đích",
    "Ngày hạch toán", "Mã đối tác", "Hạng mục P&L", "Mã công nợ", "Mã tiền cọc",
    "Gross doanh thu Ví", "Phí Grab", "Phí cà thẻ/Ví khác",
  ];
  const row = [
    "01/01/2099", "TESTACC999", TXN_CODE, "Test lo hong ma phieu", 1000000, 0, "",
    "NME", "", "CHI_NCC_THANG_NAY", "01/01/2099", "01/01/2099",
    "FDSVIETBINH", "FDSVIETBINH", "FDSVIETBINH", "",
    "01/01/2099", "VE00044", "", "", "", "", "", "",
  ];
  const sheet = XLSX.utils.aoa_to_sheet([header, row]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Import chuyển khoản");
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "gap.xlsx");
}

test("mã phiếu nối sau số lớn nhất đã cấp, không rơi vào lỗ hổng do rollback để lại", async (t) => {
  let batchId = null;
  t.after(async () => {
    if (batchId) await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    if (batchId) await prisma.importBatch.delete({ where: { id: batchId } }).catch(() => undefined);
    await prisma.financialVoucher.deleteMany({ where: { code: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  for (const code of SEEDED) {
    await prisma.financialVoucher.create({
      data: {
        code, voucherType: "PAYMENT", documentChannel: "BANK", voucherDate: new Date("2099-01-01T00:00:00Z"),
        partnerName: "Test", branchCode: "NME", moneySourceCode: "FDSVIETBINH",
        amount: 1, description: "Gia lap phieu con song sau rollback", status: "APPROVED",
      },
    });
  }

  const parsed = await parseImportFile(bankFile(), template, { defaultValues: { branch_code: "NME" } });
  await validateImportResult(parsed, "BANK_STATEMENT", session, {});
  const errors = parsed.rows.flatMap((row) => row.errors);
  assert.deepEqual(errors, [], `file test phải sạch lỗi: ${errors.join(" / ")}`);

  const batch = await commitImport({
    importType: "BANK_STATEMENT", templateCode: template.code, fileName: "gap.xlsx",
    uploadedBy: session.name, branchCode: "NME", mapping: parsed.mapping, rows: parsed.rows,
  });
  batchId = batch.id;

  const created = await prisma.financialVoucher.findFirst({
    where: { importBatchId: batch.id },
    select: { code: true },
  });
  assert.ok(created, "commit phải tạo được phiếu chi");
  // COUNT + 1 cũ sẽ cho 00003 (đếm được 2 phiếu) và nổ P2002. Max + 1 phải cho 00004.
  assert.equal(created.code, `${PREFIX}00004`);
});
