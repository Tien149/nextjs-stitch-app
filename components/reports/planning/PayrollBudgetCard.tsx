"use client";

import React, { useEffect, useState } from "react";
import { MoneyLineChart } from "@/components/charts/ReportCharts";
import { Card, fmtMoney } from "@/components/reports/planning/planning-ui";
import { sumMonths, type MonthPick } from "@/components/reports/planning/planning-types";

type DeptSeries = { code: string; name: string; months: number[]; total: number };
type PayrollBudgetPayload = {
  departments: Array<{ code: string; name: string }>;
  standard: { byDepartment: DeptSeries[]; total: number[] };
  actual: { byDepartment: DeptSeries[]; total: number[] };
};

const ALL = "ALL";

/**
 * "Chi phí lương so với ngân sách" theo từng phòng ban hoặc tất cả — học theo slide "Chi phí
 * lương người lao động" của chị Bình (28/09/2026): mỗi bộ phận một cặp đường ngân sách / thực tế.
 * Số lấy từ report type=payroll-budget (tab Ngân sách nhân sự) để hai nơi luôn cùng một số:
 * ngân sách = tỷ trọng bộ phận × doanh thu (gồm SVC), thực tế = import bảng lương.
 * Xem tất cả mà chưa set tỷ trọng bộ phận nào thì rơi về ngân sách lương set ở tab Ngân sách.
 */
export default function PayrollBudgetCard({ year, branchCode, labels, picked, fallbackBudget }: {
  year: string; branchCode: string; labels: string[]; picked: MonthPick; fallbackBudget: number[];
}) {
  const [data, setData] = useState<PayrollBudgetPayload | null>(null);
  const [error, setError] = useState("");
  const [department, setDepartment] = useState(ALL);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ type: "payroll-budget", period: `${year}-01`, branchCode });
    fetch(`/api/reports?${params.toString()}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok || !payload || !("standard" in payload)) {
          setError(payload?.error || "Không tải được số liệu lương theo bộ phận.");
          setData(null);
          return;
        }
        setError("");
        setData(payload as PayrollBudgetPayload);
      })
      .catch(() => { if (!cancelled) setError("Lỗi kết nối máy chủ khi tải số liệu lương."); });
    return () => { cancelled = true; };
  }, [year, branchCode]);

  const zeros = labels.map(() => 0);
  // Bộ phận có ngân sách hoặc có lương thực tế mới đưa vào ô chọn.
  const departmentOptions = (() => {
    if (!data) return [];
    const seen = new Map<string, string>();
    for (const row of [...data.standard.byDepartment, ...data.actual.byDepartment]) if (!seen.has(row.code)) seen.set(row.code, row.name);
    const order = new Map(data.departments.map((item, index) => [item.code, index]));
    return [...seen.entries()]
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => (order.get(a.code) ?? 999) - (order.get(b.code) ?? 999));
  })();
  const selected = department === ALL || departmentOptions.some((item) => item.code === department) ? department : ALL;
  const selectedName = selected === ALL ? "tất cả bộ phận" : departmentOptions.find((item) => item.code === selected)?.name || selected;

  const useFallback = selected === ALL && data !== null && !data.standard.total.some((value) => value > 0) && fallbackBudget.some((value) => value > 0);
  const budget = !data ? zeros
    : selected === ALL ? (useFallback ? fallbackBudget : data.standard.total)
      : data.standard.byDepartment.find((row) => row.code === selected)?.months || zeros;
  const actual = !data ? zeros
    : selected === ALL ? data.actual.total
      : data.actual.byDepartment.find((row) => row.code === selected)?.months || zeros;

  const pickedBudget = sumMonths(budget, picked);
  const pickedActual = sumMonths(actual, picked);
  const gap = pickedActual - pickedBudget;
  const label = selected === ALL ? "Lương" : `Lương ${selectedName}`;

  return (
    <Card
      title="Chi phí lương so với ngân sách"
      subtitle={useFallback
        ? "Chưa set tỷ trọng lương theo bộ phận — ngân sách lấy theo tab Ngân sách; thực tế từ import bảng lương."
        : "Ngân sách = tỷ trọng bộ phận × doanh thu (tab Ngân sách nhân sự); thực tế từ import bảng lương."}
      icon="show_chart"
      right={(
        <select className="control mt-0 text-xs w-40 py-1.5" value={selected} onChange={(event) => setDepartment(event.target.value)}>
          <option value={ALL}>Tất cả phòng ban</option>
          {departmentOptions.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
        </select>
      )}
      bodyClassName="px-2 pb-3"
    >
      {error ? (
        <p className="py-10 text-center text-sm text-rose-600">{error}</p>
      ) : !data ? (
        <p className="py-10 text-center text-sm text-slate-500 animate-pulse">Đang tải lương theo bộ phận...</p>
      ) : (
        <>
          <p className="px-2 pb-2 text-xs text-slate-600">
            Các tháng đang chọn ({selectedName}): thực tế <b>{fmtMoney(pickedActual)}</b> / ngân sách <b>{fmtMoney(pickedBudget)}</b>
            {pickedBudget > 0 && (
              <b className={gap > 0 ? "text-rose-600" : "text-emerald-600"}>
                {" · "}{gap > 0 ? "vượt" : "còn"} {fmtMoney(Math.abs(gap))} ({((Math.abs(gap) / pickedBudget) * 100).toFixed(2)}%)
              </b>
            )}
          </p>
          <MoneyLineChart
            labels={labels}
            series={[
              { name: `${label} (ngân sách)`, values: budget, color: "#2563eb", dashed: true },
              { name: `${label} (thực tế)`, values: actual, color: "#dc2626" },
            ]}
          />
        </>
      )}
    </Card>
  );
}
