"use client";

import React, { useMemo, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { toFileSlug } from "@/lib/export-table-excel";
import { goodsGroupKey } from "@/lib/goods-group";
import { inventoryItemTypeLabel } from "@/lib/inventory-scope";
import { CHART_COLORS, MoneyBarChart } from "@/components/charts/ReportCharts";
import { PanelHeader, money, statValueTextClass } from "@/components/reports/report-ui";
import { ShowMoreRows, useRowLimit } from "@/components/ShowMoreRows";
import { matchesSearch } from "@/lib/search-text";
import {
  NO_HOUR,
  orderedShiftNames,
  rankSalesItems,
  revenuePerGuest,
  SALES_KINDS,
  salesKindLabels,
  shiftRangeOf,
  shiftsOf,
  summarizeSales,
  summarizeVisits,
  type RankBy,
  type SalesItemSummary,
  type SalesKind,
  type ShiftConfigs,
  type VisitMoney,
} from "@/lib/sales-analysis";
import SalesShiftEditor from "@/components/reports/SalesShiftEditor";
import type { SalesAnalysisData, SalesItemNoteValue } from "@/lib/sales-analysis-server";

/**
 * Tab "DT theo ca & món" (khách 20/11/2026): doanh thu sáng / trưa / tối, đồ ăn / đồ uống, từng
 * món, top 20 bán chạy và top 10 bán chậm trong tháng. Số lấy từ dòng import doanh thu POS có
 * giờ bán; mốc giờ ca chỉnh ngay trên màn (nhớ trên máy người xem).
 */

const qty = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value);
const pct = (value: number, base: number) => (Math.abs(base) >= 0.5 ? `${((value / base) * 100).toFixed(1)}%` : "—");

/** "NME 10:00 – 14:59 · ASA 10:30 – 14:59" — khung giờ của một ca ở từng cửa hàng đang xem. */
function rangeText(configs: ShiftConfigs, branches: string[], name: string) {
  if (name === NO_HOUR) return "File chỉ có ngày";
  const parts = branches.map((branch) => ({ branch, range: shiftRangeOf(shiftsOf(configs, branch), name) })).filter((part) => part.range);
  if (parts.length === 1 && branches.length === 1) return parts[0].range;
  if (parts.length > 0 && parts.every((part) => part.range === parts[0].range)) return parts[0].range;
  return parts.map((part) => `${part.branch} ${part.range}`).join(" · ");
}

