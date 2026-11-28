import { prisma } from "@/lib/prisma";
import { businessError } from "@/lib/phase3";

/**
 * Ảnh chứng từ (khách 28/11/2026): "phiếu hủy hàng và điều chuyển bắt buộc có hình ảnh".
 * Trình duyệt nén ảnh (lib/document-images-client) rồi gửi dạng data URL kèm phiếu; máy chủ kiểm
 * tra và lưu DocumentImage cùng giao dịch tạo phiếu — không có ảnh thì không tạo phiếu.
 */

export const DOC_IMAGE_TX = "InventoryTransaction";
export const DOC_IMAGE_TRANSFER_REQUEST = "InventoryTransferRequest";
export const DOC_IMAGE_ENTITY_TYPES = [DOC_IMAGE_TX, DOC_IMAGE_TRANSFER_REQUEST] as const;

export const MAX_DOC_IMAGES = 10;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export type ParsedDocImage = { fileName: string; mimeType: string; buffer: Buffer; width: number | null; height: number | null };

/** Đọc mảng ảnh gửi kèm phiếu: [{ name, dataUrl, width, height }]. */
export function parseDocImages(value: unknown): ParsedDocImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) businessError("Ảnh chứng từ không hợp lệ.");
  if (value.length > MAX_DOC_IMAGES) businessError(`Mỗi phiếu tối đa ${MAX_DOC_IMAGES} ảnh.`);
  return value.map((raw, index) => {
    const item = (raw || {}) as Record<string, unknown>;
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
    const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
    if (!match) businessError(`Ảnh thứ ${index + 1} không đọc được — chụp hoặc chọn lại.`);
    const mimeType = match[1].toLowerCase();
    if (!ALLOWED_MIME.has(mimeType)) businessError(`Ảnh thứ ${index + 1}: chỉ nhận JPG, PNG, WEBP.`);
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length === 0) businessError(`Ảnh thứ ${index + 1} rỗng.`);
    if (buffer.length > MAX_IMAGE_BYTES) businessError(`Ảnh thứ ${index + 1} quá lớn (tối đa 4 MB sau khi nén).`);
    const size = (key: string) => {
      const number = Math.round(Number(item[key]));
      return Number.isFinite(number) && number > 0 && number < 100000 ? number : null;
    };
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 200) : `anh-${index + 1}.jpg`;
    return { fileName: name, mimeType, buffer, width: size("width"), height: size("height") };
  });
}

/** Bắt buộc có ít nhất một ảnh (phiếu hủy / điều chuyển lập trên màn hình). */
export function requireDocImages(value: unknown, label: string) {
  const images = parseDocImages(value);
  if (images.length === 0) businessError(`${label} bắt buộc có hình ảnh — chụp hoặc chọn ít nhất 1 ảnh.`);
  return images;
}

type Db = Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma;

export async function saveDocImages(db: Db, entityType: string, entityId: string, images: ParsedDocImage[], uploadedBy: string) {
  if (images.length === 0) return 0;
  await db.documentImage.createMany({
    data: images.map((image) => ({
      entityType,
      entityId,
      fileName: image.fileName,
      mimeType: image.mimeType,
      fileSize: image.buffer.length,
      width: image.width,
      height: image.height,
      content: image.buffer,
      uploadedBy,
    })),
  });
  return images.length;
}

/**
 * Các (entityType, entityId) chứa ảnh của một phiếu kho: chính phiếu đó + phiếu điều chuyển chờ
 * duyệt đã sinh ra nó (phiếu chuyển đi DCK-…-DI hoặc phiếu điều chuyển sau khi bên nhận duyệt).
 */
export async function imageOwnersOfTransactions(transactionIds: string[]) {
  const owners = new Map<string, Array<{ entityType: string; entityId: string }>>();
  for (const id of transactionIds) owners.set(id, [{ entityType: DOC_IMAGE_TX, entityId: id }]);
  if (transactionIds.length === 0) return owners;
  const requests = await prisma.inventoryTransferRequest.findMany({
    where: { OR: [{ transactionId: { in: transactionIds } }, { dispatchTransactionId: { in: transactionIds } }] },
    select: { id: true, transactionId: true, dispatchTransactionId: true },
  });
  for (const request of requests) {
    for (const txId of [request.transactionId, request.dispatchTransactionId]) {
      if (txId && owners.has(txId)) owners.get(txId)!.push({ entityType: DOC_IMAGE_TRANSFER_REQUEST, entityId: request.id });
    }
  }
  return owners;
}
