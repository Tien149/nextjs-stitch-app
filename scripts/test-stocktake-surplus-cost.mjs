/**
 * Import kiểm kê đếm THỪA ở kho chưa có giá vốn (khách chốt 15/10/2026): không bắt khai "Đơn giá"
 * nữa mà lấy giá mua gần nhất / giá kho khác (latestKnownUnitCost). Chỉ mã chưa có giá ở kho nào
 * mới còn báo lỗi ngay ở bước xem trước.
 *
 * Chạy trên DB thật với mã *_SPC, cửa hàng SPC riêng, ngày năm 2031 và tự dọn sạch.
 *
 * Chạy: npm run test:stocktake-surplus-cost
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport, rollbackImportBatch } from "../lib/import-commit.ts";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const session = { name: "test-stocktake-surplus-cost", role: "Admin", allowedBranches: ["ALL"] };
const BRANCH = "SPC";
const KITCHEN = "KBEP_SPC";
const BAR = "KBAR_SPC";
const PRICED = "NVL_SPC_DAO";
const UNPRICED = "NVL_SPC_BOTNGO";
const day = (value) => new Date(`${value}T00:00:00.000Z`);
const batchIds = [];

function fileFrom(rows) {
  const sheet = XLSX.utils.aoa_to_sheet([["Ngay kiem ke", "Cua hang", "Kho", "Ma hang", "Ton thuc te", "Don gia"], ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Kiem ke");
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], "kk-spc.xlsx");
}

async function preview(rows) {
  const template = getImportTemplate("STOCKTAKE", "STOCKTAKE_STANDARD_V1");
  const parsed = await parseImportFile(fileFrom(rows), template);
  await validateImportResult(parsed, "STOCKTAKE", session, {});
  return { template, parsed };
}

async function cleanup() {
  for (const batchId of batchIds) {
    await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    await prisma.importBatch.deleteMany({ where: { id: batchId } }).catch(() => undefined);
  }
  const itemIds = (await prisma.inventoryItem.findMany({ where: { code: { in: [PRICED, UNPRICED] } }, select: { id: true } })).map((row) => row.id);
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.stocktakeSession.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: { in: [KITCHEN, BAR] } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH } });
}

test("kiểm thừa ở kho chưa có giá lấy giá mua gần nhất", async (t) => {
  await cleanup();
  t.after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test giá kiểm thừa", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: KITCHEN, name: "Kho bếp SPC", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: BAR, name: "Kho bar SPC", branch: BRANCH, group: "BAR", status: "ACTIVE" } });
  const priced = await prisma.inventoryItem.create({ data: { code: PRICED, name: "Đào test", itemType: "RAW_MATERIAL", unit: "G" } });
  await prisma.inventoryItem.create({ data: { code: UNPRICED, name: "Bột ngò test", itemType: "RAW_MATERIAL", unit: "G" } });
  // Chỉ mua vào BAR @ 60 đ/g — bếp chưa từng nhập.
  await prisma.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM_SPC_1", transactionType: "NHAP_MUA", transactionDate: day("2031-01-01"),
    branchCode: BRANCH, warehouseCode: BAR, createdBy: session.name,
    lines: [{ itemId: priced.id, inputQuantity: 1000, inputUnitCode: "G", inputUnitCost: 60 }],
  }));

  // Mã chưa có giá ở kho nào vẫn bắt khai Đơn giá; mã có giá ở kho khác thì không.
  const blocked = await preview([
    ["2031-01-31", BRANCH, KITCHEN, PRICED, 50, ""],
    ["2031-01-31", BRANCH, KITCHEN, UNPRICED, 20, ""],
  ]);
  assert.deepEqual(blocked.parsed.rows[0].errors, [], "Đào có giá ở bar → không lỗi");
  assert.match(blocked.parsed.rows[1].errors.join(" "), /chua co gia von o kho nao/);

  // Khai giá cho bột ngò thì cả file qua và ghi được.
  const { template, parsed } = await preview([
    ["2031-01-31", BRANCH, KITCHEN, PRICED, 50, ""],
    ["2031-01-31", BRANCH, KITCHEN, UNPRICED, 20, 15],
  ]);
  assert.deepEqual(parsed.rows.flatMap((row) => row.errors), []);
  const batch = await commitImport({
    importType: "STOCKTAKE", templateCode: template.code, fileName: "kk-spc.xlsx",
    uploadedBy: session.name, mapping: parsed.mapping, rows: parsed.rows,
  });
  batchIds.push(batch.id);

  const docs = await prisma.inventoryTransaction.findMany({
    where: { branchCode: BRANCH, transactionType: "NHAP_KIEM_KE", deletedAt: null },
    include: { lines: { include: { item: true } } },
  });
  const lines = new Map(docs.flatMap((doc) => doc.lines).map((line) => [line.item.code, line]));
  assert.equal(lines.get(PRICED).quantity, 50);
  assert.ok(Math.abs(lines.get(PRICED).unitCost - 60) < 0.0001, "phần thừa lấy giá mua gần nhất 60 đ/g");
  assert.ok(Math.abs(lines.get(UNPRICED).unitCost - 15) < 0.0001, "mã chưa có giá dùng đơn giá khai");
});
