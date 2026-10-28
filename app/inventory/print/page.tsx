"use client";

import { Fragment, useEffect, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { money, quantity as qty } from "@/lib/format-number";
import { vatRateLabel } from "@/lib/inventory-vat";
import { purchasePrintRow, purchasePrintTotal, type PurchasePrintTotalKey, type StockPrintLine } from "@/lib/stock-print-rows";

/**
 * In GỘP nhiều phiếu nhập mua của cùng một NCC trên một phiếu (khách 28/10/2026, như in gộp tài sản /
 * CCDC) — mở từ danh sách Nhập mua ở màn Nhập kho: tick các phiếu → In gộp. Một bảng chung, mỗi phiếu
 * một nhóm dòng kèm dòng cộng của phiếu, tổng cộng chung và ô ký một lần.
 */
type StockDocument = {
  id: string;
  code: string;
  transactionDate: string;
  branchCode: string;
  warehouseCode: string;
  referenceCode: string | null;
  createdBy: string | null;
  purchaseCost?: number;
  lines: StockPrintLine[];
};
type Payload = { documents: StockDocument[]; partnerName: string | null; warehouseNames: Record<string, string> };
type BranchOption = { code: string; name: string };

const dayText = (value: string) => new Date(value).toLocaleDateString("vi-VN");

export default function MergedPurchasePrintPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);

  useEffect(() => {
    const ids = new URLSearchParams(window.location.search).get("ids") || "";
    fetch(`/api/inventory?view=documents&ids=${encodeURIComponent(ids)}`).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) setPayload(data as Payload);
      else setError((data as { error?: string }).error || "Không tải được các phiếu nhập");
    });
    fetch("/api/branding").then(async (response) => {
      if (response.ok) setBranches(((await response.json()) as { branches?: BranchOption[] }).branches || []);
    });
  }, []);

  if (error) return <div className="p-10 text-rose-700">{error}</div>;
  if (!payload) return <div className="p-10">Đang tải các phiếu nhập...</div>;

  const { documents, partnerName, warehouseNames } = payload;
  const branchNameOf = (code: string) => branches.find((branch) => branch.code === code)?.name || storeLabel(code);
  const warehouseLabel = (code: string) => (warehouseNames[code] ? `${warehouseNames[code]} (${code})` : code);
  const branchCodes = [...new Set(documents.map((doc) => doc.branchCode))];
  const warehouseCodes = [...new Set(documents.map((doc) => doc.warehouseCode))];
  // STT chạy liên tục qua mọi phiếu.
  const groups = documents.reduce<Array<{ doc: StockDocument; rows: Array<ReturnType<typeof purchasePrintRow> & { stt: number }> }>>((list, doc) => {
    const start = list.reduce((count, group) => count + group.rows.length, 0);
    return [...list, { doc, rows: doc.lines.map((line, index) => ({ ...purchasePrintRow(line), stt: start + index + 1 })) }];
  }, []);
  const allRows = groups.flatMap((group) => group.rows);
  const total = (key: PurchasePrintTotalKey) => purchasePrintTotal(allRows, key);
  const purchaseCost = documents.reduce((sum, doc) => sum + (doc.purchaseCost || 0), 0);
  const dates = documents.map((doc) => doc.transactionDate).sort();
  const creators = [...new Set(documents.map((doc) => doc.createdBy).filter(Boolean))].join(", ");

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-6xl mx-auto border border-slate-200 p-8 print:border-0 print:max-w-none print:p-0">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold uppercase">{branchCodes.map(branchNameOf).join(" · ")}</h1>
            <p className="text-sm text-slate-500 mt-1">Kho: {warehouseCodes.map(warehouseLabel).join(", ")}</p>
          </div>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In phiếu</button>
        </div>

        <section className="text-center py-8">
          <h2 className="text-3xl font-bold uppercase tracking-wide">Phiếu nhập kho</h2>
          <p className="mt-2 text-sm text-slate-500">Gộp {documents.length} phiếu nhập mua</p>
          <p className="text-sm text-slate-500 mt-1">
            {dates.length > 0 && (dayText(dates[0]) === dayText(dates[dates.length - 1]) ? `Ngày ${dayText(dates[0])}` : `Từ ngày ${dayText(dates[0])} đến ngày ${dayText(dates[dates.length - 1])}`)}
          </p>
        </section>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-[180px_1fr] gap-3"><b>Nhà cung cấp</b><span className={partnerName ? "" : "border-b border-dotted border-slate-400"}>{partnerName || ""}</span></div>
          <div className="grid grid-cols-[180px_1fr] gap-3"><b>Các phiếu nhập</b><span>{documents.map((doc) => doc.code).join(", ")}</span></div>
        </div>

        <table className="mt-6 w-full border-collapse text-xs print:text-[8px] print:leading-tight">
          <thead>
            <tr className="border-y-2 border-slate-300 text-[10px] uppercase text-slate-500 print:text-[6.5px]">
              <th className="py-2 pr-1 text-left">STT</th>
              <th className="py-2 pr-1 text-left">Mã hàng</th>
              <th className="py-2 pr-1 text-left">Tên hàng</th>
              <th className="py-2 pr-1 text-left">ĐVT</th>
              <th className="py-2 pr-1 text-right">SL</th>
              <th className="py-2 pr-1 text-right">Đơn giá</th>
              <th className="py-2 pr-1 text-right">Thành tiền trước thuế</th>
              <th className="py-2 pr-1 text-right">Chiết khấu</th>
              <th className="py-2 pr-1 text-right">Thuế suất</th>
              <th className="py-2 pr-1 text-right">Tiền thuế</th>
              <th className="py-2 pr-1 text-right">Thành tiền sau thuế</th>
              <th className="py-2 pr-1 text-right">CP mua phân bổ</th>
              <th className="py-2 text-right">Trị giá mua hàng</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ doc, rows }) => (
              <Fragment key={doc.id}>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <td colSpan={13} className="py-1.5 font-bold">
                    {doc.code} · {dayText(doc.transactionDate)}
                    <span className="font-normal text-slate-500">
                      {warehouseCodes.length > 1 ? ` · ${warehouseLabel(doc.warehouseCode)}` : ""}
                      {doc.referenceCode && doc.referenceCode !== doc.code ? ` · Tham chiếu ${doc.referenceCode}` : ""}
                    </span>
                  </td>
                </tr>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 align-top">
                    <td className="py-1.5 pr-1">{row.stt}</td>
                    <td className="py-1.5 pr-1 whitespace-nowrap">{row.item.code}</td>
                    <td className="py-1.5 pr-1">{row.item.name}{row.note && <small className="block text-slate-500 italic">{row.note}</small>}</td>
                    <td className="py-1.5 pr-1">{row.printUnit}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">{qty(row.printQuantity)}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">{money(row.printUnitPrice)}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">{money(row.gross)}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">
                      {row.discount > 0 ? money(row.discount) : "-"}
                      {row.discountRate !== null && row.discountRate !== undefined && <small className="block text-slate-500">{Number((row.discountRate * 100).toFixed(2))}%</small>}
                    </td>
                    <td className="py-1.5 pr-1 text-right">{vatRateLabel(row.vatRate)}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">{row.vatAmount > 0 ? money(row.vatAmount) : "-"}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">{money(row.afterTax)}</td>
                    <td className="py-1.5 pr-1 text-right tabular-nums">{row.share > 0 ? money(row.share) : "-"}</td>
                    <td className="py-1.5 text-right tabular-nums font-bold">{money(row.purchaseValue)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-300 text-slate-600">
                  <td colSpan={6} className="py-1.5 italic">Cộng phiếu {doc.code}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{money(purchasePrintTotal(rows, "gross"))}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{money(purchasePrintTotal(rows, "discount"))}</td>
                  <td />
                  <td className="py-1.5 pr-1 text-right tabular-nums">{money(purchasePrintTotal(rows, "vatAmount"))}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{money(purchasePrintTotal(rows, "afterTax"))}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{money(purchasePrintTotal(rows, "share"))}</td>
                  <td className="py-1.5 text-right tabular-nums font-bold">{money(purchasePrintTotal(rows, "purchaseValue"))}</td>
                </tr>
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-bold">
              <td colSpan={6} className="py-2">Cộng {documents.length} phiếu</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(total("gross"))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(total("discount"))}</td>
              <td />
              <td className="py-2 pr-1 text-right tabular-nums">{money(total("vatAmount"))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(total("afterTax"))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(total("share"))}</td>
              <td className="py-2 text-right tabular-nums">{money(total("purchaseValue"))}</td>
            </tr>
            <tr>
              <td colSpan={10} className="py-2 font-bold">Tổng cộng thanh toán NCC <span className="font-normal text-slate-500">(sau thuế, đã trừ chiết khấu, gồm chi phí mua hàng)</span></td>
              <td colSpan={3} className="py-2 text-right tabular-nums text-sm font-bold">{money(total("afterTax") + purchaseCost)} đ</td>
            </tr>
          </tfoot>
        </table>

        {/* Ô ký để trống cho ký tay trên bản in. */}
        <div className="grid grid-cols-4 gap-6 text-center mt-16 text-sm">
          <div><b>Người lập phiếu</b><div className="h-20" /><p>{creators}</p></div>
          <div><b>Người giao hàng (NCC)</b><div className="h-20" /></div>
          <div><b>Thủ kho</b><div className="h-20" /></div>
          <div><b>Kế toán</b><div className="h-20" /></div>
        </div>
      </div>
    </main>
  );
}
