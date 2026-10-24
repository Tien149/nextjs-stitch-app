import type { RawTxClient, TxClient } from "@/lib/prisma";
import { isInternalPartnerCode } from "@/lib/cost-reallocation";
import { roundVnd } from "@/lib/round-vnd";

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
/** Phiếu xuất trả hàng NCC — sinh khoản PHẢI THU NCC (cùng mã CN-<phiếu>, cùng sourceType). */
export const SUPPLIER_RETURN_TYPE = "XUAT_TRA_NCC";
const debtTypeOf = (transaction: { transactionType: string }) => (transaction.transactionType === SUPPLIER_RETURN_TYPE ? "RECEIVABLE" : "PAYABLE");
const debtDescriptionOf = (transaction: { transactionType: string; code: string; referenceCode: string | null }) => {
  const reference = transaction.referenceCode ? ` (chứng từ ${transaction.referenceCode})` : "";
  return transaction.transactionType === SUPPLIER_RETURN_TYPE
    ? `Trả hàng NCC theo phiếu xuất ${transaction.code}${reference} — giảm nợ NCC`
    : `Công nợ mua hàng theo phiếu nhập ${transaction.code}${reference}`;
};

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
  /** Chi phí mua hàng của phiếu (lib/purchase-cost.ts) — NCC thu chung hoá đơn nên cộng vào nợ. */
  purchaseCost?: number | null;
  lines: PurchasePayableLine[];
};

export type PurchasePayableLine = {
  itemId?: string;
  /** Số lượng theo ĐVT tồn — phiếu trả hàng tính số giảm nợ theo đơn giá phiếu nhập gốc. */
  quantity?: number;
  totalCost: number;
  vatAmount?: number | null;
  inputQuantity?: number | null;
  inputUnitCost?: number | null;
};

/**
 * Tiền hàng PHẢI TRẢ của một dòng — số KHAI TRÊN PHIẾU, không phải giá trị nhập kho.
 *
 * Hai số này lệch nhau đúng ở hàng khuyến mãi / tặng kèm: dòng đơn giá 0 được ĐỊNH GIÁ LẠI
 * theo bình quân của kho khi vào tồn, để giá vốn không bị hàng tặng kéo xuống (khách chốt
 * 20/09/2026) — nên `totalCost` của nó lớn hơn 0 dù không ai phải trả đồng nào. Lấy
 * `totalCost` làm số nợ là hệ thống ghi nhà hàng nợ NCC tiền của hàng được tặng; khách xác
 * nhận 21/09/2026 đây là sai.
 *
 * `inputUnitCost` trống nghĩa là khai 0 đ (xem resolveStockLine). Dòng cũ không lưu số khai
 * (`inputQuantity` trống) thì không có cách nào biết được, giữ nguyên `totalCost` để số nợ
 * của dữ liệu đã có không đổi.
 */
export function purchaseLineAmount(line: PurchasePayableLine) {
  if (line.inputQuantity === null || line.inputQuantity === undefined) return line.totalCost;
  return roundVnd(line.inputQuantity * (line.inputUnitCost || 0));
}

/**
 * Phiếu có thuộc diện sinh công nợ không, và nếu có thì bao nhiêu tiền.
 *
 * Số nợ là THÀNH TIỀN SAU THUẾ — đúng số trên hoá đơn NCC gửi và đúng số kế toán phải chuyển
 * đi. Khách chốt 21/09/2026: giá vốn tồn kho giữ số trước thuế (`totalCost`), phần thuế GTGT
 * đầu vào (`vatAmount`) chỉ cộng vào khoản phải trả. Dòng cũ chưa có cột thuế mang vatAmount
 * = 0 nên số nợ của dữ liệu đã có không đổi. Chi phí mua hàng của phiếu cộng thêm vào nợ.
 */
