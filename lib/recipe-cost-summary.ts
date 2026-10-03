/**
 * "Sheet tổng hợp giá vốn & giá thành" THEO THÁNG (khách hỏi 03/10/2026): mỗi phiên bản định
 * lượng có áp dụng ngày nào trong tháng là một dòng, kèm khoảng ngày áp dụng — đổi giá bán / định
 * lượng giữa tháng (2 lần cũng được) thì tháng đó có nhiều dòng nối tiếp nhau cho cùng một món.
 *
 * Giá cost tính theo ĐÚNG phiên bản đó (thành phần là BTP lấy phiên bản BTP áp dụng cùng ngày), giá
 * nguyên liệu là giá vốn bình quân hiện tại — giống bảng "đang áp dụng".
 */
import { computeRecipeUnitCosts, type ExplosionRecipe } from "@/lib/production-explosion";
import { recipeValidity, validityInMonth } from "@/lib/recipe-validity";

export type MonthlyCostSummaryRow = {
  productCode: string;
  branchCode: string;
  productName: string;
  group: string;
  stockUnit: string;
  batchUnit: string;
  outputConversionRate: number;
  sellingPrice: number;
  unitCost: number;
  costRatio: number | null;
  version: number;
  appliedFrom: string;
  appliedTo: string;
};

export function buildMonthlyCostSummary(input: {
  recipes: ExplosionRecipe[];
  items: Array<{ code: string; name: string; unit: string; itemType: string }>;
  averageCostByItemId: Map<string, number>;
  month: string;
}): MonthlyCostSummaryRow[] {
  const validity = recipeValidity(input.recipes);
  const itemByCode = new Map(input.items.map((item) => [item.code.toUpperCase(), item]));
  const costCache = new Map<string, Map<string, number>>();
  const costsAt = (day: string, scope: string) => {
    const key = `${day}|${scope}`;
    if (!costCache.has(key)) {
      // Giữa trưa UTC của ngày đó: chắc chắn sau mọi effectiveFrom cùng ngày (lưu 00:00 UTC hay
      // 17:00 UTC hôm trước), trước mọi phiên bản của ngày hôm sau.
      costCache.set(key, computeRecipeUnitCosts(input.recipes, input.averageCostByItemId, new Date(`${day}T12:00:00Z`), scope || undefined));
    }
    return costCache.get(key)!;
  };

  const rows: MonthlyCostSummaryRow[] = [];
  for (const recipe of input.recipes) {
    const window = validityInMonth(validity.get(recipe.id), input.month);
    if (!window) continue;
    const productCode = recipe.productCode.toUpperCase();
    const branchCode = (recipe.branchCode || "").toUpperCase();
    const item = itemByCode.get(productCode);
    const unitCost = costsAt(window.from, branchCode).get(productCode);
    const cost = Number.isFinite(unitCost) ? (unitCost as number) : 0;
    const sellingPrice = recipe.sellingPrice || 0;
    rows.push({
      productCode,
      branchCode,
      productName: recipe.productName || item?.name || productCode,
      group: item?.itemType || "FINISHED",
      stockUnit: item?.unit || "",
      batchUnit: recipe.unit || item?.unit || "",
      outputConversionRate: recipe.outputConversionRate || 1,
      sellingPrice,
      unitCost: cost,
      costRatio: sellingPrice > 0 ? cost / sellingPrice : null,
      version: recipe.version,
      appliedFrom: window.from,
      appliedTo: window.to || window.from,
    });
  }
  return rows.sort((a, b) => a.productCode.localeCompare(b.productCode) || a.branchCode.localeCompare(b.branchCode) || a.appliedFrom.localeCompare(b.appliedFrom));
}
