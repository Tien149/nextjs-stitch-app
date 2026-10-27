/**
 * Dòng PR chưa nằm trên PO còn hiệu lực nào. Một PR tách nhiều PO theo NCC; huỷ (hoặc xoá) một PO
 * thì PR mở lại đúng các dòng của PO đó để thu mua duyệt lại, PO khác giữ nguyên (khách 27/10/2026).
 * Dòng PO nhớ dòng PR qua `requestLineId`; màn Mua hàng tính lại cùng luật ở openLinesOf.
 */
import type { TxClient } from "@/lib/prisma";

/**
 * Đơn mua hàng CÒN HIỆU LỰC của một yêu cầu mua. `include` quan hệ không tự lọc xoá mềm
 * (xem lib/prisma.ts), nên PO đã xoá vào Thùng rác từng bị đếm và khoá cứng báo giá lẫn yêu cầu
 * mua. PO đã huỷ cũng không còn giữ PR.
 */
export const liveOrdersWhere = { deletedAt: null, status: { not: "CANCELLED" } };

export async function openRequestLines<T extends { id: string }>(db: Pick<TxClient, "purchaseOrderLine">, requestId: string, lines: T[]) {
  const ordered = await db.purchaseOrderLine.findMany({ where: { order: { requestId, ...liveOrdersWhere }, requestLineId: { not: null } }, select: { requestLineId: true } });
  const taken = new Set(ordered.map((line) => line.requestLineId));
  return lines.filter((line) => !taken.has(line.id));
}

/**
 * PR tự Hoàn tất (khách 27/10/2026): PR đã lên PO (hoặc đã bỏ phần còn lại) mà MỌI PO còn hiệu lực
 * đều Hoàn tất (nhận đủ hoặc Đóng PO) thì PR → COMPLETED; huỷ lần nhận / mở lại PO thì về ORDERED.
 * PR đang chờ duyệt (còn dòng chưa lên PO) không đụng tới.
 */
export async function syncRequestCompletion(db: Pick<TxClient, "purchaseRequest" | "purchaseOrder">, requestId: string | null | undefined) {
  if (!requestId) return;
  const request = await db.purchaseRequest.findUnique({ where: { id: requestId }, select: { status: true } });
  if (!request || !["ORDERED", "COMPLETED"].includes(request.status)) return;
  const orders = await db.purchaseOrder.findMany({ where: { requestId, ...liveOrdersWhere }, select: { status: true } });
  const next = orders.length > 0 && orders.every((order) => order.status === "COMPLETED") ? "COMPLETED" : "ORDERED";
  if (next !== request.status) await db.purchaseRequest.update({ where: { id: requestId }, data: { status: next } });
}
