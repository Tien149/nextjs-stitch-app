"use client";

import React, { useMemo } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { opexGroupRank } from "@/lib/pnl-ordering";
import { DonutLegendChart, MoneyBarChart, MoneyLineChart } from "@/components/charts/ReportCharts";
import { Card, MonthChips, StatCard, Tag, fmtCompact, fmtMoney, pctText, ratioOf, signedMoney } from "@/components/reports/planning/planning-ui";
import { bucketSum, cumulative, sumAll, type PlanningData, type PnlBucket } from "@/components/reports/planning/planning-types";

/**
 * Màn "Điểm hòa vốn" học theo phần mềm mẫu: 3 thẻ (DT hòa vốn, định phí, biến phí dự kiến),
 * banner đã/chưa vượt hòa vốn + biên an toàn, bảng & chart doanh thu lũy kế so mốc hòa vốn,
 * cơ cấu định phí / biến phí, phân tích độ nhạy định phí, và so sánh hòa vốn theo cửa hàng.
 *
 * Phân loại: biến phí = giá vốn + nhóm OPEX "biến đổi"; định phí = nhân sự + khấu hao + nhóm
 * OPEX cố định/marketing/khác (đọc theo tên nhóm, cùng luật sắp xếp trên bảng P&L). Số "dự
 * kiến" lấy kế hoạch cả năm; chưa set kế hoạch thì tạm lấy thực tế cả năm làm gốc.
 */

export type BreakEvenModel = {
  baseLabel: string;
  revenue: number;
  fixed: number;
  variable: number;
  variableRatio: number;
  cmRatio: number;
  bep: number | null;
  fixedShareOfOpex: number;
  fixedParts: Array<{ name: string; value: number }>;
  variableParts: Array<{ name: string; value: number }>;
};

/** Mô hình hòa vốn cả năm từ dữ liệu P&L — dùng chung với màn Giả định. */
export function buildBreakEvenModel(data: PlanningData, buckets: PnlBucket[], baseLabel: string): BreakEvenModel {
  const opexLine = data.statement.find((line) => line.key === "otherOpex");
  const usePlan = buckets === data.plans;
  const groupTotal = (group: { months: number[]; plan: number[] | null }) => (usePlan ? sumAll(group.plan || []) : sumAll(group.months));
  const fixedParts: Array<{ name: string; value: number }> = [];
  const variableParts: Array<{ name: string; value: number }> = [];
  const payroll = sumAll(buckets.map((bucket) => bucket.payroll));
  const depreciation = sumAll(buckets.map((bucket) => bucket.depreciation));
  const cogs = sumAll(buckets.map((bucket) => bucket.cogs));
  if (payroll > 0) fixedParts.push({ name: "Chi phí nhân sự", value: payroll });
  if (depreciation > 0) fixedParts.push({ name: "Khấu hao tài sản/CCDC", value: depreciation });
  if (cogs > 0) variableParts.push({ name: "Giá vốn hàng bán", value: cogs });
  let fixedOpex = 0;
  let variableOpex = 0;
  for (const group of opexLine?.groups || []) {
    const value = groupTotal(group);
    if (value <= 0) continue;
    if (opexGroupRank(group.name) === 2) { variableOpex += value; variableParts.push({ name: group.name, value }); } else { fixedOpex += value; fixedParts.push({ name: group.name, value }); }
  }
  // Nhóm OPEX chưa gắn nhóm nào (tổng dòng lớn hơn tổng nhóm) coi là định phí.
  const opexTotal = sumAll(buckets.map((bucket) => bucket.otherOpex));
  const unassignedOpex = opexTotal - fixedOpex - variableOpex;
  if (unassignedOpex > 0.5) { fixedOpex += unassignedOpex; fixedParts.push({ name: "OPEX khác (chưa gắn nhóm)", value: unassignedOpex }); }
  const revenue = sumAll(buckets.map((bucket) => bucket.revenue));
  const fixed = payroll + depreciation + fixedOpex;
  const variable = cogs + variableOpex;
  const variableRatio = revenue > 0 ? variable / revenue : 0;
  const cmRatio = 1 - variableRatio;
  return {
    baseLabel,
    revenue,
    fixed,
    variable,
    variableRatio,
    cmRatio,
    bep: cmRatio > 0 ? fixed / cmRatio : null,
    fixedShareOfOpex: opexTotal > 0 ? fixedOpex / opexTotal : 1,
    fixedParts: fixedParts.sort((a, b) => b.value - a.value),
    variableParts: variableParts.sort((a, b) => b.value - a.value),
  };
}

