"use client";

import React, { useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { DonutLegendChart, MixedChart, MoneyLineChart, PercentLineChart, ShareDonutChart } from "@/components/charts/ReportCharts";
import { Card, MonthChips, NoPlanNotice, PlanActualCell, RateChip, Segmented, StatCard, Tag, fmtMoney, ratioOf, type Tone } from "@/components/reports/planning/planning-ui";
import { bucketOperatingCost, bucketSum, nodeValue, type PlanningData, type PnlBucket, type Series, type StatementLine } from "@/components/reports/planning/planning-types";

/**
 * Màn "Dashboard P&L" học theo phần mềm mẫu: chip lũy kế tháng, 6 thẻ KPI (số kế hoạch màu +
 * Thực đạt + % hoàn thành), chart Doanh thu & LN ròng KH/TT, chart % biên lợi nhuận, thanh
 * "cơ cấu 1 đồng doanh thu", ba donut cơ cấu, bảng hiệu quả theo cửa hàng. Cuối màn giữ
 * nguyên bộ chart theo file của chị Bình (tỷ trọng DT theo bộ phận/kênh, COGS và Lương so DT).
 */

const BRANCH_TONES: Tone[] = ["blue", "rose", "amber", "emerald", "violet", "teal", "orange", "sky"];
type Mode = "plan" | "actual";

function shareOf(line: StatementLine | undefined, upTo: number, mode: Mode) {
  if (!line) return [];
  const groups = line.groups;
  // Dòng chỉ có một nhóm thì bung hạng mục bên trong để donut có nhiều lát hơn.
  const nodes = groups.length === 1 && groups[0].items.length > 1 ? groups[0].items : groups;
  return nodes.map((node) => ({ name: node.name, value: nodeValue(node, upTo, mode) }));
}

export default function PnlDashboardTab({ data, upTo, onChangeUpTo }: { data: PlanningData; upTo: number; onChangeUpTo: (index: number) => void }) {
  const [mixMode, setMixMode] = useState<Mode>(data.hasPlan ? "plan" : "actual");
  const [opexMode, setOpexMode] = useState<Mode>("actual");
  const [pieMonth, setPieMonth] = useState<number>(-1);
  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const actual = (key: keyof PnlBucket) => bucketSum(data.totals, key, upTo);
  const plan = (key: keyof PnlBucket) => bucketSum(data.plans, key, upTo);
  const statementOf = (key: string) => data.statement.find((line) => line.key === key);

  const kpis: Array<{ label: string; tone: Tone; income: boolean; icon: string; actual: number; plan: number }> = [
    { label: "Doanh thu", tone: "blue", income: true, icon: "payments", actual: actual("revenue"), plan: plan("revenue") },
    { label: "Giá vốn (COGS)", tone: "amber", income: false, icon: "inventory_2", actual: actual("cogs"), plan: plan("cogs") },
    { label: "Lợi nhuận gộp", tone: "emerald", income: true, icon: "trending_up", actual: actual("grossProfit"), plan: plan("grossProfit") },
    { label: "Chi phí hoạt động", tone: "rose", income: false, icon: "receipt_long", actual: bucketOperatingCost(data.totals, upTo), plan: bucketOperatingCost(data.plans, upTo) },
    { label: "EBITDA", tone: "violet", income: true, icon: "monitoring", actual: actual("ebitda"), plan: plan("ebitda") },
    { label: "Lợi nhuận ròng", tone: "indigo", income: true, icon: "workspace_premium", actual: actual("netProfit"), plan: plan("netProfit") },
  ];

  const marginSeries = (key: "grossProfit" | "netProfit", buckets: PnlBucket[]) => buckets.map((bucket) => (bucket.revenue ? bucket[key] / bucket.revenue : 0));

  // Cơ cấu 1 đồng doanh thu (lũy kế): giá vốn / nhân sự / OPEX khác / khấu hao / phần còn lại là LN.
  const mixBuckets = mixMode === "plan" ? data.plans : data.totals;
  const mixRevenue = bucketSum(mixBuckets, "revenue", upTo);
  const mixParts: Array<{ label: string; value: number; color: string }> = [
    { label: "Giá vốn hàng bán", value: bucketSum(mixBuckets, "cogs", upTo), color: "#f59e0b" },
    { label: "Chi phí nhân sự", value: bucketSum(mixBuckets, "payroll", upTo), color: "#0ea5e9" },
    { label: "OPEX khác", value: bucketSum(mixBuckets, "otherOpex", upTo), color: "#2563eb" },
    { label: "Khấu hao", value: bucketSum(mixBuckets, "depreciation", upTo), color: "#94a3b8" },
    { label: "Lợi nhuận ròng", value: bucketSum(mixBuckets, "netProfit", upTo), color: "#10b981" },
  ];

  const pickAt = (values: number[]) => (pieMonth < 0 ? values.reduce((total, value) => total + value, 0) : values[pieMonth] || 0);
  const pickPie = (rows: Series[]) => [
    ...rows.map((row) => ({ name: row.name, value: pickAt(row.months) })),
    { name: "SVC", value: pickAt(data.revenueSplit.svc) },
    { name: "Thuế GTGT", value: pickAt(data.revenueSplit.vat) },
  ];

  const branchRows = data.byBranch.map((branch, index) => ({
    code: branch.code,
    tone: BRANCH_TONES[index % BRANCH_TONES.length],
    revenue: { plan: bucketSum(branch.plan, "revenue", upTo), actual: bucketSum(branch.actual, "revenue", upTo) },
    cogs: { plan: bucketSum(branch.plan, "cogs", upTo), actual: bucketSum(branch.actual, "cogs", upTo) },
    grossProfit: { plan: bucketSum(branch.plan, "grossProfit", upTo), actual: bucketSum(branch.actual, "grossProfit", upTo) },
    operating: { plan: bucketOperatingCost(branch.plan, upTo), actual: bucketOperatingCost(branch.actual, upTo) },
    netProfit: { plan: bucketSum(branch.plan, "netProfit", upTo), actual: bucketSum(branch.actual, "netProfit", upTo) },
  }));
  const totalRow = {
    revenue: { plan: plan("revenue"), actual: actual("revenue") },
    cogs: { plan: plan("cogs"), actual: actual("cogs") },
    grossProfit: { plan: plan("grossProfit"), actual: actual("grossProfit") },
    operating: { plan: bucketOperatingCost(data.plans, upTo), actual: bucketOperatingCost(data.totals, upTo) },
    netProfit: { plan: plan("netProfit"), actual: actual("netProfit") },
  };

  const donutCard = (title: string, subtitle: string, line: StatementLine | undefined, mode: Mode, onMode?: (mode: Mode) => void) => (
    <Card
      title={title}
      subtitle={subtitle}
      icon="donut_small"
      right={onMode && <Segmented value={mode} onChange={onMode} options={[{ id: "plan", label: "Kế hoạch" }, { id: "actual", label: "Thực tế" }]} />}
      bodyClassName="px-4 pb-4"
    >
      <DonutLegendChart data={shareOf(line, upTo, mode)} />
    </Card>
  );

  return (
    <div className="space-y-4">
      {!data.hasPlan && <NoPlanNotice year={data.year} />}
      <MonthChips upTo={upTo} onChange={onChangeUpTo} />

      {/* Sáu thẻ KPI mang số tiền hàng tỷ: chỉ xếp 6 cột khi màn đủ rộng, còn lại 2-3 cột cho
          thẻ rộng ra để số hiện đủ chữ số thay vì bị cắt. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3">
        {kpis.map((kpi) => {
          const rate = data.hasPlan ? ratioOf(kpi.actual, kpi.plan) : null;
          return (
            <StatCard
              key={kpi.label}
              label={kpi.label}
              tone={kpi.tone}
              icon={kpi.icon}
              value={fmtMoney(data.hasPlan ? kpi.plan : kpi.actual)}
              sub={data.hasPlan ? `Thực đạt: ${fmtMoney(kpi.actual)}` : "Thực tế lũy kế (chưa có KH)"}
              rate={rate}
              rateGood={rate === null ? null : kpi.income ? rate >= 1 : rate <= 1}
              hint={data.hasPlan ? `Kế hoạch ${fmtMoney(kpi.plan)} · Thực đạt ${fmtMoney(kpi.actual)}` : undefined}
            />
          );
        })}
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="So sánh Doanh thu & Lợi nhuận ròng" subtitle="Xu hướng kế hoạch và thực tế từng tháng (cả năm)" icon="bar_chart" bodyClassName="px-2 pb-3">
          <MixedChart
            labels={monthHeaders}
            bars={[
              { name: "Doanh thu KH", values: data.plans.map((bucket) => bucket.revenue), color: "#c7d2fe" },
              { name: "Doanh thu TT", values: data.totals.map((bucket) => bucket.revenue), color: "#4f46e5" },
            ]}
            lines={[
              { name: "LN ròng KH", values: data.plans.map((bucket) => bucket.netProfit), color: "#6ee7b7", dashed: true },
              { name: "LN ròng TT", values: data.totals.map((bucket) => bucket.netProfit), color: "#059669" },
            ]}
          />
        </Card>
        <Card title="Chỉ số hiệu quả lợi nhuận (% biên LN)" subtitle="Biên lợi nhuận gộp và ròng — kế hoạch nét đứt, thực tế nét liền" icon="percent" bodyClassName="px-2 pb-3">
          <PercentLineChart
            labels={monthHeaders}
            series={[
              { name: "% biên LN gộp KH", values: marginSeries("grossProfit", data.plans), color: "#6ee7b7", dashed: true },
              { name: "% biên LN gộp TT", values: marginSeries("grossProfit", data.totals), color: "#059669" },
              { name: "% biên LN ròng KH", values: marginSeries("netProfit", data.plans), color: "#93c5fd", dashed: true },
              { name: "% biên LN ròng TT", values: marginSeries("netProfit", data.totals), color: "#2563eb" },
            ]}
          />
        </Card>
      </div>

      <Card
        title="Cơ cấu 1 đồng doanh thu"
        subtitle={`Lũy kế ${upTo + 1} tháng — mỗi 100 đồng doanh thu chia cho giá vốn, nhân sự, OPEX, khấu hao và phần còn lại là lợi nhuận`}
        icon="stacked_bar_chart"
        right={<Segmented value={mixMode} onChange={setMixMode} options={[{ id: "plan", label: "Theo kế hoạch" }, { id: "actual", label: "Theo thực tế" }]} />}
        bodyClassName="px-4 pb-4"
      >
        {mixRevenue > 0 ? (
          <>
            <div className="flex h-9 w-full overflow-hidden rounded-lg bg-slate-100">
              {mixParts.map((part) => {
                const share = Math.max(0, part.value / mixRevenue) * 100;
                return share > 0.2 ? (
                  <div key={part.label} className="h-full flex items-center justify-center text-[11px] font-bold text-white whitespace-nowrap overflow-hidden" style={{ width: `${Math.min(100, share)}%`, background: part.color }} title={`${part.label}: ${fmtMoney(part.value)} (${share.toFixed(1)}%)`}>
                    {share >= 6 ? `${share.toFixed(1)}%` : ""}
                  </div>
                ) : null;
              })}
            </div>
            <div className="mt-2 flex justify-between text-[10px] text-slate-400">{Array.from({ length: 11 }, (_, index) => <span key={index}>{index * 10}%</span>)}</div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
              {mixParts.map((part) => (
                <span key={part.label} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: part.color }} />{part.label}: <b>{((part.value / mixRevenue) * 100).toFixed(1)}%</b></span>
              ))}
              {mixParts[4].value < 0 && <span className="text-rose-600 font-semibold">Lợi nhuận âm — chi phí đang vượt doanh thu.</span>}
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">Chưa có doanh thu {mixMode === "plan" ? "kế hoạch" : "thực tế"} trong khoảng lũy kế này.</p>
        )}
      </Card>

      <div className="grid md:grid-cols-3 gap-4">
        {donutCard("Cơ cấu doanh thu", "Theo nguồn thu (lũy kế)", statementOf("revenue"), "actual")}
        {donutCard("Cơ cấu giá vốn", "Theo nhóm/hạng mục giá vốn (lũy kế)", statementOf("cogs"), "actual")}
        {donutCard("Cơ cấu chi phí hoạt động (OPEX)", "Theo nhóm OPEX — chọn kế hoạch hoặc thực tế", statementOf("otherOpex"), opexMode, setOpexMode)}
      </div>

      <Card title="Phân tích hiệu quả theo cửa hàng" subtitle={`Doanh thu, chi phí, lợi nhuận từng cửa hàng — kế hoạch đậm, thực đạt chip màu (lũy kế ${upTo + 1} tháng)`} icon="storefront" bodyClassName="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="px-4 py-3 font-bold">Cửa hàng</th>
              {["Doanh thu", "Giá vốn (COGS)", "Lợi nhuận gộp", "Chi phí hoạt động", "Lợi nhuận ròng"].map((header) => <th key={header} className="px-3 py-3 font-bold text-right whitespace-nowrap">{header}</th>)}
              <th className="px-3 py-3 font-bold text-right whitespace-nowrap">% Hoàn thành KH<br /><span className="normal-case font-normal text-[10px]">Doanh thu TT / KH</span></th>
            </tr>
          </thead>
          <tbody>
            {branchRows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">Chưa có dữ liệu ghi sổ.</td></tr>}
            {branchRows.map((row) => {
              const rate = ratioOf(row.revenue.actual, row.revenue.plan);
              return (
                <tr key={row.code} className="border-t border-slate-100">
                  <td className="px-4 py-2.5"><Tag tone={row.tone} className="text-[11px]">{storeLabel(row.code)}</Tag></td>
                  <td className="px-3 py-2.5"><PlanActualCell plan={row.revenue.plan} actual={row.revenue.actual} income /></td>
                  <td className="px-3 py-2.5"><PlanActualCell plan={row.cogs.plan} actual={row.cogs.actual} income={false} /></td>
                  <td className="px-3 py-2.5"><PlanActualCell plan={row.grossProfit.plan} actual={row.grossProfit.actual} income /></td>
                  <td className="px-3 py-2.5"><PlanActualCell plan={row.operating.plan} actual={row.operating.actual} income={false} /></td>
                  <td className="px-3 py-2.5"><PlanActualCell plan={row.netProfit.plan} actual={row.netProfit.actual} income /></td>
                  <td className="px-3 py-2.5 text-right">
                    <RateChip rate={rate} good={rate === null ? null : rate >= 1} />
                    <div className="mt-1 h-1.5 w-28 ml-auto rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${rate !== null && rate >= 1 ? "bg-emerald-500" : "bg-amber-400"}`} style={{ width: `${Math.min(100, (rate || 0) * 100)}%` }} /></div>
                  </td>
                </tr>
              );
            })}
            {branchRows.length > 0 && (
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                <td className="px-4 py-2.5 text-[12px] uppercase tracking-wide text-slate-600">Tổng cộng</td>
                <td className="px-3 py-2.5"><PlanActualCell plan={totalRow.revenue.plan} actual={totalRow.revenue.actual} income /></td>
                <td className="px-3 py-2.5"><PlanActualCell plan={totalRow.cogs.plan} actual={totalRow.cogs.actual} income={false} /></td>
                <td className="px-3 py-2.5"><PlanActualCell plan={totalRow.grossProfit.plan} actual={totalRow.grossProfit.actual} income /></td>
                <td className="px-3 py-2.5"><PlanActualCell plan={totalRow.operating.plan} actual={totalRow.operating.actual} income={false} /></td>
                <td className="px-3 py-2.5"><PlanActualCell plan={totalRow.netProfit.plan} actual={totalRow.netProfit.actual} income /></td>
                <td className="px-3 py-2.5 text-right"><RateChip rate={ratioOf(totalRow.revenue.actual, totalRow.revenue.plan)} good={null} /></td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Bộ chart theo file của chị Bình (feedback 26/08/2026) — giữ nguyên, chuyển từ bảng 12 tháng sang đây. */}
      <div className="grid xl:grid-cols-2 gap-4">
        <Card
          title="Doanh thu theo tỷ trọng bộ phận"
          subtitle="Doanh thu thuần tách theo Bếp/Bar/FOH, cộng SVC và thuế GTGT thành 100% tiền khách trả."
          icon="pie_chart"
          right={(
            <select className="control mt-0 text-xs w-32 py-1.5" value={pieMonth} onChange={(event) => setPieMonth(Number(event.target.value))}>
              <option value={-1}>Cả năm</option>
              {monthHeaders.map((header, index) => <option key={header} value={index}>Tháng {index + 1}</option>)}
            </select>
          )}
          bodyClassName="px-2 pb-3"
        >
          <ShareDonutChart data={pickPie(data.revenueSplit.byDepartment)} />
        </Card>
        <Card title="Doanh thu theo tỷ trọng phân bổ theo nguồn" subtitle="Cùng số tiền đó nhưng tách theo kênh bán (Tại chỗ, Grab...), kèm SVC và thuế GTGT." icon="pie_chart" bodyClassName="px-2 pb-3">
          <ShareDonutChart data={pickPie(data.revenueSplit.byChannel)} />
        </Card>
      </div>
      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="COGS so với doanh thu" subtitle="Giá vốn từng bộ phận và tổng, đặt cạnh doanh thu từng bộ phận và tổng doanh thu." icon="show_chart" bodyClassName="px-2 pb-3">
          <MoneyLineChart
            labels={monthHeaders}
            series={[
              ...data.cogsByDepartment.slice(0, 3).map((row) => ({ name: `COGS ${row.name}`, values: row.months })),
              { name: "Tổng COGS", values: data.totals.map((total) => total.cogs) },
              ...data.revenueSplit.byDepartment.slice(0, 3).map((row) => ({ name: row.name, values: row.months })),
              { name: "Doanh thu", values: data.totals.map((total) => total.revenue), color: "#84cc16" },
              ...(data.budgets.cogs.some((value) => value > 0) ? [{ name: "Ngân sách COGS", values: data.budgets.cogs, color: "#94a3b8", dashed: true }] : []),
            ]}
          />
        </Card>
        <Card title="Lương so với doanh thu" subtitle="Lương, SVC & KPI, bảo hiểm trên nền doanh thu tháng — cùng bộ đường như file của chị Bình." icon="show_chart" bodyClassName="px-2 pb-3">
          <MoneyLineChart
            labels={monthHeaders}
            series={[
              { name: "Lương", values: data.totals.map((total) => total.payroll) },
              // SVC thu được thường chia lại cho nhân viên nên gộp chung với thưởng KPI thành một đường.
              { name: "SVC & KPI", values: data.revenueSplit.svc.map((value, index) => value + (data.payrollSplit.bonus[index] || 0)) },
              { name: "Bảo hiểm", values: data.payrollSplit.insurance },
              { name: "Doanh thu", values: data.totals.map((total) => total.revenue), color: "#84cc16" },
              ...(data.budgets.payroll.some((value) => value > 0) ? [{ name: "Ngân sách lương", values: data.budgets.payroll, color: "#94a3b8", dashed: true }] : []),
            ]}
          />
        </Card>
      </div>
      <p className="text-[11px] text-slate-400 px-1">Chi phí hoạt động = nhân sự + OPEX khác + khấu hao. Số lũy kế theo chip tháng ở trên; hai chart xu hướng luôn vẽ đủ 12 tháng.</p>
    </div>
  );
}
