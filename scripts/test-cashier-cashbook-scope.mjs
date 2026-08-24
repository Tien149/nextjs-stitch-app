import assert from "node:assert/strict";
import test from "node:test";
import {
  appMenuItems,
  allowedMenuTabs,
  canAccessMenu,
  canOpenPath,
  canPerformMenuAction,
  getDefaultRouteForRole,
  isCashierSubject,
} from "../lib/auth-demo.ts";
import { filterCashierCashSources, isCashierRoleName } from "../lib/money-sources.ts";

/** Đúng cấu hình vai trò THU NGÂN đang chạy: chỉ tab Sổ quỹ dòng tiền + hai màn của ca. */
const cashier = {
  id: "u1",
  name: "Thu ngân Asa",
  role: "Thu ngân",
  branch: "ASA",
  email: "thungan@fin-erp.vn",
  loginAt: "2026-08-24T00:00:00.000Z",
  allowedBranches: ["ASA"],
  menuAccess: ["/finance-operations?tab=cashbook", "/vouchers", "/reports?tab=daily-cash"],
  actions: ["view", "create", "edit", "export"],
};

const menuByName = (name) => appMenuItems.find((item) => item.name === name);

test("nhận vai trò thu ngân theo tên, bỏ qua dấu và hoa thường", () => {
  assert.equal(isCashierRoleName("Thu ngân"), true);
  assert.equal(isCashierRoleName("THU NGAN ca tối"), true);
  assert.equal(isCashierRoleName("thu_ngan"), true);
  assert.equal(isCashierRoleName("Kế toán tổng hợp"), false);
  assert.equal(isCashierRoleName(""), false);
  assert.equal(isCashierSubject(cashier), true);
});

test("gán riêng một tab thì mục menu cha vẫn hiện ngoài sidebar", () => {
  // Lỗi cũ: menuAccess chỉ có "/finance-operations?tab=cashbook" nên không mục nào khớp
  // tuyệt đối -> tick "Có" trong ma trận mà thu ngân không thấy Sổ quỹ đâu cả.
  assert.equal(canAccessMenu(cashier, menuByName("Sổ quỹ")), true);
  assert.equal(canOpenPath(cashier, "/finance-operations"), true);
  assert.deepEqual(allowedMenuTabs(cashier, "/finance-operations"), ["cashbook"]);
});

test("tab đã có mục menu riêng thì không kéo theo mục cha cùng trang", () => {
  // "/reports?tab=daily-cash" là mục menu riêng ("Thu chi ngày"); không được vì thế mà mở
  // luôn "Báo cáo & BI" hay "Dòng tiền" — cả ba dùng chung base path "/reports".
  assert.equal(canAccessMenu(cashier, menuByName("Thu chi ngày")), true);
  assert.equal(canAccessMenu(cashier, menuByName("Báo cáo & BI")), false);
  assert.equal(canAccessMenu(cashier, menuByName("Dòng tiền")), false);
  assert.equal(canAccessMenu(cashier, menuByName("Báo cáo nguồn tiền")), false);
});

test("không có Dashboard thì đăng nhập vào thẳng màn được phép, không rơi về /", () => {
  // Trả "/" là trang Dashboard lại đẩy về "/" lần nữa: người dùng đứng trước bảng điều hành
  // trắng trơn toàn số 0.
  const route = getDefaultRouteForRole(cashier);
  assert.notEqual(route, "/");
  assert.equal(canOpenPath(cashier, route), true);
});

test("Sổ quỹ với thu ngân là chỉ đọc, các màn khác giữ nguyên quyền", () => {
  assert.equal(canPerformMenuAction(cashier, "/finance-operations", "view"), true);
  for (const action of ["create", "edit", "approve", "delete", "export", "config"]) {
    assert.equal(canPerformMenuAction(cashier, "/finance-operations", action), false, action);
  }
  // Vẫn phải lập được phiếu và nộp tiền ở màn của ca.
  assert.equal(canPerformMenuAction(cashier, "/reports", "create"), true);
  assert.equal(canPerformMenuAction(cashier, "/vouchers", "edit"), true);
});

test("vai trò khác không bị màn Sổ quỹ thu hẹp quyền", () => {
  const accountant = { ...cashier, role: "Kế toán tổng hợp", menuAccess: [], actions: [] };
  assert.equal(canPerformMenuAction(accountant, "/finance-operations", "create"), true);
  assert.equal(canPerformMenuAction("Admin", "/finance-operations", "delete"), true);
});

const sources = [
  { code: "TM_THUNGAN_ASA", name: "Tiền mặt Thu ngân", group: "CASH", branch: "ASA", status: "ACTIVE" },
  { code: "TM_KET_ASA", name: "Két quản lý", group: "CASH", branch: "ASA", status: "ACTIVE" },
  { code: "VTB_ASA", name: "ASA - Vietinbank", group: "BANK", branch: "ASA", status: "ACTIVE" },
  { code: "MOMO_ASA", name: "Ví Momo", group: "WALLET", branch: "ASA", status: "ACTIVE" },
  { code: "TM_THUNGAN_NM", name: "Tiền mặt Thu ngân", group: "CASH", branch: "NM", status: "ACTIVE" },
  { code: "TM_CU_ASA", name: "Quỹ thu ngân cũ", group: "CASH", branch: "ASA", status: "INACTIVE" },
];

test("thu ngân chỉ còn quỹ tiền mặt thu ngân của cửa hàng mình", () => {
  const codes = filterCashierCashSources(sources, "ASA").map((source) => source.code);
  assert.deepEqual(codes, ["TM_THUNGAN_ASA"]);
});

test("cửa hàng chưa khai quỹ thu ngân thì giữ nguyên mọi quỹ tiền mặt của cửa hàng đó", () => {
  const chuaKhai = [
    { code: "TM_1", name: "Tiền mặt cửa hàng", group: "CASH", branch: "XX", status: "ACTIVE" },
    { code: "TM_2", name: "Két phụ", group: "CASH", branch: "XX", status: "ACTIVE" },
    { code: "VTB_XX", name: "Vietinbank", group: "BANK", branch: "XX", status: "ACTIVE" },
  ];
  const codes = filterCashierCashSources(chuaKhai, "XX").map((source) => source.code);
  assert.deepEqual(codes, ["TM_1", "TM_2"]);
});
