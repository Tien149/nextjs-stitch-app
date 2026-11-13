"use client";

import type { ReactNode } from "react";
import { MoneyInput } from "@/components/MoneyInput";
import { PriceInput } from "@/components/PriceInput";
import { QuantityInput } from "@/components/QuantityInput";
import { SearchableSelect } from "@/components/SearchableSelect";
import { money, quantity as qty, unitPrice } from "@/lib/format-number";
import { parseVatRate, VAT_RATE_CODES } from "@/lib/inventory-vat";
import { purchaseLineFigures, resolveDiscount, type PurchaseLineFigures } from "@/lib/purchase-discount";

/** Ô nhập của một dòng nhận hàng — chuỗi thô như người dùng gõ. */
export type ReceiveLineValue = { quantity: string; price: string; discountRate: string; discountAmount: string; vatRate: string };
/**
 * `isExtra`: dòng THÊM lúc nhận (NCC giao thêm chung phiếu, khách 26/10/2026) — không có "còn phải nhận".
 * `unitControl`: ô chọn ĐVT, đứng ngay cạnh tên hàng; `onRemove`: nút bỏ dòng ở cuối dòng.
 */
export type ReceiveLineInfo = {
  id: string; name: string; unit: string; remaining: number; hint: string;
  badge?: ReactNode; extra?: ReactNode; isExtra?: boolean;
  unitControl?: ReactNode; onRemove?: () => void;
};

export const emptyReceiveTerms = { discountRate: "", discountAmount: "", vatRate: "KKKNT" };

/** Các cột tính được của từng dòng + tổng — cha dùng để hiện tổng công nợ ở chân form. */
export function receiveFigures(lines: ReceiveLineInfo[], values: Record<string, ReceiveLineValue>, purchaseCost: number) {
  const rows = purchaseLineFigures(lines.map((line) => {
    const value = values[line.id];
    const vat = parseVatRate(value?.vatRate);
    return {
      quantity: Number(value?.quantity || 0) || 0,
      unitPrice: Number(value?.price || 0) || 0,
      discountRate: value?.discountRate,
      discountAmount: value?.discountAmount,
      vatRate: vat.ok ? vat.rate : null,
    };
  }), purchaseCost);
  const sum = (key: keyof PurchaseLineFigures) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  return {
    rows,
    total: { gross: sum("gross"), discountAmount: sum("discountAmount"), vatAmount: sum("vatAmount"), afterTax: sum("afterTax"), costShare: sum("costShare"), purchaseValue: sum("purchaseValue") },
  };
}

/** Lỗi chiết khấu của dòng (% ngoài 0–100, số tiền vượt thành tiền) — chặn bấm Xác nhận. */
export function receiveLineErrors(lines: ReceiveLineInfo[], values: Record<string, ReceiveLineValue>) {
  return lines.flatMap((line) => {
    const value = values[line.id];
    const gross = Math.round((Number(value?.quantity || 0) || 0) * (Number(value?.price || 0) || 0));
    const discount = resolveDiscount(gross, value?.discountRate, value?.discountAmount);
    return discount.ok ? [] : [`${line.name}: ${discount.reason}`];
  });
}

/**
 * Bảng nhận hàng theo PO (khách 26/10/2026): SL, đơn giá, thành tiền trước thuế, chiết khấu (% hoặc
 * số tiền, sửa được), thuế suất, tiền thuế, sau thuế, chi phí mua phân bổ, trị giá mua hàng.
 * Dùng chung cho màn Mua hàng (bảng rộng trên máy tính) và form Nhập kho (`cardsOnly`, cột hẹp).
 */
