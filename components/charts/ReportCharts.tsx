"use client";

import React from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Bộ chart dùng chung cho các báo cáo so sánh ngân sách/thực tế (feedback chị Bình
 * 26/08/2026). Mọi chart nhận series dạng mảng số thẳng hàng với labels — component
 * tự ghép thành shape của recharts để trang báo cáo không phải lặp lại việc đó.
 */

export const CHART_COLORS = ["#2563eb", "#f97316", "#10b981", "#f59e0b", "#8b5cf6", "#f43f5e", "#0ea5e9", "#94a3b8", "#84cc16", "#d946ef"];

const fullVnd = (value: number) => `${new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value)} đ`;

/** 1.932.735.673 -> "1,93 tỷ"; 845.941.929 -> "846 tr" — cho trục tiền đỡ chật. */
export function compactVnd(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} tỷ`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 0 })} tr`;
  if (absolute >= 1_000) return `${(value / 1_000).toLocaleString("vi-VN", { maximumFractionDigits: 0 })} k`;
  return value.toLocaleString("vi-VN", { maximumFractionDigits: 0 });
}

export type ChartSeries = { name: string; values: number[]; color?: string; /** Nét đứt — dùng cho đường ngân sách/kế hoạch. */ dashed?: boolean };

function toRows(labels: string[], series: ChartSeries[]) {
  return labels.map((label, index) => {
    const row: Record<string, number | string> = { label };
    for (const item of series) row[item.name] = Math.round(item.values[index] || 0);
    return row;
  });
}

const tooltipProps = {
  formatter: (value: unknown) => fullVnd(Number(value ?? 0)),
  contentStyle: { fontSize: 12, borderRadius: 8, borderColor: "#e2e8f0" },
} as const;

const axisProps = {
  tick: { fontSize: 11, fill: "#64748b" },
  axisLine: { stroke: "#e2e8f0" },
  tickLine: false as const,
};

/** Line nhiều series — dùng cho xu hướng lương/COGS/doanh thu qua các tháng. */
export function MoneyLineChart({ labels, series, height = 280, countMode = false }: { labels: string[]; series: ChartSeries[]; height?: number; countMode?: boolean }) {
  const rows = toRows(labels, series);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} width={56} tickFormatter={(value: number) => (countMode ? String(value) : compactVnd(value))} />
        <Tooltip
          formatter={(value: unknown) => (countMode ? `${Number(value ?? 0)} người` : fullVnd(Number(value ?? 0)))}
          contentStyle={tooltipProps.contentStyle}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((item, index) => (
          <Line key={item.name} type="monotone" dataKey={item.name} stroke={item.color || CHART_COLORS[index % CHART_COLORS.length]} strokeWidth={2} strokeDasharray={item.dashed ? "6 4" : undefined} dot={{ r: 3 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Bar thực tế + line ngân sách/kế hoạch — chart so sánh chính của feedback. */
export function PlanActualComboChart({ labels, planName, actualName, plan, actual, height = 280 }: { labels: string[]; planName: string; actualName: string; plan: number[]; actual: number[]; height?: number }) {
  const rows = toRows(labels, [
    { name: actualName, values: actual },
    { name: planName, values: plan },
  ]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} width={56} tickFormatter={(value: number) => compactVnd(value)} />
        <Tooltip {...tooltipProps} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey={actualName} fill="#2563eb" radius={[3, 3, 0, 0]} maxBarSize={28} />
        <Line type="monotone" dataKey={planName} stroke="#f97316" strokeWidth={2} dot={{ r: 3 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Bar nhiều series đứng cạnh nhau — so kế hoạch/thực hiện luỹ kế. */
export function MoneyBarChart({ labels, series, height = 280 }: { labels: string[]; series: ChartSeries[]; height?: number }) {
  const rows = toRows(labels, series);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
        <XAxis dataKey="label" {...axisProps} />
        <YAxis {...axisProps} width={56} tickFormatter={(value: number) => compactVnd(value)} />
        <Tooltip {...tooltipProps} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {series.map((item, index) => (
          <Bar key={item.name} dataKey={item.name} fill={item.color || CHART_COLORS[index % CHART_COLORS.length]} radius={[3, 3, 0, 0]} maxBarSize={28} />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Donut tỷ trọng kèm % trên từng lát — pie doanh thu theo bộ phận / theo nguồn. */
export function ShareDonutChart({ data, height = 280 }: { data: Array<{ name: string; value: number }>; height?: number }) {
  const alive = data.filter((item) => Math.abs(item.value) > 0.5);
  const total = alive.reduce((sum, item) => sum + item.value, 0);
  if (alive.length === 0 || total <= 0) {
    return <p className="py-10 text-center text-sm text-slate-400">Chưa có dữ liệu để vẽ tỷ trọng.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={alive}
          dataKey="value"
          nameKey="name"
          innerRadius="45%"
          outerRadius="72%"
          paddingAngle={1}
          label={(props: { name?: string; percent?: number }) => `${props.name} ${((props.percent || 0) * 100).toFixed(1)}%`}
          labelLine={{ stroke: "#cbd5e1" }}
          fontSize={11}
        >
          {alive.map((item, index) => (
            <Cell key={item.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip {...tooltipProps} />
      </PieChart>
    </ResponsiveContainer>
  );
}
