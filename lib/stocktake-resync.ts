import { prisma, type TxClient } from "@/lib/prisma";
import { isPeriodLocked } from "@/lib/phase3";
import { latestKnownUnitCost, postInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { netMovementsAfter } from "@/lib/stocktake-batch";
import { EXPLOSION_PENDING } from "@/lib/explosion-sources";
import { STOCKTAKE_APPROVED } from "@/lib/stocktake-status";
import { EXPLANATION_DRAFT, EXPLANATION_LOCKED, snapshotExplanation, type ExplanationLine } from "@/lib/stocktake-explanation";

/**
 * Chênh lệch kiểm kê CHỈ GHI NHẬN KHI CHỐT GIẢI TRÌNH (khách chốt 21/10/2026: "Duyệt là duyệt số
 * kiểm kê chứ chưa duyệt kết quả chênh lệch — giải trình chưa chốt thì chênh lệch cũng chưa được ghi
 * nhận"; bổ sung phiếu trước giờ chốt thì tồn hệ thống phải cập nhật lại).
 *
 *  - Duyệt: chốt SỐ ĐẾM (có kiểm dư bán thành phẩm để rã BOM), KHÔNG sinh phiếu -N / -X.
 *  - Trước khi chốt: sổ sách tại giờ chốt tính lại từ dữ liệu hiện tại (`resyncStocktake`) — số trên
 *    phiếu, Giải trình, Kết quả luôn là số sống; phiếu -N/-X còn sót (luật cũ) bị gỡ.
 *  - Chốt giải trình (`postStocktakeAdjustments`): ghi -N/-X = số đếm − tồn hệ thống tại giờ chốt,
 *    vào giá vốn. Mở chốt (`unpostStocktakeAdjustments`) gỡ ra.
 *
 * Sổ sách hiển thị = tồn tại giờ chốt bỏ phần điều chỉnh của chính phiếu và phần rã kiểm dư của nó
 * (Giải trình cộng lại phần chế biến đó vào cột nhập / xuất chế biến).
 * Bỏ qua: phiếu theo vị trí / đợt duyệt gộp, kỳ đã khoá.
 */
export type ResyncResult = { code: string; changed: boolean; skipped?: string; documents?: string[]; date: Date; branchCode: string };

const EPS = 0.000001;
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type SessionWithLines = NonNullable<Awaited<ReturnType<typeof loadSession>>>;

function loadSession(sessionId: string) {
  return prisma.stocktakeSession.findUnique({ where: { id: sessionId }, include: { lines: { include: { item: true } } } });
}

/** Tồn hệ thống tại giờ chốt của từng dòng + cập nhật sổ sách / chênh lệch trên dòng. */
async function liveBook(tx: Tx, session: SessionWithLines) {
  const db = tx as unknown as TxClient;
  const itemIds = session.lines.map((line) => line.itemId);
  const [balances, laterNet, ownDocs, explosionDocs] = await Promise.all([
    tx.inventoryBalance.findMany({ where: { warehouseCode: session.warehouseCode, itemId: { in: itemIds } } }),
    netMovementsAfter(db, session.warehouseCode, session.stocktakeDate),
    tx.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: session.id, deletedAt: null }, include: { lines: true } }),
    tx.inventoryTransaction.findMany({ where: { referenceType: "PRODUCTION", referenceId: session.id, deletedAt: null }, include: { lines: true } }),
  ]);
  const net = (docs: typeof ownDocs) => {
    const map = new Map<string, number>();
    for (const doc of docs) for (const line of doc.lines) {
      map.set(line.itemId, (map.get(line.itemId) || 0) + (doc.transactionType.startsWith("NHAP_") ? line.quantity : -line.quantity));
    }
    return map;
  };
  const ownAdj = net(ownDocs);
  const explosionNet = net(explosionDocs);
  const balanceOf = new Map(balances.map((balance) => [balance.itemId, balance]));
  const rows = [];
  let linesChanged = false;
  for (const line of session.lines) {
    const atCutoff = (balanceOf.get(line.itemId)?.quantity || 0) - (laterNet.get(line.itemId) || 0);
    /** Tồn hệ thống tại giờ chốt KHÔNG kể điều chỉnh kiểm kê của chính phiếu (đã gồm phần rã kiểm dư). */
    const systemStock = atCutoff - (ownAdj.get(line.itemId) || 0);
    const book = systemStock - (explosionNet.get(line.itemId) || 0);
    const variance = line.actualQuantity - book;
    if (Math.abs(line.systemQuantity - book) > EPS || Math.abs(line.varianceQuantity - variance) > EPS) {
      linesChanged = true;
      await tx.stocktakeLine.update({ where: { id: line.id }, data: { systemQuantity: book, varianceQuantity: variance } });
    }
    rows.push({ line, systemStock, averageCost: balanceOf.get(line.itemId)?.averageCost || 0 });
  }
  return { rows, ownDocs, linesChanged };
}

