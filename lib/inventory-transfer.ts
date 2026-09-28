/**
 * Điều chuyển hàng hóa giữa các kho, kể cả LIÊN nhà hàng.
 *
 * Hai kho cùng một nhà hàng: chỉ là cộng trừ trên báo cáo nhập xuất tồn, không phát sinh
 * công nợ. Kho nhận thuộc nhà hàng khác: hàng rời kho bên chuyển sang kho bên nhận, nên
 * bên chuyển có PHẢI THU nội bộ và bên nhận có PHẢI TRẢ nội bộ đúng bằng trị giá hàng
 * (giá vốn bình quân lúc xuất, thiếu thì đơn giá gần nhất) — cùng cơ chế với phiếu Điều tiền liên nhà hàng, hoàn tiền
 * thì gạch thẳng vào cặp mã công nợ sinh ra ở đây.
 *
 * Lưu ý nghiệp vụ: KHÔNG điều chuyển nhóm FINISHED — thành phẩm chỉ sinh ra từ chế biến
 * và xuất đi qua bán hàng/hủy, chuyển thành phẩm giữa kho là dấu hiệu quy trình sai.
 */

import type { TxClient } from "@/lib/prisma";
import type { prisma } from "@/lib/prisma";
import { postInventoryTransaction, type StockLineInput } from "@/lib/inventory-stock";
import { ensureInternalPartner } from "@/lib/internal-partner";
import { refreshTransferExplosionStatus } from "@/lib/explosion-sources";

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
  // Có bán thành phẩm có định lượng thì vào hàng chờ rã: kho nguồn phải chế biến đúng số
  // chuyển đi (khách chốt 28/09/2026) — lập tay hay import đều qua đây.
  await refreshTransferExplosionStatus(tx, transaction.id);

  return syncTransferInternalDebt(tx, transaction.id);
}

/**
 * Đồng bộ cặp công nợ nội bộ (-PT phải thu bên chuyển / -PTR phải trả bên nhận) theo ĐÚNG
 * số hiện tại của phiếu điều chuyển. Dùng chung cho lúc lập phiếu và lúc sửa phiếu:
 * - liên nhà hàng và có trị giá → tạo mới hoặc cập nhật cặp nợ (upsert khôi phục cả cặp mã đã
 *   xoá mềm, nên sửa về 0 đ rồi sửa lại vẫn dùng đúng mã cũ);
 * - cùng nhà hàng, hoặc 0 đồng (chưa có đơn giá — khách chốt 27/09/2026 không chặn) → gỡ cặp
 *   nợ nếu đang có.
 * Nợ đã gạch (có phiếu thu/chi thanh toán) thì chặn: đổi số là lệch với tiền đã trả.
 */
export async function syncTransferInternalDebt(tx: TxClient, transactionId: string) {
  const transaction = await tx.inventoryTransaction.findUnique({
    where: { id: transactionId },
    include: { lines: { include: { item: true } } },
  });
  if (!transaction) transferError("Không tìm thấy phiếu điều chuyển");

  const fromBranch = transaction.branchCode.toUpperCase();
  const toBranch = (transaction.toBranchCode || "").toUpperCase() || fromBranch;
  const totalValue = transaction.lines.reduce((sum, line) => sum + line.totalCost, 0);
  const { receivableCode, payableCode } = inventoryTransferDebtCodes(transaction.code);

  const existing = await tx.debtRecord.findMany({
    where: { code: { in: [receivableCode, payableCode] }, deletedAt: null },
    include: { settlements: true },
  });
  const settled = existing.find((debt) => debt.settlements.length > 0);
  if (settled) {
    transferError(`Công nợ nội bộ ${settled.code} của phiếu ${transaction.code} đã được gạch nợ nên không sửa được phiếu. Hoàn tác các phiếu thu/chi gạch nợ trước.`);
  }

  if (toBranch === fromBranch || !(totalValue > 0)) {
    if (existing.length > 0) {
      await tx.debtRecord.updateMany({ where: { id: { in: existing.map((debt) => debt.id) } }, data: { deletedAt: new Date() } });
    }
    const updated = transaction.internalReceivableDebtCode || transaction.internalPayableDebtCode
      ? await tx.inventoryTransaction.update({
        where: { id: transaction.id },
        data: { internalReceivableDebtCode: null, internalPayableDebtCode: null },
        include: { lines: { include: { item: true } } },
      })
      : transaction;
    return { transaction: updated, receivable: null, payable: null };
  }

  // Đối tác nội bộ dùng chung với phiếu điều tiền/phân bổ chi phí — tạo sẵn nếu chưa có.
  const fromPartner = await ensureInternalPartner(tx as unknown as typeof prisma, fromBranch);
  const toPartner = await ensureInternalPartner(tx as unknown as typeof prisma, toBranch);

  const common = {
    partnerGroup: "INTERNAL",
    documentDate: transaction.transactionDate,
    originalAmount: totalValue,
    outstandingAmount: totalValue,
    sourceType: "INVENTORY_TRANSFER",
    sourceId: transaction.id,
    status: "OPEN",
    // Ghi rõ thay vì trông vào lớp xoá mềm: caller import dùng client thô, upsert không tự
    // khôi phục cặp mã đã xoá mềm của lần sửa trước.
    deletedAt: null,
  };
  const receivableData = {
    ...common,
    debtType: "RECEIVABLE",
    partnerCode: toPartner.code,
    partnerName: toPartner.name,
    branchCode: fromBranch,
    description: `${toBranch} nhận hàng theo phiếu điều chuyển ${transaction.code}`,
  };
  const payableData = {
    ...common,
    debtType: "PAYABLE",
    partnerCode: fromPartner.code,
    partnerName: fromPartner.name,
    branchCode: toBranch,
    description: `Nhận hàng từ ${fromBranch} theo phiếu điều chuyển ${transaction.code}`,
  };
  const receivable = await tx.debtRecord.upsert({
    where: { code: receivableCode },
    create: { code: receivableCode, ...receivableData },
    update: receivableData,
  });
  const payable = await tx.debtRecord.upsert({
    where: { code: payableCode },
    create: { code: payableCode, ...payableData },
    update: payableData,
  });

  const updated = await tx.inventoryTransaction.update({
    where: { id: transaction.id },
    data: { internalReceivableDebtCode: receivableCode, internalPayableDebtCode: payableCode },
    include: { lines: { include: { item: true } } },
  });

  return { transaction: updated, receivable, payable };
}
