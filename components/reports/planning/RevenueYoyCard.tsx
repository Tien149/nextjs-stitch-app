"use client";

import React, { useEffect, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { TrendLineChart } from "@/components/charts/ReportCharts";
import { Card } from "@/components/reports/planning/planning-ui";
import { money } from "@/components/reports/report-ui";

/**
 * "Biến động doanh thu thực hiện cùng kỳ qua các năm" trên Dashboard (khách 22/10/2026, sau khi
 * bổ sung số cũ ở màn Số liệu trước 08/2026): mỗi năm một đường + bảng tháng × năm, % năm sau so
 * với năm trước, dòng Cộng và DT trung bình. Số = dòng Doanh thu P&L (getRevenueTrendReport).
 */

type TrendData = { year: string; series: Array<{ year: string; months: number[]; total: number }> };

/** Năm cũ → mới: tím, đỏ, xanh lá như báo cáo mẫu của khách. */
const YEAR_COLORS = ["#7c3aed", "#dc2626", "#16a34a", "#2563eb", "#f97316"];

const pct = (current: number, previous: number) => (previous ? `${((current / previous) * 100).toFixed(2)}%` : "—");

export default function RevenueYoyCard({ year, branchCode }: { year: string; branchCode: string }) {
  const [data, setData] = useState<TrendData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ type: "revenue-trend", period: `${year}-01`, branchCode });
    fetch(`/api/reports?${params.toString()}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!alive) return;
        if (response.ok) { setData(payload as TrendData); setError(""); } else setError(payload.error || "Không tải được doanh thu các năm.");
      })
      .catch(() => { if (alive) setError("Lỗi kết nối máy chủ."); });
    return () => { alive = false; };
  }, [year, branchCode]);

  const series = data?.series || [];
  const current = series.find((row) => row.year === data?.year);
  // Năm đang xem chạy tới tháng nào thì so tới tháng đó (cùng kỳ); chưa có số thì hiện đủ 12 tháng.
  const lastMonth = (() => {
    let last = -1;
    current?.months.forEach((value, index) => { if (Math.abs(value) >= 0.5) last = index; });
    return last >= 0 ? last + 1 : 12;
  })();
  const monthIndexes = Array.from({ length: lastMonth }, (_, index) => index);
  const totals = series.map((row) => monthIndexes.reduce((sum, index) => sum + row.months[index], 0));
  const averages = totals.map((total) => total / lastMonth);

  const cell = "px-3 py-2 text-right whitespace-nowrap";
  const rowCells = (values: number[], className = "") => series.map((row, index) => (
    <React.Fragment key={row.year}>
      <td className={`${cell} ${className}`}>{values[index] ? money(Math.round(values[index])) : "-"}</td>
      {index > 0 && <td className={`${cell} ${className}`}>{values[index] && values[index - 1] ? pct(values[index], values[index - 1]) : "—"}</td>}
    </React.Fragment>
  ));

  return (
    <Card
      title={`Biến động doanh thu thực hiện ${storeLabel(branchCode)} cùng kỳ qua các năm`}
      subtitle={`Doanh thu P&L từng tháng (gồm số nhập tay trước 08/2026), T1–T${lastMonth} mỗi năm`}
      icon="show_chart"
      bodyClassName="px-4 pb-4 space-y-4"
    >
      {error && <p className="rounded-md bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{error}</p>}
      {!data && !error && <p className="py-8 text-center text-sm text-slate-400 animate-pulse">Đang tải doanh thu các năm...</p>}
      {data && (
        <>
          <TrendLineChart
            labels={monthIndexes.map((index) => `Tháng ${index + 1}`)}
            series={series.map((row, index) => ({
              name: `Năm ${row.year}`,
              // Tháng chưa có số: NaN để đường dừng lại chứ không rơi về 0.
              values: monthIndexes.map((month) => (Math.abs(row.months[month]) >= 0.5 ? row.months[month] : Number.NaN)),
              color: YEAR_COLORS[index % YEAR_COLORS.length],
            }))}
          />
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-amber-50/70 text-slate-700">
                <tr>
                  <th className="px-3 py-2 text-left font-bold">Tháng</th>
                  {series.map((row, index) => (
                    <React.Fragment key={row.year}>
                      <th className={`${cell} font-bold`}>Năm {row.year}</th>
                      {index > 0 && <th className={`${cell} font-bold`}>Năm {row.year} so với {series[index - 1].year}</th>}
                    </React.Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthIndexes.map((month) => (
                  <tr key={month} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-semibold text-slate-700">{String(month + 1).padStart(2, "0")}</td>
                    {rowCells(series.map((row) => row.months[month]), "text-slate-700")}
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-300 font-bold text-slate-900">
                  <td className="px-3 py-2">Cộng</td>
                  {rowCells(totals)}
                </tr>
                <tr className="border-t border-slate-100 font-bold text-sky-700">
                  <td className="px-3 py-2">DT trung bình</td>
                  {rowCells(averages)}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
