/**
 * Công nợ NCC của hàng nhận theo PO, trình bày THEO PHIẾU NHẬP NM (khách 27/10/2026: "công nợ NCC lấy
 * từ phiếu NM mới đúng, đừng lấy PO — PO là đặt, chưa xong cũng treo; hiện 1 dòng, đối chiếu dựa vào
 * NM"). Sổ vẫn lưu SupplierPayable theo PO (bút toán Nợ 152 / Có 331, Huỷ lần nhận đảo theo PO); ở đây
 * chỉ tách số đó ra từng phiếu NM: mỗi phiếu một dòng, đúng mã + ngày nhập, phiếu gộp nhiều PO cũng một
 * dòng. Tổng các dòng luôn bằng tổng SupplierPayable — phần không gắn được phiếu (nhận Tài sản/CCDC
 * không vào kho) đứng thành dòng mang mã PO.
 *
 * Số của từng phiếu: bản ghi lần nhận (PurchaseOrderReceipt.payableAmount, từ 26/10/2026); lần nhận
 * cũ hơn dựng lại từ dòng phiếu nhập (tiền hàng sau chiết khấu + thuế + chi phí mua hàng).
 */
import type { TxClient } from "@/lib/prisma";
import { purchaseLineAmount } from "@/lib/purchase-payable";

type Payable = {
  purchaseOrderId: string;
  supplierCode: string;
  supplierName: string;
  recognizedDate: Date;
  outstandingAmount: number;
  purchaseOrder: { code: string };
};

export type ReceiptPayableLine = {
  partnerCode: string;
  partnerName: string;
  date: Date;
  /** Mã phiếu nhập NM-… (hoặc mã PO cho phần nhận không vào kho). */
  code: string;
  orderCodes: string[];
  description: string;
  amount: number;
};

export async function purchaseReceiptPayableLines(db: Pick<TxClient, "purchaseOrderReceipt" | "inventoryTransaction">, payables: Payable[]): Promise<ReceiptPayableLine[]> {
  if (payables.length === 0) return [];
  const orderIds = payables.map((row) => row.purchaseOrderId);
  const receipts = await db.purchaseOrderReceipt.findMany({
    where: { orderId: { in: orderIds }, status: "ACTIVE" },
    select: { orderId: true, stockTransactionId: true, receivedDate: true, payableAmount: true },
  });
  const tracked = new Set(receipts.map((row) => row.stockTransactionId).filter((id): id is string => Boolean(id)));
  const docs = await db.inventoryTransaction.findMany({
    where: {
      transactionType: "NHAP_MUA",
      OR: [{ id: { in: [...tracked] } }, { referenceType: "PURCHASE_ORDER", referenceId: { in: orderIds } }],
    },
    select: {
      id: true, code: true, transactionDate: true, referenceId: true, purchaseCost: true,
      lines: { select: { inputQuantity: true, inputUnitCost: true, discountAmount: true, totalCost: true, vatAmount: true } },
    },
  });
  const docById = new Map(docs.map((doc) => [doc.id, doc]));

  // Phần của từng PO trên từng phiếu NM.
  const portions = new Map<string, Array<{ docId: string | null; date: Date; amount: number }>>();
  const push = (orderId: string, portion: { docId: string | null; date: Date; amount: number }) => {
    const list = portions.get(orderId) || [];
    list.push(portion);
    portions.set(orderId, list);
  };
  for (const row of receipts) push(row.orderId, { docId: row.stockTransactionId, date: row.receivedDate, amount: row.payableAmount });
  for (const doc of docs) {
    if (tracked.has(doc.id) || !doc.referenceId) continue;
    const amount = doc.lines.reduce((sum, line) => sum + purchaseLineAmount(line) + (line.vatAmount || 0), 0) + (doc.purchaseCost || 0);
    push(doc.referenceId, { docId: doc.id, date: doc.transactionDate, amount });
  }

  const byKey = new Map<string, ReceiptPayableLine & { fromDoc: boolean }>();
  const add = (payable: Payable, key: string, code: string, date: Date, amount: number, fromDoc: boolean) => {
    const current = byKey.get(key);
    if (current) {
      current.amount += amount;
      if (!current.orderCodes.includes(payable.purchaseOrder.code)) current.orderCodes.push(payable.purchaseOrder.code);
      return;
    }
    byKey.set(key, { partnerCode: payable.supplierCode, partnerName: payable.supplierName, date, code, orderCodes: [payable.purchaseOrder.code], description: "", amount, fromDoc });
  };
  for (const payable of payables) {
    let explained = 0;
    for (const portion of portions.get(payable.purchaseOrderId) || []) {
      const doc = portion.docId ? docById.get(portion.docId) : null;
      if (!doc) continue;
      explained += portion.amount;
      add(payable, `${payable.supplierCode}|${doc.id}`, doc.code, doc.transactionDate, portion.amount, true);
    }
    // Phần không gắn phiếu kho (Tài sản/CCDC nhận theo PO, lần nhận chỉ có tài sản) giữ mã PO.
    const rest = Math.round((payable.outstandingAmount - explained) * 100) / 100;
    if (Math.abs(rest) > 0.5) add(payable, `${payable.supplierCode}|PO|${payable.purchaseOrderId}`, payable.purchaseOrder.code, payable.recognizedDate, rest, false);
  }
  return [...byKey.values()].map(({ fromDoc, ...line }) => ({
    ...line,
    description: fromDoc
      ? `Công nợ nhập hàng phiếu ${line.code} (theo ${line.orderCodes.join(", ")})`
      : `Công nợ nhận Tài sản/CCDC theo ${line.code}`,
  }));
}
