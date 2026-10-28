/**
 * Sửa phiếu nhập NM-… sinh từ nhận hàng PO ngay ở màn Nhập kho (khách 28/10/2026: "Huỷ lần nhận rồi
 * nhận lại" bất tiện). Phiếu kho được ghi lại như mọi phiếu nhập (repostInventoryTransaction); ở đây
 * kéo phần PO theo số mới để Mua hàng và công nợ NCC không lệch:
 * - dòng PO: số đã nhận cộng/trừ đúng phần chênh, đơn giá khai mới thay giá dòng PO (giữ giá cũ trong
 *   lần nhận để Huỷ lần nhận còn trả về đúng), dòng thêm lúc nhận thì số đặt đi theo số nhận;
 * - dòng xoá khỏi phiếu = không nhận dòng đó; dòng mặt hàng mới chỉ thêm được khi phiếu thuộc MỘT PO
 *   (thành dòng thêm của PO đó, như dòng giao thêm lúc nhận);
 * - bản ghi lần nhận (PurchaseOrderReceipt) và công nợ NCC của từng PO cộng/trừ đúng phần chênh trị giá
 *   (tiền hàng sau chiết khấu + thuế + chi phí mua hàng phân bổ); trạng thái PO, PR tính lại.
 * Kho và NCC của phiếu đi theo PO nên không đổi ở đây.
 */
import type { TxClient } from "@/lib/prisma";
import { purchaseLineAmount } from "@/lib/purchase-payable";
import { syncRequestCompletion } from "@/lib/purchase-request-open-lines";

type ReceiptLine = { lineId: string; quantity: number; createdLine: boolean; previousUnitCost: number | null; previousTotalCost: number | null };

type StockLine = {
  id?: string;
  itemId: string;
  quantity: number;
  inputUnitCost?: number | null;
  conversionRate?: number | null;
  vatAmount?: number | null;
  purchaseCostShare?: number | null;
  discountAmount?: number | null;
  totalCost: number;
  unitCost: number;
  inputQuantity?: number | null;
};

const epsilon = 1e-6;

function editError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

/** Trị giá một dòng nhập tính vào công nợ NCC — cùng luật lúc nhận PO (postOrdersReceive). */
function payableValue(line: StockLine) {
  return purchaseLineAmount(line) + (line.vatAmount || 0) + (line.purchaseCostShare || 0);
}

/** Kiểm trước khi ghi lại phiếu: việc phát sinh sau lần nhận chặn sửa (như Huỷ lần nhận). */
export async function assertPurchaseReceiptEditable(tx: TxClient, doc: { code: string }) {
  const returned = await tx.inventoryTransaction.findFirst({ where: { transactionType: "XUAT_TRA_NCC", referenceCode: doc.code, deletedAt: null }, select: { code: true } });
  if (returned) editError(`Phiếu nhập ${doc.code} đã có phiếu trả hàng NCC ${returned.code} — xoá phiếu trả hàng trước rồi mới sửa.`);
}

/**
 * Gọi SAU khi phiếu đã ghi lại. `oldLines` là dòng phiếu trước khi sửa, `newLines` là dòng mới theo
 * đúng thứ tự gửi lên, `sourceLineIds[i]` là id dòng cũ mà dòng mới thứ i sửa từ đó (trống = dòng thêm).
 */
