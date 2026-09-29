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

import { safeConversionRate } from "@/lib/unit-conversion";

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
  /** ĐVT khai trên dòng định lượng; rỗng = ĐVT tồn kho của nguyên liệu. */
  unitCode?: string | null;
  /** Quy đổi quantity về ĐVT tồn kho của nguyên liệu (chai830gr -> 830). */
  conversionRate: number;
  wasteRate: number;
  item: ExplosionItem;
};

export type ExplosionRecipe = {
  id: string;
  productCode: string;
  productName: string;
  /** Cửa hàng áp dụng; rỗng/null = công thức dùng chung cho mọi cửa hàng. */
  branchCode?: string | null;
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
  /** Phần nhu cầu sản phẩm có định lượng lấy từ TỒN KHO thay vì chế biến mới (xem takeFromStock). */
  stockUsed: Array<{ productCode: string; quantityBase: number }>;
};

/**
 * Hệ số quy đổi ĐÁNG TIN của một dòng định lượng.
 *
 * Định lượng lưu sẵn hệ số trên dòng, nhưng dữ liệu thật có hàng nghìn dòng khai "300 GR ×
 * 1000" cho nguyên liệu vốn đã tính bằng GR — tức quy đổi một đơn vị ra CHÍNH NÓ với tỷ lệ
 * khác 1, đúng cái luật bất biến mà lib/unit-conversion.ts dựng lên để chặn. Đọc thẳng
 * `line.conversionRate` thì mỗi cấp bán thành phẩm nhân sai 1000 lần và nhân chồng qua các
 * cấp (một mẻ sốt ra nhu cầu cà chua nghìn tấn, rã BOM chết vì "xuất vượt tồn kho").
 */
export function lineConversionRate(line: ExplosionRecipeLine) {
  const unitCode = (line.unitCode || "").trim();
  // Bỏ trống ĐVT thì KHÔNG suy ra là trùng ĐVT tồn kho: dữ liệu cũ có dòng khai đúng phép quy
  // đổi (2 chai830gr = 1660 gr) mà chưa kịp điền ĐVT, ép về 1 là xoá mất phép nhân thật.
  // Chỉ chặn đúng hình dạng hỏng: ĐVT khai tường minh mà trùng ĐVT tồn kho, hệ số vẫn khác 1.
  if (!unitCode) return line.conversionRate > 0 ? line.conversionRate : 1;
  return safeConversionRate(line.item.unit, { unitCode, conversionRate: line.conversionRate });
}

function up(value: string) {
  return value.trim().toUpperCase();
}

function explosionError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

export function recipeBranchOf(recipe: ExplosionRecipe) {
  const branch = up(recipe.branchCode || "");
  return branch === "ALL" ? "" : branch;
}

/**
 * Thu hẹp danh sách phiên bản về đúng phạm vi cửa hàng.
 *
 * Luật (khách chốt 20/09/2026): cửa hàng nào khai công thức RIÊNG thì dùng bản riêng, nơi
 * chưa khai thì ăn bản DÙNG CHUNG (branchCode rỗng). Bản riêng của cửa hàng khác không bao
 * giờ được đem sang — pha kiểu cửa hàng A mà trừ kho cửa hàng B là sai cả giá vốn lẫn tồn.
 *
 * Không truyền cửa hàng (bảng giá thành chạy cho "Tất cả cửa hàng") thì lấy bản chung; món
 * nào chỉ có bản riêng thì đành gộp mọi bản riêng lại để món đó vẫn lên bảng, thay vì biến mất.
 */
function scopeRecipesToBranch(recipes: ExplosionRecipe[], branchCode?: string | null): ExplosionRecipe[] {
  if (recipes.length === 0) return recipes;
  const branch = up(branchCode || "");
  const shared = recipes.filter((recipe) => !recipeBranchOf(recipe));
  if (!branch || branch === "ALL") return shared.length > 0 ? shared : recipes;
  const own = recipes.filter((recipe) => recipeBranchOf(recipe) === branch);
  if (own.length > 0) return own;
  return shared;
}

/**
 * Chọn phiên bản định lượng theo cửa hàng + ngày áp dụng: trong phạm vi cửa hàng đã chọn,
 * lấy phiên bản có effectiveFrom muộn nhất nhưng không vượt quá ngày bán (trùng ngày thì lấy
 * version lớn hơn). Món bán trước khi mọi phiên bản có hiệu lực thì đành dùng phiên bản sớm
 * nhất — còn hơn là không rã được.
 */
