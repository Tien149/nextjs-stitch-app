"use client";

import React, { useCallback, useEffect, useState } from "react";
import { MoneyLineChart, ShareDonutChart } from "@/components/charts/ReportCharts";
import { Cell, PanelHeader, money } from "@/components/reports/report-ui";

/**
 * Góc nhìn "Cả năm 12 tháng" trong tab P&L đa chiều (feedback chị Bình 26/08/2026 mục 4):
 * đưa hết hạng mục doanh thu - chi phí vào một bảng liền mạch, group theo nhóm P&L,
 * kèm pie tỷ trọng doanh thu và line COGS/Lương so với doanh thu. Tự fetch
 * type=pnl-matrix vì tab P&L mặc định vẫn nạp số liệu một kỳ.
 */

type MatrixSeries = { code: string; name: string; months: number[]; total: number };
type MatrixGroup = MatrixSeries & { items: MatrixSeries[] };
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
  incomeGroups: MatrixGroup[];
  expenseGroups: MatrixGroup[];
  revenueByDepartment: MatrixSeries[];
  payrollByDepartment: MatrixSeries[];
  cogsByDepartment: MatrixSeries[];
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export default function PnlMatrixTab({ period, branchCode }: { period: string; branchCode: string }) {
  const [data, setData] = useState<PnlMatrixData | null>(null);
  const [loading, setLoading] = useState(false);
  const [pieMonth, setPieMonth] = useState<number>(-1); // -1 = cả năm
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

  const exportExcel = async () => {
    // xlsx chỉ nạp khi bấm xuất — tránh cộng vào bundle của trang báo cáo.
    const XLSX = await import("xlsx");
    const header = ["Hạng mục", ...monthHeaders, "Cả năm", "% doanh thu"];
    const rows: Array<Array<string | number>> = [header];
    const pushSeries = (prefix: string, series: MatrixSeries) => {
      rows.push([`${prefix}${series.name}`, ...series.months.map((value) => Math.round(value)), Math.round(series.total), yearRevenue ? Number(((series.total / yearRevenue) * 100).toFixed(2)) : 0]);
    };
    for (const group of data.incomeGroups) {
      pushSeries("", group);
      for (const item of group.items) pushSeries("    ", item);
    }
    for (const group of data.expenseGroups) {
      pushSeries("", group);
      for (const item of group.items) pushSeries("    ", item);
    }
    rows.push(["EBITDA", ...data.totals.map((total) => Math.round(total.ebitda)), Math.round(sum(data.totals.map((total) => total.ebitda))), ""]);
    rows.push(["Lợi nhuận ròng", ...data.totals.map((total) => Math.round(total.netProfit)), Math.round(sum(data.totals.map((total) => total.netProfit))), ""]);
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, `PnL ${data.year}`);
    XLSX.writeFile(workbook, `pnl_12_thang_${data.year}_${data.branchCode}.xlsx`);
  };

  const summaryRows: Array<{ label: string; pick: (total: MatrixTotals) => number; bold?: boolean }> = [
    { label: "Lợi nhuận gộp", pick: (total) => total.grossProfit, bold: true },
    { label: "EBITDA", pick: (total) => total.ebitda, bold: true },
    { label: "Lợi nhuận ròng", pick: (total) => total.netProfit, bold: true },
  ];

  return (
    <div className="space-y-5">
      <section className="table-panel">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-bold">Bảng P&L đầy đủ {data.year}</h2>
            <p className="text-xs text-slate-500 mt-0.5">Toàn bộ hạng mục doanh thu - chi phí group theo nhóm P&L, trải 12 tháng. Bấm tên nhóm để thu gọn/mở chi tiết.</p>
          </div>
          <button type="button" onClick={() => void exportExcel()} className="secondary-button flex items-center gap-1 text-xs font-bold text-blue-700 border border-blue-200 rounded px-3 py-1.5 hover:bg-blue-50">
            <span className="material-symbols-outlined text-base">download</span>Xuất Excel
          </button>
        </div>
        <div className="overflow-x-auto max-h-[640px] overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white shadow-sm z-10">
              <tr className="text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-semibold whitespace-nowrap">Hạng mục</th>
                {monthHeaders.map((header) => (
                  <th key={header} className="px-4 py-3 font-semibold whitespace-nowrap text-right">{header}</th>
                ))}
                <th className="px-4 py-3 font-semibold whitespace-nowrap text-right">Cả năm</th>
                <th className="px-4 py-3 font-semibold whitespace-nowrap text-right">% DT</th>
              </tr>
            </thead>
            <tbody>
              {[...data.incomeGroups, ...data.expenseGroups].map((group) => {
                const isIncome = data.incomeGroups.includes(group);
                const isCollapsed = collapsed[group.code];
                return (
                  <React.Fragment key={group.code}>
                    <tr
                      className={`border-t border-slate-200 cursor-pointer font-bold ${isIncome ? "bg-emerald-50/70 hover:bg-emerald-50" : "bg-slate-50 hover:bg-slate-100"}`}
                      onClick={() => setCollapsed({ ...collapsed, [group.code]: !isCollapsed })}
                    >
                      <Cell>
                        <span className="flex items-center gap-1">
                          <span className="material-symbols-outlined text-base text-slate-400">{isCollapsed ? "chevron_right" : "expand_more"}</span>
                          <b>{group.name}</b>
                        </span>
                      </Cell>
                      {group.months.map((value, index) => (
                        <Cell key={data.months[index]} right><b>{value ? money(Math.round(value)) : "-"}</b></Cell>
                      ))}
                      <Cell right><b>{money(Math.round(group.total))}</b></Cell>
                      <Cell right><b>{yearRevenue ? `${((group.total / yearRevenue) * 100).toFixed(1)}%` : "-"}</b></Cell>
                    </tr>
                    {!isCollapsed && group.items.map((item) => (
                      <tr key={`${group.code}-${item.code}`} className={`border-t border-slate-100 hover:bg-slate-50 ${item.code === "UNCLASSIFIED" ? "bg-amber-50/60" : ""}`}>
                        <Cell><span className="pl-7 text-slate-600">{item.name}</span></Cell>
                        {item.months.map((value, index) => (
                          <Cell key={data.months[index]} right>{value ? money(Math.round(value)) : "-"}</Cell>
                        ))}
                        <Cell right><b>{money(Math.round(item.total))}</b></Cell>
                        <Cell right>{yearRevenue ? `${((item.total / yearRevenue) * 100).toFixed(1)}%` : "-"}</Cell>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
              {summaryRows.map((row) => (
                <tr key={row.label} className="border-t border-slate-200 bg-blue-50/50 font-bold">
                  <Cell><b className="text-blue-700">{row.label}</b></Cell>
                  {data.totals.map((total, index) => {
                    const value = row.pick(total);
                    return <Cell key={data.months[index]} right><b className={value < 0 ? "text-rose-600" : "text-blue-700"}>{value ? money(Math.round(value)) : "-"}</b></Cell>;
                  })}
                  <Cell right><b className="text-blue-700">{money(Math.round(sum(data.totals.map(row.pick))))}</b></Cell>
                  <Cell right><b>{yearRevenue ? `${((sum(data.totals.map(row.pick)) / yearRevenue) * 100).toFixed(1)}%` : "-"}</b></Cell>
                </tr>
              ))}
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
          <PanelHeader title="Doanh thu theo tỷ trọng phân bổ theo nguồn" subtitle="Cùng số tiền đó nhưng tách theo kênh bán (Tại chỗ, Grab...), kèm SVC và thuế GTGT." />
          <div className="p-4">
            <ShareDonutChart data={pickPie(data.revenueSplit.byChannel)} />
          </div>
        </section>
      </div>

      <div className="grid xl:grid-cols-2 gap-5">
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="COGS so với doanh thu" subtitle="Giá vốn từng bộ phận và tổng, đặt cạnh doanh thu từng bộ phận và tổng doanh thu." />
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
          <PanelHeader title="Lương so với doanh thu" subtitle="Lương, SVC & KPI, bảo hiểm trên nền doanh thu tháng — cùng bộ đường như file của chị Bình." />
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
