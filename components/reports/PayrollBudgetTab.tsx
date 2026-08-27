"use client";

import React, { useEffect, useMemo, useState } from "react";
import { MoneyLineChart, PlanActualComboChart } from "@/components/charts/ReportCharts";
import { Cell, PanelHeader, Table, money } from "@/components/reports/report-ui";

/**
 * Tab "Ngân sách nhân sự" (feedback chị Bình 26/08/2026, mục 2 & 3):
 *  - Set tỷ trọng lương chuẩn của từng bộ phận so với doanh thu (12.8% Bếp, 2% Bar...).
 *  - Bảng lương 12 tháng: doanh thu tham chiếu, lương theo tiêu chuẩn (= tỷ trọng ×
 *    tổng doanh thu gồm SVC), lương thực chi trả từ import bảng lương.
 *  - Chart so sánh chuẩn/thực chi theo tháng-quý-năm, toàn nhà hàng hoặc từng bộ phận.
 *  - Biến động số lượng nhân sự theo bộ phận qua các tháng.
 */

export type PayrollBudgetSeries = { code: string; name: string; months: number[]; total: number };
export type PayrollBudgetData = {
  year: string;
  branchCode: string;
  months: string[];
  departments: Array<{ code: string; name: string }>;
  ratios: Array<{ branchCode: string; departmentCode: string; ratio: number; industryMin: number | null; industryMax: number | null; note: string | null }>;
  revenue: { totalGross: number[]; totalSvc: number[]; byDepartment: PayrollBudgetSeries[]; svcByDepartment: PayrollBudgetSeries[] };
  standard: { byDepartment: PayrollBudgetSeries[]; total: number[] };
  actual: { byDepartment: PayrollBudgetSeries[]; total: number[]; insurance: number[] };
  headcount: { byDepartment: PayrollBudgetSeries[]; total: number[] };
};

type RatioDraft = { ratio: string; industryMin: string; industryMax: string; note: string };

const percentText = (value: number | null | undefined) => (value ? (value * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 }) : "");