async function removeOwnAdjustments(tx: Tx, docs: Array<{ id: string; code: string; transactionType: string; warehouseCode: string; toWarehouseCode: string | null; lines: Array<{ itemId: string; quantity: number; totalCost: number }> }>, actor: string) {
  for (const doc of docs) {
    await reverseStockEffect(tx as unknown as TxClient, doc);
    await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedBy: actor } });
  }
  if (docs.length > 0) await tx.journalEntry.deleteMany({ where: { sourceType: "INVENTORY_ISSUE", sourceId: { in: docs.map((doc) => doc.id) } } });
}

async function refreshDraftExplanation(sessionId: string, actor: string) {
  const explanation = await prisma.stocktakeExplanation.findFirst({ where: { sourceType: "SESSION", sourceId: sessionId } });
  if (!explanation || explanation.status !== EXPLANATION_DRAFT) return;
  const notes = new Map(((Array.isArray(explanation.lines) ? explanation.lines : []) as unknown as ExplanationLine[]).map((line) => [line.itemId, line.explanation || ""]));
  const snapshot = await snapshotExplanation(prisma as unknown as TxClient, "SESSION", sessionId, notes);
  await prisma.stocktakeExplanation.update({
    where: { id: explanation.id },
    data: { lines: snapshot.lines, periodFrom: snapshot.periodFrom, periodTo: snapshot.source.cutoffAt, sourceApprovedAt: snapshot.source.approvedAt, snapshotBy: actor, snapshotAt: new Date() },
  });
}

async function guard(session: SessionWithLines | null) {
  if (!session || session.deletedAt) throw new Error("BUSINESS:Không tìm thấy phiếu kiểm kê");
  if (session.status !== STOCKTAKE_APPROVED) return "chưa duyệt";
  if (session.locationCode || session.batchId) return "phiếu theo vị trí (duyệt gộp)";
  if (await isPeriodLocked(session.stocktakeDate, session.branchCode)) return "kỳ đã khoá";
  return null;
}

/** Phiếu đã duyệt, giải trình CHƯA chốt: số sống theo sổ mới nhất, không giữ phiếu điều chỉnh nào. */
export async function resyncStocktake(sessionId: string, actor: string): Promise<ResyncResult> {
  const session = await loadSession(sessionId);
  const skipped = await guard(session);
  const base = { code: session!.code, date: session!.stocktakeDate, branchCode: session!.branchCode };
  if (skipped) return { ...base, changed: false, skipped };
  const explanation = await prisma.stocktakeExplanation.findFirst({ where: { sourceType: "SESSION", sourceId: sessionId }, select: { status: true } });
  if (explanation?.status === EXPLANATION_LOCKED) return { ...base, changed: false, skipped: "giải trình đã chốt" };
  const result = await prisma.$transaction(async (tx) => {
    const { ownDocs, linesChanged } = await liveBook(tx, session!);
    await removeOwnAdjustments(tx, ownDocs, actor);
    return { changed: linesChanged || ownDocs.length > 0, documents: [] as string[], removed: ownDocs.length > 0 };
  }, { timeout: 5 * 60 * 1000, maxWait: 30000 });
  await refreshDraftExplanation(sessionId, actor);
  return { ...base, changed: result.changed, documents: result.documents };
}

