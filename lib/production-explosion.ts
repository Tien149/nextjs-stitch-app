/**
 * Rã nguyên liệu theo định lượng — trái tim của tab Chế biến.
 *
 * Bối cảnh: import doanh thu cho biết mỗi ngày bán bao nhiêu món (mã hàng + số lượng).
 * Kế toán KHÔNG muốn import thêm file nào nữa: ấn một nút, hệ thống tự rã số bán thành
 * nhu cầu chế biến theo đúng thứ tự bán thành phẩm → thành phẩm → combo, rồi sinh phiếu
 * nhập/xuất kho tương ứng:
 *   - mỗi sản phẩm có định lượng: XUAT_CHE_BIEN nguyên liệu + NHAP_CHE_BIEN sản phẩm;
 *   - sản phẩm không có định lượng (bia, nước đóng chai...): xuất bán thẳng từ tồn kho.
 *
 * File này chỉ tính toán thuần (không chạm DB) để test được bằng node --test và tái dùng
 * cho cả nút rã ở màn hình lẫn import.
 */

export type ExplosionItem = {
  id: string;
  code: string;
  name: string;
  unit: string;
  itemType: string;
};

export type ExplosionRecipeLine = {
  itemId: string;
  quantity: number;
  /** Quy đổi quantity về ĐVT tồn kho của nguyên liệu (chai830gr -> 830). */
  conversionRate: number;
  wasteRate: number;
  item: ExplosionItem;
};

export type ExplosionRecipe = {
  id: string;
  productCode: string;
  productName: string;
  unit: string;
  /** 1 mẻ `unit` = bao nhiêu ĐVT tồn kho của sản phẩm. */
  outputConversionRate: number;
  version: number;
  effectiveFrom: Date | string;
  status: string;
  sellingPrice?: number;
  lines: ExplosionRecipeLine[];
};

export type ProductionStep = {
  productCode: string;
  /** Số lượng cần chế biến, tính theo ĐVT tồn kho của sản phẩm. */
  quantityBase: number;
  /** Số mẻ chuẩn bị tương ứng (quantityBase / outputConversionRate). */
  batchQuantity: number;
  recipe: ExplosionRecipe;
  /** Nguyên liệu tiêu hao (đã gồm hao hụt), quy về ĐVT tồn kho của từng nguyên liệu. */
  components: Array<{ item: ExplosionItem; quantityBase: number }>;
};

export type ExplosionPlan = {
  /** Thứ tự chế biến an toàn tồn kho: bán thành phẩm trước, thành phẩm sau, combo cuối. */
  productions: ProductionStep[];
  /** Sản phẩm có định lượng: sau khi nhập chế biến thì xuất bán đúng số đã bán. */
  producedSales: Array<{ productCode: string; quantityBase: number }>;
  /** Sản phẩm không có định lượng: xuất bán thẳng từ tồn kho. */
  directSales: Array<{ productCode: string; quantityBase: number }>;
};

function up(value: string) {
  return value.trim().toUpperCase();
}

function explosionError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

/**
 * Chọn phiên bản định lượng theo ngày áp dụng: phiên bản có effectiveFrom muộn nhất nhưng
 * không vượt quá ngày bán (trùng ngày thì lấy version lớn hơn). Món bán trước khi mọi
 * phiên bản có hiệu lực thì đành dùng phiên bản sớm nhất — còn hơn là không rã được.
 */
export function pickRecipeForDate(recipes: ExplosionRecipe[], date: Date): ExplosionRecipe | null {
  if (recipes.length === 0) return null;
  const time = date.getTime();
  const sorted = [...recipes].sort((a, b) => {
    const diff = new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime();
    return diff !== 0 ? diff : a.version - b.version;
  });
  const effective = sorted.filter((recipe) => new Date(recipe.effectiveFrom).getTime() <= time);
  return effective.length > 0 ? effective[effective.length - 1] : sorted[0];
}

export type ExplosionInput = {
  /** Số lượng bán theo mã sản phẩm, tính bằng ĐVT tồn kho của sản phẩm. */
  demands: Array<{ productCode: string; quantity: number }>;
  /** Toàn bộ phiên bản định lượng, nhóm sẵn hay không đều được. */
  recipes: ExplosionRecipe[];
  /** Ngày dùng để chọn phiên bản định lượng. */
  date: Date;
};

/**
 * Rã nhu cầu bán hàng thành kế hoạch chế biến đa cấp.
 *
 * Thuật toán: DFS hậu thứ tự trên đồ thị "sản phẩm → thành phần có định lượng" cho ra
 * thứ tự thành phần đứng TRƯỚC sản phẩm dùng nó (BTP → TP → combo). Cộng dồn nhu cầu thì
 * đi ngược lại (combo trước) để mọi nhu cầu của cấp trên đã chốt trước khi tính cấp dưới.
 */
