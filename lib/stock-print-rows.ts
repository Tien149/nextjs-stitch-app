import { roundVnd } from "@/lib/round-vnd";

/**
 * Số in của một dòng phiếu nhập mua — dùng chung cho bản in một phiếu (/inventory/[id]/print) và in
 * gộp nhiều phiếu cùng NCC (/inventory/print). In theo đúng ĐVT người dùng đã nhập trên phiếu.
 */
export type StockPrintLine = {
  id: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  inputQuantity: number | null;
  inputUnitCode: string | null;
  inputUnitCost: number | null;
  conversionRate: number;
  vatRate: number | null;
  vatAmount: number;
  purchaseCostShare?: number;
  discountRate?: number | null;
  discountAmount?: number;
  note?: string | null;
  item: { code: string; name: string; unit: string };
};

export function stockPrintRow<T extends StockPrintLine>(line: T, transactionType: string) {
  const hasInput = line.inputQuantity !== null && line.inputQuantity !== undefined && Boolean(line.inputUnitCode);
  const printQuantity = hasInput ? Number(line.inputQuantity) : line.quantity;
  const printUnit = hasInput ? String(line.inputUnitCode) : line.item.unit;
  const printUnitPrice = hasInput ? line.inputUnitCost ?? line.unitCost * (line.conversionRate || 1) : line.unitCost;
  // Thành tiền in theo hoá đơn NCC (SL × đơn giá); chi phí mua hàng in riêng.
  const printAmount = line.totalCost - (line.purchaseCostShare || 0) - (transactionType.startsWith("NHAP_") ? line.vatAmount || 0 : 0);
  return { ...line, printQuantity, printUnit, printUnitPrice, printAmount };
}

/**
 * Phiếu NHẬP MUA in đủ cột như màn nhận hàng (khách 26/10/2026): thành tiền trước thuế = SL × đơn giá
 * NCC, chiết khấu, thuế suất, tiền thuế, sau thuế, chi phí mua hàng phân bổ, trị giá mua hàng.
 */
export function purchasePrintRow<T extends StockPrintLine>(line: T) {
  const row = stockPrintRow(line, "NHAP_MUA");
  const discount = row.discountAmount || 0;
  const gross = row.inputQuantity !== null && row.inputQuantity !== undefined
    ? roundVnd(Number(row.inputQuantity) * (row.inputUnitCost || 0))
    : row.printAmount + discount;
  const afterTax = gross - discount + (row.vatAmount || 0);
  const share = row.purchaseCostShare || 0;
  return { ...row, gross, discount, afterTax, share, purchaseValue: afterTax + share };
}

export type PurchasePrintTotalKey = "gross" | "discount" | "vatAmount" | "afterTax" | "share" | "purchaseValue";
export function purchasePrintTotal(rows: Array<Record<PurchasePrintTotalKey, number>>, key: PurchasePrintTotalKey) {
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}
