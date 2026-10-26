/**
 * Công nợ chi hộ theo số dư đối tác (khách chốt 26/10/2026): phiếu thu "Thu lại tiền chi hộ theo
 * đối tác" tự cấn vào khoản chi hộ cũ nhất, và cấn LẠI khi phiếu chi hộ / phiếu thu được sửa, bỏ
 * duyệt, xoá — không còn chặn như UNC-2608-ASA-00133 (đã được PTHU-2608-ASA-00103 cấn 88 triệu).
 *
 * Phần DB dựng trên cửa hàng giả ZCH (dọn sạch trước/sau), đi đúng chuỗi revert → update → apply
 * như app/api/vouchers/route.ts.
 *
 * Chạy: npm run test:partner-collection
 */
import assert from "node:assert/strict";
import test from "node:test";
import { prismaRaw } from "../lib/prisma.ts";
import { applyVoucherSideEffects, planPartnerCollection } from "../lib/voucher-side-effects.ts";
import { revertVoucherSideEffects, VoucherRevertError } from "../lib/voucher-revert.ts";
import { ADVANCE_RECEIVABLE_ACTION, PARTNER_COLLECTION_ACTION } from "../lib/voucher-rules.ts";

const d = (day) => new Date(`${day}T00:00:00+07:00`);

test("phiếu thu cũ nhất cấn khoản phải thu cũ nhất, phần dư không cấn", () => {
  const plan = planPartnerCollection(
    [
      { id: "R2", code: "PT-2", voucherDate: d("2026-09-10"), amount: 50 },
      { id: "R1", code: "PT-1", voucherDate: d("2026-08-16"), amount: 88 },
    ],
    [
      { id: "A", code: "CNTHU-A", documentDate: d("2026-08-25"), outstandingAmount: 150 },
      { id: "B", code: "CNTHU-B", documentDate: d("2026-08-01"), outstandingAmount: 40 },
    ],
  );
  assert.deepEqual(plan, [
    { voucherId: "R1", debtId: "B", amount: 40 },
    { voucherId: "R1", debtId: "A", amount: 48 },
    { voucherId: "R2", debtId: "A", amount: 50 },
  ]);
  // Không còn khoản nào thì không cấn gì (thu dư).
  assert.deepEqual(planPartnerCollection([{ id: "R", code: "PT", voucherDate: d("2026-08-01"), amount: 10 }], []), []);
});

const BRANCH = "ZCH";
const PARTNER = "ZCH_THOA";

async function cleanup() {
  const vouchers = await prismaRaw.financialVoucher.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  const ids = vouchers.map((row) => row.id);
  await prismaRaw.debtSettlement.deleteMany({ where: { OR: [{ voucherId: { in: ids } }, { debt: { branchCode: BRANCH } }] } });
  await prismaRaw.debtRecord.deleteMany({ where: { branchCode: BRANCH } });
  await prismaRaw.financialVoucher.deleteMany({ where: { branchCode: BRANCH } });
}

let seq = 0;
async function approve(data) {
  seq += 1;
  return prismaRaw.$transaction(async (tx) => {
    const voucher = await tx.financialVoucher.create({
      data: {
        code: `${data.voucherType === "RECEIPT" ? "ZPT" : "ZUNC"}-${String(seq).padStart(3, "0")}`,
        partnerName: data.partnerCode || PARTNER,
        branchCode: BRANCH,
        moneySourceCode: "ZCH_CASH",
        description: "test",
        status: "APPROVED",
        ...data,
      },
    });
    await applyVoucherSideEffects(tx, voucher, "test");
    return voucher;
  });
}

/** Chi hộ cho ZCH_THOA. */
const chiHo = (day, amount) => approve({ voucherType: "PAYMENT", voucherDate: d(day), amount, partnerCode: "ZCH_NCC", debtAction: ADVANCE_RECEIVABLE_ACTION, receivablePartnerCode: PARTNER, receivablePartnerName: "Cô Thoa" });
/** Thu lại tiền chi hộ theo đối tác. */
const thu = (day, amount) => approve({ voucherType: "RECEIPT", voucherDate: d(day), amount, partnerCode: PARTNER, debtAction: PARTNER_COLLECTION_ACTION });

/** Sửa phiếu đang duyệt: hoàn tác → cập nhật → áp lại, đúng như route PUT. */
async function edit(voucher, changes) {
  return prismaRaw.$transaction(async (tx) => {
    const latest = await tx.financialVoucher.findUnique({ where: { id: voucher.id } });
    const next = { ...latest, ...changes };
    await revertVoucherSideEffects(tx, latest, { branchCode: next.branchCode, debtAction: next.debtAction, receivablePartnerCode: next.receivablePartnerCode }, "test");
    const updated = await tx.financialVoucher.update({ where: { id: voucher.id }, data: changes });
    await applyVoucherSideEffects(tx, updated, "test");
    return updated;
  });
}

async function unapprove(voucher) {
  await prismaRaw.$transaction(async (tx) => {
    const latest = await tx.financialVoucher.findUnique({ where: { id: voucher.id } });
    await revertVoucherSideEffects(tx, latest, null, "test");
    await tx.financialVoucher.update({ where: { id: voucher.id }, data: { status: "DRAFT" } });
  });
}

