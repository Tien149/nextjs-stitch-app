/**
 * Nguồn rã BOM ngoài doanh thu (khách chốt 28/09/2026). Bán thành phẩm (BTP) CÓ ĐỊNH LƯỢNG chỉ
 * sinh ra từ chế biến, nên ngoài phần dùng cho món bán còn hai chỗ phải rã ra nguyên liệu:
 *   - ĐIỀU CHUYỂN BTP đi kho khác: kho nguồn chế biến phần chuyển đi (lấy tồn trước);
 *   - HUỶ / XUẤT TEST MÓN / XUẤT KHÁC BTP (khách báo 30/09/2026: kho bar âm vì huỷ BTP mà BTP
 *     chưa từng được chế biến): kho xuất chế biến phần thiếu, cùng luật với điều chuyển;
 *   - KIỂM KÊ đếm DƯ BTP (thực tế > sổ sách): phần dư là hàng đã chế biến mà chưa rã, nên rã ra
 *     nguyên liệu (trừ NVL, nhập BTP có giá vốn) thay vì phiếu nhập kiểm kê không có nguồn gốc.
 *     Kiểm THIẾU vẫn xuất kiểm kê như cũ.
 * Cả hai không sinh phiếu ngay mà vào hàng chờ (`explosionStatus` = PENDING), bấm Rã ở tab Chế
 * biến mới sinh phiếu cùng lần rã doanh thu — hoàn tác / rã lại đi theo cả cụm RA-... như doanh thu.
 */
import type { TxClient } from "@/lib/prisma";

export const EXPLOSION_PENDING = "PENDING";
const POSTED_PREFIX = "POSTED:";

/**
 * Loại phiếu XUẤT mà bán thành phẩm có định lượng trên phiếu phải được rã (kho xuất chế biến
 * phần chuyển / huỷ đi). Xuất chế biến / xuất bán / xuất kiểm kê do chính lần rã & kiểm kê sinh
 * ra nên không nằm đây.
 */
export const EXPLOSION_ISSUE_TYPES = ["DIEU_CHUYEN", "XUAT_HUY", "XUAT_TEST_MON", "XUAT_KHAC"];

export function isExplosionIssueType(transactionType: string | null | undefined) {
  return EXPLOSION_ISSUE_TYPES.includes(transactionType || "");
}

export function explosionPostedStatus(runCode: string) {
  return `${POSTED_PREFIX}${runCode}`;
}

/** Mã lần rã (RA-...) của phiếu đã rã; chưa rã / không cần rã thì null. */
export function explodedRunOf(status: string | null | undefined) {
  return status && status.startsWith(POSTED_PREFIX) ? status.slice(POSTED_PREFIX.length) : null;
}

type RecipeScopeClient = Pick<TxClient, "recipe">;

/**
 * Hàm kiểm "BTP có định lượng dùng được ở cửa hàng này": nhóm SEMI_FINISHED và có ít nhất một
 * phiên bản định lượng dùng chung hoặc của chính cửa hàng (cùng phạm vi với pickRecipeForDate —
 * bản riêng của cửa hàng khác không tính). BTP không có định lượng thì không rã được, đi đường
 * nhập/xuất kho thường như cũ.
 */
export async function semiFinishedWithRecipeChecker(tx: RecipeScopeClient, branchCode: string) {
  const branch = (branchCode || "").trim().toUpperCase();
  const recipes = await tx.recipe.findMany({ where: { deletedAt: null }, select: { productCode: true, branchCode: true } });
  const codes = new Set<string>();
  for (const recipe of recipes) {
    const recipeBranch = (recipe.branchCode || "").trim().toUpperCase();
    if (!recipeBranch || recipeBranch === "ALL" || recipeBranch === branch) codes.add(recipe.productCode.toUpperCase());
  }
  return (item: { code: string; itemType: string }) => item.itemType === "SEMI_FINISHED" && codes.has(item.code.toUpperCase());
}

/**
 * Đặt lại trạng thái chờ rã của một phiếu điều chuyển / huỷ / xuất khác theo dòng hàng hiện tại:
 * có BTP có định lượng thì PENDING, không thì null. Phiếu đã rã thì giữ nguyên (sửa/xoá phiếu đã
 * rã bị chặn ở route — phải hoàn tác lần rã trước).
 */
export async function refreshTransferExplosionStatus(tx: TxClient, transactionId: string) {
  const transaction = await tx.inventoryTransaction.findUnique({
    where: { id: transactionId },
    select: { transactionType: true, branchCode: true, explosionStatus: true, lines: { select: { item: { select: { code: true, itemType: true } } } } },
  });
  if (!transaction || !isExplosionIssueType(transaction.transactionType)) return null;
  if (explodedRunOf(transaction.explosionStatus)) return transaction.explosionStatus;
  const isExplodable = await semiFinishedWithRecipeChecker(tx, transaction.branchCode);
  const next = transaction.lines.some((line) => isExplodable(line.item)) ? EXPLOSION_PENDING : null;
  if (next !== transaction.explosionStatus) {
    await tx.inventoryTransaction.update({ where: { id: transactionId }, data: { explosionStatus: next } });
  }
  return next;
}

