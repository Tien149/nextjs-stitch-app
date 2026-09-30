/**
 * Báo cáo "Mã thiếu định lượng" của tab Định lượng (khách hỏi 30/09/2026: có báo cáo nào biết
 * nhóm Finished & Semi-Finished trong tháng đã update đủ BOM chưa).
 *
 * Hai phần, cùng luật chọn công thức với nút Rã (pickRecipeForDate theo cửa hàng — bản riêng
 * của cửa hàng, không có thì bản dùng chung):
 *   1. MÓN BÁN: thành phẩm / bán thành phẩm có bán trong tháng mà cửa hàng chưa có định lượng —
 *      lúc rã chúng bị xuất bán thẳng từ tồn kho (luôn âm, giá vốn 0). Mã bán mà chưa có trong
 *      danh mục mặt hàng cũng vào đây vì làm lần rã báo lỗi. Dòng thuộc nhóm doanh thu không
 *      theo dõi tồn kho (phụ thu, dịch vụ) được bỏ qua như lúc rã.
 *   2. THÀNH PHẦN: thành phẩm / bán thành phẩm nằm trong định lượng cửa hàng đang dùng nhưng
 *      chính nó chưa có định lượng — bị trừ tồn như nguyên liệu mà không bao giờ được chế biến.
 *      Có nhập mua trong tháng thì nhiều khả năng là hàng mua sẵn, nên đổi nhóm sang Nguyên liệu.
 */
import type { TxClient } from "@/lib/prisma";
import { pickRecipeForDate, type ExplosionRecipe } from "@/lib/production-explosion";
import { loadNonInventoryRevenueGroups, tracksInventory, type CategoryLookupClient } from "@/lib/revenue-source";

export type MissingRecipeSoldRow = {
  branchCode: string;
  productCode: string;
  productName: string;
  /** Nhóm mặt hàng; null = mã chưa có trong danh mục. */
  itemType: string | null;
  quantity: number;
  revenue: number;
  rows: number;
};

export type MissingRecipeComponentRow = {
  branchCode: string;
  itemCode: string;
  itemName: string;
  itemType: string;
  /** Các món (đang áp dụng ở cửa hàng) có dòng định lượng dùng mã này. */
  usedIn: string[];
  /** Số lượng nhập mua (ĐVT tồn) trong tháng ở cửa hàng — > 0 thì nhiều khả năng là hàng mua sẵn. */
  purchasedQuantity: number;
};

export type MissingRecipeReport = {
  month: string;
  branches: string[];
  sold: MissingRecipeSoldRow[];
  components: MissingRecipeComponentRow[];
};

const PRODUCED_TYPES = new Set(["FINISHED", "SEMI_FINISHED"]);

function up(value: string | null | undefined) {
  return (value || "").trim().toUpperCase();
}

