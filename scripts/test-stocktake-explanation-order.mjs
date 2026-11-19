import test from "node:test";
import assert from "node:assert/strict";
import { lockBlockers, openingMismatches, unlockBlockers } from "../lib/stocktake-explanation-order.ts";

const T8 = { sourceCode: "KK-2026-0011", periodTo: "2026-08-26T08:00:00Z", status: "DRAFT" };
const T9 = { sourceCode: "KK-2026-0007", periodTo: "2026-09-30T08:00:00Z", status: "LOCKED" };
const T10 = { sourceCode: "KKT-2026-0050", periodTo: "2026-10-30T08:00:00Z", status: "LOCKED" };

test("ca thật ASA_KBEP 18/11: T8 đang mở chốt thì không chốt được T9", () => {
  assert.deepEqual(lockBlockers(T9, [T8, T10], "LOCKED"), ["KK-2026-0011"]);
  assert.deepEqual(lockBlockers(T9, [{ ...T8, status: "LOCKED" }, T10], "LOCKED"), []);
});

test("mở chốt T9 khi T10 còn chốt: phải mở T10 trước; T8 chốt không chặn", () => {
  assert.deepEqual(unlockBlockers(T9, [{ ...T8, status: "LOCKED" }, T10], "LOCKED"), ["KKT-2026-0050"]);
  assert.deepEqual(unlockBlockers(T10, [T9], "LOCKED"), []);
});

test("đầu kỳ so với số kiểm đợt trước: Bao Xốp 3Kg kiểm T9 = 3 mà đầu kỳ T10 = −20", () => {
  const line = (itemId, opening, counted, extra = {}) => ({ itemId, itemCode: itemId, itemName: itemId, opening, counted, ...extra });
  const rows = openingMismatches(
    [line("VTTHBE00013", 23, 3), line("A", 0, 5), line("B", 2, 0, { notCounted: true }), line("C", 4, 0, { notCounted: true, countAsZero: true })],
    [line("VTTHBE00013", -20, 0), line("A", 5, 5), line("B", 7, 7), line("C", 0, 0), line("NEW", 2, 2)],
  );
  assert.deepEqual(rows.map((row) => [row.itemCode, row.opening, row.previousCounted]), [["VTTHBE00013", -20, 3], ["NEW", 2, 0]]);
});
