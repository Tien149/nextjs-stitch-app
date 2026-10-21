import { prisma, type TxClient } from "@/lib/prisma";
import { isPeriodLocked } from "@/lib/phase3";
import { latestKnownUnitCost, postInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { netMovementsAfter } from "@/lib/stocktake-batch";
import { EXPLOSION_PENDING, semiFinishedWithRecipeChecker } from "@/lib/explosion-sources";
import { STOCKTAKE_APPROVED } from "@/lib/stocktake-status";
import { EXPLANATION_DRAFT, EXPLANATION_LOCKED, snapshotExplanation, type ExplanationLine } from "@/lib/stocktake-explanation";

/**
 * Chênh lệch kiểm kê TỰ CẬP NHẬT tới khi Chốt (khách chốt 21/10/2026): "Duyệt là duyệt số kiểm kê
 * chứ chưa duyệt kết quả chênh lệch — chưa chốt thì bổ sung phiếu trước giờ chốt, tồn vẫn phải cập
 * nhật lại". Duyệt vẫn cần để có số kiểm dư bán thành phẩm mang đi rã BOM.
 *
 * Với một phiếu kiểm cả kho đã duyệt mà bản giải trình CHƯA chốt: sổ sách tại giờ chốt tính lại từ dữ
 * liệu hiện tại (tồn − phát sinh sau giờ chốt, bỏ phần điều chỉnh của chính phiếu này và phần rã kiểm
 * dư của nó), rồi phiếu -N / -X được ghi lại để tồn tại giờ chốt đúng bằng số đếm. Phần kiểm dư bán
 * thành phẩm đang CHỜ rã thì không nhập kiểm kê (lần rã sẽ chế biến nó). Giải trình nháp chụp lại số.
 *
 * Bỏ qua: phiếu theo vị trí / đợt duyệt gộp, giải trình đã chốt, kỳ đã khoá.
 */
export type ResyncResult = { code: string; changed: boolean; skipped?: string; documents?: string[]; date: Date; branchCode: string };

const EPS = 0.000001;

export async function resyncStocktake(sessionId: string, actor: string): Promise<ResyncResult> {
  const session = await prisma.stocktakeSession.findUnique({ where: { id: sessionId }, include: { lines: { include: { item: true } } } });
  if (!session || session.deletedAt) throw new Error("BUSINESS:Không tìm thấy phiếu kiểm kê");
  const base = { code: session.code, date: session.stocktakeDate, branchCode: session.branchCode };
  if (session.status !== STOCKTAKE_APPROVED) return { ...base, changed: false, skipped: "chưa duyệt" };
  if (session.locationCode || session.batchId) return { ...base, changed: false, skipped: "phiếu theo vị trí (duyệt gộp)" };
  const explanation = await prisma.stocktakeExplanation.findFirst({ where: { sourceType: "SESSION", sourceId: session.id } });
  if (explanation?.status === EXPLANATION_LOCKED) return { ...base, changed: false, skipped: "giải trình đã chốt" };
  if (await isPeriodLocked(session.stocktakeDate, session.branchCode)) return { ...base, changed: false, skipped: "kỳ đã khoá" };

  const result = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as TxClient;
    const warehouseCode = session.warehouseCode;
    const cutoff = session.stocktakeDate;
    const itemIds = session.lines.map((line) => line.itemId);
    const [balances, laterNet, ownDocs, explosionDocs] = await Promise.all([
      tx.inventoryBalance.findMany({ where: { warehouseCode, itemId: { in: itemIds } } }),
      netMovementsAfter(db, warehouseCode, cutoff),
      tx.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: session.id, deletedAt: null }, include: { lines: true } }),
      tx.inventoryTransaction.findMany({ where: { referenceType: "PRODUCTION", referenceId: session.id, deletedAt: null }, include: { lines: true } }),
    ]);
    const signed = (type: string, quantity: number) => (type.startsWith("NHAP_") ? quantity : -quantity);
    const sumBy = (docs: typeof ownDocs, filter: (type: string) => boolean) => {
      const map = new Map<string, number>();
      for (const doc of docs) {
        if (!filter(doc.transactionType)) continue;
        for (const line of doc.lines) map.set(line.itemId, (map.get(line.itemId) || 0) + signed(doc.transactionType, line.quantity));
      }
      return map;
    };
    const ownAdj = sumBy(ownDocs, () => true);
    const explosionNet = sumBy(explosionDocs, () => true);
    const balanceOf = new Map(balances.map((balance) => [balance.itemId, balance]));
    const isExplodable = await semiFinishedWithRecipeChecker(db, session.branchCode);
    const pending = session.explosionStatus === EXPLOSION_PENDING;

    const inbound: Array<{ itemId: string; inputQuantity: number; inputUnitCode: string; inputUnitCost: number }> = [];
    const outbound: Array<{ itemId: string; inputQuantity: number; inputUnitCode: string; inputUnitCost: number }> = [];
    let changed = false;
    for (const line of session.lines) {
      const atCutoff = (balanceOf.get(line.itemId)?.quantity || 0) - (laterNet.get(line.itemId) || 0);
      const withoutOwnAdj = atCutoff - (ownAdj.get(line.itemId) || 0);
      // Sổ sách "trước kiểm kê": bỏ cả phần rã kiểm dư của chính phiếu (chế biến + bù nguyên liệu).
      const book = withoutOwnAdj - (explosionNet.get(line.itemId) || 0);
      const variance = line.actualQuantity - book;
      // Kiểm dư BTP đang chờ rã: tồn tại giờ chốt giữ ở sổ sách, lần rã sẽ nhập phần dư.
      const deferred = pending && variance > EPS && isExplodable(line.item);
      const target = deferred ? withoutOwnAdj - (explosionNet.get(line.itemId) || 0) : line.actualQuantity;
      const adjustment = target - withoutOwnAdj;
      if (Math.abs(line.systemQuantity - book) > EPS || Math.abs(line.varianceQuantity - variance) > EPS) {
        await tx.stocktakeLine.update({ where: { id: line.id }, data: { systemQuantity: book, varianceQuantity: variance } });
      }
      if (Math.abs(adjustment - (ownAdj.get(line.itemId) || 0)) > EPS) changed = true;
      if (adjustment > EPS) {
        const balance = balanceOf.get(line.itemId);
        let unitCost = (balance?.averageCost || 0) > 0 ? balance?.averageCost || 0 : line.unitCost || 0;
        if (!(unitCost > 0)) unitCost = await latestKnownUnitCost(db, line.itemId, warehouseCode);
        inbound.push({ itemId: line.itemId, inputQuantity: adjustment, inputUnitCode: line.item.unit, inputUnitCost: unitCost });
      } else if (adjustment < -EPS) {
        outbound.push({ itemId: line.itemId, inputQuantity: -adjustment, inputUnitCode: line.item.unit, inputUnitCost: 0 });
      }
    }
    if (!changed) return { changed: false, documents: [] as string[] };

    // Ghi lại phiếu điều chỉnh: hoàn kho + xoá mềm phiếu cũ, lập phiếu mới theo số hiện tại.
    for (const doc of ownDocs) {
      await reverseStockEffect(db, doc);
      await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedBy: actor } });
    }
    if (ownDocs.length > 0) await tx.journalEntry.deleteMany({ where: { sourceType: "INVENTORY_ISSUE", sourceId: { in: ownDocs.map((doc) => doc.id) } } });
    const freeCode = async (prefix: string) => {
      const taken = new Set((await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "InventoryTransaction" WHERE "code" = ${prefix} OR "code" LIKE ${`${prefix}-%`}`).map((row) => row.code));
      if (!taken.has(prefix)) return prefix;
      let suffix = 2;
      while (taken.has(`${prefix}-${suffix}`)) suffix += 1;
      return `${prefix}-${suffix}`;
    };
    const header = {
      transactionDate: cutoff, branchCode: session.branchCode, warehouseCode,
      referenceType: "STOCKTAKE", referenceId: session.id, referenceCode: session.code,
      note: `Cập nhật chênh lệch kiểm kê ${session.code} theo sổ sách hiện tại`, createdBy: actor,
    };
    const documents: string[] = [];
    if (inbound.length > 0) documents.push((await postInventoryTransaction(db, { ...header, code: await freeCode(`${session.code}-N`), transactionType: "NHAP_KIEM_KE", lines: inbound })).code);
    if (outbound.length > 0) documents.push((await postInventoryTransaction(db, { ...header, code: await freeCode(`${session.code}-X`), transactionType: "XUAT_KIEM_KE", lines: outbound })).code);
    return { changed: true, documents };
  }, { timeout: 5 * 60 * 1000, maxWait: 30000 });

  // Giải trình nháp chụp lại số mới (giữ phần giải trình đã gõ theo mã hàng).
  if (explanation && explanation.status === EXPLANATION_DRAFT) {
    const notes = new Map(((Array.isArray(explanation.lines) ? explanation.lines : []) as unknown as ExplanationLine[]).map((line) => [line.itemId, line.explanation || ""]));
    const snapshot = await snapshotExplanation(prisma as unknown as TxClient, "SESSION", session.id, notes);
    await prisma.stocktakeExplanation.update({
      where: { id: explanation.id },
      data: { lines: snapshot.lines, periodFrom: snapshot.periodFrom, periodTo: snapshot.source.cutoffAt, sourceApprovedAt: snapshot.source.approvedAt, snapshotBy: actor, snapshotAt: new Date() },
    });
  }
  return { ...base, ...result };
}

/**
 * Đồng bộ mọi phiếu kiểm cả kho đã duyệt, chưa chốt, của cửa hàng (ALL = mọi cửa hàng) có giờ chốt
 * từ `from` trở đi — gọi sau khi rã / hoàn tác rã / import phiếu kho, trước khi tính giá vốn tháng.
 */
export async function resyncOpenStocktakes(input: { branchCode?: string | null; from?: Date | null; ids?: string[] }, actor: string) {
  const sessions = await prisma.stocktakeSession.findMany({
    where: {
      status: STOCKTAKE_APPROVED, deletedAt: null, locationCode: null, batchId: null,
      ...(input.ids ? { id: { in: input.ids } } : {}),
      ...(input.branchCode && input.branchCode !== "ALL" ? { branchCode: input.branchCode } : {}),
      ...(input.from ? { stocktakeDate: { gte: input.from } } : {}),
    },
    select: { id: true },
    orderBy: { stocktakeDate: "asc" },
  });
  const results: ResyncResult[] = [];
  for (const session of sessions) {
    try {
      results.push(await resyncStocktake(session.id, actor));
    } catch (error) {
      console.error("Không đồng bộ được chênh lệch kiểm kê:", error);
    }
  }
  return results;
}