export function explodeSalesDemand(input: ExplosionInput): ExplosionPlan {
  const recipeByProduct = new Map<string, ExplosionRecipe[]>();
  for (const recipe of input.recipes) {
    const code = up(recipe.productCode);
    if (!recipeByProduct.has(code)) recipeByProduct.set(code, []);
    recipeByProduct.get(code)!.push(recipe);
  }
  const pickedRecipe = new Map<string, ExplosionRecipe | null>();
  const recipeFor = (code: string) => {
    if (!pickedRecipe.has(code)) {
      pickedRecipe.set(code, pickRecipeForDate(recipeByProduct.get(code) || [], input.date));
    }
    return pickedRecipe.get(code)!;
  };

  // Hậu thứ tự DFS: thành phần trước, sản phẩm sau. Chặn định lượng khai vòng (A cần B, B cần A).
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (code: string, chain: string[]) => {
    const marker = state.get(code);
    if (marker === 2) return;
    if (marker === 1) {
      explosionError(`Định lượng khai vòng: ${[...chain, code].join(" → ")}. Sửa lại định lượng trước khi rã.`);
    }
    state.set(code, 1);
    const recipe = recipeFor(code);
    for (const line of recipe?.lines || []) {
      const componentCode = up(line.item.code);
      if (recipeFor(componentCode)) visit(componentCode, [...chain, code]);
    }
    state.set(code, 2);
    order.push(code);
  };

  const directSales = new Map<string, number>();
  const producedSales = new Map<string, number>();
  const demand = new Map<string, number>();
  for (const entry of input.demands) {
    const code = up(entry.productCode);
    if (!(entry.quantity > 0)) continue;
    if (!recipeFor(code)) {
      directSales.set(code, (directSales.get(code) || 0) + entry.quantity);
      continue;
    }
    visit(code, []);
    demand.set(code, (demand.get(code) || 0) + entry.quantity);
    producedSales.set(code, (producedSales.get(code) || 0) + entry.quantity);
  }

  // Cộng dồn nhu cầu từ cấp trên xuống: duyệt ngược hậu thứ tự (combo → TP → BTP).
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const code = order[index];
    const quantityBase = demand.get(code) || 0;
    if (quantityBase <= 0) continue;
    const recipe = recipeFor(code)!;
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    const batchQuantity = quantityBase / outputRate;
    for (const line of recipe.lines) {
      const componentCode = up(line.item.code);
      if (!recipeFor(componentCode)) continue;
      const componentQuantity = line.quantity * (line.conversionRate || 1) * (1 + line.wasteRate / 100) * batchQuantity;
      demand.set(componentCode, (demand.get(componentCode) || 0) + componentQuantity);
    }
  }

  // Sinh bước chế biến theo đúng hậu thứ tự: BTP đứng trước TP, TP trước combo.
  const productions: ProductionStep[] = [];
  for (const code of order) {
    const quantityBase = demand.get(code) || 0;
    if (quantityBase <= 0) continue;
    const recipe = recipeFor(code)!;
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    const batchQuantity = quantityBase / outputRate;
    const components = new Map<string, { item: ExplosionItem; quantityBase: number }>();
    for (const line of recipe.lines) {
      const componentQuantity = line.quantity * (line.conversionRate || 1) * (1 + line.wasteRate / 100) * batchQuantity;
      if (componentQuantity <= 0) continue;
      const key = line.item.id;
      const current = components.get(key) || { item: line.item, quantityBase: 0 };
      current.quantityBase += componentQuantity;
      components.set(key, current);
    }
    if (components.size === 0) {
      explosionError(`Định lượng của ${code} không có nguyên liệu nào — không thể rã.`);
    }
    productions.push({
      productCode: code,
      quantityBase,
      batchQuantity,
      recipe,
      components: [...components.values()],
    });
  }

  return {
    productions,
    producedSales: [...producedSales.entries()].map(([productCode, quantityBase]) => ({ productCode, quantityBase })),
    directSales: [...directSales.entries()].map(([productCode, quantityBase]) => ({ productCode, quantityBase })),
  };
}

/**
 * Cost một ĐVT tồn kho của sản phẩm theo định lượng + giá bình quân nguyên liệu, rã đa
 * cấp: thành phần có định lượng thì lấy cost tính từ định lượng của chính nó thay vì giá
 * bình quân tồn kho (BTP vừa setup chưa có tồn vẫn ra cost đúng).
 *
 * Trả về map productCode → cost/ĐVT tồn kho. Thành phần khai vòng thì trả NaN cho nhánh đó.
 */
