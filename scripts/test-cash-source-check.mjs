/**
 * Đối chiếu Sổ quỹ – Nguồn tiền (khách 13/11/2026: KCF - Vietinbank sổ quỹ 0 đ, nguồn tiền âm 31 triệu
 * vì dòng sao kê nạp trùng).
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-cash-source-check.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cashCloseWarnings, compareCashSources } from "../lib/cash-source-check.ts";

const flow = (code, group, opening, closing, extra = {}) => ({
  code, memberCodes: [code], name: code, group, branchCode: "ASA", opening, closing, in: 0, out: 0, transferIn: 0, transferOut: opening - closing, ...extra,
});
const book = (entries) => new Map(entries.map(([code, opening, closing]) => [code, { opening, receipt: 0, payment: opening - closing, closing }]));

test("lệch đầu kỳ đúng bằng lệch cuối kỳ → phát sinh trong kỳ khớp", () => {
  const rows = compareCashSources(
    [flow("KCFCHKHMPOS", "BANK", 460_770_200, -31_260_623)],
    book([["KCFCHKHMPOS", 492_030_823, 0]]),
  );
  assert.equal(rows[0].openingDiff, -31_260_623);
  assert.equal(rows[0].closingDiff, -31_260_623);
  assert.equal(rows[0].movementDiff, 0);
  assert.equal(rows[0].matched, false);
  assert.equal(rows[0].negativeReport, true);
  assert.equal(rows[0].negativeCashbook, false);
});

test("bỏ ví, gộp nguồn tiền tổng theo memberCodes, lệch 1 đ coi là khớp", () => {
  const rows = compareCashSources(
    [
      flow("MOMO", "WALLET", 0, 500),
      { ...flow("TM1", "CASH", 100, 300), code: "TM1, TM2", memberCodes: ["TM1", "TM2"] },
    ],
    book([["TM1", 60, 200], ["TM2", 40, 101]]),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cashbook.closing, 301);
  assert.equal(rows[0].matched, true);
});

test("cảnh báo khoá sổ: nguồn âm và nguồn lệch", () => {
  const rows = compareCashSources(
    [flow("A", "BANK", 0, -5000), flow("B", "CASH", 10, 10)],
    book([["A", 0, -5000], ["B", 10, 10]]),
  );
  const warnings = cashCloseWarnings(rows);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /A \(A\) âm cuối kỳ: Sổ quỹ -5\.000 đ, Nguồn tiền -5\.000 đ/);
});
