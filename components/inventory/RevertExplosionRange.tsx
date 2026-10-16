"use client";

import { useState } from "react";

type Run = { runCode: string; documents: number; revenueRows: number; from: string | null; to: string | null; createdAt: string | null; createdBy: string | null; outsideRange: boolean };
type RevertResult = { reverted: string[]; remaining: number; stoppedAt: { runCode: string; error: string } | null; cogsRepost?: unknown };

const day = (v: string | null) => (v ? new Date(v).toLocaleDateString("vi-VN") : "—");

/**
 * Hoàn tác rã BOM theo khoảng ngày (khách 16/10/2026: import doanh thu sai đã rã, muốn huỷ để đẩy lại
 * doanh thu). Nút nằm cạnh "Rã nguyên liệu & sinh phiếu", dùng chung cửa hàng + từ/đến ngày bán của form rã
 * (khách: "user chọn theo khoảng thời gian họ xử lý"). Bấm → xem các lần rã liên quan → xác nhận hoàn tác tất
 * cả (từ lần mới nhất về lần cũ). Sau đó rollback/xoá ngày ở Import doanh thu rồi đẩy lại file đúng.
 */
export default function RevertExplosionRange({ branchCode, dateFrom, dateTo, headers, onDone }: {
  branchCode: string;
  dateFrom: string;
  dateTo: string;
  headers: () => Record<string, string>;
  onDone: (message: string) => void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  // Đổi cửa hàng / khoảng ngày ở form Rã nguyên liệu thì danh sách cũ không còn đúng.
  const [shownFor, setShownFor] = useState("");
  const key = `${branchCode}|${dateFrom}|${dateTo}`;
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
    if (payload) { setRuns(payload.runs); setShownFor(key); }
  };

  const revert = async () => {
    if (!runs?.length || shownFor !== key) return;
    if (!window.confirm(`Hoàn tác ${runs.length} lần rã (${runs.map((r) => r.runCode).join(", ")})? Kho được trả lại, doanh thu của các lần rã này quay về "chờ rã".`)) return;
    const result = await post(true) as RevertResult | null;
    if (!result) return;
    setRuns(null);
    setShownFor("");
    const head = result.reverted.length ? `Đã hoàn tác ${result.reverted.length} lần rã: ${result.reverted.join(", ")}.` : "Chưa hoàn tác lần rã nào.";
    onDone(result.stoppedAt
      ? `${head} Dừng ở ${result.stoppedAt.runCode}: ${result.stoppedAt.error} (còn ${result.remaining} lần rã chưa hoàn tác).`
      : `${head} Giờ vào Import → Doanh thu để rollback / xoá ngày rồi đẩy lại file đúng.`);
  };

  const list = shownFor === key ? runs : null;
  return (
    <>
      <button type="button" className="secondary-button !text-rose-700" disabled={busy || !branchCode || branchCode === "ALL"} onClick={() => void preview()}
        title="Hoàn tác các lần rã có doanh thu / phiếu trong cửa hàng và khoảng ngày bán đã chọn ở trên (dùng khi import doanh thu sai đã rã)">
        <span className="material-symbols-outlined text-lg">undo</span>
        {busy && !list ? "Đang tìm lần rã..." : "Hoàn tác rã trong khoảng ngày"}
      </button>
      {(error || list) && (
        <div className="basis-full rounded-xl border border-rose-200 bg-rose-50/40 p-4 space-y-2">
          {error && <p className="text-sm text-rose-700 whitespace-pre-line">{error}</p>}
          {list && (list.length === 0 ? (
            <p className="text-sm text-slate-600">Không có lần rã nào của cửa hàng này trong khoảng {day(dateFrom)} – {day(dateTo)}.</p>
          ) : (<>
            <p className="text-sm font-semibold text-slate-800">{list.length} lần rã trong khoảng {day(dateFrom)} – {day(dateTo)} — hoàn tác thì kho được trả lại, doanh thu về &quot;chờ rã&quot;; sau đó vào Import → Doanh thu rollback / xoá ngày rồi đẩy lại file đúng.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm bg-white rounded-lg">
                <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 px-2">Mã lần rã</th><th className="py-1 px-2">Doanh thu từ – đến</th><th className="py-1 px-2 text-right">Dòng DT</th><th className="py-1 px-2 text-right">Phiếu kho</th><th className="py-1 px-2">Người rã · lúc</th></tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.runCode} className="border-t border-slate-100">
                      <td className="py-1.5 px-2 font-bold">{r.runCode}</td>
                      <td className="py-1.5 px-2">{day(r.from)} – {day(r.to)}{r.outsideRange && <span className="ml-1 status bg-amber-50 text-amber-700">vượt khoảng ngày chọn</span>}</td>
                      <td className="py-1.5 px-2 text-right">{r.revenueRows}</td>
                      <td className="py-1.5 px-2 text-right">{r.documents}</td>
                      <td className="py-1.5 px-2 text-xs text-slate-500">{r.createdBy || "—"} · {r.createdAt ? new Date(r.createdAt).toLocaleString("vi-VN") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.some((r) => r.outsideRange) && <p className="text-xs text-amber-700">Lần rã có ngày ngoài khoảng chọn sẽ được hoàn tác cả lần — các ngày đó cũng phải rã lại.</p>}
            <div className="flex gap-2">
              <button type="button" className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50" disabled={busy} onClick={() => void revert()}>{busy ? "Đang hoàn tác..." : `Hoàn tác ${list.length} lần rã`}</button>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { setRuns(null); setShownFor(""); }}>Đóng</button>
            </div>
          </>))}
        </div>
      )}
    </>
  );
}
