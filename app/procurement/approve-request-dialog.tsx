"use client";

import { useEffect, useMemo, useState } from "react";
import { PartnerPicker, type CreatedPartner } from "@/components/PartnerPicker";
import { SearchableSelect } from "@/components/SearchableSelect";
import { QuantityInput } from "@/components/QuantityInput";
import { money, quantity as qty } from "@/lib/format-number";
import { purchaseLineRate, purchaseLineUnit, receiveUnitOptions, toPurchasePrice, toPurchaseQuantity, type PurchaseUnitLine, type UnitConversionLike } from "@/lib/unit-conversion";

type ApproveLine = PurchaseUnitLine & { id: string; itemId: string; quantity: number; supplierCode?: string | null; supplierName?: string | null; note?: string | null; item: { code: string; name: string; unit: string } };
type ApproveQuote = { supplierCode: string; supplierName: string; isSelected: boolean; lines: Array<PurchaseUnitLine & { itemId: string; unitCost: number }> };
export type ApprovableRequest = { id: string; code: string; branchCode: string; reason: string; warehouseCode?: string | null; supplierCode?: string | null; supplierName?: string | null; lines: ApproveLine[]; quotes: ApproveQuote[] };
type ActivePriceRow = { itemId: string; supplierCode: string; supplierName: string; stockUnitPrice: number; unitPrice: number; unitCode: string; priceListCode: string };
/** Tổng tiền PR theo từng NCC (bảng giá đang hiệu lực + báo giá trên PR) để thu mua so sánh lúc duyệt. */
type SupplierCompare = { supplierCode: string; supplierName: string; total: number; covered: number; source: string };
type Option = { value: string; label: string; subLabel?: string };
/** Giá một NCC cho một dòng PR, theo ĐVT đặt của dòng. */
type LineOffer = { supplierCode: string; supplierName: string; price: number; source: string };
type LineSupplier = { code: string; name: string };
/** Số lượng / ĐVT mua thu mua sửa lúc duyệt (khách 27/11/2026) — số theo ĐVT mua, rate = hệ số về ĐVT tồn. */
type LineEdit = { quantity: string; unitCode: string; rate: number };
export type ApproveItemUnits = { id: string; unit: string; unitConversions?: UnitConversionLike[] | null };

