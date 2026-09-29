"use client";

import React, { useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { opexGroupRank } from "@/lib/pnl-ordering";
import { DonutLegendChart, MoneyLineChart, ShareDonutChart } from "@/components/charts/ReportCharts";
import OpexCategoryCard from "@/components/reports/planning/OpexCategoryCard";
import PayrollBudgetCard from "@/components/reports/planning/PayrollBudgetCard";
import PnlTrendCard from "@/components/reports/planning/PnlTrendCard";
import { Card, MonthChips, NoPlanNotice, PlanActualCell, RateChip, Segmented, StatCard, Tag, fmtMoney, ratioOf, type Tone } from "@/components/reports/planning/planning-ui";
import { bucketOperatingCost, bucketSum, monthPickSummary, nodeValue, type MonthPick, type PlanningData, type PnlBucket, type Series, type StatementLine } from "@/components/reports/planning/planning-types";

/**
 * Màn "Dashboard P&L" học theo phần mềm mẫu: chip lũy kế tháng, 9 thẻ KPI (số THỰC ĐẠT in to +
 * kế hoạch dòng phụ + % hoàn thành), chart biến động Doanh thu – Chi phí – LN – EBITDA kèm ghi chú tháng, thanh
 * "cơ cấu 1 đồng doanh thu", ba donut cơ cấu, bảng hiệu quả theo cửa hàng. Cuối màn giữ
 * nguyên bộ chart theo file của chị Bình (tỷ trọng DT theo bộ phận/kênh, COGS so DT, lương so ngân sách theo bộ phận).
 */

const BRANCH_TONES: Tone[] = ["blue", "rose", "amber", "emerald", "violet", "teal", "orange", "sky"];
/** Màu từng nhóm OPEX trên thanh "Cơ cấu 1 đồng doanh thu" — theo thứ tự nhóm của bảng P&L. */
const OPEX_GROUP_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#0d9488", "#4f46e5", "#c026d3"];
type Mode = "plan" | "actual";
/** Hai cách xem cơ cấu doanh thu (spec khách 07/09/2026): theo nhóm doanh thu, hoặc theo kênh bán. */
type RevenueView = "group" | "channel";
/** Chart COGS so với doanh thu (khách yêu cầu 28/09/2026): xem tổng, riêng bếp hoặc riêng bar. */
type CogsView = "total" | "kitchen" | "bar";

/** Bộ phận Bếp / Bar của một dòng theo mã (KIT/BAR) hoặc tên ("Team Bếp", "DT Team Bar"). */
function departmentKind(row: { code: string; name: string }): "kitchen" | "bar" | null {
  const text = `${row.code} ${row.name}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toUpperCase();
  if (/\bKIT\b|BEP|KITCHEN/.test(text)) return "kitchen";
  if (/\bBAR\b/.test(text)) return "bar";
  return null;
}
/** Cộng các dòng thuộc cùng một bộ phận thành một đường 12 tháng. */
function departmentMonths(rows: Array<{ code: string; name: string; months: number[] }>, kind: "kitchen" | "bar", length: number) {
  return Array.from({ length }, (_, index) => rows
    .filter((row) => departmentKind(row) === kind)
    .reduce((sum, row) => sum + (row.months[index] || 0), 0));
}

function shareOf(line: StatementLine | undefined, picked: MonthPick, mode: Mode) {
  if (!line) return [];
  const groups = line.groups;
  // Dòng chỉ có một nhóm thì bung hạng mục bên trong để donut có nhiều lát hơn.
  const nodes = groups.length === 1 && groups[0].items.length > 1 ? groups[0].items : groups;
  return nodes.map((node) => ({ name: node.name, value: nodeValue(node, picked, mode) }));
}

export default function PnlDashboardTab({ data, picked, onChangePicked }: { data: PlanningData; picked: MonthPick; onChangePicked: (picked: MonthPick) => void }) {
  const [mixMode, setMixMode] = useState<Mode>(data.hasPlan ? "plan" : "actual");
  const [opexMode, setOpexMode] = useState<Mode>("actual");
  const [revenueView, setRevenueView] = useState<RevenueView>("group");
  const [cogsView, setCogsView] = useState<CogsView>("total");
  const [pieMonth, setPieMonth] = useState<number>(-1);
  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const actual = (key: keyof PnlBucket) => bucketSum(data.totals, key, picked);
  const plan = (key: keyof PnlBucket) => bucketSum(data.plans, key, picked);
  const statementOf = (key: string) => data.statement.find((line) => line.key === key);

  // Chi phí hoạt động tách theo nhóm OPEX (nét vẽ khách 28/09/2026) — nhận nhóm theo tên, cùng
  // luật sắp xếp bảng P&L (lib/pnl-ordering). Nhóm khác + chứng từ chưa gắn nhóm dồn vào Chi phí
  // cố định (giống màn Điểm hòa vốn) để CAPEX + bốn thẻ chi phí vẫn cộng đúng chi phí hoạt động cũ.
  const opexGroups = statementOf("otherOpex")?.groups || [];
  const opexRankSum = (rank: number, mode: Mode) =>
    opexGroups.filter((group) => opexGroupRank(group.name) === rank).reduce((sum, group) => sum + nodeValue(group, picked, mode), 0);
  const marketingCost = { actual: opexRankSum(1, "actual"), plan: opexRankSum(1, "plan") };
  const variableCost = { actual: opexRankSum(2, "actual"), plan: opexRankSum(2, "plan") };
  const fixedCost = {
    actual: actual("otherOpex") - marketingCost.actual - variableCost.actual,
    plan: plan("otherOpex") - marketingCost.plan - variableCost.plan,
  };
  const kpis: Array<{ label: string; tone: Tone; income: boolean; icon: string; actual: number; plan: number; note?: string }> = [
    { label: "Doanh thu", tone: "blue", income: true, icon: "payments", actual: actual("revenue"), plan: plan("revenue") },
    { label: "Giá vốn (COGS)", tone: "amber", income: false, icon: "inventory_2", actual: actual("cogs"), plan: plan("cogs") },
    { label: "CAPEX", tone: "slate", income: false, icon: "construction", actual: actual("capex"), plan: plan("capex") },
    { label: "CP nhân sự", tone: "sky", income: false, icon: "groups", actual: actual("payroll"), plan: plan("payroll") },
    { label: "CP cố định", tone: "rose", income: false, icon: "home_work", actual: fixedCost.actual, plan: fixedCost.plan, note: "Gồm cả nhóm OPEX khác và chi phí chưa gắn nhóm" },
    { label: "CP Marketing", tone: "orange", income: false, icon: "campaign", actual: marketingCost.actual, plan: marketingCost.plan },
    { label: "CP biến đổi", tone: "teal", income: false, icon: "swap_vert", actual: variableCost.actual, plan: variableCost.plan },
    { label: "Lợi nhuận vận hành", tone: "indigo", income: true, icon: "workspace_premium", actual: actual("netProfit"), plan: plan("netProfit") },
    { label: "EBITDA", tone: "violet", income: true, icon: "monitoring", actual: actual("ebitda"), plan: plan("ebitda"), note: "LN gộp − nhân sự − CAPEX − OPEX + khấu hao (trước thu nhập/chi phí khác), cùng số dòng 7 KQKD" },
  ];

  // Cơ cấu 1 đồng doanh thu (lũy kế): giá vốn / nhân sự / CAPEX / OPEX / phần còn lại là LN.
  // OPEX tách đúng theo các NHÓM dưới dòng Chi phí hoạt động của bảng P&L, cùng thứ tự (khách
  // yêu cầu 29/09/2026) — khấu hao nằm trong nhóm Chi phí cố định như trên P&L. Phần OPEX không
  // rơi vào nhóm nào (kế hoạch set thẳng vào dòng, dữ liệu cũ) đứng riêng để thanh vẫn cộng đủ.
  const mixBuckets = mixMode === "plan" ? data.plans : data.totals;
  const mixRevenue = bucketSum(mixBuckets, "revenue", picked);
  const mixOpexTotal = bucketSum(mixBuckets, "otherOpex", picked);
  const mixOpexGroups = opexGroups
    .map((group, index) => ({ label: group.name, value: nodeValue(group, picked, mixMode), color: OPEX_GROUP_COLORS[index % OPEX_GROUP_COLORS.length] }))
    .filter((part) => Math.abs(part.value) > 0.5);
  const mixOpexRest = mixOpexTotal - mixOpexGroups.reduce((sum, part) => sum + part.value, 0);
  const mixCapex = bucketSum(mixBuckets, "capex", picked);
  const mixParts: Array<{ label: string; value: number; color: string }> = [
    { label: "Giá vốn hàng bán", value: bucketSum(mixBuckets, "cogs", picked), color: "#f59e0b" },
    { label: "Chi phí nhân sự", value: bucketSum(mixBuckets, "payroll", picked), color: "#0ea5e9" },
    ...(Math.abs(mixCapex) > 0.5 ? [{ label: "CAPEX", value: mixCapex, color: "#64748b" }] : []),
    ...mixOpexGroups,
    ...(Math.abs(mixOpexRest) > 0.5 ? [{ label: "OPEX chưa gắn nhóm", value: mixOpexRest, color: "#94a3b8" }] : []),
    { label: "Lợi nhuận vận hành", value: bucketSum(mixBuckets, "netProfit", picked), color: "#10b981" },
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
    revenue: { plan: bucketSum(branch.plan, "revenue", picked), actual: bucketSum(branch.actual, "revenue", picked) },
    cogs: { plan: bucketSum(branch.plan, "cogs", picked), actual: bucketSum(branch.actual, "cogs", picked) },
    grossProfit: { plan: bucketSum(branch.plan, "grossProfit", picked), actual: bucketSum(branch.actual, "grossProfit", picked) },
    operating: { plan: bucketOperatingCost(branch.plan, picked), actual: bucketOperatingCost(branch.actual, picked) },
    netProfit: { plan: bucketSum(branch.plan, "netProfit", picked), actual: bucketSum(branch.actual, "netProfit", picked) },
  }));
  const totalRow = {
    revenue: { plan: plan("revenue"), actual: actual("revenue") },
    cogs: { plan: plan("cogs"), actual: actual("cogs") },
    grossProfit: { plan: plan("grossProfit"), actual: actual("grossProfit") },
    operating: { plan: bucketOperatingCost(data.plans, picked), actual: bucketOperatingCost(data.totals, picked) },
    netProfit: { plan: plan("netProfit"), actual: actual("netProfit") },
  };

  /**
   * Cơ cấu doanh thu xem được theo hai cách (spec khách 07/09/2026):
   *  - Nhóm doanh thu: DT bếp / DT bar / DT phụ thu / SVC / Thuế GTGT — chính là các nhóm dưới
   *    dòng Doanh thu của P&L.
   *  - Kênh bán: Tại chỗ / Mang về / Giao hàng qua app — gộp hạng mục P&L của mọi nhóm lại.
   * Phần doanh thu chưa gắn kênh bán được tách riêng để hai cách xem luôn cộng ra cùng một tổng.
   */
  const revenueShare = () => {
    const groups = statementOf("revenue")?.groups || [];
    if (revenueView === "group") return groups.map((group) => ({ name: group.name, value: nodeValue(group, picked, "actual") }));
    const byChannel = new Map<string, { name: string; value: number }>();
    let unknown = 0;
    for (const group of groups) {
      let covered = 0;
      for (const item of group.items) {
        const value = nodeValue(item, picked, "actual");
        covered += value;
        const current = byChannel.get(item.code) || { name: item.name, value: 0 };
        current.value += value;
        byChannel.set(item.code, current);
      }
      unknown += nodeValue(group, picked, "actual") - covered;
    }
    const rows = Array.from(byChannel.values());
    if (Math.abs(unknown) > 0.5) rows.push({ name: "Chưa rõ kênh bán", value: unknown });
    return rows;
  };

  const donutCard = (title: string, subtitle: string, line: StatementLine | undefined, mode: Mode, onMode?: (mode: Mode) => void) => (
    <Card
      title={title}
      subtitle={subtitle}
      icon="donut_small"
      right={onMode && <Segmented value={mode} onChange={onMode} options={[{ id: "plan", label: "Kế hoạch" }, { id: "actual", label: "Thực tế" }]} />}
      bodyClassName="px-4 pb-4"
    >
      <DonutLegendChart data={shareOf(line, picked, mode)} />
    </Card>
  );

  return (
    <div className="space-y-4">
      {!data.hasPlan && <NoPlanNotice year={data.year} />}
      <MonthChips picked={picked} onChange={onChangePicked} />

      {/* Chín thẻ KPI mang số tiền hàng tỷ: xếp 3 x 3 ở màn rộng cho thẻ đủ rộng để số hiện đủ
          chữ số thay vì bị cắt. Số in to là THỰC ĐẠT, kế hoạch đứng ở dòng phụ (feedback chị
          Bình 06/09/2026: bản trước in kế hoạch to, thực đạt nhỏ — ngược). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {kpis.map((kpi) => {
          const rate = data.hasPlan ? ratioOf(kpi.actual, kpi.plan) : null;
          return (
            <StatCard
              key={kpi.label}
              label={kpi.label}
              tone={kpi.tone}
              icon={kpi.icon}
              value={fmtMoney(kpi.actual)}
              sub={data.hasPlan ? `Kế hoạch: ${fmtMoney(kpi.plan)}` : "Thực tế các tháng đã chọn (chưa có KH)"}
              rate={rate}
              rateGood={rate === null ? null : kpi.income ? rate >= 1 : rate <= 1}
              hint={[data.hasPlan ? `Kế hoạch ${fmtMoney(kpi.plan)} · Thực đạt ${fmtMoney(kpi.actual)}` : "", kpi.note || ""].filter(Boolean).join(" — ") || undefined}
            />
          );
        })}
      </div>

      <PnlTrendCard data={data} picked={picked} monthHeaders={monthHeaders} />

      <Card
        title="Cơ cấu 1 đồng doanh thu"
        subtitle={`Cộng ${monthPickSummary(picked)} — mỗi 100 đồng doanh thu chia cho giá vốn, nhân sự, CAPEX, từng nhóm chi phí hoạt động như bảng P&L và phần còn lại là lợi nhuận`}
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
              {(mixParts.find((part) => part.label === "Lợi nhuận vận hành")?.value ?? 0) < 0 && <span className="text-rose-600 font-semibold">Lợi nhuận âm — chi phí đang vượt doanh thu.</span>}
            </div>
          </>
        ) : (
          <p className="py-6 text-center text-sm text-slate-400">Chưa có doanh thu {mixMode === "plan" ? "kế hoạch" : "thực tế"} trong khoảng lũy kế này.</p>
        )}
      </Card>

      <div className="grid md:grid-cols-3 gap-4">
        <Card
          title="Cơ cấu doanh thu"
          subtitle={revenueView === "group" ? `Theo nhóm doanh thu — cộng ${monthPickSummary(picked)}` : `Theo kênh bán — cộng ${monthPickSummary(picked)}`}
          icon="donut_small"
          right={<Segmented value={revenueView} onChange={setRevenueView} options={[{ id: "group", label: "Nhóm doanh thu" }, { id: "channel", label: "Kênh bán" }]} />}
          bodyClassName="px-4 pb-4"
        >
          <DonutLegendChart data={revenueShare()} />
        </Card>
        {donutCard("Cơ cấu giá vốn", "Theo nhóm/hạng mục giá vốn (lũy kế)", statementOf("cogs"), "actual")}
        {donutCard("Cơ cấu chi phí hoạt động (OPEX)", "Theo nhóm OPEX — chọn kế hoạch hoặc thực tế", statementOf("otherOpex"), opexMode, setOpexMode)}
      </div>

      <Card title="Phân tích hiệu quả theo cửa hàng" subtitle={`Doanh thu, chi phí, lợi nhuận từng cửa hàng — kế hoạch đậm, thực đạt chip màu (cộng ${monthPickSummary(picked)})`} icon="storefront" bodyClassName="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="px-4 py-3 font-bold">Cửa hàng</th>
              {["Doanh thu", "Giá vốn (COGS)", "Lợi nhuận gộp", "Chi phí hoạt động", "Lợi nhuận vận hành"].map((header) => <th key={header} className="px-3 py-3 font-bold text-right whitespace-nowrap">{header}</th>)}
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
        <Card
          title="COGS so với doanh thu"
          subtitle={cogsView === "total"
            ? "Tổng doanh thu, tổng giá vốn và ngân sách giá vốn."
            : `Doanh thu và giá vốn riêng của ${cogsView === "kitchen" ? "bếp" : "bar"} (giá vốn theo kho ${cogsView === "kitchen" ? "bếp" : "bar"} bị trừ).`}
          icon="show_chart"
          right={<Segmented value={cogsView} onChange={setCogsView} options={[{ id: "total", label: "Tổng" }, { id: "kitchen", label: "Bếp" }, { id: "bar", label: "Bar" }]} />}
          bodyClassName="px-2 pb-3"
        >
          <MoneyLineChart
            labels={monthHeaders}
            series={cogsView === "total"
              ? [
                { name: "Doanh thu", values: data.totals.map((total) => total.revenue), color: "#84cc16" },
                { name: "Tổng COGS", values: data.totals.map((total) => total.cogs), color: "#f97316" },
                ...(data.budgets.cogs.some((value) => value > 0) ? [{ name: "Ngân sách COGS", values: data.budgets.cogs, color: "#94a3b8", dashed: true }] : []),
              ]
              : [
                { name: `Doanh thu ${cogsView === "kitchen" ? "bếp" : "bar"}`, values: departmentMonths(data.revenueSplit.byDepartment, cogsView, monthHeaders.length), color: "#84cc16" },
                { name: `COGS ${cogsView === "kitchen" ? "bếp" : "bar"}`, values: departmentMonths(data.cogsByDepartment, cogsView, monthHeaders.length), color: "#f97316" },
              ]}
          />
        </Card>
        <PayrollBudgetCard year={data.year} branchCode={data.branchCode} labels={monthHeaders} picked={picked} fallbackBudget={data.budgets.payroll} />
      </div>
      <OpexCategoryCard data={data} picked={picked} monthHeaders={monthHeaders} />
      <p className="text-[11px] text-slate-400 px-1">Chi phí hoạt động = nhân sự + OPEX khác + khấu hao. Số lũy kế theo chip tháng ở trên; hai chart xu hướng luôn vẽ đủ 12 tháng.</p>
    </div>
  );
}