/**
 * Phiếu nhập gốc của một phiếu XUẤT TRẢ hàng NCC (referenceCode = mã phiếu nhập NM-…). Khách chốt
 * 24/10/2026: trả NCC phải đúng phiếu đã nhập — số giảm nợ = số lượng trả × (đơn giá trên phiếu
 * nhập + thuế GTGT của dòng), gạch thẳng vào công nợ của phiếu nhập đó.
 */
export async function supplierReturnSource(tx: PurchasePayableTx, transaction: Pick<PurchasePayableSource, "referenceCode" | "partnerCode">) {
  const code = (transaction.referenceCode || "").trim();
  if (!code) return null;
  const client = tx as RawTxClient;
  return client.inventoryTransaction.findFirst({
    where: { code, transactionType: "NHAP_MUA", deletedAt: null },
    include: { lines: true },
  });
}

/** Tiền phải trả trên phiếu nhập cho MỘT đơn vị tồn kho của từng mặt hàng (gồm thuế, không gồm chi phí mua hàng). */
export function payableUnitByItem(lines: Array<PurchasePayableLine & { itemId: string; quantity: number }>) {
  const totals = new Map<string, { amount: number; quantity: number }>();
  for (const line of lines) {
    const row = totals.get(line.itemId) || { amount: 0, quantity: 0 };
    row.amount += purchaseLineAmount(line) + (line.vatAmount || 0);
    row.quantity += line.quantity;
    totals.set(line.itemId, row);
  }
  return new Map([...totals.entries()].map(([itemId, row]) => [itemId, row.quantity > 0 ? row.amount / row.quantity : 0]));
}

/** Số giảm nợ của phiếu trả: tính theo phiếu nhập gốc; không có phiếu gốc thì theo trị giá xuất. */
async function supplierReturnAmount(tx: PurchasePayableTx, transaction: PurchasePayableSource) {
  if (!(transaction.partnerCode || "").trim()) return 0;
  const source = await supplierReturnSource(tx, transaction);
  if (!source) return roundVnd(transaction.lines.reduce((sum, line) => sum + (line.totalCost || 0), 0));
  const unitOf = payableUnitByItem(source.lines);
  return roundVnd(transaction.lines.reduce((sum, line) => sum + (line.quantity || 0) * (unitOf.get(line.itemId || "") || 0), 0));
}

async function debtAmountOf(tx: PurchasePayableTx, transaction: PurchasePayableSource) {
  if (transaction.transactionType === SUPPLIER_RETURN_TYPE) {
    const value = await supplierReturnAmount(tx, transaction);
    return value > 0 ? value : 0;
  }
  return payableAmountOf(transaction);
}

function payableAmountOf(transaction: PurchasePayableSource) {
  if (transaction.transactionType !== "NHAP_MUA") return 0;
  // Hàng nhận theo Đơn mua hàng đã có SupplierPayable (cột "Nhập hàng" trên bảng công nợ),
  // ghi thêm một khoản nữa ở đây là nợ NCC gấp đôi.
  if (transaction.referenceType === "PURCHASE_ORDER") return 0;
  if (!(transaction.partnerCode || "").trim()) return 0;
  // Chi phí mua hàng (vận chuyển...) NCC thu chung hoá đơn — khách chốt 13/10/2026 cộng vào nợ NCC.
  const amount = transaction.lines.reduce((sum, line) => sum + purchaseLineAmount(line) + (line.vatAmount || 0), 0) + (transaction.purchaseCost || 0);
  return amount > 0 ? amount : 0;
}

/**
 * Sinh khoản phải trả cho một phiếu nhập mua. Trả về null khi phiếu không thuộc diện:
 * không phải nhập mua, không khai NCC, hoặc cả phiếu khai 0 đ (hàng khuyến mãi, tặng kèm).
 */
