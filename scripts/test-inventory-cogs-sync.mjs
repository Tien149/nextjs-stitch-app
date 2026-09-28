/**
 * Giá vốn theo kho chạy thật qua "Ghi sổ kỳ" (syncAccountingPeriod) và P&L (getPnl):
 * COGS Bếp / COGS Bar từ phiếu xuất, bao bì vào CPBD_VTTH, phiếu chi mua nhóm Giá vốn kỳ 09 ghi
 * Nợ 152 nên không lên P&L, phiếu kho bị xoá thì bút toán giá vốn bị dọn ở lần ghi sổ sau.
 *
 * DB thật, cửa hàng CGST riêng, tự dọn. Chạy: npm run test:inventory-cogs-sync
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { syncAccountingPeriod } from "../lib/accounting.ts";
import { getPnl } from "../lib/reports.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "CGST";
const KITCHEN = "KBEP_CGST";
const BAR = "KBAR_CGST";
const MEAT = "NVL_CGST_THIT";
const BOX = "BB_CGST_HOP";
const PNL_ITEM = "PNL_CGST_NVL";
// Mã xếp SAU nhóm Giá vốn thật: ensureInventoryCogsPnlItems gắn hạng mục vào nhóm COGS đầu tiên theo mã.
const PNL_GROUP = "PNL_ZZ_CGST_GIAVON";
const vn = (value) => new Date(`${value}+07:00`);
const ids = {};

async function cleanup() {
  const entries = await prisma.journalEntry.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  const entryIds = entries.map((entry) => entry.id);
  if (entryIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" = ANY(${entryIds})`;
    await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "id" = ANY(${entryIds})`;
  }
  const itemIds = (await prisma.inventoryItem.findMany({ where: { code: { in: [MEAT, BOX] } }, select: { id: true } })).map((row) => row.id);
  await prisma.financialVoucher.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: { in: [KITCHEN, BAR] } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH } });
  await prisma.masterDataItem.deleteMany({ where: { type: "PNL_ITEM", code: PNL_ITEM } });
  await prisma.masterDataItem.deleteMany({ where: { type: "PNL_GROUP", code: PNL_GROUP } });
}

const post = (input) => prisma.$transaction((tx) => postInventoryTransaction(tx, { branchCode: BRANCH, ...input }));

test.before(async () => {
  await cleanup();
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test giá vốn", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: KITCHEN, name: "Kho bếp CGST", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: BAR, name: "Kho bar CGST", branch: BRANCH, group: "BAR", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PNL_GROUP", code: PNL_GROUP, name: "Giá vốn test", group: "COGS", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PNL_ITEM", code: PNL_ITEM, name: "Giá vốn NVL test", group: "COGS", subGroup: PNL_GROUP, status: "ACTIVE" } });
  ids.meat = (await prisma.inventoryItem.create({ data: { code: MEAT, name: "Thịt test", itemType: "RAW_MATERIAL", unit: "KG" } })).id;
  ids.box = (await prisma.inventoryItem.create({ data: { code: BOX, name: "Hộp test", itemType: "PACKAGING", unit: "CAI" } })).id;

  await post({ code: "NM_CGST_1", transactionType: "NHAP_MUA", transactionDate: vn("2026-09-02T08:00:00"), warehouseCode: KITCHEN, lines: [{ itemId: ids.meat, inputQuantity: 10, inputUnitCode: "KG", inputUnitCost: 100 }] });
  await post({ code: "NM_CGST_2", transactionType: "NHAP_MUA", transactionDate: vn("2026-09-02T08:00:00"), warehouseCode: BAR, lines: [{ itemId: ids.box, inputQuantity: 50, inputUnitCode: "CAI", inputUnitCost: 2 }, { itemId: ids.meat, inputQuantity: 5, inputUnitCode: "KG", inputUnitCost: 100 }] });
  await post({ code: "XB_CGST_1", transactionType: "XUAT_BAN", transactionDate: vn("2026-09-10T07:00:00"), warehouseCode: KITCHEN, lines: [{ itemId: ids.meat, inputQuantity: 3, inputUnitCode: "KG" }] });
  await post({ code: "XCB_CGST_1", transactionType: "XUAT_CHE_BIEN", transactionDate: vn("2026-09-10T07:00:00"), warehouseCode: KITCHEN, lines: [{ itemId: ids.meat, inputQuantity: 2, inputUnitCode: "KG" }] });
  ids.waste = (await post({ code: "HH_CGST_1", transactionType: "XUAT_HUY", transactionDate: vn("2026-09-11T07:00:00"), warehouseCode: BAR, lines: [{ itemId: ids.box, inputQuantity: 5, inputUnitCode: "CAI" }, { itemId: ids.meat, inputQuantity: 1, inputUnitCode: "KG" }] })).id;
  await post({ code: "NKK_CGST_1", transactionType: "NHAP_KIEM_KE", transactionDate: vn("2026-09-30T11:00:00"), warehouseCode: KITCHEN, lines: [{ itemId: ids.meat, inputQuantity: 1, inputUnitCode: "KG", inputUnitCost: 100 }] });

  const voucher = {
    voucherType: "PAYMENT", partnerName: "NCC test", branchCode: BRANCH, moneySourceCode: "CASH_CGST", amount: 1500,
    pnlItemCode: PNL_ITEM, description: "Mua thịt test", status: "APPROVED",
  };
  ids.voucher = (await prisma.financialVoucher.create({ data: { ...voucher, code: "PC_CGST_1", voucherDate: vn("2026-09-02T09:00:00") } })).id;
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function entriesOf(sourceType) {
  return prisma.journalEntry.findMany({
    where: { branchCode: BRANCH, sourceType, deletedAt: null },
    include: { lines: { include: { account: true } } },
  });
}
const linesOf = (entries) => entries.flatMap((entry) => entry.lines);
const net = (lines, accountCode, pnlItemCode) => lines
  .filter((line) => line.account.code === accountCode && (pnlItemCode === undefined || line.pnlItemCode === pnlItemCode))
  .reduce((sum, line) => sum + line.debit - line.credit, 0);

test("ghi sổ kỳ 09: phiếu xuất sinh COGS Bếp/Bar + vật tư tiêu hao, xuất chế biến không sinh", async () => {
  await syncAccountingPeriod("2026-09", BRANCH, "test");
  const entries = await entriesOf("INVENTORY_ISSUE");
  assert.deepEqual(entries.map((entry) => entry.sourceCode).sort(), ["HH_CGST_1", "NKK_CGST_1", "XB_CGST_1"]);
  const lines = linesOf(entries);
  assert.equal(net(lines, "632", "COGS_BEP"), 300 - 100, "xuất bán 3 kg − kiểm thừa 1 kg ở kho bếp");
  assert.equal(net(lines, "632", "COGS_BAR"), 100, "hủy 1 kg thịt ở kho bar");
  assert.equal(net(lines, "6428", "CPBD_VTTH"), 10, "hủy 5 hộp bao bì");
  assert.equal(net(lines, "152"), -(300 - 100 + 100 + 10));
});

test("phiếu chi mua nhóm Giá vốn kỳ 09 ghi Nợ 152, không vào 632", async () => {
  const lines = linesOf(await entriesOf("VOUCHER"));
  assert.equal(net(lines, "152"), 1500);
  assert.equal(net(lines, "632"), 0);
});

test("P&L kỳ 09: dòng Giá vốn = COGS Bếp + COGS Bar, không có tiền mua hàng", async () => {
  const pnl = await getPnl("2026-09", BRANCH);
  const cogs = pnl.statement.find((line) => line.key === "cogs");
  assert.equal(cogs.amount, 300);
  const items = cogs.groups.flatMap((group) => group.items);
  assert.equal(items.find((item) => item.code === "COGS_BEP").amount, 200);
  assert.equal(items.find((item) => item.code === "COGS_BAR").amount, 100);
  assert.equal(items.find((item) => item.code === PNL_ITEM)?.amount || 0, 0);
});

test("xoá phiếu hủy rồi ghi sổ lại: bút toán giá vốn của nó bị dọn", async () => {
  await prisma.inventoryTransaction.update({ where: { id: ids.waste }, data: { deletedAt: new Date() } });
  await syncAccountingPeriod("2026-09", BRANCH, "test");
  const entries = await entriesOf("INVENTORY_ISSUE");
  assert.equal(entries.some((entry) => entry.sourceCode === "HH_CGST_1"), false);
  assert.equal(net(linesOf(entries), "632", "COGS_BAR"), 0);
  // Phiếu quay lại (khôi phục) thì ghi sổ lại được, không vướng khoá unique của bút toán cũ.
  await prisma.inventoryTransaction.update({ where: { id: ids.waste }, data: { deletedAt: null } });
  await syncAccountingPeriod("2026-09", BRANCH, "test");
  assert.equal((await entriesOf("INVENTORY_ISSUE")).some((entry) => entry.sourceCode === "HH_CGST_1"), true);
});
