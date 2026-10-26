import assert from "node:assert/strict";
import test from "node:test";
import { receiptCounterAccount } from "../lib/voucher-accounting.ts";
import { PARTNER_COLLECTION_ACTION, PARTNER_COLLECTION_PURPOSE, validateReceiptPurpose, voucherPartnerRequirement } from "../lib/voucher-rules.ts";
import { applyVoucherSideEffects, VoucherSideEffectError } from "../lib/voucher-side-effects.ts";

/**
 * "Thu lại tiền chi hộ theo đối tác" (khách góp ý 19/09/2026): bên phiếu chi có Chi hộ chỉ cần
 * chọn đối tác, phiếu thu cũng phải vậy — chọn đối tác là hệ thống tự gạch, không bắt chép mã
 * khoản nợ CNTHU-... nữa.
 */
const phieuThu = {
  id: "v1",
  code: "UNT-2608-NME-00912",
  voucherType: "RECEIPT",
  voucherDate: new Date("2026-08-25"),
  partnerCode: "NB-THOA",
  partnerName: "BOD Cô Thoa",
  branchCode: "NME",
  moneySourceCode: "FDS_CHAU",
  categoryCode: "THU_KHAC",
  pnlItemCode: null,
  amount: 60_000_000,
  description: "Cô Thoa chuyển tiền ngày 25.08.2026",
  depositAction: null,
  depositCode: null,
  debtAction: PARTNER_COLLECTION_ACTION,
  debtReference: null,
  allocationMonths: null,
  allocationStartPeriod: null,
};

/**
 * tx giả: sổ nợ + các lần gạch trong bộ nhớ, đủ cho nhánh gạch nợ theo đối tác. Từ 26/10/2026
 * nhánh này gỡ hết lần gạch cũ của phiếu rồi cấn lại (reallocatePartnerCollections), nên tx giả
 * phải hiểu findMany/deleteMany của DebtSettlement và findUnique của DebtRecord.
 */
function fakeTx(debts, { settlements = [] } = {}) {
  const calls = { settlements: settlements.map((row) => ({ ...row })), updates: [] };
  const store = debts.map((debt) => ({ ...debt }));
  let seq = 0;
  return {
    calls,
    store,
    financialVoucher: { findMany: async () => [] },
    debtSettlement: {
      findMany: async ({ where }) => calls.settlements.filter((row) => where.voucherId.in.includes(row.voucherId)),
      deleteMany: async ({ where }) => { calls.settlements = calls.settlements.filter((row) => !where.id.in.includes(row.id)); },
      create: async ({ data }) => calls.settlements.push({ id: `s${++seq}`, ...data }),
    },
    debtRecord: {
      findMany: async ({ where }) => store
        .filter((item) => item.debtType === where.debtType && item.partnerCode === where.partnerCode
          && item.branchCode === where.branchCode && item.outstandingAmount > 0),
      findUnique: async ({ where }) => store.find((item) => item.id === where.id) || null,
      findFirst: async ({ where }) => store.find((item) => item.code === where.code) || null,
      update: async ({ where, data }) => {
        const item = store.find((row) => row.id === where.id);
        Object.assign(item, data);
        calls.updates.push({ where, data });
      },
    },
    masterDataItem: { findFirst: async () => null, findMany: async () => [] },
    voucherAllocation: { findMany: async () => [] },
  };
}

const noCu = { id: "d1", code: "CNTHU-UNC-2608-NME-00090", debtType: "RECEIVABLE", partnerCode: "NB-THOA", partnerName: "BOD Cô Thoa", branchCode: "NME", documentDate: new Date("2026-08-05"), originalAmount: 40_000_000, outstandingAmount: 40_000_000 };
const noMoi = { id: "d2", code: "CNTHU-UNC-2608-NME-00104", debtType: "RECEIVABLE", partnerCode: "NB-THOA", partnerName: "BOD Cô Thoa", branchCode: "NME", documentDate: new Date("2026-08-20"), originalAmount: 50_000_000, outstandingAmount: 50_000_000 };