export function pickRecipeForDate(recipes: ExplosionRecipe[], date: Date, branchCode?: string | null): ExplosionRecipe | null {
  const scoped = scopeRecipesToBranch(recipes, branchCode);
  if (scoped.length === 0) return null;
  const time = date.getTime();
  const sorted = [...scoped].sort((a, b) => {
    const diff = new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime();
    return diff !== 0 ? diff : a.version - b.version;
  });
  const effective = sorted.filter((recipe) => new Date(recipe.effectiveFrom).getTime() <= time);
  return effective.length > 0 ? effective[effective.length - 1] : sorted[0];
}

/**
 * Dấu vân tay NỘI DUNG của một phiên bản định lượng: đúng những gì làm thay đổi số rã
 * (nguyên liệu, định lượng, quy đổi, hao hụt, hệ số mẻ). Tên món, giá bán, ghi chú không vào
 * đây — sửa chúng không cần rã lại. Dùng để biết một lần rã cũ có còn khớp định lượng mới không.
 */
export function recipeContentSignature(recipe: ExplosionRecipe | null | undefined) {
  if (!recipe) return "";
  return JSON.stringify([
    recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1,
    recipe.lines
      .map((line) => [line.itemId, line.quantity, lineConversionRate(line), line.wasteRate].join("|"))
      .sort(),
  ]);
}

export type ExplosionInput = {
  /** Số lượng bán theo mã sản phẩm, tính bằng ĐVT tồn kho của sản phẩm. */
  demands: Array<{ productCode: string; quantity: number }>;
  /** Toàn bộ phiên bản định lượng, nhóm sẵn hay không đều được. */
  recipes: ExplosionRecipe[];
  /** Ngày dùng để chọn phiên bản định lượng. */
  date: Date;
  /** Cửa hàng đang rã: quyết định dùng công thức riêng của cửa hàng hay bản dùng chung. */
  branchCode?: string | null;
  /**
   * Lấy tồn trước, chế biến phần thiếu (khách chốt 29/09/2026): cần 5 kg BTP A mà kho còn 2 kg
   * thì dùng 2 kg tồn, chỉ chế biến 3 kg. Trả về số lấy được từ tồn (caller tự trừ dần tồn của
   * kho tương ứng `department`, không lấy quá tồn dương). Không truyền = chế biến đủ 100% như cũ.
   */
  takeFromStock?: (productCode: string, department: string | null, quantity: number) => number;
};

const stockEpsilon = 1e-9;

