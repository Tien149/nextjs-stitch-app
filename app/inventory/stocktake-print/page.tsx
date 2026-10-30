"use client";

import { useEffect, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { money, quantity as qty } from "@/lib/format-number";
import { goodsGroupKey } from "@/lib/goods-group";

/**
 * BIÊN BẢN KIỂM KÊ in từ màn Giải trình kiểm kê (khách 30/10/2026: in để nhà hàng ký xác nhận).
 * Số lấy đúng bản giải trình đang mở (cùng đơn giá tạm tính với màn hình); lọc nhóm / tìm mã theo
 * màn hình, mặc định chỉ in dòng có chênh lệch. Giải trình chưa chốt thì in kèm dấu "Bản nháp".
 */
type Line = {
  itemId: string; itemCode: string; itemName: string; goodsGroup: string | null; unit: string;
  closing: number; counted: number; variance: number; unitCost: number; explanation: string;
  notCounted?: boolean; countAsZero?: boolean;
};
type Detail = {
  explanation: {
    sourceCode: string; branchCode: string; warehouseCode: string; periodFrom: string | null; periodTo: string;
    status: string; lines: Line[]; lockedBy: string | null; lockedAt: string | null; snapshotAt: string | null;
  };
  unitCosts?: Record<string, number>;
};
type BranchOption = { code: string; name: string };

const dateTime = (value: string | null | undefined) =>
  (value ? new Date(value).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

export default function StocktakePrintPage() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [params] = useState(() => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search));
  const [onlyVariance, setOnlyVariance] = useState(() => params.get("all") !== "1");

  useEffect(() => {
    const sessionKey = params.get("sk") || "";
    const raw = sessionKey ? localStorage.getItem(sessionKey) : null;
    const headers: Record<string, string> = raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
    fetch(`/api/inventory?view=stocktake-explanation&id=${encodeURIComponent(params.get("id") || "")}`, { headers }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) setDetail(data as Detail);
      else setError((data as { error?: string }).error || "Không tải được bản giải trình");
    });
    fetch("/api/branding").then(async (response) => {
      if (response.ok) setBranches(((await response.json()) as { branches?: BranchOption[] }).branches || []);
    });
  }, [params]);

  if (error) return <div className="p-10 text-rose-700">{error}</div>;
  if (!detail) return <div className="p-10">Đang tải biên bản kiểm kê...</div>;

  const { explanation } = detail;
  const locked = explanation.status === "LOCKED";
  const group = params.get("group") || "ALL";
  const keyword = (params.get("search") || "").trim().toLowerCase();
  const onlyCounted = params.get("counted") === "1";
  const lines = explanation.lines.filter((line) => {
    if (onlyVariance && Math.abs(line.variance) <= 1e-6) return false;
    if (onlyCounted && line.notCounted) return false;
    if (group === "MISSING" && line.goodsGroup) return false;
    if (!["ALL", "MISSING"].includes(group) && goodsGroupKey(line.goodsGroup) !== group) return false;
    return !keyword || line.itemCode.toLowerCase().includes(keyword) || line.itemName.toLowerCase().includes(keyword);
  });
  const unitCostOf = (line: Line) => detail.unitCosts?.[line.itemId] ?? line.unitCost ?? 0;
  const valueOf = (line: Line) => Math.round(line.variance * unitCostOf(line));
  const surplus = lines.reduce((sum, line) => sum + Math.max(0, valueOf(line)), 0);
  const shortage = lines.reduce((sum, line) => sum + Math.min(0, valueOf(line)), 0);
  const branchName = branches.find((branch) => branch.code === explanation.branchCode)?.name || storeLabel(explanation.branchCode);
  const warehouseName = params.get("wname") || "";
  const countedText = (line: Line) => (line.notCounted && !line.countAsZero ? "Không kiểm" : qty(line.counted));

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <style>{"@page { size: A4 landscape; margin: 10mm; }"}</style>
      <div className="max-w-6xl mx-auto border border-slate-200 p-8 print:border-0 print:max-w-none print:p-0">
        <div className="flex justify-between items-start border-b border-slate-200 pb-4">
          <div>
            <h1 className="text-2xl font-bold uppercase">{branchName}</h1>
            <p className="text-sm text-slate-500 mt-1">Kho: {warehouseName ? `${warehouseName} (${explanation.warehouseCode})` : explanation.warehouseCode}</p>
          </div>
          <div className="flex items-center gap-3 print:hidden">
            <label className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-600">
              <input type="checkbox" checked={onlyVariance} onChange={(event) => setOnlyVariance(event.target.checked)} />
              Chỉ in dòng có chênh lệch
            </label>
            <button onClick={() => window.print()} className="rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In biên bản</button>
          </div>
          {!locked && <p className="hidden print:block rounded border-2 border-rose-600 px-3 py-1 text-sm font-bold uppercase text-rose-700">Bản nháp – chưa chốt</p>}
        </div>

        <section className="text-center py-6">
          <h2 className="text-3xl font-bold uppercase tracking-wide">Biên bản kiểm kê</h2>
          <p className="mt-2 text-sm text-slate-600">
            Đợt <b>{explanation.sourceCode}</b> · Kỳ {explanation.periodFrom ? dateTime(explanation.periodFrom) : "từ lúc lên hệ thống"} → <b>{dateTime(explanation.periodTo)}</b> (giờ chốt)
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {locked ? `Giải trình đã chốt ${dateTime(explanation.lockedAt)}${explanation.lockedBy ? ` bởi ${explanation.lockedBy}` : ""}` : <span className="font-bold text-rose-700">Bản nháp – giải trình chưa chốt, số liệu còn có thể thay đổi</span>}
            {" · "}In lúc {dateTime(new Date().toISOString())}
          </p>
          <p className="text-xs text-slate-500 mt-1">{onlyVariance ? `Các mã có chênh lệch (${lines.length} mã)` : `${lines.length} mã`}</p>
        </section>

        <table className="w-full border-collapse text-xs print:text-[9px] print:leading-tight">
          <thead>
            <tr className="border-y-2 border-slate-300 text-[10px] uppercase text-slate-500 print:text-[7.5px]">
              <th className="py-2 pr-1 text-left">STT</th>
              <th className="py-2 pr-1 text-left">Mã hàng</th>
              <th className="py-2 pr-1 text-left">Tên hàng</th>
              <th className="py-2 pr-1 text-left">ĐVT</th>
              <th className="py-2 pr-1 text-right">SL sổ sách</th>
              <th className="py-2 pr-1 text-right">SL kiểm kê</th>
              <th className="py-2 pr-1 text-right">Chênh lệch</th>
              <th className="py-2 pr-1 text-right">Đơn giá</th>
              <th className="py-2 pr-1 text-right">Trị giá chênh lệch</th>
              <th className="py-2 pl-2 text-left w-[28%]">Giải trình</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={10} className="py-6 text-center text-slate-400">Không có mã nào{onlyVariance ? " có chênh lệch" : ""}.</td></tr>}
            {lines.map((line, index) => {
              const hasVariance = Math.abs(line.variance) > 1e-6;
              return (
                <tr key={line.itemId} className="border-b border-slate-100 align-top break-inside-avoid">
                  <td className="py-1.5 pr-1">{index + 1}</td>
                  <td className="py-1.5 pr-1 whitespace-nowrap">{line.itemCode}</td>
                  <td className="py-1.5 pr-1">{line.itemName}</td>
                  <td className="py-1.5 pr-1">{line.unit}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{qty(line.closing)}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{countedText(line)}</td>
                  <td className={`py-1.5 pr-1 text-right tabular-nums font-bold ${hasVariance ? (line.variance > 0 ? "text-emerald-700" : "text-rose-700") : ""}`}>{hasVariance ? qty(line.variance) : "-"}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{hasVariance ? money(unitCostOf(line)) : ""}</td>
                  <td className="py-1.5 pr-1 text-right tabular-nums">{hasVariance ? money(valueOf(line)) : ""}</td>
                  <td className="py-1.5 pl-2 whitespace-pre-wrap">{line.explanation || ""}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-300">
              <td colSpan={8} className="py-1.5 text-right font-bold">Trị giá thừa</td>
              <td className="py-1.5 pr-1 text-right tabular-nums font-bold text-emerald-700">{money(surplus)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={8} className="py-1.5 text-right font-bold">Trị giá thiếu</td>
              <td className="py-1.5 pr-1 text-right tabular-nums font-bold text-rose-700">{money(shortage)}</td>
              <td />
            </tr>
            <tr className="border-t border-slate-300">
              <td colSpan={8} className="py-1.5 text-right font-bold">Chênh lệch thuần</td>
              <td className="py-1.5 pr-1 text-right tabular-nums font-bold">{money(surplus + shortage)} đ</td>
              <td />
            </tr>
          </tfoot>
        </table>
        <p className="mt-2 text-[11px] text-slate-500">Đơn giá, trị giá chênh lệch là tạm tính theo giá vốn tại thời điểm in; số chính thức ghi nhận khi chốt giải trình.</p>

        {/* Ô ký để trống cho ký tay trên bản in. */}
        <div className="grid grid-cols-4 gap-6 text-center mt-12 text-sm break-inside-avoid">
          {["Người kiểm kê", "Quản lý nhà hàng", "Kế toán", "Giám đốc"].map((title) => (
            <div key={title}><b>{title}</b><p className="text-xs italic text-slate-500">(Ký, ghi rõ họ tên)</p><div className="h-20" /></div>
          ))}
        </div>
      </div>
    </main>
  );
}
