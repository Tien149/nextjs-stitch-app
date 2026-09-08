import assert from "node:assert/strict";
import test from "node:test";
import {
  bankSigned, debtBalanceOf, debtRecordSigned, depositSigned, openingBalanceSigned, voucherSigned,
} from "../lib/debt-balance.ts";

const emptyRow = {
  openingAmount: 0, purchasePayable: 0, debtPayable: 0, debtReceivable: 0,
  depositHolding: 0, bankMatched: 0, voucherNet: 0,
};

test("dương là mình nợ đối tác, âm là đối tác nợ mình", () => {
  assert.equal(openingBalanceSigned("AP", 260_068_208), 260_068_208);
  assert.equal(openingBalanceSigned("AR", 68_000_000), -68_000_000);
  assert.equal(debtRecordSigned("PAYABLE", 46_500_000), 46_500_000);
  assert.equal(debtRecordSigned("RECEIVABLE", 46_500_000), -46_500_000);
  // Tiền cọc đang giữ của khách là một khoản phải trả.
  assert.equal(depositSigned(30_000_000), 30_000_000);
});

test("trả tiền nhà cung cấp thì công nợ phải trả GIẢM", () => {
  // Đúng tình huống khách báo: đầu kỳ nợ 260.068.208, chi 25.068.208 qua ủy nhiệm chi.
  const balance = debtBalanceOf({
    ...emptyRow,
    openingAmount: openingBalanceSigned("AP", 260_068_208),
    voucherNet: voucherSigned("PAYMENT", 25_068_208),
  });
  assert.equal(balance, 235_000_000);
  assert.ok(balance < 260_068_208, "trả tiền rồi thì số dư phải trả không được tăng lên");
});

test("thu tiền của khách thì công nợ phải thu giảm về 0", () => {
  const balance = debtBalanceOf({
    ...emptyRow,
    openingAmount: openingBalanceSigned("AR", 100_000_000),
    voucherNet: voucherSigned("RECEIPT", 40_000_000),
  });
  assert.equal(balance, -60_000_000);
});

test("trả nhiều hơn nợ thì đảo chiều thành phải thu", () => {
  const balance = debtBalanceOf({
    ...emptyRow,
    openingAmount: openingBalanceSigned("AP", 145_000_000),
    debtPayable: 46_500_000,
    voucherNet: voucherSigned("PAYMENT", 320_000_000),
  });
  assert.equal(balance, -128_500_000);
});

test("tiền vào tài khoản làm giảm phải thu, tiền ra làm giảm phải trả", () => {
  assert.equal(bankSigned(50_000_000, 0), 50_000_000);
  assert.equal(bankSigned(0, 50_000_000), -50_000_000);
  assert.equal(debtBalanceOf({ ...emptyRow, debtPayable: 10_000_000, bankMatched: bankSigned(0, 4_000_000) }), 6_000_000);
});

test("khoản phải thu và phải trả của cùng một đối tác bù trừ nhau", () => {
  assert.equal(debtBalanceOf({ ...emptyRow, debtPayable: 10_000_000, debtReceivable: 3_000_000 }), 7_000_000);
});
