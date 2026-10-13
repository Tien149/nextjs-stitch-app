"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { money, quantity as qty } from "@/lib/format-number";
import { cogsRepostMessage, type CogsRepostResult } from "@/lib/inventory-cogs";

/**
 * Tính giá vốn bình quân cả tháng theo từng kho (khách chốt 13/10/2026) — thay nút "Tính giá" cũ.
 * Chạy thử (so sánh trước/sau) ai mở Kho cũng xem được; Ghi giá vốn cần quyền Duyệt ở Kho.
 * Nghiệp vụ: lib/inventory-monthly-cost.ts + lib/inventory-monthly-cost-db.ts.
 */

type PeriodStatus = { period: string; status: "OK" | "STALE" | "NEVER" | "STALE_EARLIER"; computedAt: string | null; computedBy: string | null };
type Report = {
  fromPeriod: string;
  toPeriod: string;
  cogs: Array<{ period: string; branchCode: string; label: string; before: number; after: number; fromZero: number }>;
  zeroLines: Array<{ period: string; total: number; before: number; after: number }>;
  unpriced: Array<{ itemCode: string; itemName: string; itemType: string; unit: string; warehouseCode: string; periods: string[]; outQty: number }>;
  changedLines: number;
  changedTransfers: Array<{ code: string; fromBranch: string; toBranch: string; before: number; after: number; settledDebt: string | null }>;
  locked: string | null;
};

type Props = {
  headers: () => Record<string, string>;
  canApply: boolean;
  /** Sau khi ghi giá: màn Kho tải lại tồn / phiếu để hiện giá mới. */
  onApplied: () => void;
};

