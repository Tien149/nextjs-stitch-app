import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShiftBounds, rankSalesItems, revenuePerGuest, shiftOfHour, summarizeSales, summarizeVisits } from "../lib/sales-analysis.ts";
import { spreadBillGuestCounts } from "../lib/revenue-guest-count.ts";

const bounds = { morningFrom: 5, noonFrom: 11, eveningFrom: 17 };
const cell = (code, kind, hour, quantity, amount, total = amount) => ({ code, kind, hour, quantity, amount, total, rows: 1 });

test("chia ca theo mốc giờ; giờ khuya trước mốc Sáng là đuôi ca Tối; không giờ để riêng", () => {
  assert.equal(shiftOfHour(7, bounds), "MORNING");
  assert.equal(shiftOfHour(10, bounds), "MORNING");
  assert.equal(shiftOfHour(11, bounds), "NOON");
  assert.equal(shiftOfHour(16, bounds), "NOON");
  assert.equal(shiftOfHour(17, bounds), "EVENING");
  assert.equal(shiftOfHour(2, bounds), "EVENING");
  assert.equal(shiftOfHour(null, bounds), "NO_HOUR");
});

test("mốc giờ nhập lộn xộn vẫn ra ba ca nối nhau", () => {
  assert.deepEqual(normalizeShiftBounds({ morningFrom: 6, noonFrom: 4, eveningFrom: 3 }), { morningFrom: 6, noonFrom: 7, eveningFrom: 8 });
  assert.deepEqual(normalizeShiftBounds({ morningFrom: "x" }), bounds);
});

test("gom theo ca × nhóm và theo món; lọc nhóm chỉ còn món của nhóm đó", () => {
  const cells = [
    cell("PHO", "FOOD", 8, 10, 1_000_000, 1_150_000),
    cell("PHO", "FOOD", 12, 4, 400_000, 460_000),
    cell("CAFE", "DRINK", 8, 20, 600_000),
    cell("CAFE", "DRINK", null, 5, 150_000),
    cell("KHAN", "SERVICE", 19, 30, 60_000),
  ];
  const all = summarizeSales(cells, bounds);
  assert.equal(all.total.amount, 2_210_000);
  assert.equal(all.byShift.MORNING.amount, 1_600_000);
  assert.equal(all.byShift.MORNING.byKind.DRINK.amount, 600_000);
  assert.equal(all.byShift.NOON.total, 460_000);
  assert.equal(all.byShift.NO_HOUR.quantity, 5);
  assert.equal(all.byHour[8].amount, 1_600_000);
  assert.deepEqual(all.items.map((item) => item.code), ["PHO", "CAFE", "KHAN"]);
  assert.equal(all.items[0].byShift.NOON.quantity, 4);
  const drinks = summarizeSales(cells, bounds, ["DRINK"]);
  assert.deepEqual(drinks.items.map((item) => item.code), ["CAFE"]);
  assert.equal(drinks.total.quantity, 25);
});

test("top bán chạy / bán chậm: bỏ món 0 đ (món trong combo) và món SL ≤ 0", () => {
  const items = summarizeSales([
    cell("A", "FOOD", 8, 50, 5_000_000),
    cell("B", "FOOD", 8, 3, 900_000),
    cell("C", "FOOD", 8, 1, 50_000),
    cell("SOT", "FOOD", 8, 200, 0),
    cell("TRA", "FOOD", 8, -1, -50_000),
  ], bounds).items;
  assert.deepEqual(rankSalesItems(items, { by: "quantity", order: "best", limit: 2, skipFree: true }).map((item) => item.code), ["A", "B"]);
  assert.deepEqual(rankSalesItems(items, { by: "quantity", order: "best", limit: 1, skipFree: false }).map((item) => item.code), ["SOT"]);
  assert.deepEqual(rankSalesItems(items, { by: "quantity", order: "worst", limit: 10, skipFree: true }).map((item) => item.code), ["C", "B", "A"]);
  assert.deepEqual(rankSalesItems(items, { by: "amount", order: "worst", limit: 1, skipFree: true }).map((item) => item.code), ["C"]);
});

test("một mã khai lệch nhóm giữa các ngày vẫn là một món, nhóm theo phần doanh thu lớn", () => {
  const items = summarizeSales([cell("X", "OTHER", 9, 1, 10_000), cell("X", "FOOD", 9, 5, 500_000)], bounds).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "FOOD");
  assert.equal(items[0].quantity, 6);
});

test("số khách theo hoá đơn: ghi lặp trên mọi dòng món chỉ tính một lần; dòng không số HĐ giữ nguyên", () => {
  const day = new Date("2026-11-20T00:00:00Z");
  const row = (bill, guests, product) => ({ values: { sale_date: day, branch_code: "ASA", bill_code: bill, guest_count: guests, product_code: product } });
  const out = spreadBillGuestCounts([row("HD1", 4, "PHO"), row("HD1", 4, "CAFE"), row("HD1", 4, "TRA"), row("HD2", null, "PHO"), row("HD2", 2, "BIA"), row("", 3, "X")]);
  assert.deepEqual(out.map((r) => r.values.guest_count), [4, 0, 0, 2, 0, 3]);
  assert.deepEqual(out.map((r) => r.values.order_count), [1, 0, 0, 1, 0, undefined]);
  const total = out.reduce((sum, r) => sum + Number(r.values.guest_count || 0), 0);
  assert.equal(total, 9);
});

test("lượt khách: chia ca, DT/khách bỏ kênh không ghi khách (Grab)", () => {
  const v = (date, hour, channel, guests, bills, amount) => ({ date, hour, channel, guests, bills, amount, total: amount });
  const summary = summarizeVisits([
    v("2026-11-01", 8, "Tại chỗ", 10, 4, 2_000_000),
    v("2026-11-01", 19, "Tại chỗ", 30, 10, 9_000_000),
    v("2026-11-01", 19, "Grab", 0, 5, 1_000_000),
    v("2026-11-02", null, "Tại chỗ", 5, 2, 500_000),
  ], bounds);
  assert.equal(summary.total.guests, 45);
  assert.equal(summary.byShift.MORNING.guests, 10);
  assert.equal(summary.byShift.EVENING.guests, 30);
  assert.equal(summary.byShift.NO_HOUR.guests, 5);
  assert.deepEqual(summary.guestChannels, ["Tại chỗ"]);
  assert.equal(revenuePerGuest(summary.total), 11_500_000 / 45);
  assert.equal(summary.byDay.length, 2);
  assert.equal(summary.byDay[0].bills, 19);
  assert.equal(summary.byChannel[0].channel, "Tại chỗ");
});
