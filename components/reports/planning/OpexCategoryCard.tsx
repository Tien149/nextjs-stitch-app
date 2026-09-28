"use client";

import React, { useState } from "react";
import { opexGroupRank } from "@/lib/pnl-ordering";
import type { PnlNoteKind } from "@/lib/pnl-note";
import { TrendLineChart } from "@/components/charts/ReportCharts";
import { money } from "@/components/reports/report-ui";
import PnlNoteBox from "@/components/reports/planning/PnlNoteBox";
import { Card, Segmented, fmtMoney, pctText, ratioOf } from "@/components/reports/planning/planning-ui";
import { lastPicked, monthPickLabel, sumMonths, type MonthPick, type PlannedGroup, type PlanningData } from "@/components/reports/planning/planning-types";

/**
 * Ba khối "CP cố định / CP biến đổi / CP Marketing so với doanh thu" — học theo slide "Chi phí
 * vận hành cố định" của khách (28/09/2026), đứng cạnh hai chart COGS và Lương:
 *  1. Chart đường Doanh thu – Ngân sách – Thực hiện theo tháng.
 *  2. Bảng tháng: doanh thu, ngân sách, thực hiện, % thực hiện, tỷ trọng trên doanh thu.
 *  3. Nhận xét tự động (vượt ngân sách bao nhiêu, lệch tỷ trọng bao nhiêu điểm %, doanh thu phải
 *     đạt bao nhiêu để giữ tỷ trọng) + ô ghi chú nguyên nhân / dự trù theo tháng.
 *  4. Bảng bóc tách từng hạng mục x tháng, cộng, % tỷ trọng trên doanh thu, kèm các dòng doanh thu.
 *
 * Chia nhóm theo đúng luật thẻ KPI của Dashboard: nhận nhóm OPEX theo tên (opexGroupRank);
 * nhóm khác và chứng từ chưa gán hạng mục dồn vào CP cố định, để ba khối cộng lại đúng OPEX.
 */

type Category = "fixed" | "variable" | "marketing";
const CATEGORIES: Array<{ id: Category; label: string; ranks: number[]; kind: PnlNoteKind; color: string }> = [
  { id: "fixed", label: "CP cố định", ranks: [0, 3], kind: "COST_FIXED", color: "#e11d48" },
  { id: "variable", label: "CP biến đổi", ranks: [2], kind: "COST_VARIABLE", color: "#0d9488" },
  { id: "marketing", label: "CP Marketing", ranks: [1], kind: "COST_MARKETING", color: "#ea580c" },
];

type Row = { key: string; name: string; months: number[]; plan: number[] | null; group?: boolean; muted?: boolean };

const num = (value: number) => money(Math.round(value));
const sumAt = (rows: Array<{ months: number[] }>, index: number) => rows.reduce((sum, row) => sum + (row.months[index] || 0), 0);