/**
 * Thu mua duyệt PR → lên PO luôn (khách 21/10/2026). CHƯA CÓ GIÁ VẪN DUYỆT ĐƯỢC — để trống, giá
 * thực nhập lúc nhận hàng.
 *
 * Từ 22/10/2026 mỗi DÒNG chọn NCC riêng (mẫu đặt hàng của một NCC nhưng vài món lấy NCC khác):
 * dòng nào có NCC rẻ hơn thì gợi ý ngay trên dòng đó; duyệt xong tự tách mỗi NCC một PO. NCC ở
 * đầu phiếu là NCC mặc định — đổi thì áp cho mọi dòng.
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
  existingOrders = [],
  items = [],
}: {
  request: ApprovableRequest;
  supplierOptions: Option[];
  warehouses: Array<{ code: string; name: string }>;
  defaultWarehouse: string;
  canCreatePartner: boolean;
  onSupplierCreated: (partner: CreatedPartner) => void;
  onClose: () => void;
  onApproved: (message: string) => Promise<void> | void;
  /** PO còn hiệu lực của PR — có nghĩa là đang duyệt lại phần mở lại sau khi huỷ một PO (`request.lines` chỉ còn phần đó). */
  existingOrders?: string[];
  /** Danh mục mặt hàng (ĐVT tồn + quy đổi) để chọn lại ĐVT mua từng dòng. */
  items?: ApproveItemUnits[];
}) {
  // NCC mặc định: NCC đề xuất trên PR (từ mẫu / người đặt) → báo giá đã chốt; thu mua đổi được.
  const initialQuote = request.quotes.find((quote) => quote.isSelected) || null;
  const initialSupplier = { code: request.supplierCode || initialQuote?.supplierCode || "", name: request.supplierName || initialQuote?.supplierName || "" };
  const [supplier, setSupplier] = useState<LineSupplier>(initialSupplier);
  const [activePrices, setActivePrices] = useState<ActivePriceRow[] | null>(null);
  const [warehouseCode, setWarehouseCode] = useState(request.warehouseCode || defaultWarehouse);
  const [lineSupplier, setLineSupplier] = useState<Record<string, LineSupplier>>({});
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [priceSource, setPriceSource] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Mặc định = đúng số & ĐVT người đặt; thu mua sửa thì PR và PO đi theo số mới.
  const [edits, setEdits] = useState<Record<string, LineEdit>>(() => Object.fromEntries(request.lines.map((line) => [
    line.id,
    { quantity: String(toPurchaseQuantity(line.quantity, line)), unitCode: purchaseLineUnit(line), rate: purchaseLineRate(line) },
  ])));
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  /** Dòng PR sau khi áp số lượng / ĐVT thu mua sửa — mọi phép tính giá, tổng tiền dùng dòng này. */
  const lines = useMemo<ApproveLine[]>(() => request.lines.map((line) => {
    const edit = edits[line.id];
    if (!edit) return line;
    return { ...line, unitCode: edit.unitCode, conversionRate: edit.rate, quantity: (Number(edit.quantity) || 0) * edit.rate };
  }), [request.lines, edits]);
  /** Số & ĐVT người đặt ghi trên PR (để hiện "PR: 5 GR" cạnh ô đã sửa). */
  const originalOf = (lineId: string) => {
    const line = request.lines.find((candidate) => candidate.id === lineId);
    return line ? { quantity: toPurchaseQuantity(line.quantity, line), unit: purchaseLineUnit(line) } : null;
  };
  const isEdited = (lineId: string) => {
    const edit = edits[lineId];
    const original = originalOf(lineId);
    return Boolean(edit && original) && (edit.unitCode.toUpperCase() !== original!.unit.toUpperCase() || Math.abs((Number(edit.quantity) || 0) - original!.quantity) > 1e-9);
  };

  // Bảng giá đang hiệu lực của MỌI NCC cho cửa hàng — nguồn gợi ý từng dòng và bảng so sánh.
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ view: "active-prices", branchCode: request.branchCode });
    void fetch(`/api/procurement?${query.toString()}`)
      .then(async (response) => (response.ok ? await response.json() as { prices: ActivePriceRow[] } : { prices: [] }))
      .catch(() => ({ prices: [] as ActivePriceRow[] }))
      .then(({ prices: rows }) => { if (!cancelled) setActivePrices(rows); });
    return () => { cancelled = true; };
  }, [request.branchCode]);

  /** Mọi NCC có giá cho một dòng (báo giá trên PR trước, rồi bảng giá), rẻ nhất trước — giá theo ĐVT mua của dòng. */
  const offersFor = (line: ApproveLine) => {
    const offers = new Map<string, LineOffer>();
    for (const quote of request.quotes) {
      const quoteLine = quote.lines.find((candidate) => candidate.itemId === line.itemId);
      if (quoteLine && quoteLine.unitCost > 0) {
        offers.set(quote.supplierCode, { supplierCode: quote.supplierCode, supplierName: quote.supplierName, price: toPurchasePrice(quoteLine.unitCost, line), source: "Báo giá" });
      }
    }
    for (const listed of activePrices || []) {
      if (listed.itemId !== line.itemId || !(listed.stockUnitPrice > 0) || offers.has(listed.supplierCode)) continue;
      const price = listed.unitCode === purchaseLineUnit(line) ? listed.unitPrice : Math.round(toPurchasePrice(listed.stockUnitPrice, line) * 100) / 100;
      offers.set(listed.supplierCode, { supplierCode: listed.supplierCode, supplierName: listed.supplierName, price, source: `Bảng giá ${listed.priceListCode}` });
    }
    return [...offers.values()].sort((a, b) => a.price - b.price);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const offersByLine = useMemo(() => new Map(lines.map((line) => [line.id, offersFor(line)])), [lines, request.quotes, activePrices]);

  const offerOf = (lineId: string, supplierCode: string) => offersByLine.get(lineId)?.find((offer) => offer.supplierCode === supplierCode);

  /** Gán NCC cho các dòng và lấy lại giá của NCC đó (không có giá thì để trống). */
  const assign = (entries: Array<{ lineId: string; supplier: LineSupplier }>) => {
    setLineSupplier((current) => ({ ...current, ...Object.fromEntries(entries.map((entry) => [entry.lineId, entry.supplier])) }));
    setPrices((current) => ({ ...current, ...Object.fromEntries(entries.map((entry) => [entry.lineId, String(offerOf(entry.lineId, entry.supplier.code)?.price ?? "")])) }));
    setPriceSource((current) => ({ ...current, ...Object.fromEntries(entries.map((entry) => [entry.lineId, offerOf(entry.lineId, entry.supplier.code)?.source || ""])) }));
  };

  // Lần đầu có bảng giá: dòng theo NCC của chính dòng (từ mẫu) → NCC mặc định của phiếu → NCC rẻ nhất.
  useEffect(() => {
    if (!activePrices) return;
    const timer = window.setTimeout(() => {
      assign(lines.map((line) => {
        const cheapest = offersByLine.get(line.id)?.[0];
        if (line.supplierCode) return { lineId: line.id, supplier: { code: line.supplierCode, name: line.supplierName || line.supplierCode } };
        return { lineId: line.id, supplier: initialSupplier.code ? initialSupplier : cheapest ? { code: cheapest.supplierCode, name: cheapest.supplierName } : { code: "", name: "" } };
      }));
    }, 0);
    return () => window.clearTimeout(timer);
    // Chỉ chạy khi bảng giá về; các lần đổi sau do người dùng bấm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePrices]);

  const changeDefaultSupplier = (next: LineSupplier) => {
    setSupplier(next);
    assign(lines.map((line) => ({ lineId: line.id, supplier: next })));
  };

  const changeQuantity = (lineId: string, value: string) => setEdits((current) => ({ ...current, [lineId]: { ...current[lineId], quantity: value } }));

  /**
   * Đổi ĐVT mua của dòng: giữ con số đang gõ (thu mua sửa tiếp nếu cần), giá lấy lại của NCC đang
   * chọn theo ĐVT mới; NCC chưa có giá mà đã gõ tay thì quy đổi theo hệ số.
   */
  const changeUnit = (line: ApproveLine, unitCode: string, rate: number) => {
    const nextLine = { ...line, unitCode, conversionRate: rate, quantity: (Number(edits[line.id]?.quantity) || 0) * rate };
    setEdits((current) => ({ ...current, [line.id]: { ...current[line.id], unitCode, rate } }));
    const chosen = lineSupplier[line.id]?.code || "";
    const offer = offersFor(nextLine).find((candidate) => candidate.supplierCode === chosen);
    const typed = Number(prices[line.id]);
    const previousRate = purchaseLineRate(line);
    setPrices((current) => ({ ...current, [line.id]: offer ? String(offer.price) : typed > 0 ? String(Math.round((typed / previousRate) * rate * 100) / 100) : "" }));
    setPriceSource((current) => ({ ...current, [line.id]: offer?.source || "" }));
  };

  const pickCheapestEachLine = () => assign(lines.flatMap((line) => {
    const cheapest = offersByLine.get(line.id)?.[0];
    return cheapest ? [{ lineId: line.id, supplier: { code: cheapest.supplierCode, name: cheapest.supplierName } }] : [];
  }));

  // So sánh tổng phiếu theo từng NCC (chỉ các mặt hàng NCC đó có giá).
  const compare = useMemo<SupplierCompare[]>(() => {
    const rows = new Map<string, SupplierCompare>();
    for (const line of lines) {
      for (const offer of offersByLine.get(line.id) || []) {
        const row = rows.get(offer.supplierCode) || { supplierCode: offer.supplierCode, supplierName: offer.supplierName, total: 0, covered: 0, source: offer.source === "Báo giá" ? "báo giá" : "bảng giá" };
        row.total += toPurchaseQuantity(line.quantity, line) * offer.price;
        row.covered += 1;
        rows.set(offer.supplierCode, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.covered - a.covered || a.total - b.total);
  }, [lines, offersByLine]);

  const amountOf = (line: ApproveLine) => toPurchaseQuantity(line.quantity, line) * Number(prices[line.id] || 0);
  const total = lines.reduce((sum, line) => sum + amountOf(line), 0);
  const unpriced = lines.filter((line) => !(Number(prices[line.id]) > 0)).length;
  /** PO sẽ tạo: gom dòng theo NCC đã chọn. */
  const orderGroups = useMemo(() => {
    const groups = new Map<string, { name: string; lines: number; amount: number }>();
    for (const line of lines) {
      const chosen = lineSupplier[line.id];
      if (!chosen?.code) continue;
      const group = groups.get(chosen.code) || { name: chosen.name || chosen.code, lines: 0, amount: 0 };
      group.lines += 1;
      group.amount += toPurchaseQuantity(line.quantity, line) * Number(prices[line.id] || 0);
      groups.set(chosen.code, group);
    }
    return [...groups.entries()].map(([code, group]) => ({ code, ...group }));
  }, [lines, lineSupplier, prices]);

  const approve = async () => {
    const missing = lines.find((line) => !lineSupplier[line.id]?.code);
    if (missing) {
      setError(`Chọn nhà cung cấp cho ${missing.item.name}.`);
      return;
    }
    if (!warehouseCode) {
      setError("Chọn kho nhận hàng.");
      return;
    }
    const zero = lines.find((line) => !(Number(edits[line.id]?.quantity) > 0));
    if (zero) {
      setError(`Nhập số lượng cho ${zero.item.name}.`);
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
          supplierCode: supplier.code,
          supplierName: supplier.name,
          warehouseCode,
          lines: lines.map((line) => ({
            lineId: line.id,
            unitCost: Number(prices[line.id] || 0),
            // Số lượng / ĐVT mua theo bản thu mua đã sửa (máy chủ quy về ĐVT tồn, sửa luôn dòng PR).
            quantity: Number(edits[line.id]?.quantity) || 0,
            unitCode: edits[line.id]?.unitCode,
            supplierCode: lineSupplier[line.id]?.code,
            supplierName: lineSupplier[line.id]?.name,
          })),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { code?: string; codes?: string[]; error?: string };
      if (!response.ok) {
        setError(payload.error || "Không duyệt được yêu cầu mua");
        return;
      }
      const codes = payload.codes?.length ? payload.codes : [payload.code];
      await onApproved(`Đã duyệt ${request.code} → ${codes.length > 1 ? `${codes.length} PO: ${codes.join(", ")}` : `PO ${codes[0]}`}${unpriced > 0 ? ` (${unpriced} dòng chưa có giá — nhập giá thực lúc nhận hàng)` : ""}. Gửi PO cho NCC ở tab Đơn mua hàng.`);
    } finally {
      setBusy(false);
    }
  };

  const supplierLabel = (code: string) => supplierOptions.find((option) => option.value === code)?.label || code;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-6xl shadow-xl max-h-[92vh] flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-slate-900">Duyệt {request.code} → lên PO</h3>
            <p className="text-sm text-slate-500 mt-1">{request.reason}. Mỗi dòng chọn được NCC riêng — duyệt xong tự tách mỗi NCC một PO. Chưa có giá vẫn duyệt được. Số lượng / ĐVT mua sai thì sửa thẳng trên dòng — PR và PO đi theo số mới.</p>
            {existingOrders.length > 0 && (
              <p className="text-sm text-amber-700 mt-1">Duyệt lại {request.lines.length} dòng của PO đã huỷ — các dòng đang nằm trên {existingOrders.join(", ")} giữ nguyên.</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="icon-button" title="Đóng">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block text-xs font-bold text-slate-600">NCC mặc định (áp cho mọi dòng)
              <div className="mt-1.5">
                <PartnerPicker
                  value={supplier.code}
                  onChange={(code) => changeDefaultSupplier({ code, name: supplierLabel(code) })}
                  options={supplierOptions}
                  placeholder="-- Chọn nhà cung cấp --"
                  canCreate={canCreatePartner}
                  defaultPartnerType="SUPPLIER"
                  onCreated={(partner) => { onSupplierCreated(partner); changeDefaultSupplier({ code: partner.code, name: partner.name }); }}
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
          {compare.length > 0 && (
            <details className="rounded-lg border border-slate-200 p-3 text-sm">
              <summary className="cursor-pointer text-xs font-bold text-slate-600 uppercase">So sánh tổng phiếu theo NCC ({compare.length} NCC có giá)</summary>
              <div className="mt-2 space-y-1">
                {compare.slice(0, 8).map((row) => (
                  <button key={row.supplierCode} type="button" onClick={() => changeDefaultSupplier({ code: row.supplierCode, name: row.supplierName })}
                    className={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left ${row.supplierCode === supplier.code ? "bg-blue-50 ring-1 ring-blue-300" : "hover:bg-slate-50"}`} title="Áp NCC này cho mọi dòng">
                    <span className="min-w-0 truncate"><b>{row.supplierName}</b><small className="text-slate-500"> · {row.covered}/{lines.length} mặt hàng · theo {row.source}</small></span>
                    <span className="tabular-nums whitespace-nowrap">{money(Math.round(row.total))} đ</span>
                  </button>
                ))}
              </div>
            </details>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500">Dòng có <b className="text-emerald-700">NCC rẻ hơn</b> hiện gợi ý ngay dưới tên hàng — bấm để đổi NCC dòng đó.</p>
            <button type="button" onClick={pickCheapestEachLine} disabled={!activePrices} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
              Chọn NCC rẻ nhất từng dòng
            </button>
          </div>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Mặt hàng</th>
                  <th className="px-3 py-2 text-right">Số lượng</th>
                  <th className="px-3 py-2 text-left">ĐVT mua</th>
                  <th className="px-3 py-2 text-left min-w-[220px]">Nhà cung cấp</th>
                  <th className="px-3 py-2 text-right">Đơn giá (trước thuế)</th>
                  <th className="px-3 py-2 text-right">Thành tiền</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const unit = purchaseLineUnit(line);
                  const quantity = toPurchaseQuantity(line.quantity, line);
                  const chosen = lineSupplier[line.id];
                  const offers = offersByLine.get(line.id) || [];
                  const current = Number(prices[line.id]) || 0;
                  const cheaper = offers.find((offer) => offer.supplierCode !== chosen?.code && (!(current > 0) || offer.price < current));
                  const pricedCodes = new Set(offers.map((offer) => offer.supplierCode));
                  const edited = isEdited(line.id);
                  const original = originalOf(line.id);
                  // ĐVT PR lúc đặt đứng đầu (giữ hệ số lúc đặt), sau đó các ĐVT khai ở danh mục mặt hàng.
                  const originalLine = request.lines.find((candidate) => candidate.id === line.id) || line;
                  const catalog = itemById.get(line.itemId);
                  const unitOptions = (catalog ? receiveUnitOptions(originalLine, catalog) : [{ unitCode: purchaseLineUnit(originalLine), label: purchaseLineUnit(originalLine), conversionRate: purchaseLineRate(originalLine) }])
                    .map((option, index) => (index === 0 ? { ...option, label: option.label.replace(" · ĐVT đặt", " · theo PR") } : option));
                  return (
                    <tr key={line.id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 min-w-[180px]">
                        <b className="text-slate-800">{line.item.name}</b>
                        <small className="block text-slate-500">{line.item.code}{priceSource[line.id] ? ` · ${priceSource[line.id]}` : ""}</small>
                        {line.note && <small className="block text-amber-700">Ghi chú: {line.note}</small>}
                        {cheaper && (
                          <button type="button" className="mt-1 rounded bg-emerald-50 px-1.5 py-0.5 text-left text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                            onClick={() => assign([{ lineId: line.id, supplier: { code: cheaper.supplierCode, name: cheaper.supplierName } }])}>
                            Rẻ hơn: {cheaper.supplierName} · {money(cheaper.price)} đ/{unit}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <QuantityInput
                          value={edits[line.id]?.quantity ?? String(quantity)}
                          onChange={(value) => changeQuantity(line.id, value)}
                          className={`control !mt-0 w-24 text-right tabular-nums ${edited ? "!border-amber-400 !bg-amber-50" : ""}`}
                          ariaLabel={`Số lượng ${line.item.name}`}
                        />
                        {edited && original && <small className="block mt-0.5 text-[11px] text-amber-700 whitespace-nowrap">PR: {qty(original.quantity)} {original.unit}</small>}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={`control !mt-0 min-w-[160px] ${edited && original && original.unit.toUpperCase() !== unit.toUpperCase() ? "!border-amber-400 !bg-amber-50" : ""}`}
                          value={unit}
                          onChange={(event) => {
                            const option = unitOptions.find((candidate) => candidate.unitCode === event.target.value);
                            if (option) changeUnit(line, option.unitCode, option.conversionRate);
                          }}
                          aria-label={`ĐVT mua ${line.item.name}`}
                        >
                          {unitOptions.map((option) => <option key={option.unitCode} value={option.unitCode}>{option.label}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        {/* Ô chọn NCC có tìm kiếm (khách 24/10/2026); NCC có giá đứng đầu, rẻ → đắt. */}
                        <SearchableSelect
                          value={chosen?.code || ""}
                          onChange={(code) => assign([{ lineId: line.id, supplier: { code, name: offers.find((offer) => offer.supplierCode === code)?.supplierName || supplierLabel(code) } }])}
                          options={[
                            ...offers.map((offer) => ({ value: offer.supplierCode, label: `${offer.supplierName} · ${money(offer.price)} đ`, subLabel: `Có giá · ${offer.source}`, selectedLabel: `${offer.supplierName} · ${money(offer.price)} đ` })),
                            ...supplierOptions.filter((option) => option.value && !pricedCodes.has(option.value)).map((option) => ({ ...option, subLabel: "Chưa có giá" })),
                          ]}
                          placeholder="-- Chọn NCC --"
                          searchPlaceholder="Gõ tên hoặc mã NCC..."
                        />
                      </td>
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
                      <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">{current > 0 ? money(Math.round(amountOf(line))) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50 font-bold">
                <tr>
                  <td className="px-3 py-2" colSpan={5}>Tạm tính{unpriced > 0 ? ` (${unpriced} dòng chưa có giá)` : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(Math.round(total))} đ</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {orderGroups.length > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm">
              <p className="text-xs font-bold text-blue-800 uppercase">Duyệt sẽ tạo {orderGroups.length} PO</p>
              <ul className="mt-1 space-y-0.5 text-slate-700">
                {orderGroups.map((group) => (
                  <li key={group.code} className="flex justify-between gap-2"><span><b>{group.name}</b> · {group.lines} mặt hàng</span><span className="tabular-nums">{money(Math.round(group.amount))} đ</span></li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="px-3 py-2 rounded-lg border border-rose-200 bg-rose-50 text-sm text-rose-700">{error}</p>}
        </div>
        <div className="p-4 border-t border-slate-200 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 rounded-lg border border-slate-300 bg-white py-2 text-sm font-bold text-slate-600">Huỷ</button>
          <button type="button" disabled={busy || !activePrices} onClick={() => void approve()} className="primary-button min-w-[180px]">
            <span className="material-symbols-outlined text-lg">{busy ? "progress_activity" : "task_alt"}</span>
            {busy ? "Đang duyệt…" : orderGroups.length > 1 ? `Duyệt & lên ${orderGroups.length} PO` : "Duyệt & lên PO"}
          </button>
        </div>
      </div>
    </div>
  );
}
