"use client";

import React, { useMemo, useState } from "react";
import { opexGroupRank } from "@/lib/pnl-ordering";
import { DonutLegendChart, MoneyLineChart } from "@/components/charts/ReportCharts";
import { Card, MonthChips, NoPlanNotice, ProgressBar, StatCard, StatusBadge, Tag, budgetStatusOf, fmtCompact, fmtMoney, pctText, ratioOf, type Tone } from "@/components/reports/planning/planning-ui";
import { EXPENSE_LINE_KEYS, LINE_SHORT_LABEL, sumAll, sumRange, type PlanningData, type StatementLine } from "@/components/reports/planning/planning-types";

/**
 * Màn "Định mức chi phí & ngân sách" học theo phần mềm mẫu: 5 thẻ (tổng ngân sách, đã chi,
 * còn lại, tỷ lệ tiêu hao, số hạng mục vượt), chart biến động KH/TT theo tháng, donut cơ cấu
 * chi phí, và bảng kiểm soát định mức từng hạng mục với thanh tiêu hao + badge trạng thái.
 * Số lũy kế tới tháng đang chọn; ngân sách lấy từ tab Ngân sách (ReportTarget).
 */

type ControlRow = {
  key: string;
  level: 0 | 1 | 2;
  label: string;
  lineKey: string;
  groupName: string | null;
  plan: number | null;
  actual: number;
  code: string | null;
};

const LINE_TONE: Record<string, Tone> = { cogs: "amber", payroll: "sky", otherOpex: "blue", depreciation: "slate" };

function natureLabel(lineKey: string, groupName: string | null) {
  if (lineKey === "cogs") return "Biến đổi";
  if (lineKey === "payroll" || lineKey === "depreciation") return "Cố định";
  const rank = opexGroupRank(groupName);
  return rank === 0 ? "Cố định" : rank === 1 ? "Marketing" : rank === 2 ? "Biến đổi" : "Khác";
}

