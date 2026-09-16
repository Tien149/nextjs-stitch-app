import assert from "node:assert/strict";
import test from "node:test";
import { applyVoucherSideEffects, VoucherSideEffectError } from "../lib/voucher-side-effects.ts";

/**
 * Gạch nợ hỏng vì dữ liệu người dùng nhập (mã công nợ sai, khác cửa hàng, khác đối tác,
 * vượt dư nợ) phải ném VoucherSideEffectError để route trả 400 kèm câu giải thích.
 * Trước đây đây là Error trần nên màn Phiếu thu/chi chỉ hiện "Internal Server Error".
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
  amount: 60_000_000,
  description: "Cô Thoa chuyển tiền ngày 25.08.2026",
  depositAction: null,
  depositCode: null,
  debtAction: "SETTLE",
  debtReference: "NB-NME",
  allocationMonths: null,
  allocationStartPeriod: null,
};

/** tx giả: chỉ phục vụ nhánh gạch nợ của applyVoucherSideEffects. */
function fakeTx(debt) {
  const calls = { settlements: [], updates: [] };
  return {
    calls,
    debtSettlement: {
      findFirst: async () => null,
      create: async ({ data }) => calls.settlements.push(data),
    },
    debtRecord: {
      findFirst: async () => debt,
      update: async (args) => calls.updates.push(args),
    },
    // Phiếu một đối tác nên không có dòng phân bổ nào.
    voucherAllocation: { findMany: async () => [] },
  };
}

const congNoNME = {
  id: "d1",
  code: "CNTHU-UNC-2608-NME-00104",
  debtType: "RECEIVABLE",
  partnerCode: "NB-THOA",
  branchCode: "NME",
  outstandingAmount: 60_000_000,
};

async function loiKhiApDung(tx, voucher = phieuThu) {
  try {
    await applyVoucherSideEffects(tx, voucher, "kt");
    return null;
  } catch (e) {
    return e;
  }
}

test("mã công nợ không tồn tại: báo rõ mã công nợ khác mã đối tác", async () => {
  const error = await loiKhiApDung(fakeTx(null));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /\[NB-NME\]/);
  assert.match(error.message, /Mã công nợ khác mã đối tác/);
});

test("công nợ của cửa hàng khác: nói tên cả hai cửa hàng", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, branchCode: "ASA" }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /ASA/);
  assert.match(error.message, /NME/);
});

test("phiếu thu gạch nhầm khoản phải trả", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, debtType: "PAYABLE" }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /PHẢI TRẢ/);
});

test("công nợ đứng tên đối tác khác", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, partnerCode: "NB-BINH" }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /NB-BINH/);
  assert.match(error.message, /NB-THOA/);
});

test("số tiền vượt dư nợ: nêu cả số thu và dư nợ còn lại", async () => {
  const error = await loiKhiApDung(fakeTx({ ...congNoNME, outstandingAmount: 10_000_000 }));
  assert.ok(error instanceof VoucherSideEffectError);
  assert.match(error.message, /10\.000\.000/);
  assert.match(error.message, /60\.000\.000/);
});

test("khớp đủ điều kiện thì gạch nợ chạy bình thường", async () => {
  const tx = fakeTx(congNoNME);
  assert.equal(await loiKhiApDung(tx), null);
  assert.equal(tx.calls.settlements.length, 1);
  assert.equal(tx.calls.settlements[0].amount, 60_000_000);
  assert.equal(tx.calls.updates[0].data.outstandingAmount, 0);
  assert.equal(tx.calls.updates[0].data.status, "SETTLED");
});
