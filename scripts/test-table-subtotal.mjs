/**
 * Dòng CỘNG cuối bảng kho (khách yêu cầu 21/09/2026: "kiểu giống subtotal trên excel").
 *
 * Điều phải giữ: tổng PHẢI bằng đúng số người dùng cộng tay từ các dòng đang hiện. Nên làm
 * tròn theo TỪNG DÒNG rồi mới cộng, không cộng số gốc rồi tròn ở tổng.
 *
 * Chạy: npm run test:table-subtotal
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sumRoundedByRow, sumStockDocuments } from "../lib/table-subtotal.ts";

test("tròn theo từng dòng rồi mới cộng, không cộng số gốc rồi tròn", () => {
  // Ba dòng 0,5 đ: mắt thấy 1 + 1 + 1 = 3 (roundVnd tròn lên). Cộng gốc rồi tròn ra 2 — lệch.
  const rows = [{ value: 0.5 }, { value: 0.5 }, { value: 0.5 }];
  assert.equal(sumRoundedByRow(rows, (row) => row.value), 3);
  assert.notEqual(Math.round(rows.reduce((sum, row) => sum + row.value, 0)), 3);
});

test("khớp đúng ca thật đã gặp trên dữ liệu demo", () => {
  // 14 phiếu nhập kho: cộng tay ra 51.953.330, cộng số gốc rồi tròn ra 51.953.329.
  const docs = Array.from({ length: 13 }, () => ({ lines: [{ totalCost: 3996410 }] }));
  docs.push({ lines: [{ totalCost: 0.5 }] });
  const total = sumStockDocuments(docs);
  assert.equal(total.count, 14);
  assert.equal(total.beforeTax, 13 * 3996410 + 1);
});

test("cộng cả thuế GTGT và ra đúng tổng sau thuế", () => {
  const docs = [
    { lines: [{ totalCost: 82200, vatAmount: 6576 }, { totalCost: 52800, vatAmount: 2640 }] },
    { lines: [{ totalCost: 30000, vatAmount: 0 }] },
  ];
  const total = sumStockDocuments(docs);
  assert.equal(total.beforeTax, 165000);
  assert.equal(total.vat, 9216);
  assert.equal(total.afterTax, 174216);
});

test("dòng không khai thuế vẫn cộng được", () => {
  const total = sumStockDocuments([{ lines: [{ totalCost: 1000 }] }]);
  assert.equal(total.vat, 0);
  assert.equal(total.afterTax, 1000);
});

test("bảng rỗng ra 0, không vỡ", () => {
  const total = sumStockDocuments([]);
  assert.deepEqual(total, { count: 0, beforeTax: 0, vat: 0, afterTax: 0 });
  assert.equal(sumRoundedByRow([], () => 1), 0);
});

test("tổng luôn là số nguyên đồng", () => {
  const docs = [{ lines: [{ totalCost: 22030.4 }] }, { lines: [{ totalCost: 11015.6 }] }];
  const total = sumStockDocuments(docs);
  assert.ok(Number.isInteger(total.beforeTax));
  assert.ok(Number.isInteger(total.afterTax));
});
