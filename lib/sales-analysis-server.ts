import { prisma } from "@/lib/prisma";
import { periodBounds } from "@/lib/accounting";
import { isSurchargeItemText, revenueKindFromText } from "@/lib/revenue-source";
import { vietnamBusinessDayKey } from "@/lib/revenue-date";
import { normalizeGoodsGroup } from "@/lib/goods-group";
import { normalizeShiftDefs, type SalesCell, type SalesKind, type ShiftConfigs, type ShiftDef, type VisitCell } from "@/lib/sales-analysis";

export type SalesAnalysisData = {
  period: string;
  branchCode: string;
  cells: SalesCell[];
  /** Tên món theo mã (danh mục mặt hàng); mã không có trong danh mục thì không có tên. */
  names: Record<string, string>;
  /** Loại (itemType) và Nhóm hàng hóa (goodsGroup) của món theo danh mục mặt hàng — để lọc (khách 20/11/2026). */
  itemInfo: Record<string, { itemType: string; goodsGroup: string | null }>;
  /** Lượt khách theo ngày × giờ × kênh (cột Số khách / Số hoá đơn của file POS). */
  visits: VisitCell[];
  /** Có dòng nào trong kỳ mang cột Số khách không — chưa có thì màn báo cách thêm cột. */
  hasGuestData: boolean;
  /** Ca đã khai theo cửa hàng (SalesShiftConfig); cửa hàng chưa khai thì không có khoá -> ca mặc định. */
  shiftConfigs: ShiftConfigs;
  /** Cửa hàng có doanh thu trong kỳ (xem Tất cả cửa hàng thì cấu hình ca theo từng cửa hàng này). */
  branches: string[];
  /** Ghi chú của BOD theo mã món, cho đúng kỳ + phạm vi cửa hàng đang xem. */
  notes: Record<string, SalesItemNoteValue>;
};

export type SalesItemNoteValue = { note: string; updatedBy: string | null; updatedAt: string };

/** Ghi đè ghi chú một món; để trống là xoá. Trả về ghi chú đã lưu (null nếu đã xoá). */
export async function saveSalesItemNote(period: string, branchCode: string, productCode: string, note: string, actor: string): Promise<SalesItemNoteValue | null> {
  const key = { period, branchCode, productCode };
  if (!note) {
    await prisma.salesItemNote.deleteMany({ where: key });
    return null;
  }
  const saved = await prisma.salesItemNote.upsert({
    where: { period_branchCode_productCode: key },
    create: { ...key, note, updatedBy: actor },
    update: { note, updatedBy: actor },
  });
  return { note: saved.note, updatedBy: saved.updatedBy, updatedAt: saved.updatedAt.toISOString() };
}

function parseShiftsJson(value: string): ShiftDef[] {
  try {
    return normalizeShiftDefs(JSON.parse(value));
  } catch {
    return [];
  }
}

export async function loadSalesShiftConfigs(): Promise<ShiftConfigs> {
  const rows = await prisma.salesShiftConfig.findMany();
  const configs: ShiftConfigs = {};
  for (const row of rows) {
    const shifts = parseShiftsJson(row.shiftsJson);
    if (shifts.length > 0) configs[row.branchCode] = shifts;
  }
  return configs;
}

