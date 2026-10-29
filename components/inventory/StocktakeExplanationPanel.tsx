"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateRangeFilter } from "@/components/DateRangeFilter";
import { FilterApplyButton } from "@/components/FilterApplyButton";
import { useFilterDraft } from "@/lib/use-applied-filters";
import type { StocktakeFilter } from "@/components/inventory/stocktake-filter";
import CopyableText from "@/components/CopyableText";
import { money, quantity as qty } from "@/lib/format-number";
import { goodsGroupKey } from "@/lib/goods-group";

/**
 * Tab "Giải trình kiểm kê" (khách yêu cầu 03/10/2026) — xem lib/stocktake-explanation.ts.
 *
 * Mỗi đợt kiểm kê đã duyệt của một kho có một bản giải trình theo form của khách. Số liệu được
 * CHỤP lúc lập, không tự đổi theo dữ liệu mới để phần giải trình luôn khớp số lúc ghi. Nhà hàng /
 * kế toán gõ giải trình từng dòng rồi Lưu; kế toán bấm "Chốt số liệu giải trình" thì khoá hẳn.
 * Đợt bị mở lại để sửa số đếm: duyệt lại xong kế toán bấm "Cập nhật số liệu" (hoặc gắn sang đợt
 * duyệt lại) — phần giải trình đã gõ giữ theo mã hàng.
 */
type Source = {
  sourceType: "BATCH" | "SESSION";
  sourceId: string;
  code: string;
  branchCode: string;
  warehouseCode: string;
  cutoffAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  lineCount: number;
  varianceRows: number;
  explanation: { id: string; status: string; needsRefresh: boolean } | null;
};
type Orphan = { id: string; sourceCode: string; warehouseCode: string; status: string; periodTo: string };
type Line = {
  itemId: string; itemCode: string; itemName: string; goodsGroup: string | null; unit: string;
  opening: number; inPurchase: number; inTransfer: number; inOther: number; inProduction: number; inTotal: number;
  outSale: number; outTransfer: number; outWaste: number; outOther: number; outProduction: number; outTotal: number;
  closing: number; counted: number; variance: number; unitCost: number; varianceValue: number; explanation: string;
  /** Mã kho có mà phiếu không đếm — lên để tổng khớp tồn cả kho. Phiếu kiểm cả kho: tính kiểm 0
   * (countAsZero, có chênh lệch, Chốt ghi luôn); đợt theo vị trí: chỉ liệt kê. */
  notCounted?: boolean;
  countAsZero?: boolean;
};
type Explanation = {
  id: string; sourceType: string; sourceId: string; sourceCode: string; branchCode: string; warehouseCode: string;
  periodFrom: string | null; periodTo: string; status: string; lines: Line[];
  snapshotBy: string | null; snapshotAt: string | null; lockedBy: string | null; lockedAt: string | null;
};
type Detail = {
  explanation: Explanation;
  source: { status: string; code: string; cutoffAt: string; approvedAt: string | null } | null;
  needsRefresh: boolean;
  relinkCandidates: Source[];
  /** Đơn giá tạm tính theo mặt hàng (dòng có chênh lệch) — cột Trị giá chênh lệch. */
  unitCosts?: Record<string, number>;
};

type Props = {
  sessionKey: string;
  branchOptions: Array<{ code: string; label: string }>;
  warehouses: Array<{ code: string; name: string; branch: string | null }>;
  storeLabel: (code: string) => string;
  /** Bộ lọc dùng chung giữa các tab kiểm kê (giữ ở trang Kho). */
  filters: StocktakeFilter;
  setFilters: (filters: StocktakeFilter) => void;
  canCreate: boolean;
  canApprove: boolean;
};

function sessionHeaders(sessionKey: string): Record<string, string> {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(sessionKey);
  return raw ? { "x-demo-session": encodeURIComponent(raw) } : {};
}

