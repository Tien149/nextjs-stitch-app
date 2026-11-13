import { roundVnd } from "@/lib/round-vnd";
import { parseVatRate, vatAmountOf } from "@/lib/inventory-vat";

/**
 * Dòng công nợ khai tay tách thuế GTGT (khách 13/11/2026): trước thuế + thuế suất → tiền thuế →
 * sau thuế. Số SAU thuế vẫn là `originalAmount` mà báo cáo, sổ nợ và bút toán đọc như trước —
 * ba cột thuế chỉ để xem và in chứng từ. Dùng chung cho form (tính sẵn) và API (tính lại khi lưu).
 *
 * - Có trước thuế: tiền thuế = số khai (sửa tay vài đồng làm tròn theo hoá đơn), trống thì tự tính
 *   theo thuế suất; sau thuế = trước thuế + tiền thuế.
 * - Không khai trước thuế: dòng cũ, số tiền khai thẳng là số sau thuế, không tách thuế.
 */
export type DebtLineTaxInput = { amount: unknown; amountBeforeTax?: unknown; vatRate?: unknown; vatAmount?: unknown };
export type DebtLineTax =
  | { ok: true; amount: number; amountBeforeTax: number | null; vatRate: number | null; vatAmount: number | null }
  | { ok: false; reason: string };

const numberOf = (value: unknown) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : NaN;
};

export function resolveDebtLineTax(input: DebtLineTaxInput): DebtLineTax {
  const beforeTax = numberOf(input.amountBeforeTax);
  if (beforeTax === null || beforeTax === 0) {
    const amount = numberOf(input.amount);
    return { ok: true, amount: roundVnd(Number(amount) || 0), amountBeforeTax: null, vatRate: null, vatAmount: null };
  }
  if (!(beforeTax > 0)) return { ok: false, reason: "Số tiền trước thuế phải lớn hơn 0" };
  const rate = parseVatRate(input.vatRate);
  if (!rate.ok) return { ok: false, reason: "Thuế suất GTGT không hợp lệ" };
  const declaredVat = numberOf(input.vatAmount);
  if (declaredVat !== null && !(declaredVat >= 0)) return { ok: false, reason: "Tiền thuế không được âm" };
  const amountBeforeTax = roundVnd(beforeTax);
  const vatAmount = declaredVat === null ? vatAmountOf(amountBeforeTax, rate.rate) : roundVnd(declaredVat);
  return { ok: true, amount: amountBeforeTax + vatAmount, amountBeforeTax, vatRate: rate.rate, vatAmount };
}
