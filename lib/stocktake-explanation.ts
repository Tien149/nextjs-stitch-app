/**
 * GIẢI TRÌNH KIỂM KÊ (khách yêu cầu 03/10/2026) — form khách gửi:
 *   STT | Kho | Nhóm | Mã hàng | Tên hàng | ĐVT tồn | SL đầu kỳ
 *   | Nhập trong kỳ: mua, điều chuyển, khác, chế biến, cộng
 *   | Xuất trong kỳ: bán, điều chuyển, hủy, khác, chế biến, cộng
 *   | SL cuối kỳ | SL kiểm kê | Chênh lệch = kiểm kê − cuối kỳ | Giải trình
 *
 * Mỗi ĐỢT KIỂM KÊ đã duyệt của một kho (đợt duyệt gộp theo vị trí — StocktakeBatch, hoặc phiếu
 * kiểm cả kho kiểu cũ — StocktakeSession) có một bản giải trình. Kỳ = từ giờ chốt đợt kiểm kê
 * TRƯỚC của cùng kho tới giờ chốt đợt này (khách chốt); kho chưa kiểm lần nào thì từ lúc lên hệ
 * thống. SL cuối kỳ & SL kiểm kê lấy đúng số đã chốt lúc duyệt; nhập/xuất cộng phiếu kho trong
 * (đầu kỳ, giờ chốt]; SL đầu kỳ = cuối kỳ − nhập + xuất để hàng luôn khớp (phiếu điều chỉnh kiểm
 * kê không nằm trong cột nào — nó là kết quả của chính các lần kiểm).
 *
 * Số liệu được CHỤP vào StocktakeExplanation.lines — không tự đổi theo dữ liệu mới, để phần giải
 * trình đã ghi luôn khớp với con số lúc ghi (khách yêu cầu).
 */
import { Prisma } from "@prisma/custom-client";
import type { TxClient } from "@/lib/prisma";
import { STOCKTAKE_APPROVED } from "@/lib/stocktake-status";
import { latestKnownUnitCost } from "@/lib/inventory-stock";
import { netMovementsAfter } from "@/lib/stocktake-batch";

export const EXPLANATION_DRAFT = "DRAFT";
export const EXPLANATION_LOCKED = "LOCKED";

export type StocktakeSourceType = "BATCH" | "SESSION";

export type StocktakeSource = {
  sourceType: StocktakeSourceType;
  sourceId: string;
  code: string;
  branchCode: string;
  warehouseCode: string;
  cutoffAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
  lineCount: number;
  varianceRows: number;
  shortageValue: number;
  surplusValue: number;
};

export type ExplanationLine = {
  itemId: string;
  itemCode: string;
  itemName: string;
  goodsGroup: string | null;
  unit: string;
  opening: number;
  inPurchase: number;
  inTransfer: number;
  inOther: number;
  inProduction: number;
  inTotal: number;
  outSale: number;
  outTransfer: number;
  outWaste: number;
  outOther: number;
  outProduction: number;
  outTotal: number;
  closing: number;
  counted: number;
  variance: number;
  unitCost: number;
  varianceValue: number;
  explanation: string;
  /** Mã có tồn / phát sinh trong kho nhưng KHÔNG nằm trong phiếu kiểm (khách 21/10/2026: giải trình
   * gồm mọi mã của kho để tổng khớp Nhập - Xuất - Tồn). Không kiểm = không chênh lệch, không ghi phiếu. */
  notCounted?: boolean;
};

/** Một dòng phát sinh gom theo mặt hàng × loại phiếu (incoming = điều chuyển VÀO kho này). */
export type MovementRow = { itemId: string; transactionType: string; incoming: boolean; quantity: number };

