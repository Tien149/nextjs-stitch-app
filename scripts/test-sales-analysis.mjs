import test from "node:test";
import assert from "node:assert/strict";
import { NO_HOUR, normalizeShiftDefs, orderedShiftNames, rankSalesItems, revenuePerGuest, shiftNameAt, shiftRangeOf, summarizeSales, summarizeVisits } from "../lib/sales-analysis.ts";
import { spreadBillGuestCounts } from "../lib/revenue-guest-count.ts";
import { parseImportMinuteSlot } from "../lib/import-date.ts";

// Ca khách gửi 20/11/2026.
const NME = [{ name: "Sáng", from: "10:00" }, { name: "Tối", from: "15:00" }];
const ASA = [{ name: "Sáng", from: "00:00" }, { name: "Trưa", from: "10:30" }, { name: "Tối", from: "15:00" }];
const configs = { NME, ASA };
const names = orderedShiftNames(configs, ["ASA", "NME"]);
const cell = (code, kind, hour, quantity, amount, extra = {}) => ({ code, kind, branchCode: "ASA", hour, minute: null, quantity, amount, total: amount, rows: 1, ...extra });

test("ca theo từng nhà hàng: ASA Trưa từ 10:30, NME chỉ Sáng/Tối; trước ca đầu tính vào ca cuối", () => {
  assert.equal(shiftNameAt(ASA, 10, 15), "Sáng");
  assert.equal(shiftNameAt(ASA, 10, 30), "Trưa");
  assert.equal(shiftNameAt(ASA, 14, 45), "Trưa");
  assert.equal(shiftNameAt(ASA, 15, 0), "Tối");
  assert.equal(shiftNameAt(ASA, 7, null), "Sáng");
  assert.equal(shiftNameAt(NME, 12, 0), "Sáng");
  assert.equal(shiftNameAt(NME, 21, 0), "Tối");
  assert.equal(shiftNameAt(NME, 1, 0), "Tối");
  assert.equal(shiftNameAt(NME, null, null), NO_HOUR);
  assert.equal(shiftRangeOf(ASA, "Trưa"), "10:30 – 14:59");
  assert.equal(shiftRangeOf(NME, "Tối"), "15:00 – 09:59");
  assert.deepEqual(names, ["Sáng", "Trưa", "Tối"]);
});

test("khai ca: bỏ dòng thiếu, làm tròn khung 15 phút, xếp theo giờ, trùng tên/giờ giữ dòng đầu", () => {
  assert.deepEqual(normalizeShiftDefs([{ name: "Tối", from: "15:00" }, { name: " Sáng ", from: "10:07" }, { name: "", from: "08:00" }, { name: "sáng", from: "11:00" }, { name: "Khuya", from: "15:00" }]),
    [{ name: "Sáng", from: "10:00" }, { name: "Tối", from: "15:00" }]);
  assert.deepEqual(normalizeShiftDefs("x"), []);
});

test("phút bán đọc theo khung 15 phút, chỉ khi ô có phút", () => {
  assert.equal(parseImportMinuteSlot("10:37", 10), 30);
  assert.equal(parseImportMinuteSlot("11/11/2026 07:02", 7), 0);
  assert.equal(parseImportMinuteSlot("13", 13), null);
  assert.equal(parseImportMinuteSlot("10:37", null), null);
});

test("gom theo ca × nhóm và theo món, mỗi cửa hàng theo ca của mình", () => {
  const cells = [
    cell("PHO", "FOOD", 10, 10, 1_000_000, { minute: 15 }),
    cell("PHO", "FOOD", 10, 4, 400_000, { minute: 45 }),
    cell("CAFE", "DRINK", 12, 20, 600_000, { branchCode: "NME" }),
    cell("CAFE", "DRINK", null, 5, 150_000),
  ];
  const all = summarizeSales(cells, configs, names);
  assert.equal(all.total.amount, 2_150_000);
  assert.equal(all.byShift["Sáng"].amount, 1_600_000);
  assert.equal(all.byShift["Sáng"].byKind.DRINK.amount, 600_000);
  assert.equal(all.byShift["Trưa"].amount, 400_000);
  assert.equal(all.byShift[NO_HOUR].quantity, 5);
  assert.equal(all.items[0].byShift["Trưa"].quantity, 4);
  assert.deepEqual(summarizeSales(cells, configs, names, ["DRINK"]).items.map((item) => item.code), ["CAFE"]);
});

