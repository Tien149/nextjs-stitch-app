"use client";

import { useEffect, useState } from "react";
import { formatPeriodCount } from "@/lib/period-count";
import { useParams } from "next/navigation";
import { storeLabel } from "@/lib/branch-labels";
import { money, quantity as qty } from "@/lib/format-number";
import { vatRateLabel } from "@/lib/inventory-vat";

/**
 * Bản in PHIẾU NHẬP TÀI SẢN / PHIẾU NHẬP CCDC (khách yêu cầu 03/10/2026) — mở từ nút In trên
 * danh sách Tài sản & CCDC. Cùng kiểu trang in phiếu nhập kho (app/inventory/[id]/print): tên nhà
 * hàng, tiêu đề lớn, bảng, ô ký tay.
 *
 * Một phiếu in được NHIỀU tài sản (khách 27/10/2026): `/assets/<id>/print` một đợt, `?ids=a,b`
 * các dòng tick chọn, `?doc=MTS-…` cả phiếu mua. Bảng đủ cột như phiếu nhập mua: SL × đơn giá,
 * chiết khấu, thuế, chi phí mua phân bổ, nguyên giá (= số dùng khấu hao).
 */
type Asset = {
  id: string;
  code: string;
  lotNo: number;
  name: string;
  branchCode: string;
  departmentCode: string | null;
  assetGroup: string;
  location: string | null;
  warehouseCode: string | null;
  quantity: number;
  purchaseDate: string;
  originalCost: number;
  usefulLifeMonths: number | null;
  depreciationStartDate: string | null;
  residualValue: number;
  supplierCode: string | null;
  paymentStatus: string;
  payableAmount: number;
  paymentDueDate: string | null;
  openingBalanceId: string | null;
  note: string | null;
  purchaseDocCode: string | null;
  unitPrice: number | null;
  discountRate: number | null;
  discountAmount: number;
  vatRate: number | null;
  vatAmount: number;
  purchaseCostShare: number;
};
type Item = {
  asset: Asset;
  warehouseName: string | null;
  departmentName: string | null;
  groupName: string | null;
  isTool: boolean;
  supplierName: string | null;
  debt: { code: string; status: string; dueDate: string | null } | null;
  lotCount: number;
};
type BranchOption = { code: string; name: string };

const day = (value: string | null) => (value ? new Date(value).toLocaleDateString("vi-VN") : "");
/** Giá trị chung của mọi dòng, khác nhau thì null. */
const shared = <T,>(values: T[]) => (values.every((value) => value === values[0]) ? values[0] : null);

/** Các cột mua của một dòng; hồ sơ cũ (trước khi có đơn giá / thuế) coi nguyên giá là tiền hàng. */
function figuresOf(asset: Asset) {
  const quantity = asset.quantity || 1;
  if (asset.unitPrice === null || asset.unitPrice === undefined) {
    return { quantity, unitPrice: asset.originalCost / quantity, gross: asset.originalCost, discount: 0, vatAmount: 0, afterTax: asset.originalCost, share: 0 };
  }
  const gross = Math.round(quantity * asset.unitPrice);
  const afterTax = gross - (asset.discountAmount || 0) + (asset.vatAmount || 0);
  return { quantity, unitPrice: asset.unitPrice, gross, discount: asset.discountAmount || 0, vatAmount: asset.vatAmount || 0, afterTax, share: asset.purchaseCostShare || 0 };
}

