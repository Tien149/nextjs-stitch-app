import test from "node:test";
import assert from "node:assert/strict";
import { parseImportDate } from "../lib/import-date.ts";

function dateKey(value) {
  return value?.toISOString().slice(0, 10) ?? null;
}

test("parses the JavaScript date strings found in production import logs", () => {
  assert.equal(
    dateKey(parseImportDate("Sun Aug 09 2026 07:00:00 GMT+0700 (Indochina Time)")),
    "2026-08-09",
  );
  assert.equal(
    dateKey(parseImportDate("Thu Aug 06 2026 07:00:00 GMT+0700 (Indochina Time)")),
    "2026-08-06",
  );
});

test("keeps supported import date formats normalized to UTC", () => {
  assert.equal(dateKey(parseImportDate("2026-08-09")), "2026-08-09");
  assert.equal(dateKey(parseImportDate("09/08/2026")), "2026-08-09");
  assert.equal(dateKey(parseImportDate("09-08-2026 15:10:10")), "2026-08-09");
});

test("rejects invalid and ambiguous date strings", () => {
  assert.equal(parseImportDate("31/02/2026"), null);
  assert.equal(parseImportDate("08/09/26"), null);
  assert.equal(parseImportDate("not a date"), null);
});