test("top bán chạy / bán chậm: bỏ món 0 đ (món trong combo) và món SL ≤ 0", () => {
  const items = summarizeSales([
    cell("A", "FOOD", 8, 50, 5_000_000),
    cell("B", "FOOD", 8, 3, 900_000),
    cell("C", "FOOD", 8, 1, 50_000),
    cell("SOT", "FOOD", 8, 200, 0),
    cell("TRA", "FOOD", 8, -1, -50_000),
  ], configs, names).items;
  assert.deepEqual(rankSalesItems(items, { by: "quantity", order: "best", limit: 2, skipFree: true }).map((item) => item.code), ["A", "B"]);
  assert.deepEqual(rankSalesItems(items, { by: "quantity", order: "best", limit: 1, skipFree: false }).map((item) => item.code), ["SOT"]);
  assert.deepEqual(rankSalesItems(items, { by: "quantity", order: "worst", limit: 10, skipFree: true }).map((item) => item.code), ["C", "B", "A"]);
});

test("một mã khai lệch nhóm giữa các ngày vẫn là một món, nhóm theo phần doanh thu lớn", () => {
  const items = summarizeSales([cell("X", "OTHER", 9, 1, 10_000), cell("X", "FOOD", 9, 5, 500_000)], configs, names).items;
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "FOOD");
});

test("số khách theo hoá đơn: ghi lặp trên mọi dòng món chỉ tính một lần; dòng không số HĐ giữ nguyên", () => {
  const day = new Date("2026-11-20T00:00:00Z");
  const row = (bill, guests, product) => ({ values: { sale_date: day, branch_code: "ASA", bill_code: bill, guest_count: guests, product_code: product } });
  const out = spreadBillGuestCounts([row("HD1", 4, "PHO"), row("HD1", 4, "CAFE"), row("HD1", 4, "TRA"), row("HD2", null, "PHO"), row("HD2", 2, "BIA"), row("", 3, "X")]);
  assert.deepEqual(out.map((r) => r.values.guest_count), [4, 0, 0, 2, 0, 3]);
  assert.deepEqual(out.map((r) => r.values.order_count), [1, 0, 0, 1, 0, undefined]);
});

test("lượt khách: chia ca theo cửa hàng, DT/khách bỏ kênh không ghi khách (Grab)", () => {
  const v = (date, branchCode, hour, minute, channel, guests, bills, amount) => ({ date, branchCode, hour, minute, channel, guests, bills, amount, total: amount });
  const summary = summarizeVisits([
    v("2026-11-01", "ASA", 10, 30, "Tại chỗ", 10, 4, 2_000_000),
    v("2026-11-01", "NME", 19, 0, "Tại chỗ", 30, 10, 9_000_000),
    v("2026-11-01", "NME", 19, 0, "Grab", 0, 5, 1_000_000),
    v("2026-11-02", "ASA", null, null, "Tại chỗ", 5, 2, 500_000),
  ], configs, names);
  assert.equal(summary.total.guests, 45);
  assert.equal(summary.byShift["Trưa"].guests, 10);
  assert.equal(summary.byShift["Tối"].guests, 30);
  assert.equal(summary.byShift[NO_HOUR].guests, 5);
  assert.equal(revenuePerGuest(summary.total), 11_500_000 / 45);
  assert.equal(summary.byDay[0].bills, 19);
});