/** Chốt giải trình: ghi phiếu -N / -X = số đếm − tồn hệ thống tại giờ chốt (vào giá vốn). */
export async function postStocktakeAdjustments(sessionId: string, actor: string): Promise<ResyncResult> {
  const session = await loadSession(sessionId);
  const skipped = await guard(session);
  if (skipped) throw new Error(`BUSINESS:Không ghi nhận được chênh lệch kiểm kê ${session!.code}: ${skipped}.`);
  if (session!.explosionStatus === EXPLOSION_PENDING) {
    throw new Error(`BUSINESS:Phiếu ${session!.code} còn phần kiểm dư bán thành phẩm CHỜ RÃ — rã ở tab Chế biến (Chỉ rã phần còn chờ) trước khi chốt, để nguyên liệu làm ra phần dư được trừ đúng.`);
  }
  const documents = await prisma.$transaction(async (tx) => {
    const db = tx as unknown as TxClient;
    const { rows, ownDocs } = await liveBook(tx, session!);
    await removeOwnAdjustments(tx, ownDocs, actor);
    const inbound = [];
    const outbound = [];
    for (const { line, systemStock, averageCost } of rows) {
      const adjustment = line.actualQuantity - systemStock;
      if (adjustment > EPS) {
        let unitCost = averageCost > 0 ? averageCost : line.unitCost || 0;
        if (!(unitCost > 0)) unitCost = await latestKnownUnitCost(db, line.itemId, session!.warehouseCode);
        inbound.push({ itemId: line.itemId, inputQuantity: adjustment, inputUnitCode: line.item.unit, inputUnitCost: unitCost });
      } else if (adjustment < -EPS) {
        outbound.push({ itemId: line.itemId, inputQuantity: -adjustment, inputUnitCode: line.item.unit, inputUnitCost: 0 });
      }
    }
    const freeCode = async (prefix: string) => {
      const taken = new Set((await tx.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "InventoryTransaction" WHERE "code" = ${prefix} OR "code" LIKE ${`${prefix}-%`}`).map((row) => row.code));
      if (!taken.has(prefix)) return prefix;
      let suffix = 2;
      while (taken.has(`${prefix}-${suffix}`)) suffix += 1;
      return `${prefix}-${suffix}`;
    };
    const header = {
      transactionDate: session!.stocktakeDate, branchCode: session!.branchCode, warehouseCode: session!.warehouseCode,
      referenceType: "STOCKTAKE", referenceId: session!.id, referenceCode: session!.code,
      note: `Chênh lệch kiểm kê ${session!.code} (chốt giải trình)`, createdBy: actor,
    };
    const codes: string[] = [];
    if (inbound.length > 0) codes.push((await postInventoryTransaction(db, { ...header, code: await freeCode(`${session!.code}-N`), transactionType: "NHAP_KIEM_KE", lines: inbound })).code);
    if (outbound.length > 0) codes.push((await postInventoryTransaction(db, { ...header, code: await freeCode(`${session!.code}-X`), transactionType: "XUAT_KIEM_KE", lines: outbound })).code);
    return codes;
  }, { timeout: 5 * 60 * 1000, maxWait: 30000 });
  return { code: session!.code, date: session!.stocktakeDate, branchCode: session!.branchCode, changed: true, documents };
}

/** Mở chốt giải trình: gỡ phiếu -N / -X, chênh lệch về lại số sống. */
export async function unpostStocktakeAdjustments(sessionId: string, actor: string): Promise<ResyncResult> {
  const session = await loadSession(sessionId);
  const skipped = await guard(session);
  const base = { code: session!.code, date: session!.stocktakeDate, branchCode: session!.branchCode };
  if (skipped) return { ...base, changed: false, skipped };
  const removed = await prisma.$transaction(async (tx) => {
    const docs = await tx.inventoryTransaction.findMany({ where: { referenceType: "STOCKTAKE", referenceId: sessionId, deletedAt: null }, include: { lines: true } });
    await removeOwnAdjustments(tx, docs, actor);
    return docs.map((doc) => doc.code);
  }, { timeout: 5 * 60 * 1000, maxWait: 30000 });
  return { ...base, changed: removed.length > 0, documents: removed };
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