/** Phần tính thuần — test được không cần DB. */
export function buildMissingRecipeReport(input: {
  month: string;
  /** Ngày dùng để chọn phiên bản định lượng (cuối tháng). */
  date: Date;
  branches: string[];
  recipes: ExplosionRecipe[];
  items: Array<{ code: string; name: string; itemType: string }>;
  soldRows: Array<{ branchCode: string; productCode: string | null; productQuantity: number | null; netAmount: number; revenueSource: string | null }>;
  nonInventoryGroups: Set<string>;
  purchases: Array<{ branchCode: string; itemCode: string; quantity: number }>;
}): MissingRecipeReport {
  const itemByCode = new Map(input.items.map((item) => [up(item.code), item]));
  const versionsByProduct = new Map<string, ExplosionRecipe[]>();
  for (const recipe of input.recipes) {
    const code = up(recipe.productCode);
    versionsByProduct.set(code, [...(versionsByProduct.get(code) || []), recipe]);
  }
  const recipeCache = new Map<string, ExplosionRecipe | null>();
  const recipeFor = (code: string, branchCode: string) => {
    const key = `${code}|${branchCode}`;
    if (!recipeCache.has(key)) recipeCache.set(key, pickRecipeForDate(versionsByProduct.get(code) || [], input.date, branchCode));
    return recipeCache.get(key)!;
  };

  const sold = new Map<string, MissingRecipeSoldRow>();
  for (const row of input.soldRows) {
    const code = up(row.productCode);
    const branchCode = up(row.branchCode);
    if (!code || !input.branches.includes(branchCode)) continue;
    if (!tracksInventory(row.revenueSource, input.nonInventoryGroups)) continue;
    const item = itemByCode.get(code);
    // Nguyên liệu / hàng mua bán bán thẳng từ tồn là đúng luật, không cần định lượng.
    if (item && !PRODUCED_TYPES.has(item.itemType)) continue;
    if (recipeFor(code, branchCode)) continue;
    const key = `${branchCode}|${code}`;
    const current = sold.get(key) || { branchCode, productCode: code, productName: item?.name || "", itemType: item?.itemType || null, quantity: 0, revenue: 0, rows: 0 };
    current.quantity += row.productQuantity || 0;
    current.revenue += row.netAmount || 0;
    current.rows += 1;
    sold.set(key, current);
  }

  const purchased = new Map<string, number>();
  for (const row of input.purchases) {
    const key = `${up(row.branchCode)}|${up(row.itemCode)}`;
    purchased.set(key, (purchased.get(key) || 0) + row.quantity);
  }
  const components = new Map<string, MissingRecipeComponentRow>();
  for (const branchCode of input.branches) {
    for (const productCode of versionsByProduct.keys()) {
      const recipe = recipeFor(productCode, branchCode);
      if (!recipe) continue;
      for (const line of recipe.lines) {
        const code = up(line.item.code);
        if (!PRODUCED_TYPES.has(up(line.item.itemType)) || recipeFor(code, branchCode)) continue;
        const key = `${branchCode}|${code}`;
        const current = components.get(key) || {
          branchCode,
          itemCode: code,
          itemName: line.item.name,
          itemType: up(line.item.itemType),
          usedIn: [],
          purchasedQuantity: purchased.get(key) || 0,
        };
        if (!current.usedIn.includes(productCode)) current.usedIn.push(productCode);
        components.set(key, current);
      }
    }
  }

  return {
    month: input.month,
    branches: input.branches,
    sold: [...sold.values()].sort((a, b) => a.branchCode.localeCompare(b.branchCode) || b.revenue - a.revenue || a.productCode.localeCompare(b.productCode)),
    components: [...components.values()].sort((a, b) => a.branchCode.localeCompare(b.branchCode) || b.usedIn.length - a.usedIn.length || a.itemCode.localeCompare(b.itemCode)),
  };
}

/** Tháng YYYY-MM → [đầu tháng, đầu tháng sau): ngày bán POS lưu 00:00 UTC, phiếu kho theo giờ VN. */
function monthBounds(month: string) {
  const [year, monthNo] = month.split("-").map(Number);
  return {
    saleStart: new Date(Date.UTC(year, monthNo - 1, 1)),
    saleEnd: new Date(Date.UTC(year, monthNo, 1)),
    docStart: new Date(Date.UTC(year, monthNo - 1, 1) - 7 * 3600 * 1000),
    docEnd: new Date(Date.UTC(year, monthNo, 1) - 7 * 3600 * 1000),
  };
}

export async function loadMissingRecipeReport(db: TxClient, input: { month: string; branchCode: string }): Promise<MissingRecipeReport> {
  const { saleStart, saleEnd, docStart, docEnd } = monthBounds(input.month);
  const branchFilter = input.branchCode === "ALL" ? {} : { branchCode: input.branchCode };
  const [soldRows, recipes, items, purchaseLines, nonInventoryGroups] = await Promise.all([
    db.revenueImportRow.findMany({
      where: { ...branchFilter, deletedAt: null, saleDate: { gte: saleStart, lt: saleEnd }, productCode: { not: null } },
      select: { branchCode: true, productCode: true, productQuantity: true, netAmount: true, revenueSource: true },
    }),
    db.recipe.findMany({ where: { deletedAt: null }, include: { lines: { include: { item: true } } } }),
    db.inventoryItem.findMany({ select: { code: true, name: true, itemType: true } }),
    db.inventoryTransactionLine.findMany({
      where: { transaction: { ...branchFilter, deletedAt: null, transactionType: "NHAP_MUA", transactionDate: { gte: docStart, lt: docEnd } } },
      select: { quantity: true, item: { select: { code: true } }, transaction: { select: { branchCode: true } } },
    }),
    loadNonInventoryRevenueGroups(db as unknown as CategoryLookupClient),
  ]);
  const branches = input.branchCode === "ALL"
    ? [...new Set(soldRows.map((row) => up(row.branchCode)))].sort()
    : [up(input.branchCode)];
  return buildMissingRecipeReport({
    month: input.month,
    // Phiên bản áp dụng ở ngày cuối tháng, như lần rã cả tháng.
    date: new Date(saleEnd.getTime() - 1),
    branches,
    recipes: recipes as unknown as ExplosionRecipe[],
    items,
    soldRows,
    nonInventoryGroups,
    purchases: purchaseLines.map((line) => ({ branchCode: line.transaction.branchCode, itemCode: line.item.code, quantity: line.quantity })),
  });
}
