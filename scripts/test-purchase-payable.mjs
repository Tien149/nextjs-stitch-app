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
import { createPurchasePayable, purchaseLineAmount, purchasePayableCodeOf, PURCHASE_PAYABLE_SOURCE } from "../lib/purchase-payable.ts";

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

/**
 * Hàng khuyến mãi / tặng kèm: NCC giao 0 đ, nhưng dòng đó được định giá lại theo bình quân
 * của kho khi vào tồn (để giá vốn không bị kéo xuống). Số nợ phải bám ĐƠN GIÁ KHAI, không
 * bám giá trị nhập kho — nếu không hệ thống ghi nhà hàng nợ NCC tiền của hàng được tặng.
 */
const dongHangTang = { totalCost: 350000, inputQuantity: 5, inputUnitCost: null, vatAmount: 0 };
const dongMuaThat = { totalCost: 480000, inputQuantity: 4, inputUnitCost: 120000, vatAmount: 38400 };

test("dòng hàng tặng không góp đồng nào vào công nợ dù có giá trị nhập kho", () => {
  assert.equal(purchaseLineAmount(dongHangTang), 0);
  assert.equal(purchaseLineAmount(dongMuaThat), 480000);
});

test("phiếu TOÀN hàng tặng không sinh khoản nợ nào", async () => {
  const tx = fakeTx();
  assert.equal(await createPurchasePayable(tx, { ...phieuNhapMua, lines: [dongHangTang, { ...dongHangTang, totalCost: 90000 }] }), null);
  assert.equal(tx.created.length, 0);
});

test("phiếu vừa mua vừa được tặng chỉ nợ phần mua, kèm thuế của phần mua", async () => {
  const tx = fakeTx();
  await createPurchasePayable(tx, { ...phieuNhapMua, lines: [dongMuaThat, dongHangTang] });
  // 480.000 tiền hàng + 38.400 thuế; 350.000 giá trị hàng tặng đứng ngoài.
  assert.equal(tx.created[0].originalAmount, 518400);
  assert.equal(tx.created[0].outstandingAmount, 518400);
});

test("dòng cũ không lưu đơn giá khai thì giữ nguyên số nợ như trước", () => {
  // Trước 21/09/2026 dòng phiếu không lưu `inputQuantity`; không có cách nào biết dòng nào là
  // hàng tặng, nên phải bám `totalCost` để công nợ của dữ liệu đã có không tự đổi số.
  assert.equal(purchaseLineAmount({ totalCost: 600000 }), 600000);
  assert.equal(purchaseLineAmount({ totalCost: 600000, inputQuantity: null, inputUnitCost: null }), 600000);
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
