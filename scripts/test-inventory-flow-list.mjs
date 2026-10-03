/**
 * Danh sách Nhập kho / Xuất kho rút gọn phiếu chế biến của rã BOM (03/10/2026, bỏ giới hạn 2000
 * phiếu): giữ 3 dòng đầu + lineSummary; phiếu xuất bán và phiếu nhập tay giữ đủ dòng.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-inventory-flow-list.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compactFlowDocument, FLOW_PREVIEW_LINES } from "../lib/inventory-flow-list.ts";

const line = (code, quantity, totalCost, unit = "GR", vatAmount = 0) => ({ quantity, totalCost, vatAmount, item: { code, name: `Hàng ${code}`, unit } });
const doc = (transactionType, referenceType, lines) => ({ id: "x", code: "RA-1", transactionType, referenceType, lines });

test("phiếu xuất chế biến nhiều dòng: giữ 3 dòng đầu, số tổng nằm ở lineSummary", () => {
  const lines = [line("A", 10, 100), line("B", 20, 200), line("C", 30, 300), line("D", 40, 400), line("E", 5, 50, "ML")];
  const compact = compactFlowDocument(doc("XUAT_CHE_BIEN", "PRODUCTION", lines));
  assert.equal(compact.lines.length, FLOW_PREVIEW_LINES);
  assert.deepEqual(compact.lineSummary.units.sort(), ["GR", "ML"]);
  assert.equal(compact.lineSummary.count, 5);
  assert.equal(compact.lineSummary.totalCost, 1050);
  assert.equal(compact.lineSummary.quantity, 105);
  assert.match(compact.lineSummary.searchText, /E Hàng E/);
});

test("phiếu xuất bán, phiếu nhập tay và phiếu ít dòng giữ nguyên", () => {
  const many = [line("A", 1, 1), line("B", 1, 1), line("C", 1, 1), line("D", 1, 1)];
  for (const input of [doc("XUAT_BAN", "PRODUCTION", many), doc("NHAP_MUA", "IMPORT", many), doc("XUAT_CHE_BIEN", "PRODUCTION", many.slice(0, 3))]) {
    const output = compactFlowDocument(input);
    assert.equal(output, input);
    assert.equal("lineSummary" in output, false);
  }
});
