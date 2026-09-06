import assert from "node:assert/strict";
import test from "node:test";
import { REVENUE_PNL_UNCLASSIFIED, loadRevenuePnlGroups } from "../lib/revenue-source.ts";

/**
 * Dòng "Doanh thu" của P&L chỉ được có 5 nhóm (spec khách 06/09/2026): bếp / bar / phụ thu +
 * SVC + thuế GTGT. Cột nhóm doanh thu trong file POS là chữ tự do nên phải quy về LOẠI MÓN,
 * nếu không mỗi cách gõ lại đẻ thêm một dòng doanh thu.
 *
 * Chạy: npm run test:revenue-pnl-groups
 */

/** Client giả chỉ trả danh mục Thu/Chi — đủ cho loadRevenuePnlGroups, không cần database. */
const clientWith = (categories) => ({
  masterDataItem: {
    findMany: async ({ where }) => categories
      .filter((category) => (where.status ? category.status === where.status : true))
      .map((category) => ({ code: category.code, name: category.name, group: category.group, matchKeywords: category.matchKeywords ?? null })),
  },
});

const catalog = [
  { code: "REV_FOOD", name: "Doanh Thu Bếp", group: "REVENUE_SOURCE", status: "ACTIVE" },
  { code: "REV_BAR", name: "Doanh Thu Bar", group: "REVENUE_SOURCE", status: "ACTIVE" },
  { code: "REV_SERVICE", name: "Doanh thu phụ thu", group: "REVENUE_SOURCE", status: "ACTIVE" },
  { code: "THU_BANHANG", name: "Thu bán hàng trong ngày", group: "RECEIPT", status: "ACTIVE" },
  { code: "THU_CONGNO_KHACH", name: "Thu công nợ khách hàng", group: "RECEIPT", status: "ACTIVE" },
];

test("chữ tự do trong file quy về đúng ba nhóm món của danh mục", async () => {
  const { groupOf } = await loadRevenuePnlGroups(clientWith(catalog));
  assert.equal(groupOf("ĐỒ ĂN").code, "REV_FOOD");
  assert.equal(groupOf("Đồ uống").code, "REV_BAR");
  assert.equal(groupOf("Dịch vụ").code, "REV_SERVICE");
  // Mã danh mục cũng phải về đúng nhóm đó, không đẻ thêm dòng thứ tư.
  assert.equal(groupOf("REV_FOOD").code, "REV_FOOD");
  assert.equal(groupOf("REV_BAR").code, "REV_BAR");
  assert.equal(groupOf("ĐỒ ĂN").name, "Doanh Thu Bếp");
});

test("loại thu quỹ không phải doanh thu — không được đứng thành nhóm doanh thu", async () => {
  const { groupOf } = await loadRevenuePnlGroups(clientWith(catalog));
  assert.equal(groupOf("THU_BANHANG").code, REVENUE_PNL_UNCLASSIFIED.code);
  assert.equal(groupOf("THU_CONGNO_KHACH").code, REVENUE_PNL_UNCLASSIFIED.code);
  assert.equal(groupOf("").code, REVENUE_PNL_UNCLASSIFIED.code);
  assert.equal(groupOf(null).code, REVENUE_PNL_UNCLASSIFIED.code);
});

test("mã danh mục của khách được ưu tiên, tên nhóm lấy theo danh mục", async () => {
  const custom = [
    { code: "REV_KITCHEN", name: "Doanh thu bếp NAM MÊ", group: "REVENUE_SOURCE", status: "ACTIVE" },
    { code: "DT_PHU", name: "Phụ thu dịch vụ", group: "REVENUE_SOURCE", status: "ACTIVE", matchKeywords: "SVC BAN" },
  ];
  const { groupOf, categories, seedGroups } = await loadRevenuePnlGroups(clientWith(custom));
  assert.equal(groupOf("ĐỒ ĂN").code, "REV_KITCHEN");
  assert.equal(groupOf("ĐỒ ĂN").name, "Doanh thu bếp NAM MÊ");
  assert.equal(groupOf("Dịch vụ").code, "DT_PHU");
  // Chưa có danh mục đồ uống thì vẫn có nhóm dự phòng để bảng đủ dòng.
  assert.equal(groupOf("Đồ uống").code, "REV_BAR");
  assert.equal(groupOf("Đồ uống").name, "Doanh thu bar");
  // Năm nhóm cố định của dòng Doanh thu + rổ chưa phân loại.
  assert.deepEqual(seedGroups.map((group) => group.code), ["REV_KITCHEN", "REV_BAR", "DT_PHU", "REV_SVC", "REV_VAT"]);
  assert.equal(categories.length, 6);
  assert.equal(categories.at(-1).code, REVENUE_PNL_UNCLASSIFIED.code);
});

test("SVC và thuế GTGT lấy tên trên danh mục của khách nếu có", async () => {
  const withNames = [
    ...catalog,
    { code: "REV_SVC", name: "Phụ phí dịch vụ 5%", group: "REVENUE_SOURCE", status: "ACTIVE" },
  ];
  const { seedGroups } = await loadRevenuePnlGroups(clientWith(withNames));
  const svc = seedGroups.find((group) => group.code === "REV_SVC");
  assert.equal(svc.name, "Phụ phí dịch vụ 5%");
  assert.equal(seedGroups.find((group) => group.code === "REV_VAT").name, "Doanh thu thuế GTGT");
});

test("chữ mang cả ăn lẫn uống không bị suy bừa về một bên", async () => {
  const { groupOf } = await loadRevenuePnlGroups(clientWith(catalog));
  assert.equal(groupOf("Combo ăn uống").code, REVENUE_PNL_UNCLASSIFIED.code);
});
