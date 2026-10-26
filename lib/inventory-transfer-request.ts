/**
 * Phiếu điều chuyển CHỜ DUYỆT (khách chốt 03/10/2026) — "HÀNG ĐI ĐƯỜNG" từ 26/10/2026.
 *
 * Nhà hàng chuyển lập phiếu → ghi ngay phiếu CHUYỂN ĐI (mã DCK-…-DI) từ kho xuất sang kho ảo "Hàng đi
 * đường" theo NGÀY GIỜ LÊN PHIẾU: kho xuất trừ ngay (kiểm kê theo giờ chốt thấy đúng), bán thành phẩm
 * vào hàng chờ rã ở kho xuất. Nhà hàng nhận Duyệt — nhận ĐÚNG số gửi, sai thì Trả lại — mới ghi phiếu
 * DIEU_CHUYEN (mã DCK giữ chỗ) từ kho đi đường sang kho nhận theo ngày giờ nhận, sinh cặp công nợ nội
 * bộ nếu khác nhà hàng. Trả lại / huỷ thì đảo phiếu chuyển đi (hàng về kho xuất); bên chuyển sửa và
 * gửi lại thì ghi phiếu chuyển đi mới theo số mới.
 *
 * Phiếu chờ duyệt lập trước 26/10/2026 không có phiếu chuyển đi thì duyệt theo cách cũ (kho xuất →
 * kho nhận một lần) — scripts/backfill-transfer-dispatch.mjs ghi phiếu chuyển đi cho các phiếu đó.
 * Import điều chuyển từ Excel vẫn ghi thẳng (dữ liệu lịch sử kế toán nhập), không qua đây.
 */
import type { DemoSession } from "@/lib/auth-demo";
import type { TxClient } from "@/lib/prisma";
import { postStockTransfer, syncTransferInternalDebt } from "@/lib/inventory-transfer";
import { postInventoryTransaction, reverseStockEffect } from "@/lib/inventory-stock";
import { explodedRunOf, refreshTransferExplosionStatus } from "@/lib/explosion-sources";
import { allowedWarehousesOf } from "@/lib/warehouse-scope";

export const TRANSFER_PENDING = "PENDING";
export const TRANSFER_RETURNED = "RETURNED";
export const TRANSFER_APPROVED = "APPROVED";
/** referenceType của phiếu chuyển đi — chặn sửa / xoá thẳng, chỉ xử lý qua phiếu chờ duyệt gốc. */
export const TRANSFER_DISPATCH_REFERENCE = "TRANSFER_REQUEST";

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

/** Kho ảo giữ hàng đang đi đường của một cửa hàng chuyển tới một kho nhận. */
export function transitWarehouseCode(fromBranch: string, toWarehouseCode: string) {
  return `DD-${up(fromBranch)}-${up(toWarehouseCode)}`;
}

export function isTransitWarehouse(code: string | null | undefined) {
  return up(code).startsWith("DD-");
}

/**
 * Tạo danh mục kho "Hàng đi đường → <kho nhận>" thuộc cửa hàng chuyển (để chặng chuyển đi là điều chuyển
 * cùng nhà hàng, không sinh công nợ). Để INACTIVE: không hiện trong ô chọn kho, chỉ dùng để hiện tên.
 */
async function ensureTransitWarehouse(tx: TxClient, fromBranch: string, toWarehouseCode: string) {
  const code = transitWarehouseCode(fromBranch, toWarehouseCode);
  const existing = await tx.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code, deletedAt: undefined } });
  if (existing) return code;
  const destination = await tx.masterDataItem.findFirst({ where: { type: "WAREHOUSE", code: toWarehouseCode }, select: { name: true } });
  await tx.masterDataItem.create({
    data: {
      type: "WAREHOUSE",
      code,
      name: `Hàng đi đường → ${destination?.name || toWarehouseCode}`,
      branch: up(fromBranch),
      group: "TRANSIT",
      status: "INACTIVE",
      note: "Tự tạo cho điều chuyển chờ duyệt: hàng đã rời kho xuất, chờ kho nhận duyệt.",
    },
  });
  return code;
}

/** Mã phiếu chuyển đi: DCK-…-DI, gửi lại lần 2 trở đi thêm số (mã phiếu đã xoá mềm vẫn giữ chỗ). */
async function nextDispatchCode(tx: TxClient, requestCode: string) {
  const used = await tx.inventoryTransaction.count({ where: { code: { startsWith: `${requestCode}-DI` }, deletedAt: undefined } });
  return used === 0 ? `${requestCode}-DI` : `${requestCode}-DI${used + 1}`;
}

