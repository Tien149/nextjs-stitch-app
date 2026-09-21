/**
 * Luật sinh công nợ phải trả từ phiếu NHẬP MUA (chốt với khách 21/09/2026).
 *
 * Bốn cửa chặn phải đứng vững, vì mở sai cửa nào cũng là nợ NCC sai số: chỉ nhập mua, phải có
 * NCC, phải có giá trị, và KHÔNG áp cho hàng nhận theo Đơn mua hàng (đã có SupplierPayable —
 * ghi thêm là nợ gấp đôi).
 *
 * Chạy: npm run test:purchase-payable
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPurchasePayable, purchasePayableCodeOf, PURCHASE_PAYABLE_SOURCE } from "../lib/purchase-payable.ts";

/** Prisma giả: ghi lại lời gọi create để khỏi cần database. */
function fakeTx(partner = { name: "NCC Hải sản", partnerGroup: "EXTERNAL" }) {
  const created = [];
  return {
    created,
    masterDataItem: { findFirst: async () => partner },
    debtRecord: { create: async ({ data }) => { created.push(data); return { id: "debt-1", ...data }; } },
  };
}

const phieuNhapMua = {
  id: "tx-1",
  code: "NM-2026-0910",
  transactionType: "NHAP_MUA",
  transactionDate: new Date("2026-09-15T00:00:00.000Z"),
  branchCode: "NME",
  partnerCode: "NCC_HAISAN",
  referenceType: "IMPORT",
  referenceCode: "HD-17998",
  lines: [{ totalCost: 480000 }, { totalCost: 600000 }],
};

test("nhập mua có NCC sinh đúng một khoản phải trả bằng tổng giá trị phiếu", async () => {
  const tx = fakeTx();
  await createPurchasePayable(tx, phieuNhapMua, { importBatchId: "batch-1", dueDate: new Date("2026-09-30T00:00:00.000Z") });
  assert.equal(tx.created.length, 1);
  const debt = tx.created[0];
  assert.equal(debt.code, purchasePayableCodeOf("NM-2026-0910"));
  assert.equal(debt.debtType, "PAYABLE");
  assert.equal(debt.partnerCode, "NCC_HAISAN");
  assert.equal(debt.partnerName, "NCC Hải sản");
  assert.equal(debt.branchCode, "NME");
  assert.equal(debt.originalAmount, 1080000);
  assert.equal(debt.outstandingAmount, 1080000);
  assert.equal(debt.sourceType, PURCHASE_PAYABLE_SOURCE);
  assert.equal(debt.sourceId, "tx-1");
  assert.equal(debt.importBatchId, "batch-1");
  // Chi phí vẫn đến từ phiếu chi mua hàng — bật cờ này lên là chi phí đôi trên P&L.
  assert.equal(debt.recognizeExpense, false);
  assert.match(debt.description, /NM-2026-0910/);
});

test("mã khoản nợ suy ra từ mã phiếu nên một phiếu không sinh hai khoản", () => {
  assert.equal(purchasePayableCodeOf("NM-2026-0910"), "CN-NM-2026-0910");
});

test("không phải nhập mua thì không sinh nợ", async () => {
  const tx = fakeTx();
  for (const transactionType of ["NHAP_KHAC", "NHAP_CHE_BIEN", "XUAT_KHAC", "DIEU_CHUYEN"]) {
    assert.equal(await createPurchasePayable(tx, { ...phieuNhapMua, transactionType }), null);
  }
  assert.equal(tx.created.length, 0);
});

test("phiếu không khai NCC thì không sinh nợ (không biết nợ ai)", async () => {
  const tx = fakeTx();
  assert.equal(await createPurchasePayable(tx, { ...phieuNhapMua, partnerCode: null }), null);
  assert.equal(await createPurchasePayable(tx, { ...phieuNhapMua, partnerCode: "   " }), null);
  assert.equal(tx.created.length, 0);
});

test("hàng khuyến mãi giá 0 không sinh khoản nợ 0 đồng", async () => {
  const tx = fakeTx();
  assert.equal(await createPurchasePayable(tx, { ...phieuNhapMua, lines: [{ totalCost: 0 }] }), null);
  assert.equal(tx.created.length, 0);
});

test("hàng nhận theo Đơn mua hàng đã có SupplierPayable nên bỏ qua", async () => {
  const tx = fakeTx();
  assert.equal(await createPurchasePayable(tx, { ...phieuNhapMua, referenceType: "PURCHASE_ORDER" }), null);
  assert.equal(tx.created.length, 0);
});

test("đối tác nội bộ NB-* vào nhóm nội bộ kể cả khi danh mục chưa khai nhóm", async () => {
  const tx = fakeTx({ name: "Nhà hàng Asa (nội bộ)", partnerGroup: null });
  await createPurchasePayable(tx, { ...phieuNhapMua, partnerCode: "NB-HCM" });
  assert.equal(tx.created[0].partnerGroup, "INTERNAL");
});
