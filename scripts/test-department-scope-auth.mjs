/**
 * Quyền màn con + phạm vi phòng ban (kiểm kê CCDC/tài sản theo bộ phận, 26/09/2026).
 *   npm run test:department-scope
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canOpenPath, canPerformMenuAction, allowedMenuTabs, menuParentPath } from "../lib/auth-demo.ts";
import { allowedDepartmentsOf, departmentAllowed, assertDepartmentAccess } from "../lib/department-scope.ts";

const session = (overrides = {}) => ({
  id: "u1", name: "Kiểm kê Bếp", role: "Kiem ke", branch: "NME", email: "kk@x.vn", loginAt: "",
  allowedBranches: ["NME"], menuAccess: [], actions: ["view", "create"], ...overrides,
});

test("menuParentPath: màn con -> màn cha, màn gốc -> null", () => {
  assert.equal(menuParentPath("/assets/operations?tab=stocktake"), "/assets");
  assert.equal(menuParentPath("/assets"), null);
  assert.equal(menuParentPath("/reports?tab=daily-cash"), null);
});

test("vai trò chỉ gán mục Kiểm kê mở được /assets/operations nhưng KHÔNG mở được /assets", () => {
  const user = session({ menuAccess: ["/assets/operations?tab=stocktake"] });
  assert.equal(canOpenPath(user, "/assets/operations"), true);
  assert.equal(canOpenPath(user, "/assets/operations?tab=stocktake"), true);
  assert.equal(canOpenPath(user, "/assets"), false);
  assert.deepEqual(allowedMenuTabs(user, "/assets/operations"), ["stocktake"]);
});

test("gán bằng TÊN mục menu cũng mở được màn con", () => {
  const user = session({ menuAccess: ["Kiểm kê CCDC & Tài sản"] });
  assert.equal(canOpenPath(user, "/assets/operations"), true);
  assert.equal(canOpenPath(user, "/assets"), false);
});

test("vai trò có /assets mở được cả màn con (giữ hành vi cũ)", () => {
  const user = session({ menuAccess: ["/assets"] });
  assert.equal(canOpenPath(user, "/assets/operations"), true);
  assert.equal(allowedMenuTabs(user, "/assets/operations"), null);
});

test("vai trò chuẩn: luật thao tác màn con lấy theo màn cha (/assets)", () => {
  // "Quản lý" không có create theo roleActions nhưng có create ở override "/assets".
  assert.equal(canPerformMenuAction("Quản lý", "/assets/operations", "create"), true);
  assert.equal(canPerformMenuAction("Quản lý", "/assets", "create"), true);
  assert.equal(canPerformMenuAction("Viewer", "/assets/operations", "create"), false);
});

test("phạm vi phòng ban: không gán = mọi phòng ban, Admin luôn thấy hết", () => {
  assert.equal(allowedDepartmentsOf(session()), null);
  assert.equal(allowedDepartmentsOf(session({ role: "Admin", allowedDepartments: ["KIT"] })), null);
  assert.deepEqual(allowedDepartmentsOf(session({ allowedDepartments: ["kit", "FOH"] })), ["KIT", "FOH"]);
});

test("phạm vi phòng ban: chỉ tài sản đúng phòng ban mới qua, chưa gán phòng ban thì không", () => {
  const user = session({ allowedDepartments: ["KIT"] });
  assert.equal(departmentAllowed(user, "KIT"), true);
  assert.equal(departmentAllowed(user, "kit"), true);
  assert.equal(departmentAllowed(user, "FOH"), false);
  assert.equal(departmentAllowed(user, null), false);
  assert.throws(() => assertDepartmentAccess(user, "FOH", "Tài sản X"), /BUSINESS:Tài sản X thuộc phòng ban FOH/);
  assert.doesNotThrow(() => assertDepartmentAccess(session(), "FOH", "Tài sản X"));
});