export default function BreakEvenTab({ data, upTo, onChangeUpTo }: { data: PlanningData; upTo: number; onChangeUpTo: (index: number) => void }) {
  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const model = useMemo(() => buildBreakEvenModel(data, data.hasPlan ? data.plans : data.totals, data.hasPlan ? "kế hoạch cả năm" : "thực tế cả năm"), [data]);
  const actualCumulative = cumulative(data.totals.map((bucket) => bucket.revenue));
  const planCumulative = cumulative(data.plans.map((bucket) => bucket.revenue));
  const actualToDate = actualCumulative[upTo] || 0;
  const reached = model.bep !== null && actualToDate >= model.bep;
  const marginOfSafety = model.bep !== null && actualToDate > 0 ? (actualToDate - model.bep) / actualToDate : null;
  const bepMonthActual = model.bep === null ? -1 : actualCumulative.findIndex((value) => value >= (model.bep as number));
  const bepMonthPlan = model.bep === null ? -1 : planCumulative.findIndex((value) => value >= (model.bep as number));

  const sensitivity = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((delta) => {
    const fixed = model.fixed * (1 + delta);
    const bep = model.cmRatio > 0 ? fixed / model.cmRatio : null;
    return { delta, fixed, bep, diff: bep !== null && model.bep !== null ? bep - model.bep : null };
  });
  // Đồ thị giao cắt: doanh thu tăng dần từ 0 tới ~1,3 lần max(doanh thu, hòa vốn).
  const crossMax = Math.max(model.revenue, model.bep || 0, 1) * 1.3;
  const crossSteps = Array.from({ length: 7 }, (_, index) => (crossMax * index) / 6);
  const crossLabels = crossSteps.map((value) => fmtCompact(value));

  const branchRows = data.byBranch.map((branch) => {
    // Cửa hàng chưa set kế hoạch riêng (kế hoạch chỉ set ở cấp toàn hệ thống) thì lấy thực tế làm gốc.
    const branchHasPlan = branch.plan.some((bucket) => bucket.revenue > 0);
    const base = data.hasPlan && branchHasPlan ? branch.plan : branch.actual;
    const revenuePlan = sumAll(base.map((bucket) => bucket.revenue));
    const revenueActual = bucketSum(branch.actual, "revenue", upTo);
    const opex = sumAll(base.map((bucket) => bucket.otherOpex));
    const fixed = sumAll(base.map((bucket) => bucket.payroll + bucket.depreciation)) + opex * model.fixedShareOfOpex;
    const variable = sumAll(base.map((bucket) => bucket.cogs)) + opex * (1 - model.fixedShareOfOpex);
    const cm = revenuePlan > 0 ? 1 - variable / revenuePlan : 0;
    const bep = cm > 0 ? fixed / cm : null;
    const mos = bep !== null && revenueActual > 0 ? (revenueActual - bep) / revenueActual : null;
    return { code: branch.code, hasPlan: branchHasPlan, revenuePlan, revenueActual, fixed, variable, cm, bep, mos, reached: bep !== null && revenueActual >= bep };
  });

  const partsTable = (parts: Array<{ name: string; value: number }>, total: number, tone: "blue" | "amber") => (
    <table className="w-full text-left text-xs mt-3">
      <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200"><th className="px-2 py-2 font-bold">Hạng mục</th><th className="px-2 py-2 font-bold text-right">Chi phí ({model.baseLabel})</th><th className="px-2 py-2 font-bold text-right">Tỷ trọng</th></tr></thead>
      <tbody>
        {parts.slice(0, 8).map((part) => (
          <tr key={part.name} className="border-t border-slate-100"><td className="px-2 py-1.5 text-slate-700">{part.name}</td><td className="px-2 py-1.5 text-right font-semibold whitespace-nowrap">{fmtMoney(part.value)}</td><td className={`px-2 py-1.5 text-right font-bold ${tone === "blue" ? "text-blue-600" : "text-amber-600"}`}>{pctText(ratioOf(part.value, total))}</td></tr>
        ))}
        {parts.length === 0 && <tr><td colSpan={3} className="px-2 py-4 text-center text-slate-400">Chưa có số.</td></tr>}
      </tbody>
    </table>
  );

  return (
    <div className="space-y-4">
      <MonthChips upTo={upTo} onChange={onChangeUpTo} label="Doanh thu thực đạt lũy kế tới" />
      <div className="grid md:grid-cols-3 gap-3">
        <div className="bg-rose-50 border border-rose-100 rounded-xl p-4 flex items-center gap-3">
          <span className="h-10 w-10 rounded-full bg-white text-rose-500 grid place-items-center shadow-sm"><span className="material-symbols-outlined">target</span></span>
          <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-rose-600">Doanh thu hòa vốn dự kiến</p><p className="text-lg font-extrabold text-slate-800 truncate">{model.bep === null ? "—" : fmtMoney(model.bep)}</p></div>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 flex items-center gap-3">
          <span className="h-10 w-10 rounded-full bg-white text-blue-500 grid place-items-center shadow-sm"><span className="material-symbols-outlined">lock</span></span>
          <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-blue-600">Chi phí cố định dự kiến</p><p className="text-lg font-extrabold text-slate-800 truncate">{fmtMoney(model.fixed)}</p></div>
        </div>
        <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 flex items-center gap-3">
          <span className="h-10 w-10 rounded-full bg-white text-amber-500 grid place-items-center shadow-sm"><span className="material-symbols-outlined">swap_vert</span></span>
          <div className="min-w-0"><p className="text-[10px] font-bold uppercase tracking-wider text-amber-600">Chi phí biến đổi dự kiến</p><p className="text-lg font-extrabold text-slate-800 truncate">{fmtMoney(model.variable)}</p><p className="text-[11px] text-slate-500">{pctText(model.variableRatio)} doanh thu</p></div>
        </div>
      </div>

      <div className="grid xl:grid-cols-[2fr_1fr] gap-4">
        <div className={`rounded-xl border p-4 flex items-center gap-4 ${reached ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
          <span className={`h-12 w-12 rounded-xl grid place-items-center text-white shrink-0 ${reached ? "bg-emerald-500" : "bg-amber-500"}`}><span className="material-symbols-outlined text-2xl">{reached ? "check" : "hourglass_top"}</span></span>
          <div className="min-w-0">
            <p className={`text-base font-extrabold uppercase tracking-wide ${reached ? "text-emerald-800" : "text-amber-800"}`}>{model.bep === null ? "Chưa tính được điểm hòa vốn" : reached ? "Đã vượt điểm hòa vốn" : "Chưa đạt điểm hòa vốn"}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
              <span>DT thực đạt (T1–T{upTo + 1}): <b className="text-slate-800">{fmtMoney(actualToDate)}</b></span>
              <span>Mốc hòa vốn: <b className="text-slate-800">{model.bep === null ? "—" : fmtMoney(model.bep)}</b></span>
              <span>Chênh lệch: <b className={`rounded px-1.5 py-0.5 text-white ${reached ? "bg-emerald-500" : "bg-amber-500"}`}>{model.bep === null ? "—" : signedMoney(actualToDate - model.bep)}</b></span>
              {bepMonthActual >= 0 && <span>Đạt hòa vốn từ <b className="text-slate-800">tháng {bepMonthActual + 1}</b></span>}
              {bepMonthActual < 0 && bepMonthPlan >= 0 && <span>Theo kế hoạch sẽ hòa vốn vào <b className="text-slate-800">tháng {bepMonthPlan + 1}</b></span>}
            </div>
            {model.cmRatio <= 0 && <p className="mt-1 text-xs text-rose-600 font-semibold">Biến phí đang bằng hoặc vượt doanh thu — không có điểm hòa vốn, cần xem lại giá vốn.</p>}
          </div>
        </div>
        <StatCard label="Biên an toàn (MOS)" tone={marginOfSafety !== null && marginOfSafety >= 0 ? "emerald" : "rose"} icon="health_and_safety" value={pctText(marginOfSafety)} sub={marginOfSafety === null ? "Cần doanh thu thực đạt và mốc hòa vốn" : marginOfSafety >= 0 ? "Doanh thu có thể giảm chừng này vẫn không lỗ" : "Doanh thu còn thiếu so với mốc hòa vốn"} />
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="I. Tương quan doanh thu lũy kế & điểm hòa vốn" subtitle="Doanh thu cộng dồn từng tháng so với mốc hòa vốn cả năm" icon="table_rows" bodyClassName="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200 bg-rose-50/60"><th className="px-3 py-2 font-bold">Thời gian</th><th className="px-3 py-2 font-bold text-right">DT lũy kế KH</th><th className="px-3 py-2 font-bold text-right">DT lũy kế TT</th><th className="px-3 py-2 font-bold text-right">Mốc hòa vốn</th><th className="px-3 py-2 font-bold text-right">Chênh lệch</th></tr></thead>
            <tbody>
              {monthHeaders.map((label, index) => {
                const known = index <= upTo;
                const compare = known ? actualCumulative[index] : planCumulative[index];
                const diff = model.bep === null ? null : compare - model.bep;
                return (
                  <tr key={label} className={`border-t border-slate-100 ${known ? "" : "text-slate-400"}`}>
                    <td className="px-3 py-1.5 font-semibold">Tháng {index + 1}{!known && <span className="ml-1 text-[10px] font-normal">(theo KH)</span>}</td>
                    <td className="px-3 py-1.5 text-right">{fmtCompact(planCumulative[index])}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-emerald-700">{known ? fmtCompact(actualCumulative[index]) : "—"}</td>
                    <td className="px-3 py-1.5 text-right text-rose-600 font-semibold">{model.bep === null ? "—" : fmtCompact(model.bep)}</td>
                    <td className={`px-3 py-1.5 text-right font-bold ${diff === null ? "" : diff >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{diff === null ? "—" : `${diff >= 0 ? "+" : "−"}${fmtCompact(Math.abs(diff))}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        <Card title="Mức độ tương quan & điểm giao cắt" subtitle="Doanh thu lũy kế kế hoạch / thực tế và đường mốc hòa vốn" icon="show_chart" bodyClassName="px-2 pb-3">
          <MoneyLineChart
            labels={monthHeaders}
            series={[
              { name: "DT lũy kế kế hoạch", values: planCumulative, color: "#4f46e5" },
              { name: "DT lũy kế thực tế", values: actualCumulative.map((value, index) => (index <= upTo ? value : Number.NaN)), color: "#10b981" },
              { name: "Mốc hòa vốn", values: data.months.map(() => model.bep ?? Number.NaN), color: "#f43f5e", dashed: true },
            ]}
            height={330}
          />
        </Card>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="II. Chi phí cố định (FC)" subtitle={`Tổng cấu thành định phí theo ${model.baseLabel}`} icon="lock" bodyClassName="px-4 pb-4">
          <DonutLegendChart data={model.fixedParts} height={200} top={6} colors={["#2563eb", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe", "#1d4ed8", "#1e40af"]} />
          <p className="mt-2 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">Tổng cấu thành FC</p>
          <p className="text-center text-lg font-extrabold text-blue-700">{fmtMoney(model.fixed)}</p>
          {partsTable(model.fixedParts, model.fixed, "blue")}
        </Card>
        <Card title="III. Chi phí biến đổi (VC) tại mức điểm hòa vốn" subtitle="Tỷ lệ biến phí trên doanh thu và cấu thành" icon="swap_vert" bodyClassName="px-4 pb-4">
          <DonutLegendChart data={model.variableParts} height={200} top={6} colors={["#f59e0b", "#fbbf24", "#fcd34d", "#fde68a", "#d97706", "#b45309"]} />
          <p className="mt-2 text-center text-[10px] font-bold uppercase tracking-wider text-slate-500">Tỷ lệ biến phí (VC ratio)</p>
          <p className="text-center text-lg font-extrabold text-amber-600">{pctText(model.variableRatio)}</p>
          {partsTable(model.variableParts, model.variable, "amber")}
        </Card>
      </div>

      <Card title="IV. Phân tích độ nhạy (định phí) & biểu đồ tuyến tính trực quan" subtitle="Định phí thay đổi ±30% thì mốc hòa vốn dịch bao nhiêu; đồ thị doanh thu cắt tổng chi phí ở đâu" icon="tune" bodyClassName="px-4 pb-4">
        <div className="grid xl:grid-cols-2 gap-4">
          <table className="w-full text-left text-xs">
            <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200"><th className="px-3 py-2 font-bold">Kịch bản định phí (FC)</th><th className="px-3 py-2 font-bold text-right">Điểm cân bằng mới</th><th className="px-3 py-2 font-bold text-right">Biến động bù trừ</th></tr></thead>
            <tbody>
              {sensitivity.map((row) => (
                <tr key={row.delta} className={`border-t border-slate-100 ${row.delta === 0 ? "bg-indigo-50/60 font-bold" : ""}`}>
                  <td className="px-3 py-2">
                    <span className={`flex items-center gap-1.5 ${row.delta < 0 ? "text-emerald-700" : row.delta > 0 ? "text-rose-700" : "text-indigo-700"}`}>
                      <span className="material-symbols-outlined text-sm">{row.delta < 0 ? "arrow_drop_down" : row.delta > 0 ? "arrow_drop_up" : "remove"}</span>
                      FC {row.delta === 0 ? "hiện tại" : `${row.delta > 0 ? "+" : ""}${Math.round(row.delta * 100)}%`}
                    </span>
                    <span className="block text-[10px] text-slate-400 ml-5">Định phí {fmtCompact(row.fixed)}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-bold whitespace-nowrap">{row.bep === null ? "—" : fmtMoney(row.bep)}</td>
                  <td className={`px-3 py-2 text-right font-semibold whitespace-nowrap ${row.diff === null ? "" : row.diff > 0 ? "text-rose-600" : row.diff < 0 ? "text-emerald-600" : "text-slate-500"}`}>{row.diff === null ? "—" : signedMoney(row.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center mb-1">Phân tích giao cắt tuyến tính (hiện tại)</p>
            <MoneyLineChart
              labels={crossLabels}
              series={[
                { name: "Tổng doanh thu", values: crossSteps, color: "#10b981" },
                { name: "Tổng chi phí (FC + VC)", values: crossSteps.map((value) => model.fixed + value * model.variableRatio), color: "#f43f5e" },
                { name: "Định phí (FC)", values: crossSteps.map(() => model.fixed), color: "#64748b", dashed: true },
              ]}
              height={260}
            />
            <p className="text-[10px] text-slate-400 text-center">Trục ngang: mức doanh thu. Hai đường cắt nhau tại mốc hòa vốn {model.bep === null ? "—" : fmtCompact(model.bep)}.</p>
          </div>
        </div>
      </Card>

      <Card title="V. So sánh & phân tích điểm hòa vốn theo cửa hàng" subtitle="Định phí OPEX của từng cửa hàng phân bổ theo tỷ lệ cố định/biến đổi chung của cả hệ thống" icon="storefront" bodyClassName="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200"><th className="px-4 py-2.5 font-bold">Cửa hàng</th><th className="px-3 py-2.5 font-bold text-right">Doanh thu KH</th><th className="px-3 py-2.5 font-bold text-right">Doanh thu TT</th><th className="px-3 py-2.5 font-bold text-right">Định phí (FC)</th><th className="px-3 py-2.5 font-bold text-right">Biến phí (VC)</th><th className="px-3 py-2.5 font-bold text-right">Tỷ suất CM</th><th className="px-3 py-2.5 font-bold text-right">Mốc hòa vốn</th><th className="px-3 py-2.5 font-bold text-right">Biên an toàn</th><th className="px-3 py-2.5 font-bold text-center">Trạng thái</th></tr></thead>
          <tbody>
            {branchRows.map((row) => (
              <tr key={row.code} className="border-t border-slate-100">
                <td className="px-4 py-2.5"><Tag tone={row.reached ? "emerald" : "rose"} className="text-[11px]">{storeLabel(row.code)}</Tag></td>
                <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">{fmtMoney(row.revenuePlan)}{!row.hasPlan && <span className="block text-[10px] font-normal text-slate-400">gốc = thực tế cả năm</span>}</td>
                <td className="px-3 py-2.5 text-right font-bold text-emerald-700 whitespace-nowrap">{fmtMoney(row.revenueActual)}</td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">{fmtMoney(row.fixed)}</td>
                <td className="px-3 py-2.5 text-right whitespace-nowrap">{fmtMoney(row.variable)}</td>
                <td className="px-3 py-2.5 text-right font-semibold">{pctText(row.cm)}</td>
                <td className="px-3 py-2.5 text-right font-bold text-rose-600 whitespace-nowrap">{row.bep === null ? "—" : fmtMoney(row.bep)}</td>
                <td className={`px-3 py-2.5 text-right font-bold ${row.mos !== null && row.mos >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{pctText(row.mos)}</td>
                <td className="px-3 py-2.5 text-center"><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${row.reached ? "bg-emerald-50 text-emerald-700 border-emerald-100" : "bg-rose-50 text-rose-700 border-rose-100"}`}><span className="material-symbols-outlined text-sm">{row.reached ? "check_circle" : "error"}</span>{row.reached ? "Vượt hòa vốn" : "Dưới hòa vốn"}</span></td>
              </tr>
            ))}
            {branchRows.length === 0 && <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-400">Chưa có dữ liệu theo cửa hàng.</td></tr>}
          </tbody>
        </table>
        {branchRows.length > 0 && (
          <div className="px-2 pb-3 pt-2 border-t border-slate-100">
            <p className="px-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">So sánh DT vs mốc hòa vốn theo cửa hàng</p>
            <MoneyBarChart
              labels={branchRows.map((row) => storeLabel(row.code))}
              series={[
                { name: "Doanh thu KH", values: branchRows.map((row) => row.revenuePlan), color: "#4f46e5" },
                { name: "Doanh thu TT", values: branchRows.map((row) => row.revenueActual), color: "#10b981" },
                { name: "Mốc hòa vốn", values: branchRows.map((row) => row.bep || 0), color: "#f43f5e" },
              ]}
              height={240}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
