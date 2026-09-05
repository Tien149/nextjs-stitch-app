import assert from "node:assert/strict";
import test from "node:test";
import { comparePnlGroups, comparePnlItems, isPayrollPnlItem, isPayrollPnlName, opexGroupRank } from "../lib/pnl-ordering.ts";
import { createPnlDetailTree, pnlLineKeyOf } from "../lib/reports.ts";

test("hạng mục lương / nhân sự nhận diện được cả có dấu lẫn không dấu", () => {
  assert.equal(isPayrollPnlName("Chi phí lương người lao động"), true);
  assert.equal(isPayrollPnlName("Chi phi luong nguoi lao dong"), true);
  assert.equal(isPayrollPnlName("Lương và phụ cấp"), true);
  assert.equal(isPayrollPnlName("Chi phí nhân sự"), true);
  assert.equal(isPayrollPnlName("Tiền công thời vụ"), true);
});

test("không nhầm số lượng / năng lượng / đo lường thành lương", () => {
  assert.equal(isPayrollPnlName("Chi phí năng lượng"), false);
  assert.equal(isPayrollPnlName("Hao hụt số lượng"), false);
  assert.equal(isPayrollPnlName("Thiết bị đo lường"), false);
  assert.equal(isPayrollPnlName("Chi phí thuê mặt bằng"), false);
  assert.equal(isPayrollPnlName(""), false);
  assert.equal(isPayrollPnlName(null), false);
});

test("hạng mục thuộc nhóm nhân sự cũng là chi phí nhân sự", () => {
  assert.equal(isPayrollPnlItem({ name: "Thưởng KPI", groupName: "Chi phí nhân sự" }), true);
  assert.equal(isPayrollPnlItem({ name: "Chi phí điện nước", groupName: "Chi phí cố định" }), false);
  assert.equal(isPayrollPnlItem(null), false);
});

test("bút toán 6428 gắn hạng mục lương lên dòng Chi phí nhân sự, các dòng khác giữ nguyên", () => {
  const opex = { accountType: "OPEX", reportGroup: "OPEX" };
  assert.equal(pnlLineKeyOf(opex, { name: "Chi phí lương người lao động", groupName: "Chi phí cố định" }), "payroll");
  assert.equal(pnlLineKeyOf(opex, { name: "Chi phí thuê mặt bằng", groupName: "Chi phí cố định" }), "otherOpex");
  assert.equal(pnlLineKeyOf(opex), "otherOpex");
  assert.equal(pnlLineKeyOf({ accountType: "OPEX", reportGroup: "PAYROLL" }), "payroll");
  assert.equal(pnlLineKeyOf({ accountType: "OPEX", reportGroup: "DEPRECIATION" }, { name: "Lương" }), "depreciation");
  assert.equal(pnlLineKeyOf({ accountType: "COGS", reportGroup: "COGS" }, { name: "Lương bếp" }), "cogs");
});

test("nhóm OPEX xếp cố định -> marketing -> biến đổi -> khác, chưa phân loại cuối", () => {
  assert.equal(opexGroupRank("Chi phí cố định"), 0);
  assert.equal(opexGroupRank("Chi phí marketing"), 1);
  assert.equal(opexGroupRank("Chi phí biến đổi"), 2);
  assert.equal(opexGroupRank("Chi phí quản lý doanh nghiệp"), 3);
  const groups = [
    { name: "Chi phí quản lý doanh nghiệp" },
    { name: "Chưa gắn nhóm hạng mục P&L", last: true },
    { name: "Chi phí biến đổi" },
    { name: "Chi phí marketing" },
    { name: "Chi phí cố định" },
    { name: "Chi phí bán hàng" },
  ].sort(comparePnlGroups);
  assert.deepEqual(groups.map((group) => group.name), [
    "Chi phí cố định",
    "Chi phí marketing",
    "Chi phí biến đổi",
    "Chi phí bán hàng",
    "Chi phí quản lý doanh nghiệp",
    "Chưa gắn nhóm hạng mục P&L",
  ]);
});

test("hạng mục trong nhóm xếp abc tiếng Việt, chưa phân loại cuối", () => {
  const items = [
    { name: "Chi phí thuê mặt bằng" },
    { name: "Chưa phân loại P&L", last: true },
    { name: "Chi phí điện nước" },
    { name: "Chi phí bảo vệ" },
    { name: "Chi phí Internet" },
  ].sort(comparePnlItems);
  assert.deepEqual(items.map((item) => item.name), [
    "Chi phí bảo vệ",
    "Chi phí điện nước",
    "Chi phí Internet",
    "Chi phí thuê mặt bằng",
    "Chưa phân loại P&L",
  ]);
});

/**
 * Dòng Doanh thu phải xoè ra theo KÊNH BÁN (05/09/2026). Trước đây bút toán 511 chỉ mang danh
 * mục nguồn thu nên cả năm hiện đúng một dòng "Thu bán hàng trong ngày" không bóc tách được.
 */
test("dòng Doanh thu tách theo kênh bán: nhóm là nguồn thu, hạng mục là kênh", () => {
  const catalog = {
    pnlItems: [
      { code: "PNL_DT_TAICHO", name: "Doanh thu tại chỗ", group: "REVENUE_SOURCE", subGroup: "PNL_DOANHTHU" },
      { code: "PNL_DT_MANGVE", name: "Doanh thu mang về", group: "REVENUE_SOURCE", subGroup: "PNL_DOANHTHU" },
    ],
    pnlGroups: [{ code: "PNL_DOANHTHU", name: "Doanh thu bán hàng", group: "REVENUE_SOURCE" }],
    categories: [{ code: "THU_BANHANG", name: "Thu bán hàng trong ngày" }],
  };
  const tree = createPnlDetailTree(catalog, 1);
  const revenueAccount = { accountType: "REVENUE", reportGroup: "REVENUE" };
  tree.add({ account: revenueAccount, pnlItemCode: "PNL_DT_TAICHO", categoryCode: "THU_BANHANG", debit: 0, credit: 800 }, 0);
  tree.add({ account: revenueAccount, pnlItemCode: "PNL_DT_MANGVE", categoryCode: "THU_BANHANG", debit: 0, credit: 200 }, 0);
  tree.add({ account: revenueAccount, pnlItemCode: null, categoryCode: "THU_BANHANG", debit: 0, credit: 50 }, 0);

  const groups = tree.groupsOf("revenue");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].code, "THU_BANHANG");
  assert.equal(groups[0].total, 1050, "tổng nhóm vẫn là toàn bộ doanh thu, kể cả dòng chưa rõ kênh");
  assert.deepEqual(
    groups[0].items.map((item) => [item.code, item.total]),
    [[ "PNL_DT_MANGVE", 200 ], [ "PNL_DT_TAICHO", 800 ]],
    "chỉ dòng có kênh mới thành hạng mục con, xếp abc theo tên",
  );
});