export async function syncPurchaseReceiptEdit(
  tx: TxClient,
  doc: { id: string; code: string; referenceId: string | null; transactionDate: Date; createdAt: Date; createdBy?: string | null },
  oldLines: StockLine[],
  newLines: StockLine[],
  sourceLineIds: Array<string | null>,
) {
  let receipts = await tx.purchaseOrderReceipt.findMany({ where: { stockTransactionId: doc.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
  const orderIds = [...new Set([...receipts.map((row) => row.orderId), ...(receipts.length === 0 && doc.referenceId ? [doc.referenceId] : [])])];
  if (orderIds.length === 0) editError(`Không tìm thấy PO của phiếu ${doc.code}.`);
  const orders = await tx.purchaseOrder.findMany({ where: { id: { in: orderIds } }, include: { lines: true, payable: true } });
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const poLineById = new Map(orders.flatMap((order) => order.lines.map((line) => [line.id, { ...line }] as const)));

  // Lần nhận trước 26/10/2026 chưa có bản ghi: dựng từ phiếu (khớp dòng PO theo mặt hàng như Huỷ lần nhận).
  if (receipts.length === 0) {
    const order = orderById.get(orderIds[0]);
    if (!order) editError(`Không tìm thấy PO của phiếu ${doc.code}.`);
    const lines: ReceiptLine[] = oldLines.map((line) => {
      const candidates = order.lines.filter((poLine) => poLine.itemId === line.itemId && poLine.receivedQuantity > 0);
      if (candidates.length !== 1) editError(`Phiếu ${doc.code} có mặt hàng nằm ở nhiều dòng PO — không tự khớp được, dùng Huỷ lần nhận rồi nhận lại.`);
      return { lineId: candidates[0].id, quantity: line.quantity, createdLine: false, previousUnitCost: null, previousTotalCost: null };
    });
    const created = await tx.purchaseOrderReceipt.create({
      data: {
        orderId: order.id,
        stockTransactionId: doc.id,
        receivedDate: doc.transactionDate,
        payableAmount: oldLines.reduce((sum, line) => sum + payableValue(line), 0),
        lines,
        assetIds: [],
        createdBy: doc.createdBy || null,
        // Giữ thứ tự lần nhận cho Huỷ lần nhận (mới nhất trước).
        createdAt: doc.createdAt,
      },
    });
    receipts = [created];
  }

  // Dòng cũ của phiếu → (lần nhận, mục dòng PO). Ưu tiên mục cùng mặt hàng và cùng số lượng.
  type Entry = ReceiptLine & { receiptId: string; orderId: string; used: boolean };
  const entries: Entry[] = receipts.flatMap((receipt) => ((receipt.lines as ReceiptLine[] | null) || []).map((line) => ({ ...line, receiptId: receipt.id, orderId: receipt.orderId, used: false })));
  const entryOfOldLine = new Map<string, Entry>();
  for (const line of oldLines) {
    const sameItem = entries.filter((entry) => !entry.used && poLineById.get(entry.lineId)?.itemId === line.itemId);
    const entry = sameItem.find((candidate) => Math.abs(candidate.quantity - line.quantity) < epsilon) || sameItem[0];
    if (!entry) editError(`Không khớp được dòng ${line.itemId} của phiếu ${doc.code} với dòng PO — dùng Huỷ lần nhận rồi nhận lại.`);
    entry.used = true;
    if (line.id) entryOfOldLine.set(line.id, entry);
  }

  // Giá trị cũ / mới của phần hàng kho theo từng PO.
  const oldValueByOrder = new Map<string, number>();
  for (const line of oldLines) {
    const entry = line.id ? entryOfOldLine.get(line.id) : undefined;
    if (entry) oldValueByOrder.set(entry.orderId, (oldValueByOrder.get(entry.orderId) || 0) + payableValue(line));
  }
  const newValueByOrder = new Map<string, number>();
  /** Số nhận mới (ĐVT tồn) + giá khai mới theo từng mục dòng PO đang có. */
  const newByEntry = new Map<Entry, { quantity: number; unitCost: number | null }>();
  const claimed = new Set<string>();
  const addedLines: StockLine[] = [];
  newLines.forEach((line, index) => {
    const sourceId = sourceLineIds[index];
    const entry = sourceId && !claimed.has(sourceId) ? entryOfOldLine.get(sourceId) : undefined;
    // Đổi mặt hàng trên một dòng cũ = bỏ dòng cũ, thêm dòng mới.
    if (!entry || poLineById.get(entry.lineId)?.itemId !== line.itemId) {
      addedLines.push(line);
      return;
    }
    claimed.add(sourceId as string);
    const rate = line.conversionRate || 1;
    const unitCost = line.inputUnitCost ? line.inputUnitCost / rate : null;
    if (!unitCost) editError("Dòng hàng nhận theo PO phải có đơn giá — hàng tặng kèm hãy nhận bằng phiếu Nhập khác.");
    newByEntry.set(entry, { quantity: line.quantity, unitCost });
    newValueByOrder.set(entry.orderId, (newValueByOrder.get(entry.orderId) || 0) + payableValue(line));
  });
  if (addedLines.length > 0 && orders.length > 1) {
    editError(`Phiếu ${doc.code} gộp nhiều PO (${orders.map((order) => order.code).join(", ")}) — không thêm / đổi mặt hàng được vì không biết thuộc PO nào. Nhận thêm ở PO tương ứng.`);
  }

  const receiptLinesById = new Map(receipts.map((receipt) => [receipt.id, [] as ReceiptLine[]]));
  // 1) Mục dòng PO đang có: sửa số nhận / giá, bỏ nếu dòng bị xoá khỏi phiếu.
  for (const entry of entries) {
    const poLine = poLineById.get(entry.lineId);
    const next = newByEntry.get(entry);
    if (!poLine) {
      receiptLinesById.get(entry.receiptId)?.push(entry);
      continue;
    }
    const isStockEntry = entry.used;
    // Mục của Tài sản/CCDC trong cùng lần nhận (không nằm trên phiếu kho) giữ nguyên.
    if (!isStockEntry) {
      receiptLinesById.get(entry.receiptId)?.push(stripEntry(entry));
      continue;
    }
    const newQuantity = next?.quantity ?? 0;
    const delta = newQuantity - entry.quantity;
    if (entry.createdLine && newQuantity <= epsilon) {
      await tx.purchaseOrderLine.delete({ where: { id: poLine.id } });
      poLineById.delete(poLine.id);
      continue;
    }
    const before = { unitCost: poLine.unitCost, totalCost: poLine.totalCost };
    const priceChanged = next?.unitCost !== null && next?.unitCost !== undefined && Math.abs(next.unitCost - poLine.unitCost) > 0.0001;
    const orderedQuantity = entry.createdLine ? newQuantity : poLine.orderedQuantity;
    const unitCost = priceChanged ? (next?.unitCost as number) : poLine.unitCost;
    const data = {
      receivedQuantity: Math.max(0, poLine.receivedQuantity + delta),
      ...(entry.createdLine || priceChanged ? { orderedQuantity, unitCost, totalCost: orderedQuantity * unitCost } : {}),
    };
    await tx.purchaseOrderLine.update({ where: { id: poLine.id }, data });
    Object.assign(poLine, data);
    if (newQuantity <= epsilon) continue;
    receiptLinesById.get(entry.receiptId)?.push({
      lineId: entry.lineId,
      quantity: newQuantity,
      createdLine: entry.createdLine,
      // Giá trước lần nhận đầu tiên đổi giá — Huỷ lần nhận trả về giá này.
      previousUnitCost: entry.previousUnitCost ?? (priceChanged && !entry.createdLine ? before.unitCost : null),
      previousTotalCost: entry.previousUnitCost !== null ? entry.previousTotalCost : priceChanged && !entry.createdLine ? before.totalCost : null,
    });
  }

  // 2) Dòng mặt hàng mới (phiếu một PO): thành dòng thêm của PO, như dòng giao thêm lúc nhận.
  if (addedLines.length > 0) {
    const order = orders[0];
    const receipt = receipts.find((row) => row.orderId === order.id) || receipts[0];
    for (const line of addedLines) {
      const rate = line.conversionRate || 1;
      const unitCost = line.inputUnitCost ? line.inputUnitCost / rate : 0;
      if (!(unitCost > 0)) editError("Mặt hàng thêm vào phiếu nhận PO phải có đơn giá — hàng tặng kèm hãy nhận bằng phiếu Nhập khác.");
      const created = await tx.purchaseOrderLine.create({
        data: {
          orderId: order.id, itemId: line.itemId, orderedQuantity: line.quantity, receivedQuantity: line.quantity,
          unitCost, totalCost: line.quantity * unitCost, conversionRate: 1,
        },
      });
      receiptLinesById.get(receipt.id)?.push({ lineId: created.id, quantity: line.quantity, createdLine: true, previousUnitCost: null, previousTotalCost: null });
      newValueByOrder.set(order.id, (newValueByOrder.get(order.id) || 0) + payableValue(line));
    }
  }

  // 3) Lần nhận + công nợ NCC + trạng thái từng PO.
  const now = new Date();
  const stillOnDoc: string[] = [];
  for (const order of orders) {
    const delta = (newValueByOrder.get(order.id) || 0) - (oldValueByOrder.get(order.id) || 0);
    for (const receipt of receipts.filter((row) => row.orderId === order.id)) {
      const lines = receiptLinesById.get(receipt.id) || [];
      // Xoá hết dòng của PO này khỏi phiếu (và lần nhận không có Tài sản/CCDC) = PO không còn nhận ở phiếu này.
      const emptied = lines.length === 0 && ((receipt.assetIds as string[] | null) || []).length === 0;
      if (!emptied && !stillOnDoc.includes(order.code)) stillOnDoc.push(order.code);
      await tx.purchaseOrderReceipt.update({
        where: { id: receipt.id },
        data: {
          receivedDate: doc.transactionDate,
          lines,
          // Phần chênh đi vào lần nhận đầu tiên của PO trên phiếu (thường chỉ có một).
          ...(receipt === receipts.find((row) => row.orderId === order.id) ? { payableAmount: receipt.payableAmount + delta } : {}),
          ...(emptied ? { status: "CANCELLED", cancelledBy: "Sửa phiếu nhập", cancelledAt: now } : {}),
        },
      });
    }
    if (Math.abs(delta) > 0.005) {
      if (order.payable && order.payable.originalAmount + delta <= 0.5) {
        // Về 0 thì bỏ hẳn khoản nợ của PO (và bút toán của nó) như Huỷ lần nhận.
        await tx.journalEntry.deleteMany({ where: { sourceType: "SUPPLIER_PAYABLE", sourceId: order.payable.id } });
        await tx.supplierPayable.delete({ where: { id: order.payable.id } });
      } else if (order.payable) {
        await tx.supplierPayable.update({
          where: { id: order.payable.id },
          data: { originalAmount: { increment: delta }, outstandingAmount: { increment: delta } },
        });
      } else if (delta > 0) {
        await tx.supplierPayable.create({
          data: { purchaseOrderId: order.id, supplierCode: order.supplierCode, supplierName: order.supplierName, recognizedDate: doc.transactionDate, originalAmount: delta, outstandingAmount: delta },
        });
      }
    }
    const lines = await tx.purchaseOrderLine.findMany({ where: { orderId: order.id } });
    const nothingReceived = lines.every((line) => line.receivedQuantity <= epsilon);
    const completed = lines.length > 0 && lines.every((line) => line.receivedQuantity >= line.orderedQuantity - epsilon);
    await tx.purchaseOrder.update({
      where: { id: order.id },
      data: {
        // PO đã Đóng (nhận thiếu rồi bấm Hoàn tất) giữ nguyên trạng thái.
        ...(order.closedAt ? {} : { status: nothingReceived ? "APPROVED" : completed ? "COMPLETED" : "PARTIALLY_RECEIVED" }),
        totalAmount: lines.reduce((sum, line) => sum + line.totalCost, 0),
      },
    });
    await syncRequestCompletion(tx, order.requestId);
  }
  // Phiếu gộp bỏ hẳn một PO: tham chiếu của phiếu chỉ còn các PO đang nhận ở đây.
  if (stillOnDoc.length > 0 && stillOnDoc.length < orders.length) {
    const first = orders.find((order) => order.code === stillOnDoc[0]);
    await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { referenceCode: stillOnDoc.join(", "), referenceId: first?.id } });
  }
  return { orderCodes: stillOnDoc };
}

function stripEntry(entry: ReceiptLine & { receiptId?: string; orderId?: string; used?: boolean }): ReceiptLine {
  return { lineId: entry.lineId, quantity: entry.quantity, createdLine: entry.createdLine, previousUnitCost: entry.previousUnitCost, previousTotalCost: entry.previousTotalCost };
}
