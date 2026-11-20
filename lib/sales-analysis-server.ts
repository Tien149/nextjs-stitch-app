import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { isSurchargeItemText, revenueKindFromText } from "@/lib/revenue-source";
import { vietnamBusinessDayKey } from "@/lib/revenue-date";
import type { SalesCell, SalesKind, VisitCell } from "@/lib/sales-analysis";

export type SalesAnalysisData = {
  period: string;
  branchCode: string;
  cells: SalesCell[];
  /** Tên món theo mã (danh mục mặt hàng); mã không có trong danh mục thì không có tên. */
  names: Record<string, string>;
  /** Lượt khách theo ngày × giờ × kênh (cột Số khách / Số hoá đơn của file POS). */
  visits: VisitCell[];
  /** Có dòng nào trong kỳ mang cột Số khách không — chưa có thì màn báo cách thêm cột. */
  hasGuestData: boolean;
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
  const scope = {
    saleDate: { gte: start, lt: end },
    deletedAt: null,
    ...(branchCode === "ALL" ? {} : { branchCode }),
  };
  const [visitGroups, groups] = await Promise.all([
    prisma.revenueImportRow.groupBy({
      by: ["saleDate", "saleHour", "channel"],
      where: scope,
      _sum: { guestCount: true, orderCount: true, grossAmount: true, discountAmount: true, netAmount: true },
      _count: { guestCount: true },
    }),
    prisma.revenueImportRow.groupBy({
      by: ["productCode", "revenueSource", "saleHour"],
      where: scope,
      _sum: { productQuantity: true, grossAmount: true, discountAmount: true, netAmount: true },
      _count: { _all: true },
    }),
  ]);

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
  // Ngày lưu có thể là nửa đêm UTC (file mới) hoặc nửa đêm giờ VN (file cũ): gom theo ngày
  // nghiệp vụ VN cho khỏi xé một ngày làm hai dòng — cùng luật Sổ doanh thu.
  const visitMap = new Map<string, VisitCell>();
  let hasGuestData = false;
  for (const group of visitGroups) {
    if (group._count.guestCount > 0) hasGuestData = true;
    const date = vietnamBusinessDayKey(group.saleDate);
    const channel = (group.channel || "").trim() || "Không ghi kênh";
    const hour = group.saleHour ?? null;
    const key = `${date}|${hour ?? ""}|${channel}`;
    const current = visitMap.get(key) || { date, hour, channel, guests: 0, bills: 0, amount: 0, total: 0 };
    current.guests += group._sum.guestCount || 0;
    current.bills += group._sum.orderCount || 0;
    current.amount += (group._sum.grossAmount || 0) - (group._sum.discountAmount || 0);
    current.total += group._sum.netAmount || 0;
    visitMap.set(key, current);
  }
  return { period, branchCode, cells, names, visits: [...visitMap.values()], hasGuestData };
}
