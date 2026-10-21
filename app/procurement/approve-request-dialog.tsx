"use client";

import { useEffect, useState } from "react";
import { PartnerPicker, type CreatedPartner } from "@/components/PartnerPicker";
import { money, quantity as qty } from "@/lib/format-number";
import { purchaseLineUnit, toPurchasePrice, toPurchaseQuantity, type PurchaseUnitLine } from "@/lib/unit-conversion";

type ApproveLine = PurchaseUnitLine & { id: string; itemId: string; quantity: number; item: { code: string; name: string; unit: string } };
type ApproveQuote = { supplierCode: string; supplierName: string; isSelected: boolean; lines: Array<PurchaseUnitLine & { itemId: string; unitCost: number }> };
export type ApprovableRequest = { id: string; code: string; branchCode: string; reason: string; warehouseCode?: string | null; lines: ApproveLine[]; quotes: ApproveQuote[] };
type Option = { value: string; label: string; subLabel?: string };

/**
 * Thu mua duyệt PR → lên PO luôn (khách 21/10/2026). Chọn NCC + kho nhận; đơn giá theo ĐVT đặt tự
 * điền từ báo giá của NCC đó trên PR, không có thì từ Bảng giá NCC đang hiệu lực. CHƯA CÓ GIÁ VẪN
 * DUYỆT ĐƯỢC — để trống, giá thực nhập lúc nhận hàng.
 */
