/**
 * File CCDC đầu kỳ (OPENING_ASSET_TOOL_V1) có thêm Ngày nhập / Mã đối tác / Tên đối tác (khách
 * 20/10/2026): lưu ở số dư đầu kỳ và lên hồ sơ tài sản (ngày mua, NCC). Mã có mà tên trống thì lấy
 * tên trong danh mục Đối tác; bỏ trống cả ba thì như cũ.
 *
 * DB local, kỳ 2031-01, mã CCDC TEST-ORIGIN-*, tự dọn. npm run test:opening-asset-origin
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport, rollbackImportBatch } from "../lib/import-commit.ts";
import { prisma } from "../lib/prisma.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const session = { name: "test-opening-asset-origin", role: "Admin", allowedBranches: ["ALL"] };
const CODES = ["TEST-ORIGIN-1", "TEST-ORIGIN-2", "TEST-ORIGIN-3"];

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "AssetRecord" WHERE "code" = ANY(${CODES})`;
  await prisma.$executeRaw`DELETE FROM "OpeningBalance" WHERE "objectCode" = ANY(${CODES})`;
}

test("CCDC đầu kỳ lưu ngày nhập + đối tác và đẩy sang hồ sơ tài sản", async (t) => {
  await cleanup();
  const partner = await prisma.masterDataItem.findFirst({ where: { type: "PARTNER", code: "NCC_HAISAN" } });
  assert.ok(partner, "DB local cần đối tác NCC_HAISAN");
  let batchId = null;
  t.after(async () => {
    if (batchId) await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    await cleanup();
    await prisma.$disconnect();
  });

  const headers = ["Kỳ", "Cửa hàng", "Mã CCDC", "Tên CCDC", "Nhóm tài sản", "Số lượng", "Tổng giá trị", "Tổng số kỳ phân bổ", "Số kỳ PB còn lại", "Giá trị đã PB", "Giá trị phân bổ còn lại", "Ngày nhập", "Mã đối tác", "Tên đối tác"];
  const rows = [
    ["2031-01", "NME", CODES[0], "Ly test 1", "CCDC_BEP", 10, 1_200_000, 12, 6, 600_000, 600_000, "15/03/2030", "NCC_HAISAN", "NCC ghi tay"],
    ["2031-01", "NME", CODES[1], "Ly test 2", "CCDC_BEP", 5, 600_000, 6, 3, 300_000, 300_000, "01/06/2030", "NCC_HAISAN", ""],
    ["2031-01", "NME", CODES[2], "Ly test 3", "CCDC_BEP", 1, 120_000, 12, 12, 0, 120_000, "", "", ""],
  ];
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "CCDC");
  const file = new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "ccdc-origin.xlsx");
  const template = getImportTemplate("OPENING_BALANCE", "OPENING_ASSET_TOOL_V1");
  const parsed = await parseImportFile(file, template);
  await validateImportResult(parsed, "OPENING_BALANCE", session, {});
  const errors = parsed.rows.flatMap((row) => row.errors);
  assert.deepEqual(errors, [], errors.join(" / "));
  const batch = await commitImport({ importType: "OPENING_BALANCE", templateCode: template.code, fileName: file.name, uploadedBy: session.name, mapping: parsed.mapping, rows: parsed.rows });
  batchId = batch.id;

  const assets = await prisma.assetRecord.findMany({ where: { code: { in: CODES } }, orderBy: { code: "asc" } });
  assert.equal(assets.length, 3);
  const [a1, a2, a3] = assets;
  assert.equal(a1.purchaseDate.toISOString().slice(0, 10), "2030-03-15");
  assert.equal(a1.supplierCode, "NCC_HAISAN");
  assert.equal(a1.supplierName, "NCC ghi tay", "tên ghi trên file được giữ");
  assert.equal(a2.supplierName, partner.name, "tên trống thì lấy tên trong danh mục");
  assert.equal(a3.purchaseDate.toISOString().slice(0, 10), "2031-01-01", "không khai ngày = đầu kỳ số dư");
  assert.equal(a3.supplierCode, null);
  const opening = await prisma.openingBalance.findFirst({ where: { objectCode: CODES[0] } });
  assert.equal(opening.partnerCode, "NCC_HAISAN");
  assert.equal(opening.purchaseDate.toISOString().slice(0, 10), "2030-03-15");
});
