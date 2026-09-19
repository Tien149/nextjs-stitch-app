import test from "node:test";
import assert from "node:assert/strict";
import { pickManualVoucherForStatement } from "../lib/bank-statement-voucher-match.ts";

const base = {
  id: "v1",
  code: "UNT-2608-NME-00913",
  voucherType: "RECEIPT",
  documentChannel: "BANK",
  sourceScope: "EXTERNAL",
  moneySourceCode: "FDSCHKHCHAU",
  amount: 45_360,
  voucherDate: new Date("2026-08-25T00:00:00.000Z"),
  externalRef: null,
  businessEffect: "RECOGNITION",
};

const target = {
  voucherType: "RECEIPT",
  moneySourceCode: "FDSCHKHCHAU",
  amount: 45_360,
  documentDate: new Date("2026-08-26T00:00:00.000Z"),
};

test("nối đúng phiếu lập tay khi chỉ có một ứng viên", () => {
  const pick = pickManualVoucherForStatement([base], target);
  assert.equal(pick.voucher?.code, "UNT-2608-NME-00913");
  assert.equal(pick.reason, null);
});

/**
 * Hai phiếu cùng số tiền trong cùng vài ngày là chuyện có thật (tiền bán hàng lặt vặt).
 * Đoán bừa thì tiền nối nhầm chứng từ và sai âm thầm — thà lập phiếu như cũ rồi để kế toán chọn.
 */
test("hai phiếu cùng số tiền thì không đoán", () => {
  const pick = pickManualVoucherForStatement([base, { ...base, id: "v2", code: "UNT-2608-NME-00914" }], target);
  assert.equal(pick.voucher, null);
  assert.equal(pick.reason, "AMBIGUOUS");
});

test("lệch ngày quá xa thì không phải khoản này", () => {
  const pick = pickManualVoucherForStatement([base], {
    ...target,
    documentDate: new Date("2026-08-30T00:00:00.000Z"),
  });
  assert.equal(pick.reason, "NONE");
});

test("bỏ qua phiếu tiền mặt, phiếu do import tự lập, khác nguồn tiền và khác chiều tiền", () => {
  const candidates = [
    { ...base, id: "cash", documentChannel: "CASH" },
    { ...base, id: "auto", sourceScope: "BANK_STATEMENT_AUTO" },
    { ...base, id: "split", sourceScope: "BANK_STATEMENT_SPLIT" },
    { ...base, id: "other-source", moneySourceCode: "FDSCHKHVIET" },
    { ...base, id: "payment", voucherType: "PAYMENT" },
    { ...base, id: "other-amount", amount: 45_361 },
  ];
  assert.equal(pickManualVoucherForStatement(candidates, target).reason, "NONE");
});

test("số tiền lẻ đồng vẫn khớp sau khi làm tròn", () => {
  const pick = pickManualVoucherForStatement([{ ...base, amount: 45_360.4 }], { ...target, amount: 45_359.8 });
  assert.equal(pick.voucher?.id, "v1");
});
