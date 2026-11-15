import test from "node:test";
import assert from "node:assert/strict";
import { paginateOrderLines } from "../lib/purchase-order-share.ts";

const lines = (count, noteEvery = 0) => Array.from({ length: count }, (_, index) => ({
  itemCode: `M${index}`, itemName: `Mon ${index}`, unit: "Kg", quantity: 1, unitCost: 0, totalCost: 0,
  note: noteEvery && index % noteEvery === 0 ? "ghi chu" : null,
}));

test("đơn ngắn: một ảnh", () => {
  assert.deepEqual(paginateOrderLines(lines(12)), [{ start: 0, end: 12 }]);
  assert.deepEqual(paginateOrderLines(lines(20)), [{ start: 0, end: 20 }]);
});

test("ca thật PO-2026-0710: 50 món tách 3 ảnh, phủ đủ, không trang nào quá dài hay lẻ loi", () => {
  const pages = paginateOrderLines(lines(50, 10));
  assert.equal(pages.length, 3);
  assert.equal(pages[0].start, 0);
  assert.equal(pages.at(-1).end, 50);
  for (let i = 1; i < pages.length; i += 1) assert.equal(pages[i].start, pages[i - 1].end);
  assert.ok(pages[0].end <= 16);
  for (const page of pages.slice(1)) assert.ok(page.end - page.start >= 10 && page.end - page.start <= 24, JSON.stringify(pages));
});

test("21 món: hai ảnh, trang 1 tối đa 16 món vì còn phần Thông tin đặt hàng", () => {
  const pages = paginateOrderLines(lines(21));
  assert.equal(pages.length, 2);
  assert.deepEqual(pages, [{ start: 0, end: 16 }, { start: 16, end: 21 }]);
});