export type StockCountLine = {
  itemId: string; itemCode: string; itemName: string; goodsGroup: string | null; unit: string;
  closing: number; counted: number; unitCost: number;
  notCounted?: boolean;
};

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Phần tính thuần: dòng kiểm kê + phát sinh trong kỳ -> dòng giải trình (giữ giải trình cũ theo itemId). */
export function buildExplanationLines(
  countLines: StockCountLine[],
  movements: MovementRow[],
  previousNotes: Map<string, string> = new Map(),
): ExplanationLine[] {
  const byItem = new Map<string, MovementRow[]>();
  for (const row of movements) byItem.set(row.itemId, [...(byItem.get(row.itemId) || []), row]);
  return countLines.map((line) => {
    const sums = { inPurchase: 0, inTransfer: 0, inOther: 0, inProduction: 0, outSale: 0, outTransfer: 0, outWaste: 0, outOther: 0, outProduction: 0 };
    for (const row of byItem.get(line.itemId) || []) {
      const type = row.transactionType;
      // Phiếu điều chỉnh kiểm kê là KẾT QUẢ của các lần kiểm, không phải phát sinh trong kỳ.
      if (type === "NHAP_KIEM_KE" || type === "XUAT_KIEM_KE") continue;
      if (type === "DIEU_CHUYEN") {
        if (row.incoming) sums.inTransfer += row.quantity;
        else sums.outTransfer += row.quantity;
      } else if (type === "NHAP_MUA") sums.inPurchase += row.quantity;
      else if (type === "NHAP_CHE_BIEN") sums.inProduction += row.quantity;
      else if (type.startsWith("NHAP_")) sums.inOther += row.quantity;
      else if (type === "XUAT_BAN") sums.outSale += row.quantity;
      else if (type === "XUAT_HUY") sums.outWaste += row.quantity;
      else if (type === "XUAT_CHE_BIEN") sums.outProduction += row.quantity;
      else if (type.startsWith("XUAT_")) sums.outOther += row.quantity;
    }
    const inTotal = sums.inPurchase + sums.inTransfer + sums.inOther + sums.inProduction;
    const outTotal = sums.outSale + sums.outTransfer + sums.outWaste + sums.outOther + sums.outProduction;
    const variance = line.notCounted ? 0 : line.counted - line.closing;
    return {
      itemId: line.itemId,
      itemCode: line.itemCode,
      itemName: line.itemName,
      goodsGroup: line.goodsGroup,
      unit: line.unit,
      opening: round(line.closing - inTotal + outTotal),
      inPurchase: round(sums.inPurchase),
      inTransfer: round(sums.inTransfer),
      inOther: round(sums.inOther),
      inProduction: round(sums.inProduction),
      inTotal: round(inTotal),
      outSale: round(sums.outSale),
      outTransfer: round(sums.outTransfer),
      outWaste: round(sums.outWaste),
      outOther: round(sums.outOther),
      outProduction: round(sums.outProduction),
      outTotal: round(outTotal),
      closing: round(line.closing),
      counted: line.notCounted ? 0 : round(line.counted),
      variance: round(variance),
      unitCost: line.unitCost,
      varianceValue: Math.round(variance * line.unitCost),
      explanation: previousNotes.get(line.itemId) || "",
      ...(line.notCounted ? { notCounted: true } : {}),
    };
  }).sort((a, b) =>
    // Theo nhóm hàng hóa (mã chưa có nhóm xuống cuối) rồi theo mã — giải trình đi theo nhóm.
    Number(!a.goodsGroup) - Number(!b.goodsGroup)
    || (a.goodsGroup || "").localeCompare(b.goodsGroup || "", "vi")
    || a.itemCode.localeCompare(b.itemCode));
}

/**
 * Đơn giá cho cột trị giá của Kết quả / Giải trình kiểm kê (khách 20/10/2026: phiếu kiểm cả kho hiện
 * Đơn giá 0 vì chỉ lấy giá KHAI lúc đếm). Thứ tự: giá trên phiếu điều chỉnh đã ghi sổ (-N/-X của đợt)
 * -> giá khai / giá đã chụp trên dòng -> bình quân hiện tại của kho -> giá mua gần nhất / kho khác.
 */
