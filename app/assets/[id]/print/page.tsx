"use client";

import { useEffect, useState } from "react";
import { formatPeriodCount } from "@/lib/period-count";
import { useParams } from "next/navigation";
import { storeLabel } from "@/lib/branch-labels";
import { money, quantity as qty } from "@/lib/format-number";

/**
 * Bản in PHIẾU NHẬP TÀI SẢN / PHIẾU NHẬP CCDC (khách yêu cầu 03/10/2026) — mở từ nút In trên
 * danh sách Tài sản & CCDC. Mỗi phiếu là một đợt của mã (một mã nhiều đợt mua: in từng đợt). Cùng
 * kiểu trang in phiếu nhập kho (app/inventory/[id]/print): tên nhà hàng, tiêu đề lớn, bảng, ô ký tay.
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
};
type Payload = {
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

export default function AssetReceiptPrintPage() {
  const params = useParams<{ id: string }>();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);

  useEffect(() => {
    fetch(`/api/assets?view=print&id=${encodeURIComponent(params.id)}`).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) setPayload(data as Payload);
      else setError((data as { error?: string }).error || "Không tải được tài sản");
    });
    fetch("/api/branding").then(async (response) => {
      if (response.ok) setBranches(((await response.json()) as { branches?: BranchOption[] }).branches || []);
    });
  }, [params.id]);

  if (error) return <div className="p-10 text-rose-700">{error}</div>;
  if (!payload) return <div className="p-10">Đang tải phiếu nhập...</div>;

  const { asset, warehouseName, departmentName, groupName, isTool, supplierName, debt, lotCount } = payload;
  const branchName = branches.find((branch) => branch.code === asset.branchCode)?.name || storeLabel(asset.branchCode);
  const warehouseCode = asset.warehouseCode || asset.location || "";
  const warehouseLabel = warehouseName ? `${warehouseName} (${warehouseCode})` : warehouseCode;
  const quantity = asset.quantity || 1;
  const unitCost = asset.originalCost / quantity;
  const kind = isTool ? "công cụ dụng cụ" : "tài sản";
  const payment = debt
    ? `Ghi công nợ ${debt.code}${debt.dueDate ? ` · hạn ${day(debt.dueDate)}` : ""}`
    : asset.openingBalanceId
      ? "Số dư đầu kỳ"
      : asset.paymentStatus === "PAYABLE"
        ? "Ghi công nợ"
        : asset.paymentStatus === "PAID"
          ? "Đã thanh toán"
          : "";
  const row = (label: string, value: React.ReactNode, blankLine = false) => (
    <div className="grid grid-cols-[180px_1fr] gap-3">
      <b>{label}</b>
      <span className={blankLine && !value ? "border-b border-dotted border-slate-400" : ""}>{value}</span>
    </div>
  );

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-4xl mx-auto border border-slate-200 p-8 print:border-0 print:max-w-none">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold uppercase">{branchName}</h1>
            {warehouseCode && <p className="text-sm text-slate-500 mt-1">Kho / vị trí: {warehouseLabel}</p>}
          </div>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In phiếu</button>
        </div>

        <section className="text-center py-8">
          <h2 className="text-3xl font-bold uppercase tracking-wide">Phiếu nhập {kind}</h2>
          <p className="mt-2 text-sm uppercase tracking-widest text-slate-500">{asset.code}{lotCount > 1 ? ` · đợt ${asset.lotNo}` : ""}</p>
          <p className="text-sm text-slate-500 mt-2">Ngày {day(asset.purchaseDate)}</p>
        </section>

        <div className="space-y-3 text-sm">
          {row("Nhà cung cấp", supplierName ? `${asset.supplierCode ? `${asset.supplierCode} - ` : ""}${supplierName}` : "", true)}
          {row("Nhập tại kho / vị trí", warehouseLabel, true)}
          {row("Bộ phận sử dụng", departmentName ? `${departmentName} (${asset.departmentCode})` : asset.departmentCode || "", true)}
          {payment && row("Thanh toán", payment)}
          {asset.note && row("Ghi chú", asset.note)}
        </div>

        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y-2 border-slate-300 text-left text-xs uppercase text-slate-500">
              <th className="py-2 pr-2">STT</th>
              <th className="py-2 pr-2">Mã {isTool ? "CCDC" : "tài sản"}</th>
              <th className="py-2 pr-2">Tên {isTool ? "CCDC" : "tài sản"}</th>
              <th className="py-2 pr-2">Nhóm</th>
              <th className="py-2 pr-2 text-right">Số lượng</th>
              <th className="py-2 pr-2 text-right">Đơn giá</th>
              <th className="py-2 pr-2 text-right">Nguyên giá</th>
              <th className="py-2 text-right">{isTool ? "Số kỳ phân bổ" : "Số kỳ khấu hao"}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-100 align-top">
              <td className="py-2 pr-2">1</td>
              <td className="py-2 pr-2 whitespace-nowrap">{asset.code}</td>
              <td className="py-2 pr-2">{asset.name}</td>
              <td className="py-2 pr-2">{groupName || asset.assetGroup}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{qty(quantity)}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{money(unitCost)}</td>
              <td className="py-2 pr-2 text-right tabular-nums font-bold">{money(asset.originalCost)}</td>
              <td className="py-2 text-right tabular-nums">
                {asset.usefulLifeMonths ? `${formatPeriodCount(asset.usefulLifeMonths)} kỳ` : "-"}
                {asset.depreciationStartDate && <small className="block text-slate-500">từ {day(asset.depreciationStartDate)}</small>}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300">
              <td colSpan={6} className="py-2 font-bold">Tổng nguyên giá</td>
              <td className="py-2 pr-2 text-right tabular-nums text-base font-bold">{money(asset.originalCost)} đ</td>
              <td />
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