export async function createPurchasePayable(
  tx: PurchasePayableTx,
  transaction: PurchasePayableSource,
  options: { importBatchId?: string | null; dueDate?: Date | null } = {},
) {
  const amount = await debtAmountOf(tx, transaction);
  if (amount <= 0) return null;
  const partnerCode = (transaction.partnerCode || "").trim();

  const client = tx as RawTxClient;
  const partner = await client.masterDataItem.findFirst({
    where: { type: "PARTNER", code: partnerCode },
    select: { name: true, partnerGroup: true },
  });
  return client.debtRecord.create({
    data: {
      importBatchId: options.importBatchId || null,
      code: purchasePayableCodeOf(transaction.code),
      debtType: debtTypeOf(transaction),
      partnerGroup: partner?.partnerGroup || (isInternalPartnerCode(partnerCode) ? "INTERNAL" : "EXTERNAL"),
      partnerCode,
      partnerName: partner?.name || partnerCode,
      branchCode: transaction.branchCode,
      documentDate: transaction.transactionDate,
      dueDate: options.dueDate || null,
      originalAmount: amount,
      outstandingAmount: amount,
      description: debtDescriptionOf(transaction),
      sourceType: PURCHASE_PAYABLE_SOURCE,
      sourceId: transaction.id,
      recognizeExpense: false,
      status: "OPEN",
    },
  }).then(async (debt) => {
    await linkSupplierReturn(tx, transaction, debt);
    return debt;
  });
}

/**
 * Đồng bộ khoản phải trả sau khi SỬA phiếu nhập: đổi số tiền / NCC / ngày thì sửa khoản nợ
 * đang có, phiếu không còn thuộc diện (bỏ NCC, sửa hết về 0) thì thu khoản nợ về.
 *
 * Không xoá-rồi-tạo-lại: xoá mềm vẫn giữ mã `CN-<phiếu>` trong chỉ mục duy nhất, tạo lại là
 * đâm trúng mã cũ.
 */
export async function syncPurchasePayable(
  tx: PurchasePayableTx,
  transaction: PurchasePayableSource,
  options: { importBatchId?: string | null; dueDate?: Date | null } = {},
) {
  const client = tx as RawTxClient;
  const existing = await client.debtRecord.findFirst({
    where: { code: purchasePayableCodeOf(transaction.code), sourceType: PURCHASE_PAYABLE_SOURCE, deletedAt: null },
  });
  if (!existing) return createPurchasePayable(tx, transaction, options);

  // Phiếu trả: gỡ phần đã cấn vào phiếu nhập gốc trước, tính lại rồi cấn lại.
  await unlinkSupplierReturn(tx, transaction.id);
  const amount = await debtAmountOf(tx, transaction);
  if (amount <= 0) {
    await client.debtRecord.delete({ where: { id: existing.id } });
    return null;
  }
  const partnerCode = (transaction.partnerCode || "").trim();
  const partner = await client.masterDataItem.findFirst({
    where: { type: "PARTNER", code: partnerCode },
    select: { name: true, partnerGroup: true },
  });
  return client.debtRecord.update({
    where: { id: existing.id },
    data: {
      partnerGroup: partner?.partnerGroup || (isInternalPartnerCode(partnerCode) ? "INTERNAL" : "EXTERNAL"),
      partnerCode,
      partnerName: partner?.name || partnerCode,
      branchCode: transaction.branchCode,
      documentDate: transaction.transactionDate,
      ...(options.dueDate !== undefined ? { dueDate: options.dueDate } : {}),
      debtType: debtTypeOf(transaction),
      originalAmount: amount,
      outstandingAmount: amount,
      description: debtDescriptionOf(transaction),
    },
  }).then(async (debt) => {
    await linkSupplierReturn(tx, transaction, debt);
    return debt;
  });
}