function rollup(values: number[], view: "month" | "quarter" | "year", year: string) {
  if (view === "month") return { labels: values.map((_, index) => `T${index + 1}`), values };
  if (view === "quarter") {
    return {
      labels: ["Q1", "Q2", "Q3", "Q4"],
      values: [0, 1, 2, 3].map((quarter) => values.slice(quarter * 3, quarter * 3 + 3).reduce((sum, value) => sum + value, 0)),
    };
  }
  return { labels: [`Năm ${year}`], values: [values.reduce((sum, value) => sum + value, 0)] };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export default function PayrollBudgetTab({
  data,
  period,
  branchCode,
  canConfigure,
  onSaved,
  setMessage,
}: {
  data: PayrollBudgetData;
  period: string;
  branchCode: string;
  canConfigure: boolean;
  onSaved: () => Promise<void>;
  setMessage: (message: string) => void;
}) {
  const [chartDept, setChartDept] = useState("ALL");
  const [chartView, setChartView] = useState<"month" | "quarter" | "year">("month");
  const [ratioDrafts, setRatioDrafts] = useState<Record<string, RatioDraft>>({});
  const [saving, setSaving] = useState(false);

  const branchRatios = useMemo(
    () => data.ratios.filter((row) => branchCode === "ALL" || row.branchCode === branchCode),
    [data.ratios, branchCode],
  );

  // Nạp lại form tỷ trọng mỗi khi đổi cửa hàng/năm — giữ nguyên khi đang gõ dở cùng bộ dữ liệu.
  // setTimeout 0 để tránh setState đồng bộ trong effect — cùng pattern với app/reports/page.tsx.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const drafts: Record<string, RatioDraft> = {};
      for (const department of data.departments) {
        const existing = branchRatios.find((row) => row.departmentCode === department.code);
        drafts[department.code] = {
          ratio: percentText(existing?.ratio),
          industryMin: percentText(existing?.industryMin),
          industryMax: percentText(existing?.industryMax),
          note: existing?.note || "",
        };
      }
      setRatioDrafts(drafts);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.year, branchCode, data.ratios]);

  const draftTotal = data.departments.reduce((total, department) => total + (Number(ratioDrafts[department.code]?.ratio?.replace(",", ".")) || 0), 0);

  const saveRatios = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      for (const department of data.departments) {
        const draft = ratioDrafts[department.code];
        if (!draft) continue;
        const existing = branchRatios.find((row) => row.departmentCode === department.code);
        const ratioValue = Number(draft.ratio.replace(",", ".")) || 0;
        if (!existing && ratioValue === 0 && !draft.note) continue; // chưa từng set và vẫn để trống -> bỏ qua
        const response = await fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "UPSERT_DEPARTMENT_RATIO",
            period,
            branchCode,
            departmentCode: department.code,
            ratioPercent: ratioValue,
            industryMinPercent: Number(draft.industryMin.replace(",", ".")) || 0,
            industryMaxPercent: Number(draft.industryMax.replace(",", ".")) || 0,
            note: draft.note,
          }),
        });
        if (!response.ok) {
          const payload = await response.json();
          setMessage(payload.error || `Không lưu được tỷ trọng bộ phận ${department.code}`);
          setSaving(false);
          return;
        }
      }
      setMessage(`Đã lưu tỷ trọng bộ phận năm ${data.year}.`);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  // Chuỗi cho chart: tổng hoặc một bộ phận cụ thể.
  const standardSeries = chartDept === "ALL" ? data.standard.total : data.standard.byDepartment.find((row) => row.code === chartDept)?.months || Array.from({ length: 12 }, () => 0);
  const actualSeries = chartDept === "ALL" ? data.actual.total : data.actual.byDepartment.find((row) => row.code === chartDept)?.months || Array.from({ length: 12 }, () => 0);
  const standardRollup = rollup(standardSeries, chartView, data.year);
  const actualRollup = rollup(actualSeries, chartView, data.year);

  const revenueYearTotal = sum(data.revenue.totalGross) + sum(data.revenue.totalSvc);
  const standardYearTotal = sum(data.standard.total);
  const actualYearTotal = sum(data.actual.total);
  const headcountLatest = [...data.headcount.total].reverse().find((value) => value > 0) || 0;

  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const chartDeptOptions = [...new Set([...data.standard.byDepartment, ...data.actual.byDepartment].map((row) => row.code))];
  const deptName = (code: string) => data.departments.find((department) => department.code === code)?.name || code;

  const hasPayroll = actualYearTotal > 0;
  const hasRatio = branchRatios.some((row) => row.ratio > 0);

  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-4 gap-4">
        <KpiBox label={`Doanh thu ${data.year} (gồm SVC)`} value={`${money(revenueYearTotal)} đ`} icon="payments" tone="text-blue-600" />
        <KpiBox label="Lương theo tiêu chuẩn" value={`${money(standardYearTotal)} đ`} icon="flag" tone="text-slate-800" />
        <KpiBox label="Lương thực chi trả" value={`${money(actualYearTotal)} đ`} icon="receipt_long" tone={actualYearTotal > standardYearTotal && standardYearTotal > 0 ? "text-rose-600" : "text-emerald-600"} />
        <KpiBox label="Nhân sự tháng gần nhất" value={`${headcountLatest} người`} icon="groups" tone="text-slate-800" />
      </div>

      <div className="grid xl:grid-cols-[420px_1fr] gap-5">
        {canConfigure && (
          <form onSubmit={saveRatios} className="bg-white border border-slate-200 rounded-lg h-fit overflow-hidden">
            <PanelHeader
              title={`Tỷ trọng lương theo bộ phận — năm ${data.year}`}
              subtitle={branchCode === "ALL" ? "Chọn một cửa hàng cụ thể ở bộ lọc trên để set tỷ trọng." : "Nhập %, ví dụ 12.8 = 12.8% doanh thu (gồm SVC). Cột Ngành là khoảng tham chiếu F&B."}
            />
            <div className="overflow-x-auto">
              <Table headers={["Bộ phận", "Ngành %", "Áp dụng %"]}>
                {data.departments.map((department) => {
                  const draft = ratioDrafts[department.code] || { ratio: "", industryMin: "", industryMax: "", note: "" };
                  return (
                    <tr key={department.code} className="border-t border-slate-100">
                      <Cell>
                        <b>{department.name}</b>
                        <p className="text-xs text-slate-400">{department.code}</p>
                      </Cell>
                      <Cell>
                        <div className="flex items-center gap-1">
                          <input className="control w-16 text-right" placeholder="10" value={draft.industryMin} disabled={branchCode === "ALL"} onChange={(event) => setRatioDrafts({ ...ratioDrafts, [department.code]: { ...draft, industryMin: event.target.value } })} />
                          <span className="text-slate-400">-</span>
                          <input className="control w-16 text-right" placeholder="12" value={draft.industryMax} disabled={branchCode === "ALL"} onChange={(event) => setRatioDrafts({ ...ratioDrafts, [department.code]: { ...draft, industryMax: event.target.value } })} />
                        </div>
                      </Cell>
                      <Cell right>
                        <input className="control w-20 text-right font-bold" placeholder="0" value={draft.ratio} disabled={branchCode === "ALL"} onChange={(event) => setRatioDrafts({ ...ratioDrafts, [department.code]: { ...draft, ratio: event.target.value } })} />
                      </Cell>
                    </tr>
                  );
                })}
                <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                  <Cell><b>Tổng CP lương cho NLĐ</b></Cell>
                  <Cell> </Cell>
                  <Cell right><b className={draftTotal > 35 ? "text-rose-600" : "text-blue-700"}>{draftTotal.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} %</b></Cell>
                </tr>
              </Table>
            </div>
            <div className="p-4 border-t border-slate-100">
              <button className="primary-button w-full" disabled={saving || branchCode === "ALL"}>
                <span className="material-symbols-outlined text-lg">save</span>
                {saving ? "Đang lưu..." : "Lưu tỷ trọng cả năm"}
              </button>
            </div>
          </form>
        )}

        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">Lương ngân sách vs thực tế</h2>
              <p className="text-xs text-slate-500 mt-0.5">Ngân sách = tỷ trọng × tổng doanh thu (gồm SVC) của kỳ. Thực tế = lương + phụ cấp + thưởng từ import bảng lương.</p>
            </div>
            <div className="flex items-center gap-2">
              <select className="control text-xs" value={chartDept} onChange={(event) => setChartDept(event.target.value)}>
                <option value="ALL">Toàn bộ nhà hàng</option>
                {chartDeptOptions.map((code) => (
                  <option key={code} value={code}>{deptName(code)}</option>
                ))}
              </select>
              <select className="control text-xs" value={chartView} onChange={(event) => setChartView(event.target.value as "month" | "quarter" | "year")}>
                <option value="month">Theo tháng</option>
                <option value="quarter">Theo quý</option>
                <option value="year">Cả năm</option>
              </select>
            </div>
          </div>
          <div className="p-4">
            {!hasRatio && !hasPayroll ? (
              <p className="py-10 text-center text-sm text-slate-400">
                Chưa có tỷ trọng bộ phận lẫn dữ liệu bảng lương năm {data.year}. Set tỷ trọng ở bảng bên trái và import bảng lương (Import → Bảng lương) để lên chart.
              </p>
            ) : (
              <PlanActualComboChart labels={standardRollup.labels} planName="Lương ngân sách" actualName="Lương thực tế" plan={standardRollup.values} actual={actualRollup.values} />
            )}
          </div>
        </section>
      </div>

      <section className="table-panel">
        <PanelHeader title={`Bảng lương theo tiêu chuẩn ${data.year}`} subtitle="Doanh thu tham chiếu theo bộ phận, lương chuẩn theo tỷ trọng đã set và lương thực chi trả. Cuộn ngang xem đủ 12 tháng." />
        <div className="overflow-x-auto">
          <Table headers={["Nội dung", ...monthHeaders, "Cả năm"]}>
            <SectionRow label="DOANH THU THAM CHIẾU" span={14} />
            <MonthRow label="Tổng doanh thu" values={data.revenue.totalGross} bold />
            <MonthRow label="SVC" values={data.revenue.totalSvc} />
            {data.revenue.byDepartment.map((row) => (
              <MonthRow key={`rev-${row.code}`} label={`Doanh thu ${row.name}`} values={row.months} muted />
            ))}
            <SectionRow label="LƯƠNG THEO TIÊU CHUẨN (tỷ trọng × doanh thu)" span={14} />
            {data.standard.byDepartment.map((row) => (
              <MonthRow key={`std-${row.code}`} label={row.name} values={row.months} />
            ))}
            <MonthRow label="Tổng lương tiêu chuẩn" values={data.standard.total} bold />
            <SectionRow label="LƯƠNG THỰC CHI TRẢ (import bảng lương)" span={14} />
            {data.actual.byDepartment.map((row) => (
              <MonthRow key={`act-${row.code}`} label={row.name} values={row.months} />
            ))}
            <MonthRow label="Tổng lương thực chi" values={data.actual.total} bold />
            <MonthRow label="Chênh lệch (thực chi - tiêu chuẩn)" values={data.months.map((_, index) => data.actual.total[index] - data.standard.total[index])} variance />
            {/* Dòng % CP lương/doanh thu như file gốc của chị Bình — so ngay được với tổng tỷ trọng đã set. */}
            <tr className="border-t border-slate-200 bg-slate-50">
              <Cell><b>% lương thực chi / doanh thu</b></Cell>
              {data.months.map((month, index) => {
                const base = data.revenue.totalGross[index] + data.revenue.totalSvc[index];
                const rate = base > 0 ? (data.actual.total[index] / base) * 100 : null;
                return (
                  <Cell key={month} right>
                    {rate === null ? "-" : <b className={rate > draftTotal && draftTotal > 0 ? "text-rose-600" : "text-emerald-700"}>{rate.toFixed(1)}%</b>}
                  </Cell>
                );
              })}
              <Cell right>
                {(() => {
                  const baseYear = sum(data.revenue.totalGross) + sum(data.revenue.totalSvc);
                  const rate = baseYear > 0 ? (sum(data.actual.total) / baseYear) * 100 : null;
                  return rate === null ? "-" : <b className={rate > draftTotal && draftTotal > 0 ? "text-rose-600" : "text-emerald-700"}>{rate.toFixed(1)}%</b>;
                })()}
              </Cell>
            </tr>
          </Table>
        </div>
        {data.revenue.byDepartment.some((row) => row.code === "UNASSIGNED") && (
          <p className="px-4 py-3 text-xs text-amber-800 bg-amber-50 border-t border-amber-100">
            Có doanh thu chưa gán được bộ phận (dòng &quot;Chưa gán bộ phận&quot;) — kiểm tra nguồn doanh thu/mã hàng của file import để tách đủ Bếp/Bar.
          </p>
        )}
      </section>

      <div className="grid xl:grid-cols-2 gap-5">
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Biến động số lượng nhân sự" subtitle="Đếm số nhân viên có tên trong bảng lương từng tháng, tách theo bộ phận." />
          <div className="p-4">
            {data.headcount.byDepartment.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-400">Chưa import bảng lương nên chưa có số lượng nhân sự. Import ở màn Import → Bảng lương.</p>
            ) : (
              <MoneyLineChart
                labels={monthHeaders}
                series={data.headcount.byDepartment.map((row) => ({ name: row.name, values: row.months }))}
                countMode
              />
            )}
          </div>
        </section>
        <section className="table-panel">
          <PanelHeader title="Số lượng nhân sự theo tháng" subtitle="Kèm tổng quỹ lương thực chi và lương bình quân đầu người." />
          <div className="overflow-x-auto">
            <Table headers={["Chỉ số", ...monthHeaders]}>
              {data.headcount.byDepartment.map((row) => (
                <tr key={`hc-${row.code}`} className="border-t border-slate-100">
                  <Cell><b>{row.name}</b></Cell>
                  {row.months.map((value, index) => (
                    <Cell key={data.months[index]} right>{value || "-"}</Cell>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-slate-200 bg-slate-50 font-bold">
                <Cell><b>Tổng nhân sự</b></Cell>
                {data.headcount.total.map((value, index) => (
                  <Cell key={data.months[index]} right><b>{value || "-"}</b></Cell>
                ))}
              </tr>
              <tr className="border-t border-slate-100">
                <Cell><b>Lương bình quân/người</b></Cell>
                {data.headcount.total.map((value, index) => (
                  <Cell key={data.months[index]} right>{value ? money(Math.round(data.actual.total[index] / value)) : "-"}</Cell>
                ))}
              </tr>
            </Table>
          </div>
        </section>
      </div>
    </div>
  );
}

function KpiBox({ label, value, icon, tone }: { label: string; value: string; icon: string; tone: string }) {
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

function SectionRow({ label, span }: { label: string; span: number }) {
  return (
    <tr className="border-t border-slate-200 bg-slate-50">
      <td colSpan={span} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-600">{label}</td>
    </tr>
  );
}

function MonthRow({ label, values, bold, muted, variance }: { label: string; values: number[]; bold?: boolean; muted?: boolean; variance?: boolean }) {
  const total = values.reduce((sumValue, value) => sumValue + value, 0);
  const cellClass = (value: number) => (variance ? (value > 0 ? "text-rose-600 font-bold" : value < 0 ? "text-emerald-600 font-bold" : "") : "");
  return (
    <tr className={`border-t border-slate-100 ${bold ? "bg-blue-50/40 font-bold" : ""} ${muted ? "text-slate-500" : ""}`}>
      <Cell><span className={bold ? "font-bold" : ""}>{label}</span></Cell>
      {values.map((value, index) => (
        <Cell key={index} right><span className={cellClass(value)}>{value ? money(Math.round(value)) : "-"}</span></Cell>
      ))}
      <Cell right><b className={cellClass(total)}>{total ? money(Math.round(total)) : "-"}</b></Cell>
    </tr>
  );
}
