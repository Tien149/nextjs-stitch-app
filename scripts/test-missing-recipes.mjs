import assert from "node:assert/strict";
import test from "node:test";
import { buildMissingRecipeReport } from "../lib/missing-recipes.ts";

const item = (code, itemType, name = code) => ({ id: `i-${code}`, code, name, unit: "gr", itemType });
const nvl = item("NVL_THIT", "RAW_MATERIAL");
const btpCo = item("BTP_SOT", "SEMI_FINISHED");
const btpThieu = item("BTP_NEM", "SEMI_FINISHED");
const btpMua = item("BTP_BACON", "SEMI_FINISHED");
const recipe = (productCode, branchCode, lines) => ({
  id: `r-${productCode}-${branchCode || "all"}`, productCode, productName: productCode, branchCode, unit: "PHAN",
  outputConversionRate: 1, version: 1, effectiveFrom: "2026-08-01", status: "ACTIVE",
  lines: lines.map((line) => ({ itemId: line.id, quantity: 1, conversionRate: 1, wasteRate: 0, item: line })),
});
const recipes = [
  recipe("BTP_SOT", null, [nvl]),
  recipe("SP_COM", null, [btpCo, btpThieu, nvl]),
  recipe("SP_BACON", "ASA", [btpMua]),
  recipe("SP_RIENG_NME", "NME", [nvl]),
];
const items = [nvl, btpCo, btpThieu, btpMua, item("SP_COM", "FINISHED"), item("SP_BACON", "FINISHED"), item("SP_RIENG_NME", "FINISHED"), item("SP_THIEU", "FINISHED", "Món thiếu"), item("BIA", "RAW_MATERIAL"), item("PHI_DV", "FINISHED")];
const row = (branchCode, productCode, productQuantity, revenueSource = "REV_FOOD") => ({ branchCode, productCode, productQuantity, netAmount: productQuantity * 1000, revenueSource });

const report = buildMissingRecipeReport({
  month: "2026-09",
  date: new Date("2026-09-30T23:59:59Z"),
  branches: ["ASA", "NME"],
  recipes,
  items,
  soldRows: [
    row("ASA", "SP_COM", 5), row("ASA", "SP_THIEU", 3), row("ASA", "SP_THIEU", 2), row("ASA", "BIA", 9),
    row("ASA", "PHI_DV", 1, "REV_PHUTHU"), row("ASA", "SP_RIENG_NME", 4), row("NME", "SP_RIENG_NME", 4), row("ASA", "MA_LA", 1),
  ],
  nonInventoryGroups: new Set(["REV_PHUTHU"]),
  purchases: [{ branchCode: "ASA", itemCode: "BTP_BACON", quantity: 2000 }],
});

test("món bán thiếu định lượng: gộp theo cửa hàng + mã, bỏ nguyên liệu và nhóm không theo dõi tồn", () => {
  const sold = report.sold.map((r) => `${r.branchCode}|${r.productCode}|${r.quantity}|${r.itemType}`);
  assert.deepEqual(sold.sort(), ["ASA|MA_LA|1|null", "ASA|SP_RIENG_NME|4|FINISHED", "ASA|SP_THIEU|5|FINISHED"]);
});

test("bản riêng của cửa hàng khác không tính là có định lượng", () => {
  assert.ok(report.sold.some((r) => r.branchCode === "ASA" && r.productCode === "SP_RIENG_NME"));
  assert.ok(!report.sold.some((r) => r.branchCode === "NME"));
});

test("thành phần BTP thiếu định lượng theo từng cửa hàng, kèm món dùng và nhập mua", () => {
  const components = report.components.map((r) => `${r.branchCode}|${r.itemCode}|${r.usedIn.join("+")}|${r.purchasedQuantity}`);
  assert.deepEqual(components.sort(), ["ASA|BTP_BACON|SP_BACON|2000", "ASA|BTP_NEM|SP_COM|0", "NME|BTP_NEM|SP_COM|0"]);
});