export function PurchaseReceiveLines({ lines, values, onChange, purchaseCost, cardsOnly = false, addOptions, onAdd }: {
  lines: ReceiveLineInfo[];
  values: Record<string, ReceiveLineValue>;
  onChange: (lineId: string, patch: Partial<ReceiveLineValue>) => void;
  purchaseCost: number;
  cardsOnly?: boolean;
  /** Mặt hàng chọn được để THÊM dòng ngay lúc nhận; không truyền thì không có ô thêm. */
  addOptions?: Array<{ value: string; label: string; subLabel?: string }>;
  onAdd?: (itemId: string) => void;
}) {
  const { rows, total } = receiveFigures(lines, values, purchaseCost);
  const valueOf = (lineId: string) => values[lineId] || { quantity: "", price: "", ...emptyReceiveTerms };

  const quantityInput = (line: ReceiveLineInfo) => (
    <QuantityInput className="control !mt-0 w-full text-right" value={valueOf(line.id).quantity} onChange={(quantity) => onChange(line.id, { quantity })} ariaLabel={`Số lượng nhận ${line.name}`} />
  );
  // Đơn giá hiện phân cách hàng nghìn "16.000" (khách 13/11/2026), số lẻ gõ bằng dấu phẩy.
  const priceInput = (line: ReceiveLineInfo) => (
    <PriceInput
      className={`control !mt-0 w-full text-right ${!(Number(valueOf(line.id).price) > 0) ? "border-amber-400 bg-amber-50" : ""}`}
      placeholder="Giá thực"
      value={valueOf(line.id).price}
      onChange={(price) => onChange(line.id, { price })}
      ariaLabel={`Đơn giá nhận ${line.name}`}
    />
  );
  // Gõ % thì xoá số tiền và ngược lại — dòng chỉ theo một cách khai.
  const discountRateInput = (line: ReceiveLineInfo) => (
    <input
      type="number" min="0" max="100" step="any" inputMode="decimal"
      className="control !mt-0 w-full text-right" placeholder="%"
      value={valueOf(line.id).discountRate}
      onChange={(e) => onChange(line.id, { discountRate: e.target.value, discountAmount: "" })}
      aria-label={`Chiết khấu % ${line.name}`}
    />
  );
  const discountAmountInput = (line: ReceiveLineInfo, figures: PurchaseLineFigures) => (
    <MoneyInput
      className="control !mt-0 w-full text-right" placeholder="0"
      value={valueOf(line.id).discountRate ? String(figures.discountAmount) : valueOf(line.id).discountAmount}
      onChange={(discountAmount) => onChange(line.id, { discountAmount, discountRate: "" })}
      ariaLabel={`Tiền chiết khấu ${line.name}`}
    />
  );
  const vatInput = (line: ReceiveLineInfo) => (
    <select className="control !mt-0 w-full !px-1.5" value={valueOf(line.id).vatRate || "KKKNT"} onChange={(e) => onChange(line.id, { vatRate: e.target.value })} aria-label={`Thuế suất ${line.name}`}>
      {VAT_RATE_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
    </select>
  );

  const removeButton = (line: ReceiveLineInfo) => line.onRemove ? (
    <button type="button" onClick={line.onRemove} title="Bỏ dòng" aria-label={`Bỏ dòng ${line.name}`}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-rose-600 hover:bg-rose-50">
      <span className="material-symbols-outlined text-[18px]">close</span>
    </button>
  ) : null;

  const cards = (
    <div className={`space-y-3 ${cardsOnly ? "@2xl:hidden" : "lg:hidden"}`}>
      {lines.map((line, index) => {
        const figures = rows[index];
        return (
          <div key={line.id} className="space-y-2 rounded-xl border border-slate-200 p-3">
            <div className="min-w-0">
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 font-bold text-sm leading-snug">{line.name} {line.badge}</p>
                {line.unitControl}
                {removeButton(line)}
              </div>
              <p className="text-xs text-slate-500">{line.isExtra ? line.hint : <>Còn phải nhận: <b>{qty(line.remaining)} {line.unit}</b> · {line.hint}</>}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-500">
              <label className="block">SL nhận ({line.unit}){quantityInput(line)}</label>
              <label className="block">Đơn giá (đ/{line.unit}){priceInput(line)}</label>
              <label className="block">Chiết khấu %{discountRateInput(line)}</label>
              <label className="block">Tiền chiết khấu{discountAmountInput(line, figures)}</label>
              <label className="block col-span-2">Thuế suất GTGT{vatInput(line)}</label>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-slate-500">Thành tiền trước thuế</dt><dd className="text-right tabular-nums">{money(figures.gross)}</dd>
              <dt className="text-slate-500">Tiền thuế</dt><dd className="text-right tabular-nums">{money(figures.vatAmount)}</dd>
              <dt className="text-slate-500">Thành tiền sau thuế</dt><dd className="text-right tabular-nums">{money(figures.afterTax)}</dd>
              <dt className="text-slate-500">Chi phí mua phân bổ</dt><dd className="text-right tabular-nums">{money(figures.costShare)}</dd>
              <dt className="font-bold text-slate-700">Trị giá mua hàng</dt><dd className="text-right font-bold tabular-nums">{money(figures.purchaseValue)}</dd>
            </dl>
            {line.extra}
          </div>
        );
      })}
    </div>
  );
  // Ô thêm dòng: NCC giao thêm hàng gọi bổ sung, nhận chung phiếu PO này (khách 26/10/2026).
  const addPicker = addOptions && onAdd ? (
    <div className="mt-2">
      <SearchableSelect value="" onChange={(itemId) => { if (itemId) onAdd(itemId); }} options={addOptions} placeholder="+ Thêm mặt hàng NCC giao thêm..." />
    </div>
  ) : null;
  /**
   * Form Nhập kho (khách 13/11/2026): khung đủ rộng thì mỗi mặt hàng MỘT dòng, ĐVT ngay cạnh tên;
   * khung hẹp (điện thoại) vẫn là thẻ. Đo theo bề rộng khung (@container) chứ không theo màn hình,
   * vì form nằm ở nửa phải hộp thoại.
   */
  const lineGrid = "grid grid-cols-[minmax(0,1fr)_4.5rem_6.5rem_3.5rem_6rem_5rem_7rem_1.75rem] items-start gap-1.5";
  const compactRows = (
    <div className="hidden @2xl:block rounded-xl border border-slate-200">
      <div className={`${lineGrid} border-b border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-bold uppercase text-slate-500 [&>span:not(:first-child)]:text-right`}>
        <span>Mặt hàng</span><span>SL</span><span>Đơn giá</span><span>CK %</span><span>Tiền CK</span><span>Thuế</span><span>Thành tiền</span><span />
      </div>
      {lines.map((line, index) => {
        const figures = rows[index];
        return (
          <div key={line.id} className={`${lineGrid} border-b border-slate-100 px-2 py-2 last:border-b-0`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm font-bold leading-snug text-slate-800">{line.name} {line.badge}</p>
                {line.unitControl || <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-600">{line.unit}</span>}
              </div>
              <p className="text-[11px] text-slate-500">{line.isExtra ? line.hint : <>Còn {qty(line.remaining)} {line.unit}{line.hint ? ` · ${line.hint}` : ""}</>}</p>
              {line.extra}
            </div>
            {quantityInput(line)}
            {priceInput(line)}
            {discountRateInput(line)}
            {discountAmountInput(line, figures)}
            {vatInput(line)}
            <p className="pt-2 text-right text-sm font-bold tabular-nums text-slate-800"
              title={`Trước thuế ${money(figures.gross)} · Thuế ${money(figures.vatAmount)} · CP mua phân bổ ${money(figures.costShare)} · Trị giá mua hàng ${money(figures.purchaseValue)}`}>
              {money(figures.afterTax)}
            </p>
            {removeButton(line) || <span />}
          </div>
        );
      })}
    </div>
  );
  // Dòng tổng cả phiếu — chữ to, nổi màu để đối chiếu nhanh với chứng từ giấy.
  const totalQuantity = lines.reduce((sum, line) => sum + (Number(valueOf(line.id).quantity) || 0), 0);
  const totalUnits = [...new Set(lines.map((line) => line.unit))];
  const totals = lines.length > 0 ? (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-blue-900">
      <p className="text-sm font-semibold">
        Tổng số lượng: <b className="text-lg tabular-nums">{qty(totalQuantity)}</b>
        {totalUnits.length === 1 ? ` ${totalUnits[0]}` : ""} <span className="text-xs font-normal">({lines.length} dòng)</span>
      </p>
      <p className="text-sm font-semibold">
        Tổng tiền (sau thuế): <b className="text-xl tabular-nums">{money(total.afterTax)} đ</b>
      </p>
      {total.costShare > 0 && (
        <p className="w-full text-right text-xs">Trị giá mua hàng (gồm chi phí mua {money(total.costShare)} đ): <b className="tabular-nums">{money(total.purchaseValue)} đ</b></p>
      )}
    </div>
  ) : null;
  if (cardsOnly) return <div className="@container space-y-3">{cards}{compactRows}{totals}{addPicker}</div>;

  const head = ["Mặt hàng", "SL nhận", "Đơn giá", "Thành tiền trước thuế", "CK %", "Tiền CK", "Thuế suất", "Tiền thuế", "Thành tiền sau thuế", "CP mua phân bổ", "Trị giá mua hàng"];
  return (
    <>
      {cards}
      <div className="hidden lg:block overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
            <tr>{head.map((label, index) => <th key={label} className={`px-2 py-2 font-bold ${index === 0 ? "text-left" : "text-right"}`}>{label}</th>)}</tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const figures = rows[index];
              return (
                <tr key={line.id} className="border-t border-slate-100 align-top">
                  <td className="px-2 py-2 min-w-[180px]">
                    <p className="font-bold text-slate-800">{line.name} {line.badge}</p>
                    <p className="text-[11px] text-slate-500">{line.isExtra ? line.hint : `Còn ${qty(line.remaining)} ${line.unit} · ${line.hint}`}</p>
                    {line.extra}
                  </td>
                  <td className="px-1 py-2 w-24">{quantityInput(line)}</td>
                  <td className="px-1 py-2 w-28">{priceInput(line)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{money(figures.gross)}</td>
                  <td className="px-1 py-2 w-16">{discountRateInput(line)}</td>
                  <td className="px-1 py-2 w-28">{discountAmountInput(line, figures)}</td>
                  <td className="px-1 py-2 w-24">{vatInput(line)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{money(figures.vatAmount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{money(figures.afterTax)}</td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">{money(figures.costShare)}</td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums whitespace-nowrap">{money(figures.purchaseValue)}</td>
                </tr>
              );
            })}
          </tbody>
          {/* Dòng Cộng chữ to + màu, để đối chiếu nhanh với chứng từ giấy (khách 13/11/2026). */}
          <tfoot className="border-t-2 border-blue-200 bg-blue-50 text-sm font-bold text-blue-900">
            <tr>
              <td className="px-2 py-2.5 text-base">Cộng <span className="text-xs font-semibold">({lines.length} dòng)</span></td>
              <td className="px-2 py-2.5 text-right tabular-nums text-base">{qty(totalQuantity)}{totalUnits.length === 1 ? ` ${totalUnits[0]}` : ""}</td>
              <td />
              <td className="px-2 py-2 text-right tabular-nums">{money(total.gross)}</td>
              <td />
              <td className="px-2 py-2 text-right tabular-nums">{money(total.discountAmount)}</td>
              <td />
              <td className="px-2 py-2 text-right tabular-nums">{money(total.vatAmount)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-base">{money(total.afterTax)}</td>
              <td className="px-2 py-2 text-right tabular-nums">{money(total.costShare)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums text-base">{money(total.purchaseValue)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {totals && <div className="lg:hidden">{totals}</div>}
      {addPicker}
    </>
  );
}

/** Đơn giá PO dạng chữ cho dòng gợi ý. */
export function poPriceHint(poPrice: number, unit: string, suggestedSource?: string) {
  if (poPrice > 0) return `giá PO ${unitPrice(poPrice)} đ/${unit}`;
  return suggestedSource ? `PO chưa có giá · gợi ý theo ${suggestedSource}` : "PO chưa có giá — nhập giá thực";
}

/**
 * Ô ĐVT nhận của dòng PO (khách 27/10/2026: PO đặt THÙNG, NCC giao lẻ KG thì nhận theo KG) —
 * `options` từ receiveUnitOptions (lib/unit-conversion), chỉ hiện khi có hơn một ĐVT.
 */
export function ReceiveUnitSelect({ name, value, options, onChange }: {
  name: string;
  value: string;
  options: Array<{ unitCode: string; label: string }>;
  onChange: (unitCode: string) => void;
}) {
  if (options.length < 2) return null;
  return (
    <select className="control !mt-0 !h-8 !py-0 w-auto text-xs" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`ĐVT nhận ${name}`}>
      {options.map((option) => <option key={option.unitCode} value={option.unitCode}>{option.label}</option>)}
    </select>
  );
}

/** Đổi ĐVT nhận: quy số lượng + đơn giá đã gõ sang ĐVT mới để thành tiền giữ nguyên. */
export function convertReceiveValue(value: { quantity: string; price: string }, fromRate: number, toRate: number) {
  if (!(fromRate > 0) || !(toRate > 0) || fromRate === toRate) return value;
  const factor = toRate / fromRate;
  return {
    quantity: value.quantity === "" ? "" : String(Math.round((Number(value.quantity) / factor) * 1e6) / 1e6),
    price: value.price === "" ? "" : String(Math.round(Number(value.price) * factor * 100) / 100),
  };
}