test("chọn đối tác là đủ: tự gạch khoản cũ trước rồi tới khoản mới, đúng hết số tiền trên phiếu", async () => {
  const tx = fakeTx([noMoi, noCu]);
  await applyVoucherSideEffects(tx, phieuThu, "kt");
  assert.deepEqual(tx.calls.settlements.map((row) => [row.debtId, row.amount]), [["d1", 40_000_000], ["d2", 20_000_000]]);
  assert.equal(tx.store.find((row) => row.id === "d1").outstandingAmount, 0);
  assert.equal(tx.store.find((row) => row.id === "d2").outstandingAmount, 30_000_000);
});

test("thu nhiều hơn tổng nợ đang mở: gạch hết phần có, phần dư không gạch khống", async () => {
  const tx = fakeTx([noCu]);
  await applyVoucherSideEffects(tx, phieuThu, "kt");
  assert.deepEqual(tx.calls.settlements.map((row) => row.amount), [40_000_000]);
});

test("đối tác chưa có khoản nào đang mở: phiếu vẫn duyệt được, không gạch gì", async () => {
  const tx = fakeTx([{ ...noCu, branchCode: "ASA" }]);
  await applyVoucherSideEffects(tx, phieuThu, "kt");
  assert.equal(tx.calls.settlements.length, 0);
});

test("duyệt lại không gạch đôi: lần gạch cũ được gỡ rồi cấn lại đúng một lần", async () => {
  const tx = fakeTx([{ ...noCu, outstandingAmount: 0, status: "SETTLED" }], {
    settlements: [{ id: "s0", debtId: "d1", voucherId: "v1", amount: 40_000_000 }],
  });
  await applyVoucherSideEffects(tx, phieuThu, "kt");
  assert.deepEqual(tx.calls.settlements.map((row) => [row.debtId, row.amount]), [["d1", 40_000_000]]);
  assert.equal(tx.store.find((row) => row.id === "d1").outstandingAmount, 0);
});

test("không có đối tác thì chặn ngay bằng lỗi nghiệp vụ", async () => {
  await assert.rejects(
    () => applyVoucherSideEffects(fakeTx([noCu]), { ...phieuThu, partnerCode: null }, "kt"),
    (error) => error instanceof VoucherSideEffectError && /chọn đối tác/.test(error.message),
  );
});

test("luật form/API: nội dung thu theo đối tác chỉ cần đối tác, không cần mã nợ", () => {
  assert.equal(validateReceiptPurpose("RECEIPT", PARTNER_COLLECTION_PURPOSE, "NB-THOA", null), null);
  assert.match(validateReceiptPurpose("RECEIPT", PARTNER_COLLECTION_PURPOSE, "", null), /chọn đối tác/);
  assert.match(voucherPartnerRequirement({ debtAction: PARTNER_COLLECTION_ACTION }), /đối tác/);
});

test("định khoản: đối tác ngoài ghi Có 131, nhà hàng trong nhà ghi Có 1368 để triệt tiêu vế chi hộ", () => {
  const base = { voucherType: "RECEIPT", amount: 1, moneySourceCode: "FDS_CHAU", categoryCode: "THU_KHAC", pnlItemCode: null, depositAction: null, debtAction: PARTNER_COLLECTION_ACTION };
  assert.equal(receiptCounterAccount({ ...base, partnerCode: "KH_TRUNG" }, "REVENUE_SOURCE", null, {}, ["NME", "ASA"]).account, "131");
  assert.equal(receiptCounterAccount({ ...base, partnerCode: "NB-ASA" }, "REVENUE_SOURCE", null, {}, ["NME", "ASA"]).account, "1368");
  // NB-THOA không phải mã cửa hàng nào -> đối tác ngoài, dù mang tiền tố NB-.
  assert.equal(receiptCounterAccount({ ...base, partnerCode: "NB-THOA" }, "REVENUE_SOURCE", null, {}, ["NME", "ASA"]).account, "131");
});
