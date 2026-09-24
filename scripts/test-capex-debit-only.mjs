/**
 * Dòng CAPEX trên P&L chỉ lấy bên NỢ của 211/242.
 *
 * 211/242 còn bị ghi CÓ ở những nghiệp vụ không phải hoàn lại tiền đầu tư — rõ nhất là phân bổ
 * chi phí trả trước hàng kỳ (Nợ 6428 / Có 242). Trừ vế Có vào dòng CAPEX thì tháng nào chạy
 * phân bổ là CAPEX âm một cục đúng bằng số phân bổ (khách báo 21/09/2026: CAPEX tháng 9 hiện
 * −88.225.863 đ, trong khi tháng đó không mua sắm gì).
 *
 * Chạy: npm run test:capex-debit-only
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPnlDetailTree, createPnlItemRefLookup, DEPRECIATION_PNL_ACCOUNT, NON_CAPEX_SOURCE_TYPES, pnlLineAmount, pnlLineKeyOf, withDepreciationPnlItem } from "../lib/reports.ts";

test("CAPEX chỉ là đầu tư ban đầu: Nợ 211, không lấy 242", () => {
  assert.equal(pnlLineKeyOf({ accountType: "ASSET", reportGroup: "FIXED_ASSET" }), "capex");
  assert.equal(pnlLineKeyOf({ accountType: "ASSET", reportGroup: "PREPAID_EXPENSE" }), null);
});

test("tài sản/CCDC mua ở màn Tài sản và số dư đầu kỳ không lên dòng CAPEX", () => {
  assert.ok(NON_CAPEX_SOURCE_TYPES.includes("ASSET_ACQUISITION"));
  assert.ok(NON_CAPEX_SOURCE_TYPES.includes("OPENING_BALANCE"));
  assert.ok(!NON_CAPEX_SOURCE_TYPES.includes("VOUCHER"));
  assert.ok(!NON_CAPEX_SOURCE_TYPES.includes("DEBT_PAYABLE"));
});

test("CAPEX chỉ cộng bên Nợ", () => {
  assert.equal(pnlLineAmount("capex", { debit: 10770975, credit: 0 }), 10770975);
});

test("vế Có 242 của phân bổ KHÔNG trừ vào CAPEX", () => {
  // Bút toán phân bổ: Nợ 6428 88.225.863 / Có 242 88.225.863.
  // Vế Nợ đã nằm ở dòng OPEX; vế Có không được kéo CAPEX xuống âm.
  assert.equal(pnlLineAmount("capex", { debit: 0, credit: 88225863 }), 0);
});

test("mua sắm rồi phân bổ trong cùng kỳ: CAPEX vẫn là số đã bỏ ra", () => {
  const lines = [
    { debit: 88225863, credit: 0 },  // chi trả trước, treo Nợ 242
    { debit: 0, credit: 88225863 },  // phân bổ kỳ đầu, rút 242 xuống
  ];
  const capex = lines.reduce((sum, line) => sum + pnlLineAmount("capex", line), 0);
  assert.equal(capex, 88225863);
});

test("dòng chi phí thường vẫn lấy Nợ trừ Có", () => {
  assert.equal(pnlLineAmount("otherOpex", { debit: 1000, credit: 200 }), 800);
  assert.equal(pnlLineAmount("cogs", { debit: 500, credit: 0 }), 500);
  assert.equal(pnlLineAmount("payroll", { debit: 0, credit: 300 }), -300);
});

test("dòng thu lấy Có trừ Nợ", () => {
  assert.equal(pnlLineAmount("revenue", { debit: 0, credit: 5000 }), 5000);
  assert.equal(pnlLineAmount("otherIncome", { debit: 100, credit: 5000 }), 4900);
});

/**
 * Khách báo 23/09/2026: nhóm "Chi Phí Đầu Tư Ban Đầu" (hạng mục CAPEX_DTBD) đứng trong OPEX, bị
 * trừ vào lợi nhuận. Hạng mục nhóm CAPEX / nhóm tên "đầu tư ban đầu" phải lên dòng CAPEX.
 */
const capexCatalog = {
  pnlGroups: [
    { code: "CPCD", name: "Chi Phí Cố Định", group: "OPEX" },
    { code: "DTBD", name: "Chi Phí Đầu Tư Ban Đầu", group: "OPEX" },
  ],
  pnlItems: [
    { code: "CPCD_DIEN", name: "CPCĐ - CP Điện", group: "OPEX", subGroup: "CPCD" },
    { code: "CAPEX_DTBD", name: "CP Đầu Tư Ban Đầu", group: "OPEX", subGroup: "DTBD" },
  ],
  categories: [],
};

test("hạng mục nhóm Chi phí đầu tư ban đầu hạch toán 6428 lên dòng CAPEX", () => {
  const refOf = createPnlItemRefLookup(capexCatalog.pnlItems, capexCatalog.pnlGroups);
  const opex = { accountType: "OPEX", reportGroup: "OPEX" };
  assert.equal(pnlLineKeyOf(opex, refOf("CAPEX_DTBD")), "capex");
  assert.equal(pnlLineKeyOf(opex, refOf("CPCD_DIEN")), "otherOpex");
  const tree = createPnlDetailTree(capexCatalog, 1);
  tree.add({ account: opex, pnlItemCode: "CAPEX_DTBD", categoryCode: null, debit: 88248717, credit: 0 }, 0);
  assert.deepEqual(tree.groupsOf("capex").map((group) => [group.name, group.total]), [["Chi Phí Đầu Tư Ban Đầu", 88248717]]);
  assert.ok(!tree.groupsOf("otherOpex").some((group) => group.code === "DTBD"));
});

test("chưa khai hạng mục khấu hao thì dựng sẵn CPCĐ - CP Khấu Hao trong Chi phí cố định", () => {
  const items = withDepreciationPnlItem(capexCatalog.pnlItems, capexCatalog.pnlGroups);
  const tree = createPnlDetailTree({ ...capexCatalog, pnlItems: items }, 1);
  tree.add({ account: DEPRECIATION_PNL_ACCOUNT, pnlItemCode: null, categoryCode: null, debit: 1500000, credit: 0 }, 0);
  const fixed = tree.groupsOf("otherOpex").find((group) => group.code === "CPCD");
  assert.equal(fixed.items.find((item) => item.name === "CPCĐ - CP Khấu Hao")?.total, 1500000);
  // Danh mục đã có hạng mục khấu hao thì không dựng thêm.
  assert.equal(withDepreciationPnlItem(items, capexCatalog.pnlGroups).length, items.length);
});

test("CAPEX TRỪ vào lợi nhuận hoạt động và lợi nhuận ròng (chốt 24/09/2026)", async () => {
  const { finalizePnl } = await import("../lib/reports.ts");
  const { finalizeBucket } = await import("../components/reports/planning/planning-types.ts");
  const base = { revenue: 1_000, cogs: 300, payroll: 200, otherOpex: 100, otherIncome: 0, otherExpense: 0, capex: 88 };
  for (const pnl of [finalizePnl(base), finalizeBucket(base)]) {
    assert.equal(pnl.grossProfit, 700);
    assert.equal(pnl.ebitda, 700 - 200 - 88 - 100);
    assert.equal(pnl.netProfit, 312);
  }
});