/** Lưu bộ ca của một cửa hàng. Trả về bộ ca đã chuẩn hoá (giờ làm tròn khung 15 phút, xếp theo giờ). */
export async function saveSalesShiftConfig(branchCode: string, input: unknown, actor: string) {
  const shifts = normalizeShiftDefs(input);
  if (shifts.length === 0) throw new Error("BUSINESS:Cần ít nhất một ca có tên và giờ bắt đầu");
  const shiftsJson = JSON.stringify(shifts);
  await prisma.salesShiftConfig.upsert({
    where: { branchCode },
    create: { branchCode, shiftsJson, updatedBy: actor },
    update: { shiftsJson, updatedBy: actor },
  });
  return shifts;
}

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
      by: ["saleDate", "branchCode", "saleHour", "saleMinute", "channel"],
      where: scope,
      _sum: { guestCount: true, orderCount: true, netAmount: true },
      _count: { guestCount: true },
    }),
    prisma.revenueImportRow.groupBy({
      by: ["productCode", "revenueSource", "branchCode", "saleHour", "saleMinute"],
      where: scope,
      _sum: { productQuantity: true, netAmount: true },
      _count: { _all: true },
    }),
  ]);

  const codes = [...new Set(groups.map((group) => (group.productCode || "").trim()).filter(Boolean))];
  const [items, categories] = await Promise.all([
    codes.length > 0
      ? prisma.inventoryItem.findMany({ where: { code: { in: codes } }, select: { code: true, name: true, revenueGroup: true, itemType: true, goodsGroup: true } })
      : Promise.resolve([] as Array<{ code: string; name: string; revenueGroup: string | null; itemType: string; goodsGroup: string | null }>),
    prisma.masterDataItem.findMany({ where: { type: { in: ["REVENUE_EXPENSE_CATEGORY", "PNL_ITEM"] }, deletedAt: null }, select: { type: true, code: true, name: true, group: true } }),
  ]);
  // Hình thức bán: file mới ghi MÃ (PNL_DT_TAICHO — bắt buộc từ 23/11/2026), file cũ ghi chữ
  // ("Tại chỗ", "TẠI CHỖ"). Gom về một tên hiển thị để báo cáo không tách hai dòng cho cùng kênh.
  const channelItems = categories.filter((item) => item.type === "PNL_ITEM" && (item.group || "").toUpperCase() === "REVENUE_SOURCE");
  const channelKey = (value: string) => value.normalize("NFC").trim().toLowerCase();
  const channelLabelOf = (name: string) => name.replace(/^DT\s+/i, "").trim() || name;
  const channelByCode = new Map(channelItems.map((item) => [item.code.toUpperCase(), channelLabelOf(item.name)]));
  const channelByName = new Map(channelItems.map((item) => [channelKey(channelLabelOf(item.name)), channelLabelOf(item.name)]));
  const channelLabel = (raw: string | null) => {
    const value = (raw || "").trim();
    if (!value) return "Không ghi kênh";
    return channelByCode.get(value.toUpperCase()) || channelByName.get(channelKey(value)) || value;
  };
  const categoryName = new Map(categories.filter((category) => category.type === "REVENUE_EXPENSE_CATEGORY").map((category) => [category.code.toUpperCase(), category.name]));
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
    return {
      code,
      kind,
      branchCode: group.branchCode,
      hour: group.saleHour ?? null,
      minute: group.saleHour === null ? null : group.saleMinute ?? null,
      quantity: group._sum.productQuantity || 0,
      // Doanh thu sau thuế (gồm SVC + thuế) — khách chốt 23/11/2026, cùng số Doanh thu P&L.
      amount: group._sum.netAmount || 0,
      rows: group._count._all,
    };
  });

  const names: Record<string, string> = {};
  const itemInfo: SalesAnalysisData["itemInfo"] = {};
  for (const item of items) {
    names[item.code] = item.name;
    itemInfo[item.code] = { itemType: item.itemType, goodsGroup: normalizeGoodsGroup(item.goodsGroup) };
  }
  // Ngày lưu có thể là nửa đêm UTC (file mới) hoặc nửa đêm giờ VN (file cũ): gom theo ngày
  // nghiệp vụ VN cho khỏi xé một ngày làm hai dòng — cùng luật Sổ doanh thu.
  const visitMap = new Map<string, VisitCell>();
  let hasGuestData = false;
  for (const group of visitGroups) {
    if (group._count.guestCount > 0) hasGuestData = true;
    const date = vietnamBusinessDayKey(group.saleDate);
    const channel = channelLabel(group.channel);
    const hour = group.saleHour ?? null;
    const minute = hour === null ? null : group.saleMinute ?? null;
    const key = `${date}|${group.branchCode}|${hour ?? ""}|${minute ?? ""}|${channel}`;
    const current = visitMap.get(key) || { date, branchCode: group.branchCode, hour, minute, channel, guests: 0, bills: 0, amount: 0 };
    current.guests += group._sum.guestCount || 0;
    current.bills += group._sum.orderCount || 0;
    current.amount += group._sum.netAmount || 0;
    visitMap.set(key, current);
  }
  const [shiftConfigs, noteRows] = await Promise.all([
    loadSalesShiftConfigs(),
    prisma.salesItemNote.findMany({ where: { period, branchCode } }),
  ]);
  const notes: Record<string, SalesItemNoteValue> = {};
  for (const row of noteRows) notes[row.productCode] = { note: row.note, updatedBy: row.updatedBy, updatedAt: row.updatedAt.toISOString() };
  const branches = [...new Set(groups.map((group) => group.branchCode))].sort();
  if (branchCode !== "ALL" && !branches.includes(branchCode)) branches.push(branchCode);
  return { period, branchCode, cells, names, itemInfo, visits: [...visitMap.values()], hasGuestData, shiftConfigs, branches, notes };
}
