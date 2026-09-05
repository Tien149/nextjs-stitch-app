"use client";

import React, { useEffect, useMemo, useState } from "react";
import { MoneyLineChart, PlanActualComboChart } from "@/components/charts/ReportCharts";
import { Cell, PanelHeader, Table, money } from "@/components/reports/report-ui";

/**
 * Tab "Ngân sách nhân sự" (feedback chị Bình 26/08/2026, mục 2 & 3):
 *  - Set tỷ trọng lương chuẩn của từng bộ phận so với doanh thu (12.8% Bếp, 2% Bar...).
 *    Bộ tỷ trọng khóa theo THÁNG BẮT ĐẦU ÁP DỤNG: có hiệu lực từ kỳ đang chọn cho tới khi có
 *    bộ mới — chốt quý xong đổi tỷ lệ thì đứng ở tháng đầu quý sau sửa, các tháng sau tự theo.
 *  - Bảng lương 12 tháng: doanh thu tham chiếu, lương theo tiêu chuẩn (= tỷ trọng ×
 *    tổng doanh thu gồm SVC), lương thực chi trả từ import bảng lương.
 *  - Chart so sánh chuẩn/thực chi theo tháng-quý-năm, toàn nhà hàng hoặc từng bộ phận.
 *  - Biến động số lượng nhân sự theo bộ phận qua các tháng.
 */

export type PayrollBudgetSeries = { code: string; name: string; months: number[]; total: number };
export type PayrollBudgetData = {
  year: string;
  /** Kỳ đang chọn (YYYY-MM) — form tỷ trọng là bộ có hiệu lực ở tháng này. */
  period: string;
  branchCode: string;
  months: string[];
  departments: Array<{ code: string; name: string }>;
  /** Các tháng trong năm đã set bộ tỷ trọng riêng. */
  ratioPeriods: string[];
  /** Tổng tỷ trọng có hiệu lực từng tháng (0.25 = 25%). */
  ratioTotalByMonth: number[];
  ratios: Array<{ branchCode: string; departmentCode: string; period: string; ratio: number; industryMin: number | null; industryMax: number | null; note: string | null }>;
  revenue: { totalGross: number[]; totalSvc: number[]; byDepartment: PayrollBudgetSeries[]; svcByDepartment: PayrollBudgetSeries[] };
  standard: { byDepartment: PayrollBudgetSeries[]; total: number[] };
  actual: { byDepartment: PayrollBudgetSeries[]; total: number[]; insurance: number[] };
  headcount: { byDepartment: PayrollBudgetSeries[]; total: number[] };
};

type RatioDraft = { ratio: string; industryMin: string; industryMax: string; note: string };