/** Gỡ các dòng cấn nợ do phiếu trả hàng này tạo, trả lại số còn nợ cho cả hai khoản. */
export async function unlinkSupplierReturn(tx: PurchasePayableTx, stockTransactionId: string) {
  const client = tx as RawTxClient;
  const settlements = await client.debtSettlement.findMany({ where: { stockTransactionId } });
  for (const settlement of settlements) {
    const debt = await client.debtRecord.findUnique({ where: { id: settlement.debtId } });
    if (debt) {
      const outstandingAmount = Math.min(debt.originalAmount, roundVnd(debt.outstandingAmount + settlement.amount));
      await client.debtRecord.update({ where: { id: debt.id }, data: { outstandingAmount, status: outstandingAmount >= debt.originalAmount ? "OPEN" : "PARTIAL" } });
    }
  }
  if (settlements.length > 0) await client.debtSettlement.deleteMany({ where: { stockTransactionId } });
}

/**
 * Cấn khoản giảm nợ của phiếu trả (CN-XTN… phải thu NCC) vào công nợ của phiếu nhập gốc (CN-NM…):
 * gạch cả hai một số bằng min(còn nợ phiếu nhập, giá trị trả). Phiếu nhập đã trả hết tiền thì phần
 * trả hàng đứng thành khoản NCC nợ lại mình.
 */
async function linkSupplierReturn(tx: PurchasePayableTx, transaction: PurchasePayableSource, debt: { id: string; outstandingAmount: number; debtType: string }) {
  if (transaction.transactionType !== SUPPLIER_RETURN_TYPE || debt.debtType !== "RECEIVABLE") return;
  const sourceCode = (transaction.referenceCode || "").trim();
  if (!sourceCode) return;
  const client = tx as RawTxClient;
  const payable = await client.debtRecord.findFirst({
    where: { code: purchasePayableCodeOf(sourceCode), sourceType: PURCHASE_PAYABLE_SOURCE, debtType: "PAYABLE", deletedAt: null },
  });
  if (!payable) return;
  const part = roundVnd(Math.min(payable.outstandingAmount, debt.outstandingAmount));
  if (!(part > 0)) return;
  const settlementDate = transaction.transactionDate;
  for (const target of [payable, debt]) {
    const outstandingAmount = roundVnd(target.outstandingAmount - part);
    await client.debtSettlement.create({ data: { debtId: target.id, stockTransactionId: transaction.id, settlementDate, amount: part, createdBy: "Hệ thống (trả hàng NCC)" } });
    await client.debtRecord.update({ where: { id: target.id }, data: { outstandingAmount, status: outstandingAmount <= 0 ? "SETTLED" : "PARTIAL" } });
  }
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
  // Phiếu TRẢ hàng bị xoá: gỡ phần đã cấn vào phiếu nhập gốc trước.
  const ownReturns = await client.debtRecord.findMany({
    where: { code: { in: codes }, sourceType: PURCHASE_PAYABLE_SOURCE, debtType: "RECEIVABLE" },
    select: { sourceId: true },
  });
  for (const row of ownReturns) if (row.sourceId) await unlinkSupplierReturn(tx, row.sourceId);
  const debts = await client.debtRecord.findMany({
    where: { code: { in: codes }, sourceType: PURCHASE_PAYABLE_SOURCE },
    include: { settlements: true },
  });
  const returned = debts.find((debt) => debt.settlements.some((settlement) => settlement.stockTransactionId));
  if (returned) {
    throw new Error(`Phiếu nhập của công nợ ${returned.code} đã có phiếu xuất trả hàng NCC — xoá phiếu trả hàng trước rồi mới xoá phiếu nhập.`);
  }
  const settled = debts.find((debt) => debt.settlements.length > 0);
  if (settled) {
    const message = `Công nợ ${settled.code} (mua hàng theo phiếu nhập) đã được gạch nợ nên không thể xoá phiếu. Hoàn tác phiếu chi gạch nợ trước.`;
    throw new Error(message);
  }
  const removed = await client.debtRecord.deleteMany({ where: { id: { in: debts.map((debt) => debt.id) } } });
  return removed.count;
}
