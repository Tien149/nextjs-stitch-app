import { roundVnd } from "@/lib/round-vnd";
import { allocatePurchaseCost } from "@/lib/purchase-cost";
import { vatAmountOf } from "@/lib/inventory-vat";

/**
 * Chiết khấu trên từng dòng phiếu nhập mua / nhận hàng PO (khách 26/10/2026). Khai theo % HOẶC gõ
 * thẳng số tiền; chiết khấu TRỪ TRƯỚC THUẾ — thuế GTGT tính trên tiền hàng sau chiết khấu.
 *
 * Bảng cột khách yêu cầu, theo thứ tự trên màn hình và phiếu in:
 *   Thành tiền trước thuế = SL × đơn giá
 *   Chiết khấu            = % × thành tiền (hoặc số khai)
 *   Tiền thuế             = (thành tiền − chiết khấu) × thuế suất
 *   Thành tiền sau thuế   = thành tiền − chiết khấu + tiền thuế
 *   Chi phí mua phân bổ   = chi phí mua hàng của phiếu chia theo tiền hàng sau chiết khấu
 *   Trị giá mua hàng      = sau thuế + chi phí phân bổ (= giá trị nhập kho, giá vốn sau thuế từ 21/10/2026)
 */
export function resolveDiscount(gross: number, rate: unknown, amount: unknown):
  { ok: true; rate: number | null; amount: number } | { ok: false; reason: string } {
  const base = roundVnd(Math.max(0, Number(gross) || 0));
  const rateText = rate === null || rate === undefined ? "" : String(rate).trim().replace(",", ".").replace("%", "");
  const amountText = amount === null || amount === undefined ? "" : String(amount).trim();
  if (rateText !== "") {
    const percent = Number(rateText);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { ok: false, reason: "Chiết khấu % phải từ 0 tới 100" };
    return { ok: true, rate: percent / 100, amount: roundVnd(base * percent / 100) };
  }
  if (amountText !== "") {
    const value = roundVnd(Number(amountText.replace(/\./g, "").replace(",", ".")));
    if (!Number.isFinite(value) || value < 0) return { ok: false, reason: "Tiền chiết khấu không được âm" };
    if (value > base) return { ok: false, reason: "Tiền chiết khấu lớn hơn thành tiền của dòng" };
    return { ok: true, rate: null, amount: value };
  }
  return { ok: true, rate: null, amount: 0 };
}

export type PurchaseLineFigures = {
  gross: number;
  discountRate: number | null;
  discountAmount: number;
  net: number;
  vatAmount: number;
  afterTax: number;
  costShare: number;
  purchaseValue: number;
};

/**
 * Tính đủ các cột của từng dòng + phân bổ chi phí mua hàng — dùng cho màn hình (xem trước) và phiếu
 * in, cùng công thức với lib/inventory-stock.ts để số hiện ra đúng số máy chủ ghi.
 */
export function purchaseLineFigures(
  lines: Array<{ quantity: number; unitPrice: number; discountRate?: unknown; discountAmount?: unknown; vatRate: number | null; vatAmount?: number | null }>,
  purchaseCost: number,
): PurchaseLineFigures[] {
  const base = lines.map((line) => {
    const gross = roundVnd((Number(line.quantity) || 0) * (Number(line.unitPrice) || 0));
    const discount = resolveDiscount(gross, line.discountRate, line.discountAmount);
    const discountAmount = discount.ok ? discount.amount : 0;
    const net = gross - discountAmount;
    const vatAmount = line.vatAmount === null || line.vatAmount === undefined ? vatAmountOf(net, line.vatRate) : roundVnd(line.vatAmount);
    return { gross, discountRate: discount.ok ? discount.rate : null, discountAmount, net, vatAmount, afterTax: net + vatAmount, quantity: Number(line.quantity) || 0 };
  });
  const shares = allocatePurchaseCost(purchaseCost, base.map((line) => ({ amount: line.net, quantity: line.quantity })));
  return base.map((line, index) => ({
    gross: line.gross,
    discountRate: line.discountRate,
    discountAmount: line.discountAmount,
    net: line.net,
    vatAmount: line.vatAmount,
    afterTax: line.afterTax,
    costShare: shares[index] || 0,
    purchaseValue: line.afterTax + (shares[index] || 0),
  }));
}