export async function stocktakeUnitCosts(
  db: TxClient,
  input: { sourceId: string; warehouseCode: string; lines: Array<{ itemId: string; unitCost?: number | null }> },
) {
  const itemIds = [...new Set(input.lines.map((line) => line.itemId))];
  if (itemIds.length === 0) return new Map<string, number>();
  const [posted, balances] = await Promise.all([
    db.inventoryTransactionLine.findMany({
      where: { itemId: { in: itemIds }, unitCost: { gt: 0 }, transaction: { referenceType: "STOCKTAKE", referenceId: input.sourceId, deletedAt: null } },
      select: { itemId: true, unitCost: true },
    }),
    db.inventoryBalance.findMany({ where: { warehouseCode: input.warehouseCode, itemId: { in: itemIds } }, select: { itemId: true, averageCost: true } }),
  ]);
  const postedCost = new Map(posted.map((line) => [line.itemId, line.unitCost]));
  const averageCost = new Map(balances.map((balance) => [balance.itemId, balance.averageCost]));
  const result = new Map<string, number>();
  for (const line of input.lines) {
    if (result.has(line.itemId)) continue;
    let cost = postedCost.get(line.itemId) || (line.unitCost && line.unitCost > 0 ? line.unitCost : 0) || averageCost.get(line.itemId) || 0;
    if (!(cost > 0)) cost = await latestKnownUnitCost(db, line.itemId);
    result.set(line.itemId, cost);
  }
  return result;
}

/** Số liệu chụp có khác bản mới không (bỏ qua cột giải trình) — cho nút Cập nhật số liệu. */
export function explanationNumbersChanged(before: ExplanationLine[], after: ExplanationLine[]) {
  if (before.length !== after.length) return true;
  const keys = ["opening", "inTotal", "outTotal", "closing", "counted", "variance"] as const;
  const byItem = new Map(before.map((line) => [line.itemId, line]));
  return after.some((line) => {
    const old = byItem.get(line.itemId);
    return !old || keys.some((key) => Math.abs((Number(old[key]) || 0) - line[key]) > 1e-6);
  });
}

/**
 * Các đợt kiểm kê ĐÃ DUYỆT (cả hai kiểu), mới nhất trước. `branchCodes` null = mọi cửa hàng;
 * `warehouseCodes` null = mọi kho trong phạm vi.
 */
