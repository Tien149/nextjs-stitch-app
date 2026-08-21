/**
 * Điều chuyển hàng hóa giữa các kho, kể cả LIÊN nhà hàng.
 *
 * Hai kho cùng một nhà hàng: chỉ là cộng trừ trên báo cáo nhập xuất tồn, không phát sinh
 * công nợ. Kho nhận thuộc nhà hàng khác: hàng rời kho bên chuyển sang kho bên nhận, nên
 * bên chuyển có PHẢI THU nội bộ và bên nhận có PHẢI TRẢ nội bộ đúng bằng trị giá hàng
 * (giá vốn bình quân lúc xuất) — cùng cơ chế với phiếu Điều tiền liên nhà hàng, hoàn tiền
 * thì gạch thẳng vào cặp mã công nợ sinh ra ở đây.
 *
 * Lưu ý nghiệp vụ: KHÔNG điều chuyển nhóm FINISHED — thành phẩm chỉ sinh ra từ chế biến
 * và xuất đi qua bán hàng/hủy, chuyển thành phẩm giữa kho là dấu hiệu quy trình sai.
 */

import type { TxClient } from "@/lib/prisma";
import type { prisma } from "@/lib/prisma";
import { postInventoryTransaction, type StockLineInput } from "@/lib/inventory-stock";
import { ensureInternalPartner } from "@/lib/internal-partner";

function transferError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}

/** Mã công nợ nội bộ của phiếu điều chuyển kho, cùng dạng với phiếu điều tiền. */
export function inventoryTransferDebtCodes(transferCode: string) {
  const code = (transferCode || "").trim();
  return { receivableCode: `${code}-PT`, payableCode: `${code}-PTR` };
}

export type PostStockTransferInput = {
  code: string;
  transactionDate: Date;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode: string;
  /** Cửa hàng của kho nhận — truyền từ danh mục WAREHOUSE, trống = cùng cửa hàng. */
  toBranchCode?: string | null;
  referenceCode?: string | null;
  note?: string | null;
  createdBy?: string | null;
  importBatchId?: string | null;
  lines: StockLineInput[];
};

/**
 * Ghi phiếu điều chuyển + sinh công nợ nội bộ nếu liên nhà hàng.
 * Caller tự lo kiểm tra quyền cửa hàng và khóa kỳ (phụ thuộc phiên đăng nhập).
 */
export async function postStockTransfer(tx: TxClient, input: PostStockTransferInput) {
  const fromBranch = (input.branchCode || "").trim().toUpperCase();
  const toBranch = (input.toBranchCode || "").trim().toUpperCase() || fromBranch;
  const isCrossBranch = toBranch !== fromBranch;

  // Chặn FINISHED ngay trên dữ liệu dòng — kể cả khi caller quên lọc ở giao diện.
  for (const line of input.lines) {
    const item = line.itemId
      ? await tx.inventoryItem.findUnique({ where: { id: String(line.itemId) } })
      : await tx.inventoryItem.findUnique({ where: { code: String(line.itemCode || "").toUpperCase() } });
    if (!item) transferError(`Không tìm thấy mặt hàng ${line.itemCode || line.itemId}`);
    if (item.itemType === "FINISHED") {
      transferError(`Mặt hàng ${item.code} thuộc nhóm FINISHED nên không được điều chuyển. Thành phẩm chỉ nhập qua chế biến và xuất qua bán hàng/hủy.`);
    }
  }

  const transaction = await postInventoryTransaction(tx, {
    importBatchId: input.importBatchId || null,
    code: input.code,
    transactionType: "DIEU_CHUYEN",
    transactionDate: input.transactionDate,
    branchCode: fromBranch,
    warehouseCode: input.warehouseCode,
    toWarehouseCode: input.toWarehouseCode,
    toBranchCode: isCrossBranch ? toBranch : null,
    referenceType: input.referenceCode ? "MANUAL" : null,
    referenceCode: input.referenceCode || null,
    note: input.note || null,
    createdBy: input.createdBy || null,
    lines: input.lines,
  });

  if (!isCrossBranch) return { transaction, receivable: null, payable: null };

  const totalValue = transaction.lines.reduce((sum, line) => sum + line.totalCost, 0);
  if (!(totalValue > 0)) {
    transferError(`Phiếu điều chuyển ${input.code} không có trị giá (giá vốn bình quân = 0) nên không thể ghi công nợ nội bộ. Kiểm tra lại giá vốn của mặt hàng trước.`);
  }

  const { receivableCode, payableCode } = inventoryTransferDebtCodes(transaction.code);
  // Đối tác nội bộ dùng chung với phiếu điều tiền/phân bổ chi phí — tạo sẵn nếu chưa có.
  const fromPartner = await ensureInternalPartner(tx as unknown as typeof prisma, fromBranch);
  const toPartner = await ensureInternalPartner(tx as unknown as typeof prisma, toBranch);

  const receivable = await tx.debtRecord.create({
    data: {
      code: receivableCode,
      debtType: "RECEIVABLE",
      partnerGroup: "INTERNAL",
      partnerCode: toPartner.code,
      partnerName: toPartner.name,
      branchCode: fromBranch,
      documentDate: input.transactionDate,
      originalAmount: totalValue,
      outstandingAmount: totalValue,
      description: `${toBranch} nhận hàng theo phiếu điều chuyển ${transaction.code}`,
      sourceType: "INVENTORY_TRANSFER",
      sourceId: transaction.id,
      status: "OPEN",
    },
  });
  const payable = await tx.debtRecord.create({
    data: {
      code: payableCode,
      debtType: "PAYABLE",
      partnerGroup: "INTERNAL",
      partnerCode: fromPartner.code,
      partnerName: fromPartner.name,
      branchCode: toBranch,
      documentDate: input.transactionDate,
      originalAmount: totalValue,
      outstandingAmount: totalValue,
      description: `Nhận hàng từ ${fromBranch} theo phiếu điều chuyển ${transaction.code}`,
      sourceType: "INVENTORY_TRANSFER",
      sourceId: transaction.id,
      status: "OPEN",
    },
  });

  const updated = await tx.inventoryTransaction.update({
    where: { id: transaction.id },
    data: { internalReceivableDebtCode: receivableCode, internalPayableDebtCode: payableCode },
    include: { lines: { include: { item: true } } },
  });

  return { transaction: updated, receivable, payable };
}