const monthLabel = (period: string) => `T${period.slice(5)}/${period.slice(0, 4)}`;
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${money(Math.abs(value))}`;
const STATUS_UI: Record<PeriodStatus["status"], { label: string; tone: string }> = {
  OK: { label: "Đã tính", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  STALE: { label: "Cần tính lại", tone: "bg-amber-50 text-amber-800 border-amber-300" },
  STALE_EARLIER: { label: "Cần tính lại (tháng trước đổi)", tone: "bg-amber-50 text-amber-800 border-amber-300" },
  NEVER: { label: "Chưa tính", tone: "bg-slate-50 text-slate-600 border-slate-200" },
};

export default function MonthlyCostPanel({ headers, canApply, onApplied }: Props) {
  const [periods, setPeriods] = useState<PeriodStatus[]>([]);
  const [fromPeriod, setFromPeriod] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<"" | "status" | "preview" | "apply">("status");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [showUnpriced, setShowUnpriced] = useState(false);

  const applyStatus = (payload: { periods?: PeriodStatus[]; earliestPending?: string | null }) => {
    const rows = payload.periods || [];
    setPeriods(rows);
    setFromPeriod((current) => current || payload.earliestPending || rows.at(-1)?.period || "");
  };

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/inventory/monthly-cost", { headers: headers() });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) applyStatus(payload);
        else setError(payload.error || "Không tải được trạng thái tính giá");
      } finally {
        setBusy("");
      }
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (action: "PREVIEW" | "APPLY") => {
    setBusy(action === "APPLY" ? "apply" : "preview");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/inventory/monthly-cost", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ action, fromPeriod }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || "Không tính được giá vốn tháng");
        return;
      }
      setReport(payload.report);
      applyStatus(payload);
      if (action === "APPLY") {
        setConfirming(false);
        const repost = cogsRepostMessage(payload.reposted as CogsRepostResult[]);
        setNotice(`Đã ghi giá vốn ${monthLabel(payload.report.fromPeriod)} → ${monthLabel(payload.report.toPeriod)}: cập nhật ${payload.report.changedLines.toLocaleString("vi-VN")} dòng phiếu kho. ${repost}`);
        onApplied();
      }
    } finally {
      setBusy("");
    }
  };

  const pending = periods.filter((row) => row.status !== "OK");
  const grouped = useMemo(() => {
    const map = new Map<string, Report["cogs"]>();
    for (const row of report?.cogs || []) map.set(row.period, [...(map.get(row.period) || []), row]);
    return [...map.entries()];
  }, [report]);
  const settled = report?.changedTransfers.filter((row) => row.settledDebt) || [];
  const blocked = Boolean(report?.locked) || settled.length > 0;
  const previewMatches = report && report.fromPeriod === fromPeriod;

  return (
    <section className="bg-white border border-emerald-200 rounded-lg p-5 shadow-sm mb-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-slate-800 flex items-center gap-2">
            <span className="material-symbols-outlined text-emerald-600">calculate</span>
            Tính giá vốn bình quân cả tháng
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-3xl leading-relaxed">
            Giá tháng của từng mặt hàng × kho = (trị giá tồn đầu + trị giá nhập) ÷ (SL tồn đầu + SL nhập), theo <b>ngày chứng từ</b>. Mọi phiếu xuất,
            chế biến, điều chuyển, kiểm kê trong tháng được định giá lại, công nợ nội bộ điều chuyển và giá vốn P&amp;L ghi lại theo. Trong tháng phiếu vẫn
            lấy giá tạm tính (bình quân lúc lưu); nhập bổ sung phiếu lùi ngày thì tháng đó báo <b>Cần tính lại</b>.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-bold text-slate-600">
            Tính lại từ tháng
            <select className="control mt-1 block" value={fromPeriod} onChange={(e) => { setFromPeriod(e.target.value); setReport(null); }} disabled={busy !== ""}>
              {periods.map((row) => <option key={row.period} value={row.period}>{monthLabel(row.period)} — {STATUS_UI[row.status].label}</option>)}
            </select>
          </label>
          <button type="button" className="secondary-button" disabled={busy !== "" || !fromPeriod} onClick={() => void run("PREVIEW")}>
            <span className="material-symbols-outlined text-lg">preview</span>
            {busy === "preview" ? "Đang tính thử..." : "Chạy thử"}
          </button>
          {canApply && (
            <button type="button" className="primary-button" disabled={busy !== "" || !previewMatches || blocked} onClick={() => setConfirming(true)} title={previewMatches ? "" : "Bấm Chạy thử trước để xem chênh lệch"}>
              <span className="material-symbols-outlined text-lg">bolt</span>
              Ghi giá vốn
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {periods.map((row) => (
          <span key={row.period} className={`text-[11px] font-bold border rounded-full px-2.5 py-1 ${STATUS_UI[row.status].tone}`} title={row.computedAt ? `Lần tính gần nhất ${new Date(row.computedAt).toLocaleString("vi-VN")} · ${row.computedBy || ""}` : "Chưa tính lần nào"}>
            {monthLabel(row.period)}: {STATUS_UI[row.status].label}
            {row.status === "OK" && row.computedAt ? ` ${new Date(row.computedAt).toLocaleDateString("vi-VN")}` : ""}
          </span>
        ))}
        {busy === "status" && <span className="text-xs text-slate-400">Đang kiểm tra trạng thái...</span>}
      </div>
      {pending.length > 0 && busy !== "status" && (
        <p className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-3 py-2">
          {pending[0].status === "NEVER" ? "Chưa tính giá vốn tháng" : "Có phiếu kho thay đổi sau lần tính giá"} từ {monthLabel(pending[0].period)} — giá vốn các tháng {pending.map((row) => monthLabel(row.period)).join(", ")} đang là giá tạm tính. Chạy thử rồi Ghi giá vốn để chốt.
        </p>
      )}
      {error && <p className="text-xs bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2">{error}</p>}
      {notice && <p className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2">{notice}</p>}

      {report && (
        <div className="space-y-3">
          {report.locked && <p className="text-xs bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2">{report.locked}</p>}
          {settled.length > 0 && (
            <p className="text-xs bg-rose-50 border border-rose-200 text-rose-800 rounded-lg px-3 py-2">
              Phiếu điều chuyển liên nhà hàng đổi trị giá nhưng công nợ nội bộ đã gạch nợ: {settled.map((row) => `${row.code} (${row.settledDebt})`).join(", ")}. Hoàn tác phiếu thu/chi gạch nợ trước rồi tính lại.
            </p>
          )}
          <p className="text-xs text-slate-600">
            {monthLabel(report.fromPeriod)} → {monthLabel(report.toPeriod)}: <b>{report.changedLines.toLocaleString("vi-VN")}</b> dòng phiếu kho đổi giá
            {report.changedTransfers.length > 0 ? <> · <b>{report.changedTransfers.length}</b> phiếu điều chuyển liên nhà hàng ghi lại công nợ nội bộ</> : null}
            {report.zeroLines.map((row) => <Fragment key={row.period}> · Dòng xuất 0 đ {monthLabel(row.period)}: {row.before} → <b>{row.after}</b></Fragment>)}
          </p>
          <div className="border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-xs min-w-[760px]">
              <thead className="bg-slate-50 text-slate-600 font-bold">
                <tr>
                  <th className="px-3 py-2 text-left">Tháng</th>
                  <th className="px-3 py-2 text-left">Nhà hàng</th>
                  <th className="px-3 py-2 text-left">Hạng mục</th>
                  <th className="px-3 py-2 text-right">Giá vốn hiện tại</th>
                  <th className="px-3 py-2 text-right">Sau tính lại</th>
                  <th className="px-3 py-2 text-right">Chênh lệch</th>
                  <th className="px-3 py-2 text-right">Do dòng 0 đ nay có giá</th>
                </tr>
              </thead>
              <tbody>
                {grouped.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Không có phiếu xuất tính giá vốn trong khoảng này.</td></tr>}
                {grouped.map(([period, rows]) => {
                  const total = rows.reduce((sum, row) => ({ before: sum.before + row.before, after: sum.after + row.after, fromZero: sum.fromZero + row.fromZero }), { before: 0, after: 0, fromZero: 0 });
                  return (
                    <Fragment key={period}>
                      {rows.map((row) => (
                        <tr key={`${row.period}-${row.branchCode}-${row.label}`} className="border-t border-slate-100">
                          <td className="px-3 py-1.5">{monthLabel(row.period)}</td>
                          <td className="px-3 py-1.5">{row.branchCode}</td>
                          <td className="px-3 py-1.5">{row.label}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{money(row.before)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{money(row.after)}</td>
                          <td className={`px-3 py-1.5 text-right tabular-nums font-bold ${row.after - row.before > 0.5 ? "text-rose-700" : row.after - row.before < -0.5 ? "text-emerald-700" : "text-slate-500"}`}>{signed(row.after - row.before)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{signed(row.fromZero)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-slate-200 bg-blue-50/60 font-bold">
                        <td className="px-3 py-1.5">{monthLabel(period)}</td>
                        <td className="px-3 py-1.5" colSpan={2}>Tổng cộng</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(total.before)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{money(total.after)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{signed(total.after - total.before)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{signed(total.fromZero)}</td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {report.unpriced.length > 0 && (
            <div className="text-xs">
              <button type="button" className="font-bold text-amber-800 hover:underline" onClick={() => setShowUnpriced((value) => !value)}>
                {showUnpriced ? "▾" : "▸"} {report.unpriced.length} mã × kho đã xuất nhưng chưa có giá nào (xuất 0 đ)
              </button>
              {showUnpriced && (
                <div className="mt-2 border border-slate-200 rounded-lg overflow-auto max-h-80">
                  <table className="w-full min-w-[720px]">
                    <thead className="bg-slate-50 text-slate-600 font-bold sticky top-0">
                      <tr><th className="px-3 py-2 text-left">Mã</th><th className="px-3 py-2 text-left">Tên</th><th className="px-3 py-2 text-left">Kho</th><th className="px-3 py-2 text-left">Tháng</th><th className="px-3 py-2 text-right">SL đã xuất</th><th className="px-3 py-2 text-left">Cần làm</th></tr>
                    </thead>
                    <tbody>
                      {report.unpriced.map((row) => (
                        <tr key={`${row.itemCode}-${row.warehouseCode}`} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 font-bold">{row.itemCode}</td>
                          <td className="px-3 py-1.5">{row.itemName}</td>
                          <td className="px-3 py-1.5">{row.warehouseCode}</td>
                          <td className="px-3 py-1.5">{row.periods.map(monthLabel).join(", ")}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{qty(row.outQty)} {row.unit}</td>
                          <td className="px-3 py-1.5 text-slate-500">{["SEMI_FINISHED", "FINISHED"].includes(row.itemType) ? "Kiểm tra định lượng (nguyên liệu chưa có giá)" : "Khai tồn đầu kỳ hoặc nhập phiếu mua có giá"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {confirming && report && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md shadow-xl">
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">Ghi giá vốn {monthLabel(report.fromPeriod)} → {monthLabel(report.toPeriod)}?</h3>
            </div>
            <div className="p-5 space-y-2 text-sm text-slate-600">
              <p>Hệ thống ghi lại đơn giá <b>{report.changedLines.toLocaleString("vi-VN")}</b> dòng phiếu kho theo giá bình quân cả tháng, cập nhật công nợ nội bộ điều chuyển, giá bình quân tồn hiện tại và ghi sổ lại giá vốn P&amp;L các tháng này.</p>
              <p className="text-xs text-slate-500">Bổ sung / sửa phiếu sau đó thì bấm tính lại; kỳ đã khoá sổ không tính lại được.</p>
            </div>
            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button type="button" className="secondary-button" onClick={() => setConfirming(false)} disabled={busy === "apply"}>Huỷ</button>
              <button type="button" className="primary-button" onClick={() => void run("APPLY")} disabled={busy === "apply"}>
                {busy === "apply" ? "Đang ghi giá vốn..." : "Ghi giá vốn"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
