/**
 * Lọc khoảng ngày dùng chung (khách yêu cầu 03/10/2026): nút nhanh, so theo ngày VN, kỳ giao khoảng.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-date-range.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dateRangePreset, inDateRange, periodInRange, prismaDateRange } from "../lib/date-range.ts";

const now = new Date("2026-10-03T18:30:00Z"); // 04/10 01:30 giờ VN

test("nút nhanh theo ngày VN", () => {
  assert.deepEqual(dateRangePreset("this-month", now), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(dateRangePreset("last-month", now), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(dateRangePreset("last-30", now), { from: "2026-09-05", to: "2026-10-04" });
  assert.deepEqual(dateRangePreset("last-month", new Date("2026-01-10T00:00:00Z")), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(dateRangePreset("all", now), { from: "", to: "" });
});

test("inDateRange: mốc 00:00 UTC, 03:00 UTC và 17:00 UTC hôm trước đều là cùng ngày VN", () => {
  const range = { from: "2026-10-01", to: "2026-10-01" };
  assert.equal(inDateRange("2026-10-01T00:00:00Z", range), true);
  assert.equal(inDateRange("2026-10-01T03:00:00Z", range), true);
  assert.equal(inDateRange("2026-09-30T17:00:00Z", range), true);
  assert.equal(inDateRange("2026-10-01T17:00:00Z", range), false);
  assert.equal(inDateRange(null, range), false);
  assert.equal(inDateRange(null, { from: "", to: "" }), true);
});

test("prismaDateRange: nửa mở theo giờ VN", () => {
  const range = prismaDateRange({ from: "2026-10-01", to: "2026-10-31" });
  assert.equal(range.gte.toISOString(), "2026-09-30T17:00:00.000Z");
  assert.equal(range.lt.toISOString(), "2026-10-31T17:00:00.000Z");
  assert.equal(prismaDateRange({ from: "", to: null }), null);
  assert.deepEqual(Object.keys(prismaDateRange({ to: "2026-10-31" })), ["lt"]);
});

test("periodInRange: kỳ giao khoảng là tính", () => {
  assert.equal(periodInRange("2026-09", { from: "2026-09-15", to: "" }), true);
  assert.equal(periodInRange("2026-08", { from: "2026-09-15", to: "" }), false);
  assert.equal(periodInRange("2026-11", { from: "", to: "2026-10-31" }), false);
});
