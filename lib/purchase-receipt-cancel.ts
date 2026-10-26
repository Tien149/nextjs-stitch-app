/**
 * "Huỷ lần nhận" hàng của PO (khách 26/10/2026): phiếu nhập sinh từ nhận PO bị khoá sửa/xoá ở màn Kho
 * (xử lý ở chứng từ gốc) mà bên Mua hàng chưa có cách sửa — nhận sai là kẹt. Huỷ = đảo đúng những gì
 * lần nhận đã làm: hoàn kho theo phiếu nhập, trả lại số đã nhận trên dòng PO (dòng thêm lúc nhận thì
 * bỏ, giá dòng đổi lúc nhận thì về giá cũ), trừ lại công nợ NCC của PO, gỡ hồ sơ Tài sản/CCDC. Rồi
 * nhận lại với số đúng.
 *
 * Theo THỨ TỰ NGƯỢC LẠI (khách chốt): chỉ lần nhận MỚI NHẤT còn hiệu lực của PO huỷ được; việc phát
 * sinh sau lần nhận (trả hàng NCC theo phiếu nhập, khấu hao / bảo trì tài sản) phải gỡ trước. Công nợ
 * NCC của PO không gạch theo từng phiếu chi (trả tiền trừ ở số dư đối tác) nên không chặn ở đây — huỷ
 * sau khi đã trả thì sổ NCC hiện trả dư cho tới khi nhận lại.
 *
 * Lần nhận trước khi có bảng PurchaseOrderReceipt (trước 26/10/2026) dựng lại từ phiếu nhập NM-…:
 * khớp dòng PO theo mặt hàng, công nợ = tiền hàng sau chiết khấu + thuế + chi phí mua hàng của phiếu.
 */
import type { TxClient } from "@/lib/prisma";
import { reverseStockEffect } from "@/lib/inventory-stock";
import { isPeriodLocked } from "@/lib/phase3";
import { purchaseLineAmount } from "@/lib/purchase-payable";

type ReceiptLine = { lineId: string; quantity: number; createdLine: boolean; previousUnitCost: number | null; previousTotalCost: number | null };

function cancelError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

type Candidate = {
  receiptId: string | null;
  stockTransactionId: string | null;
  code: string;
  receivedDate: Date;
  createdAt: Date;
};

