import assert from "node:assert/strict";
import test from "node:test";
import { payrollCatalogItemCode, resolvePnlItemCode } from "../lib/reports.ts";

const catalog = [
  { code: "PNL_GV_NVL", name: "Giá vốn nguyên vật liệu", subGroup: "GV", status: "ACTIVE" },
  { code: "PNL_CP_KHAUHAO", name: "Chi phí khấu hao", subGroup: "CPBD", status: "ACTIVE" },
  { code: "PNL_CP_LUONG", name: "Chi phí lương và phụ cấp", subGroup: "CPNLD", status: "ACTIVE" },
];

test("hạng mục lương lấy từ danh mục theo tên, bỏ qua hạng mục đã ngừng", () => {
  assert.equal(payrollCatalogItemCode(catalog), "PNL_CP_LUONG");
  assert.equal(payrollCatalogItemCode(catalog.map((item) => ({ ...item, status: "INACTIVE" }))), null);
  assert.equal(payrollCatalogItemCode([]), null);
});

test("bút toán lương 6421 tự nhận hạng mục lương, không rơi vào Chưa phân loại", () => {
  const payrollLine = { pnlItemCode: null, account: { reportGroup: "PAYROLL" } };
  assert.equal(resolvePnlItemCode(payrollLine, "PNL_CP_KHAUHAO", "PNL_CP_LUONG"), "PNL_CP_LUONG");
  // Không truyền mã lương (nơi gọi cũ) thì giữ nguyên hành vi trước đây.
  assert.equal(resolvePnlItemCode(payrollLine, "PNL_CP_KHAUHAO"), null);
});

test("hạng mục khai tay trên chứng từ luôn thắng mã suy ra theo tài khoản", () => {
  const line = { pnlItemCode: "PNL_CP_MATBANG", account: { reportGroup: "PAYROLL" } };
  assert.equal(resolvePnlItemCode(line, "PNL_CP_KHAUHAO", "PNL_CP_LUONG"), "PNL_CP_MATBANG");
});

test("bút toán chi phí thường vẫn không có hạng mục nếu chưa khai", () => {
  const line = { pnlItemCode: null, account: { reportGroup: "OPEX" } };
  assert.equal(resolvePnlItemCode(line, "PNL_CP_KHAUHAO", "PNL_CP_LUONG"), null);
});