const percentText = (value: number | null | undefined) => (value ? (value * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 }) : "");
const monthLabel = (period: string) => `${Number(period.slice(5, 7))}/${period.slice(0, 4)}`;
const parsePercent = (text: string) => Number(text.replace(",", ".")) || 0;

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

  // Nạp lại form tỷ trọng mỗi khi đổi cửa hàng/kỳ — giữ nguyên khi đang gõ dở cùng bộ dữ liệu.
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
  }, [data.period, branchCode, data.ratios]);

  const draftTotal = data.departments.reduce((total, department) => total + parsePercent(ratioDrafts[department.code]?.ratio || ""), 0);
  const periodLabel = monthLabel(data.period);
  // Bộ đang hiện là set riêng cho tháng này hay kế thừa từ mốc trước — để người dùng biết lưu sẽ tạo mốc mới.
  const ownPeriodRows = branchRatios.filter((row) => row.period === data.period);
  const inheritedFrom = branchRatios.filter((row) => row.period < data.period).map((row) => row.period).sort().pop() || null;

  const saveRatios = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      let savedCount = 0;
      for (const department of data.departments) {
        const draft = ratioDrafts[department.code];
        if (!draft) continue;
        const existing = branchRatios.find((row) => row.departmentCode === department.code);
        const ratioValue = parsePercent(draft.ratio);
        const industryMinValue = parsePercent(draft.industryMin);
        const industryMaxValue = parsePercent(draft.industryMax);
        if (!existing && ratioValue === 0 && !draft.note) continue; // chưa từng set và vẫn để trống -> bỏ qua
        // Bộ phận không đổi so với bộ đang có hiệu lực (kể cả kế thừa) thì không ghi mốc mới ở tháng này —
        // tránh mỗi lần bấm Lưu lại đóng băng một bản sao, sau quay về sửa mốc cũ không thấy lan xuống.
        const unchanged = existing
          && Math.abs(existing.ratio * 100 - ratioValue) < 1e-9
          && Math.abs((existing.industryMin || 0) * 100 - industryMinValue) < 1e-9
          && Math.abs((existing.industryMax || 0) * 100 - industryMaxValue) < 1e-9
          && (existing.note || "") === draft.note;
        if (unchanged) continue;
        const response = await fetch("/api/reports", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "UPSERT_DEPARTMENT_RATIO",
            period,
            branchCode,
            departmentCode: department.code,
            ratioPercent: ratioValue,
            industryMinPercent: industryMinValue,
            industryMaxPercent: industryMaxValue,
            note: draft.note,
          }),
        });
        if (!response.ok) {
          const payload = await response.json();
          setMessage(payload.error || `Không lưu được tỷ trọng bộ phận ${department.code}`);
          setSaving(false);
          return;
        }
        savedCount += 1;
      }
      if (savedCount === 0) {
        setMessage(`Tỷ trọng không đổi so với bộ đang áp cho tháng ${periodLabel} — chưa có gì để lưu.`);
        return;
      }
      setMessage(`Đã lưu tỷ trọng ${savedCount} bộ phận, áp từ tháng ${periodLabel} trở đi cho tới khi có bộ mới.`);
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

      <div className="grid xl:grid-cols-[440px_1fr] gap-5">
        {canConfigure && (
          <form onSubmit={saveRatios} className="bg-white border border-slate-200 rounded-lg h-fit overflow-hidden">
            <PanelHeader
              title={`Tỷ trọng lương theo bộ phận — từ tháng ${periodLabel}`}
              subtitle={branchCode === "ALL"
                ? "Đang xem Tất cả cửa hàng — chọn một cửa hàng cụ thể ở bộ lọc trên để set tỷ trọng."
                : `Áp cho ${data.branchCode} từ tháng ${periodLabel} trở đi, tới khi có bộ mới ở tháng sau. Đổi kỳ báo cáo ở trên để set cho mốc khác. Nhập 12.8 nghĩa là 12.8% doanh thu (gồm SVC).`}
            />
            {branchCode !== "ALL" && (
              <div className={`px-4 py-2 text-xs border-b ${ownPeriodRows.length > 0 ? "bg-blue-50 border-blue-100 text-blue-800" : inheritedFrom ? "bg-amber-50 border-amber-100 text-amber-800" : "bg-slate-50 border-slate-100 text-slate-500"}`}>
                {ownPeriodRows.length > 0
                  ? <>Tháng {periodLabel} đã có bộ tỷ trọng riêng{inheritedFrom && ownPeriodRows.length < branchRatios.length ? `, bộ phận chưa set ở mốc này kế thừa từ tháng ${monthLabel(inheritedFrom)}` : ""}.</>
                  : inheritedFrom
                    ? <>Tháng {periodLabel} chưa set riêng — đang kế thừa bộ tỷ trọng từ tháng {monthLabel(inheritedFrom)}. Sửa rồi bấm Lưu sẽ tạo mốc mới từ tháng {periodLabel}.</>
                    : <>Chưa có bộ tỷ trọng nào cho {data.branchCode} tính tới tháng {periodLabel}.</>}
                {data.ratioPeriods.length > 0 && (
                  <span className="block mt-0.5 text-[11px] opacity-80">Các mốc đã set trong năm {data.year}: {data.ratioPeriods.map((item) => `T${Number(item.slice(5))}`).join(", ")}.</span>
                )}
              </div>
            )}
            {/* Hàng tiêu đề + hàng nhập tự dựng bằng flex thay vì <Table> nowrap — bảng cũ
                tràn ngang làm cột "Áp dụng %" (cột chính) bị đẩy khuất khỏi card. */}
            <div className="flex items-center gap-2 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100">
              <span className="flex-1">Bộ phận</span>
              <span className="w-[104px] text-center">Ngành tham chiếu</span>
              <span className="w-[74px] text-right pr-1">Áp dụng</span>
            </div>
            <div className="divide-y divide-slate-100">
              {data.departments.map((department) => {
                const draft = ratioDrafts[department.code] || { ratio: "", industryMin: "", industryMax: "", note: "" };
                const inputClass = "rounded-md border border-slate-300 bg-white px-1.5 py-1.5 text-sm text-right outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
                const hasRatio = Number(draft.ratio.replace(",", ".")) > 0;
                return (
                  <div key={department.code} className={`flex items-center gap-2 px-4 py-2 ${hasRatio ? "bg-blue-50/40" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm text-slate-800 truncate">{department.name}</p>
                      <p className="text-[11px] text-slate-400">{department.code}</p>
                    </div>
                    <div className="flex w-[104px] items-center gap-1 justify-center">
                      <input className={`${inputClass} w-11`} value={draft.industryMin} disabled={branchCode === "ALL"} onChange={(event) => setRatioDrafts({ ...ratioDrafts, [department.code]: { ...draft, industryMin: event.target.value } })} />
                      <span className="text-slate-300">–</span>
                      <input className={`${inputClass} w-11`} value={draft.industryMax} disabled={branchCode === "ALL"} onChange={(event) => setRatioDrafts({ ...ratioDrafts, [department.code]: { ...draft, industryMax: event.target.value } })} />
                    </div>
                    <div className="flex w-[74px] items-center gap-1 justify-end">
                      <input className={`${inputClass} w-14 font-bold`} value={draft.ratio} disabled={branchCode === "ALL"} onChange={(event) => setRatioDrafts({ ...ratioDrafts, [department.code]: { ...draft, ratio: event.target.value } })} />
                      <span className="text-xs font-bold text-slate-400">%</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-2 px-4 py-3 border-t-2 border-slate-200 bg-slate-50">
              <div className="flex-1">
                <p className="font-bold text-sm">Tổng CP lương cho NLĐ</p>
                <p className="text-[11px] text-slate-400">Chuỗi F&amp;B thường khoán 25–30% doanh thu</p>
              </div>
              <b className={`text-lg ${draftTotal > 35 ? "text-rose-600" : draftTotal > 0 ? "text-blue-700" : "text-slate-300"}`}>
                {draftTotal.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} %
              </b>
            </div>
            <div className="p-4 border-t border-slate-100">
              <button className="primary-button w-full" disabled={saving || branchCode === "ALL"}>
                <span className="material-symbols-outlined text-lg">save</span>
                {saving ? "Đang lưu..." : `Lưu tỷ trọng từ tháng ${periodLabel}`}
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
              <div className="py-8 flex flex-col items-center text-center">
                <span className="material-symbols-outlined text-5xl text-slate-200">monitoring</span>
                <p className="mt-2 font-bold text-slate-600">Chart cần hai nguồn số liệu — làm theo 2 bước:</p>
                <div className="mt-4 space-y-3 text-left text-sm max-w-md">
                  <div className="flex gap-3 items-start">
                    <span className="mt-0.5 w-6 h-6 shrink-0 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">1</span>
                    <p><b>Set tỷ trọng bộ phận</b> ở bảng bên trái (cột &quot;Áp dụng&quot;) rồi bấm Lưu — ra đường <b>Lương ngân sách</b>. {branchCode === "ALL" && "Chọn một cửa hàng cụ thể ở bộ lọc trên trước."}</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="mt-0.5 w-6 h-6 shrink-0 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center">2</span>
                    <p><b>Import bảng lương</b> các tháng {data.year} ở menu <a href="/imports/payroll" className="text-blue-700 font-bold underline-offset-2 hover:underline">Import → Bảng lương ↗</a> — ra cột <b>Lương thực tế</b>.</p>
                  </div>
                </div>
                <p className="mt-4 text-xs text-slate-400">Làm xong một trong hai là chart bắt đầu hiện; đủ cả hai mới so sánh được.</p>
              </div>
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
            {data.standard.byDepartment.length === 0 ? (
              <EmptySectionRow span={14} message={`Chưa có bộ tỷ trọng bộ phận nào có hiệu lực trong năm ${data.year}${branchCode === "ALL" ? " cho cửa hàng nào" : ""} — điền bảng "Tỷ trọng lương theo bộ phận" phía trên rồi bấm Lưu.`} />
            ) : (
              <>
                {data.standard.byDepartment.map((row) => (
                  <MonthRow key={`std-${row.code}`} label={row.name} values={row.months} />
                ))}
                <MonthRow label="Tổng lương tiêu chuẩn" values={data.standard.total} bold />
              </>
            )}
            <SectionRow label="LƯƠNG THỰC CHI TRẢ (import bảng lương)" span={14} />
            {data.actual.byDepartment.length === 0 ? (
              <EmptySectionRow span={14} message={`Chưa import bảng lương tháng nào của năm ${data.year} — nạp file ở menu Import → Bảng lương.`} />
            ) : (
              <>
                {data.actual.byDepartment.map((row) => (
                  <MonthRow key={`act-${row.code}`} label={row.name} values={row.months} />
                ))}
                <MonthRow label="Tổng lương thực chi" values={data.actual.total} bold />
              </>
            )}
            {hasRatio && hasPayroll && (
              <MonthRow label="Chênh lệch (thực chi - tiêu chuẩn)" values={data.months.map((_, index) => data.actual.total[index] - data.standard.total[index])} variance />
            )}
            {/* Dòng % CP lương/doanh thu như file gốc của chị Bình — so với tổng tỷ trọng có hiệu lực
                của ĐÚNG tháng đó (tỷ trọng đổi theo mốc set, không dùng con số đang gõ trên form). */}
            {hasPayroll && (
            <tr className="border-t border-slate-200 bg-slate-50">
              <Cell><b>% lương thực chi / doanh thu</b></Cell>
              {data.months.map((month, index) => {
                const base = data.revenue.totalGross[index] + data.revenue.totalSvc[index];
                const rate = base > 0 ? (data.actual.total[index] / base) * 100 : null;
                const limit = data.ratioTotalByMonth[index] * 100;
                return (
                  <Cell key={month} right>
                    {rate === null ? "-" : <b className={rate > limit && limit > 0 ? "text-rose-600" : "text-emerald-700"}>{rate.toFixed(1)}%</b>}
                  </Cell>
                );
              })}
              <Cell right>
                {(() => {
                  const baseYear = sum(data.revenue.totalGross) + sum(data.revenue.totalSvc);
                  const rate = baseYear > 0 ? (sum(data.actual.total) / baseYear) * 100 : null;
                  const limit = baseYear > 0 ? (standardYearTotal / baseYear) * 100 : 0;
                  return rate === null ? "-" : <b className={rate > limit && limit > 0 ? "text-rose-600" : "text-emerald-700"}>{rate.toFixed(1)}%</b>;
                })()}
              </Cell>
            </tr>
            )}
          </Table>
        </div>
        {data.revenue.byDepartment.some((row) => row.code === "UNASSIGNED") && (
          <p className="px-4 py-3 text-xs text-amber-800 bg-amber-50 border-t border-amber-100">
            Có doanh thu chưa gán được bộ phận (dòng &quot;Chưa gán bộ phận&quot;) — kiểm tra nguồn doanh thu/mã hàng của file import để tách đủ Bếp/Bar.
          </p>
        )}
      </section>

      {data.headcount.byDepartment.length === 0 ? (
        <section className="bg-white border border-slate-200 rounded-lg p-5 flex items-center gap-4">
          <span className="material-symbols-outlined text-4xl text-slate-200">groups</span>
          <div>
            <p className="font-bold text-slate-600">Biến động số lượng nhân sự — chưa có dữ liệu</p>
            <p className="text-sm text-slate-400 mt-0.5">
              Chart và bảng nhân sự lấy từ file bảng lương. Import các tháng {data.year} ở{" "}
              <a href="/imports/payroll" className="text-blue-700 font-bold underline-offset-2 hover:underline">Import → Bảng lương ↗</a> là hai khối này tự hiện.
            </p>
          </div>
        </section>
      ) : (
      <div className="grid xl:grid-cols-2 gap-5">
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Biến động số lượng nhân sự" subtitle="Đếm số nhân viên có tên trong bảng lương từng tháng, tách theo bộ phận." exportable={false} />
          <div className="p-4">
            <MoneyLineChart
              labels={monthHeaders}
              series={data.headcount.byDepartment.map((row) => ({ name: row.name, values: row.months }))}
              countMode
            />
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
      )}
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

/** Dòng thay cho cả khối khi khối chưa có dữ liệu — nói rõ thiếu gì và bổ sung ở đâu. */
function EmptySectionRow({ span, message }: { span: number; message: string }) {
  return (
    <tr className="border-t border-slate-100">
      <td colSpan={span} className="px-4 py-3 text-xs text-slate-400 italic">{message}</td>
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