/** Ghi phiếu CHUYỂN ĐI của phiếu chờ duyệt: kho xuất → kho đi đường, theo ngày giờ lên phiếu. */
export async function dispatchTransferRequest(tx: TxClient, requestId: string) {
  const request = await tx.inventoryTransferRequest.findUnique({ where: { id: requestId } });
  if (!request) requestError("Không tìm thấy phiếu điều chuyển chờ duyệt");
  if (request.dispatchTransactionId) return request;
  const transit = await ensureTransitWarehouse(tx, request.branchCode, request.toWarehouseCode);
  const transaction = await postInventoryTransaction(tx, {
    code: await nextDispatchCode(tx, request.code),
    transactionType: "DIEU_CHUYEN",
    transactionDate: request.requestDate,
    branchCode: request.branchCode,
    warehouseCode: request.warehouseCode,
    toWarehouseCode: transit,
    toBranchCode: null,
    referenceType: TRANSFER_DISPATCH_REFERENCE,
    referenceId: request.id,
    referenceCode: request.code,
    note: [`Chuyển đi chờ kho ${request.toWarehouseCode} nhận`, request.note].filter(Boolean).join(" · "),
    createdBy: request.createdBy,
    lines: parseRequestLines(request.lines).map((line) => ({
      itemId: line.itemId,
      quantity: line.inputQuantity,
      inputQuantity: line.inputQuantity,
      unitCode: line.inputUnitCode || undefined,
      inputUnitCode: line.inputUnitCode || undefined,
    })),
  });
  // Bán thành phẩm có định lượng: kho xuất chế biến phần chuyển đi (khách chốt 28/09/2026) — tính
  // từ lúc hàng rời kho, không đợi bên nhận duyệt.
  await refreshTransferExplosionStatus(tx, transaction.id);
  return tx.inventoryTransferRequest.update({ where: { id: request.id }, data: { dispatchTransactionId: transaction.id } });
}

/** Đảo phiếu chuyển đi (Trả lại / Huỷ / sửa gửi lại): hàng về kho xuất. Đã rã BOM thì chặn. */
export async function undoTransferDispatch(tx: TxClient, request: { id: string; dispatchTransactionId: string | null }, actor: string | null) {
  if (!request.dispatchTransactionId) return;
  const doc = await tx.inventoryTransaction.findUnique({ where: { id: request.dispatchTransactionId }, include: { lines: true } });
  if (doc && !doc.deletedAt) {
    const run = explodedRunOf(doc.explosionStatus);
    if (run) requestError(`Phiếu chuyển đi ${doc.code} có bán thành phẩm đã rã BOM trong lần rã ${run} — kế toán hoàn tác lần rã đó ở tab Chế biến trước.`);
    await reverseStockEffect(tx, doc);
    await tx.inventoryTransaction.update({ where: { id: doc.id }, data: { deletedAt: new Date(), deletedBy: actor } });
  }
  await tx.inventoryTransferRequest.update({ where: { id: request.id }, data: { dispatchTransactionId: null } });
}

/**
 * Bên nhận duyệt: nhận ĐÚNG số bên chuyển gửi (khách 26/10/2026 — sai thì Trả lại để bên chuyển sửa)
 * theo ngày giờ nhận. Có phiếu chuyển đi thì ghi kho đi đường → kho nhận; phiếu cũ chưa có thì ghi
 * thẳng kho xuất → kho nhận như trước.
 */
export async function approveTransferRequest(
  tx: TxClient,
  input: { id: string; receivedDate: Date; approvedBy: string | null },
) {
  const request = await tx.inventoryTransferRequest.findUnique({ where: { id: input.id } });
  if (!request) requestError("Không tìm thấy phiếu điều chuyển chờ duyệt");
  if (request.status !== TRANSFER_PENDING) requestError(`Phiếu ${request.code} không ở trạng thái chờ duyệt`);

  const lines = parseRequestLines(request.lines).map((line) => ({ ...line, receivedQuantity: line.inputQuantity }));
  const stockLines = lines.map((line) => ({
    itemId: line.itemId,
    quantity: line.inputQuantity,
    inputQuantity: line.inputQuantity,
    unitCode: line.inputUnitCode || undefined,
    inputUnitCode: line.inputUnitCode || undefined,
  }));
  const fromBranch = up(request.branchCode);
  const toBranch = up(request.toBranchCode) || fromBranch;

  let result;
  const dispatch = request.dispatchTransactionId
    ? await tx.inventoryTransaction.findUnique({ where: { id: request.dispatchTransactionId }, select: { toWarehouseCode: true, deletedAt: true } })
    : null;
  if (dispatch && !dispatch.deletedAt && dispatch.toWarehouseCode) {
    const transaction = await postInventoryTransaction(tx, {
      code: request.code,
      transactionType: "DIEU_CHUYEN",
      transactionDate: input.receivedDate,
      branchCode: fromBranch,
      warehouseCode: dispatch.toWarehouseCode,
      toWarehouseCode: request.toWarehouseCode,
      toBranchCode: toBranch !== fromBranch ? toBranch : null,
      referenceType: request.referenceCode ? "MANUAL" : null,
      referenceCode: request.referenceCode || null,
      note: request.note || null,
      createdBy: request.createdBy,
      lines: stockLines,
    });
    // Không vào hàng chờ rã: bán thành phẩm đã rã ở chặng chuyển đi (kho xuất).
    result = await syncTransferInternalDebt(tx, transaction.id);
  } else {
    result = await postStockTransfer(tx, {
      code: request.code,
      transactionDate: input.receivedDate,
      branchCode: request.branchCode,
      warehouseCode: request.warehouseCode,
      toWarehouseCode: request.toWarehouseCode,
      toBranchCode: request.toBranchCode,
      referenceCode: request.referenceCode,
      note: request.note,
      createdBy: request.createdBy,
      lines: stockLines,
    });
  }

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