export function ApproveRequestDialog({
  request,
  supplierOptions,
  warehouses,
  defaultWarehouse,
  canCreatePartner,
  onSupplierCreated,
  onClose,
  onApproved,
}: {
  request: ApprovableRequest;
  supplierOptions: Option[];
  warehouses: Array<{ code: string; name: string }>;
  defaultWarehouse: string;
  canCreatePartner: boolean;
  onSupplierCreated: (partner: CreatedPartner) => void;
  onClose: () => void;
  onApproved: (message: string) => Promise<void> | void;
}) {
  const initialQuote = request.quotes.find((quote) => quote.isSelected) || null;
  const [supplierCode, setSupplierCode] = useState(initialQuote?.supplierCode || "");
  const [supplierName, setSupplierName] = useState(initialQuote?.supplierName || "");
  const [warehouseCode, setWarehouseCode] = useState(request.warehouseCode || defaultWarehouse);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [priceSource, setPriceSource] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Đổi NCC → dựng lại giá: báo giá của NCC trên PR, rồi bảng giá đang hiệu lực, còn lại để trống.
  useEffect(() => {
    if (!supplierCode) return;
    let cancelled = false;
    const quote = request.quotes.find((candidate) => candidate.supplierCode === supplierCode);
    const query = new URLSearchParams({ view: "active-prices", supplierCode, branchCode: request.branchCode });
    void fetch(`/api/procurement?${query.toString()}`)
      .then(async (response) => (response.ok ? await response.json() as { prices: Array<{ itemId: string; stockUnitPrice: number; unitPrice: number; unitCode: string; priceListCode: string }> } : { prices: [] }))
      .catch(() => ({ prices: [] }))
      .then((payload) => {
        if (cancelled) return;
        const byItem = new Map(payload.prices.map((price) => [price.itemId, price]));
        const nextPrices: Record<string, string> = {};
        const sources: Record<string, string> = {};
        for (const line of request.lines) {
          const quoteLine = quote?.lines.find((candidate) => candidate.itemId === line.itemId);
          const listed = byItem.get(line.itemId);
          if (quoteLine && quoteLine.unitCost > 0) {
            nextPrices[line.id] = String(toPurchasePrice(quoteLine.unitCost, line));
            sources[line.id] = "Báo giá";
          } else if (listed) {
            nextPrices[line.id] = String(listed.unitCode === purchaseLineUnit(line) ? listed.unitPrice : Math.round(toPurchasePrice(listed.stockUnitPrice, line) * 100) / 100);
            sources[line.id] = `Bảng giá ${listed.priceListCode}`;
          } else {
            nextPrices[line.id] = "";
          }
        }
        setPrices(nextPrices);
        setPriceSource(sources);
      });
    return () => { cancelled = true; };
  }, [supplierCode, request]);

  const total = request.lines.reduce((sum, line) => sum + toPurchaseQuantity(line.quantity, line) * Number(prices[line.id] || 0), 0);
  const unpriced = request.lines.filter((line) => !(Number(prices[line.id]) > 0)).length;

  const approve = async () => {
    if (!supplierCode) {
      setError("Chọn nhà cung cấp để lên PO.");
      return;
    }
    if (!warehouseCode) {
      setError("Chọn kho nhận hàng.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/procurement", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "APPROVE_REQUEST",
          requestId: request.id,
          supplierCode,
          supplierName,
          warehouseCode,
          lines: request.lines.map((line) => ({ lineId: line.id, unitCost: Number(prices[line.id] || 0) })),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { code?: string; error?: string };
      if (!response.ok) {
        setError(payload.error || "Không duyệt được yêu cầu mua");
        return;
      }
      await onApproved(`Đã duyệt ${request.code} → PO ${payload.code}${unpriced > 0 ? ` (${unpriced} dòng chưa có giá — nhập giá thực lúc nhận hàng)` : ""}. Gửi PO cho NCC ở tab Đơn mua hàng.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-3xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-900">Duyệt {request.code} → lên PO</h3>
            <p className="text-sm text-slate-500 mt-1">{request.reason}. Chưa có giá vẫn duyệt được — để trống, giá thực nhập lúc nhận hàng.</p>
          </div>
          <button type="button" onClick={onClose} className="icon-button" title="Đóng">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-xs font-bold text-slate-600">Nhà cung cấp
              <div className="mt-1.5">
                <PartnerPicker
                  value={supplierCode}
                  onChange={(code) => { setSupplierCode(code); setSupplierName(supplierOptions.find((option) => option.value === code)?.label || code); }}
                  options={supplierOptions}
                  placeholder="-- Chọn nhà cung cấp --"
                  canCreate={canCreatePartner}
                  defaultPartnerType="SUPPLIER"
                  onCreated={(partner) => { onSupplierCreated(partner); setSupplierCode(partner.code); setSupplierName(partner.name); }}
                />
              </div>
            </label>
            <label className="block text-xs font-bold text-slate-600">Kho nhận hàng
              <select className="control" value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)}>
                <option value="">-- Chọn kho --</option>
                {warehouses.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name} ({warehouse.code})</option>)}
              </select>
            </label>
          </div>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Mặt hàng</th>
                  <th className="px-3 py-2 text-right">Số lượng</th>
                  <th className="px-3 py-2 text-right">Đơn giá (trước thuế)</th>
                  <th className="px-3 py-2 text-right">Thành tiền</th>
                </tr>
              </thead>
              <tbody>
                {request.lines.map((line) => {
                  const unit = purchaseLineUnit(line);
                  const quantity = toPurchaseQuantity(line.quantity, line);
                  return (
                    <tr key={line.id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 min-w-[180px]">
                        <b className="text-slate-800">{line.item.name}</b>
                        <small className="block text-slate-500">{line.item.code}{priceSource[line.id] ? ` · ${priceSource[line.id]}` : ""}</small>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{qty(quantity)} {unit}</td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          inputMode="decimal"
                          className="control !mt-0 w-32 text-right"
                          placeholder={`Chưa có giá · đ/${unit}`}
                          value={prices[line.id] ?? ""}
                          onChange={(e) => setPrices({ ...prices, [line.id]: e.target.value })}
                          aria-label={`Đơn giá ${line.item.name}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{Number(prices[line.id]) > 0 ? money(Math.round(quantity * Number(prices[line.id]))) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50 font-bold">
                <tr>
                  <td className="px-3 py-2" colSpan={3}>Tạm tính{unpriced > 0 ? ` (${unpriced} dòng chưa có giá)` : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(Math.round(total))} đ</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {error && <p className="px-3 py-2 rounded-lg border border-rose-200 bg-rose-50 text-sm text-rose-700">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600">Huỷ</button>
          <button type="button" disabled={busy} onClick={() => void approve()} className="primary-button min-w-[180px]">
            <span className="material-symbols-outlined text-lg">{busy ? "progress_activity" : "task_alt"}</span>
            {busy ? "Đang duyệt…" : "Duyệt & lên PO"}
          </button>
        </div>
      </div>
    </div>
  );
}
