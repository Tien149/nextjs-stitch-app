/**
 * Bộ test chốt cho đợt sửa Kho & Định lượng 20/08/2026 (theo plan trong
 * doc/MD/claude/claude_audit_kho_dinh_luong_2026-08-20.md). Chạy trên DB thật,
 * dùng dữ liệu tổng hợp đặt ở năm 2098-2099 + mã *_KFTEST để không đụng dữ liệu thường,
 * và tự dọn sạch kể cả khi test hỏng giữa chừng.
 *
 * Chạy: npm run test:inventory-fixes
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseImportFile } from "../lib/import-parser.ts";
import { getImportTemplate } from "../lib/import-templates.ts";
import { validateImportResult } from "../lib/import-validation.ts";
import { commitImport, rollbackImportBatch } from "../lib/import-commit.ts";
import { nextStockDocCode, postInventoryTransaction } from "../lib/inventory-stock.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const session = { name: "test-kho", role: "Admin", allowedBranches: ["ALL"] };
const BRANCH = "NME";
const WH = "KHO_KFTEST";
const WH2 = "KHO_KFTEST2";
const NVL = "NVL_KFTEST01";
const NVL_NOCOST = "NVL_KFTEST02";
const BTP = "BTP_KFTEST01";
const ASSET_CODE = "TS-KFTEST-0001";
const LOCKED_PERIOD = "2098-12";
const batchIds = [];

function fileFrom(headers, rows, sheetName, fileName) {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return new File([XLSX.write(book, { type: "buffer", bookType: "xlsx" })], fileName);
}

async function runImport(importType, templateCode, file, { expectErrors = false } = {}) {
  const template = getImportTemplate(importType, templateCode);
  const parsed = await parseImportFile(file, template);
  await validateImportResult(parsed, importType, session, {});
  const errors = parsed.rows.flatMap((row) => row.errors);
  if (expectErrors) return { parsed, errors };
  assert.deepEqual(errors, [], `file phải sạch lỗi: ${errors.join(" / ")}`);
  const batch = await commitImport({
    importType, templateCode, fileName: file.name,
    uploadedBy: session.name, mapping: parsed.mapping, rows: parsed.rows,
  });
  batchIds.push(batch.id);
  return { parsed, batch, errors };
}

async function cleanup() {
  for (const batchId of batchIds.reverse()) {
    await rollbackImportBatch({ batchId, actor: session.name, note: "don test" }).catch(() => undefined);
    await prisma.importBatch.deleteMany({ where: { id: batchId } }).catch(() => undefined);
  }
  const items = await prisma.inventoryItem.findMany({ where: { code: { contains: "KFTEST" } }, select: { id: true } });
  const itemIds = items.map((item) => item.id);
  await prisma.inventoryTransactionLine.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryTransaction.deleteMany({ where: { OR: [{ warehouseCode: { contains: "KFTEST" } }, { code: { contains: "-2099-" } }, { code: { contains: "-2098-" } }] } });
  await prisma.stocktakeLine.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.stocktakeSession.deleteMany({ where: { warehouseCode: { contains: "KFTEST" } } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.recipeLine.deleteMany({ where: { recipe: { productCode: { contains: "KFTEST" } } } });
  await prisma.recipe.deleteMany({ where: { productCode: { contains: "KFTEST" } } });
  await prisma.itemUnitConversion.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { code: { contains: "KFTEST" } } });
  await prisma.assetStocktakeLine.deleteMany({ where: { asset: { code: ASSET_CODE } } });
  await prisma.assetStocktakeSession.deleteMany({ where: { code: { startsWith: "KKTS-2099-" } } });
  await prisma.assetRecord.deleteMany({ where: { code: ASSET_CODE } });
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: { in: [WH, WH2] } } });
  await prisma.accountingPeriod.deleteMany({ where: { period: LOCKED_PERIOD, branchCode: BRANCH } });
}

test("kho & định lượng: các fix của đợt 20/08", async (t) => {
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await cleanup(); // dọn tàn dư của lần chạy hỏng trước (nếu có)

  await prisma.masterDataItem.createMany({ data: [
    { type: "WAREHOUSE", code: WH, name: "Kho test KF", branch: BRANCH, status: "ACTIVE" },
    { type: "WAREHOUSE", code: WH2, name: "Kho test KF 2", branch: BRANCH, status: "ACTIVE" },
  ] });
  await prisma.accountingPeriod.create({ data: { period: LOCKED_PERIOD, branchCode: BRANCH, status: "CLOSED", closedBy: "test" } });

  await t.test("mã phiếu kho nối sau max, không rơi vào lỗ hổng do xoá/rollback", async () => {
    await prisma.inventoryTransaction.createMany({ data: [
      { code: "NK-2099-0001", transactionType: "NHAP_KHAC", transactionDate: new Date("2099-06-01"), branchCode: BRANCH, warehouseCode: WH },
      { code: "NK-2099-0003", transactionType: "NHAP_KHAC", transactionDate: new Date("2099-06-01"), branchCode: BRANCH, warehouseCode: WH },
    ] });
    const next = await nextStockDocCode(prisma, "NK", new Date("2099-06-02"));
    assert.equal(next, "NK-2099-0004", "count+1 cũ sẽ trả 0003 và nổ trùng mã");
  });

  await t.test("import mặt hàng: đủ trường, nhiều ĐVT, không ghi đè cột không map", async () => {
    const headers = ["Mã mặt hàng", "Tên mặt hàng", "Loại hàng", "Đơn vị tính", "DVT mua", "Ty le quy doi", "Ghi chu quy doi", "Tồn tối thiểu", "Yêu cầu hình ảnh (1/0)", "ĐVT mua mặc định (1/0)", "Ghi chú", "Trạng thái"];
    await runImport("INVENTORY_ITEM", "INVENTORY_ITEM_STANDARD_V1", fileFrom(headers, [
      [NVL, "Duong test KF", "RAW_MATERIAL", "g", "kg", 1000, "1 kg = 1000 g", 500, 1, 1, "Hang test", "ACTIVE"],
      [NVL, "Duong test KF", "RAW_MATERIAL", "g", "bao", 50000, "1 bao = 50 kg", 500, "", 0, "", ""],
      [NVL_NOCOST, "Tra test KF", "RAW_MATERIAL", "goi", "", "", "", 0, "", "", "", ""],
      [BTP, "Sot test KF", "SEMI_FINISHED", "phan", "", "", "", 0, "", "", "", ""],
    ], "Danh muc", "items.xlsx"));

    const item = await prisma.inventoryItem.findUnique({ where: { code: NVL }, include: { unitConversions: true } });
    assert.equal(item.note, "Hang test");
    assert.equal(item.requiresImage, true);
    assert.equal(item.minStock, 500);
    assert.equal(item.unitConversions.length, 3, "ĐVT cơ bản + 2 ĐVT mua");
    const defaults = item.unitConversions.filter((unit) => unit.isDefaultPurchase);
    assert.deepEqual(defaults.map((unit) => unit.unitCode), ["KG"], "chỉ đúng một ĐVT mua mặc định");

    // Re-import KHÔNG có cột requires_image/note -> giữ nguyên giá trị cũ, không reset
    await runImport("INVENTORY_ITEM", "INVENTORY_ITEM_STANDARD_V1", fileFrom(
      ["Mã mặt hàng", "Tên mặt hàng", "Loại hàng", "Đơn vị tính"],
      [[NVL, "Duong test KF doi ten", "RAW_MATERIAL", "g"]], "Danh muc", "items2.xlsx"));
    const after = await prisma.inventoryItem.findUnique({ where: { code: NVL } });
    assert.equal(after.name, "Duong test KF doi ten");
    assert.equal(after.requiresImage, true, "cột không map thì không được reset");
    assert.equal(after.note, "Hang test");

    // Ma MOI sai tien to -> chan; ma CU sai tien to (danh muc cu) -> cho qua
    const { errors } = await runImport("INVENTORY_ITEM", "INVENTORY_ITEM_STANDARD_V1", fileFrom(
      ["Mã mặt hàng", "Tên mặt hàng", "Loại hàng", "Đơn vị tính"],
      [["SAITIENTO_KFTEST", "Sai tien to", "RAW_MATERIAL", "g"]], "Danh muc", "items3.xlsx"), { expectErrors: true });
    assert.match(errors.join(" "), /NVL_/, "mã mới phải theo tiền tố NVL_");
  });

  await t.test("BOM 2 ngày hiệu lực = 2 phiên bản; chế biến chọn đúng bản theo ngày; rollback hoàn giá vốn", async () => {
    const bomHeaders = ["Ma san pham", "Ten san pham", "Gia ban", "Ma nguyen lieu", "So luong dinh muc", "Hao hut %", "Ngay ap dung", "Ghi chu"];
    await runImport("BOM", "BOM_STANDARD_V1", fileFrom(bomHeaders, [
      [BTP, "Sot test KF", 45000, NVL, 20, 0, "01/01/2099", "V1"],
      [BTP, "Sot test KF", 45000, NVL, 25, 0, "01/02/2099", "V2 tang duong"],
    ], "BOM", "bom.xlsx"));
    const recipes = await prisma.recipe.findMany({ where: { productCode: BTP }, orderBy: { version: "asc" } });
    assert.equal(recipes.length, 2, "hai ngày hiệu lực phải thành 2 phiên bản, không dính thành 1");
    assert.equal(recipes[0].note, "V1");

    // Cho NVL ton kho co gia von bang import NHAP_MUA (100.000 g @ 100 d/g)
    const txHeaders = ["Ngay", "Loai giao dich", "Cua hang", "Kho xuat / nhap", "Ma mat hang", "So luong", "DVT", "Don gia", "NCC / Doi tuong", "So chung tu"];
    const { batch: buyBatch } = await runImport("INVENTORY_TRANSACTION", "INVENTORY_TRANSACTION_STANDARD_V1", fileFrom(txHeaders, [
      ["05/01/2099", "NHAP_MUA", BRANCH, WH, NVL, 100000, "g", 100, "", ""],
    ], "NhapXuat", "buy.xlsx"));
    const bought = await prisma.inventoryTransaction.findFirst({ where: { importBatchId: buyBatch.id } });
    assert.equal(bought.transactionType, "NHAP_MUA");

    // Che bien NGAY 15/01/2099 -> phai an theo V1 (20 g/phan), khong phai V2 (25)
    const prodHeaders = ["Ngay che bien", "Cua hang", "Kho xuat NVL", "Kho nhap BTP", "Ma ban thanh pham", "So luong che bien", "So chung tu", "Ghi chu"];
    const { batch: prodBatch } = await runImport("PRODUCTION", "PRODUCTION_STANDARD_V1", fileFrom(prodHeaders, [
      ["15/01/2099", BRANCH, WH, "", BTP, 10, "", "Nau thu"],
    ], "Che bien", "prod.xlsx"));
    const issue = await prisma.inventoryTransaction.findFirst({ where: { importBatchId: prodBatch.id, transactionType: "XUAT_CHE_BIEN" }, include: { lines: true } });
    assert.equal(issue.lines[0].quantity, 200, "10 phần × 20 g theo V1 — chọn V2 (250) là sai ngày hiệu lực");
    const btpBalance = await prisma.inventoryBalance.findFirst({ where: { warehouseCode: WH, item: { code: BTP } } });
    assert.equal(btpBalance.quantity, 10);
    assert.equal(Math.round(btpBalance.averageCost), 2000, "giá vốn BTP = 200 g × 100 đ / 10 phần");

    // Rollback lenh che bien -> ton va gia von NVL tro ve nguyen trang
    await rollbackImportBatch({ batchId: prodBatch.id, actor: session.name, note: "test" });
    const nvlBalance = await prisma.inventoryBalance.findFirst({ where: { warehouseCode: WH, item: { code: NVL } } });
    assert.equal(nvlBalance.quantity, 100000);
    assert.equal(Math.round(nvlBalance.averageCost), 100);

    // Rollback phieu NHAP_MUA @100 sau khi da co ton 0 @0 truoc do -> avg khong duoc ket lai
    await rollbackImportBatch({ batchId: buyBatch.id, actor: session.name, note: "test" });
    const emptied = await prisma.inventoryBalance.findFirst({ where: { warehouseCode: WH, item: { code: NVL } } });
    assert.equal(emptied.quantity, 0, "rollback nhập mua phải trả hết số lượng");
  });

  await t.test("khoá kỳ chặn import phiếu kho ngay ở preview", async () => {
    const txHeaders = ["Ngay", "Loai giao dich", "Cua hang", "Kho xuat / nhap", "Ma mat hang", "So luong", "DVT", "Don gia"];
    const { errors } = await runImport("INVENTORY_TRANSACTION", "INVENTORY_TRANSACTION_STANDARD_V1", fileFrom(txHeaders, [
      ["15/12/2098", "NHAP_MUA", BRANCH, WH, NVL, 10, "g", 100],
    ], "NhapXuat", "locked.xlsx"), { expectErrors: true });
    assert.match(errors.join(" "), /đã khóa sổ/);
  });

  await t.test("kiểm kê: hàng thừa chưa có giá vốn phải khai Đơn giá; số phiếu + ghi chú vào sổ", async () => {
    const stHeaders = ["Ngay kiem ke", "Cua hang", "Kho", "Ma hang", "Ton thuc te", "Don gia", "Ly do", "So phieu", "Ghi chu phieu"];
    const { errors } = await runImport("STOCKTAKE", "STOCKTAKE_STANDARD_V1", fileFrom(stHeaders, [
      ["10/06/2099", BRANCH, WH, NVL_NOCOST, 50, "", "Kiem ke", "", ""],
    ], "KiemKe", "st1.xlsx"), { expectErrors: true });
    assert.match(errors.join(" "), /gia von/i, "thừa hàng giá vốn 0 mà không khai Đơn giá phải bị chặn");

    const { batch } = await runImport("STOCKTAKE", "STOCKTAKE_STANDARD_V1", fileFrom(stHeaders, [
      ["10/06/2099", BRANCH, WH, NVL_NOCOST, 50, 2000, "Kiem ke", "KK-KFTEST-01", "Phien test"],
    ], "KiemKe", "st2.xlsx"));
    const sessionRow = await prisma.stocktakeSession.findFirst({ where: { code: "KK-KFTEST-01" } });
    assert.ok(sessionRow, "số phiếu tự đặt phải được dùng");
    assert.equal(sessionRow.note, "Phien test");
    const balance = await prisma.inventoryBalance.findFirst({ where: { warehouseCode: WH, item: { code: NVL_NOCOST } } });
    assert.equal(balance.quantity, 50);
    assert.equal(Math.round(balance.averageCost), 2000, "phần thừa phải mang giá đã khai, không phải 0");
    await rollbackImportBatch({ batchId: batch.id, actor: session.name, note: "test" });
  });

  // Khoá lạc quan của APPROVE_STOCKTAKE nằm trong route handler (kéo theo next/server nên
  // không import được dưới node thuần) — kiểm bằng UAT tay: mở tab Kiểm kê, lập 1 phiếu xuất
  // ở tab khác, quay lại bấm Duyệt -> phải bị chặn với thông báo "đã thay đổi".

  await t.test("chuyển kho từ kho có giá vốn 0 bị chặn", async () => {
    const item = await prisma.inventoryItem.findUnique({ where: { code: NVL } });
    await prisma.inventoryBalance.upsert({
      where: { itemId_warehouseCode: { itemId: item.id, warehouseCode: WH2 } },
      create: { itemId: item.id, warehouseCode: WH2, quantity: 80, averageCost: 0 },
      update: { quantity: 80, averageCost: 0 },
    });
    await assert.rejects(
      prisma.$transaction((tx) => postInventoryTransaction(tx, {
        code: "DCK-KFTEST-01", transactionType: "DIEU_CHUYEN", transactionDate: new Date("2099-06-21"),
        branchCode: BRANCH, warehouseCode: WH2, toWarehouseCode: WH,
        lines: [{ itemCode: NVL, inputQuantity: 10, inputUnitCost: 0 }],
      })),
      /chua co gia von/,
    );
  });

  await t.test("kiểm kê CCDC & Tài sản: import cập nhật số sổ sách, rollback trả lại", async () => {
    await prisma.assetRecord.create({ data: {
      code: ASSET_CODE, name: "May test KF", branchCode: BRANCH, assetGroup: "CCDC_BEP",
      quantity: 5, purchaseDate: new Date("2099-01-01"), originalCost: 1000000, currentValue: 1000000,
      supplierName: "Test", status: "IN_USE",
    } });
    const headers = ["Ngay kiem ke", "Cua hang", "Ma tai san", "So dem thuc te", "Tinh trang", "Ghi chu"];
    const { batch } = await runImport("ASSET_STOCKTAKE", "ASSET_STOCKTAKE_STANDARD_V1", fileFrom(headers, [
      ["30/06/2099", BRANCH, ASSET_CODE, 3, "Hong 2 cai", "Thieu so voi so sach"],
    ], "KiemKeTS", "ast.xlsx"));
    const asset = await prisma.assetRecord.findUnique({ where: { code: ASSET_CODE } });
    assert.equal(asset.quantity, 3, "duyệt kiểm kê phải lấy số đếm làm số sổ sách");
    const kkSession = await prisma.assetStocktakeSession.findFirst({ where: { importBatchId: batch.id }, include: { lines: true } });
    assert.equal(kkSession.lines[0].varianceQuantity, -2);

    await rollbackImportBatch({ batchId: batch.id, actor: session.name, note: "test" });
    const restored = await prisma.assetRecord.findUnique({ where: { code: ASSET_CODE } });
    assert.equal(restored.quantity, 5, "rollback phải trả số sổ sách về trước kiểm kê");
  });

  await t.test("kiểm kê kho từ chối CCDC/Tài sản (itemType TOOL)", async () => {
    await prisma.inventoryItem.create({ data: { code: "CCDC_KFTEST01", name: "Keo test", unit: "cai", itemType: "TOOL", status: "ACTIVE" } });
    const stHeaders = ["Ngay kiem ke", "Cua hang", "Kho", "Ma hang", "Ton thuc te"];
    const { errors } = await runImport("STOCKTAKE", "STOCKTAKE_STANDARD_V1", fileFrom(stHeaders, [
      ["10/06/2099", BRANCH, WH, "CCDC_KFTEST01", 5],
    ], "KiemKe", "st3.xlsx"), { expectErrors: true });
    assert.match(errors.join(" "), /Tai san & khau hao/);
  });
});
