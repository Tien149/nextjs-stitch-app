"use client";

import React, { useCallback, useEffect, useState } from "react";
import { MoneyLineChart, ShareDonutChart } from "@/components/charts/ReportCharts";
import { PanelHeader, money } from "@/components/reports/report-ui";

/**
 * Góc nhìn "Cả năm 12 tháng" trong tab P&L đa chiều (feedback chị Bình 26/08/2026 mục 4,
 * chỉnh lại 03/09/2026): bảng KQKD có ĐÚNG cấu trúc như bảng một kỳ — 10 dòng chỉ tiêu,
 * bung ra nhóm hạng mục rồi hạng mục — nhưng mỗi tháng một cột để nhìn biến động giữa
 * các tháng. Kèm pie tỷ trọng doanh thu và line COGS/Lương so với doanh thu. Tự fetch
 * type=pnl-matrix vì tab P&L mặc định vẫn nạp số liệu một kỳ.
 */

type MatrixSeries = { code: string; name: string; months: number[]; total: number };
type MatrixGroup = MatrixSeries & { items: MatrixSeries[] };
type MatrixStatementLine = { key: string; label: string; subtotal: boolean; months: number[]; total: number; groups: MatrixGroup[] };
type MatrixTotals = {
  revenue: number; cogs: number; payroll: number; depreciation: number; otherOpex: number;
  otherIncome: number; otherExpense: number; grossProfit: number; opexBeforeDepreciation: number;
  ebitda: number; operatingProfit: number; netProfit: number;
};
type PnlMatrixData = {
  year: string;
  branchCode: string;
  months: string[];
  totals: MatrixTotals[];
  revenueSplit: { byDepartment: MatrixSeries[]; byChannel: MatrixSeries[]; svc: number[]; vat: number[] };
  payrollSplit: { bonus: number[]; insurance: number[] };
  budgets: { revenue: number[]; cogs: number[]; payroll: number[] };
  statement: MatrixStatementLine[];
  revenueByDepartment: MatrixSeries[];
  payrollByDepartment: MatrixSeries[];
  cogsByDepartment: MatrixSeries[];
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const isEmptySeries = (row: { months: number[]; total: number }) => Math.abs(row.total) <= 0.5 && row.months.every((value) => Math.abs(value) <= 0.5);

export default function PnlMatrixTab({ period, branchCode }: { period: string; branchCode: string }) {
  const [data, setData] = useState<PnlMatrixData | null>(null);
  const [loading, setLoading] = useState(false);
  const [pieMonth, setPieMonth] = useState<number>(-1); // -1 = cả năm
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hideEmpty, setHideEmpty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ type: "pnl-matrix", period, branchCode });
      const response = await fetch(`/api/reports?${params.toString()}`);
      if (response.ok) setData((await response.json()) as PnlMatrixData);
    } finally {
      setLoading(false);
    }
  }, [period, branchCode]);

  // setTimeout 0 để tránh setState đồng bộ trong effect — cùng pattern với app/reports/page.tsx.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (loading || !data) {
    return <p className="py-10 text-center text-sm text-slate-500 animate-pulse">Đang tổng hợp P&L 12 tháng...</p>;
  }

  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const yearRevenue = sum(data.totals.map((total) => total.revenue));
  const percent = (value: number) => (yearRevenue ? `${((value / yearRevenue) * 100).toFixed(1)}%` : "-");
  const cell = (value: number) => (Math.abs(value) > 0.5 ? money(Math.round(value)) : "-");
  const pickAt = (values: number[]) => (pieMonth < 0 ? values.reduce((total, value) => total + value, 0) : values[pieMonth] || 0);
  /**
   * Pie tỷ trọng lấy đúng cấu thành tiền khách trả như file của chị Bình: phần doanh thu
   * thuần (tách theo bộ phận hoặc theo kênh) + SVC + Thuế GTGT, cộng lại tròn 100%.
   */
  const pickPie = (rows: MatrixSeries[]) => [
    ...rows.map((row) => ({ name: row.name, value: pickAt(row.months) })),
    { name: "SVC", value: pickAt(data.revenueSplit.svc) },
    { name: "Thuế GTGT", value: pickAt(data.revenueSplit.vat) },
  ];

  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  const setAll = (nextCollapsed: boolean) => {
    const next: Record<string, boolean> = {};
    if (nextCollapsed) {
      for (const line of data.statement) {
        if (line.groups.length > 0) next[line.key] = true;
        for (const group of line.groups) if (group.items.length > 0) next[`${line.key}:${group.code}`] = true;
      }
    }
    setCollapsed(next);
  };

  const exportExcel = async () => {
    // xlsx chỉ nạp khi bấm xuất — tránh cộng vào bundle của trang báo cáo.
    const XLSX = await import("xlsx");
    const header = ["Chỉ tiêu", ...monthHeaders, "Cả năm", "% doanh thu"];
    const rows: Array<Array<string | number>> = [header];
    const push = (prefix: string, label: string, series: { months: number[]; total: number }) => {
      rows.push([`${prefix}${label}`, ...series.months.map((value) => Math.round(value)), Math.round(series.total), yearRevenue ? Number(((series.total / yearRevenue) * 100).toFixed(2)) : 0]);
    };
    for (const line of data.statement) {
      push("", line.label, line);
      for (const group of line.groups) {
        if (hideEmpty && isEmptySeries(group)) continue;
        push("    ", group.name, group);
        for (const item of group.items) {
          if (hideEmpty && isEmptySeries(item)) continue;
          push("        ", `${item.code === "UNCLASSIFIED" ? "" : `${item.code} - `}${item.name}`, item);
        }
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, `KQKD ${data.year}`);
    XLSX.writeFile(workbook, `kqkd_12_thang_${data.year}_${data.branchCode}.xlsx`);
  };

  // Cột đầu dính bên trái khi cuộn ngang 12 tháng; phải tô nền cho ô đó cùng màu với dòng
  // để số của các cột tháng không hiện xuyên qua.
  const numberCells = (series: { months: number[]; total: number }, bold: boolean, tone = "") => (
    <>
      {series.months.map((value, index) => (
        <td key={data.months[index]} className={`px-3 py-2.5 text-right whitespace-nowrap ${tone}`}>{bold ? <b>{cell(value)}</b> : cell(value)}</td>
      ))}
      <td className={`px-3 py-2.5 text-right whitespace-nowrap border-l border-slate-200 ${tone}`}><b>{cell(series.total)}</b></td>
      <td className={`px-3 py-2.5 text-right whitespace-nowrap ${tone}`}>{percent(series.total)}</td>
    </>
  );

  return (
    <div className="space-y-5">
      <section className="table-panel">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold">Báo cáo Kết quả Kinh doanh cả năm {data.year}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Cùng cấu trúc với bảng một kỳ, mỗi tháng một cột để nhìn biến động. Bấm tên chỉ tiêu hoặc tên nhóm để mở/thu gọn.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />
              Ẩn dòng bằng 0
            </label>
            <button type="button" onClick={() => setAll(false)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50">Mở tất cả</button>
            <button type="button" onClick={() => setAll(true)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded px-3 py-1.5 hover:bg-slate-50">Thu gọn tất cả</button>
            <button type="button" onClick={() => void exportExcel()} className="secondary-button flex items-center gap-1 text-xs font-bold text-blue-700 border border-blue-200 rounded px-3 py-1.5 hover:bg-blue-50">
              <span className="material-symbols-outlined text-base">download</span>Xuất Excel
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[720px] overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white shadow-sm z-20">
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-semibold whitespace-nowrap sticky left-0 bg-white z-10 min-w-[260px]">Chỉ tiêu</th>
                {monthHeaders.map((header) => (
                  <th key={header} className="px-3 py-3 font-semibold whitespace-nowrap text-right">{header}</th>
                ))}
                <th className="px-3 py-3 font-semibold whitespace-nowrap text-right border-l border-slate-200">Cả năm</th>
                <th className="px-3 py-3 font-semibold whitespace-nowrap text-right">% DT</th>
              </tr>
            </thead>
            <tbody>
              {data.statement.map((line) => {
                const lineCollapsed = collapsed[line.key];
                const groups = hideEmpty ? line.groups.filter((group) => !isEmptySeries(group)) : line.groups;
                const lineBg = line.subtotal ? "bg-blue-50" : "bg-slate-50";
                const lineTone = line.subtotal ? (line.total < 0 ? "text-rose-600" : "text-blue-700") : "";
                return (
                  <React.Fragment key={line.key}>
                    <tr
                      className={`border-t border-slate-200 font-bold ${lineBg} ${groups.length > 0 ? "cursor-pointer hover:bg-slate-100" : ""}`}
                      onClick={groups.length > 0 ? () => toggle(line.key) : undefined}
                    >
                      <td className={`px-4 py-2.5 whitespace-nowrap sticky left-0 z-10 ${lineBg}`}>
                        <span className="flex items-center gap-1">
                          {groups.length === 0
                            ? <span className="w-4" />
                            : <span className="material-symbols-outlined text-base text-slate-400">{lineCollapsed ? "chevron_right" : "expand_more"}</span>}
                          {line.label}
                        </span>
                      </td>
                      {numberCells(line, true, lineTone)}
                    </tr>
                    {!lineCollapsed && groups.map((group) => {
                      const groupKey = `${line.key}:${group.code}`;
                      const groupCollapsed = collapsed[groupKey];
                      const items = hideEmpty ? group.items.filter((item) => !isEmptySeries(item)) : group.items;
                      const groupBg = group.code === "UNGROUPED" ? "bg-amber-50" : "bg-white";
                      return (
                        <React.Fragment key={groupKey}>
                          <tr
                            className={`border-t border-slate-100 ${groupBg} ${items.length > 0 ? "cursor-pointer hover:bg-slate-50" : ""}`}
                            onClick={items.length > 0 ? () => toggle(groupKey) : undefined}
                          >
                            <td className={`px-4 py-2.5 whitespace-nowrap sticky left-0 z-10 ${groupBg}`}>
                              <span className="flex items-center gap-1 pl-6">
                                {items.length === 0
                                  ? <span className="w-4" />
                                  : <span className="material-symbols-outlined text-base text-slate-300">{groupCollapsed ? "chevron_right" : "expand_more"}</span>}
                                <b className="text-slate-700">{group.name}</b>
                              </span>
                            </td>
                            {numberCells(group, true)}
                          </tr>
                          {!groupCollapsed && items.map((item) => {
                            const itemBg = item.code === "UNCLASSIFIED" ? "bg-amber-50" : "bg-white";
                            return (
                              <tr key={`${groupKey}:${item.code}`} className={`border-t border-slate-100 ${itemBg} hover:bg-slate-50`}>
                                <td className={`px-4 py-2.5 whitespace-nowrap sticky left-0 z-10 ${itemBg}`}>
                                  <span className="pl-16 text-slate-600">
                                    {item.code !== "UNCLASSIFIED" && <span className="text-[11px] text-slate-400 mr-1.5">{item.code}</span>}
                                    {item.name}
                                  </span>
                                </td>
                                {numberCells(item, false)}
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid xl:grid-cols-2 gap-5">
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">Doanh thu theo tỷ trọng bộ phận</h2>
              <p className="text-xs text-slate-500 mt-0.5">Doanh thu thuần tách theo Bếp/Bar/FOH, cộng SVC và thuế GTGT thành 100% tiền khách trả.</p>
            </div>
            <select className="control text-xs w-32" value={pieMonth} onChange={(event) => setPieMonth(Number(event.target.value))}>
              <option value={-1}>Cả năm</option>
              {monthHeaders.map((header, index) => (
                <option key={header} value={index}>Tháng {index + 1}</option>
              ))}
            </select>
          </div>
          <div className="p-4">
            <ShareDonutChart data={pickPie(data.revenueSplit.byDepartment)} />
          </div>
        </section>
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Doanh thu theo tỷ trọng phân bổ theo nguồn" subtitle="Cùng số tiền đó nhưng tách theo kênh bán (Tại chỗ, Grab...), kèm SVC và thuế GTGT." exportable={false} />
          <div className="p-4">
            <ShareDonutChart data={pickPie(data.revenueSplit.byChannel)} />
          </div>
        </section>
      </div>

      <div className="grid xl:grid-cols-2 gap-5">
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="COGS so với doanh thu" subtitle="Giá vốn từng bộ phận và tổng, đặt cạnh doanh thu từng bộ phận và tổng doanh thu." exportable={false} />
          <div className="p-4">
            <MoneyLineChart
              labels={monthHeaders}
              series={[
                ...data.cogsByDepartment.slice(0, 3).map((row) => ({ name: `COGS ${row.name}`, values: row.months })),
                { name: "Tổng COGS", values: data.totals.map((total) => total.cogs) },
                ...data.revenueSplit.byDepartment.slice(0, 3).map((row) => ({ name: row.name, values: row.months })),
                { name: "Doanh thu", values: data.totals.map((total) => total.revenue), color: "#84cc16" },
                ...(data.budgets.cogs.some((value) => value > 0)
                  ? [{ name: "Ngân sách COGS", values: data.budgets.cogs, color: "#94a3b8", dashed: true }]
                  : []),
              ]}
            />
          </div>
        </section>
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Lương so với doanh thu" subtitle="Lương, SVC & KPI, bảo hiểm trên nền doanh thu tháng — cùng bộ đường như file của chị Bình." exportable={false} />
          <div className="p-4">
            <MoneyLineChart
              labels={monthHeaders}
              series={[
                { name: "Lương", values: data.totals.map((total) => total.payroll) },
                // SVC thu được thường chia lại cho nhân viên nên gộp chung với thưởng KPI
                // thành một đường, đúng chú giải "SVC & KPI" trong file gốc.
                { name: "SVC & KPI", values: data.revenueSplit.svc.map((value, index) => value + (data.payrollSplit.bonus[index] || 0)) },
                { name: "Bảo hiểm", values: data.payrollSplit.insurance },
                { name: "Doanh thu", values: data.totals.map((total) => total.revenue), color: "#84cc16" },
                ...(data.budgets.payroll.some((value) => value > 0)
                  ? [{ name: "Ngân sách lương", values: data.budgets.payroll, color: "#94a3b8", dashed: true }]
                  : []),
              ]}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
