"use client";

import React, { useMemo, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { HorizontalBarChart, MixedChart } from "@/components/charts/ReportCharts";
import { buildBreakEvenModel } from "@/components/reports/planning/BreakEvenTab";
import { Card, MonthChips, NoPlanNotice, Tag, fmtCompact, fmtMoney, pctText, ratioOf, signedMoney, type Tone } from "@/components/reports/planning/planning-ui";
import { bucketOperatingCost, bucketSum, cumulative, finalizeBucket, sumAll, type PlanningData, type PnlBucket } from "@/components/reports/planning/planning-types";

/**
 * Màn "Giả định tài chính" (what-if) học theo phần mềm mẫu: bảng kịch bản bên trái với các biến
 * số kéo thanh trượt (% tăng/giảm doanh thu, giá vốn, nhân sự, OPEX, khấu hao, áp dụng từ tháng
 * nào), bên phải là 5 thẻ Kế hoạch / Thực đạt / Giả định, phân tích hòa vốn theo kịch bản,
 * chart LN ròng KH vs kịch bản vs thực đạt, độ lệch LN ròng theo cửa hàng và bảng biến động
 * P&L các tháng bị tác động. Tính ngay trên trình duyệt, không ghi vào kế hoạch.
 */

type VariableKey = "revenue" | "cogs" | "payroll" | "otherOpex" | "depreciation";
const VARIABLES: Array<{ key: VariableKey; label: string; hint: string; tone: Tone }> = [
  { key: "revenue", label: "Doanh thu", hint: "Tăng/giảm doanh thu mọi cửa hàng", tone: "blue" },
  { key: "cogs", label: "Giá vốn hàng bán", hint: "Giá nguyên liệu, định lượng", tone: "amber" },
  { key: "payroll", label: "Chi phí nhân sự", hint: "Lương, thưởng, bảo hiểm", tone: "sky" },
  { key: "otherOpex", label: "Chi phí OPEX khác", hint: "Thuê mặt bằng, marketing, điện nước...", tone: "indigo" },
  { key: "depreciation", label: "Khấu hao", hint: "Tài sản, CCDC", tone: "slate" },
];
type Adjustment = { enabled: boolean; pct: number };
const defaultAdjustments = (): Record<VariableKey, Adjustment> => ({
  revenue: { enabled: true, pct: 0 }, cogs: { enabled: false, pct: 0 }, payroll: { enabled: false, pct: 0 }, otherOpex: { enabled: false, pct: 0 }, depreciation: { enabled: false, pct: 0 },
});

function applyScenario(base: PnlBucket[], adjustments: Record<VariableKey, Adjustment>, fromMonth: number) {
  return base.map((bucket, index) => {
    const factor = (key: VariableKey) => (index >= fromMonth && adjustments[key].enabled ? 1 + adjustments[key].pct / 100 : 1);
    return finalizeBucket({
      revenue: bucket.revenue * factor("revenue"),
      cogs: bucket.cogs * factor("cogs"),
      payroll: bucket.payroll * factor("payroll"),
      otherOpex: bucket.otherOpex * factor("otherOpex"),
      depreciation: bucket.depreciation * factor("depreciation"),
      otherIncome: bucket.otherIncome,
      otherExpense: bucket.otherExpense,
    });
  });
}

export default function ScenarioTab({ data, upTo, onChangeUpTo }: { data: PlanningData; upTo: number; onChangeUpTo: (index: number) => void }) {
  const [adjustments, setAdjustments] = useState<Record<VariableKey, Adjustment>>(defaultAdjustments);
  const [fromMonth, setFromMonth] = useState(0);
  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const base = data.hasPlan ? data.plans : data.totals;
  const baseLabel = data.hasPlan ? "Kế hoạch" : "Thực tế (gốc)";
  const scenario = useMemo(() => applyScenario(base, adjustments, fromMonth), [base, adjustments, fromMonth]);
  const activeCount = VARIABLES.filter((variable) => adjustments[variable.key].enabled && adjustments[variable.key].pct !== 0).length;

  const update = (key: VariableKey, patch: Partial<Adjustment>) => setAdjustments((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  const cards: Array<{ label: string; tone: Tone; income: boolean; plan: number; actual: number; what: number }> = [
    { label: "Tổng doanh thu", tone: "blue", income: true, plan: bucketSum(data.plans, "revenue", upTo), actual: bucketSum(data.totals, "revenue", upTo), what: bucketSum(scenario, "revenue", upTo) },
    { label: "Tổng lợi nhuận gộp", tone: "emerald", income: true, plan: bucketSum(data.plans, "grossProfit", upTo), actual: bucketSum(data.totals, "grossProfit", upTo), what: bucketSum(scenario, "grossProfit", upTo) },
    { label: "Chi phí hoạt động (OPEX)", tone: "rose", income: false, plan: bucketOperatingCost(data.plans, upTo), actual: bucketOperatingCost(data.totals, upTo), what: bucketOperatingCost(scenario, upTo) },
    { label: "Tổng lợi nhuận ròng", tone: "indigo", income: true, plan: bucketSum(data.plans, "netProfit", upTo), actual: bucketSum(data.totals, "netProfit", upTo), what: bucketSum(scenario, "netProfit", upTo) },
  ];
  const netDelta = bucketSum(scenario, "netProfit", upTo) - bucketSum(base, "netProfit", upTo);

  // Hòa vốn theo kịch bản (cả năm) so với gốc.
  const bepBase = useMemo(() => buildBreakEvenModel(data, base, baseLabel), [data, base, baseLabel]);
  const scenarioModel = useMemo(() => {
    const model = buildBreakEvenModel(data, scenario, "kịch bản");
    // buildBreakEvenModel đọc nhóm OPEX từ statement (số gốc); scale phần OPEX theo hệ số kịch bản để giữ cùng tỷ lệ.
    const opexFactor = adjustments.otherOpex.enabled ? 1 + adjustments.otherOpex.pct / 100 : 1;
    const fixedOpex = (bepBase.fixed - sumAll(base.map((bucket) => bucket.payroll + bucket.depreciation))) * opexFactor;
    const variableOpex = (bepBase.variable - sumAll(base.map((bucket) => bucket.cogs))) * opexFactor;
    const fixed = sumAll(scenario.map((bucket) => bucket.payroll + bucket.depreciation)) + fixedOpex;
    const variable = sumAll(scenario.map((bucket) => bucket.cogs)) + variableOpex;
    const revenue = model.revenue;
    const variableRatio = revenue > 0 ? variable / revenue : 0;
    const cmRatio = 1 - variableRatio;
    return { revenue, fixed, variable, cmRatio, bep: cmRatio > 0 ? fixed / cmRatio : null };
  }, [data, scenario, adjustments.otherOpex, bepBase, base]);
  const scenarioCumulative = cumulative(scenario.map((bucket) => bucket.revenue));
  const bepMonth = scenarioModel.bep === null ? -1 : scenarioCumulative.findIndex((value) => value >= (scenarioModel.bep as number));
  const bepMonthBase = bepBase.bep === null ? -1 : cumulative(base.map((bucket) => bucket.revenue)).findIndex((value) => value >= (bepBase.bep as number));
  const mos = scenarioModel.bep !== null && scenarioModel.revenue > 0 ? (scenarioModel.revenue - scenarioModel.bep) / scenarioModel.revenue : null;
  const mosBase = bepBase.bep !== null && bepBase.revenue > 0 ? (bepBase.revenue - bepBase.bep) / bepBase.revenue : null;
  const operatingProfit = sumAll(scenario.map((bucket) => bucket.operatingProfit));
  const dol = operatingProfit > 0 ? (scenarioModel.revenue - scenarioModel.variable) / operatingProfit : null;
  const operatingProfitBase = sumAll(base.map((bucket) => bucket.operatingProfit));
  const dolBase = operatingProfitBase > 0 ? (bepBase.revenue - bepBase.variable) / operatingProfitBase : null;

  const branchDeviation = data.byBranch.map((branch) => {
    const branchBase = data.hasPlan && branch.plan.some((bucket) => bucket.revenue > 0) ? branch.plan : branch.actual;
    const branchScenario = applyScenario(branchBase, adjustments, fromMonth);
    return { name: storeLabel(branch.code), value: bucketSum(branchScenario, "netProfit", upTo) - bucketSum(branchBase, "netProfit", upTo) };
  });

  const impactedMonths = data.months.map((_, index) => index).filter((index) => index >= fromMonth);

  return (
    <div className="space-y-4">
      {!data.hasPlan && <NoPlanNotice year={data.year} />}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[320px]"><MonthChips upTo={upTo} onChange={onChangeUpTo} /></div>
        <button type="button" onClick={() => { setAdjustments(defaultAdjustments()); setFromMonth(0); }} className="flex items-center gap-1 text-xs font-bold text-slate-600 border border-slate-200 rounded-lg px-3 py-2 bg-white hover:bg-slate-50">
          <span className="material-symbols-outlined text-base">restart_alt</span>Đặt lại tất cả
        </button>
        <span className="flex items-center gap-1 text-xs font-bold text-indigo-700 border border-indigo-200 rounded-lg px-3 py-2 bg-indigo-50" title="Kịch bản chỉ tính thử trên trình duyệt; muốn thành kế hoạch chính thức thì set lại ở tab Ngân sách.">
          <span className="material-symbols-outlined text-base">science</span>Đang thử {activeCount} biến số
        </span>
      </div>

      <div className="grid xl:grid-cols-[320px_1fr] gap-4 items-start">
        <Card title="Bảng kịch bản" subtitle="Kéo thanh trượt để giả định % thay đổi" icon="tune" right={<Tag tone="indigo">{VARIABLES.length} biến số</Tag>} bodyClassName="px-4 pb-4 space-y-3">
          <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wide">Áp dụng từ tháng
            <select className="control mt-1 py-2 text-xs font-semibold normal-case" value={fromMonth} onChange={(event) => setFromMonth(Number(event.target.value))}>
              {monthHeaders.map((label, index) => <option key={label} value={index}>Tháng {index + 1} → hết năm</option>)}
            </select>
          </label>
          {VARIABLES.map((variable) => {
            const adjustment = adjustments[variable.key];
            const original = sumAll(base.map((bucket) => bucket[variable.key]));
            const changed = sumAll(scenario.map((bucket) => bucket[variable.key]));
            return (
              <div key={variable.key} className={`rounded-xl border p-3 ${adjustment.enabled ? "border-indigo-200 bg-indigo-50/40" : "border-slate-200 bg-white"}`}>
                <label className="flex items-center gap-2 text-sm font-bold text-slate-800 cursor-pointer">
                  <input type="checkbox" checked={adjustment.enabled} onChange={(event) => update(variable.key, { enabled: event.target.checked })} />
                  {variable.label}
                </label>
                <p className="text-[10px] text-slate-400 mt-0.5 ml-5">{variable.hint}</p>
                <div className="mt-2 flex items-center gap-2">
                  <input type="range" min={-50} max={50} step={1} value={adjustment.pct} disabled={!adjustment.enabled} onChange={(event) => update(variable.key, { pct: Number(event.target.value) })} className="flex-1 accent-indigo-600 disabled:opacity-40" />
                  <div className="flex items-center rounded-lg border border-slate-200 bg-white overflow-hidden">
                    <input type="number" min={-90} max={200} value={adjustment.pct} disabled={!adjustment.enabled} onChange={(event) => update(variable.key, { pct: Number(event.target.value) || 0 })} className={`w-14 px-1.5 py-1 text-right text-xs font-bold outline-none disabled:opacity-40 ${adjustment.pct > 0 ? "text-emerald-700" : adjustment.pct < 0 ? "text-rose-700" : "text-slate-700"}`} />
                    <span className="px-1.5 text-[11px] font-bold text-slate-400 bg-slate-50">%</span>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                  <span>Gốc: <b className="text-slate-700">{fmtCompact(original)}</b></span>
                  <span className="material-symbols-outlined text-sm text-slate-300">arrow_forward</span>
                  <span className={`font-bold ${changed > original ? "text-emerald-700" : changed < original ? "text-rose-700" : "text-slate-700"}`}>{fmtCompact(changed)}</span>
                </div>
              </div>
            );
          })}
        </Card>

        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
            {cards.map((card) => {
              const whatVsPlan = card.what - card.plan;
              const goodWhat = card.income ? whatVsPlan >= 0 : whatVsPlan <= 0;
              const actualVsPlan = card.actual - card.plan;
              const goodActual = card.income ? actualVsPlan >= 0 : actualVsPlan <= 0;
              return (
                <div key={card.label} className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-sm min-w-0">
                  <p className={`text-[10px] font-bold uppercase tracking-wider ${{ blue: "text-blue-600", emerald: "text-emerald-600", rose: "text-rose-600", indigo: "text-indigo-600" }[card.tone as "blue" | "emerald" | "rose" | "indigo"]}`}>{card.label}</p>
                  <dl className="mt-2 space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between gap-1"><dt className="text-slate-400">{baseLabel}:</dt><dd className="font-bold text-slate-700 truncate">{fmtCompact(card.plan || (data.hasPlan ? 0 : card.actual))}</dd></div>
                    <div className="flex items-center justify-between gap-1"><dt className="text-slate-400">Thực đạt:</dt><dd className="font-bold text-slate-700 truncate flex items-center gap-1">{fmtCompact(card.actual)}{data.hasPlan && <span className={`text-[10px] ${goodActual ? "text-emerald-600" : "text-rose-600"}`}>{actualVsPlan >= 0 ? "+" : "−"}{fmtCompact(Math.abs(actualVsPlan))}</span>}</dd></div>
                    <div className="flex items-center justify-between gap-1 border-t border-dashed border-slate-200 pt-1.5"><dt className="text-indigo-500 font-semibold">Giả định:</dt><dd className={`font-extrabold truncate flex items-center gap-1 ${goodWhat ? "text-emerald-700" : "text-rose-700"}`}>{fmtCompact(card.what)}<span className="text-[10px]">{whatVsPlan >= 0 ? "+" : "−"}{fmtCompact(Math.abs(whatVsPlan))}</span></dd></div>
                  </dl>
                </div>
              );
            })}
            <div className={`rounded-xl border p-3.5 grid place-items-center text-center ${netDelta >= 0 ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200"}`}>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Độ lệch của tổng lợi nhuận ròng</p>
              <p className={`mt-1 text-2xl font-extrabold ${netDelta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{netDelta >= 0 ? "+" : "−"}{fmtCompact(Math.abs(netDelta))}</p>
              <p className="text-[10px] text-slate-500">so với {baseLabel.toLowerCase()} lũy kế {upTo + 1} tháng</p>
            </div>
          </div>

          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4">
            <p className="text-sm font-bold text-indigo-800 flex items-center gap-1.5"><span className="material-symbols-outlined text-lg">balance</span>Phân tích điểm hòa vốn (BEP) theo kịch bản — cả năm</p>
            <div className="mt-3 grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {[
                { label: "Doanh thu hòa vốn", value: scenarioModel.bep === null ? "—" : fmtCompact(scenarioModel.bep), basis: bepBase.bep === null ? "—" : fmtCompact(bepBase.bep), good: scenarioModel.bep !== null && bepBase.bep !== null ? scenarioModel.bep <= bepBase.bep : null },
                { label: "Biên an toàn", value: pctText(mos), basis: pctText(mosBase), good: mos !== null && mosBase !== null ? mos >= mosBase : null },
                { label: "Thời điểm hòa vốn", value: bepMonth >= 0 ? `Tháng ${bepMonth + 1}` : "Chưa đạt", basis: bepMonthBase >= 0 ? `Tháng ${bepMonthBase + 1}` : "Chưa đạt", good: bepMonth >= 0 && (bepMonthBase < 0 || bepMonth <= bepMonthBase) },
                { label: "Đòn bẩy (DOL)", value: dol === null ? "—" : `${dol.toFixed(2)}x`, basis: dolBase === null ? "—" : `${dolBase.toFixed(2)}x`, good: null },
              ].map((item) => (
                <div key={item.label}>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500">{item.label}</p>
                  <p className={`text-lg font-extrabold ${item.good === null ? "text-slate-800" : item.good ? "text-emerald-700" : "text-rose-700"}`}>{item.value}</p>
                  <p className="text-[11px] text-slate-500">{baseLabel}: {item.basis}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="grid xl:grid-cols-2 gap-4">
            <Card title="Lợi nhuận ròng: So sánh giả định và kế hoạch gốc" subtitle="Cột nhạt = gốc, cột đậm = kịch bản, đường = thực đạt" icon="bar_chart" bodyClassName="px-2 pb-3">
              <MixedChart
                labels={monthHeaders}
                bars={[
                  { name: `LN ròng ${baseLabel}`, values: base.map((bucket) => bucket.netProfit), color: "#c7d2fe" },
                  { name: "LN ròng kịch bản", values: scenario.map((bucket) => bucket.netProfit), color: "#4f46e5" },
                ]}
                lines={[{ name: "LN ròng thực đạt", values: data.totals.map((bucket, index) => (index <= upTo ? bucket.netProfit : Number.NaN)), color: "#059669" }]}
                height={280}
              />
            </Card>
            <Card title="Độ lệch của tổng lợi nhuận ròng theo cửa hàng" subtitle={`Kịch bản trừ ${baseLabel.toLowerCase()}, lũy kế ${upTo + 1} tháng`} icon="storefront" bodyClassName="px-2 pb-3">
              {branchDeviation.length > 0 ? <HorizontalBarChart rows={branchDeviation} height={Math.max(200, 40 * branchDeviation.length + 60)} /> : <p className="py-10 text-center text-sm text-slate-400">Chưa có dữ liệu theo cửa hàng.</p>}
            </Card>
          </div>

          <Card title="Biến động P&L các tháng tác động" subtitle={`Từ tháng ${fromMonth + 1} tới hết năm — doanh thu và lợi nhuận ròng gốc so với kịch bản`} icon="table_rows" bodyClassName="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead><tr className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-200"><th className="px-4 py-2.5 font-bold">Tháng</th><th className="px-3 py-2.5 font-bold text-right">Doanh thu gốc</th><th className="px-3 py-2.5 font-bold text-right">Doanh thu kịch bản</th><th className="px-3 py-2.5 font-bold text-right">LN gộp kịch bản</th><th className="px-3 py-2.5 font-bold text-right">LN ròng gốc</th><th className="px-3 py-2.5 font-bold text-right">LN ròng kịch bản</th><th className="px-3 py-2.5 font-bold text-right">Δ LN ròng</th><th className="px-3 py-2.5 font-bold text-right">Biên LN ròng</th></tr></thead>
              <tbody>
                {impactedMonths.map((index) => {
                  const delta = scenario[index].netProfit - base[index].netProfit;
                  return (
                    <tr key={index} className="border-t border-slate-100">
                      <td className="px-4 py-2 font-semibold">Tháng {index + 1}</td>
                      <td className="px-3 py-2 text-right text-slate-500 whitespace-nowrap">{fmtMoney(base[index].revenue)}</td>
                      <td className="px-3 py-2 text-right font-semibold whitespace-nowrap">{fmtMoney(scenario[index].revenue)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(scenario[index].grossProfit)}</td>
                      <td className="px-3 py-2 text-right text-slate-500 whitespace-nowrap">{fmtMoney(base[index].netProfit)}</td>
                      <td className="px-3 py-2 text-right font-bold whitespace-nowrap">{fmtMoney(scenario[index].netProfit)}</td>
                      <td className={`px-3 py-2 text-right font-bold whitespace-nowrap ${delta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{signedMoney(delta)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{pctText(ratioOf(scenario[index].netProfit, scenario[index].revenue))}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold">
                  <td className="px-4 py-2">Cộng</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(impactedMonths.reduce((sum, index) => sum + base[index].revenue, 0))}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(impactedMonths.reduce((sum, index) => sum + scenario[index].revenue, 0))}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(impactedMonths.reduce((sum, index) => sum + scenario[index].grossProfit, 0))}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(impactedMonths.reduce((sum, index) => sum + base[index].netProfit, 0))}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtMoney(impactedMonths.reduce((sum, index) => sum + scenario[index].netProfit, 0))}</td>
                  <td className={`px-3 py-2 text-right whitespace-nowrap ${netDelta >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{signedMoney(impactedMonths.reduce((sum, index) => sum + scenario[index].netProfit - base[index].netProfit, 0))}</td>
                  <td className="px-3 py-2 text-right">{pctText(ratioOf(impactedMonths.reduce((sum, index) => sum + scenario[index].netProfit, 0), impactedMonths.reduce((sum, index) => sum + scenario[index].revenue, 0)))}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      </div>
    </div>
  );
}