export default function OpexCategoryCard({ data, picked, monthHeaders }: { data: PlanningData; picked: MonthPick; monthHeaders: string[] }) {
  const [categoryId, setCategoryId] = useState<Category>("fixed");
  const category = CATEGORIES.find((item) => item.id === categoryId) || CATEGORIES[0];
  const monthIndexes = data.months.map((_, index) => index);

  const opexLine = data.statement.find((line) => line.key === "otherOpex");
  const opexGroups = opexLine?.groups || [];
  const groupsOf = (ranks: number[]) => opexGroups.filter((group) => ranks.includes(opexGroupRank(group.name)));
  const planOf = (groups: PlannedGroup[], index: number) => groups.reduce((sum, group) => sum + (group.plan?.[index] || 0), 0);

  // Tổng từng tháng của ba khối — khối cố định lấy phần còn lại của OPEX, cùng luật thẻ KPI.
  const marketingGroups = groupsOf([1]);
  const variableGroups = groupsOf([2]);
  const totalsOf = (id: Category) => {
    if (id === "marketing") return { actual: monthIndexes.map((index) => sumAt(marketingGroups, index)), budget: monthIndexes.map((index) => planOf(marketingGroups, index)) };
    if (id === "variable") return { actual: monthIndexes.map((index) => sumAt(variableGroups, index)), budget: monthIndexes.map((index) => planOf(variableGroups, index)) };
    return {
      actual: monthIndexes.map((index) => data.totals[index].otherOpex - sumAt(marketingGroups, index) - sumAt(variableGroups, index)),
      budget: monthIndexes.map((index) => data.plans[index].otherOpex - planOf(marketingGroups, index) - planOf(variableGroups, index)),
    };
  };
  const revenue = data.totals.map((bucket) => bucket.revenue);
  const planRevenue = data.plans.map((bucket) => bucket.revenue);
  /**
   * Ngân sách chạy theo doanh thu THỰC TẾ, giống slide của khách (28/09/2026: "CP vận hành cố
   * định (30%)" = 30% × doanh thu thực tế từng tháng). Tỷ trọng phân bổ lấy từ tab Ngân sách:
   * ngân sách chi phí ÷ doanh thu kế hoạch cùng tháng, rồi nhân lại cho doanh thu thực tế.
   * Tháng chưa có doanh thu thực tế (tháng tới) hoặc chưa set doanh thu kế hoạch thì giữ nguyên
   * số tiền ngân sách — không suy được tỷ trọng, và tháng tới cần số dự trù để nhìn trước.
   */
  const toActualBasis = (plan: number[] | null) =>
    plan ? monthIndexes.map((index) => (planRevenue[index] > 0 && revenue[index] > 0 ? ((plan[index] || 0) / planRevenue[index]) * revenue[index] : plan[index] || 0)) : null;
  const totals = totalsOf(category.id);
  const actual = totals.actual;
  const budget = toActualBasis(totals.budget) || [];
  const hasBudget = budget.some((value) => Math.abs(value) > 0.5);
  // Chỉ tính các tháng đang tick mà ĐÃ có số (doanh thu hoặc chi phí): tháng chưa tới không kéo
  // bình quân xuống, không cộng ngân sách của tháng chưa chi vào so sánh, không so "−100%".
  const active = monthIndexes.map((index) => Math.abs(revenue[index]) + Math.abs(actual[index]) > 0.5);
  const shown = [...picked].sort((a, b) => a - b).filter((index) => active[index]);

  const monthRows = shown.map((index) => {
    // Ngân sách đã nhân theo doanh thu thực tế nên tỷ trọng phân bổ = ngân sách ÷ doanh thu thực tế.
    const budgetRatio = ratioOf(budget[index], revenue[index]);
    return {
      index,
      revenue: revenue[index],
      budget: budget[index],
      actual: actual[index],
      rate: ratioOf(actual[index], budget[index]),
      share: ratioOf(actual[index], revenue[index]),
      budgetRatio,
      requiredRevenue: budgetRatio && budgetRatio > 0 ? actual[index] / budgetRatio : null,
    };
  });
  const sum = {
    revenue: sumMonths(revenue, shown),
    budget: sumMonths(budget, shown),
    actual: sumMonths(actual, shown),
  };
  const sumBudgetRatio = hasBudget ? ratioOf(sum.budget, sum.revenue) : null;
  const sumShare = ratioOf(sum.actual, sum.revenue);
  const sumRate = ratioOf(sum.actual, sum.budget);

  // ---- Nhận xét tự động -------------------------------------------------------------------
  const pickLabel = monthPickLabel(shown);
  const label = category.label;
  const remarks: React.ReactNode[] = [];
  if (shown.length > 0) {
    if (hasBudget && sum.budget > 0) {
      const gap = sum.actual - sum.budget;
      remarks.push(
        <>So với ngân sách, lũy kế {pickLabel} {label} thực hiện <b>{fmtMoney(sum.actual)}</b> / ngân sách <b>{fmtMoney(sum.budget)}</b> —{" "}
          <b className={gap > 0 ? "text-rose-600" : "text-emerald-600"}>{gap > 0 ? "vượt" : "còn dư"} {pctText(Math.abs(gap) / sum.budget, 2)} ({fmtMoney(Math.abs(gap))})</b>.</>,
      );
    } else {
      remarks.push(<>Chưa set ngân sách {label} cho {pickLabel} — set theo hạng mục OPEX ở tab <b>Ngân sách</b> để có cột so sánh.</>);
    }
    if (sumShare !== null && sumBudgetRatio !== null) {
      const diff = sumShare - sumBudgetRatio;
      remarks.push(
        <>Tỷ trọng {label}/doanh thu thực tế <b>{pctText(sumShare, 2)}</b>, so với tỷ trọng phân bổ <b>{pctText(sumBudgetRatio, 2)}</b> —{" "}
          <b className={diff > 0 ? "text-rose-600" : "text-emerald-600"}>{diff > 0 ? "cao hơn" : "thấp hơn"} {(Math.abs(diff) * 100).toFixed(2)} điểm %</b>.</>,
      );
      if (sumBudgetRatio > 0) {
        const perMonth = sum.actual / shown.length;
        const needRevenue = perMonth / sumBudgetRatio;
        const allowedCost = (sum.revenue / shown.length) * sumBudgetRatio;
        const reached = shown.filter((index) => revenue[index] >= needRevenue).map((index) => `T${index + 1}`);
        remarks.push(
          <>Với mức chi bình quân {fmtMoney(perMonth)}/tháng, để giữ tỷ trọng {pctText(sumBudgetRatio, 2)} thì doanh thu mỗi tháng phải đạt ít nhất <b>{fmtMoney(needRevenue)}</b>
            {reached.length > 0 ? <> (mới chạm được ở {reached.join(", ")})</> : <> (chưa tháng nào chạm)</>}; hoặc giữ doanh thu như hiện tại thì {label} phải về <b>{fmtMoney(allowedCost)}</b>/tháng.</>,
        );
      }
    } else if (sumShare !== null) {
      remarks.push(<>Tỷ trọng {label}/doanh thu thực tế lũy kế <b>{pctText(sumShare, 2)}</b>.</>);
    }
  }

  // ---- Bảng bóc tách ----------------------------------------------------------------------
  const categoryGroups = groupsOf(category.ranks);
  const itemRows: Row[] = [];
  const multiGroup = categoryGroups.length > 1;
  for (const group of categoryGroups) {
    if (multiGroup) itemRows.push({ key: `g-${group.code}`, name: group.name, months: group.months, plan: toActualBasis(group.plan), group: true });
    for (const item of group.items) itemRows.push({ key: `i-${group.code}-${item.code}`, name: item.name, months: item.months, plan: toActualBasis(item.plan) });
  }
  // Phần OPEX chưa gán hạng mục (hoặc set kế hoạch thẳng vào dòng OPEX) nằm trong CP cố định.
  if (category.id === "fixed") {
    const listed = monthIndexes.map((index) => sumAt(categoryGroups, index));
    const residual = monthIndexes.map((index) => actual[index] - listed[index]);
    const listedPlan = toActualBasis(monthIndexes.map((index) => planOf(categoryGroups, index))) || [];
    const residualPlan = monthIndexes.map((index) => budget[index] - listedPlan[index]);
    if (residual.some((value) => Math.abs(value) > 0.5) || residualPlan.some((value) => Math.abs(value) > 0.5)) {
      itemRows.push({ key: "residual", name: "Chưa gán hạng mục P&L / ngân sách set chung dòng OPEX", months: residual, plan: residualPlan, muted: true });
    }
  }
  const revenueLine = data.statement.find((line) => line.key === "revenue");
  const incomeLine = data.statement.find((line) => line.key === "otherIncome");
  const otherIncome = data.totals.map((bucket) => bucket.otherIncome);
  const hasOtherIncome = shown.some((index) => Math.abs(otherIncome[index]) > 0.5);

  // Biến động lớn nhất của tháng cuối đang xem so với tháng liền trước — gợi ý chỗ cần ghi nguyên nhân.
  const lastIndex = lastPicked(shown);
  const movers = lastIndex > 0
    ? itemRows
      .filter((row) => !row.group)
      .map((row) => ({ name: row.name, diff: (row.months[lastIndex] || 0) - (row.months[lastIndex - 1] || 0), base: row.months[lastIndex - 1] || 0 }))
      .filter((row) => Math.abs(row.diff) > 0.5)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 4)
    : [];

  const orNaN = (values: number[], keep: (index: number) => boolean) => values.map((value, index) => (keep(index) ? value : Number.NaN));

  const pctCell = (value: number, base: number) => (base ? `${((value / base) * 100).toFixed(2)}%` : "—");
  const changeHint = (values: number[], index: number) => {
    if (index === 0) return undefined;
    const previous = values[index - 1] || 0;
    const diff = (values[index] || 0) - previous;
    if (Math.abs(diff) <= 0.5) return `Bằng T${index}`;
    return `${diff > 0 ? "Tăng" : "Giảm"} ${num(Math.abs(diff))} so với T${index}${previous ? ` (${diff > 0 ? "+" : "−"}${Math.abs((diff / previous) * 100).toFixed(1)}%)` : ""}`;
  };
  const th = "px-2.5 py-2 font-bold text-right whitespace-nowrap";
  const td = "px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap";
  const sticky = "sticky left-0 z-10";

  const renderRow = (row: Row, className: string, stickyBg: string) => {
    const total = sumMonths(row.months, shown);
    const planTotal = row.plan ? sumMonths(row.plan, shown) : 0;
    return (
      <tr key={row.key} className={className}>
        <td className={`${sticky} ${stickyBg} px-3 py-1.5 whitespace-nowrap ${row.group ? "font-bold text-slate-700" : row.muted ? "italic text-slate-500" : "pl-5 text-slate-700"}`}>{row.name}</td>
        {shown.map((index) => <td key={index} className={td} title={changeHint(row.months, index)}>{num(row.months[index] || 0)}</td>)}
        <td className={`${td} font-bold bg-amber-50/60`}>{num(total)}</td>
        <td className={`${td} text-slate-500`}>{row.plan ? num(planTotal) : "—"}</td>
        <td className={`${td} font-semibold ${planTotal && total > planTotal ? "text-rose-600" : "text-slate-600"}`}>{planTotal ? pctCell(total, planTotal) : "—"}</td>
        <td className={`${td} font-semibold bg-sky-50/60`}>{pctCell(total, sum.revenue)}</td>
        {shown.map((index) => <td key={index} className={`${td} text-slate-500`}>{pctCell(row.months[index] || 0, revenue[index])}</td>)}
      </tr>
    );
  };
  const infoRow = (key: string, name: string, months: number[], className: string, stickyBg: string, bold = false) => {
    const total = sumMonths(months, shown);
    return (
      <tr key={key} className={className}>
        <td className={`${sticky} ${stickyBg} px-3 py-1.5 whitespace-nowrap ${bold ? "font-extrabold" : "pl-5"}`}>{name}</td>
        {shown.map((index) => <td key={index} className={`${td} ${bold ? "font-bold" : ""}`}>{num(months[index] || 0)}</td>)}
        <td className={`${td} font-bold`}>{num(total)}</td>
        <td className={td} />
        <td className={td} />
        <td className={`${td} font-semibold`}>{pctCell(total, sum.revenue)}</td>
        {shown.map((index) => <td key={index} className={`${td} text-slate-500`}>{pctCell(months[index] || 0, revenue[index])}</td>)}
      </tr>
    );
  };

  return (
    <Card
      title={`${label} so với doanh thu`}
      subtitle="Ngân sách = tỷ trọng phân bổ (tab Ngân sách: chi phí ÷ doanh thu kế hoạch) × doanh thu thực tế từng tháng; tháng chưa có doanh thu giữ số dự trù. Nhóm OPEX nhận theo tên: cố định / biến đổi / marketing; nhóm khác và chứng từ chưa gán hạng mục tính vào CP cố định."
      icon="receipt_long"
      right={<Segmented value={categoryId} onChange={setCategoryId} options={CATEGORIES.map((item) => ({ id: item.id, label: item.label }))} />}
      bodyClassName="px-2 pb-4 space-y-4"
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
        <div className="min-w-0">
          <TrendLineChart
            labels={monthHeaders}
            height={320}
            series={[
              { name: "Doanh thu", values: orNaN(revenue, (index) => active[index]), color: "#b91c1c" },
              ...(hasBudget ? [{ name: "Ngân sách", values: orNaN(budget, (index) => Math.abs(budget[index]) > 0.5), color: "#7c3aed", dashed: true }] : []),
              { name: "Thực hiện", values: orNaN(actual, (index) => active[index]), color: "#16a34a" },
            ]}
          />
        </div>
        <div className="min-w-0 overflow-x-auto px-2 xl:px-0 xl:pr-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-2 py-2 text-left font-bold">Tháng</th>
                <th className={th}>Doanh thu</th>
                <th className={th}>Ngân sách</th>
                <th className={th}>Thực hiện</th>
                <th className={th}>% TH</th>
                <th className={th}>% / DT</th>
              </tr>
            </thead>
            <tbody>
              {monthRows.length === 0 && <tr><td colSpan={6} className="px-2 py-6 text-center text-slate-400">Các tháng đang chọn chưa có doanh thu hay {label}.</td></tr>}
              {monthRows.map((row) => (
                <tr key={row.index} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-semibold text-slate-700">{`${String(row.index + 1).padStart(2, "0")}/${data.year}`}</td>
                  <td className={td}>{num(row.revenue)}</td>
                  <td className={`${td} text-slate-500`}>{hasBudget ? num(row.budget) : "—"}</td>
                  <td className={`${td} font-semibold`}>{num(row.actual)}</td>
                  <td className={`${td} font-bold ${row.rate !== null && row.rate > 1 ? "text-rose-600" : "text-emerald-600"}`}>{pctText(row.rate, 2)}</td>
                  <td className={td} title={row.budgetRatio !== null ? `Tỷ trọng ngân sách ${pctText(row.budgetRatio, 2)}${row.requiredRevenue ? ` · DT cần để giữ tỷ trọng: ${num(row.requiredRevenue)}` : ""}` : undefined}>{pctText(row.share, 2)}</td>
                </tr>
              ))}
              {monthRows.length > 0 && (
                <tr className="border-t-2 border-slate-300 bg-slate-50 font-extrabold">
                  <td className="px-2 py-1.5">Cộng</td>
                  <td className={td}>{num(sum.revenue)}</td>
                  <td className={td}>{hasBudget ? num(sum.budget) : "—"}</td>
                  <td className={td}>{num(sum.actual)}</td>
                  <td className={`${td} ${sumRate !== null && sumRate > 1 ? "text-rose-600" : "text-emerald-600"}`}>{pctText(sumRate, 2)}</td>
                  <td className={td}>{pctText(sumShare, 2)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)] px-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-sm leading-relaxed text-slate-700">
          <p className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wide text-slate-500">Nhận xét tự động — {label}, {pickLabel}</p>
          {remarks.length === 0 ? <p className="text-slate-400">Chọn tháng để xem nhận xét.</p> : <ul className="list-disc space-y-1.5 pl-5">{remarks.map((remark, index) => <li key={index}>{remark}</li>)}</ul>}
          {movers.length > 0 && (
            <div className="mt-3 border-t border-slate-200 pt-2">
              <p className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500">Biến động lớn nhất T{lastIndex + 1} so với T{lastIndex}</p>
              <ul className="mt-1 space-y-0.5 text-[13px]">
                {movers.map((row) => (
                  <li key={row.name} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">{row.name}</span>
                    <b className={`shrink-0 tabular-nums ${row.diff > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                      {row.diff > 0 ? "+" : "−"}{num(Math.abs(row.diff))}{row.base ? ` (${row.diff > 0 ? "+" : "−"}${Math.abs((row.diff / row.base) * 100).toFixed(1)}%)` : ""}
                    </b>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <PnlNoteBox
          key={category.kind}
          kind={category.kind}
          year={data.year}
          branchCode={data.branchCode}
          months={data.months}
          monthHeaders={monthHeaders}
          defaultMonth={lastIndex >= 0 ? lastIndex : new Date().getMonth()}
          placeholder={(month) => `${label} tháng ${month + 1}: nguyên nhân tăng/giảm (hạng mục nào, vì sao), hướng xử lý, dự trù chi phí phải đạt tháng tới...`}
        />
      </div>

      {shown.length > 0 && (
        <div className="overflow-x-auto px-2">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 bg-amber-50 text-[11px] text-slate-600">
                <th className={`${sticky} bg-amber-50 px-3 py-2 text-left font-bold`}>Nội dung</th>
                {shown.map((index) => <th key={index} className={th}>{`${String(index + 1).padStart(2, "0")}.${data.year}`}</th>)}
                <th className={th}>Cộng {pickLabel}</th>
                <th className={th}>Ngân sách</th>
                <th className={th}>% TH</th>
                <th className={th}>% Tỷ trọng<br />cộng/DT</th>
                {shown.map((index) => <th key={index} className={th}>% Tỷ trọng<br />{`${String(index + 1).padStart(2, "0")}/DT`}</th>)}
              </tr>
            </thead>
            <tbody>
              {itemRows.length === 0 && (
                <tr><td colSpan={shown.length * 2 + 5} className="px-3 py-6 text-center text-slate-400">Danh mục chưa có nhóm OPEX nào mang tên &quot;{category.id === "marketing" ? "marketing" : category.id === "variable" ? "biến đổi" : "cố định"}&quot;.</td></tr>
              )}
              {itemRows.map((row) => renderRow(row, `border-t border-slate-100 ${row.group ? "bg-slate-50" : ""}`, row.group ? "bg-slate-50" : "bg-white"))}
              {renderRow({ key: "total", name: label, months: actual, plan: hasBudget ? budget : null }, "border-y-2 border-rose-200 bg-rose-50 font-extrabold text-rose-900", "bg-rose-50")}
              {(revenueLine?.groups || []).map((group) => infoRow(`rev-${group.code}`, group.name, group.months, "border-t border-slate-100 text-slate-600", "bg-white"))}
              {infoRow("revenue", "Doanh thu", revenue, "border-y-2 border-lime-300 bg-lime-100 text-lime-900", "bg-lime-100", true)}
              {hasOtherIncome && (incomeLine?.groups || []).map((group) => infoRow(`inc-${group.code}`, group.name, group.months, "border-t border-slate-100 text-slate-600", "bg-white"))}
              {hasOtherIncome && infoRow("revenue-income", "Cộng DT & TN", monthIndexes.map((index) => revenue[index] + otherIncome[index]), "border-t-2 border-slate-300 bg-slate-100", "bg-slate-100", true)}
            </tbody>
          </table>
          <p className="mt-1.5 text-[11px] text-slate-400">Rê chuột vào ô số tiền tháng để xem tăng/giảm so với tháng trước. % Tỷ trọng = số tiền ÷ doanh thu cùng tháng.</p>
        </div>
      )}
    </Card>
  );
}
