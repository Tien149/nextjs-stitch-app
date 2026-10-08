/**
 * Giá vốn theo kho — COGS Bếp / COGS Bar, bao bì vào vật tư tiêu hao, mua hàng nhóm Giá vốn ghi
 * Nợ 152 từ kỳ 2026-08 (chị Bình chốt 27/09; mốc dời từ 09 về 08 ngày 28/09/2026). lib/inventory-cogs.ts.
 * Chạy: npm run test:inventory-cogs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cogsPurchaseAccount, inventoryCogsActive, inventoryCogsParentGroup, inventoryCogsRegroupTarget, planInventoryCogsJournal } from "../lib/inventory-cogs.ts";
import { paymentCounterAccount, voucherJournalLines } from "../lib/voucher-accounting.ts";

const sum = (lines, side) => lines.reduce((total, line) => total + (line[side] || 0), 0);

test("xuất bán kho bếp: Nợ 632 COGS Bếp / Có 152, gắn bộ phận KIT", () => {
  const lines = planInventoryCogsJournal({
    transactionType: "XUAT_BAN",
    warehouseGroup: "BEP",
    lines: [{ totalCost: 1000, itemType: "FINISHED" }, { totalCost: 500, itemType: "RAW_MATERIAL" }],
  });
  assert.deepEqual(lines, [
    { accountCode: "632", debit: 1500, pnlItemCode: "COGS_BEP", departmentCode: "KIT" },
    { accountCode: "152", credit: 1500 },
  ]);
});

test("kho bar -> COGS Bar; nhóm kho viết có dấu vẫn nhận ra", () => {
  const [line] = planInventoryCogsJournal({ transactionType: "XUAT_HUY", warehouseGroup: "Kho Bar", lines: [{ totalCost: 200, itemType: "RAW_MATERIAL" }] });
  assert.equal(line.pnlItemCode, "COGS_BAR");
  const [kitchen] = planInventoryCogsJournal({ transactionType: "XUAT_HUY", warehouseGroup: "KHO BẾP", lines: [{ totalCost: 200, itemType: "RAW_MATERIAL" }] });
  assert.equal(kitchen.pnlItemCode, "COGS_BEP");
});

test("kho không thuộc bếp/bar -> COGS kho chung, không gắn bộ phận", () => {
  const [line] = planInventoryCogsJournal({ transactionType: "XUAT_KIEM_KE", warehouseGroup: "VAN_PHONG", lines: [{ totalCost: 300, itemType: "RAW_MATERIAL" }] });
  assert.equal(line.pnlItemCode, "COGS_KHAC");
  assert.equal(line.departmentCode, null);
});

test("bao bì thiếu kiểm kê -> 6428 CPBD_VTTH, nguyên liệu cùng phiếu vẫn vào COGS", () => {
  const lines = planInventoryCogsJournal({
    transactionType: "XUAT_KIEM_KE",
    warehouseGroup: "BAR",
    lines: [{ totalCost: 100, itemType: "PACKAGING" }, { totalCost: 400, itemType: "RAW_MATERIAL" }],
  });
  assert.deepEqual(lines.find((line) => line.accountCode === "6428"), { accountCode: "6428", debit: 100, pnlItemCode: "CPBD_VTTH", departmentCode: "BAR" });
  assert.equal(lines.find((line) => line.accountCode === "632").debit, 400);
  assert.equal(sum(lines, "debit"), sum(lines, "credit"));
});

test("đồng phục xuất kho -> chi phí cố định CPCD_DONGPHUC (6428); hàng hóa xuất bán -> giá vốn 632 theo kho", () => {
  const lines = planInventoryCogsJournal({
    transactionType: "XUAT_KHAC",
    warehouseGroup: "BEP",
    lines: [{ totalCost: 300, itemType: "UNIFORM" }, { totalCost: 200, itemType: "GOODS" }],
  });
  assert.deepEqual(lines.find((line) => line.accountCode === "6428"), { accountCode: "6428", debit: 300, pnlItemCode: "CPCD_DONGPHUC", departmentCode: "KIT" });
  assert.deepEqual(lines.find((line) => line.accountCode === "632"), { accountCode: "632", debit: 200, pnlItemCode: "COGS_BEP", departmentCode: "KIT" });
  assert.equal(sum(lines, "debit"), sum(lines, "credit"));
});

test("kiểm kê THỪA ghi giảm giá vốn: Nợ 152 / Có 632", () => {
  const lines = planInventoryCogsJournal({ transactionType: "NHAP_KIEM_KE", warehouseGroup: "BEP", lines: [{ totalCost: 250, itemType: "RAW_MATERIAL" }] });
  assert.deepEqual(lines, [
    { accountCode: "632", credit: 250, pnlItemCode: "COGS_BEP", departmentCode: "KIT" },
    { accountCode: "152", debit: 250 },
  ]);
});

test("xuất / nhập chế biến, nhập mua, điều chuyển không sinh giá vốn; phiếu 0 đ bỏ qua", () => {
  for (const transactionType of ["XUAT_CHE_BIEN", "NHAP_CHE_BIEN", "NHAP_MUA", "DIEU_CHUYEN"]) {
    assert.deepEqual(planInventoryCogsJournal({ transactionType, warehouseGroup: "BEP", lines: [{ totalCost: 100, itemType: "RAW_MATERIAL" }] }), []);
  }
  assert.deepEqual(planInventoryCogsJournal({ transactionType: "XUAT_BAN", warehouseGroup: "BEP", lines: [{ totalCost: 0, itemType: "RAW_MATERIAL" }] }), []);
});

test("mốc áp dụng: từ 00:00 01/08/2026 giờ Việt Nam (ngày hệ thống lên chạy)", () => {
  assert.equal(inventoryCogsActive(new Date("2026-07-31T16:59:59Z")), false);
  assert.equal(inventoryCogsActive(new Date("2026-07-31T17:00:00Z")), true);
  assert.equal(cogsPurchaseAccount(new Date("2026-07-15T00:00:00Z")), "632");
  assert.equal(cogsPurchaseAccount(new Date("2026-08-15T00:00:00Z")), "152");
  assert.equal(cogsPurchaseAccount(new Date("2026-09-15T00:00:00Z")), "152");
});

const purchase = {
  voucherType: "PAYMENT", amount: 1000, moneySourceCode: "TM", partnerCode: "NCC1", categoryCode: "CHI_MUA_NVL",
  pnlItemCode: "PNL_GV_NVL", depositAction: null, debtAction: null,
};

test("phiếu chi mua nguyên liệu từ kỳ 08: Nợ 152, bỏ hạng mục P&L", () => {
  const { lines } = voucherJournalLines({ ...purchase, voucherDate: new Date("2026-08-05T03:00:00Z") }, "COGS", "COGS");
  assert.equal(lines[0].accountCode, "152");
  assert.equal(lines[0].pnlItemCode, null);
});

test("phiếu chi mua trước kỳ 08 giữ nguyên Nợ 632 như cũ", () => {
  const { lines } = voucherJournalLines({ ...purchase, voucherDate: new Date("2026-07-20T03:00:00Z") }, "COGS", "COGS");
  assert.equal(lines[0].accountCode, "632");
  assert.equal(lines[0].pnlItemCode, "PNL_GV_NVL");
});

test("trả nợ NCC / chi phí vận hành không bị kéo sang 152", () => {
  const september = new Date("2026-09-05T03:00:00Z");
  assert.equal(paymentCounterAccount({ ...purchase, voucherDate: september, debtAction: "SETTLE" }, "COGS").account, "331");
  assert.equal(paymentCounterAccount({ ...purchase, voucherDate: september }, "OPEX").account, "6428");
});

// Danh mục VPS 29/09/2026: nhóm COGS_BAR đứng đầu theo mã nên cả COGS Bếp bị gắn vào nhóm Bar.
const vpsGroups = [
  { code: "COGS_BAR", name: "COGS Bar" },
  { code: "COGS_BEP", name: "COGS Bếp" },
  { code: "COGS_KHAC", name: "Giá vốn khác" },
];

test("hạng mục giá vốn theo kho vào nhóm cùng bộ phận, không vào nhóm đầu tiên theo mã", () => {
  assert.equal(inventoryCogsParentGroup("COGS_BEP", vpsGroups), "COGS_BEP");
  assert.equal(inventoryCogsParentGroup("COGS_BAR", vpsGroups), "COGS_BAR");
  assert.equal(inventoryCogsParentGroup("COGS_KHAC", vpsGroups), "COGS_KHAC");
  // Danh mục chỉ có một nhóm Giá vốn chung (local): cả ba vào nhóm đó như cũ.
  assert.equal(inventoryCogsParentGroup("COGS_BEP", [{ code: "PNL_GIAVON", name: "Giá vốn" }]), "PNL_GIAVON");
});

test("chuyển COGS Bếp ra khỏi nhóm Bar; hạng mục ở nhóm chung hoặc đã đúng thì để yên", () => {
  assert.equal(inventoryCogsRegroupTarget("COGS_BEP", "COGS_BAR", vpsGroups), "COGS_BEP");
  assert.equal(inventoryCogsRegroupTarget("COGS_BAR", "COGS_BAR", vpsGroups), null);
  assert.equal(inventoryCogsRegroupTarget("COGS_KHAC", "COGS_BAR", vpsGroups), "COGS_KHAC");
  assert.equal(inventoryCogsRegroupTarget("COGS_BEP", "COGS_KHAC", vpsGroups), null, "người dùng tự để ở nhóm chung");
  // Không có nhóm Bếp để chuyển sang: giữ nguyên, không đẩy vào nhóm khác.
  assert.equal(inventoryCogsRegroupTarget("COGS_BEP", "COGS_BAR", [{ code: "COGS_BAR", name: "COGS Bar" }]), null);
});