export async function listStocktakeSources(
  db: TxClient,
  filters: { branchCodes: string[] | null; warehouseCodes: string[] | null; warehouseCode?: string; from?: Date | null; to?: Date | null },
): Promise<StocktakeSource[]> {
  const branchWhere = filters.branchCodes ? { branchCode: { in: filters.branchCodes, mode: "insensitive" as const } } : {};
  const warehouseWhere = filters.warehouseCode
    ? { warehouseCode: filters.warehouseCode }
    : filters.warehouseCodes ? { warehouseCode: { in: filters.warehouseCodes, mode: "insensitive" as const } } : {};
  const range = (field: string) => (filters.from || filters.to
    ? { [field]: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) } }
    : {});
  const [batches, sessions] = await Promise.all([
    db.stocktakeBatch.findMany({
      where: { status: "APPROVED", ...branchWhere, ...warehouseWhere, ...range("cutoffAt") },
      include: { lines: { select: { varianceQuantity: true } } },
    }),
    db.stocktakeSession.findMany({
      where: { status: STOCKTAKE_APPROVED, locationCode: null, batchId: null, deletedAt: null, ...branchWhere, ...warehouseWhere, ...range("stocktakeDate") },
      include: { lines: { select: { varianceQuantity: true, actualQuantity: true, systemQuantity: true } } },
    }),
  ]);
  // Thiếu / thừa của phiếu kiểm cả kho = trị giá phiếu -X / -N đã ghi (đợt duyệt gộp lưu sẵn trên đợt).
  const sessionDocs = sessions.length === 0 ? [] : await db.inventoryTransaction.findMany({
    where: { referenceType: "STOCKTAKE", referenceId: { in: sessions.map((session) => session.id) }, deletedAt: null, transactionType: { in: ["NHAP_KIEM_KE", "XUAT_KIEM_KE"] } },
    select: { referenceId: true, transactionType: true, lines: { select: { totalCost: true } } },
  });
  const sessionValue = (id: string, type: string) => sessionDocs
    .filter((doc) => doc.referenceId === id && doc.transactionType === type)
    .reduce((sum, doc) => sum + doc.lines.reduce((lineSum, line) => lineSum + line.totalCost, 0), 0);
  const sources: StocktakeSource[] = [
    ...batches.map((batch) => ({
      sourceType: "BATCH" as const,
      sourceId: batch.id,
      code: batch.code,
      branchCode: batch.branchCode,
      warehouseCode: batch.warehouseCode,
      cutoffAt: batch.cutoffAt,
      approvedAt: batch.approvedAt,
      approvedBy: batch.approvedBy,
      lineCount: batch.lines.length,
      varianceRows: batch.lines.filter((line) => Math.abs(line.varianceQuantity) > 1e-6).length,
      shortageValue: batch.shortageValue,
      surplusValue: batch.surplusValue,
    })),
    ...sessions.map((session) => ({
      sourceType: "SESSION" as const,
      sourceId: session.id,
      code: session.code,
      branchCode: session.branchCode,
      warehouseCode: session.warehouseCode,
      cutoffAt: session.stocktakeDate,
      approvedAt: session.approvedAt,
      approvedBy: session.approvedBy,
      lineCount: session.lines.length,
      varianceRows: session.lines.filter((line) => Math.abs(line.actualQuantity - line.systemQuantity) > 1e-6).length,
      shortageValue: -Math.round(sessionValue(session.id, "XUAT_KIEM_KE")),
      surplusValue: Math.round(sessionValue(session.id, "NHAP_KIEM_KE")),
    })),
  ];
  return sources.sort((a, b) => b.cutoffAt.getTime() - a.cutoffAt.getTime());
}

/** Giờ chốt đợt kiểm kê đã duyệt gần nhất TRƯỚC `cutoffAt` của cùng kho (null = chưa kiểm lần nào). */
export async function previousCutoffOf(db: TxClient, warehouseCode: string, cutoffAt: Date) {
  const [batch, session] = await Promise.all([
    db.stocktakeBatch.findFirst({ where: { warehouseCode, status: "APPROVED", cutoffAt: { lt: cutoffAt } }, orderBy: { cutoffAt: "desc" }, select: { cutoffAt: true } }),
    db.stocktakeSession.findFirst({
      where: { warehouseCode, status: STOCKTAKE_APPROVED, locationCode: null, batchId: null, deletedAt: null, stocktakeDate: { lt: cutoffAt } },
      orderBy: { stocktakeDate: "desc" },
      select: { stocktakeDate: true },
    }),
  ]);
  const candidates = [batch?.cutoffAt, session?.stocktakeDate].filter((value): value is Date => Boolean(value));
  return candidates.length ? new Date(Math.max(...candidates.map((value) => value.getTime()))) : null;
}

/**
 * Nhập − xuất CHẾ BIẾN của lần rã phần kiểm dư BTP (phiếu RA mang referenceId = phiếu kiểm kê): rã
 * sau khi duyệt nên số sổ sách lưu lúc duyệt chưa có chúng. Cộng vào sổ sách để Giải trình / Kết
 * quả theo tồn sau rã: BTP dư hết chênh (đã chế biến), nguyên liệu chỉ còn hao hụt thật. Phiếu
 * điều chỉnh (-N/-X, phiếu bù BN/BX) là kết quả kiểm kê nên không tính.
 */