export function computeRecipeUnitCosts(
  recipes: ExplosionRecipe[],
  averageCostByItemId: Map<string, number>,
  date: Date,
): Map<string, number> {
  const recipeByProduct = new Map<string, ExplosionRecipe[]>();
  for (const recipe of recipes) {
    const code = up(recipe.productCode);
    if (!recipeByProduct.has(code)) recipeByProduct.set(code, []);
    recipeByProduct.get(code)!.push(recipe);
  }
  const costs = new Map<string, number>();
  const visiting = new Set<string>();

  const unitCostOf = (code: string): number => {
    if (costs.has(code)) return costs.get(code)!;
    if (visiting.has(code)) return Number.NaN;
    const recipe = pickRecipeForDate(recipeByProduct.get(code) || [], date);
    if (!recipe) return Number.NaN;
    visiting.add(code);
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    let batchCost = 0;
    for (const line of recipe.lines) {
      const componentCode = up(line.item.code);
      const quantityBase = line.quantity * (line.conversionRate || 1) * (1 + line.wasteRate / 100);
      const componentRecipeCost = unitCostOf(componentCode);
      const componentCost = Number.isFinite(componentRecipeCost)
        ? componentRecipeCost
        : averageCostByItemId.get(line.itemId) || 0;
      batchCost += quantityBase * componentCost;
    }
    visiting.delete(code);
    const unitCost = batchCost / outputRate;
    costs.set(code, unitCost);
    return unitCost;
  };

  for (const code of recipeByProduct.keys()) unitCostOf(code);
  return costs;
}

export type CostingLevel = {
  /** 1 = bán thành phẩm cấp 1 (chỉ dùng nguyên liệu), tăng dần theo độ sâu định lượng. */
  level: number;
  products: Array<{
    productCode: string;
    productName: string;
    itemType: string;
    /** Giá thành MỘT mẻ chuẩn bị theo định lượng. */
    batchCost: number;
    /** Giá vốn một ĐVT tồn kho = batchCost / hệ số quy đổi. */
    unitCost: number;
    outputConversionRate: number;
    sellingPrice: number;
  }>;
};

/**
 * Xếp các sản phẩm có định lượng thành TẦNG để chạy tính giá đúng thứ tự kế toán:
 * giá vốn nguyên liệu → giá bán thành phẩm cấp 1 → cấp 2 → ... → thành phẩm → combo.
 *
 * Tầng của một sản phẩm = tầng sâu nhất của các thành phần có định lượng + 1. Nguyên liệu
 * (không có định lượng) là tầng 0, lấy thẳng giá vốn bình quân tồn kho.
 */
export function computeCostingLevels(
  recipes: ExplosionRecipe[],
  averageCostByItemId: Map<string, number>,
  date: Date,
  itemTypeByCode?: Map<string, string>,
): CostingLevel[] {
  const recipeByProduct = new Map<string, ExplosionRecipe[]>();
  for (const recipe of recipes) {
    const code = up(recipe.productCode);
    if (!recipeByProduct.has(code)) recipeByProduct.set(code, []);
    recipeByProduct.get(code)!.push(recipe);
  }
  const current = new Map<string, ExplosionRecipe>();
  for (const [code, versions] of recipeByProduct) {
    const picked = pickRecipeForDate(versions, date);
    if (picked) current.set(code, picked);
  }

  // Độ sâu định lượng; định lượng khai vòng thì dừng ở tầng đang xét thay vì lặp vô hạn.
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (code: string): number => {
    if (depths.has(code)) return depths.get(code)!;
    const recipe = current.get(code);
    if (!recipe) return 0;
    if (visiting.has(code)) return 0;
    visiting.add(code);
    let depth = 1;
    for (const line of recipe.lines) {
      const componentCode = up(line.item.code);
      if (current.has(componentCode)) depth = Math.max(depth, depthOf(componentCode) + 1);
    }
    visiting.delete(code);
    depths.set(code, depth);
    return depth;
  };
  for (const code of current.keys()) depthOf(code);

  const unitCosts = computeRecipeUnitCosts(recipes, averageCostByItemId, date);
  const byLevel = new Map<number, CostingLevel["products"]>();
  for (const [code, recipe] of current) {
    const level = depths.get(code) || 1;
    const outputConversionRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    const unitCost = unitCosts.get(code);
    const safeUnitCost = Number.isFinite(unitCost) ? (unitCost as number) : 0;
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level)!.push({
      productCode: code,
      productName: recipe.productName,
      itemType: itemTypeByCode?.get(code) || "FINISHED",
      batchCost: safeUnitCost * outputConversionRate,
      unitCost: safeUnitCost,
      outputConversionRate,
      sellingPrice: recipe.sellingPrice || 0,
    });
  }

  return [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, products]) => ({
      level,
      products: products.sort((a, b) => a.productCode.localeCompare(b.productCode)),
    }));
}
