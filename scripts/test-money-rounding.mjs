/**
 * Luật làm tròn tiền lúc ghi sổ (chốt với khách 21/09/2026).
 *
 * Ba điều phải đứng vững: (1) chỉ TIỀN bị tròn, số lượng / hệ số / đơn giá theo ĐVT nhỏ thì
 * không; (2) ghi lồng (phiếu + các dòng) cũng phải tròn tới tận dòng con; (3) tròn xong bút
 * toán vẫn cân Nợ = Có, nếu không cả hệ thống ghi sổ đứng.
 *
 * Chạy: npm run test:money-rounding
 */
import test from "node:test";
import assert from "node:assert/strict";
import { roundVnd, roundJournalLines, roundMoneyWrite, MONEY_FIELDS } from "../lib/money-rounding.ts";

test("tròn tới đồng, đối xứng quanh 0", () => {
  assert.equal(roundVnd(1000.4), 1000);
  assert.equal(roundVnd(1000.5), 1001);
  assert.equal(roundVnd(1923347490.265), 1923347490);
  // Tiền âm phải tròn cùng độ lớn với tiền dương, nếu không hai vế bút toán lệch nhau.
  assert.equal(roundVnd(-1000.5), -1001);
  assert.equal(roundVnd(-1000.4), -1000);
  assert.equal(roundVnd(0), 0);
});

test("chỉ trường tiền bị tròn, số lượng và đơn giá giữ nguyên", () => {
  const data = { quantity: 0.2, unitCost: 0.35, inputUnitCost: 0.35, conversionRate: 1000, totalCost: 672584.2696629212 };
  roundMoneyWrite("InventoryTransactionLine", data);
  assert.equal(data.quantity, 0.2, "số lượng 0,2 KG mà tròn thành 0 là báo sai tồn kho");
  assert.equal(data.unitCost, 0.35, "giá vốn 0,35 đ/g mà tròn đồng là mất sạch giá vốn");
  assert.equal(data.inputUnitCost, 0.35);
  assert.equal(data.conversionRate, 1000);
  assert.equal(data.totalCost, 672584);
});

test("số dư đầu kỳ: tròn tiền, giữ số lượng và đơn giá tồn kho", () => {
  const data = { quantity: 12.5, unitCost: 0.35, amount: 4.375 };
  roundMoneyWrite("OpeningBalance", data);
  assert.deepEqual(data, { quantity: 12.5, unitCost: 0.35, amount: 4 });
});

test("ghi lồng: phiếu và từng dòng con đều tròn", () => {
  const data = {
    code: "JE-1",
    lines: { create: [{ debit: 100.6, credit: 0 }, { debit: 0, credit: 100.6 }] },
  };
  roundMoneyWrite("JournalEntry", data);
  assert.deepEqual(data.lines.create, [{ debit: 101, credit: 0 }, { debit: 0, credit: 101 }]);
});

test("ghi lồng createMany cũng đi tới nơi", () => {
  const data = { amount: 10.7, settlements: { createMany: { data: [{ amount: 3.4 }, { amount: 7.3 }] } } };
  roundMoneyWrite("DebtRecord", data);
  assert.equal(data.amount, 10.7, "DebtRecord không có trường 'amount' nên không đụng tới");
  assert.deepEqual(data.settlements.createMany.data, [{ amount: 3 }, { amount: 7 }]);
});

test("increment / decrement cũng tròn, multiply thì không", () => {
  const data = { outstandingAmount: { decrement: 1000.6 }, originalAmount: { increment: 2000.4 } };
  roundMoneyWrite("DebtRecord", data);
  assert.deepEqual(data, { outstandingAmount: { decrement: 1001 }, originalAmount: { increment: 2000 } });
});

test("bút toán tròn xong vẫn cân Nợ = Có", () => {
  // Một vế 1.000,5 tròn lên 1.001, hai vế kia 500,25 tròn xuống 500 — lệch 1 đồng nếu tròn rời rạc.
  const lines = roundJournalLines([
    { debit: 500.25, credit: 0 },
    { debit: 500.25, credit: 0 },
    { debit: 0, credit: 1000.5 },
  ]);
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  assert.equal(debit, credit);
  assert.equal(debit, 1001);
  // Phần dôi dồn vào dòng lớn nhất của vế thiếu.
  assert.deepEqual(lines.map((line) => line.debit), [501, 500, 0]);
});

test("bút toán chia ba không chẵn vẫn cân", () => {
  const lines = roundJournalLines([
    { debit: 1000 / 3, credit: 0 },
    { debit: 1000 / 3, credit: 0 },
    { debit: 1000 / 3, credit: 0 },
    { debit: 0, credit: 1000 },
  ]);
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  assert.equal(debit, credit);
  assert.equal(credit, 1000);
});

test("bút toán đã tròn sẵn thì không bị đụng vào", () => {
  const input = [{ debit: 500, credit: 0 }, { debit: 0, credit: 500 }];
  assert.deepEqual(roundJournalLines(input), input);
});

test("danh sách trường tiền không lỡ tay nhận số lượng", () => {
  for (const [model, fields] of Object.entries(MONEY_FIELDS)) {
    for (const field of fields) {
      assert.ok(
        !/quantity|conversionRate|wasteRate|ratio|Percent/i.test(field),
        `${model}.${field} không phải tiền`,
      );
    }
  }
  // Đơn giá theo ĐVT nhỏ phải đứng ngoài danh sách.
  assert.ok(!MONEY_FIELDS.InventoryTransactionLine.includes("unitCost"));
  assert.ok(!MONEY_FIELDS.InventoryBalance);
});