async function explodedSurplusNet(db: TxClient, stocktakeId: string) {
  const rows = await db.$queryRaw<Array<{ itemId: string; net: number }>>(Prisma.sql`
    SELECT l."itemId", SUM(CASE WHEN t."transactionType" = 'NHAP_CHE_BIEN' THEN l."quantity" ELSE -l."quantity" END)::float8 AS net
    FROM "InventoryTransactionLine" l
    JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
    WHERE t."deletedAt" IS NULL AND t."referenceType" = 'PRODUCTION' AND t."referenceId" = ${stocktakeId}
      AND t."transactionType" IN ('NHAP_CHE_BIEN', 'XUAT_CHE_BIEN')
    GROUP BY 1
  `);
  return new Map(rows.map((row) => [row.itemId, row.net]));
}

/** Nguồn đợt kiểm kê đang có hiệu lực (đã duyệt) — null nếu đã mở lại / không còn. */
export async function loadStocktakeSource(db: TxClient, sourceType: StocktakeSourceType, sourceId: string) {
  if (sourceType === "BATCH") {
    const batch = await db.stocktakeBatch.findUnique({
      where: { id: sourceId },
      include: { lines: { include: { item: { select: { id: true, code: true, name: true, unit: true, goodsGroup: true } } } } },
    });
    if (!batch) return null;
    return {
      status: batch.status === "APPROVED" ? STOCKTAKE_APPROVED : batch.status,
      code: batch.code, branchCode: batch.branchCode, warehouseCode: batch.warehouseCode,
      cutoffAt: batch.cutoffAt, approvedAt: batch.approvedAt,
      countLines: batch.lines.map((line) => ({
        itemId: line.itemId, itemCode: line.item.code, itemName: line.item.name, goodsGroup: line.item.goodsGroup, unit: line.item.unit,
        closing: line.bookQuantity, counted: line.countedQuantity, unitCost: line.unitCost,
      })),
    };
  }
  const session = await db.stocktakeSession.findUnique({
    where: { id: sourceId },
    include: { lines: { include: { item: { select: { id: true, code: true, name: true, unit: true, goodsGroup: true } } } } },
  });
  if (!session || session.deletedAt) return null;
  const produced = await explodedSurplusNet(db, session.id);
  return {
    status: session.status,
    code: session.code, branchCode: session.branchCode, warehouseCode: session.warehouseCode,
    cutoffAt: session.stocktakeDate, approvedAt: session.approvedAt,
    countLines: session.lines.map((line) => ({
      itemId: line.itemId, itemCode: line.item.code, itemName: line.item.name, goodsGroup: line.item.goodsGroup, unit: line.item.unit,
      closing: line.systemQuantity + (produced.get(line.itemId) || 0), counted: line.actualQuantity, unitCost: line.unitCost || 0,
    })),
  };
}

/** Phát sinh trong (from, to] của kho, gom mặt hàng × loại phiếu — chỉ cho các mặt hàng truyền vào. */
export async function loadPeriodMovements(db: TxClient, warehouseCode: string, from: Date | null, to: Date, itemIds: string[]): Promise<MovementRow[]> {
  if (itemIds.length === 0) return [];
  const rows = await db.$queryRaw<Array<{ itemId: string; transactionType: string; incoming: boolean; quantity: number }>>(Prisma.sql`
    SELECT l."itemId", t."transactionType",
           (t."transactionType" = 'DIEU_CHUYEN' AND t."toWarehouseCode" = ${warehouseCode}) AS incoming,
           SUM(l."quantity")::float8 AS quantity
    FROM "InventoryTransactionLine" l
    JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
    WHERE t."deletedAt" IS NULL
      AND (t."warehouseCode" = ${warehouseCode} OR (t."transactionType" = 'DIEU_CHUYEN' AND t."toWarehouseCode" = ${warehouseCode}))
      AND t."transactionDate" <= ${to}
      ${from ? Prisma.sql`AND t."transactionDate" > ${from}` : Prisma.empty}
      AND l."itemId" IN (${Prisma.join(itemIds)})
    GROUP BY 1, 2, 3
  `);
  return rows;
}