export default function AssetReceiptPrintPage() {
  const params = useParams<{ id: string }>();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const query = search.get("doc")
      ? `doc=${encodeURIComponent(search.get("doc") || "")}`
      : search.get("ids")
        ? `ids=${encodeURIComponent(search.get("ids") || "")}`
        : `id=${encodeURIComponent(params.id)}`;
    fetch(`/api/assets?view=print&${query}`).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) setItems((data as { items: Item[] }).items);
      else setError((data as { error?: string }).error || "Không tải được tài sản");
    });
    fetch("/api/branding").then(async (response) => {
      if (response.ok) setBranches(((await response.json()) as { branches?: BranchOption[] }).branches || []);
    });
  }, [params.id]);

  if (error) return <div className="p-10 text-rose-700">{error}</div>;
  if (!items) return <div className="p-10">Đang tải phiếu nhập...</div>;

  const assets = items.map((item) => item.asset);
  const first = items[0];
  const branchCode = shared(assets.map((asset) => asset.branchCode));
  const branchName = branchCode ? branches.find((branch) => branch.code === branchCode)?.name || storeLabel(branchCode) : "Nhiều nhà hàng";
  const warehouseCode = shared(assets.map((asset) => asset.warehouseCode || asset.location || ""));
  const warehouseName = warehouseCode ? items.find((item) => (item.asset.warehouseCode || item.asset.location || "") === warehouseCode)?.warehouseName : null;
  const warehouseLabel = warehouseCode === null ? "Nhiều kho / vị trí" : warehouseName ? `${warehouseName} (${warehouseCode})` : warehouseCode;
  const supplierText = shared(items.map((item) => `${item.asset.supplierCode ? `${item.asset.supplierCode} - ` : ""}${item.supplierName || ""}`));
  const departmentText = shared(items.map((item) => (item.departmentName ? `${item.departmentName} (${item.asset.departmentCode})` : item.asset.departmentCode || "")));
  const kinds = new Set(items.map((item) => item.isTool));
  const kind = kinds.size > 1 ? "tài sản / CCDC" : first.isTool ? "công cụ dụng cụ" : "tài sản";
  const docCode = shared(assets.map((asset) => asset.purchaseDocCode));
  const purchaseDay = shared(assets.map((asset) => day(asset.purchaseDate)));
  const debts = items.flatMap((item) => (item.debt ? [item.debt.code] : []));
  const payment = debts.length > 0
    ? `Ghi công nợ ${debts.join(", ")}${items.length === 1 && first.debt?.dueDate ? ` · hạn ${day(first.debt.dueDate)}` : ""}`
    : items.length === 1 && first.asset.openingBalanceId
      ? "Số dư đầu kỳ"
      : shared(assets.map((asset) => asset.paymentStatus)) === "PAID"
        ? "Đã thanh toán"
        : "";
  const notes = [...new Set(assets.map((asset) => asset.note).filter(Boolean))];
  const rows = items.map((item) => ({ item, figures: figuresOf(item.asset) }));
  const sum = (pick: (figures: ReturnType<typeof figuresOf>) => number) => rows.reduce((total, row) => total + pick(row.figures), 0);
  const totalCost = assets.reduce((total, asset) => total + asset.originalCost, 0);
  const row = (label: string, value: React.ReactNode, blankLine = false) => (
    <div className="grid grid-cols-[180px_1fr] gap-3">
      <b>{label}</b>
      <span className={blankLine && !value ? "border-b border-dotted border-slate-400" : ""}>{value}</span>
    </div>
  );

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-6xl mx-auto border border-slate-200 p-8 print:border-0 print:max-w-none print:p-0">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold uppercase">{branchName}</h1>
            {warehouseCode && <p className="text-sm text-slate-500 mt-1">Kho / vị trí: {warehouseLabel}</p>}
          </div>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In phiếu</button>
        </div>

        <section className="text-center py-8">
          <h2 className="text-3xl font-bold uppercase tracking-wide">Phiếu nhập {kind}</h2>
          <p className="mt-2 text-sm uppercase tracking-widest text-slate-500">
            {docCode || (items.length === 1 ? `${first.asset.code}${first.lotCount > 1 ? ` · đợt ${first.asset.lotNo}` : ""}` : `${items.length} mã`)}
          </p>
          <p className="text-sm text-slate-500 mt-2">{purchaseDay ? `Ngày ${purchaseDay}` : `Từ ${day(assets[0].purchaseDate)} đến ${day(assets[assets.length - 1].purchaseDate)}`}</p>
        </section>

        <div className="space-y-3 text-sm">
          {row("Nhà cung cấp", supplierText === null ? "Nhiều nhà cung cấp" : supplierText, true)}
          {row("Nhập tại kho / vị trí", warehouseLabel, true)}
          {row("Bộ phận sử dụng", departmentText === null ? "Nhiều bộ phận" : departmentText, true)}
          {payment && row("Thanh toán", payment)}
          {notes.length > 0 && row("Ghi chú", notes.join(" · "))}
        </div>

        {/* Nhiều cột như phiếu nhập mua: chữ nhỏ lại khi in để đủ trên A4 dọc. */}
        <table className="mt-6 w-full border-collapse text-xs print:text-[8.5px] print:leading-tight">
          <thead>
            <tr className="border-y-2 border-slate-300 text-[10px] uppercase text-slate-500 print:text-[7px]">
              <th className="py-2 pr-1 text-left">STT</th>
              <th className="py-2 pr-1 text-left">Mã</th>
              <th className="py-2 pr-1 text-left">Tên</th>
              <th className="py-2 pr-1 text-right">SL</th>
              <th className="py-2 pr-1 text-right">Đơn giá</th>
              <th className="py-2 pr-1 text-right">Thành tiền trước thuế</th>
              <th className="py-2 pr-1 text-right">Chiết khấu</th>
              <th className="py-2 pr-1 text-right">Thuế suất</th>
              <th className="py-2 pr-1 text-right">Tiền thuế</th>
              <th className="py-2 pr-1 text-right">Thành tiền sau thuế</th>
              <th className="py-2 pr-1 text-right">CP mua phân bổ</th>
              <th className="py-2 pr-1 text-right">Nguyên giá</th>
              <th className="py-2 text-right">Số kỳ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, figures }, index) => (
              <tr key={item.asset.id} className="border-b border-slate-100 align-top">
                <td className="py-1.5 pr-1">{index + 1}</td>
                <td className="py-1.5 pr-1 whitespace-nowrap">{item.asset.code}{item.lotCount > 1 && <small className="block text-slate-500">đợt {item.asset.lotNo}</small>}</td>
                <td className="py-1.5 pr-1">{item.asset.name}<small className="block text-slate-500">{item.groupName || item.asset.assetGroup}</small></td>
                <td className="py-1.5 pr-1 text-right tabular-nums">{qty(figures.quantity)}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums">{money(figures.unitPrice)}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums">{money(figures.gross)}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums">
                  {figures.discount > 0 ? money(figures.discount) : "-"}
                  {item.asset.discountRate !== null && item.asset.discountRate !== undefined && <small className="block text-slate-500">{Number((item.asset.discountRate * 100).toFixed(2))}%</small>}
                </td>
                <td className="py-1.5 pr-1 text-right">{item.asset.unitPrice === null ? "-" : vatRateLabel(item.asset.vatRate)}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums">{figures.vatAmount > 0 ? money(figures.vatAmount) : "-"}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums">{money(figures.afterTax)}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums">{figures.share > 0 ? money(figures.share) : "-"}</td>
                <td className="py-1.5 pr-1 text-right tabular-nums font-bold">{money(item.asset.originalCost)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {item.asset.usefulLifeMonths ? `${formatPeriodCount(item.asset.usefulLifeMonths)} kỳ` : "-"}
                  {item.asset.depreciationStartDate && <small className="block text-slate-500">từ {day(item.asset.depreciationStartDate)}</small>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300 font-bold">
              <td colSpan={5} className="py-2">Cộng</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(sum((figures) => figures.gross))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(sum((figures) => figures.discount))}</td>
              <td />
              <td className="py-2 pr-1 text-right tabular-nums">{money(sum((figures) => figures.vatAmount))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(sum((figures) => figures.afterTax))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(sum((figures) => figures.share))}</td>
              <td className="py-2 pr-1 text-right tabular-nums">{money(totalCost)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={10} className="py-2 font-bold">Tổng nguyên giá <span className="font-normal text-slate-500">(sau chiết khấu, gồm thuế và chi phí mua hàng — số dùng để khấu hao / phân bổ)</span></td>
              <td colSpan={3} className="py-2 text-right tabular-nums text-sm font-bold">{money(totalCost)} đ</td>
            </tr>
          </tfoot>
        </table>

        {/* Ô ký để trống cho ký tay trên bản in. */}
        <div className="grid grid-cols-4 gap-6 text-center mt-16 text-sm">
          <div><b>Người lập phiếu</b><div className="h-20" /></div>
          <div><b>Người giao hàng (NCC)</b><div className="h-20" /></div>
          <div><b>Bộ phận sử dụng</b><div className="h-20" /></div>
          <div><b>Kế toán</b><div className="h-20" /></div>
        </div>
      </div>
    </main>
  );
}