/** Số lấy được từ tồn cho một nhu cầu, kẹp trong [0, nhu cầu]. */
function takeStock(input: ExplosionInput, code: string, department: string | null, needed: number) {
  if (!input.takeFromStock || !(needed > 0)) return 0;
  const taken = Number(input.takeFromStock(code, department, needed));
  return Number.isFinite(taken) ? Math.min(needed, Math.max(0, taken)) : 0;
}

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
      pickedRecipe.set(code, pickRecipeForDate(recipeByProduct.get(code) || [], input.date, input.branchCode));
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

  // Cộng dồn nhu cầu từ cấp trên xuống: duyệt ngược hậu thứ tự (combo → TP → BTP). Tới lượt
  // một mã thì nhu cầu của mọi cấp trên đã chốt: lấy tồn trước, chỉ phần thiếu mới chế biến và
  // mới kéo nhu cầu xuống cấp dưới.
  const production = new Map<string, number>();
  const stockUsed = new Map<string, number>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const code = order[index];
    const needed = demand.get(code) || 0;
    if (needed <= 0) continue;
    const fromStock = takeStock(input, code, null, needed);
    if (fromStock > 0) stockUsed.set(code, (stockUsed.get(code) || 0) + fromStock);
    const quantityBase = needed - fromStock;
    if (quantityBase <= stockEpsilon) continue;
    production.set(code, quantityBase);
    const recipe = recipeFor(code)!;
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    const batchQuantity = quantityBase / outputRate;
    for (const line of recipe.lines) {
      const componentCode = up(line.item.code);
      if (!recipeFor(componentCode)) continue;
      const componentQuantity = line.quantity * lineConversionRate(line) * (1 + line.wasteRate / 100) * batchQuantity;
      demand.set(componentCode, (demand.get(componentCode) || 0) + componentQuantity);
    }
  }

  // Sinh bước chế biến theo đúng hậu thứ tự: BTP đứng trước TP, TP trước combo.
  const productions: ProductionStep[] = [];
  for (const code of order) {
    const quantityBase = production.get(code) || 0;
    if (quantityBase <= 0) continue;
    const recipe = recipeFor(code)!;
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    const batchQuantity = quantityBase / outputRate;
    const components = new Map<string, { item: ExplosionItem; quantityBase: number }>();
    for (const line of recipe.lines) {
      const componentQuantity = line.quantity * lineConversionRate(line) * (1 + line.wasteRate / 100) * batchQuantity;
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
    stockUsed: [...stockUsed.entries()].map(([productCode, quantityBase]) => ({ productCode, quantityBase })),
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
  branchCode?: string | null,
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
    const recipe = pickRecipeForDate(recipeByProduct.get(code) || [], date, branchCode);
    if (!recipe) return Number.NaN;
    visiting.add(code);
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    let batchCost = 0;
    for (const line of recipe.lines) {
      const componentCode = up(line.item.code);
      const quantityBase = line.quantity * lineConversionRate(line) * (1 + line.wasteRate / 100);
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
  branchCode?: string | null,
): CostingLevel[] {
  const recipeByProduct = new Map<string, ExplosionRecipe[]>();
  for (const recipe of recipes) {
    const code = up(recipe.productCode);
    if (!recipeByProduct.has(code)) recipeByProduct.set(code, []);
    recipeByProduct.get(code)!.push(recipe);
  }
  const current = new Map<string, ExplosionRecipe>();
  for (const [code, versions] of recipeByProduct) {
    const picked = pickRecipeForDate(versions, date, branchCode);
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

  const unitCosts = computeRecipeUnitCosts(recipes, averageCostByItemId, date, branchCode);
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

export type DepartmentProductionStep = Omit<ProductionStep, "components"> & {
  /** Bộ phận của bước chế biến = kho NHẬP thành phẩm của bước; null = chưa suy được. */
  department: string | null;
  /** Mỗi nguyên liệu mang bộ phận của kho sẽ trừ nó (combo: kho của từng thành phần). */
  components: Array<{ item: ExplosionItem; quantityBase: number; department: string | null }>;
};

export type DepartmentExplosionPlan = {
  productions: DepartmentProductionStep[];
  producedSales: Array<{ productCode: string; quantityBase: number; department: string | null }>;
  directSales: Array<{ productCode: string; quantityBase: number; department: string | null }>;
  stockUsed: Array<{ productCode: string; quantityBase: number; department: string | null }>;
};

export type DepartmentRules = {
  /** Bộ phận của MỘT MÓN tự thân (nhóm doanh thu -> phân nhóm); null khi không suy được. */
  departmentOf: (productCode: string) => string | null;
  /** Combo luôn nhập kho / xuất bán ở bộ phận này (khách chốt 27/09/2026: kho bếp). */
  comboDepartment?: string | null;
};

/** Combo = định lượng có ít nhất một thành phần là THÀNH PHẨM (món ghép từ món). */
export function isComboRecipe(recipe: ExplosionRecipe) {
  return recipe.lines.some((line) => up(line.item.itemType) === "FINISHED");
}

/**
 * Rã theo BỘ PHẬN (bếp / bar), khách chốt 27/09/2026:
 *   - món bán ra thuộc bộ phận của chính nó (nhóm doanh thu -> phân nhóm);
 *   - bán thành phẩm & nguyên liệu KHÔNG tự suy bộ phận, đi theo món dùng tới nó — BTP dùng
 *     cho cả món bếp lẫn món bar thì chế biến tách phần ở từng kho;
 *   - COMBO nhập kho / xuất bán ở `comboDepartment` (kho bếp), còn TỪNG THÀNH PHẦN của combo
 *     trừ ở kho của chính thành phần đó (món ăn -> bếp, đồ uống -> bar), không suy được thì
 *     theo combo.
 * Trước đây mỗi bước tự suy kho theo chính sản phẩm của bước: BTP không có nhóm doanh thu nên
 * rơi hết về kho mặc định (Kho văn phòng), cả combo lẫn đồ uống trong combo đi chung một kho.
 *
 * Cùng công thức số lượng với explodeSalesDemand, chỉ khác là nhu cầu được theo dõi theo cặp
 * (sản phẩm, bộ phận). Bộ phận null = chưa suy được, caller tự chọn kho mặc định.
 */
export function explodeSalesDemandWithDepartments(input: ExplosionInput, rules: DepartmentRules): DepartmentExplosionPlan {
  const recipeByProduct = new Map<string, ExplosionRecipe[]>();
  for (const recipe of input.recipes) {
    const code = up(recipe.productCode);
    if (!recipeByProduct.has(code)) recipeByProduct.set(code, []);
    recipeByProduct.get(code)!.push(recipe);
  }
  const pickedRecipe = new Map<string, ExplosionRecipe | null>();
  const recipeFor = (code: string) => {
    if (!pickedRecipe.has(code)) pickedRecipe.set(code, pickRecipeForDate(recipeByProduct.get(code) || [], input.date, input.branchCode));
    return pickedRecipe.get(code)!;
  };

  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (code: string, chain: string[]) => {
    const marker = state.get(code);
    if (marker === 2) return;
    if (marker === 1) explosionError(`Định lượng khai vòng: ${[...chain, code].join(" → ")}. Sửa lại định lượng trước khi rã.`);
    state.set(code, 1);
    for (const line of recipeFor(code)?.lines || []) {
      const componentCode = up(line.item.code);
      if (recipeFor(componentCode)) visit(componentCode, [...chain, code]);
    }
    state.set(code, 2);
    order.push(code);
  };

  const keyOf = (department: string | null) => department || "";
  const deptOfKey = (key: string) => key || null;
  const addTo = (map: Map<string, Map<string, number>>, code: string, department: string | null, quantity: number) => {
    const byDept = map.get(code) || new Map<string, number>();
    byDept.set(keyOf(department), (byDept.get(keyOf(department)) || 0) + quantity);
    map.set(code, byDept);
  };
  const soldDepartment = (code: string) => {
    const recipe = recipeFor(code);
    if (recipe && isComboRecipe(recipe) && rules.comboDepartment) return rules.comboDepartment;
    return rules.departmentOf(code);
  };

  const demand = new Map<string, Map<string, number>>();
  const producedSales = new Map<string, Map<string, number>>();
  const directSales = new Map<string, Map<string, number>>();
  for (const entry of input.demands) {
    const code = up(entry.productCode);
    if (!(entry.quantity > 0)) continue;
    const department = soldDepartment(code);
    if (!recipeFor(code)) {
      addTo(directSales, code, department, entry.quantity);
      continue;
    }
    visit(code, []);
    addTo(demand, code, department, entry.quantity);
    addTo(producedSales, code, department, entry.quantity);
  }

  /** Bộ phận của một thành phần khi sản phẩm cha ở bộ phận `parent`. */
  const componentDepartment = (parentRecipe: ExplosionRecipe, item: ExplosionItem, parent: string | null) => {
    if (!isComboRecipe(parentRecipe)) return parent;
    return rules.departmentOf(up(item.code)) ?? parent;
  };

  // Cộng dồn nhu cầu từ cấp trên xuống (combo → TP → BTP), giữ nguyên bộ phận từng nhánh. Tồn
  // trừ theo TỪNG bộ phận (kho bếp / kho bar): BTP nằm ở kho bếp không đem bù cho món bar.
  const production = new Map<string, Map<string, number>>();
  const stockUsed = new Map<string, Map<string, number>>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const code = order[index];
    const recipe = recipeFor(code)!;
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    for (const [key, needed] of demand.get(code) || []) {
      if (needed <= 0) continue;
      const fromStock = takeStock(input, code, deptOfKey(key), needed);
      if (fromStock > 0) addTo(stockUsed, code, deptOfKey(key), fromStock);
      const quantityBase = needed - fromStock;
      if (quantityBase <= stockEpsilon) continue;
      addTo(production, code, deptOfKey(key), quantityBase);
      const batchQuantity = quantityBase / outputRate;
      for (const line of recipe.lines) {
        const componentCode = up(line.item.code);
        if (!recipeFor(componentCode)) continue;
        const componentQuantity = line.quantity * lineConversionRate(line) * (1 + line.wasteRate / 100) * batchQuantity;
        addTo(demand, componentCode, componentDepartment(recipe, line.item, deptOfKey(key)), componentQuantity);
      }
    }
  }

  const productions: DepartmentProductionStep[] = [];
  for (const code of order) {
    const recipe = recipeFor(code)!;
    const outputRate = recipe.outputConversionRate > 0 ? recipe.outputConversionRate : 1;
    for (const [key, quantityBase] of production.get(code) || []) {
      if (quantityBase <= 0) continue;
      const department = deptOfKey(key);
      const batchQuantity = quantityBase / outputRate;
      const components = new Map<string, { item: ExplosionItem; quantityBase: number; department: string | null }>();
      for (const line of recipe.lines) {
        const componentQuantity = line.quantity * lineConversionRate(line) * (1 + line.wasteRate / 100) * batchQuantity;
        if (componentQuantity <= 0) continue;
        const componentDept = componentDepartment(recipe, line.item, department);
        const componentKey = `${line.item.id}|${keyOf(componentDept)}`;
        const current = components.get(componentKey) || { item: line.item, quantityBase: 0, department: componentDept };
        current.quantityBase += componentQuantity;
        components.set(componentKey, current);
      }
      if (components.size === 0) explosionError(`Định lượng của ${code} không có nguyên liệu nào — không thể rã.`);
      productions.push({ productCode: code, department, quantityBase, batchQuantity, recipe, components: [...components.values()] });
    }
  }

  const flatten = (map: Map<string, Map<string, number>>) => [...map.entries()].flatMap(([productCode, byDept]) => (
    [...byDept.entries()].map(([key, quantityBase]) => ({ productCode, quantityBase, department: deptOfKey(key) }))
  ));
  return { productions, producedSales: flatten(producedSales), directSales: flatten(directSales), stockUsed: flatten(stockUsed) };
}
