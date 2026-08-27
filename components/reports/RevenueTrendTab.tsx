"use client";

import React, { useCallback, useEffect, useState } from "react";
import { CHART_COLORS, MoneyBarChart, MoneyLineChart } from "@/components/charts/ReportCharts";
import { PanelHeader, money } from "@/components/reports/report-ui";

/**
 * Khối chart "So sánh doanh thu các tháng" (feedback chị Bình 26/08/2026 mục 5), gắn thêm
 * vào tab Biến động YoY: doanh thu kế hoạch vs thực hiện từng tháng, tỷ lệ thực hiện
 * luỹ kế và biến động cùng kỳ qua các năm. Tự fetch type=revenue-trend.
 */

type RevenueTrendData = {
  period: string;
  branchCode: string;
  year: string;
  plan: number[];
  series: Array<{ year: string; months: number[]; total: number }>;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export default function RevenueTrendTab({ period, branchCode }: { period: string; branchCode: string }) {
  const [data, setData] = useState<RevenueTrendData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ type: "revenue-trend", period, branchCode });
      const response = await fetch(`/api/reports?${params.toString()}`);
      if (response.ok) setData((await response.json()) as RevenueTrendData);
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
    return <p className="py-10 text-center text-sm text-slate-500 animate-pulse">Đang tổng hợp xu hướng doanh thu...</p>;
  }

  const currentSeries = data.series.find((series) => series.year === data.year);
  const actual = currentSeries?.months || Array.from({ length: 12 }, () => 0);
  const monthHeaders = actual.map((_, index) => `T${index + 1}`);
  // Luỹ kế tính đến tháng gần nhất có số thực hiện — để "Tỷ lệ thực hiện" không bị
  // kéo tụt bởi các tháng tương lai chưa diễn ra.
  const lastActualIndex = (() => {
    let last = -1;
    actual.forEach((value, index) => { if (Math.abs(value) > 0.5) last = index; });
    return last;
  })();
  const actualYtd = lastActualIndex >= 0 ? sum(actual.slice(0, lastActualIndex + 1)) : 0;
  const planYtd = lastActualIndex >= 0 ? sum(data.plan.slice(0, lastActualIndex + 1)) : 0;
  const planYear = sum(data.plan);
  const completion = planYtd > 0 ? (actualYtd / planYtd) * 100 : null;
  const hasPlan = planYear > 0;

  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-4 gap-4">
        <TrendKpi label={`DT kế hoạch ${data.year}`} value={`${money(Math.round(planYear))} đ`} icon="flag" tone="text-slate-800" />
        <TrendKpi label={`DT thực hiện luỹ kế${lastActualIndex >= 0 ? ` (đến T${lastActualIndex + 1})` : ""}`} value={`${money(Math.round(actualYtd))} đ`} icon="payments" tone="text-blue-600" />
        <TrendKpi label="Kế hoạch cùng luỹ kế" value={`${money(Math.round(planYtd))} đ`} icon="event" tone="text-slate-800" />
        <TrendKpi label="Tỷ lệ thực hiện" value={completion !== null ? `${completion.toFixed(1)}%` : "Chưa có KH"} icon="percent" tone={completion !== null && completion >= 100 ? "text-emerald-600" : "text-amber-600"} />
      </div>

      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <PanelHeader
          title={`Doanh thu ${data.year}: kế hoạch vs thực hiện`}
          subtitle={hasPlan ? "Kế hoạch lấy từ target Doanh thu của từng kỳ ở tab Ngân sách." : "Chưa set target Doanh thu cho các kỳ — vào tab Ngân sách để set kế hoạch từng tháng."}
        />
        <div className="p-4">
          <MoneyLineChart
            labels={monthHeaders}
            series={[
              { name: "DT kế hoạch", values: data.plan, color: "#2563eb", dashed: true },
              { name: "DT thực hiện", values: actual, color: "#f97316" },
            ]}
          />
        </div>
      </section>

      <div className="grid xl:grid-cols-2 gap-5">
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader
            title={`Tỷ lệ thực hiện đến ${data.period}`}
            subtitle="Cột trái: kế hoạch cả năm. Cột phải: thực hiện luỹ kế tới kỳ đang xem — đúng cách đọc trong file gốc."
          />
          <div className="p-4">
            <MoneyBarChart
              labels={[`Đến ${data.period}`]}
              series={[
                { name: "DT kế hoạch (cả năm)", values: [planYear], color: "#84cc16" },
                { name: "DT thực hiện (luỹ kế)", values: [actualYtd], color: "#f97316" },
              ]}
            />
            <p className="mt-2 text-center text-xs text-slate-500">
              Đạt <b className={planYear > 0 && actualYtd / planYear >= 0.6 ? "text-emerald-600" : "text-amber-600"}>{planYear > 0 ? `${((actualYtd / planYear) * 100).toFixed(1)}%` : "—"}</b> kế hoạch năm
              {completion !== null && <> · so cùng luỹ kế đạt <b>{completion.toFixed(1)}%</b></>}
            </p>
          </div>
        </section>
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Biến động doanh thu cùng kỳ qua các năm" subtitle="Mỗi đường một năm — nhìn ngay tháng nào lệch nhịp so với cùng kỳ." />
          <div className="p-4">
            <MoneyLineChart
              labels={monthHeaders}
              series={data.series.map((series, index) => ({
                name: `Năm ${series.year}`,
                values: series.months,
                color: series.year === data.year ? "#f97316" : CHART_COLORS[(index + 2) % CHART_COLORS.length],
              }))}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function TrendKpi({ label, value, icon, tone }: { label: string; value: string; icon: string; tone: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between text-slate-400">
        <span className="text-xs font-semibold text-slate-500">{label}</span>
        <span className="material-symbols-outlined text-xl">{icon}</span>
      </div>
      <p className={`text-xl font-bold mt-2 ${tone}`}>{value}</p>
    </div>
  );
}