const dateTime = (value: string | null | undefined) =>
  (value ? new Date(value).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** Cột số theo đúng form khách: [khoá, nhãn, nhóm tiêu đề]. */
const NUMBER_COLUMNS: Array<[keyof Line, string, "" | "in" | "out"]> = [
  ["opening", "SL đầu kỳ", ""],
  ["inPurchase", "SL nhập mua", "in"],
  ["inTransfer", "SL nhập điều chuyển", "in"],
  ["inOther", "SL nhập khác", "in"],
  ["inProduction", "SL nhập chế biến", "in"],
  ["inTotal", "Cộng SL nhập", "in"],
  ["outSale", "SL xuất bán", "out"],
  ["outTransfer", "SL xuất điều chuyển", "out"],
  ["outWaste", "SL xuất hủy", "out"],
  ["outOther", "SL xuất khác", "out"],
  ["outProduction", "SL xuất chế biến", "out"],
  ["outTotal", "Cộng SL xuất", "out"],
  ["closing", "SL cuối kỳ", ""],
  ["counted", "SL kiểm kê", ""],
  ["variance", "Chênh lệch (kiểm kê − cuối kỳ)", ""],
];

/** Cột cố định bên trái bảng giải trình (STT → ĐVT): độ rộng cố định để tính vị trí dính. */
const FROZEN_WIDTHS = [52, 96, 110, 130, 220, 84];
const frozenStyle = (index: number) => {
  const width = FROZEN_WIDTHS[index];
  return { left: FROZEN_WIDTHS.slice(0, index).reduce((sum, value) => sum + value, 0), width, minWidth: width, maxWidth: width };
};
const frozenEdge = (index: number) => (index === FROZEN_WIDTHS.length - 1 ? "shadow-[2px_0_0_0_rgb(226_232_240)]" : "");

function statusBadge(source: Source) {
  if (!source.explanation) return <span className="status bg-slate-100 text-slate-600">Chưa lập</span>;
  if (source.explanation.status === "LOCKED") return <span className="status bg-emerald-100 text-emerald-800">Đã chốt</span>;
  if (source.explanation.needsRefresh) return <span className="status bg-amber-100 text-amber-800">Đợt đã duyệt lại — cần cập nhật số</span>;
  return <span className="status bg-blue-50 text-blue-700">Đang giải trình</span>;
}

export default function StocktakeExplanationPanel({ sessionKey, branchOptions, warehouses, storeLabel, filters, setFilters, canCreate, canApprove }: Props) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [lineFilter, setLineFilter] = useState({ group: "ALL", onlyVariance: false, onlyCounted: false, search: "" });
  const [relinkTarget, setRelinkTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const headers = useCallback(() => sessionHeaders(sessionKey), [sessionKey]);

  const loadSources = useCallback(async () => {
    const query = new URLSearchParams({ view: "stocktake-sources", branchCode: filters.branchCode });
    if (filters.warehouseCode) query.set("warehouseCode", filters.warehouseCode);
    if (filters.from) query.set("from", filters.from);
    if (filters.to) query.set("to", filters.to);
    try {
      const response = await fetch(`/api/inventory?${query.toString()}`, { headers: headers() });
      const payload = await response.json() as { sources?: Source[]; orphans?: Orphan[]; error?: string };
      if (!response.ok) setMessage({ tone: "error", text: payload.error || "Không tải được danh sách đợt kiểm kê" });
      setSources(payload.sources || []);
      setOrphans(payload.orphans || []);
    } catch {
      setMessage({ tone: "error", text: "Mất kết nối tới máy chủ." });
      setSources([]);
    }
  }, [filters, headers]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSources(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSources]);

  const openExplanation = async (id: string) => {
    setMessage(null);
    const response = await fetch(`/api/inventory?view=stocktake-explanation&id=${encodeURIComponent(id)}`, { headers: headers() });
    const payload = await response.json() as Detail & { error?: string };
    if (!response.ok) {
      setMessage({ tone: "error", text: payload.error || "Không mở được bản giải trình" });
      return;
    }
    setDetail(payload);
    setNotes(Object.fromEntries(payload.explanation.lines.map((line) => [line.itemId, line.explanation || ""])));
    setRelinkTarget(payload.relinkCandidates[0] ? `${payload.relinkCandidates[0].sourceType}|${payload.relinkCandidates[0].sourceId}` : "");
    setLineFilter({ group: "ALL", onlyVariance: false, onlyCounted: false, search: "" });
  };

  const post = async (body: object, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/inventory", { method: "POST", headers: { "Content-Type": "application/json", ...headers() }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({})) as { explanation?: Explanation; error?: string };
      if (!response.ok) {
        setMessage({ tone: "error", text: payload.error || "Không thực hiện được thao tác" });
        return null;
      }
      setMessage({ tone: "ok", text: success });
      return payload;
    } catch {
      setMessage({ tone: "error", text: "Mất kết nối tới máy chủ. Vui lòng thử lại." });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createFor = async (source: Source) => {
    const payload = await post({ action: "CREATE_STOCKTAKE_EXPLANATION", sourceType: source.sourceType, sourceId: source.sourceId }, `Đã lập giải trình cho đợt ${source.code} — số liệu đã chụp tại thời điểm này.`);
    if (payload?.explanation) {
      await loadSources();
      await openExplanation(payload.explanation.id);
    }
  };

  const explanation = detail?.explanation || null;
  const locked = explanation?.status === "LOCKED";
  const editable = Boolean(explanation) && !locked && canCreate;
  const dirtyIds = explanation ? explanation.lines.filter((line) => (notes[line.itemId] || "") !== (line.explanation || "")).map((line) => line.itemId) : [];

  const saveNotes = async () => {
    if (!explanation || dirtyIds.length === 0) return true;
    const payload = await post({ action: "SAVE_STOCKTAKE_EXPLANATION", id: explanation.id, notes: Object.fromEntries(dirtyIds.map((id) => [id, notes[id] || ""])) }, `Đã lưu giải trình ${dirtyIds.length} dòng.`);
    if (payload?.explanation && detail) setDetail({ ...detail, explanation: payload.explanation as Explanation });
    return Boolean(payload);
  };

  const runAction = async (action: string, success: string, extra: object = {}) => {
    if (!explanation) return;
    setRunning(action);
    try {
      if (dirtyIds.length > 0 && action !== "UNLOCK_STOCKTAKE_EXPLANATION" && !(await saveNotes())) return;
      const payload = await post({ action, id: explanation.id, ...extra }, success);
      if (payload) {
        await openExplanation(explanation.id);
        await loadSources();
      }
    } finally {
      setRunning(null);
    }
  };
  const spinIcon = (action: string, icon: string) => (
    <span className={`material-symbols-outlined text-lg ${running === action ? "animate-spin" : ""}`}>{running === action ? "progress_activity" : icon}</span>
  );

  const groupOptions = useMemo(() => {
    const groups = new Map<string, string>();
    for (const line of explanation?.lines || []) if (line.goodsGroup) groups.set(goodsGroupKey(line.goodsGroup), line.goodsGroup);
    return [...groups.entries()].sort((a, b) => a[1].localeCompare(b[1], "vi"));
  }, [explanation]);
  const keyword = lineFilter.search.trim().toLowerCase();
  const visibleLines = (explanation?.lines || []).filter((line) => {
    if (lineFilter.onlyVariance && Math.abs(line.variance) <= 1e-6) return false;
    if (lineFilter.onlyCounted && line.notCounted) return false;
    if (lineFilter.group === "MISSING" && line.goodsGroup) return false;
    if (!["ALL", "MISSING"].includes(lineFilter.group) && goodsGroupKey(line.goodsGroup) !== lineFilter.group) return false;
    return !keyword || line.itemCode.toLowerCase().includes(keyword) || line.itemName.toLowerCase().includes(keyword);
  });

  const unitCostOf = (line: Line) => detail?.unitCosts?.[line.itemId] ?? line.unitCost ?? 0;
  const varianceValueOf = (line: Line) => Math.round(line.variance * unitCostOf(line));
  const visibleVarianceValue = visibleLines.reduce((sum, line) => sum + varianceValueOf(line), 0);
  const visibleTotals = Object.fromEntries(NUMBER_COLUMNS.map(([key]) => [key, visibleLines.reduce((sum, line) => sum + Number(line[key] || 0), 0)])) as Record<string, number>;

  /** Xuất Excel đúng form khách: 2 hàng tiêu đề, nhóm "SL nhập / xuất trong kỳ" gộp ô. */
  const exportExcel = async () => {
    if (!explanation) return;
    const XLSX = await import("xlsx");
    const top = ["STT", "Kho", "Nhóm", "Mã hàng", "Tên hàng", "ĐVT tồn kho", "SL đầu kỳ", "SL nhập trong kỳ", "", "", "", "", "SL xuất trong kỳ", "", "", "", "", "", "SL cuối kỳ", "SL kiểm kê", "Chênh lệch kiểm kê (SL kiểm kê − SL cuối kỳ)", "Đơn giá tạm tính", "Trị giá chênh lệch (tạm tính)", "Giải trình"];
    const second = ["", "", "", "", "", "", "", "SL nhập mua", "SL nhập điều chuyển", "SL nhập khác", "SL nhập chế biến", "Cộng SL nhập", "SL xuất bán", "SL xuất điều chuyển", "SL xuất hủy", "SL xuất khác", "SL xuất chế biến", "Cộng SL xuất", "", "", "", "", "", ""];
    const rows: Array<Array<string | number>> = [
      [`GIẢI TRÌNH KIỂM KÊ — kho ${explanation.warehouseCode} — đợt ${explanation.sourceCode} — kỳ ${explanation.periodFrom ? dateTime(explanation.periodFrom) : "từ đầu"} → ${dateTime(explanation.periodTo)}${locked ? " — ĐÃ CHỐT" : ""}`],
      top,
      second,
      ...visibleLines.map((line, index) => [
        index + 1, explanation.warehouseCode, line.goodsGroup || "", line.itemCode, line.itemName, line.unit,
        ...NUMBER_COLUMNS.map(([key]) => (line.notCounted && !line.countAsZero && (key === "counted" || key === "variance") ? (key === "counted" ? "Không kiểm" : "") : line[key] as number)),
        Math.abs(line.variance) > 1e-6 ? Math.round(unitCostOf(line)) : "",
        Math.abs(line.variance) > 1e-6 ? varianceValueOf(line) : "",
        notes[line.itemId] ?? line.explanation ?? "",
      ]),
    ];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const merge = (r1: number, c1: number, r2: number, c2: number) => ({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });
    sheet["!merges"] = [
      merge(0, 0, 0, 23),
      ...[0, 1, 2, 3, 4, 5, 6, 18, 19, 20, 21, 22, 23].map((col) => merge(1, col, 2, col)),
      merge(1, 7, 1, 11),
      merge(1, 12, 1, 17),
    ];
    sheet["!cols"] = [{ wch: 5 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 32 }, { wch: 8 }, ...Array.from({ length: 17 }, () => ({ wch: 12 })), { wch: 40 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Giai trinh kiem ke");
    XLSX.writeFile(workbook, `giai_trinh_kiem_ke_${explanation.warehouseCode}_${explanation.sourceCode}.xlsx`);
  };

  // Bộ lọc chỉ chạy khi bấm Lọc (khách 28/10/2026).
  const bar = useFilterDraft(filters, setFilters);
  const warehouseOptions = warehouses.filter((warehouse) => bar.draft.branchCode === "ALL" || warehouse.branch === bar.draft.branchCode || !warehouse.branch);
  const sourceReopened = Boolean(detail) && detail?.source?.status !== "APPROVED";

  return (
    <div className="space-y-5">
      <section className="table-panel shadow-sm">
        <div className="p-5 pb-3">
          <h2 className="font-bold text-slate-800">Giải trình kiểm kê</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-4xl leading-relaxed">
            Mỗi đợt kiểm kê đã duyệt của một kho có một bản giải trình. Kỳ tính <b>từ giờ chốt lần kiểm kê trước của cùng kho tới giờ chốt đợt này</b>.
            Chưa chốt thì số liệu <b>tự cập nhật</b> theo tồn hệ thống mới nhất tại giờ chốt (bổ sung phiếu, rã lại… — hoặc bấm <b>Cập nhật tồn hệ thống</b>);
            chênh lệch kiểm kê <b>chỉ ghi nhận vào tồn kho &amp; giá vốn khi bấm Chốt</b>. Mở chốt thì gỡ ra (giải trình đã gõ giữ theo mã hàng).
          </p>
        </div>
        <div className="px-5 pb-4 grid grid-cols-2 lg:grid-cols-5 gap-3">
          <label className="text-xs font-bold text-slate-500">Nhà hàng
            <select className="control mt-1" value={bar.draft.branchCode} onChange={(e) => bar.update({ branchCode: e.target.value, warehouseCode: "" })}>
              {branchOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Kho
            <select className="control mt-1" value={bar.draft.warehouseCode} onChange={(e) => bar.update({ warehouseCode: e.target.value })}>
              <option value="">Tất cả kho</option>
              {warehouseOptions.map((warehouse) => <option key={warehouse.code} value={warehouse.code}>{warehouse.name || warehouse.code}</option>)}
            </select>
          </label>
          <DateRangeFilter label="Ngày chốt" value={{ from: bar.draft.from, to: bar.draft.to }} onChange={(range) => bar.update(range)} className="col-span-2 !text-xs !text-slate-500" />
            <FilterApplyButton dirty={bar.dirty} onApply={bar.apply} />
        </div>
        {message && !detail && (
          <p className={`mx-5 mb-3 rounded-lg border px-3 py-2 text-sm ${message.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{message.text}</p>
        )}
        <div className="overflow-x-auto max-h-[360px] overflow-y-auto custom-scrollbar">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase border-b border-slate-200 sticky top-0 z-10">
              <tr>
                {["Đợt kiểm kê", "Nhà hàng", "Kho", "Giờ chốt", "Số mã", "Mã lệch", "Giải trình", ""].map((label, index) => (
                  <th key={index} className={`px-4 py-3 font-bold whitespace-nowrap ${index === 4 || index === 5 ? "text-right" : "text-left"}`}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources === null && <tr><td colSpan={8} className="cell text-center text-slate-400">Đang tải...</td></tr>}
              {sources !== null && sources.length === 0 && <tr><td colSpan={8} className="cell text-center text-slate-400">Chưa có đợt kiểm kê nào đã duyệt khớp bộ lọc.</td></tr>}
              {(sources || []).map((source) => (
                <tr key={`${source.sourceType}|${source.sourceId}`} className={`border-t border-slate-100 ${detail?.explanation.sourceId === source.sourceId ? "bg-blue-50/60" : ""}`}>
                  <td className="cell whitespace-nowrap">
                    <CopyableText value={source.code}><b>{source.code}</b></CopyableText>
                    <small className="block text-slate-500">{source.sourceType === "BATCH" ? "Duyệt gộp theo vị trí" : "Kiểm cả kho"} · duyệt {source.approvedBy || ""}</small>
                  </td>
                  <td className="cell whitespace-nowrap">{storeLabel(source.branchCode)}</td>
                  <td className="cell whitespace-nowrap">{source.warehouseCode}</td>
                  <td className="cell whitespace-nowrap">{dateTime(source.cutoffAt)}</td>
                  <td className="cell text-right tabular-nums">{source.lineCount}</td>
                  <td className="cell text-right tabular-nums">{source.varianceRows}</td>
                  <td className="cell">{statusBadge(source)}</td>
                  <td className="cell text-right whitespace-nowrap">
                    {source.explanation ? (
                      <button type="button" className="secondary-button !min-h-8 !py-1" onClick={() => void openExplanation(source.explanation!.id)}>Mở</button>
                    ) : canCreate ? (
                      <button type="button" className="primary-button !min-h-8 !py-1" disabled={busy} onClick={() => void createFor(source)}>Lập giải trình</button>
                    ) : <span className="text-xs text-slate-400">Chưa lập</span>}
                  </td>
                </tr>
              ))}
              {orphans.map((orphan) => (
                <tr key={orphan.id} className="border-t border-slate-100 bg-amber-50/50">
                  <td className="cell whitespace-nowrap"><b>{orphan.sourceCode}</b><small className="block text-amber-700">Đợt đã mở lại — chờ gắn sang đợt duyệt lại</small></td>
                  <td className="cell" />
                  <td className="cell whitespace-nowrap">{orphan.warehouseCode}</td>
                  <td className="cell whitespace-nowrap">{dateTime(orphan.periodTo)}</td>
                  <td className="cell" /><td className="cell" />
                  <td className="cell">{orphan.status === "LOCKED" ? <span className="status bg-emerald-100 text-emerald-800">Đã chốt</span> : <span className="status bg-amber-100 text-amber-800">Chờ gắn đợt mới</span>}</td>
                  <td className="cell text-right"><button type="button" className="secondary-button !min-h-8 !py-1" onClick={() => void openExplanation(orphan.id)}>Mở</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail && explanation && (
        <section className="table-panel shadow-sm">
          <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-bold text-slate-800">
                Giải trình kiểm kê — kho {explanation.warehouseCode} · đợt {explanation.sourceCode}
                {locked ? <span className="ml-2 status bg-emerald-100 text-emerald-800">Đã chốt</span> : <span className="ml-2 status bg-blue-50 text-blue-700">Đang giải trình</span>}
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                {storeLabel(explanation.branchCode)} · Kỳ: <b>{explanation.periodFrom ? dateTime(explanation.periodFrom) : "từ lúc lên hệ thống"}</b> → <b>{dateTime(explanation.periodTo)}</b>
                {" "}· Số liệu chụp lúc {dateTime(explanation.snapshotAt)}{explanation.snapshotBy ? ` (${explanation.snapshotBy})` : ""}
                {locked && <> · Chốt bởi {explanation.lockedBy} lúc {dateTime(explanation.lockedAt)}</>}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {editable && (
                <button type="button" className="primary-button !min-h-9" disabled={busy || dirtyIds.length === 0} onClick={() => void saveNotes()}>
                  Lưu giải trình{dirtyIds.length > 0 ? ` (${dirtyIds.length})` : ""}
                </button>
              )}
              {canApprove && !locked && !sourceReopened && (
                <button
                  type="button"
                  className="secondary-button !min-h-9"
                  disabled={busy || running !== null}
                  title="Tính lại sổ sách tại giờ chốt theo dữ liệu mới nhất (phiếu vừa bổ sung, rã lại...)"
                  onClick={() => void runAction("REFRESH_STOCKTAKE_EXPLANATION", "Đã cập nhật tồn hệ thống tại giờ chốt theo dữ liệu mới nhất; giải trình giữ nguyên theo mã hàng.")}
                >
                  {spinIcon("REFRESH_STOCKTAKE_EXPLANATION", "sync")}{running === "REFRESH_STOCKTAKE_EXPLANATION" ? "Đang cập nhật…" : "Cập nhật tồn hệ thống"}
                </button>
              )}
              {canApprove && !locked && !sourceReopened && (
                <button
                  type="button"
                  className="secondary-button !min-h-9 !border-emerald-300 !text-emerald-800"
                  disabled={busy || running !== null}
                  onClick={() => { if (window.confirm(`Chốt giải trình đợt ${explanation.sourceCode}?\n\nChốt = GHI NHẬN chênh lệch kiểm kê vào tồn kho và giá vốn (theo tồn hệ thống mới nhất tại giờ chốt). Sau khi chốt số liệu đứng yên — muốn sửa thì Mở chốt.`)) void runAction("LOCK_STOCKTAKE_EXPLANATION", `Đã chốt giải trình và ghi nhận chênh lệch kiểm kê đợt ${explanation.sourceCode}.`); }}
                >
                  {spinIcon("LOCK_STOCKTAKE_EXPLANATION", "lock")}{running === "LOCK_STOCKTAKE_EXPLANATION" ? "Đang chốt & ghi nhận…" : <>Chốt &amp; ghi nhận chênh lệch</>}
                </button>
              )}
              {canApprove && locked && (
                <button
                  type="button"
                  className="secondary-button !min-h-9"
                  disabled={busy || running !== null}
                  onClick={() => { if (window.confirm("Mở chốt giải trình?\n\nPhiếu chênh lệch kiểm kê đã ghi nhận sẽ được gỡ khỏi tồn kho và giá vốn; số liệu quay về tự cập nhật cho tới khi chốt lại.")) void runAction("UNLOCK_STOCKTAKE_EXPLANATION", "Đã mở chốt giải trình và gỡ chênh lệch đã ghi nhận."); }}
                >
                  {spinIcon("UNLOCK_STOCKTAKE_EXPLANATION", "lock_open")}{running === "UNLOCK_STOCKTAKE_EXPLANATION" ? "Đang mở chốt…" : "Mở chốt"}
                </button>
              )}
              <button type="button" className="secondary-button !min-h-9" onClick={() => void exportExcel()}>
                <span className="material-symbols-outlined text-lg">download</span>Xuất Excel
              </button>
              <button type="button" className="text-xs font-bold text-slate-500 hover:underline" onClick={() => { if (dirtyIds.length === 0 || window.confirm("Còn giải trình chưa lưu — đóng luôn?")) setDetail(null); }}>Đóng</button>
            </div>
          </div>

          {running && (
            <p className="mx-5 mb-3 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
              Hệ thống đang chạy (tính lại tồn tại giờ chốt{running === "REFRESH_STOCKTAKE_EXPLANATION" ? "" : ", ghi phiếu chênh lệch, tính lại giá vốn"}) — có thể mất vài chục giây, vui lòng không đóng trang…
            </p>
          )}
          {message && !running && (
            <p className={`mx-5 mb-3 rounded-lg border px-3 py-2 text-sm ${message.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>{message.text}</p>
          )}
          {detail.needsRefresh && !locked && (
            <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span>Đợt <b>{explanation.sourceCode}</b> đã được duyệt lại sau lúc chụp số — số dưới đây là số CŨ.</span>
              {canApprove && <button type="button" className="primary-button !min-h-8 !py-1" disabled={busy} onClick={() => void runAction("REFRESH_STOCKTAKE_EXPLANATION", "Đã cập nhật số liệu theo lần duyệt mới; giải trình giữ nguyên theo mã hàng.")}>Cập nhật số liệu</button>}
            </div>
          )}
          {detail.needsRefresh && locked && (
            <p className="mx-5 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Đợt đã được duyệt lại sau lúc chụp số — Mở chốt rồi Cập nhật số liệu nếu cần.</p>
          )}
          {sourceReopened && (
            <div className="mx-5 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span>Đợt <b>{explanation.sourceCode}</b> đã bị mở lại để sửa số đếm. Duyệt lại xong thì gắn giải trình sang đợt mới:</span>
              {detail.relinkCandidates.length === 0 ? (
                <span className="font-bold">chưa có đợt duyệt lại nào của kho này.</span>
              ) : canApprove && !locked ? (
                <>
                  <select className="control !w-auto !mt-0" value={relinkTarget} onChange={(e) => setRelinkTarget(e.target.value)}>
                    {detail.relinkCandidates.map((candidate) => (
                      <option key={candidate.sourceId} value={`${candidate.sourceType}|${candidate.sourceId}`}>{candidate.code} · chốt {dateTime(candidate.cutoffAt)}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="primary-button !min-h-8 !py-1"
                    disabled={busy || !relinkTarget}
                    onClick={() => {
                      const [sourceType, sourceId] = relinkTarget.split("|");
                      void runAction("REFRESH_STOCKTAKE_EXPLANATION", "Đã gắn sang đợt duyệt lại và cập nhật số liệu; giải trình giữ nguyên theo mã hàng.", { sourceType, sourceId });
                    }}
                  >
                    Gắn & cập nhật số liệu
                  </button>
                </>
              ) : <span>(kế toán thao tác{locked ? " sau khi Mở chốt" : ""})</span>}
            </div>
          )}

          <div className="px-5 pb-3 flex flex-wrap items-end gap-3">
            <label className="text-xs font-bold text-slate-500">Nhóm hàng hóa
              <select className="control mt-1" value={lineFilter.group} onChange={(e) => setLineFilter({ ...lineFilter, group: e.target.value })}>
                <option value="ALL">Tất cả nhóm</option>
                <option value="MISSING">Chưa có nhóm</option>
                {groupOptions.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
              </select>
            </label>
            <label className="text-xs font-bold text-slate-500">Tìm mã / tên
              <input className="control mt-1" value={lineFilter.search} onChange={(e) => setLineFilter({ ...lineFilter, search: e.target.value })} placeholder="Mã hoặc tên hàng..." />
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs font-bold text-slate-600">
              <input type="checkbox" checked={lineFilter.onlyVariance} onChange={(e) => setLineFilter({ ...lineFilter, onlyVariance: e.target.checked })} />Chỉ dòng có chênh lệch
            </label>
            <label className="flex items-center gap-2 pb-2 text-xs font-bold text-slate-600" title="Giải trình gồm mọi mã của kho; mã phiếu không đếm tính số kiểm = 0">
              <input type="checkbox" checked={lineFilter.onlyCounted} onChange={(e) => setLineFilter({ ...lineFilter, onlyCounted: e.target.checked })} />Chỉ mã trong phiếu kiểm
            </label>
            <p className="pb-2 text-xs text-slate-500">Đang hiện <b>{visibleLines.length}</b> / {explanation.lines.length} mã</p>
          </div>

          <div className="overflow-x-auto max-h-[640px] overflow-y-auto custom-scrollbar border-t border-slate-200">
            <table className="w-full min-w-[2200px] text-sm">
              <thead className="bg-amber-50 text-[11px] text-slate-700 uppercase sticky top-0 z-10">
                <tr className="border-b border-amber-200">
                  {["STT", "Kho", "Nhóm", "Mã hàng", "Tên hàng", "ĐVT tồn kho"].map((label, index) => (
                    <th key={label} rowSpan={2} style={frozenStyle(index)} className={`sticky z-20 bg-amber-50 px-3 py-2 font-bold text-center border-r border-amber-200 align-middle ${frozenEdge(index)}`}>{label}</th>
                  ))}
                  <th rowSpan={2} className="px-3 py-2 font-bold text-center border-r border-amber-200 align-middle">SL đầu kỳ</th>
                  <th colSpan={5} className="px-3 py-2 font-bold text-center border-r border-amber-200">SL nhập trong kỳ</th>
                  <th colSpan={6} className="px-3 py-2 font-bold text-center border-r border-amber-200">SL xuất trong kỳ</th>
                  {["SL cuối kỳ", "SL kiểm kê", "Chênh lệch (kiểm kê − cuối kỳ)", "Trị giá chênh lệch (tạm tính)", "Giải trình"].map((label) => (
                    <th key={label} rowSpan={2} className="px-3 py-2 font-bold text-center border-r border-amber-200 align-middle">{label}</th>
                  ))}
                </tr>
                <tr className="border-b border-amber-200">
                  {NUMBER_COLUMNS.filter(([, , group]) => group).map(([key, label]) => (
                    <th key={key} className="px-3 py-2 font-bold text-center border-r border-amber-200">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleLines.length === 0 && <tr><td colSpan={23} className="cell text-center text-slate-400">Không có dòng nào khớp bộ lọc.</td></tr>}
                {visibleLines.map((line, index) => {
                  const tone = Math.abs(line.variance) <= 1e-6 ? "" : line.variance > 0 ? "text-emerald-700 font-bold" : "text-rose-700 font-bold";
                  return (
                    <tr key={line.itemId} className="border-t border-slate-100 align-top">
                      <td style={frozenStyle(0)} className="cell sticky z-[5] bg-white text-center tabular-nums">{index + 1}</td>
                      <td style={frozenStyle(1)} className="cell sticky z-[5] bg-white break-words">{explanation.warehouseCode}</td>
                      <td style={frozenStyle(2)} className="cell sticky z-[5] bg-white break-words">{line.goodsGroup || ""}</td>
                      <td style={frozenStyle(3)} className="cell sticky z-[5] bg-white break-words"><b>{line.itemCode}</b></td>
                      <td style={frozenStyle(4)} className="cell sticky z-[5] bg-white">{line.itemName}</td>
                      <td style={frozenStyle(5)} className={`cell sticky z-[5] bg-white break-words ${frozenEdge(5)}`}>{line.unit}</td>
                      {NUMBER_COLUMNS.map(([key, , group]) => {
                        const value = line[key] as number;
                        const strong = key === "inTotal" || key === "outTotal" || key === "closing" || key === "counted";
                        return (
                          <td key={key} className={`cell text-right tabular-nums whitespace-nowrap ${strong ? "font-bold" : ""} ${key === "variance" ? tone : ""} ${group ? "" : "bg-slate-50/50"}`}>
                            {line.notCounted && !line.countAsZero && (key === "counted" || key === "variance")
                              ? (key === "counted" ? <span className="text-xs font-normal text-slate-400">Không kiểm</span> : <span className="text-slate-300">-</span>)
                              : Math.abs(value) <= 1e-9 && group ? <span className="text-slate-300">-</span> : qty(value)}
                            {line.countAsZero && key === "counted" && <small className="block text-[10px] font-normal text-slate-400">không đếm = 0</small>}
                          </td>
                        );
                      })}
                      <td
                        className={`cell text-right tabular-nums whitespace-nowrap ${tone}`}
                        title={Math.abs(line.variance) > 1e-6 ? `Đơn giá tạm tính ${money(unitCostOf(line))} đ / ${line.unit}` : undefined}
                      >
                        {Math.abs(line.variance) <= 1e-6 ? <span className="text-slate-300">-</span> : money(varianceValueOf(line))}
                      </td>
                      <td className="cell min-w-[280px]">
                        {editable ? (
                          <textarea
                            className={`control !mt-0 min-h-[38px] text-sm ${(notes[line.itemId] || "") !== (line.explanation || "") ? "border-amber-400 bg-amber-50" : ""}`}
                            rows={1}
                            value={notes[line.itemId] ?? ""}
                            onChange={(e) => setNotes({ ...notes, [line.itemId]: e.target.value })}
                            placeholder={Math.abs(line.variance) > 1e-6 ? "Nhập giải trình..." : ""}
                          />
                        ) : (
                          <span className="whitespace-pre-wrap">{line.explanation || ""}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {visibleLines.length > 0 && (
                <tfoot className="sticky bottom-0 z-10 bg-amber-50 font-bold">
                  <tr className="border-t border-amber-200">
                    <td colSpan={6} style={{ left: 0 }} className={`cell sticky z-[5] bg-amber-50 text-right ${frozenEdge(5)}`}>Tổng cộng ({visibleLines.length} dòng đang hiện)</td>
                    {NUMBER_COLUMNS.map(([key]) => {
                      const total = visibleTotals[key];
                      const tone = key === "variance" ? (total < -1e-6 ? "text-rose-700" : total > 1e-6 ? "text-emerald-700" : "") : "";
                      return <td key={key} className={`cell text-right tabular-nums whitespace-nowrap ${tone}`}>{qty(total)}</td>;
                    })}
                    <td className={`cell text-right tabular-nums whitespace-nowrap ${visibleVarianceValue < 0 ? "text-rose-700" : visibleVarianceValue > 0 ? "text-emerald-700" : ""}`}>{money(visibleVarianceValue)}</td>
                    <td className="cell" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