export default function BudgetControlTab({ data, upTo, onChangeUpTo, onOpenBudget }: { data: PlanningData; upTo: number; onChangeUpTo: (index: number) => void; onOpenBudget?: () => void }) {
  const [lineFilter, setLineFilter] = useState<string>("ALL");
  const [groupFilter, setGroupFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const expenseLines = useMemo(
    () => EXPENSE_LINE_KEYS.map((key) => data.statement.find((line) => line.key === key)).filter((line): line is StatementLine => Boolean(line)),
    [data.statement],
  );
  const visibleLines = expenseLines.filter((line) => lineFilter === "ALL" || line.key === lineFilter);
  const groupOptions = visibleLines.flatMap((line) => line.groups.map((group) => ({ code: `${line.key}:${group.code}`, name: group.name })));

  // Kế hoạch cấp dòng: dòng OPEX = tổng hạng mục (khi có), dòng khác = target set thẳng.
  const rows: ControlRow[] = [];
  for (const line of visibleLines) {
    const linePlan = sumRange(line.plan, upTo);
    rows.push({ key: line.key, level: 0, label: LINE_SHORT_LABEL[line.key] || line.label, lineKey: line.key, groupName: null, plan: linePlan > 0 ? linePlan : null, actual: sumRange(line.months, upTo), code: null });
    for (const group of line.groups) {
      const groupKey = `${line.key}:${group.code}`;
      if (groupFilter !== "ALL" && groupFilter !== groupKey) continue;
      const groupPlan = group.plan ? sumRange(group.plan, upTo) : null;
      const groupActual = sumRange(group.months, upTo);
      if (!groupPlan && Math.abs(groupActual) <= 0.5) continue;
      rows.push({ key: groupKey, level: 1, label: group.name, lineKey: line.key, groupName: group.name, plan: groupPlan && groupPlan > 0 ? groupPlan : null, actual: groupActual, code: group.code === "UNGROUPED" ? null : group.code });
      for (const item of group.items) {
        const itemPlan = item.plan ? sumRange(item.plan, upTo) : null;
        const itemActual = sumRange(item.months, upTo);
        if (!itemPlan && Math.abs(itemActual) <= 0.5) continue;
        rows.push({ key: `${groupKey}:${item.code}`, level: 2, label: item.name, lineKey: line.key, groupName: group.name, plan: itemPlan && itemPlan > 0 ? itemPlan : null, actual: itemActual, code: item.code === "UNCLASSIFIED" ? null : item.code });
      }
    }
  }
  const filteredRows = statusFilter === "ALL" ? rows : rows.filter((row) => row.level === 0 || budgetStatusOf(ratioOf(row.actual, row.plan || 0)) === statusFilter);

  // KPI: chỉ cộng những dòng đã set ngân sách để tỷ lệ tiêu hao không bị méo bởi dòng chưa set.
  const plannedLines = visibleLines.filter((line) => sumRange(line.plan, upTo) > 0);
  const totalPlan = plannedLines.reduce((sum, line) => sum + sumRange(line.plan, upTo), 0);
  const spentOnPlanned = plannedLines.reduce((sum, line) => sum + sumRange(line.months, upTo), 0);
  const totalActual = visibleLines.reduce((sum, line) => sum + sumRange(line.months, upTo), 0);
  const usage = ratioOf(spentOnPlanned, totalPlan);
  const leafRows = rows.filter((row) => row.level === 2 || (row.level === 1 && !rows.some((child) => child.key.startsWith(`${row.key}:`))));
  const leafWithPlan = leafRows.filter((row) => row.plan !== null);
  const overCount = leafWithPlan.filter((row) => row.actual > (row.plan as number)).length;

  const monthlyPlan = data.months.map((_, index) => visibleLines.reduce((sum, line) => sum + (line.plan[index] || 0), 0));
  const monthlyActual = data.months.map((_, index) => visibleLines.reduce((sum, line) => sum + (line.months[index] || 0), 0));
  const donutData = lineFilter === "ALL"
    ? expenseLines.map((line) => ({ name: LINE_SHORT_LABEL[line.key] || line.label, value: sumRange(line.months, upTo) }))
    : visibleLines.flatMap((line) => line.groups.map((group) => ({ name: group.name, value: sumRange(group.months, upTo) })));

  const indent = { 0: "", 1: "pl-5", 2: "pl-10" } as const;

  return (
    <div className="space-y-4">
      {!data.hasPlan && <NoPlanNotice year={data.year} />}
      <Card bodyClassName="px-4 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3 pt-4">
          <div className="flex items-start gap-3">
            <span className="h-10 w-10 rounded-xl bg-indigo-50 text-indigo-600 grid place-items-center"><span className="material-symbols-outlined">price_check</span></span>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Hoạch định tài chính</p>
              <h2 className="text-lg font-extrabold text-slate-800">Định mức Chi phí & Ngân sách</h2>
              <p className="text-xs text-slate-500">Theo dõi ngân sách kế hoạch, chi phí thực tế và mức tiêu hao từ dữ liệu Dự báo P&L năm {data.year}.</p>
            </div>
          </div>
          {onOpenBudget && (
            <button type="button" onClick={onOpenBudget} className="flex items-center gap-1 text-xs font-bold text-indigo-700 border border-indigo-200 rounded-lg px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100">
              <span className="material-symbols-outlined text-base">edit_calendar</span>Set định mức
            </button>
          )}
        </div>
        <div className="mt-4"><MonthChips upTo={upTo} onChange={onChangeUpTo} /></div>
        <div className="mt-3 grid sm:grid-cols-3 gap-3">
          <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Nhóm lớn
            <select className="control mt-1 py-2 text-xs font-semibold normal-case" value={lineFilter} onChange={(event) => { setLineFilter(event.target.value); setGroupFilter("ALL"); }}>
              <option value="ALL">Tất cả nhóm chi phí</option>
              {expenseLines.map((line) => <option key={line.key} value={line.key}>{LINE_SHORT_LABEL[line.key] || line.label}</option>)}
            </select>
          </label>
          <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Danh mục
            <select className="control mt-1 py-2 text-xs font-semibold normal-case" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
              <option value="ALL">Tất cả danh mục</option>
              {groupOptions.map((option) => <option key={option.code} value={option.code}>{option.name}</option>)}
            </select>
          </label>
          <label className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Trạng thái
            <select className="control mt-1 py-2 text-xs font-semibold normal-case" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="ALL">Tất cả trạng thái</option>
              <option value="OK">Đúng định mức</option>
              <option value="WATCH">Cần chú ý (trên 90%)</option>
              <option value="OVER">Vượt ngân sách</option>
              <option value="NONE">Chưa set định mức</option>
            </select>
          </label>
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <StatCard label="Tổng ngân sách" tone="indigo" icon="account_balance_wallet" value={fmtMoney(totalPlan)} sub={`Lũy kế ${upTo + 1} tháng năm ${data.year}`} />
        <StatCard label="Thực tế đã chi" tone="blue" icon="payments" value={fmtMoney(totalActual)} sub={totalPlan > 0 ? `Trên dòng có ngân sách: ${fmtCompact(spentOnPlanned)}` : "Từ bút toán đã ghi sổ"} />
        <StatCard label="Còn lại / Chênh lệch" tone={totalPlan - spentOnPlanned >= 0 ? "emerald" : "rose"} icon="savings" value={fmtMoney(totalPlan - spentOnPlanned)} sub="Ngân sách trừ thực chi" />
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600">Tỷ lệ tiêu hao</p>
          <p className={`mt-1.5 text-xl font-extrabold ${usage !== null && usage > 1 ? "text-rose-600" : usage !== null && usage > 0.9 ? "text-amber-600" : "text-emerald-600"}`}>{pctText(usage)}</p>
          <ProgressBar rate={usage} className="mt-2" />
          <p className="mt-1.5 text-[11px] text-slate-500">{usage === null ? "Chưa có ngân sách để so" : usage > 1 ? "Đã vượt ngân sách" : "Trong định mức"}</p>
        </div>
        <StatCard label="Vượt định mức" tone={overCount > 0 ? "rose" : "emerald"} icon="report" value={`${overCount}/${leafWithPlan.length}`} sub="Hạng mục vượt / hạng mục có ngân sách" />
      </div>

      <div className="grid xl:grid-cols-[2fr_1fr] gap-4">
        <Card title="Biến động theo tháng" subtitle="So sánh ngân sách kế hoạch và chi phí thực tế theo từng tháng" icon="show_chart" right={<Tag tone="indigo">{lineFilter === "ALL" ? "Tất cả chi phí" : LINE_SHORT_LABEL[lineFilter]}</Tag>} bodyClassName="px-2 pb-3">
          <MoneyLineChart labels={monthHeaders} series={[{ name: "Kế hoạch", values: monthlyPlan, color: "#6366f1", dashed: true }, { name: "Thực tế", values: monthlyActual, color: "#f97316" }]} height={260} />
        </Card>
        <Card title="Cơ cấu chi phí" subtitle={`Thực tế lũy kế ${upTo + 1} tháng`} icon="donut_small" bodyClassName="px-4 pb-4">
          <DonutLegendChart data={donutData} height={220} top={6} />
        </Card>
      </div>

      <Card title="Bảng kiểm soát định mức" subtitle={`Các dòng chi phí đang lọc theo lũy kế ${upTo + 1} tháng năm ${data.year}`} icon="rule" right={<span className="text-xs font-bold text-slate-500">{filteredRows.filter((row) => row.level > 0).length} hạng mục</span>} bodyClassName="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="px-4 py-3 font-bold min-w-[260px]">Hạng mục</th>
              <th className="px-3 py-3 font-bold">Tính chất</th>
              <th className="px-3 py-3 font-bold text-right">Kế hoạch</th>
              <th className="px-3 py-3 font-bold text-right">Thực tế</th>
              <th className="px-3 py-3 font-bold text-right">Còn lại</th>
              <th className="px-3 py-3 font-bold min-w-[160px]">Tiêu hao</th>
              <th className="px-3 py-3 font-bold text-center">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => {
              const rate = row.plan ? row.actual / row.plan : null;
              const remaining = row.plan !== null ? row.plan - row.actual : null;
              const tone = LINE_TONE[row.lineKey] || "slate";
              return (
                <tr key={row.key} className={`border-t border-slate-100 ${row.level === 0 ? "bg-slate-50" : "hover:bg-slate-50/60"}`}>
                  <td className={`px-4 py-2.5 ${indent[row.level]}`}>
                    <span className={`flex items-center gap-2 ${row.level === 0 ? "font-extrabold text-slate-800" : row.level === 1 ? "font-bold text-slate-700" : "text-slate-600"}`}>
                      <span className={`h-2 w-2 rounded-full ${{ amber: "bg-amber-500", sky: "bg-sky-500", blue: "bg-blue-500", slate: "bg-slate-400" }[tone as "amber" | "sky" | "blue" | "slate"] || "bg-slate-400"} ${row.level === 2 ? "opacity-40" : ""}`} />
                      <span className="whitespace-nowrap">{row.label}</span>
                      {row.code && row.level === 2 && <span className="text-[10px] text-slate-400">{row.code}</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2.5"><Tag tone={row.level === 0 ? "indigo" : "slate"}>{row.level === 0 ? "Tổng nhóm" : natureLabel(row.lineKey, row.groupName)}</Tag></td>
                  <td className="px-3 py-2.5 text-right font-bold whitespace-nowrap">{row.plan !== null ? fmtCompact(row.plan) : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">{fmtCompact(row.actual)}</td>
                  <td className={`px-3 py-2.5 text-right font-bold whitespace-nowrap ${remaining === null ? "text-slate-300" : remaining < 0 ? "text-rose-600" : "text-emerald-600"}`}>{remaining === null ? "—" : fmtCompact(remaining)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <ProgressBar rate={rate} className="flex-1" />
                      <span className="text-[11px] font-bold text-slate-600 w-11 text-right">{pctText(rate, 0)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-center"><StatusBadge status={budgetStatusOf(rate)} /></td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">Không có hạng mục nào khớp bộ lọc.</td></tr>}
          </tbody>
        </table>
        <p className="px-4 py-2.5 border-t border-slate-100 text-[11px] text-slate-400">Đúng định mức: dưới 90% · Cần chú ý: 90–100% · Vượt ngân sách: trên 100%. Tổng nhóm không set được ngân sách ở cấp hạng mục (giá vốn, nhân sự, khấu hao) thì chỉ có kế hoạch ở dòng tổng. Cả năm thực chi {fmtCompact(sumAll(monthlyActual))}.</p>
      </Card>
    </div>
  );
}