export default function SalesAnalysisTab({ data, canConfigure = false }: { data: SalesAnalysisData; canConfigure?: boolean }) {
  // Ca sửa xong là áp ngay cho số liệu đang xem, không phải tải lại báo cáo.
  const [configs, setConfigs] = useState<ShiftConfigs>(() => data.shiftConfigs || {});
  const branches = useMemo(() => (data.branchCode === "ALL" ? data.branches || [] : [data.branchCode]), [data.branchCode, data.branches]);
  const shiftNames = useMemo(() => orderedShiftNames(configs, branches.length > 0 ? branches : [data.branchCode]), [branches, configs, data.branchCode]);
  const [kindFilter, setKindFilter] = useState<SalesKind | "ALL">("ALL");
  const [rankBy, setRankBy] = useState<RankBy>("quantity");
  const [skipFree, setSkipFree] = useState(true);
  const [search, setSearch] = useState("");
  // Lọc theo Loại và Nhóm hàng hóa của danh mục mặt hàng (khách 20/11/2026) — khác Nhóm doanh thu.
  const [typeFilter, setTypeFilter] = useState("");
  const [goodsGroupFilter, setGoodsGroupFilter] = useState("");
  // Số món của hai bảng xếp hạng: BOD tự gõ (khách 20/11/2026), mặc định 20 bán chạy / 10 bán chậm.
  const [bestLimit, setBestLimit] = useState(20);
  const [worstLimit, setWorstLimit] = useState(10);
  // Ghi chú của BOD theo món (kỳ × phạm vi cửa hàng đang xem). Số liệu tải lại thì lấy bản máy chủ.
  const [noteState, setNoteState] = useState(() => ({ source: data.notes, notes: data.notes || {} }));
  if (noteState.source !== data.notes) setNoteState({ source: data.notes, notes: data.notes || {} });
  const notes = noteState.notes;
  const saveNote = async (productCode: string, note: string) => {
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "SAVE_SALES_ITEM_NOTE", period: data.period, branchCode: data.branchCode, productCode, note }),
    });
    const payload = (await response.json().catch(() => ({}))) as { note?: SalesItemNoteValue | null; error?: string };
    if (!response.ok) throw new Error(payload.error || "Không lưu được ghi chú");
    setNoteState((current) => {
      const next = { ...current.notes };
      if (payload.note) next[productCode] = payload.note;
      else delete next[productCode];
      return { ...current, notes: next };
    });
  };
  const noteProps = { notes, canEdit: canConfigure, onSave: saveNote };

  const itemInfo = useMemo(() => data.itemInfo || {}, [data.itemInfo]);
  const goodsGroupOf = (code: string) => itemInfo[code]?.goodsGroup || "";
  // Ô chọn chỉ liệt kê loại / nhóm có bán trong kỳ. "__NONE__" = món chưa khai nhóm hàng hóa.
  const filterOptions = useMemo(() => {
    const types = new Map<string, number>();
    const groups = new Map<string, { label: string; count: number }>();
    for (const code of new Set(data.cells.map((cell) => cell.code))) {
      const info = itemInfo[code];
      const type = info?.itemType || "";
      types.set(type, (types.get(type) || 0) + 1);
      const key = info?.goodsGroup ? goodsGroupKey(info.goodsGroup) : "__NONE__";
      const current = groups.get(key) || { label: info?.goodsGroup || "(Chưa có nhóm hàng hóa)", count: 0 };
      current.count += 1;
      groups.set(key, current);
    }
    return {
      types: [...types.entries()].map(([value, count]) => ({ value, label: value ? inventoryItemTypeLabel(value) : "(Không có trong danh mục)", count })).sort((a, b) => b.count - a.count),
      groups: [...groups.entries()].map(([value, group]) => ({ value, ...group })).sort((a, b) => (a.value === "__NONE__" ? 1 : b.value === "__NONE__" ? -1 : a.label.localeCompare(b.label, "vi"))),
    };
  }, [data.cells, itemInfo]);
  const cells = useMemo(() => {
    if (!typeFilter && !goodsGroupFilter) return data.cells;
    return data.cells.filter((cell) => {
      const info = itemInfo[cell.code];
      if (typeFilter && (info?.itemType || "") !== typeFilter.replace(/^__EMPTY__$/, "")) return false;
      if (goodsGroupFilter) {
        const key = info?.goodsGroup ? goodsGroupKey(info.goodsGroup) : "__NONE__";
        if (key !== goodsGroupFilter) return false;
      }
      return true;
    });
  }, [data.cells, goodsGroupFilter, itemInfo, typeFilter]);
  const itemFilterLabel = [
    typeFilter ? `loại ${filterOptions.types.find((option) => (option.value || "__EMPTY__") === typeFilter)?.label || typeFilter}` : "",
    goodsGroupFilter ? `nhóm hàng hóa ${filterOptions.groups.find((option) => option.value === goodsGroupFilter)?.label || goodsGroupFilter}` : "",
  ].filter(Boolean).join(", ");

  const all = useMemo(() => summarizeSales(cells, configs, shiftNames), [cells, configs, shiftNames]);
  const filtered = useMemo(
    () => (kindFilter === "ALL" ? all : summarizeSales(cells, configs, shiftNames, [kindFilter])),
    [all, cells, configs, shiftNames, kindFilter],
  );
  const kindsPresent = useMemo(() => SALES_KINDS.filter((kind) => Math.abs(all.byKind[kind].amount) >= 0.5 || all.byKind[kind].rows > 0), [all]);
  const tableKinds = useMemo(() => (kindsPresent.length > 0 ? kindsPresent : (["FOOD", "DRINK"] as SalesKind[])), [kindsPresent]);
  const noHour = all.byShift[NO_HOUR];
  // Ca lạ (ca đã đổi tên sau khi tính) vẫn hiện nếu còn số; "Không có giờ" chỉ hiện khi có dòng.
  const shiftsShown = useMemo(() => {
    const extra = Object.keys(all.byShift).filter((name) => name !== NO_HOUR && !shiftNames.includes(name) && all.byShift[name].rows > 0);
    return [...shiftNames, ...extra, ...(noHour.rows > 0 ? [NO_HOUR] : [])];
  }, [all.byShift, noHour.rows, shiftNames]);
  const shiftLabel = (name: string) => (name === NO_HOUR ? NO_HOUR : `Ca ${name.toLocaleLowerCase("vi")}`);
  const rangeOf = (name: string) => rangeText(configs, branches, name);
  const nameOf = (code: string) => data.names[code] || "";
  const filterLabel = `${kindFilter === "ALL" ? "mọi nhóm doanh thu" : salesKindLabels[kindFilter]}${itemFilterLabel ? `, ${itemFilterLabel}` : ""}`;

  // Xem "Tất cả" thì xếp hạng bỏ nhóm Phụ thu: khăn lạnh bán 4.480 cái/tháng (ASA T10) đứng đầu
  // bảng bán chạy theo số lượng mà không phải món. Bấm riêng nhóm Phụ thu vẫn xem được.
  const rankPool = useMemo(() => (kindFilter === "ALL" ? filtered.items.filter((item) => item.kind !== "SERVICE") : filtered.items), [filtered.items, kindFilter]);
  const rankNote = `${filterLabel}${kindFilter === "ALL" && all.byKind.SERVICE.rows > 0 ? " (không tính Phụ thu)" : ""}${skipFree ? ", bỏ món 0 đ" : ""}`;
  const best = useMemo(() => rankSalesItems(rankPool, { by: rankBy, order: "best", limit: bestLimit, skipFree }), [rankPool, rankBy, skipFree, bestLimit]);
  const worst = useMemo(() => rankSalesItems(rankPool, { by: rankBy, order: "worst", limit: worstLimit, skipFree }), [rankPool, rankBy, skipFree, worstLimit]);
  const searchedItems = useMemo(
    () => filtered.items.filter((item) => matchesSearch(search, [item.code, data.names[item.code], itemInfo[item.code]?.goodsGroup])),
    [filtered.items, search, data.names, itemInfo],
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
      const byHour = summarizeSales(cells, configs, shiftNames, [kind]).byHour;
      return {
        name: salesKindLabels[kind],
        color: CHART_COLORS[index % CHART_COLORS.length],
        values: Array.from({ length: lastHour - firstHour + 1 }, (_, offset) => Math.round(byHour[firstHour + offset].amount)),
      };
    });
  }, [all.byKind.OTHER.rows, cells, configs, firstHour, kindFilter, lastHour, shiftNames, tableKinds]);

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
            <p className="text-xs font-semibold text-slate-500">Nhóm doanh thu</p>
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
          <label className="block">
            <span className="text-xs font-semibold text-slate-500">Loại</span>
            <select className="control mt-1.5 w-44" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="">Tất cả loại</option>
              {filterOptions.types.map((option) => <option key={option.value || "__EMPTY__"} value={option.value || "__EMPTY__"}>{option.label} ({option.count})</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-500">Nhóm hàng hóa</span>
            <select className="control mt-1.5 w-56" value={goodsGroupFilter} onChange={(event) => setGoodsGroupFilter(event.target.value)}>
              <option value="">Tất cả nhóm hàng hóa</option>
              {filterOptions.groups.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
          </label>
          {(typeFilter || goodsGroupFilter) && (
            <button type="button" className="self-end pb-2 text-xs font-bold text-blue-600 hover:underline" onClick={() => { setTypeFilter(""); setGoodsGroupFilter(""); }}>
              Bỏ lọc loại / nhóm
            </button>
          )}
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
          Ca chia theo giờ bán của file POS và bảng ca của từng nhà hàng (khung bên dưới); giờ trước ca đầu tiên tính vào ca cuối.
        </p>
        {noHour.rows > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <b>{noHour.rows.toLocaleString("vi-VN")}</b> dòng doanh thu ({money(Math.round(noHour.amount))} đ) <b>không có giờ bán</b> — file import chỉ có ngày nên không chia được ca, xếp riêng vào cột &quot;Không có giờ&quot;.
            Muốn chia ca thì xoá các ngày đó ở Sổ doanh thu rồi import lại file POS có cột Thời gian kèm giờ.
          </p>
        )}
      </section>

      <SalesShiftEditor
        branches={branches}
        configs={configs}
        canEdit={canConfigure}
        hasMinuteGap={
          branches.some((branch) => shiftsOf(configs, branch).some((shift) => !shift.from.endsWith(":00")))
          && data.cells.some((cell) => cell.hour !== null && cell.minute === null)
        }
        onSaved={(branchCode, shifts) => setConfigs((current) => ({ ...current, [branchCode]: shifts }))}
      />

      <div className={`grid gap-4 sm:grid-cols-2 ${shiftsShown.length > 3 ? "xl:grid-cols-4" : shiftsShown.length === 2 ? "xl:grid-cols-2" : "xl:grid-cols-3"}`}>
        {shiftsShown.map((shift) => {
          const value = filtered.byShift[shift] || { quantity: 0, amount: 0, total: 0, rows: 0 };
          const text = `${money(Math.round(value.amount))} đ`;
          return (
            <div key={shift} className={`rounded-lg border p-4 ${shift === NO_HOUR ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-700">{shiftLabel(shift)}</span>
                <span className="text-xs text-slate-500 text-right">{rangeOf(shift)}</span>
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
                    <td className="px-4 py-3 whitespace-nowrap font-semibold">{shift}</td>
                    <td className="px-4 py-3 text-slate-500">{rangeOf(shift)}</td>
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

      <VisitsSection data={data} configs={configs} shiftNames={shiftNames} />

      {hourSeries.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Doanh thu món theo giờ" subtitle={`Cộng cả tháng theo từng giờ bán (${filterLabel}). Dòng không có giờ không nằm trong biểu đồ.`} exportable={false} />
          <div className="p-4">
            <MoneyBarChart labels={hourLabels} series={hourSeries} height={300} />
          </div>
        </section>
      )}

      <RankTable
        titleBefore="Top"
        titleAfter={`món bán chạy nhất ${data.period}`}
        limit={bestLimit}
        onLimit={setBestLimit}
        available={rankPool.length}
        {...noteProps}
        subtitle={`Xếp theo ${rankBy === "quantity" ? "số lượng bán" : "doanh thu món"}, ${rankNote}.`}
        items={best}
        shifts={shiftsShown.filter((shift) => shift !== NO_HOUR)}
        nameOf={nameOf}
        groupOf={goodsGroupOf}
        base={filtered.total.amount}
        tone="text-emerald-700"
      />
      <RankTable
        titleBefore="Top"
        titleAfter={`món bán chậm nhất ${data.period}`}
        limit={worstLimit}
        onLimit={setWorstLimit}
        available={rankPool.length}
        {...noteProps}
        subtitle={`Món có bán trong tháng nhưng ít nhất, xếp theo ${rankBy === "quantity" ? "số lượng bán" : "doanh thu món"}, ${rankNote}. Món không bán dòng nào thì không có trong file POS nên không hiện ở đây.`}
        items={worst}
        shifts={shiftsShown.filter((shift) => shift !== NO_HOUR)}
        nameOf={nameOf}
        groupOf={goodsGroupOf}
        base={filtered.total.amount}
        tone="text-rose-700"
      />

      <section className="table-panel">
        <PanelHeader
          title={`Doanh thu theo món ${data.period}`}
          subtitle={`${filtered.items.length.toLocaleString("vi-VN")} món (${filterLabel}), xếp theo doanh thu món giảm dần. Số lượng và doanh thu tách theo ca.`}
        />
        <div className="px-4 pt-3" data-no-export>
          <input className="control w-72 max-w-full" placeholder="Tìm mã, tên món hoặc nhóm hàng hóa..." value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <div className="overflow-auto max-h-[75vh]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                {["Mã", "Tên món", "Nhóm DT", "Nhóm hàng hóa", ...shiftsShown.map((shift) => `SL ${shift.toLocaleLowerCase("vi")}`), "Tổng SL", ...shiftsShown.map((shift) => `DT ${shift.toLocaleLowerCase("vi")}`), "Tổng DT món", "Tỷ trọng", "Ghi chú"].map((header, index, headers) => (
                  <th key={header} className={`sticky top-0 z-10 bg-white px-4 py-3 font-semibold whitespace-nowrap shadow-[inset_0_-1px_0_#e2e8f0] ${index >= 4 && index < headers.length - 1 ? "text-right" : ""}`}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {searchedItems.slice(0, itemRows.limit).map((item) => (
                <tr key={item.code} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">{item.code}</td>
                  <td className="px-4 py-2 min-w-48">{nameOf(item.code) || <span className="text-slate-400">(chưa có trong danh mục)</span>}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{salesKindLabels[item.kind]}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-slate-600">{goodsGroupOf(item.code)}</td>
                  {shiftsShown.map((shift) => <td key={shift} className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(item.byShift[shift]?.quantity || 0)}</td>)}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{qty(item.quantity)}</td>
                  {shiftsShown.map((shift) => <td key={shift} className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{money(Math.round(item.byShift[shift]?.amount || 0))}</td>)}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{money(Math.round(item.amount))}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{pct(item.amount, filtered.total.amount)}</td>
                  <NoteCell code={item.code} {...noteProps} />
                </tr>
              ))}
              {searchedItems.length === 0 && (
                <tr><td colSpan={8 + shiftsShown.length * 2} className="px-4 py-8 text-center text-slate-500">Không có món nào khớp.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <ShowMoreRows shown={Math.min(itemRows.limit, searchedItems.length)} total={searchedItems.length} step={50} onMore={itemRows.more} onAll={itemRows.all} unit="món" />
      </section>
    </div>
  );
}

type NoteProps = {
  notes: Record<string, SalesItemNoteValue>;
  canEdit: boolean;
  onSave: (productCode: string, note: string) => Promise<void>;
};

/**
 * Ô ghi chú của BOD trên một món: bấm để gõ, Enter hoặc bấm ra ngoài là lưu, Esc huỷ, xoá trắng là
 * xoá. Chữ ghi chú nằm thẳng trong ô nên Xuất Excel mang theo; nút sửa không vào file.
 */
function NoteCell({ code, notes, canEdit, onSave }: NoteProps & { code: string }) {
  const current = notes[code];
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const commit = async () => {
    if (draft === null) return;
    const text = draft.trim();
    if (text === (current?.note || "")) {
      setDraft(null);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(code, text);
      setDraft(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Không lưu được ghi chú");
    } finally {
      setSaving(false);
    }
  };
  if (draft !== null) {
    return (
      <td className="px-4 py-2 min-w-64">
        <textarea
          autoFocus
          rows={2}
          className="control w-full text-sm"
          value={draft}
          disabled={saving}
          placeholder="Ghi chú cho món này..."
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Escape") setDraft(null);
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void commit();
            }
          }}
        />
        {saving && <span className="text-[11px] text-slate-500">Đang lưu...</span>}
        {error && <span className="text-[11px] text-rose-600">{error}</span>}
      </td>
    );
  }
  return (
    <td
      className={`px-4 py-2 min-w-48 max-w-80 align-top ${canEdit ? "cursor-text hover:bg-amber-50" : ""}`}
      title={current ? `${current.updatedBy || ""} · ${new Date(current.updatedAt).toLocaleString("vi-VN")}` : canEdit ? "Bấm để ghi chú" : undefined}
      onClick={canEdit ? () => setDraft(current?.note || "") : undefined}
    >
      {current ? <span className="whitespace-pre-wrap text-slate-700">{current.note}</span> : canEdit ? <span className="text-xs text-slate-300" data-no-export>+ ghi chú</span> : null}
    </td>
  );
}

/** Ô gõ số món của bảng xếp hạng: giữ chữ đang gõ (xoá trắng để gõ lại không nhảy về 1), số hợp lệ mới áp. */
function LimitInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const apply = (raw: string) => {
    const number = Math.round(Number(raw));
    if (Number.isFinite(number) && number >= 1) onChange(Math.min(500, number));
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={500}
      className="control !w-20 !py-1 text-center font-bold"
      value={text}
      aria-label="Số món hiển thị"
      onChange={(event) => {
        setText(event.target.value);
        apply(event.target.value);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function RankTable({ titleBefore, titleAfter, limit, onLimit, available, notes, canEdit, onSave, subtitle, items, shifts, nameOf, groupOf, base, tone }: NoteProps & {
  groupOf: (code: string) => string;
  titleBefore: string;
  titleAfter: string;
  limit: number;
  onLimit: (value: number) => void;
  available: number;
  subtitle: string;
  items: SalesItemSummary[];
  shifts: string[];
  nameOf: (code: string) => string;
  base: number;
  tone: string;
}) {
  return (
    <section className="table-panel">
      <div className="p-4 border-b border-slate-200 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold flex flex-wrap items-center gap-2">
            {titleBefore}
            <LimitInput value={limit} onChange={onLimit} />
            {titleAfter}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">{subtitle} Gõ số món muốn xem vào ô{available > 0 ? ` (tháng này có ${available.toLocaleString("vi-VN")} món)` : ""}.</p>
        </div>
        <ExportExcelButton fileName={toFileSlug(`${titleBefore} ${limit} ${titleAfter}`)} sheetName={`${titleBefore} ${limit}`.slice(0, 31)} />
      </div>
      {/* Gõ Top 100, 200... thì bảng dài: cuộn trong khung, dòng tiêu đề đứng yên (khách 20/11/2026). */}
      <div className="overflow-auto max-h-[70vh]">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              {["#", "Mã", "Tên món", "Nhóm DT", "Nhóm hàng hóa", "SL bán", "DT món", "Tỷ trọng DT", ...shifts.map((shift) => `SL ${shift.toLocaleLowerCase("vi")}`), "Ghi chú"].map((header, index, headers) => (
                <th key={header} className={`sticky top-0 z-10 bg-white px-4 py-3 font-semibold whitespace-nowrap shadow-[inset_0_-1px_0_#e2e8f0] ${index >= 5 && index < headers.length - 1 ? "text-right" : ""}`}>{header}</th>
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
                <td className="px-4 py-2 whitespace-nowrap text-slate-600">{groupOf(item.code)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{qty(item.quantity)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{money(Math.round(item.amount))}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{pct(item.amount, base)}</td>
                {shifts.map((shift) => <td key={shift} className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(item.byShift[shift]?.quantity || 0)}</td>)}
                <NoteCell code={item.code} notes={notes} canEdit={canEdit} onSave={onSave} />
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={9 + shifts.length} className="px-4 py-8 text-center text-slate-500">Không có món nào.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const perGuest = (value: VisitMoney) => {
  const result = revenuePerGuest(value);
  return result === null ? "—" : money(Math.round(result));
};
const perBill = (value: VisitMoney) => (value.bills > 0 ? money(Math.round(value.amount / value.bills)) : "—");
const dayLabel = (date: string) => {
  const [year, month, day] = date.split("-");
  const weekday = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${weekday} ${day}/${month}/${year}`;
};

/**
 * Lượt khách (khách 20/11/2026): cột Số khách / Số hoá đơn của file POS. DT/khách chỉ chia doanh
 * thu của kênh có ghi số khách — đơn Grab/giao hàng không có khách ngồi, chia vào là đội số lên.
 */
function VisitsSection({ data, configs, shiftNames }: { data: SalesAnalysisData; configs: ShiftConfigs; shiftNames: string[] }) {
  const visits = useMemo(() => summarizeVisits(data.visits || [], configs, shiftNames), [data.visits, configs, shiftNames]);
  if (!data.hasGuestData || visits.total.guests <= 0) {
    return (
      <section className="table-panel">
        <PanelHeader title={`Lượt khách ${data.period}`} subtitle="Lấy từ cột Số khách của file doanh thu POS." exportable={false} />
        <p className="px-4 py-6 text-sm text-slate-600">
          Kỳ này chưa có số khách. Thêm cột <b>Số khách</b> vào file doanh thu POS (Import &gt; Doanh thu POS thô) rồi import — có thêm cột <b>Số hoá đơn</b> thì
          hệ thống đếm được số hoá đơn và mỗi hoá đơn chỉ tính khách một lần dù số khách ghi lặp trên mọi dòng món. Không có cột Số hoá đơn thì chỉ ghi số khách ở
          một dòng của mỗi hoá đơn. Ngày đã import trước đó phải xoá ở Sổ doanh thu rồi nạp lại file có cột Số khách.
        </p>
      </section>
    );
  }
  const hasBills = visits.total.bills > 0;
  const noHour = (visits.byShift[NO_HOUR]?.guests || 0) > 0;
  const shifts = [...shiftNames, ...(noHour ? [NO_HOUR] : [])];
  const excluded = visits.byChannel.filter((channel) => !visits.guestChannels.includes(channel.channel) && Math.abs(channel.amount) >= 0.5).map((channel) => channel.channel);
  return (
    <>
      <div className={`grid gap-4 sm:grid-cols-2 ${shifts.length > 3 ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <p className="text-sm font-bold text-slate-700">Lượt khách cả tháng</p>
          <p className="mt-2 text-2xl font-bold tabular-nums text-violet-700">{qty(visits.total.guests)}</p>
          <p className="mt-1 text-xs text-slate-500">
            {hasBills ? `${qty(visits.total.bills)} hoá đơn · ` : ""}DT/khách {perGuest(visits.total)} đ · TB {qty(Math.round((visits.total.guests / Math.max(1, visits.byDay.filter((day) => day.guests > 0).length)) * 10) / 10)} khách/ngày
          </p>
        </div>
        {shifts.map((shift) => {
          const value = visits.byShift[shift] || { guests: 0, bills: 0, amount: 0, total: 0, guestAmount: 0 };
          return (
            <div key={shift} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-700">{shift === NO_HOUR ? "Khách không có giờ" : `Khách ca ${shift.toLocaleLowerCase("vi")}`}</span>
                <span className="text-xs text-slate-500">{pct(value.guests, visits.total.guests)}</span>
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums text-violet-700">{qty(value.guests)}</p>
              <p className="mt-1 text-xs text-slate-500">{hasBills ? `${qty(value.bills)} hoá đơn · ` : ""}DT/khách {perGuest(value)} đ</p>
            </div>
          );
        })}
      </div>

      <section className="table-panel">
        <PanelHeader
          title={`Lượt khách theo ngày ${data.period}`}
          subtitle={`Cột Số khách của file POS, chia ca theo giờ bán. DT/khách = doanh thu món của kênh có ghi số khách ÷ số khách${excluded.length > 0 ? ` (không tính ${excluded.join(", ")} vì không ghi khách)` : ""}.`}
        />
        <div className="overflow-auto max-h-[75vh]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                {["Ngày", ...shifts.map((shift) => `Khách ${shift.toLocaleLowerCase("vi")}`), "Tổng khách", ...(hasBills ? ["Số hoá đơn", "Khách/HĐ"] : []), "DT món", "DT/khách", ...(hasBills ? ["DT/HĐ"] : [])].map((header, index) => (
                  <th key={header} className={`sticky top-0 z-10 bg-white px-4 py-3 font-semibold whitespace-nowrap shadow-[inset_0_-1px_0_#e2e8f0] ${index > 0 ? "text-right" : ""}`}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visits.byDay.map((day) => (
                <tr key={day.date} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap">{dayLabel(day.date)}</td>
                  {shifts.map((shift) => <td key={shift} className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(day.byShift[shift]?.guests || 0)}</td>)}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums font-semibold">{qty(day.guests)}</td>
                  {hasBills && <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(day.bills)}</td>}
                  {hasBills && <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{day.bills > 0 ? qty(Math.round((day.guests / day.bills) * 10) / 10) : "—"}</td>}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{money(Math.round(day.amount))}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{perGuest(day)}</td>
                  {hasBills && <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{perBill(day)}</td>}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                <td className="px-4 py-3">Tổng cộng</td>
                {shifts.map((shift) => <td key={shift} className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{qty(visits.byShift[shift]?.guests || 0)}</td>)}
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{qty(visits.total.guests)}</td>
                {hasBills && <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{qty(visits.total.bills)}</td>}
                {hasBills && <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{visits.total.bills > 0 ? qty(Math.round((visits.total.guests / visits.total.bills) * 10) / 10) : "—"}</td>}
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{money(Math.round(visits.total.amount))}</td>
                <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{perGuest(visits.total)}</td>
                {hasBills && <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums">{perBill(visits.total)}</td>}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="table-panel">
        <PanelHeader title={`Lượt khách theo kênh bán ${data.period}`} subtitle="Tại chỗ / Mang về / Grab... theo cột Hình thức bán của file POS." />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                {["Kênh bán", "Lượt khách", "Tỷ trọng khách", ...(hasBills ? ["Số hoá đơn"] : []), "DT món", "DT/khách", ...(hasBills ? ["DT/HĐ"] : [])].map((header, index) => (
                  <th key={header} className={`px-4 py-3 font-semibold whitespace-nowrap ${index > 0 ? "text-right" : ""}`}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visits.byChannel.map((channel) => (
                <tr key={channel.channel} className="border-t border-slate-100">
                  <td className="px-4 py-2 whitespace-nowrap font-semibold">{channel.channel}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(channel.guests)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{pct(channel.guests, visits.total.guests)}</td>
                  {hasBills && <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{qty(channel.bills)}</td>}
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{money(Math.round(channel.amount))}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{perGuest(channel)}</td>
                  {hasBills && <td className="px-4 py-2 whitespace-nowrap text-right tabular-nums">{perBill(channel)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
