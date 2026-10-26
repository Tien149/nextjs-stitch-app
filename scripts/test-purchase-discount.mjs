/**
 * Chiết khấu trên dòng phiếu nhập mua / nhận hàng PO (khách 26/10/2026): trừ TRƯỚC thuế; chi phí mua
 * hàng chia theo tiền hàng sau chiết khấu; giá nhập kho = sau thuế + chi phí; công nợ NCC = sau thuế
 * (đã trừ chiết khấu) + chi phí mua hàng.
 *
 * Phần DB chạy trên cửa hàng giả ZDC (tự dọn). Chạy: npm run test:purchase-discount
 */
import assert from "node:assert/strict";
import test from "node:test";
import { prismaRaw } from "../lib/prisma.ts";
import { purchaseLineFigures, resolveDiscount } from "../lib/purchase-discount.ts";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { createPurchasePayable, purchaseLineAmount } from "../lib/purchase-payable.ts";

test("chiết khấu theo % hoặc số tiền, chặn số sai", () => {
  assert.deepEqual(resolveDiscount(1_000_000, "10", ""), { ok: true, rate: 0.1, amount: 100_000 });
  assert.deepEqual(resolveDiscount(1_000_000, "", "25000"), { ok: true, rate: null, amount: 25_000 });
  assert.deepEqual(resolveDiscount(1_000_000, "", ""), { ok: true, rate: null, amount: 0 });
  // Ô % thắng ô số tiền khi cả hai cùng có (giao diện xoá ô kia khi gõ).
  assert.equal(resolveDiscount(200_000, "5", "999").amount, 10_000);
  assert.equal(resolveDiscount(100, "120", "").ok, false);
  assert.equal(resolveDiscount(100, "", "101").ok, false);
  assert.equal(resolveDiscount(100, "", "-1").ok, false);
});

test("đủ các cột: trước thuế → chiết khấu → thuế → sau thuế → chi phí phân bổ → trị giá", () => {
  const [a, b] = purchaseLineFigures([
    { quantity: 10, unitPrice: 100_000, discountRate: "10", vatRate: 0.1 },
    { quantity: 2, unitPrice: 50_000, discountAmount: "0", vatRate: null },
  ], 10_000);
  assert.deepEqual(a, { gross: 1_000_000, discountRate: 0.1, discountAmount: 100_000, net: 900_000, vatAmount: 90_000, afterTax: 990_000, costShare: 9_000, purchaseValue: 999_000 });
  // Chi phí chia theo tiền hàng SAU chiết khấu: 900.000 : 100.000.
  assert.deepEqual(b, { gross: 100_000, discountRate: null, discountAmount: 0, net: 100_000, vatAmount: 0, afterTax: 100_000, costShare: 1_000, purchaseValue: 101_000 });
});

test("công nợ dòng phiếu nhập trừ chiết khấu", () => {
  assert.equal(purchaseLineAmount({ totalCost: 0, inputQuantity: 10, inputUnitCost: 100_000, discountAmount: 100_000 }), 900_000);
  // Dòng cũ chưa có cột chiết khấu giữ nguyên số.
  assert.equal(purchaseLineAmount({ totalCost: 0, inputQuantity: 10, inputUnitCost: 100_000 }), 1_000_000);
});

const BRANCH = "ZDC";
const NCC = "ZDC-NCC";
const ITEM = "ZDC-ITEM";

async function cleanup() {
  await prismaRaw.debtRecord.deleteMany({ where: { branchCode: BRANCH } });
  await prismaRaw.inventoryTransactionLine.deleteMany({ where: { transaction: { branchCode: BRANCH } } });
  await prismaRaw.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prismaRaw.inventoryBalance.deleteMany({ where: { warehouseCode: "ZDC_KHO" } });
  await prismaRaw.inventoryItem.deleteMany({ where: { code: ITEM } });
}

test("DB: phiếu nhập mua có chiết khấu + thuế + chi phí — giá nhập kho và công nợ NCC đúng", async (t) => {
  await cleanup();
  t.after(cleanup);
  const item = await prismaRaw.inventoryItem.create({ data: { code: ITEM, name: "Bơ test", unit: "KG", itemType: "RAW_MATERIAL" } });
  const receipt = await prismaRaw.$transaction((tx) => postInventoryTransaction(tx, {
    code: "NM-ZDC-0001",
    transactionType: "NHAP_MUA",
    transactionDate: new Date("2026-10-26T00:00:00+07:00"),
    branchCode: BRANCH,
    warehouseCode: "ZDC_KHO",
    partnerCode: NCC,
    purchaseCost: 10_000,
    lines: [{ itemId: item.id, inputQuantity: 10, inputUnitCost: 100_000, vatRate: 0.1, discountRate: "10" }],
  }));
  const [line] = receipt.lines;
  assert.equal(line.discountAmount, 100_000);
  assert.equal(line.discountRate, 0.1);
  assert.equal(line.vatAmount, 90_000, "thuế tính trên 900.000 sau chiết khấu");
  assert.equal(line.purchaseCostShare, 10_000);
  assert.equal(Math.round(line.totalCost), 1_000_000, "giá nhập kho = 900.000 + 90.000 thuế + 10.000 chi phí");
  const payable = await createPurchasePayable(prismaRaw, receipt);
  assert.equal(payable.originalAmount, 1_000_000, "nợ NCC = 990.000 sau thuế + 10.000 chi phí");
});
