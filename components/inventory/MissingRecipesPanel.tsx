"use client";

import { useCallback, useEffect, useState } from "react";
import CopyableText from "@/components/CopyableText";
import ExportExcelButton from "@/components/ExportExcelButton";
import { money, quantity as qty } from "@/lib/format-number";
import type { MissingRecipeReport } from "@/lib/missing-recipes";

/**
 * Bảng "Mã thiếu định lượng" ở tab Định lượng — xem lib/missing-recipes.ts. Tải riêng theo tháng
 * + cửa hàng để kế toán soát đủ BOM trước khi bấm Rã, không phải chạy lệnh trên máy chủ.
 */
type Props = {
  sessionKey: string;
  branchOptions: Array<{ code: string; label: string }>;
  defaultBranch: string;
};

function sessionHeaders(sessionKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(sessionKey);
  return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

const TYPE_LABEL: Record<string, string> = { FINISHED: "Thành phẩm", SEMI_FINISHED: "Bán thành phẩm" };

export default function MissingRecipesPanel({ sessionKey, branchOptions, defaultBranch }: Props) {
  const [month, setMonth] = useState(currentMonth);
  const [branchCode, setBranchCode] = useState(defaultBranch || "ALL");
  const [report, setReport] = useState<MissingRecipeReport | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const branchLabel = (code: string) => branchOptions.find((option) => option.code === code)?.label || code;

  const load = useCallback(async () => {
    if (!/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/inventory?view=missing-recipes&month=${month}&branchCode=${encodeURIComponent(branchCode)}`, { headers: sessionHeaders(sessionKey) });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không tải được danh sách mã thiếu định lượng");
        return;
      }
      setReport(payload);
    } catch {
      setMessage("Mất kết nối tới máy chủ khi tải danh sách mã thiếu định lượng.");
    } finally {
      setLoading(false);
    }
  }, [month, branchCode, sessionKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const sold = report?.sold || [];
  const components = report?.components || [];

  return (
    <section className="table-panel shadow-sm">
      <div className="p-5 flex flex-wrap justify-between items-start gap-3">
        <div>
          <h2 className="font-bold text-slate-800">Mã thiếu định lượng</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-relaxed">
            Thành phẩm / bán thành phẩm chưa có định lượng áp dụng cho cửa hàng. Lúc rã, món bán thiếu định lượng bị
            <b> xuất bán thẳng từ tồn kho</b> (tồn âm, giá vốn 0); thành phần thiếu định lượng bị trừ tồn mà không bao
            giờ được chế biến. Khai định lượng xong thì rã lại tháng đó.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-bold text-slate-500">
            Tháng
            <input type="month" className="control mt-1" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          <label className="text-xs font-bold text-slate-500">
            Cửa hàng
            <select className="control mt-1" value={branchCode} onChange={(event) => setBranchCode(event.target.value)}>
              {branchOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
          <button type="button" title="Tải lại" onClick={() => void load()} className="icon-button">
            <span className={`material-symbols-outlined text-lg ${loading ? "animate-spin" : ""}`}>refresh</span>
          </button>
        </div>
      </div>
      {message && <p className="mx-5 mb-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-3">{message}</p>}

      <div data-export-root className="border-t border-slate-100">
        <div className="px-5 py-3 flex justify-between items-center gap-3">
          <h3 className="text-sm font-bold text-slate-700">
            1. Món bán trong tháng chưa có định lượng <span className={sold.length ? "text-rose-600" : "text-emerald-700"}>({sold.length})</span>
          </h3>
          <ExportExcelButton fileName={`ma_ban_thieu_dinh_luong_${month}`} sheetName="Mon ban thieu dinh luong" />
        </div>
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-left font-bold">Cửa hàng</th>
                <th className="px-4 py-3 text-left font-bold">Mã</th>
                <th className="px-4 py-3 text-left font-bold">Tên</th>
                <th className="px-4 py-3 text-left font-bold">Nhóm</th>
                <th className="px-4 py-3 text-right font-bold">SL bán</th>
                <th className="px-4 py-3 text-right font-bold">Doanh thu</th>
              </tr>
            </thead>
            <tbody>
              {sold.length === 0 && (
                <tr><td colSpan={6} className="cell text-center text-emerald-700">{loading ? "Đang tải..." : "Mọi món bán trong tháng đều đã có định lượng."}</td></tr>
              )}
              {sold.map((row) => (
                <tr key={`${row.branchCode}|${row.productCode}`} className="border-t border-slate-100">
                  <td className="cell whitespace-nowrap">{branchLabel(row.branchCode)}</td>
                  <td className="cell"><CopyableText value={row.productCode}><b>{row.productCode}</b></CopyableText></td>
                  <td className="cell min-w-[200px]">{row.productName || <span className="text-rose-600">Chưa có trong danh mục mặt hàng</span>}</td>
                  <td className="cell whitespace-nowrap">{row.itemType ? TYPE_LABEL[row.itemType] || row.itemType : "-"}</td>
                  <td className="cell text-right tabular-nums">{qty(row.quantity)}</td>
                  <td className="cell text-right tabular-nums">{money(row.revenue)} đ</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div data-export-root className="border-t border-slate-100">
        <div className="px-5 py-3 flex justify-between items-center gap-3">
          <h3 className="text-sm font-bold text-slate-700">
            2. Thành phần trong định lượng chưa có định lượng riêng <span className={components.length ? "text-rose-600" : "text-emerald-700"}>({components.length})</span>
          </h3>
          <ExportExcelButton fileName={`thanh_phan_thieu_dinh_luong_${month}`} sheetName="Thanh phan thieu dinh luong" />
        </div>
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-left font-bold">Cửa hàng</th>
                <th className="px-4 py-3 text-left font-bold">Mã</th>
                <th className="px-4 py-3 text-left font-bold">Tên</th>
                <th className="px-4 py-3 text-left font-bold">Nhóm</th>
                <th className="px-4 py-3 text-left font-bold">Dùng trong món</th>
                <th className="px-4 py-3 text-right font-bold">Nhập mua trong tháng</th>
                <th className="px-4 py-3 text-left font-bold">Gợi ý</th>
              </tr>
            </thead>
            <tbody>
              {components.length === 0 && (
                <tr><td colSpan={7} className="cell text-center text-emerald-700">{loading ? "Đang tải..." : "Mọi thành phần đều đã có định lượng."}</td></tr>
              )}
              {components.map((row) => (
                <tr key={`${row.branchCode}|${row.itemCode}`} className="border-t border-slate-100">
                  <td className="cell whitespace-nowrap">{branchLabel(row.branchCode)}</td>
                  <td className="cell"><CopyableText value={row.itemCode}><b>{row.itemCode}</b></CopyableText></td>
                  <td className="cell min-w-[200px]">{row.itemName}</td>
                  <td className="cell whitespace-nowrap">{TYPE_LABEL[row.itemType] || row.itemType}</td>
                  <td className="cell" title={row.usedIn.join(", ")}>
                    {row.usedIn.slice(0, 3).join(", ")}{row.usedIn.length > 3 ? ` +${row.usedIn.length - 3} món` : ""}
                  </td>
                  <td className="cell text-right tabular-nums">{row.purchasedQuantity > 0 ? qty(row.purchasedQuantity) : "-"}</td>
                  <td className="cell text-xs min-w-[220px]">
                    {row.purchasedQuantity > 0
                      ? <span className="text-amber-700">Có nhập mua — nếu là hàng mua sẵn thì đổi nhóm sang Nguyên liệu</span>
                      : <span className="text-slate-600">Bếp tự làm thì khai định lượng</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
