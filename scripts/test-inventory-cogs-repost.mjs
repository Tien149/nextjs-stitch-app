/**
 * Tự ghi sổ lại giá vốn theo kho sau khi rã / rã lại / hoàn tác rã (repostInventoryCogs,
 * lib/accounting.ts — khách chốt 28/09/2026):
 *  - kỳ còn phiếu chi mua ghi Nợ 632 kiểu cũ -> NEEDS_SYNC, không ghi thêm (tránh giá vốn đôi);
 *  - Ghi sổ kỳ một lần xong -> phiếu kho thêm / bỏ tự lên / xuống P&L, không cần bấm lại;
 *  - kỳ khoá -> LOCKED; kỳ trước mốc 2026-08 -> bỏ qua.
 *
 * DB thật, cửa hàng CGRP riêng, tự dọn. Chạy: npm run test:inventory-cogs-repost
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { postInventoryTransaction } from "../lib/inventory-stock.ts";
import { postJournalEntry, repostInventoryCogs, syncAccountingPeriod } from "../lib/accounting.ts";
import { cogsRepostMessage } from "../lib/inventory-cogs.ts";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/custom-client");
const prisma = new PrismaClient();

const BRANCH = "CGRP";
const KITCHEN = "KBEP_CGRP";
const MEAT = "NVL_CGRP_THIT";
const PNL_ITEM = "PNL_CGRP_NVL";
const PNL_GROUP = "PNL_ZZ_CGRP_GIAVON";
const vn = (value) => new Date(`${value}+07:00`);
const ids = {};

async function cleanup() {
  const entries = await prisma.journalEntry.findMany({ where: { branchCode: BRANCH }, select: { id: true } });
  const entryIds = entries.map((entry) => entry.id);
  if (entryIds.length > 0) {
    await prisma.$executeRaw`DELETE FROM "JournalLine" WHERE "entryId" = ANY(${entryIds})`;
    await prisma.$executeRaw`DELETE FROM "JournalEntry" WHERE "id" = ANY(${entryIds})`;
  }
  const itemIds = (await prisma.inventoryItem.findMany({ where: { code: MEAT }, select: { id: true } })).map((row) => row.id);
  await prisma.accountingPeriod.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.financialVoucher.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryTransaction.deleteMany({ where: { branchCode: BRANCH } });
  await prisma.inventoryBalance.deleteMany({ where: { itemId: { in: itemIds } } });
  await prisma.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.masterDataItem.deleteMany({ where: { type: "WAREHOUSE", code: KITCHEN } });
  await prisma.masterDataItem.deleteMany({ where: { type: "BRANCH", code: BRANCH } });
  await prisma.masterDataItem.deleteMany({ where: { type: "PNL_ITEM", code: PNL_ITEM } });
  await prisma.masterDataItem.deleteMany({ where: { type: "PNL_GROUP", code: PNL_GROUP } });
}

const post = (input) => prisma.$transaction((tx) => postInventoryTransaction(tx, { branchCode: BRANCH, warehouseCode: KITCHEN, ...input }));
const cogsEntries = () => prisma.journalEntry.findMany({
  where: { branchCode: BRANCH, sourceType: "INVENTORY_ISSUE", deletedAt: null },
  select: { sourceCode: true },
});

test.before(async () => {
  await cleanup();
  await prisma.masterDataItem.create({ data: { type: "BRANCH", code: BRANCH, name: "Cửa hàng test tự ghi giá vốn", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "WAREHOUSE", code: KITCHEN, name: "Kho bếp CGRP", branch: BRANCH, group: "BEP", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PNL_GROUP", code: PNL_GROUP, name: "Giá vốn test", group: "COGS", status: "ACTIVE" } });
  await prisma.masterDataItem.create({ data: { type: "PNL_ITEM", code: PNL_ITEM, name: "Giá vốn NVL test", group: "COGS", subGroup: PNL_GROUP, status: "ACTIVE" } });
  ids.meat = (await prisma.inventoryItem.create({ data: { code: MEAT, name: "Thịt test", itemType: "RAW_MATERIAL", unit: "KG" } })).id;
  await post({ code: "NM_CGRP_1", transactionType: "NHAP_MUA", transactionDate: vn("2026-09-02T08:00:00"), lines: [{ itemId: ids.meat, inputQuantity: 20, inputUnitCode: "KG", inputUnitCost: 100 }] });
  await post({ code: "XB_CGRP_1", transactionType: "XUAT_BAN", transactionDate: vn("2026-09-10T07:00:00"), lines: [{ itemId: ids.meat, inputQuantity: 3, inputUnitCode: "KG" }] });

  // Phiếu chi mua đã ghi sổ theo luật CŨ (Nợ 632) — kỳ 09 chưa bấm Ghi sổ lại từ khi đổi luật.
  const voucher = await prisma.financialVoucher.create({
    data: {
      code: "PC_CGRP_1", voucherType: "PAYMENT", voucherDate: vn("2026-09-02T09:00:00"), partnerName: "NCC test", branchCode: BRANCH,
      moneySourceCode: "CASH_CGRP", amount: 2000, pnlItemCode: PNL_ITEM, description: "Mua thịt test", status: "APPROVED",
    },
  });
  await postJournalEntry({
    entryDate: voucher.voucherDate, branchCode: BRANCH, sourceType: "VOUCHER", sourceId: voucher.id, sourceCode: voucher.code,
    description: "Phiếu chi ghi theo luật cũ", createdBy: "test",
    lines: [{ accountCode: "632", debit: 2000, pnlItemCode: PNL_ITEM }, { accountCode: "1111", credit: 2000 }],
  });
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("kỳ còn phiếu chi mua ghi 632 kiểu cũ: không tự ghi giá vốn, báo cần Ghi sổ kỳ", async () => {
  const results = await repostInventoryCogs([{ date: vn("2026-09-10T07:00:00"), branchCode: BRANCH }], "test");
  assert.deepEqual(results.map((row) => [row.period, row.status]), [["2026-09", "NEEDS_SYNC"]]);
  assert.equal((await cogsEntries()).length, 0, "không được cộng giá vốn theo kho lên trên tiền mua 632");
  assert.match(cogsRepostMessage(results), /bấm Ghi sổ kỳ/);
});

test("Ghi sổ kỳ một lần xong, rã thêm phiếu xuất bán: tự lên sổ không cần bấm lại", async () => {
  await syncAccountingPeriod("2026-09", BRANCH, "test");
  assert.deepEqual((await cogsEntries()).map((entry) => entry.sourceCode), ["XB_CGRP_1"]);

  await post({ code: "XB_CGRP_2", transactionType: "XUAT_BAN", transactionDate: vn("2026-09-20T07:00:00"), lines: [{ itemId: ids.meat, inputQuantity: 2, inputUnitCode: "KG" }] });
  const results = await repostInventoryCogs([{ date: vn("2026-09-20T07:00:00"), branchCode: BRANCH }], "test");
  assert.deepEqual(results.map((row) => [row.period, row.status]), [["2026-09", "POSTED"]]);
  assert.equal(results[0].changed, 1, "chỉ phiếu mới là thay đổi, phiếu cũ SKIPPED_EXISTS");
  assert.deepEqual((await cogsEntries()).map((entry) => entry.sourceCode).sort(), ["XB_CGRP_1", "XB_CGRP_2"]);
  assert.match(cogsRepostMessage(results), /Đã tự ghi sổ lại giá vốn kỳ T9\/2026/);
});

test("hoàn tác rã (phiếu xuất bị xoá): bút toán giá vốn của nó tự bị dọn", async () => {
  const doc = await prisma.inventoryTransaction.findFirst({ where: { code: "XB_CGRP_2" } });
  await prisma.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
  const results = await repostInventoryCogs([{ date: doc.transactionDate, branchCode: BRANCH }], "test");
  assert.equal(results[0].status, "POSTED");
  assert.deepEqual((await cogsEntries()).map((entry) => entry.sourceCode), ["XB_CGRP_1"]);
});

test("kỳ khoá sổ -> LOCKED; ngày trước 2026-08 và cửa hàng ALL -> bỏ qua", async () => {
  await prisma.accountingPeriod.create({ data: { period: "2026-10", branchCode: BRANCH, status: "CLOSED" } });
  const results = await repostInventoryCogs([
    { date: vn("2026-10-05T07:00:00"), branchCode: BRANCH },
    { date: vn("2026-07-20T07:00:00"), branchCode: BRANCH },
    { date: vn("2026-09-05T07:00:00"), branchCode: "ALL" },
  ], "test");
  assert.deepEqual(results.map((row) => [row.period, row.status]), [["2026-10", "LOCKED"]]);
});