/**
 * Mã của kho KHÔNG có trong phiếu kiểm: còn tồn tại giờ chốt hoặc có phát sinh trong kỳ. Tồn cuối =
 * tồn hiện tại − phát sinh sau giờ chốt (cùng cách Nhập - Xuất - Tồn lùi tồn).
 */
async function loadUncountedLines(db: TxClient, warehouseCode: string, from: Date | null, to: Date, countedIds: Set<string>): Promise<StockCountLine[]> {
  const [balances, laterNet, moved] = await Promise.all([
    db.inventoryBalance.findMany({ where: { warehouseCode }, select: { itemId: true, quantity: true } }),
    netMovementsAfter(db as unknown as Parameters<typeof netMovementsAfter>[0], warehouseCode, to),
    db.$queryRaw<Array<{ itemId: string }>>(Prisma.sql`
      SELECT DISTINCT l."itemId"
      FROM "InventoryTransactionLine" l
      JOIN "InventoryTransaction" t ON t."id" = l."transactionId"
      WHERE t."deletedAt" IS NULL
        AND (t."warehouseCode" = ${warehouseCode} OR (t."transactionType" = 'DIEU_CHUYEN' AND t."toWarehouseCode" = ${warehouseCode}))
        AND t."transactionDate" <= ${to}
        ${from ? Prisma.sql`AND t."transactionDate" > ${from}` : Prisma.empty}
    `),
  ]);
  const closing = new Map<string, number>();
  for (const balance of balances) closing.set(balance.itemId, balance.quantity - (laterNet.get(balance.itemId) || 0));
  for (const [itemId, net] of laterNet) if (!closing.has(itemId)) closing.set(itemId, -net);
  const movedIds = new Set(moved.map((row) => row.itemId));
  const ids = [...new Set([...closing.keys(), ...movedIds])]
    .filter((itemId) => !countedIds.has(itemId) && (movedIds.has(itemId) || Math.abs(closing.get(itemId) || 0) > 1e-6));
  if (ids.length === 0) return [];
  const items = await db.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, unit: true, goodsGroup: true } });
  return items.map((item) => ({
    itemId: item.id, itemCode: item.code, itemName: item.name, goodsGroup: item.goodsGroup, unit: item.unit,
    closing: closing.get(item.id) || 0, counted: 0, unitCost: 0, notCounted: true,
  }));
}

/** Chụp số liệu giải trình cho một đợt (giữ phần giải trình cũ theo mã hàng nếu có). */
export async function snapshotExplanation(db: TxClient, sourceType: StocktakeSourceType, sourceId: string, previousNotes: Map<string, string> = new Map()) {
  const source = await loadStocktakeSource(db, sourceType, sourceId);
  if (!source) throw new Error("BUSINESS:Không tìm thấy đợt kiểm kê");
  if (source.status !== STOCKTAKE_APPROVED) throw new Error(`BUSINESS:Đợt ${source.code} chưa duyệt (hoặc đã mở lại) — duyệt xong mới lập / cập nhật giải trình được.`);
  const periodFrom = await previousCutoffOf(db, source.warehouseCode, source.cutoffAt);
  // Gồm cả mã kho có mà phiếu không đếm, để tổng giải trình = tồn của cả kho.
  const uncounted = await loadUncountedLines(db, source.warehouseCode, periodFrom, source.cutoffAt, new Set(source.countLines.map((line) => line.itemId)));
  const allLines = [...source.countLines, ...uncounted];
  const movements = await loadPeriodMovements(db, source.warehouseCode, periodFrom, source.cutoffAt, allLines.map((line) => line.itemId));
  return {
    source,
    periodFrom,
    lines: buildExplanationLines(allLines, movements, previousNotes),
  };
}
