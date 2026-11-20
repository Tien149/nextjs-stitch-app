"use client";

import React, { useMemo, useState } from "react";
import { CHART_COLORS, MoneyBarChart } from "@/components/charts/ReportCharts";
import { PanelHeader, money, statValueTextClass } from "@/components/reports/report-ui";
import { ShowMoreRows, useRowLimit } from "@/components/ShowMoreRows";
import { matchesSearch } from "@/lib/search-text";
import {
  DEFAULT_SHIFT_BOUNDS,
  normalizeShiftBounds,
  rankSalesItems,
  SALES_KINDS,
  salesKindLabels,
  salesShiftLabels,
  shiftRangeLabel,
  summarizeSales,
  type RankBy,
  type SalesItemSummary,
  type SalesKind,
  type SalesShift,
  type ShiftBounds,
} from "@/lib/sales-analysis";
import type { SalesAnalysisData } from "@/lib/sales-analysis-server";

/**
 * Tab "DT theo ca & món" (khách 20/11/2026): doanh thu sáng / trưa / tối, đồ ăn / đồ uống, từng
 * món, top 20 bán chạy và top 10 bán chậm trong tháng. Số lấy từ dòng import doanh thu POS có
 * giờ bán; mốc giờ ca chỉnh ngay trên màn (nhớ trên máy người xem).
 */

const BOUNDS_STORAGE_KEY = "sales-analysis-shift-bounds";
const TIMED_SHIFTS: SalesShift[] = ["MORNING", "NOON", "EVENING"];
const qty = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value);
const pct = (value: number, base: number) => (Math.abs(base) >= 0.5 ? `${((value / base) * 100).toFixed(1)}%` : "—");

function readStoredBounds(): ShiftBounds {
  try {
    const raw = window.localStorage.getItem(BOUNDS_STORAGE_KEY);
    return raw ? normalizeShiftBounds(JSON.parse(raw) as Partial<ShiftBounds>) : DEFAULT_SHIFT_BOUNDS;
  } catch {
    return DEFAULT_SHIFT_BOUNDS;
  }
}

