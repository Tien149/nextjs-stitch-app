"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { storeLabel } from "@/lib/branch-labels";
import { money, quantity as qty } from "@/lib/format-number";
import { movementTypeLabel } from "@/lib/inventory-movement-labels";
import { vatRateLabel } from "@/lib/inventory-vat";

/**
 * Bản in PHIẾU NHẬP KHO (khách yêu cầu 03/10/2026) — mở từ nút "In" trên danh sách phiếu nhập
 * ở màn Kho. Phiếu điều chuyển in thành phiếu nhập ở kho nhận. Cùng kiểu trang in phiếu thu/chi
 * (app/vouchers/[id]/print): tên nhà hàng, tiêu đề lớn, bảng hàng, ô ký tay để trống.
 */
type Line = {
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
  item: { code: string; name: string; unit: string };
};
type StockDocument = {
  id: string;
  code: string;
  transactionType: string;
  transactionDate: string;
  branchCode: string;
  warehouseCode: string;
  toWarehouseCode: string | null;
  toBranchCode: string | null;
  partnerCode: string | null;
  referenceCode: string | null;
  note: string | null;
  createdBy: string | null;
  lines: Line[];
};
type Payload = { transaction: StockDocument; partnerName: string | null; warehouseNames: Record<string, string> };
type BranchOption = { code: string; name: string };