/** Dư nợ từng khoản chi hộ + tổng đã cấn theo từng phiếu thu. */
async function state() {
  const debts = await prismaRaw.debtRecord.findMany({ where: { branchCode: BRANCH }, include: { settlements: true } });
  const outstanding = Object.fromEntries(debts.map((row) => [row.code, row.outstandingAmount]));
  const applied = {};
  for (const debt of debts) {
    for (const row of debt.settlements) applied[row.voucherId] = (applied[row.voucherId] || 0) + row.amount;
  }
  // Dư nợ phải luôn = phát sinh − đã cấn (không lệch sau khi cấn lại).
  for (const debt of debts) {
    const settled = debt.settlements.reduce((sum, row) => sum + row.amount, 0);
    assert.equal(debt.outstandingAmount, debt.originalAmount - settled, `${debt.code} lệch dư nợ`);
  }
  return { outstanding, applied };
}

test("DB: đổi phiếu chi hộ đã được thu một phần thành chi thường — không chặn, tiền thu tự cấn sang khoản khác", async (t) => {
  await cleanup();
  t.after(cleanup);
  const a = await chiHo("2026-08-25", 150_000_000);
  const r = await thu("2026-08-16", 88_000_000);
  let s = await state();
  assert.equal(s.outstanding[`CNTHU-${a.code}`], 62_000_000);

  // Ca UNC-2608-ASA-00133: đổi sang chi thường → khoản phải thu biến mất, phiếu thu thành thu dư.
  await edit(a, { debtAction: null, receivablePartnerCode: null, receivablePartnerName: null });
  s = await state();
  assert.equal(s.outstanding[`CNTHU-${a.code}`], undefined);
  assert.equal(s.applied[r.id] || 0, 0);

  // Chi hộ mới cho đúng đối tác → phần thu dư tự cấn vào.
  const c = await chiHo("2026-09-01", 50_000_000);
  s = await state();
  assert.equal(s.outstanding[`CNTHU-${c.code}`], 0);
  assert.equal(s.applied[r.id], 50_000_000);
});

test("DB: hạ số tiền chi hộ thấp hơn phần đã thu — không chặn, phần thu thừa thành thu dư", async (t) => {
  await cleanup();
  t.after(cleanup);
  const a = await chiHo("2026-08-01", 100_000_000);
  const r = await thu("2026-08-05", 80_000_000);
  await edit(a, { amount: 60_000_000 });
  const s = await state();
  assert.equal(s.outstanding[`CNTHU-${a.code}`], 0);
  assert.equal(s.applied[r.id], 60_000_000);
});

test("DB: bỏ duyệt một phiếu thu — phiếu thu còn lại cấn lại vào chỗ trống", async (t) => {
  await cleanup();
  t.after(cleanup);
  const a = await chiHo("2026-08-01", 100_000_000);
  const r1 = await thu("2026-08-05", 60_000_000);
  const r2 = await thu("2026-08-06", 60_000_000);
  let s = await state();
  assert.equal(s.applied[r1.id], 60_000_000);
  assert.equal(s.applied[r2.id], 40_000_000);
  await unapprove(r1);
  s = await state();
  assert.equal(s.applied[r1.id] || 0, 0);
  assert.equal(s.applied[r2.id], 60_000_000);
  assert.equal(s.outstanding[`CNTHU-${a.code}`], 40_000_000);
});

test("DB: bỏ duyệt phiếu chi hộ đã được thu — tiền thu chuyển sang khoản chi hộ còn lại", async (t) => {
  await cleanup();
  t.after(cleanup);
  const a = await chiHo("2026-08-01", 30_000_000);
  const b = await chiHo("2026-08-10", 50_000_000);
  const r = await thu("2026-08-15", 40_000_000);
  let s = await state();
  assert.equal(s.outstanding[`CNTHU-${a.code}`], 0);
  assert.equal(s.outstanding[`CNTHU-${b.code}`], 40_000_000);
  await unapprove(a);
  s = await state();
  assert.equal(s.outstanding[`CNTHU-${a.code}`], undefined);
  assert.equal(s.outstanding[`CNTHU-${b.code}`], 10_000_000);
  assert.equal(s.applied[r.id], 40_000_000);
});

test("DB: khoản bị gạch ĐÍCH DANH theo mã vẫn chặn đổi nội dung chi hộ, báo đúng mã phiếu thu", async (t) => {
  await cleanup();
  t.after(cleanup);
  const a = await chiHo("2026-08-01", 30_000_000);
  const r = await approve({ voucherType: "RECEIPT", voucherDate: d("2026-08-05"), amount: 10_000_000, partnerCode: PARTNER, debtAction: "SETTLE", debtReference: `CNTHU-${a.code}` });
  await assert.rejects(
    () => edit(a, { debtAction: null, receivablePartnerCode: null, receivablePartnerName: null }),
    (error) => error instanceof VoucherRevertError && error.message.includes(r.code),
  );
  // Sửa diễn giải vẫn lưu được.
  await edit(a, { description: "sửa diễn giải" });
  const s = await state();
  assert.equal(s.outstanding[`CNTHU-${a.code}`], 20_000_000);
});