export default function SalesAnalysisTab({ data }: { data: SalesAnalysisData }) {
  const [bounds, setBounds] = useState<ShiftBounds>(() => (typeof window === "undefined" ? DEFAULT_SHIFT_BOUNDS : readStoredBounds()));
  const [kindFilter, setKindFilter] = useState<SalesKind | "ALL">("ALL");
  const [rankBy, setRankBy] = useState<RankBy>("quantity");
  const [skipFree, setSkipFree] = useState(true);
  const [search, setSearch] = useState("");

  const updateBound = (key: keyof ShiftBounds, value: number) => {
    const next = normalizeShiftBounds({ ...bounds, [key]: value });
    setBounds(next);
    try {
      window.localStorage.setItem(BOUNDS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Trình duyệt chặn lưu thì vẫn dùng mốc vừa chọn trong lượt xem này.
    }
  };

  const all = useMemo(() => summarizeSales(data.cells, bounds), [data.cells, bounds]);
  const filtered = useMemo(
    () => (kindFilter === "ALL" ? all : summarizeSales(data.cells, bounds, [kindFilter])),
    [all, data.cells, bounds, kindFilter],
  );
  const kindsPresent = useMemo(() => SALES_KINDS.filter((kind) => Math.abs(all.byKind[kind].amount) >= 0.5 || all.byKind[kind].rows > 0), [all]);
  const tableKinds = useMemo(() => (kindsPresent.length > 0 ? kindsPresent : (["FOOD", "DRINK"] as SalesKind[])), [kindsPresent]);
  const noHour = all.byShift.NO_HOUR;
  const shiftsShown: SalesShift[] = noHour.rows > 0 ? [...TIMED_SHIFTS, "NO_HOUR"] : TIMED_SHIFTS;
  const nameOf = (code: string) => data.names[code] || "";
  const filterLabel = kindFilter === "ALL" ? "mọi nhóm" : salesKindLabels[kindFilter];

  // Xem "Tất cả" thì xếp hạng bỏ nhóm Phụ thu: khăn lạnh bán 4.480 cái/tháng (ASA T10) đứng đầu
  // bảng bán chạy theo số lượng mà không phải món. Bấm riêng nhóm Phụ thu vẫn xem được.
  const rankPool = useMemo(() => (kindFilter === "ALL" ? filtered.items.filter((item) => item.kind !== "SERVICE") : filtered.items), [filtered.items, kindFilter]);
  const rankNote = `${filterLabel}${kindFilter === "ALL" && all.byKind.SERVICE.rows > 0 ? " (không tính Phụ thu)" : ""}${skipFree ? ", bỏ món 0 đ" : ""}`;
  const best = useMemo(() => rankSalesItems(rankPool, { by: rankBy, order: "best", limit: 20, skipFree }), [rankPool, rankBy, skipFree]);
  const worst = useMemo(() => rankSalesItems(rankPool, { by: rankBy, order: "worst", limit: 10, skipFree }), [rankPool, rankBy, skipFree]);
  const searchedItems = useMemo(
    () => filtered.items.filter((item) => matchesSearch(search, [item.code, data.names[item.code]])),
    [filtered.items, search, data.names],
  );
  const itemRows = useRowLimit(50, `${data.period}|${data.branchCode}|${kindFilter}|${search}`);

  // Chart theo giờ: chỉ trải từ giờ sớm nhất tới muộn nhất có bán, khỏi 24 cột trống.
  const activeHours = filtered.byHour.filter((hour) => hour.rows > 0).map((hour) => hour.hour);
  const firstHour = activeHours.length > 0 ? Math.min(...activeHours) : 0;
  const lastHour = activeHours.length > 0 ? Math.max(...activeHours) : -1;
  const hourLabels: string[] = [];
  for (let hour = firstHour; hour <= lastHour; hour += 1) hourLabels.push(`${String(hour).padStart(2, "0")}h`);
  const hourSeries = useMemo(() => {
    if (lastHour < 0) return [];
    const kinds = kindFilter === "ALL" ? tableKinds.filter((kind) => kind !== "OTHER" || all.byKind.OTHER.rows > 0) : [kindFilter];
    return kinds.map((kind, index) => {
      const byHour = summarizeSales(data.cells, bounds, [kind]).byHour;
      return {
        name: salesKindLabels[kind],
        color: CHART_COLORS[index % CHART_COLORS.length],
        values: Array.from({ length: lastHour - firstHour + 1 }, (_, offset) => Math.round(byHour[firstHour + offset].amount)),
      };
    });
  }, [all.byKind.OTHER.rows, bounds, data.cells, firstHour, kindFilter, lastHour, tableKinds]);

  if (data.cells.length === 0) {
    return (
      <section className="table-panel">
        <PanelHeader title="Doanh thu theo ca & món" subtitle={`Kỳ ${data.period}`} exportable={false} />
        <p className="p-10 text-center text-sm text-slate-500">Kỳ này chưa có doanh thu import nào.</p>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-xs font-semibold text-slate-500">Khung giờ ca</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
              {([
                ["morningFrom", "Sáng từ"],
                ["noonFrom", "Trưa từ"],
                ["eveningFrom", "Tối từ"],
              ] as Array<[keyof ShiftBounds, string]>).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5">
                  <span className="text-slate-600">{label}</span>
                  <select className="control !w-20" value={bounds[key]} onChange={(event) => updateBound(key, Number(event.target.value))}>
                    {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">Nhóm</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(["ALL", ...kindsPresent] as Array<SalesKind | "ALL">).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setKindFilter(kind)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${kindFilter === kind ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                >
                  {kind === "ALL" ? "Tất cả" : salesKindLabels[kind]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-slate-500">Xếp hạng món theo</p>
            <div className="mt-1.5 flex gap-1.5">
              {(["quantity", "amount"] as RankBy[]).map((by) => (
                <button
                  key={by}
                  type="button"
                  onClick={() => setRankBy(by)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${rankBy === by ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}
                >
                  {by === "quantity" ? "Số lượng bán" : "Doanh thu"}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 pb-1.5">
            <input type="checkbox" checked={skipFree} onChange={(event) => setSkipFree(event.target.checked)} />
            Bỏ món 0 đ khi xếp hạng (món trong combo, đồ tặng kèm)
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Doanh thu món = thành tiền − giảm giá, chưa gồm phí dịch vụ (SVC) và thuế. Cột &quot;Gồm SVC + thuế&quot; là cột Doanh thu của file import, cùng số với Doanh thu trên P&amp;L.
          Giờ trước mốc Sáng tính vào ca Tối.
        </p>
        {noHour.rows > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <b>{noHour.rows.toLocaleString("vi-VN")}</b> dòng doanh thu ({money(Math.round(noHour.amount))} đ) <b>không có giờ bán</b> — file import chỉ có ngày nên không chia được ca, xếp riêng vào cột &quot;Không có giờ&quot;.
            Muốn chia ca thì xoá các ngày đó ở Sổ doanh thu rồi import lại file POS có cột Thời gian kèm giờ.
          </p>
        )}
      </section>

      <div className={`grid gap-4 sm:grid-cols-2 ${shiftsShown.length > 3 ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
        {shiftsShown.map((shift) => {
          const value = filtered.byShift[shift];
          const text = `${money(Math.round(value.amount))} đ`;
          return (
            <div key={shift} className={`rounded-lg border p-4 ${shift === "NO_HOUR" ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-700">Ca {salesShiftLabels[shift].toLowerCase()}</span>
                <span className="text-xs text-slate-500">{shiftRangeLabel(shift, bounds)}</span>
              </div>
              <p className={`mt-2 font-bold leading-tight tabular-nums whitespace-nowrap text-blue-600 ${statValueTextClass(text)}`}>{text}</p>
              <p className="mt-1 text-xs text-slate-500">
                {pct(value.amount, filtered.total.amount)} doanh thu món ({filterLabel}) · {qty(value.quantity)} món
              </p>
              <p className="text-xs text-slate-400">Gồm SVC + thuế: {money(Math.round(value.total))} đ</p>
            </div>
          );
        })}
      </div>

      <section className="table-panel">
        <PanelHeader
          title={`Doanh thu theo ca và nhóm ${data.period}`}
          subtitle="Mỗi ca tách Đồ ăn / Đồ uống / Phụ thu theo Nhóm doanh thu của dòng import (trống thì theo nhóm doanh thu gắn trên mặt hàng). Bảng này luôn đủ mọi nhóm, không theo nút lọc Nhóm."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-semibold whitespace-nowrap">Ca</th>
                <th className="px-4 py-3 font-semibold whitespace-nowrap">Khung giờ</th>
                {tableKinds.map((kind) => <th key={kind} className="px-4 py-3 font-semibold whitespace-nowrap text-right">{salesKindLabels[kind]}</th>)}
                <th className="px-4 py-3 font-semibold whitespace-nowrap text-right">DT món</th>
                <th className="px-4 py-3 font-semibold whitespace-nowrap text-right">Tỷ trọng</th>
                <th className="px-4 py-3 font-semibold whitespace-nowrap text-right">SL món</th>
                <th className="px-4 py-3 font-semibold whitespace-nowrap text-right">Gồm SVC + thuế</th>
              </tr>
            </thead>
            <tbody>
              {shiftsShown.map((shift) => {
                const value = all.byShift[shift];
                return (
                  <tr key={shift} className="border-t border-slate-100">
                    <td className="px-4 py-3 whitespace-nowrap font-semibold">{salesShiftLabels[shift]}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-500">{shiftRangeLabel(shift, bounds)}</td>
                    {tableKinds.map((kind) => (
                      <td key={kind} className="px-4 py-3 whitespace-nowrap text-right tabular-nums">
                        {money(Math.round(value.byKind[kind].amount))}
                        <span className="block text-[11px] text-slate-400">{pct(value.byKind[kind].amount, value.amount)}</span>
                      </td>
                    ))}
                    <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums font-semibold">{money(Math.round(value.amount))}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{pct(value.amount, all.total.amount)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{qty(value.quantity)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{money(Math.round(value.total))}</td>
                  </tr>
                );
              })}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                <td className="px-4 py-3 whitespace-nowrap">Tổng cộng</td>
                <td className="px-4 py-3" />
                {tableKinds.map((kind) => (
                  <td key={kind} className="px-4 py-3 whitespace-nowrap text-right tabular-nums">
                    {money(Math.round(all.byKind[kind].amount))}
                    <span className="block text-[11px] font-normal text-slate-400">{pct(all.byKind[kind].amount, all.total.amount)}</span>
                  </td>
                ))}
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{money(Math.round(all.total.amount))}</td>
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">100%</td>
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{qty(all.total.quantity)}</td>
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{money(Math.round(all.total.total))}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {hourSeries.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Doanh thu món theo giờ" subtitle={`Cộng cả tháng theo từng giờ bán (${filterLabel}). Dòng không có giờ không nằm trong biểu đồ.`} exportable={false} />
          <div className="p-4">
            <MoneyBarChart labels={hourLabels} series={hourSeries} height={300} />
          </div>
        </section>
      )}

      <RankTable
        title={`Top 20 món bán chạy nhất ${data.period}`}
        subtitle={`Xếp theo ${rankBy === "quantity" ? "số lượng bán" : "doanh thu món"}, ${rankNote}.`}
        items={best}
        nameOf={nameOf}
        base={filtered.total.amount}
        tone="text-emerald-700"
      />
      <RankTable
        title={`Top 10 món bán chậm nhất ${data.period}`}
        subtitle={`Món có bán trong tháng nhưng ít nhất, xếp theo ${rankBy === "quantity" ? "số lượng bán" : "doanh thu món"}, ${rankNote}. Món không bán dòng nào thì không có trong file POS nên không hiện ở đây.`}
        items={worst}
        nameOf={nameOf}
        base={filtered.total.amount}
        tone="text-rose-700"
      />

      <section className="table-panel">
        <PanelHeader
          title={`Doanh thu theo món ${data.period}`}
          subtitle={`${filtered.items.length.toLocaleString("vi-VN")} món (${filterLabel}), xếp theo doanh thu món giảm dần. Số lượng và doanh thu tách theo ca.`}
        />
        <div className="px-4 pt-3" data-no-export>
          <input className="control w-72 max-w-full" placeholder="Tìm mã hoặc tên món..." value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="overflow-auto max-h-[75vh]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                {["Mã", "Tên món", "Nhóm", ...shiftsShown.map((shift) => `SL ${salesShiftLabels[shift].toLowerCase()}`), "Tổng SL", ...shiftsShown.map((shift) => `DT ${salesShiftLabels[shift].toLowerCase()}`), "Tổng DT món", "Tỷ trọng"].map((header, index) => (
                  <th key={header} className={`sticky top-0 z-10 bg-white px-4 py-3 font-semibold whitespace-nowrap shadow-[inset_0_-1px_0_#e2e8f0] ${index >= 3 ? "text-right" : ""}`}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {searchedItems.slice(0, itemRows.limit).map((item) => (
                <tr key={item.code} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">{item.code}</td>
                  <td className="px-4 py-2 min-w-48">{nameOf(item.code) || <span className="text-slate-400">(chưa có trong danh mục)</span>}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{salesKindLabels[item.kind]}</td>
                  {shiftsShown.map((shift) => <td key={shift} className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(item.byShift[shift].quantity)}</td>)}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{qty(item.quantity)}</td>
                  {shiftsShown.map((shift) => <td key={shift} className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{money(Math.round(item.byShift[shift].amount))}</td>)}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{money(Math.round(item.amount))}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{pct(item.amount, filtered.total.amount)}</td>
                </tr>
              ))}
              {searchedItems.length === 0 && (
                <tr><td colSpan={6 + shiftsShown.length * 2} className="px-4 py-8 text-center text-slate-500">Không có món nào khớp.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <ShowMoreRows shown={Math.min(itemRows.limit, searchedItems.length)} total={searchedItems.length} step={50} onMore={itemRows.more} onAll={itemRows.all} unit="món" />
      </section>
    </div>
  );
}

function RankTable({ title, subtitle, items, nameOf, base, tone }: {
  title: string;
  subtitle: string;
  items: SalesItemSummary[];
  nameOf: (code: string) => string;
  base: number;
  tone: string;
}) {
  return (
    <section className="table-panel">
      <PanelHeader title={title} subtitle={subtitle} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              {["#", "Mã", "Tên món", "Nhóm", "SL bán", "DT món", "Tỷ trọng DT", "SL sáng", "SL trưa", "SL tối"].map((header, index) => (
                <th key={header} className={`px-4 py-3 font-semibold whitespace-nowrap ${index >= 4 ? "text-right" : ""}`}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.code} className="border-t border-slate-100">
                <td className={`px-4 py-2 font-bold ${tone}`}>{index + 1}</td>
                <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">{item.code}</td>
                <td className="px-4 py-2 min-w-48">{nameOf(item.code) || <span className="text-slate-400">(chưa có trong danh mục)</span>}</td>
                <td className="px-4 py-2 whitespace-nowrap">{salesKindLabels[item.kind]}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{qty(item.quantity)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{money(Math.round(item.amount))}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{pct(item.amount, base)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(item.byShift.MORNING.quantity)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(item.byShift.NOON.quantity)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(item.byShift.EVENING.quantity)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-slate-500">Không có món nào.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
