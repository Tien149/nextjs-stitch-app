"use client";

import React from "react";
import { TrendLineChart } from "@/components/charts/ReportCharts";
import { Card } from "@/components/reports/planning/planning-ui";
import PnlNoteBox from "@/components/reports/planning/PnlNoteBox";
import { lastPicked, type MonthPick, type PlanningData } from "@/components/reports/planning/planning-types";

/**
 * "Biến động Doanh thu – Chi phí – Lợi nhuận – EBITDA" — gộp hai chart cũ (Doanh thu & LN, %
 * biên LN) thành một theo slide mẫu của khách (28/09/2026), kèm ô ghi chú nhận định từng tháng.
 *
 * Báo cáo quản trị nội bộ, không theo mẫu thuế:
 *  - Tổng chi phí = COGS + CAPEX + OPEX (nhân sự + chi phí hoạt động, đã gồm khấu hao).
 *  - Lợi nhuận = Lợi nhuận vận hành (netProfit).
 *  - EBITDA = LN gộp − nhân sự − CAPEX − OPEX + khấu hao, trước thu nhập/chi phí khác (dòng 7
 *    KQKD, chốt 28/09/2026).
 * Chỉ vẽ đường, nối thẳng — khách không muốn cột lẫn đường uốn cong.
 */
export default function PnlTrendCard({ data, picked, monthHeaders, canEdit = true }: {
  data: PlanningData;
  picked: MonthPick;
  monthHeaders: string[];
  canEdit?: boolean;
}) {
  // Tháng chưa phát sinh gì thì bỏ trống điểm (NaN) để đường dừng ở tháng cuối có số.
  const active = data.totals.map((bucket) => Math.abs(bucket.revenue) + Math.abs(bucket.cogs + bucket.payroll + bucket.otherOpex + bucket.capex) > 0.5);
  const series = (pick: (index: number) => number) => data.totals.map((_, index) => (active[index] ? pick(index) : Number.NaN));
  const totalCost = series((index) => {
    const bucket = data.totals[index];
    return bucket.cogs + bucket.capex + bucket.payroll + bucket.otherOpex;
  });

  const defaultMonth = (() => {
    const last = lastPicked(picked);
    if (last >= 0) return last;
    const lastActive = active.lastIndexOf(true);
    return lastActive >= 0 ? lastActive : new Date().getMonth();
  })();
  return (
    <Card
      title={`Biến động Doanh thu – Chi phí – Lợi nhuận – EBITDA năm ${data.year}`}
      subtitle="Báo cáo quản trị nội bộ: Tổng chi phí = COGS + CAPEX + OPEX (gồm nhân sự); Lợi nhuận = LN vận hành; EBITDA = LN gộp − nhân sự − CAPEX − OPEX + khấu hao (chưa tính thu nhập/chi phí khác)."
      icon="show_chart"
      bodyClassName="px-2 pb-3"
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="min-w-0">
          <TrendLineChart
            labels={monthHeaders}
            series={[
              { name: "Doanh thu", values: series((index) => data.totals[index].revenue), color: "#16a34a" },
              { name: "Tổng chi phí", values: totalCost, color: "#b91c1c" },
              { name: "Lợi nhuận", values: series((index) => data.totals[index].netProfit), color: "#2563eb" },
              { name: "EBITDA", values: series((index) => data.totals[index].ebitda), color: "#a21caf" },
            ]}
          />
        </div>
        <PnlNoteBox
          kind="DASHBOARD"
          year={data.year}
          branchCode={data.branchCode}
          months={data.months}
          monthHeaders={monthHeaders}
          defaultMonth={defaultMonth}
          canEdit={canEdit}
          className="mx-2 xl:mx-0 xl:mr-2"
          placeholder={(month) => `Nhận định tháng ${month + 1}: doanh thu so chỉ tiêu, lợi nhuận tăng/giảm vì đâu (COGS, lương, marketing, chi phí biến đổi...)`}
        />
      </div>
    </Card>
  );
}