export default function StockReceiptPrintPage() {
  const params = useParams<{ id: string }>();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);

  useEffect(() => {
    fetch(`/api/inventory?view=document&id=${encodeURIComponent(params.id)}`).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) setPayload(data as Payload);
      else setError((data as { error?: string }).error || "Không tải được phiếu kho");
    });
    fetch("/api/branding").then(async (response) => {
      if (response.ok) setBranches(((await response.json()) as { branches?: BranchOption[] }).branches || []);
    });
  }, [params.id]);

  if (error) return <div className="p-10 text-rose-700">{error}</div>;
  if (!payload) return <div className="p-10">Đang tải phiếu nhập kho...</div>;

  const { transaction: doc, partnerName, warehouseNames } = payload;
  // Điều chuyển: phiếu nhập đứng ở cửa hàng / kho nhận.
  const isTransfer = doc.transactionType === "DIEU_CHUYEN";
  const branchCode = isTransfer ? doc.toBranchCode || doc.branchCode : doc.branchCode;
  const warehouseCode = isTransfer ? doc.toWarehouseCode || doc.warehouseCode : doc.warehouseCode;
  const branchName = branches.find((branch) => branch.code === branchCode)?.name || storeLabel(branchCode);
  const warehouseLabel = (code: string) => (warehouseNames[code] ? `${warehouseNames[code]} (${code})` : code);
  const typeLabel = movementTypeLabel(isTransfer ? "NHAP_DIEU_CHUYEN" : doc.transactionType);

  // In theo đúng ĐVT người dùng đã nhập trên phiếu (CHAI, THÙNG...), không quy về ĐVT tồn.
  const rows = doc.lines.map((line) => {
    const hasInput = line.inputQuantity !== null && line.inputQuantity !== undefined && Boolean(line.inputUnitCode);
    const quantity = hasInput ? Number(line.inputQuantity) : line.quantity;
    const unit = hasInput ? String(line.inputUnitCode) : line.item.unit;
    const unitPrice = hasInput
      ? line.inputUnitCost ?? line.unitCost * (line.conversionRate || 1)
      : line.unitCost;
    return { ...line, printQuantity: quantity, printUnit: unit, printUnitPrice: unitPrice };
  });
  const totalBeforeTax = rows.reduce((sum, row) => sum + row.totalCost, 0);
  const totalVat = rows.reduce((sum, row) => sum + (row.vatAmount || 0), 0);
  const hasVat = totalVat > 0;

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-4xl mx-auto border border-slate-200 p-8 print:border-0 print:max-w-none">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold uppercase">{branchName}</h1>
            <p className="text-sm text-slate-500 mt-1">Kho: {warehouseLabel(warehouseCode)}</p>
          </div>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In phiếu</button>
        </div>

        <section className="text-center py-8">
          <h2 className="text-3xl font-bold uppercase tracking-wide">Phiếu nhập kho</h2>
          <p className="mt-2 text-sm uppercase tracking-widest text-slate-500">{doc.code}</p>
          <p className="text-sm text-slate-500 mt-2">Ngày {new Date(doc.transactionDate).toLocaleDateString("vi-VN")}</p>
        </section>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-[180px_1fr] gap-3"><b>Loại nhập</b><span>{typeLabel}</span></div>
          {isTransfer ? (
            <div className="grid grid-cols-[180px_1fr] gap-3">
              <b>Chuyển từ</b>
              <span>{storeLabel(doc.branchCode)} · {warehouseLabel(doc.warehouseCode)}</span>
            </div>
          ) : (
            <div className="grid grid-cols-[180px_1fr] gap-3">
              <b>Nhà cung cấp</b>
              <span className={partnerName ? "" : "border-b border-dotted border-slate-400"}>{partnerName || ""}</span>
            </div>
          )}
          <div className="grid grid-cols-[180px_1fr] gap-3"><b>Nhập tại kho</b><span>{warehouseLabel(warehouseCode)}</span></div>
          {doc.referenceCode && doc.referenceCode !== doc.code && <div className="grid grid-cols-[180px_1fr] gap-3"><b>Chứng từ tham chiếu</b><span>{doc.referenceCode}</span></div>}
          {doc.note && <div className="grid grid-cols-[180px_1fr] gap-3"><b>Ghi chú</b><span>{doc.note}</span></div>}
        </div>

        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y-2 border-slate-300 text-left text-xs uppercase text-slate-500">
              <th className="py-2 pr-2">STT</th>
              <th className="py-2 pr-2">Mã hàng</th>
              <th className="py-2 pr-2">Tên hàng</th>
              <th className="py-2 pr-2">ĐVT</th>
              <th className="py-2 pr-2 text-right">Số lượng</th>
              <th className="py-2 pr-2 text-right">Đơn giá</th>
              <th className="py-2 pr-2 text-right">Thành tiền</th>
              {hasVat && <th className="py-2 text-right">Thuế GTGT</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} className="border-b border-slate-100 align-top">
                <td className="py-2 pr-2">{index + 1}</td>
                <td className="py-2 pr-2 whitespace-nowrap">{row.item.code}</td>
                <td className="py-2 pr-2">{row.item.name}</td>
                <td className="py-2 pr-2">{row.printUnit}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{qty(row.printQuantity)}</td>
                <td className="py-2 pr-2 text-right tabular-nums">{money(row.printUnitPrice)}</td>
                <td className="py-2 pr-2 text-right tabular-nums font-bold">{money(row.totalCost)}</td>
                {hasVat && (
                  <td className="py-2 text-right tabular-nums">
                    {row.vatAmount > 0 ? money(row.vatAmount) : "-"}
                    {row.vatRate !== null && <small className="block text-slate-500">{vatRateLabel(row.vatRate)}</small>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300">
              <td colSpan={6} className="py-2 font-bold">Cộng tiền hàng</td>
              <td className="py-2 pr-2 text-right tabular-nums text-base font-bold">{money(totalBeforeTax)}</td>
              {hasVat && <td className="py-2 text-right tabular-nums font-bold">{money(totalVat)}</td>}
            </tr>
            {hasVat && (
              <tr>
                <td colSpan={6} className="py-2 font-bold">Tổng cộng thanh toán (gồm thuế)</td>
                <td colSpan={2} className="py-2 text-right tabular-nums text-base font-bold">{money(totalBeforeTax + totalVat)} đ</td>
              </tr>
            )}
          </tfoot>
        </table>

        {/* Ô ký để trống cho ký tay trên bản in. */}
        <div className="grid grid-cols-4 gap-6 text-center mt-16 text-sm">
          <div><b>Người lập phiếu</b><div className="h-20" /><p>{doc.createdBy || ""}</p></div>
          <div><b>{isTransfer ? "Người giao hàng" : "Người giao hàng (NCC)"}</b><div className="h-20" /></div>
          <div><b>Thủ kho</b><div className="h-20" /></div>
          <div><b>Kế toán</b><div className="h-20" /></div>
        </div>
      </div>
    </main>
  );
}
