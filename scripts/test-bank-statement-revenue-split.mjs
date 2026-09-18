import test from "node:test";
import assert from "node:assert/strict";
import { planRevenueDateSplit, RevenueSplitError } from "../lib/bank-statement-revenue-split.ts";

const transaction = { debitAmount: 0, creditAmount: 91_937_529, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0 };
const single = [{ id: "alloc-1", sheetName: "Sheet1", sourceRowNumber: 7, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0 }];

test("tách một lần ví trả gộp thành bốn ngày doanh thu, không mất một đồng", () => {
  const plan = planRevenueDateSplit({
    transaction,
    existing: single,
    lines: [
      { id: "alloc-1", revenueDate: "2026-08-20", amount: 20_000_000 },
      { revenueDate: "2026-08-21", amount: 21_937_529 },
      { revenueDate: "2026-08-22", amount: 25_000_000 },
      { revenueDate: "2026-08-23", amount: 25_000_000 },
    ],
  });

  assert.equal(plan.lines.reduce((sum, row) => sum + row.creditAmount, 0), 91_937_529);
  assert.equal(plan.transactionRevenueDate, null);
  assert.deepEqual(plan.lines.map((row) => row.sourceRowNumber), [7, 8, 9, 10]);
  assert.equal(plan.lines[0].id, "alloc-1");
  assert.deepEqual(plan.lines.map((row) => row.id).slice(1), [null, null, null]);
  assert.deepEqual(plan.removedIds, []);
  assert.ok(plan.lines.every((row) => row.sheetName === "Sheet1" && row.debitAmount === 0));
});

test("chia gross ví và hai khoản phí theo tỷ trọng, giữ nguyên tổng", () => {
  const plan = planRevenueDateSplit({
    transaction: { debitAmount: 0, creditAmount: 37_964_541, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0 },
    existing: [{ id: "a", sheetName: "S", sourceRowNumber: 1, grossAmount: 39_256_465, grabExpenseAmount: 655_000, cardFeeAmount: 636_924 }],
    lines: [
      { revenueDate: "2026-08-01", amount: 27_382_720 },
      { revenueDate: "2026-08-02", amount: 10_581_821 },
    ],
  });

  assert.equal(plan.lines.reduce((sum, row) => sum + (row.grossAmount || 0), 0), 39_256_465);
  assert.equal(plan.lines.reduce((sum, row) => sum + row.grabExpenseAmount, 0), 655_000);
  assert.equal(plan.lines.reduce((sum, row) => sum + row.cardFeeAmount, 0), 636_924);
  assert.ok(plan.lines.every((row) => (row.grossAmount || 0) >= row.creditAmount));
  assert.ok(plan.lines.every((row) => (row.grossAmount || 0) - row.creditAmount === row.grabExpenseAmount + row.cardFeeAmount));
  assert.deepEqual(plan.removedIds, ["a"]);
});

test("bỏ bớt dòng thì dòng cũ được xoá và giao dịch quay về một Ngày doanh thu", () => {
  const plan = planRevenueDateSplit({
    transaction,
    existing: [
      { id: "a", sheetName: "S", sourceRowNumber: 1, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0 },
      { id: "b", sheetName: "S", sourceRowNumber: 2, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0 },
    ],
    lines: [{ id: "a", revenueDate: "2026-08-23", amount: 91_937_529 }],
  });

  assert.deepEqual(plan.removedIds, ["b"]);
  assert.equal(plan.transactionRevenueDate?.toISOString(), "2026-08-23T00:00:00.000Z");
});

test("phiếu chi giữ đúng chiều Nợ", () => {
  const plan = planRevenueDateSplit({
    transaction: { debitAmount: 3_000_000, creditAmount: 0, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0 },
    existing: [],
    lines: [
      { revenueDate: "2026-08-01", amount: 1_000_000 },
      { revenueDate: "2026-08-02", amount: 2_000_000 },
    ],
  });

  assert.equal(plan.direction, "DEBIT");
  assert.deepEqual(plan.lines.map((row) => row.debitAmount), [1_000_000, 2_000_000]);
  assert.ok(plan.lines.every((row) => row.creditAmount === 0 && row.sheetName === "Sửa tay"));
  assert.deepEqual(plan.lines.map((row) => row.sourceRowNumber), [1, 2]);
});

test("tổng lệch số tiền giao dịch thì báo đúng phần còn thiếu", () => {
  assert.throws(
    () => planRevenueDateSplit({ transaction, existing: single, lines: [{ revenueDate: "2026-08-23", amount: 91_000_000 }] }),
    (error) => error instanceof RevenueSplitError && /còn thiếu 937\.529 đ/.test(error.message),
  );
});

test("chặn khai trùng ngày, thiếu ngày và số tiền không hợp lệ", () => {
  assert.throws(() => planRevenueDateSplit({
    transaction,
    existing: single,
    lines: [
      { revenueDate: "2026-08-23", amount: 45_968_764 },
      { revenueDate: "23/08/2026", amount: 45_968_765 },
    ],
  }), (error) => error instanceof RevenueSplitError && /bị khai hai lần/.test(error.message));

  assert.throws(() => planRevenueDateSplit({ transaction, existing: single, lines: [{ revenueDate: "", amount: 91_937_529 }] }),
    (error) => error instanceof RevenueSplitError && /thiếu Ngày doanh thu/.test(error.message));

  assert.throws(() => planRevenueDateSplit({ transaction, existing: single, lines: [{ revenueDate: "2026-08-23", amount: 0 }] }),
    (error) => error instanceof RevenueSplitError && /lớn hơn 0/.test(error.message));

  assert.throws(() => planRevenueDateSplit({ transaction, existing: single, lines: [] }),
    (error) => error instanceof RevenueSplitError && /ít nhất một dòng/.test(error.message));
});

