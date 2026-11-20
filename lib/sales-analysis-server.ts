import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { isSurchargeItemText, revenueKindFromText } from "@/lib/revenue-source";
import type { SalesCell, SalesKind } from "@/lib/sales-analysis";

export type SalesAnalysisData = {
  period: string;
  branchCode: string;
  cells: SalesCell[];
  /** Tên món theo mã (danh mục mặt hàng); mã không có trong danh mục thì không có tên. */
  names: Record<string, string>;
};

/**
 * Gom dòng doanh thu POS của tháng về ô (mã món × nhóm × giờ bán) cho báo cáo Doanh thu theo
 * ca & món (lib/sales-analysis.ts chia ca phía trình duyệt). Gom bằng GROUP BY: một tháng
 * ASA có ~16.000 dòng nhưng chỉ vài nghìn ô.
 *
 * Nhóm Đồ ăn / Đồ uống đọc từ cột Nhóm doanh thu của dòng (chữ "ĐỒ ĂN" hoặc mã REV_FOOD/REV_BAR),
 * không ra thì đọc tên danh mục Thu, rồi tới nhóm doanh thu gắn trên mặt hàng.
 */
export async function getSalesAnalysis(period: string, branchCode: string): Promise<SalesAnalysisData> {
  const { start, end } = periodBounds(period);
  const groups = await prisma.revenueImportRow.groupBy({
    by: ["productCode", "revenueSource", "saleHour"],
    where: {
      saleDate: { gte: start, lt: end },
      deletedAt: null,
      ...(branchCode === "ALL" ? {} : { branchCode }),
    },
    _sum: { productQuantity: true, grossAmount: true, discountAmount: true, netAmount: true },
    _count: { _all: true },
  });

  const codes = [...new Set(groups.map((group) => (group.productCode || "").trim()).filter(Boolean))];
  const [items, categories] = await Promise.all([
    codes.length > 0
      ? prisma.inventoryItem.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, revenueGroup: true } })
      : Promise.resolve([] as Array<{ code: string; name: string; revenueGroup: string | null }>),
    prisma.masterDataItem.findMany({ where: { type: "REVENUE_EXPENSE_CATEGORY", deletedAt: null }, select: { code: true, name: true } }),
  ]);
  const categoryName = new Map(categories.map((category) => [category.code.toUpperCase(), category.name]));
  const itemByCode = new Map(items.map((item) => [item.code, item]));

  const kindOfText = (value: string | null | undefined): SalesKind | null => {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const direct = revenueKindFromText(text);
    if (direct) return direct;
    const name = categoryName.get(text.toUpperCase());
    const viaCategory = name ? revenueKindFromText(`${text} ${name}`) : null;
    if (viaCategory) return viaCategory;
    return isSurchargeItemText(text) || (name && isSurchargeItemText(name)) ? "SERVICE" : null;
  };

  const cells: SalesCell[] = groups.map((group) => {
    const code = (group.productCode || "").trim();
    const item = code ? itemByCode.get(code) : undefined;
    const kind = kindOfText(group.revenueSource)
      || kindOfText(item?.revenueGroup)
      || (item && isSurchargeItemText(item.name) ? "SERVICE" : null)
      || "OTHER";
    const gross = group._sum.grossAmount || 0;
    const discount = group._sum.discountAmount || 0;
    return {
      code,
      kind,
      hour: group.saleHour ?? null,
      quantity: group._sum.productQuantity || 0,
      amount: gross - discount,
      total: group._sum.netAmount || 0,
      rows: group._count._all,
    };
  });

  const names: Record<string, string> = {};
  for (const item of items) names[item.code] = item.name;
  return { period, branchCode, cells, names };
}
