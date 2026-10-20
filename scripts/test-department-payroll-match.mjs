import assert from "node:assert/strict";
import test from "node:test";
import { matchDepartmentPayrollItem } from "../lib/pnl-ordering.ts";

/** Đúng danh mục lương trên VPS (04/10/2026). */
const items = [
  { code: "CPNLD_BEP", name: "01. CPNLD Lương Bếp" },
  { code: "CPNLD_BAR", name: "02. CPNLD Lương Bar" },
  { code: "CPNLD_FOH", name: "03. CPNLD Lương FOH" },
  { code: "CPNLD_BAOTRI", name: "04. CPNLD Lương Bảo Trì & Sữa Chữa" },
  { code: "CPNLD_BD-MKT", name: "05. CPNLD Lương BD & Marketing" },
  { code: "CPNLD_KT-MH-HR", name: "06. CPNLD Lương Tổng Hợp" },
];

test("phòng ban tên 'Team ...' khớp đúng hạng mục lương", () => {
  assert.equal(matchDepartmentPayrollItem(items, { code: "KIT", name: "Team Bếp" }), "CPNLD_BEP");
  assert.equal(matchDepartmentPayrollItem(items, { code: "BSC", name: "Team Bảo Trì - Sửa Chữa" }), "CPNLD_BAOTRI");
  assert.equal(matchDepartmentPayrollItem(items, { code: "BAR", name: "Team Bar" }), "CPNLD_BAR");
  assert.equal(matchDepartmentPayrollItem(items, { code: "APH", name: "Phòng Tổng Hợp" }), "CPNLD_KT-MH-HR");
  assert.equal(matchDepartmentPayrollItem(items, { code: "BDM", name: "Phòng BD - Marketing" }), "CPNLD_BD-MKT");
});

test("phòng ban đánh số thứ tự '01. Team Bếp' (VPS 20/10/2026) vẫn khớp", () => {
  assert.equal(matchDepartmentPayrollItem(items, { code: "KIT", name: "01. Team Bếp" }), "CPNLD_BEP");
  assert.equal(matchDepartmentPayrollItem(items, { code: "BAR", name: "02. Team Bar" }), "CPNLD_BAR");
  assert.equal(matchDepartmentPayrollItem(items, { code: "FOH", name: "03. Team FOH" }), "CPNLD_FOH");
  assert.equal(matchDepartmentPayrollItem(items, { code: "BSC", name: "04. Team Bảo Trì - Sửa Chữa" }), "CPNLD_BAOTRI");
  assert.equal(matchDepartmentPayrollItem(items, { code: "BDM", name: "05. Phòng BD - Marketing" }), "CPNLD_BD-MKT");
  assert.equal(matchDepartmentPayrollItem(items, { code: "APH", name: "06. Phòng Tổng Hợp" }), "CPNLD_KT-MH-HR");
});