/**
 * Hoàn tác / rã lại một lần rã: trả các phiếu điều chuyển + kiểm kê của lần đó về hàng chờ, và
 * cho biết đó là những phiếu nào để rã lại đúng chúng (cùng ý với rowIds của doanh thu).
 */
export async function releaseExplosionSources(tx: TxClient, runCode: string) {
  const status = explosionPostedStatus(runCode);
  const [transfers, stocktakes] = await Promise.all([
    tx.inventoryTransaction.findMany({ where: { explosionStatus: status, deletedAt: null }, select: { id: true } }),
    tx.stocktakeSession.findMany({ where: { explosionStatus: status, deletedAt: null }, select: { id: true } }),
  ]);
  const transferIds = transfers.map((row) => row.id);
  const stocktakeIds = stocktakes.map((row) => row.id);
  if (transferIds.length > 0) {
    await tx.inventoryTransaction.updateMany({ where: { id: { in: transferIds } }, data: { explosionStatus: EXPLOSION_PENDING } });
  }
  if (stocktakeIds.length > 0) {
    await tx.stocktakeSession.updateMany({ where: { id: { in: stocktakeIds } }, data: { explosionStatus: EXPLOSION_PENDING } });
  }
  return { transferIds, stocktakeIds };
}

/** Một phiếu điều chuyển / huỷ / kiểm kê đang chờ rã, quy về nhu cầu chế biến ở một kho. */
export type ExplosionSource = {
  /** TRANSFER = điều chuyển; ISSUE = huỷ / xuất test món / xuất khác; STOCKTAKE = kiểm dư. */
  kind: "TRANSFER" | "ISSUE" | "STOCKTAKE";
  id: string;
  code: string;
  date: Date;
  /** Kho chế biến: kho XUẤT của điều chuyển / huỷ, kho được kiểm của kiểm kê. */
  warehouseCode: string;
  demands: Array<{ productCode: string; quantity: number }>;
};

/**
 * Phiếu điều chuyển + kiểm kê đang chờ rã của một cửa hàng. Truyền `ids` (rã lại một lần rã
 * cũ) thì lấy đúng các phiếu đó, không quét khoảng ngày — như rowIds của doanh thu.
 */
export async function loadPendingExplosionSources(
  tx: TxClient,
  input: { branchCode: string; dateFrom: Date; rangeEnd: Date; ids?: { transferIds: string[]; stocktakeIds: string[] } },
): Promise<ExplosionSource[]> {
  const isExplodable = await semiFinishedWithRecipeChecker(tx, input.branchCode);
  const transfers = await tx.inventoryTransaction.findMany({
    where: {
      transactionType: { in: EXPLOSION_ISSUE_TYPES },
      branchCode: input.branchCode,
      explosionStatus: EXPLOSION_PENDING,
      deletedAt: null,
      ...(input.ids ? { id: { in: input.ids.transferIds } } : { transactionDate: { gte: input.dateFrom, lte: input.rangeEnd } }),
    },
    include: { lines: { include: { item: { select: { code: true, itemType: true } } } } },
    orderBy: [{ transactionDate: "asc" }, { code: "asc" }],
  });
  const stocktakes = await tx.stocktakeSession.findMany({
    where: {
      branchCode: input.branchCode,
      status: "APPROVED",
      explosionStatus: EXPLOSION_PENDING,
      deletedAt: null,
      ...(input.ids ? { id: { in: input.ids.stocktakeIds } } : { stocktakeDate: { gte: input.dateFrom, lte: input.rangeEnd } }),
    },
    include: { lines: { include: { item: { select: { code: true, itemType: true } } } } },
    orderBy: [{ stocktakeDate: "asc" }, { code: "asc" }],
  });

  const sources: ExplosionSource[] = [];
  for (const transfer of transfers) {
    sources.push({
      kind: transfer.transactionType === "DIEU_CHUYEN" ? "TRANSFER" : "ISSUE",
      id: transfer.id,
      code: transfer.code,
      date: transfer.transactionDate,
      warehouseCode: transfer.warehouseCode,
      demands: transfer.lines
        .filter((line) => isExplodable(line.item))
        .map((line) => ({ productCode: line.item.code, quantity: line.quantity })),
    });
  }
  for (const stocktake of stocktakes) {
    // Phần dư đã hoãn lúc duyệt = dòng dư KHÔNG có trên phiếu nhập kiểm kê (-N). Suy lại từ phiếu
    // thay vì hỏi lại định lượng: định lượng đổi sau lúc duyệt thì phần dư vẫn không bị bỏ sót.
    const inbound = await tx.inventoryTransactionLine.findMany({
      where: { transaction: { referenceType: "STOCKTAKE", referenceId: stocktake.id, transactionType: "NHAP_KIEM_KE", deletedAt: null } },
      select: { itemId: true },
    });
    const booked = new Set(inbound.map((line) => line.itemId));
    sources.push({
      kind: "STOCKTAKE",
      id: stocktake.id,
      code: stocktake.code,
      date: stocktake.stocktakeDate,
      warehouseCode: stocktake.warehouseCode,
      demands: stocktake.lines
        .filter((line) => line.varianceQuantity > 0 && !booked.has(line.itemId))
        .map((line) => ({ productCode: line.item.code, quantity: line.varianceQuantity })),
    });
  }
  return sources;
}
