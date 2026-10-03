/**
 * Bảng giá NCC (khách yêu cầu 03/10/2026): chọn giá hiệu lực theo ngày + cửa hàng, lệch giá,
 * import Excel gom theo NCC × cửa hàng × khoảng ngày.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-supplier-price-list.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { activePrices, buildPriceImport, dayToDate, parseDay, parseMonth, priceDeviation, priceListInMonth, priceListStatus } from "../lib/supplier-price-list.ts";

const list = (id, extra) => ({
  id, code: id, supplierCode: "NCC1", supplierName: "Một", branchCode: null,
  effectiveFrom: dayToDate("2026-10-01"), effectiveTo: dayToDate("2026-10-31"), createdAt: "2026-09-30T00:00:00Z",
  lines: [{ itemId: "a", unitCode: "THUNG", conversionRate: 24, unitPrice: 240000, vatRate: 0.1 }],
  ...extra,
});

test("hiệu lực hai đầu tính, theo ngày giờ VN", () => {
  const lists = [list("L1")];
  assert.equal(activePrices(lists, { day: "2026-10-01" }).size, 1);
  assert.equal(activePrices(lists, { day: "2026-10-31" }).size, 1);
  assert.equal(activePrices(lists, { day: "2026-11-01" }).size, 0);
  assert.equal(activePrices(lists, { day: "2026-10-15" }).get("NCC1|a").stockUnitPrice, 10000);
});

test("bảng giữa tháng đè bảng đầu tháng; bảng riêng cửa hàng thắng bảng chung", () => {
  const lists = [
    list("L1"),
    list("L2", { effectiveFrom: dayToDate("2026-10-16"), effectiveTo: null, lines: [{ itemId: "a", unitCode: "LON", conversionRate: 1, unitPrice: 11000, vatRate: 0.08 }] }),
    list("L3", { branchCode: "HCM", lines: [{ itemId: "a", unitCode: "LON", conversionRate: 1, unitPrice: 9000, vatRate: null }] }),
  ];
  assert.equal(activePrices(lists, { day: "2026-10-10", branchCode: "HN" }).get("NCC1|a").priceListCode, "L1");
  assert.equal(activePrices(lists, { day: "2026-10-20", branchCode: "HN" }).get("NCC1|a").priceListCode, "L2");
  assert.equal(activePrices(lists, { day: "2026-10-20", branchCode: "HCM" }).get("NCC1|a").priceListCode, "L3");
});

test("trạng thái + giao tháng", () => {
  assert.equal(priceListStatus(list("L1"), "2026-09-30"), "UPCOMING");
  assert.equal(priceListStatus(list("L1"), "2026-10-05"), "ACTIVE");
  assert.equal(priceListStatus(list("L1"), "2026-11-01"), "EXPIRED");
  assert.equal(priceListInMonth(list("L1"), "2026-10"), true);
  assert.equal(priceListInMonth(list("L1"), "2026-11"), false);
  assert.equal(priceListInMonth(list("L1", { effectiveTo: null }), "2027-03"), true);
});

test("lệch giá: dưới 1 đ hoặc 0,5% coi là khớp", () => {
  assert.equal(priceDeviation(10000.4, 10000).matched, true);
  assert.equal(priceDeviation(10040, 10000).matched, true);
  const off = priceDeviation(10600, 10000);
  assert.deepEqual([off.matched, off.diff, Math.round(off.ratio * 1000)], [false, 600, 60]);
});

test("đọc ngày / tháng nhiều kiểu", () => {
  assert.equal(parseDay("05/10/2026"), "2026-10-05");
  assert.equal(parseDay("2026-10-05"), "2026-10-05");
  assert.equal(parseDay(46300), "2026-10-05");
  assert.equal(parseMonth("10/2026"), "2026-10");
  assert.equal(parseMonth("T10/2026"), "2026-10");
  assert.equal(parseMonth("2026-10"), "2026-10");
});

test("import: gom nhóm, quy đổi ĐVT, báo lỗi đúng dòng", () => {
  const lookup = {
    suppliers: new Map([["NCC1", "Một"], ["NCC2", "Hai"]]),
    items: new Map([["BIA", { id: "a", code: "BIA", name: "Bia", unit: "lon", unitConversions: [{ unitCode: "THUNG", conversionRate: 24 }] }]]),
    branches: new Set(["HCM"]),
  };
  const { groups, errors } = buildPriceImport([
    { "Mã NCC": "ncc1", "Tháng áp dụng": "10/2026", "Mã hàng": "bia", "ĐVT": "thung", "Đơn giá trước thuế": "240.000", "Thuế suất": "10%" },
    { "Mã NCC": "NCC2", "Tháng áp dụng": "10/2026", "Cửa hàng": "HCM", "Mã hàng": "BIA", "Đơn giá trước thuế": 9500, "Thuế suất": "KKKNT" },
    { "Mã NCC": "NCC9", "Tháng áp dụng": "10/2026", "Mã hàng": "BIA", "Đơn giá trước thuế": 1 },
    { "Ma NCC": "NCC1", "Thang ap dung": "10/2026", "Ma hang": "BIA", "DVT": "KG", "Don gia truoc thue": 1 },
    { "Mã NCC": "NCC1", "Từ ngày": "16/10/2026", "Mã hàng": "BIA", "Đơn giá trước thuế": 1, "Thuế suất": "7%" },
    {},
  ], lookup);
  assert.equal(groups.length, 2);
  assert.deepEqual([groups[0].from, groups[0].to, groups[0].lines[0].conversionRate, groups[0].lines[0].unitPrice, groups[0].lines[0].vatRate], ["2026-10-01", "2026-10-31", 24, 240000, 0.1]);
  assert.deepEqual([groups[1].branchCode, groups[1].lines[0].unitCode, groups[1].lines[0].vatRate], ["HCM", "LON", null]);
  assert.deepEqual(errors.map((error) => error.row), [4, 5, 6]);
});
