/**
 * Phiếu điều chuyển CHỜ DUYỆT (khách chốt 03/10/2026).
 *
 * Nhà hàng chuyển lập phiếu → phiếu nằm ở trạng thái Chờ duyệt (hàng đang đi đường). Nhà hàng
 * nhận đếm hàng rồi Duyệt — sửa được số thực nhận — hoặc Trả lại kèm lý do để bên chuyển sửa và
 * gửi lại. Áp cho mọi điều chuyển, kể cả hai kho của cùng một nhà hàng.
 *
 * Chờ duyệt KHÔNG đụng tồn kho, giá vốn hay công nợ nội bộ. Duyệt mới gọi postStockTransfer ghi
 * phiếu DIEU_CHUYEN (cùng mã DCK đã giữ chỗ) theo NGÀY NHẬN: trừ kho đi, cộng kho nhận, sinh cặp
 * công nợ nội bộ nếu khác nhà hàng, vào hàng chờ rã nếu có bán thành phẩm.
 *
 * Import điều chuyển từ Excel vẫn ghi thẳng (dữ liệu lịch sử kế toán nhập), không qua đây.
 */
import type { DemoSession } from "@/lib/auth-demo";
import type { TxClient } from "@/lib/prisma";
import { postStockTransfer } from "@/lib/inventory-transfer";
import { allowedWarehousesOf } from "@/lib/warehouse-scope";

export const TRANSFER_PENDING = "PENDING";
export const TRANSFER_RETURNED = "RETURNED";
export const TRANSFER_APPROVED = "APPROVED";

export type TransferRequestLine = {
  itemId: string;
  itemCode: string;
  itemName: string;
  /** ĐVT tồn của mặt hàng. */
  unit: string;
  /** Số lượng bên chuyển gửi đi, theo ĐVT đã nhập (inputUnitCode, trống = ĐVT tồn). */
  inputQuantity: number;
  inputUnitCode: string | null;
  /** Số thực nhận bên nhận khai lúc duyệt (cùng ĐVT với inputQuantity). */
  receivedQuantity?: number | null;
};

function requestError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

const up = (value: string | null | undefined) => (value || "").trim().toUpperCase();

function hasBranch(session: DemoSession, branchCode: string) {
  const allowed = session.allowedBranches || [];
  return allowed.includes("ALL") || allowed.map(up).includes(up(branchCode));
}

function hasWarehouse(session: DemoSession, warehouseCode: string) {
  const scoped = allowedWarehousesOf(session);
  return !scoped || scoped.map(up).includes(up(warehouseCode));
}

/** Bên chuyển: có quyền cửa hàng + kho xuất — được sửa / huỷ phiếu chưa duyệt. */
export function canSendTransfer(session: DemoSession, request: { branchCode: string; warehouseCode: string }) {
  return hasBranch(session, request.branchCode) && hasWarehouse(session, request.warehouseCode);
}

/** Bên nhận: có quyền cửa hàng + kho nhận — được Duyệt / Trả lại. */
export function canReceiveTransfer(session: DemoSession, request: { toBranchCode: string; toWarehouseCode: string }) {
  return hasBranch(session, request.toBranchCode) && hasWarehouse(session, request.toWarehouseCode);
}

export function parseRequestLines(value: unknown): TransferRequestLine[] {
  return Array.isArray(value) ? (value as TransferRequestLine[]) : [];
}

/**
 * Dựng dòng hàng của phiếu chờ duyệt từ dòng người dùng gửi lên: mặt hàng phải tồn tại, không
 * thuộc nhóm FINISHED (cùng luật postStockTransfer), số lượng > 0.
 */
export async function buildTransferRequestLines(
  tx: TxClient,
  input: Array<{ itemId?: string; itemCode?: string; inputQuantity?: unknown; inputUnitCode?: unknown }>,
): Promise<TransferRequestLine[]> {
  const lines: TransferRequestLine[] = [];
  for (const line of input) {
    const item = line.itemId
      ? await tx.inventoryItem.findUnique({ where: { id: String(line.itemId) } })
      : await tx.inventoryItem.findUnique({ where: { code: up(String(line.itemCode || "")) } });
    if (!item) requestError(`Không tìm thấy mặt hàng ${line.itemCode || line.itemId}`);
    if (item.itemType === "FINISHED") {
      requestError(`Mặt hàng ${item.code} thuộc nhóm FINISHED nên không được điều chuyển. Thành phẩm chỉ nhập qua chế biến và xuất qua bán hàng/hủy.`);
    }
    const quantity = Number(line.inputQuantity);
    if (!(quantity > 0)) requestError(`Số lượng điều chuyển của ${item.code} phải lớn hơn 0`);
    const unitCode = String(line.inputUnitCode || "").trim();
    lines.push({
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name,
      unit: item.unit,
      inputQuantity: quantity,
      inputUnitCode: unitCode && up(unitCode) !== up(item.unit) ? unitCode : null,
    });
  }
  if (lines.length === 0) requestError("Cần ít nhất một dòng hàng điều chuyển");
  return lines;
}

/**
 * Bên nhận duyệt: ghi phiếu DIEU_CHUYEN theo số THỰC NHẬN và ngày nhận. Dòng thực nhận = 0 bị bỏ
 * (không nhận được gì); cả phiếu thực nhận 0 thì không cho duyệt — dùng Trả lại.
 */
export async function approveTransferRequest(
  tx: TxClient,
  input: { id: string; receivedDate: Date; receivedQuantities: Array<number | null | undefined>; approvedBy: string | null },
) {
  const request = await tx.inventoryTransferRequest.findUnique({ where: { id: input.id } });
  if (!request) requestError("Không tìm thấy phiếu điều chuyển chờ duyệt");
  if (request.status !== TRANSFER_PENDING) requestError(`Phiếu ${request.code} không ở trạng thái chờ duyệt`);

  const lines = parseRequestLines(request.lines).map((line, index) => {
    const raw = input.receivedQuantities[index];
    const received = raw === null || raw === undefined || Number.isNaN(Number(raw)) ? line.inputQuantity : Number(raw);
    if (received < 0) requestError(`Số thực nhận của ${line.itemCode} không được âm`);
    return { ...line, receivedQuantity: received };
  });
  const posted = lines.filter((line) => (line.receivedQuantity || 0) > 0);
  if (posted.length === 0) requestError("Số thực nhận đều bằng 0 — không có gì để nhận. Dùng Trả lại nếu không nhận hàng.");

  const result = await postStockTransfer(tx, {
    code: request.code,
    transactionDate: input.receivedDate,
    branchCode: request.branchCode,
    warehouseCode: request.warehouseCode,
    toWarehouseCode: request.toWarehouseCode,
    toBranchCode: request.toBranchCode,
    referenceCode: request.referenceCode,
    note: request.note,
    createdBy: request.createdBy,
    lines: posted.map((line) => ({
      itemId: line.itemId,
      quantity: line.receivedQuantity,
      inputQuantity: line.receivedQuantity,
      unitCode: line.inputUnitCode || undefined,
      inputUnitCode: line.inputUnitCode || undefined,
    })),
  });

  const updated = await tx.inventoryTransferRequest.update({
    where: { id: request.id },
    data: {
      status: TRANSFER_APPROVED,
      lines,
      approvedBy: input.approvedBy,
      approvedAt: new Date(),
      receivedDate: input.receivedDate,
      transactionId: result.transaction.id,
    },
  });
  return { request: updated, ...result };
}
