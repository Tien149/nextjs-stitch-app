/**
 * Xuất trả hàng NCC đúng phiếu nhập (khách 24/10/2026): số giảm nợ = SL trả × (đơn giá + thuế trên
 * phiếu nhập gốc), gạch thẳng vào công nợ CN-<phiếu nhập>; sửa / xoá phiếu trả thì trả lại đúng.
 *
 * Chạy trên DB local với cửa hàng TRN, tự dọn sạch. Chạy: npm run test:supplier-return
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createPurchasePayable, removePurchasePayables, syncPurchasePayable } from "../lib/purchase-payable.ts";
import { planInventoryCogsJournal } from "../lib/inventory-cogs.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();
const BRANCH = "TRN";
const NCC = "TRN-NCC";

async function cleanup() {
  await prisma.debtSettlement.deleteMany({ where: { debt: { branchCode: BRANCH } } });
  await prisma.debtRecord.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryTransactionLine.deleteMany({ where: { transaction: { branchCode: BRANCH } } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryItem.deleteMany({ where: { code: "TRN-ITEM" } });
  await prisma.masterDataItem.deleteMany({ where: { OR: [{ type: "PARTNER", code: NCC }, { type: "BRANCH", code: BRANCH }] } });
}

test("trả hàng NCC gạch đúng công nợ phiếu nhập gốc", async (t) => {
  await cleanup();
  t.after(async () => { await cleanup(); await prisma.$disconnect(); });
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "NH test trả hàng", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PARTNER", code: NCC, name: "NCC test", status: "ACTIVE" } });
  const item = await prisma.inventoryItem.create({ data: { code: "TRN-ITEM", name: "Bơ", unit: "KG", itemType: "RAW_MATERIAL" } });
  // Phiếu nhập: 10 KG × 100.000 đ, thuế 8% = 80.000 → nợ 1.080.000 (108.000 đ/KG).
  const receipt = await prisma.inventoryTransaction.create({
    data: {
      code: "NM-TRN-0001", transactionType: "NHAP_MUA", transactionDate: new Date("2026-10-10T00:00:00Z"), branchCode: BRANCH, warehouseCode: "TRN_KHO", partnerCode: NCC,
      lines: { create: [{ itemId: item.id, quantity: 10, unitCost: 108000, totalCost: 1080000, inputQuantity: 10, inputUnitCost: 100000, conversionRate: 1, vatAmount: 80000 }] },
    },
    include: { lines: true },
  });
  const payable = await createPurchasePayable(prisma, receipt);
  assert.equal(payable.originalAmount, 1080000);

  // Trả 3 KG, giá vốn kho đang 95.000 đ/KG → kho trừ 285.000; nợ giảm 3 × 108.000 = 324.000.
  const returned = await prisma.inventoryTransaction.create({
    data: {
      code: "XTN-TRN-0001", transactionType: "XUAT_TRA_NCC", transactionDate: new Date("2026-10-12T00:00:00Z"), branchCode: BRANCH, warehouseCode: "TRN_KHO", partnerCode: NCC, referenceCode: receipt.code,
      lines: { create: [{ itemId: item.id, quantity: 3, unitCost: 95000, totalCost: 285000, inputQuantity: 3, inputUnitCost: 0, conversionRate: 1 }] },
    },
    include: { lines: true },
  });
  const receivable = await createPurchasePayable(prisma, returned);
  assert.equal(receivable.debtType, "RECEIVABLE");
  assert.equal(receivable.originalAmount, 324000);
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: payable.id } })).outstandingAmount, 756000, "phiếu nhập còn nợ 1.080.000 − 324.000");
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: receivable.id } })).status, "SETTLED");

  // Bút toán: Nợ 331 324.000 / Có 152 285.000 / Có 632 39.000 (chênh giá phiếu nhập − giá vốn).
  const lines = planInventoryCogsJournal({ transactionType: "XUAT_TRA_NCC", warehouseGroup: "KHO BẾP", partnerCode: NCC, supplierReturnAmount: 324000, lines: [{ totalCost: 285000 }] });
  assert.deepEqual(lines.find((line) => line.accountCode === "331"), { accountCode: "331", debit: 324000, partnerCode: NCC });
  assert.deepEqual(lines.find((line) => line.accountCode === "152"), { accountCode: "152", credit: 285000 });
  assert.equal(lines.find((line) => line.accountCode === "632").credit, 39000);

  // Sửa phiếu trả còn 2 KG → gạch lại 216.000.
  await prisma.inventoryTransactionLine.updateMany({ where: { transactionId: returned.id }, data: { quantity: 2, inputQuantity: 2, totalCost: 190000 } });
  await syncPurchasePayable(prisma, await prisma.inventoryTransaction.findUnique({ where: { id: returned.id }, include: { lines: true } }));
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: payable.id } })).outstandingAmount, 864000);

  // Không xoá được phiếu nhập khi còn phiếu trả; xoá phiếu trả thì phiếu nhập về đủ nợ.
  await assert.rejects(() => removePurchasePayables(prisma, [receipt.code]), /phiếu xuất trả hàng/);
  await removePurchasePayables(prisma, [returned.code]);
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: payable.id } })).outstandingAmount, 1080000);
  assert.equal((await prisma.debtRecord.findUnique({ where: { id: payable.id } })).status, "OPEN");
});
