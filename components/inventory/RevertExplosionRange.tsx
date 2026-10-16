"use client";

import { useState } from "react";

type Run = { runCode: string; documents: number; revenueRows: number; from: string | null; to: string | null; createdAt: string | null; createdBy: string | null; outsideRange: boolean };
type RevertResult = { reverted: string[]; remaining: number; stoppedAt: { runCode: string; error: string } | null; cogsRepost?: unknown };

const day = (v: string | null) => (v ? new Date(v).toLocaleDateString("vi-VN") : "—");
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Hoàn tác rã BOM theo khoảng ngày (khách 16/10/2026: import doanh thu sai đã rã, muốn huỷ để đẩy lại
 * doanh thu). Chọn cửa hàng + khoảng ngày → xem các lần rã liên quan → xác nhận hoàn tác tất cả (từ lần mới
 * nhất về lần cũ). Sau đó rollback/xoá ngày ở Import doanh thu rồi đẩy lại file đúng.
 */
export default function RevertExplosionRange({ stores, defaultBranch, headers, onDone }: {
  stores: { code: string; label: string }[];
  defaultBranch: string;
  headers: () => Record<string, string>;
  onDone: (message: string) => void;
}) {
  const [branchCode, setBranchCode] = useState(defaultBranch && defaultBranch !== "ALL" ? defaultBranch : stores[0]?.code || "");
  const [dateFrom, setDateFrom] = useState(today());
  const [dateTo, setDateTo] = useState(today());
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const post = async (confirm: boolean) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({ action: "REVERT_EXPLOSION_RANGE", branchCode, dateFrom, dateTo, confirm }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setError(payload.error || `Máy chủ phản hồi lỗi ${response.status}`); return null; }
      return payload;
    } catch {
      setError("Mất kết nối tới máy chủ (hoàn tác nhiều lần rã có thể mất vài phút). Tải lại trang để kiểm tra.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    const payload = await post(false) as { runs: Run[] } | null;
    if (payload) setRuns(payload.runs);
  };

  const revert = async () => {
    if (!runs?.length) return;
    if (!window.confirm(`Hoàn tác ${runs.length} lần rã (${runs.map((r) => r.runCode).join(", ")})? Kho được trả lại, doanh thu của các lần rã này quay về "chờ rã".`)) return;
    const result = await post(true) as RevertResult | null;
    if (!result) return;
    setRuns(null);
    const head = result.reverted.length ? `Đã hoàn tác ${result.reverted.length} lần rã: ${result.reverted.join(", ")}.` : "Chưa hoàn tác lần rã nào.";
    onDone(result.stoppedAt
      ? `${head} Dừng ở ${result.stoppedAt.runCode}: ${result.stoppedAt.error} (còn ${result.remaining} lần rã chưa hoàn tác).`
      : `${head} Giờ vào Import → Doanh thu để rollback / xoá ngày rồi đẩy lại file đúng.`);
  };

  return (
    <section className="table-panel shadow-sm p-5 space-y-3">
      <div>
        <h3 className="font-bold text-slate-900">Hoàn tác rã BOM theo khoảng ngày</h3>
        <p className="text-xs text-slate-500">Dùng khi doanh thu import sai đã rã: hoàn tác các lần rã trong khoảng ngày → vào Import doanh thu rollback / xoá ngày → đẩy lại file đúng → rã lại.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-slate-600">Cửa hàng
          <select className="control mt-1 block" value={branchCode} onChange={(e) => { setBranchCode(e.target.value); setRuns(null); }}>
            {stores.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">Từ ngày
          <input type="date" className="control mt-1 block" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setRuns(null); }} />
        </label>
        <label className="text-xs font-semibold text-slate-600">Đến ngày
          <input type="date" className="control mt-1 block" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setRuns(null); }} />
        </label>
        <button type="button" className="secondary-button" disabled={busy || !branchCode} onClick={() => void preview()}>{busy && !runs ? "Đang tìm..." : "Xem các lần rã"}</button>
      </div>
      {error && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 whitespace-pre-line">{error}</p>}
      {runs && (runs.length === 0 ? (
        <p className="text-sm text-slate-500">Không có lần rã nào trong khoảng ngày này.</p>
      ) : (
        <div className="space-y-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3">Mã lần rã</th><th className="py-1 pr-3">Doanh thu từ – đến</th><th className="py-1 pr-3 text-right">Dòng DT</th><th className="py-1 pr-3 text-right">Phiếu kho</th><th className="py-1 pr-3">Người rã · lúc</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runCode} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3 font-bold">{r.runCode}</td>
                    <td className="py-1.5 pr-3">{day(r.from)} – {day(r.to)}{r.outsideRange && <span className="ml-1 status bg-amber-50 text-amber-700">vượt khoảng ngày chọn</span>}</td>
                    <td className="py-1.5 pr-3 text-right">{r.revenueRows}</td>
                    <td className="py-1.5 pr-3 text-right">{r.documents}</td>
                    <td className="py-1.5 pr-3 text-xs text-slate-500">{r.createdBy || "—"} · {r.createdAt ? new Date(r.createdAt).toLocaleString("vi-VN") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.some((r) => r.outsideRange) && <p className="text-xs text-amber-700">Lần rã có ngày ngoài khoảng chọn sẽ được hoàn tác cả lần — các ngày đó cũng phải rã lại.</p>}
          <button type="button" className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50" disabled={busy} onClick={() => void revert()}>{busy ? "Đang hoàn tác..." : `Hoàn tác ${runs.length} lần rã`}</button>
        </div>
      ))}
    </section>
  );
}
