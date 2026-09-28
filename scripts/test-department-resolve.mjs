/**
 * Quy chữ ô Phòng ban của bảng lương về mã danh mục (lib/department-resolve.ts) — dùng chung cho
 * biểu đồ lương vs ngân sách và script repair:payroll-department.
 *
 * Chạy: node --experimental-strip-types --no-warnings --import ./scripts/register-alias.mjs --test scripts/test-department-resolve.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDepartmentResolver } from "../lib/department-resolve.ts";

const resolve = createDepartmentResolver([
  { code: "BAR", name: "Team Bar" },
  { code: "BEP", name: "Bộ phận Bếp" },
  { code: "FOH", name: "Phục vụ" },
  { code: "PV2", name: "Phục vụ" },
]);

test("khớp mã không phân biệt hoa thường", () => {
  assert.equal(resolve("bar"), "BAR");
  assert.equal(resolve(" BEP "), "BEP");
});

test("khớp đúng tên, bỏ dấu và hoa thường", () => {
  assert.equal(resolve("Team Bar"), "BAR");
  assert.equal(resolve("team  bar"), "BAR");
  assert.equal(resolve("Bộ phận Bếp"), "BEP");
});

test("không đoán: tên trùng giữa hai bộ phận, chữ lạ, ô trống", () => {
  assert.equal(resolve("Phục vụ"), null);
  assert.equal(resolve("Team Pha Che"), null);
  assert.equal(resolve(""), null);
  assert.equal(resolve(null), null);
  // Mã vẫn khớp dù tên của nó bị trùng.
  assert.equal(resolve("fOh"), "FOH");
});
