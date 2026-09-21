import type { RawTxClient, TxClient } from "@/lib/prisma";
import { isInternalPartnerCode } from "@/lib/cost-reallocation";

/**
 * Công nợ phải trả sinh từ phiếu NHẬP MUA (import file Nhập/Xuất kho hoặc ghi tay ở màn Nhập kho).
 *
 * Trước 21/09/2026 hàng nhập bằng file chỉ vào kho, không ai nợ ai: cột "Nhập hàng" trên bảng
 * công nợ chỉ đếm hàng nhận theo Đơn mua hàng (SupplierPayable), còn cột "CN phải trả" chỉ đếm
 * khoản khai tay / import bằng file công nợ. Khách đẩy nhập mua rồi không thấy nợ NCC đâu.
 *
 * Khoản này KHÔNG ghi chi phí (`recognizeExpense = false`): chi phí và giá vốn của hệ thống vẫn
 * đến từ phiếu chi mua hàng (Nợ 632), ghi thêm ở đây là tính chi phí hai lần — cùng lý do với
 * công nợ sinh từ lương / tài sản / điều chuyển kho.
 */
export const PURCHASE_PAYABLE_SOURCE = "INVENTORY_PURCHASE";

/** Mã khoản nợ suy ra thẳng từ mã phiếu nhập, nên một phiếu không bao giờ sinh hai khoản nợ. */
export function purchasePayableCodeOf(transactionCode: string) {
  return `CN-${transactionCode}`;
}

type PurchasePayableTx = RawTxClient | TxClient;

export type PurchasePayableSource = {
  id: string;
  code: string;
  transactionType: string;
  transactionDate: Date;
  branchCode: string;
  partnerCode: string | null;
  referenceType?: string | null;
  referenceCode: string | null;
  lines: Array<{ totalCost: number }>;
};

/**
 * Sinh khoản phải trả cho một phiếu nhập mua. Trả về null khi phiếu không thuộc diện:
 * không phải nhập mua, không khai NCC, hoặc giá trị bằng 0 (hàng khuyến mãi, tặng kèm).
 */
export async function createPurchasePayable(
  tx: PurchasePayableTx,
  transaction: PurchasePayableSource,
  options: { importBatchId?: string | null; dueDate?: Date | null } = {},
) {
  if (transaction.transactionType !== "NHAP_MUA") return null;
  // Hàng nhận theo Đơn mua hàng đã có SupplierPayable (cột "Nhập hàng" trên bảng công nợ),
  // ghi thêm một khoản nữa ở đây là nợ NCC gấp đôi.
  if (transaction.referenceType === "PURCHASE_ORDER") return null;
  const partnerCode = (transaction.partnerCode || "").trim();
  if (!partnerCode) return null;
  const amount = transaction.lines.reduce((sum, line) => sum + line.totalCost, 0);
  if (amount <= 0) return null;

  const client = tx as RawTxClient;
  const partner = await client.masterDataItem.findFirst({
    where: { type: "PARTNER", code: partnerCode },
    select: { name: true, partnerGroup: true },
  });
  const reference = transaction.referenceCode ? ` (chứng từ ${transaction.referenceCode})` : "";
  return client.debtRecord.create({
    data: {
      importBatchId: options.importBatchId || null,
      code: purchasePayableCodeOf(transaction.code),
      debtType: "PAYABLE",
      partnerGroup: partner?.partnerGroup || (isInternalPartnerCode(partnerCode) ? "INTERNAL" : "EXTERNAL"),
      partnerCode,
      partnerName: partner?.name || partnerCode,
      branchCode: transaction.branchCode,
      documentDate: transaction.transactionDate,
      dueDate: options.dueDate || null,
      originalAmount: amount,
      outstandingAmount: amount,
      description: `Công nợ mua hàng theo phiếu nhập ${transaction.code}${reference}`,
      sourceType: PURCHASE_PAYABLE_SOURCE,
      sourceId: transaction.id,
      recognizeExpense: false,
      status: "OPEN",
    },
  });
}

/**
 * Thu hồi khoản phải trả khi phiếu nhập bị xoá / lô import bị rollback.
 *
 * Đã gạch nợ bằng phiếu chi thì chặn: xoá khoản nợ mà để phiếu chi đứng một mình là công nợ
 * đối tác âm không giải thích được. Hoàn tác phiếu gạch trước rồi mới xoá phiếu nhập.
 */
export async function removePurchasePayables(tx: PurchasePayableTx, transactionCodes: string[]) {
  if (transactionCodes.length === 0) return 0;
  const client = tx as RawTxClient;
  const codes = transactionCodes.map(purchasePayableCodeOf);
  const debts = await client.debtRecord.findMany({
    where: { code: { in: codes }, sourceType: PURCHASE_PAYABLE_SOURCE },
    include: { settlements: true },
  });
  const settled = debts.find((debt) => debt.settlements.length > 0);
  if (settled) {
    const message = `Công nợ ${settled.code} (mua hàng theo phiếu nhập) đã được gạch nợ nên không thể xoá phiếu. Hoàn tác phiếu chi gạch nợ trước.`;
    throw new Error(message);
  }
  const removed = await client.debtRecord.deleteMany({ where: { id: { in: debts.map((debt) => debt.id) } } });
  return removed.count;
}
