import assert from "node:assert/strict";
import test from "node:test";
import { comparePnlGroups, comparePnlItems, isPayrollPnlItem, isPayrollPnlName, opexGroupRank } from "../lib/pnl-ordering.ts";
import { pnlLineKeyOf } from "../lib/reports.ts";

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