test("không nhận id của giao dịch khác", () => {
  assert.throws(() => planRevenueDateSplit({ transaction, existing: single, lines: [{ id: "khac", revenueDate: "2026-08-23", amount: 91_937_529 }] }),
    (error) => error instanceof RevenueSplitError && /không thuộc giao dịch này/.test(error.message));
});

/**
 * Một lần khách quẹt gồm cả tiền bán hàng lẫn tiền thu hộ: phần thu hộ phải rời khỏi loại
 * doanh thu, nếu không bảng "Tiền về đủ chưa" đếm cả cục là tiền doanh thu về và báo VỀ DƯ.
 */
const swipe = {
  debitAmount: 0,
  creditAmount: 2_415_000,
  grossAmount: null,
  grabExpenseAmount: 0,
  cardFeeAmount: 0,
  categoryCode: "THU_BAN_HANG",
  partnerCode: "POS_NME",
};

test("tách tiền thu hộ ra khỏi tiền bán hàng trong cùng một lần quẹt", () => {
  const plan = planRevenueDateSplit({
    transaction: swipe,
    existing: [{ id: "a", sheetName: "S", sourceRowNumber: 1, grossAmount: null, grabExpenseAmount: 0, cardFeeAmount: 0, categoryCode: "THU_BAN_HANG" }],
    lines: [
      { id: "a", revenueDate: "2026-08-05", amount: 1_915_000 },
      { revenueDate: "2026-08-05", amount: 500_000, categoryCode: "thu_ho", partnerCode: "kh-001" },
    ],
  });

  assert.equal(plan.lines.reduce((sum, row) => sum + row.creditAmount, 0), 2_415_000);
  assert.deepEqual(plan.lines.map((row) => row.keepsOriginalCategory), [true, false]);
  assert.deepEqual(plan.lines.map((row) => row.categoryCode), ["THU_BAN_HANG", "THU_HO"]);
  // Dòng giữ loại gốc mượn được đối tác của giao dịch; dòng thu hộ thì không, phải khai riêng.
  assert.deepEqual(plan.lines.map((row) => row.partnerCode), ["POS_NME", "KH-001"]);
  assert.deepEqual(plan.splitCategories, [{ categoryCode: "THU_HO", partnerCode: "KH-001", amount: 500_000 }]);
  // Cùng một ngày doanh thu nhưng khác loại thu/chi là hợp lệ, không phải khai trùng.
  assert.equal(plan.transactionRevenueDate?.toISOString(), "2026-08-05T00:00:00.000Z");
});

test("gom nhiều ngày cùng loại thu hộ về một chứng từ", () => {
  const plan = planRevenueDateSplit({
    transaction: { ...swipe, creditAmount: 3_000_000 },
    existing: [],
    lines: [
      { revenueDate: "2026-08-05", amount: 1_000_000 },
      { revenueDate: "2026-08-05", amount: 400_000, categoryCode: "THU_HO", partnerCode: "KH-001" },
      { revenueDate: "2026-08-06", amount: 1_000_000 },
      { revenueDate: "2026-08-06", amount: 600_000, categoryCode: "THU_HO", partnerCode: "KH-001" },
    ],
  });

  assert.deepEqual(plan.splitCategories, [{ categoryCode: "THU_HO", partnerCode: "KH-001", amount: 1_000_000 }]);
});

test("phí ví chỉ rơi vào phần doanh thu, phần thu hộ không gánh phí", () => {
  const plan = planRevenueDateSplit({
    transaction: { ...swipe, creditAmount: 2_000_000 },
    existing: [{ id: "a", sheetName: "S", sourceRowNumber: 1, grossAmount: 2_100_000, grabExpenseAmount: 0, cardFeeAmount: 100_000, categoryCode: "THU_BAN_HANG" }],
    lines: [
      { id: "a", revenueDate: "2026-08-05", amount: 1_500_000 },
      { revenueDate: "2026-08-05", amount: 500_000, categoryCode: "THU_HO", partnerCode: "KH-001" },
    ],
  });

  assert.equal(plan.lines[0].cardFeeAmount, 100_000);
  assert.equal(plan.lines[1].cardFeeAmount, 0);
  assert.equal(plan.lines[1].grossAmount, 500_000);
  assert.equal(plan.lines.reduce((sum, row) => sum + (row.grossAmount || 0), 0), 2_100_000);
});

test("trùng cả ngày lẫn loại thu/chi thì vẫn chặn", () => {
  assert.throws(() => planRevenueDateSplit({
    transaction: swipe,
    existing: [],
    lines: [
      { revenueDate: "2026-08-05", amount: 1_000_000, categoryCode: "THU_HO", partnerCode: "KH-001" },
      { revenueDate: "2026-08-05", amount: 1_415_000, categoryCode: "THU_HO", partnerCode: "KH-001" },
    ],
  }), RevenueSplitError);
});