/** Các lần nhận còn hiệu lực của PO, MỚI NHẤT trước (gồm lần nhận cũ chỉ có phiếu nhập NM-…). */
export async function activeReceipts(tx: TxClient, orderId: string): Promise<Candidate[]> {
  const [receipts, docs] = await Promise.all([
    tx.purchaseOrderReceipt.findMany({ where: { orderId, status: "ACTIVE" } }),
    tx.inventoryTransaction.findMany({
      where: { referenceType: "PURCHASE_ORDER", referenceId: orderId, transactionType: "NHAP_MUA", deletedAt: null },
      select: { id: true, code: true, transactionDate: true, createdAt: true },
    }),
  ]);
  const tracked = new Set(receipts.map((row) => row.stockTransactionId).filter(Boolean));
  const codeOf = new Map(docs.map((doc) => [doc.id, doc.code]));
  const list: Candidate[] = [
    ...receipts.map((row) => ({
      receiptId: row.id,
      stockTransactionId: row.stockTransactionId,
      code: (row.stockTransactionId && codeOf.get(row.stockTransactionId)) || "lần nhận Tài sản/CCDC",
      receivedDate: row.receivedDate,
      createdAt: row.createdAt,
    })),
    ...docs.filter((doc) => !tracked.has(doc.id)).map((doc) => ({
      receiptId: null, stockTransactionId: doc.id, code: doc.code, receivedDate: doc.transactionDate, createdAt: doc.createdAt,
    })),
  ];
  return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function cancelPurchaseReceipt(
  tx: TxClient,
  input: { orderId?: string | null; stockTransactionId?: string | null; actor: string },
) {
  let orderId = input.orderId || "";
  if (!orderId && input.stockTransactionId) {
    const doc = await tx.inventoryTransaction.findUnique({ where: { id: input.stockTransactionId }, select: { referenceType: true, referenceId: true, code: true } });
    if (!doc || doc.referenceType !== "PURCHASE_ORDER" || !doc.referenceId) cancelError("Phiếu này không phải phiếu nhận hàng từ PO");
    orderId = doc.referenceId;
  }
  const order = await tx.purchaseOrder.findUnique({ where: { id: orderId }, include: { lines: true, payable: true } });
  if (!order) cancelError("Không tìm thấy PO");

  const receipts = await activeReceipts(tx, order.id);
  if (receipts.length === 0) cancelError(`PO ${order.code} chưa có lần nhận nào còn hiệu lực.`);
  const target = receipts[0];
  if (input.stockTransactionId && target.stockTransactionId !== input.stockTransactionId) {
    cancelError(`PO ${order.code} còn lần nhận ${target.code} sau phiếu này — huỷ theo thứ tự ngược lại: huỷ ${target.code} trước.`);
  }
  if (await isPeriodLocked(target.receivedDate, order.branchCode)) cancelError(`Kỳ kế toán của lần nhận ${target.code} đã khóa`);

  const doc = target.stockTransactionId
    ? await tx.inventoryTransaction.findUnique({ where: { id: target.stockTransactionId }, include: { lines: true } })
    : null;

  // Lần nhận cần đảo: bản ghi đầy đủ, hoặc dựng lại từ phiếu nhập cũ.
  let lines: ReceiptLine[];
  let payableAmount: number;
  let assetIds: string[];
  if (target.receiptId) {
    const receipt = await tx.purchaseOrderReceipt.findUnique({ where: { id: target.receiptId } });
    lines = (receipt?.lines as ReceiptLine[] | null) || [];
    payableAmount = receipt?.payableAmount || 0;
    assetIds = (receipt?.assetIds as string[] | null) || [];
  } else {
    if (!doc) cancelError("Không tìm thấy phiếu nhập của lần nhận");
    lines = doc.lines.map((line) => {
      const candidates = order.lines.filter((poLine) => poLine.itemId === line.itemId && poLine.receivedQuantity > 0);
      if (candidates.length !== 1) cancelError(`Lần nhận ${doc.code} có mặt hàng nằm ở nhiều dòng PO — không tự đảo được, liên hệ kế toán.`);
      return { lineId: candidates[0].id, quantity: line.quantity, createdLine: false, previousUnitCost: null, previousTotalCost: null };
    });
    payableAmount = doc.lines.reduce((sum, line) => sum + purchaseLineAmount(line) + (line.vatAmount || 0), 0) + (doc.purchaseCost || 0);
    assetIds = (await tx.assetRecord.findMany({ where: { sourceReceiptId: doc.id, deletedAt: null }, select: { id: true } })).map((row) => row.id);
  }

  // Việc phát sinh SAU lần nhận phải gỡ trước (thứ tự ngược lại).
  if (doc) {
    const returned = await tx.inventoryTransaction.findFirst({ where: { transactionType: "XUAT_TRA_NCC", referenceCode: doc.code, deletedAt: null }, select: { code: true } });
    if (returned) cancelError(`Phiếu nhập ${doc.code} đã có phiếu trả hàng NCC ${returned.code} — xoá phiếu trả hàng trước.`);
  }
  const assets = assetIds.length === 0 ? [] : await tx.assetRecord.findMany({
    where: { id: { in: assetIds }, deletedAt: null },
    select: { id: true, code: true, disposalDate: true, _count: { select: { depreciations: true, maintenances: true, damageReports: true } } },
  });
  for (const asset of assets) {
    if (asset._count.depreciations > 0) cancelError(`Tài sản ${asset.code} của lần nhận đã trích khấu hao — bỏ trích khấu hao trước.`);
    if (asset._count.maintenances > 0 || asset._count.damageReports > 0) cancelError(`Tài sản ${asset.code} của lần nhận đã có bảo trì / báo hỏng — gỡ các phiếu đó trước.`);
    if (asset.disposalDate) cancelError(`Tài sản ${asset.code} của lần nhận đã thanh lý — huỷ thanh lý trước.`);
  }

  // 1) Kho: hoàn theo phiếu nhập rồi xoá mềm phiếu.
  const now = new Date();
  if (doc) {
    await reverseStockEffect(tx, doc);
    await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: now, deletedBy: input.actor } });
  }
  // 2) Tài sản/CCDC sinh từ lần nhận.
  if (assets.length > 0) await tx.assetRecord.updateMany({ where: { id: { in: assets.map((asset) => asset.id) } }, data: { deletedAt: now, deletedBy: input.actor } });
  // 3) Dòng PO: trả lại số đã nhận; dòng thêm lúc nhận thì bỏ; giá đổi lúc nhận thì về giá cũ.
  for (const line of lines) {
    const poLine = order.lines.find((candidate) => candidate.id === line.lineId);
    if (!poLine) continue;
    if (line.createdLine) {
      await tx.purchaseOrderLine.delete({ where: { id: poLine.id } });
      continue;
    }
    await tx.purchaseOrderLine.update({
      where: { id: poLine.id },
      data: {
        receivedQuantity: Math.max(0, poLine.receivedQuantity - line.quantity),
        ...(line.previousUnitCost !== null ? { unitCost: line.previousUnitCost, totalCost: line.previousTotalCost ?? poLine.orderedQuantity * line.previousUnitCost } : {}),
      },
    });
  }
  const remaining = await tx.purchaseOrderLine.findMany({ where: { orderId: order.id } });
  const nothingReceived = remaining.every((line) => line.receivedQuantity <= 1e-6);
  const completed = remaining.length > 0 && remaining.every((line) => line.receivedQuantity >= line.orderedQuantity - 1e-6);
  await tx.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: nothingReceived ? "APPROVED" : completed ? "COMPLETED" : "PARTIALLY_RECEIVED",
      totalAmount: remaining.reduce((sum, line) => sum + line.totalCost, 0),
    },
  });
  // 4) Công nợ NCC của PO: trừ đúng phần lần nhận đã cộng; về 0 thì bỏ hẳn khoản (và bút toán của nó).
  if (order.payable) {
    const originalAmount = order.payable.originalAmount - payableAmount;
    if (originalAmount <= 0.5) {
      await tx.journalEntry.deleteMany({ where: { sourceType: "SUPPLIER_PAYABLE", sourceId: order.payable.id } });
      await tx.supplierPayable.delete({ where: { id: order.payable.id } });
    } else {
      await tx.supplierPayable.update({
        where: { id: order.payable.id },
        data: { originalAmount, outstandingAmount: order.payable.outstandingAmount - payableAmount },
      });
    }
  }
  if (target.receiptId) {
    await tx.purchaseOrderReceipt.update({ where: { id: target.receiptId }, data: { status: "CANCELLED", cancelledBy: input.actor, cancelledAt: now } });
  }
  return { orderCode: order.code, receiptCode: target.code, assetsRemoved: assets.length, payableAmount, receivedDate: target.receivedDate, branchCode: order.branchCode };
}
