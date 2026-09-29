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
  /** `group` là ô Nhóm của danh mục Phòng ban (Vận hành / Văn phòng). */
  departments: Array<{ code: string; name: string; group?: string | null }>;
  /** Các tháng trong năm đã set bộ tỷ trọng riêng. */
  ratioPeriods: string[];
  /** Tổng tỷ trọng có hiệu lực từng tháng (0.25 = 25%). */
  ratioTotalByMonth: number[];
  ratios: Array<{ branchCode: string; departmentCode: string; period: string; ratio: number; industryMin: number | null; industryMax: number | null; note: string | null }>;
  revenue: {
    totalGross: number[];
    totalSvc: number[];
    byDepartment: PayrollBudgetSeries[];
    svcByDepartment: PayrollBudgetSeries[];
    /** Thuế GTGT từng tháng. */
    totalVat?: number[];
    /** Tổng doanh thu đúng như P&L / Dashboard P&L (gồm SVC và thuế GTGT). */
    pnlTotal?: number[];
    /** Chênh lệch Tổng tiền POS so với Doanh thu − Giảm giá + SVC + Thuế (hoa hồng, phí ship...). */
    totalAdjust?: number[];
  };
  standard: { byDepartment: PayrollBudgetSeries[]; total: number[] };
  actual: { byDepartment: PayrollBudgetSeries[]; total: number[]; insurance: number[] };
  headcount: { byDepartment: PayrollBudgetSeries[]; total: number[] };
};

type RatioDraft = { ratio: string; industryMin: string; industryMax: string; note: string };

const percentText = (value: number | null | undefined) => (value ? (value * 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 }) : "");
/** Số nhân sự có thể lẻ (0,5 — người làm chia đôi hai bộ phận): in tối đa 2 chữ số thập phân. */
const headcountText = (value: number) => value.toLocaleString("vi-VN", { maximumFractionDigits: 2 });
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
        <KpiBox label="Nhân sự tháng gần nhất" value={`${headcountText(headcountLatest)} người`} icon="groups" tone="text-slate-800" />
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
            {/* Tổng = dòng Doanh thu của P&L; các dòng dưới cộng lại đúng bằng tổng. */}
            <MonthRow label="Tổng doanh thu" values={data.revenue.pnlTotal || data.revenue.totalGross} bold />
            <MonthRow label="SVC" values={data.revenue.totalSvc} />
            {data.revenue.totalVat && <MonthRow label="Thuế GTGT" values={data.revenue.totalVat} />}
            {data.revenue.totalAdjust?.some((value) => Math.abs(value) > 0.5) && (
              <MonthRow label="Chênh lệch Tổng tiền POS" values={data.revenue.totalAdjust} />
            )}
            {data.revenue.byDepartment.map((row) => (
              <MonthRow key={`rev-${row.code}`} label={`Doanh thu ${row.name}`} values={row.months} muted />
            ))}
            <SectionRow label="LƯƠNG THEO TIÊU CHUẨN (tỷ trọng × doanh thu trước thuế GTGT)" span={14} />
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
            <SectionRow label="LƯƠNG THỰC CHI TRẢ (import bảng lương + khoản lương lẻ trên phiếu chi / công nợ)" span={14} />
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
      <>
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <PanelHeader title="Biến động số lượng nhân sự" subtitle="Số lượng nhân sự trong bảng lương từng tháng, tách theo bộ phận (nhân sự chia đôi hai bộ phận tính 0,5)." exportable={false} />
          <div className="p-4">
            <MoneyLineChart
              labels={monthHeaders}
              series={data.headcount.byDepartment.map((row) => ({ name: row.name, values: row.months }))}
              countMode
            />
          </div>
        </section>
        <HeadcountCostTable data={data} monthHeaders={monthHeaders} />
      </>
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

/* ------------------------------------------------------------------------- *
 * Bảng nhân sự theo tháng — theo mẫu Excel của khách (29/09/2026)
 * ------------------------------------------------------------------------- */

type DepartmentBlock = "OPERATION" | "OFFICE";

const plainText = (value: string | null | undefined) =>
  (value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

/**
 * Khối của một bộ phận: ô Nhóm ở danh mục Phòng ban thắng ("Vận hành" / "Văn phòng", hoặc
 * "Operation" / "Back office"). Để trống thì bộ phận có doanh thu riêng (Bếp, Bar) và bộ phận
 * đứng quầy/bếp theo tên (FOH, phục vụ, bảo trì...) là Vận hành, còn lại là Khối văn phòng.
 */
function departmentBlockOf(department: { name: string; group?: string | null }, hasRevenue: boolean): DepartmentBlock {
  const group = plainText(department.group);
  if (/van phong|back ?office|office/.test(group)) return "OFFICE";
  if (/van hanh|operation/.test(group)) return "OPERATION";
  if (hasRevenue) return "OPERATION";
  return /\b(bep|bar|foh|phuc vu|bao tri|sua chua|kitchen|van hanh|operation|thu ngan|tap vu|bao ve)\b/.test(plainText(department.name)) ? "OPERATION" : "OFFICE";
}

const BLOCK_LABELS: Record<DepartmentBlock, { group: string; subtotal: string }> = {
  OPERATION: { group: "Vận hành", subtotal: "Cộng Vận hành" },
  OFFICE: { group: "Văn phòng", subtotal: "Cộng Khối văn phòng" },
};

const ratioOf = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0);

/** Một dòng của bảng nhân sự: cột Nhóm, cột Bộ phận, rồi 12 tháng in theo `format`. */
function HeadcountRow({ group, label, values, format, tone = "", strong }: { group?: string; label: string; values: number[]; format: (value: number) => string; tone?: string; strong?: boolean }) {
  // Dòng bộ phận dưới một dòng tổng (CP lương, %, bình quân) thụt vào như file mẫu; dòng số
  // người đã có cột Nhóm đứng trước nên không thụt.
  const indent = !strong && !group;
  return (
    <tr className={`border-t border-slate-100 ${tone} ${strong ? "font-bold" : ""}`}>
      <Cell><span className="text-slate-500">{group || ""}</span></Cell>
      <Cell><span className={strong ? "font-bold" : indent ? "pl-4 text-slate-600" : ""}>{label}</span></Cell>
      {values.map((value, index) => <Cell key={index} right>{format(value)}</Cell>)}
    </tr>
  );
}

/**
 * Bảng "Số lượng nhân sự theo tháng" theo mẫu file của khách: số người theo khối Vận hành /
 * Văn phòng, CP lương cho NLĐ, doanh thu, % CP lương / DT, CP lương/người và DT/người.
 *
 * Luật mẫu số (khách chốt 29/09/2026): bộ phận có doanh thu riêng (Bếp, Bar) tính trên doanh
 * thu của chính nó; các bộ phận còn lại tính trên TỔNG doanh thu.
 *
 * "Doanh thu sau thuế" = TỔNG DOANH THU của P&L / Dashboard P&L (gồm SVC và thuế GTGT), và các
 * dòng chi tiết bên dưới cộng lại đúng bằng nó; "CP lương cho NLĐ" = dòng Chi phí nhân sự của
 * P&L (khách chốt 29/09/2026 — trước đây thiếu thuế GTGT, phụ thu và khoản lương lẻ).
 */
function HeadcountCostTable({ data, monthHeaders }: { data: PayrollBudgetData; monthHeaders: string[] }) {
  const zeros = () => data.months.map(() => 0);
  const departmentMeta = new Map(data.departments.map((row) => [row.code, row]));
  const headcountByCode = new Map(data.headcount.byDepartment.map((row) => [row.code, row]));
  const salaryByCode = new Map(data.actual.byDepartment.map((row) => [row.code, row]));
  const revenueDepartments = data.revenue.byDepartment.filter((row) => row.code !== "UNASSIGNED" && row.total > 0);
  const revenueByCode = new Map(revenueDepartments.map((row) => [row.code, row]));
  const vatMonths = data.revenue.totalVat || zeros();
  const totalRevenue = data.revenue.pnlTotal
    || data.months.map((_, index) => data.revenue.totalGross[index] + data.revenue.totalSvc[index] + vatMonths[index]);
  // Chi tiết doanh thu như khối "Doanh thu theo bộ phận" của P&L: DT từng bộ phận, DT Phụ thu
  // (doanh thu không thuộc bộ phận nào), Phụ thu SVC, Thuế GTGT. Phần còn lại (chênh lệch Tổng
  // tiền file POS so với các cột) đứng một dòng riêng để các dòng chi tiết luôn cộng đúng bằng tổng.
  const revenueDetailRows: Array<{ key: string; label: string; values: number[] }> = [
    ...data.revenue.byDepartment.map((row) => ({
      key: row.code,
      label: row.code === "UNASSIGNED" ? "DT Phụ thu" : `Doanh thu ${row.name}`,
      values: row.months,
    })),
    { key: "SVC", label: "Phụ thu SVC", values: data.revenue.totalSvc },
    { key: "VAT", label: "Thuế GTGT", values: vatMonths },
  ];
  const revenueRemainder = totalRevenue.map((value, index) => value - revenueDetailRows.reduce((sum, row) => sum + (row.values[index] || 0), 0));
  if (revenueRemainder.some((value) => Math.abs(value) >= 1)) {
    revenueDetailRows.push({ key: "ADJUST", label: "Chênh lệch tổng tiền POS", values: revenueRemainder.map((value) => (Math.abs(value) >= 1 ? value : 0)) });
  }

  const departments = [...new Set([...headcountByCode.keys(), ...salaryByCode.keys()])].map((code) => {
    const headcount = headcountByCode.get(code)?.months || zeros();
    const salary = salaryByCode.get(code)?.months || zeros();
    const ownRevenue = revenueByCode.get(code)?.months || null;
    const name = headcountByCode.get(code)?.name || salaryByCode.get(code)?.name || code;
    return {
      code,
      name,
      block: departmentBlockOf({ name, group: departmentMeta.get(code)?.group }, Boolean(ownRevenue)),
      headcount,
      salary,
      /** Mẫu số doanh thu: doanh thu riêng của bộ phận nếu có, không thì tổng doanh thu. */
      revenueBase: ownRevenue || totalRevenue,
      hasOwnRevenue: Boolean(ownRevenue),
      salaryTotal: salary.reduce((total, value) => total + value, 0),
    };
  });
  // Bếp/Bar (có doanh thu riêng) đứng đầu khối như file mẫu, sau đó theo quỹ lương giảm dần.
  departments.sort((a, b) => (a.block === b.block ? 0 : a.block === "OPERATION" ? -1 : 1)
    || Number(b.hasOwnRevenue) - Number(a.hasOwnRevenue)
    || b.salaryTotal - a.salaryTotal);
  const blocks = (["OPERATION", "OFFICE"] as DepartmentBlock[])
    .map((block) => ({ block, rows: departments.filter((row) => row.block === block) }))
    .filter((item) => item.rows.length > 0);

  const headcountTotal = data.headcount.total;
  const salaryTotal = data.actual.total;
  const columnSum = (rows: number[][]) => data.months.map((_, index) => rows.reduce((total, row) => total + row[index], 0));

  const headcountCell = (value: number) => (value ? headcountText(value) : "-");
  const moneyCell = (value: number) => (value ? money(Math.round(value)) : "-");
  const percentCell = (value: number) => (value ? `${(value * 100).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` : "-");

  return (
    <section className="table-panel">
      <PanelHeader
        title="Số lượng nhân sự theo tháng"
        subtitle="Số người theo khối, CP lương cho NLĐ, doanh thu và các chỉ số trên đầu người. Bếp/Bar tính trên doanh thu bếp/bar tương ứng, bộ phận khác tính trên tổng doanh thu."
      />
      <Table headers={["Nhóm", "Bộ phận", ...monthHeaders]}>
        {blocks.map(({ block, rows }) => (
          <React.Fragment key={block}>
            {rows.map((row) => (
              <HeadcountRow key={`hc-${row.code}`} group={BLOCK_LABELS[block].group} label={row.name} values={row.headcount} format={headcountCell} />
            ))}
            <HeadcountRow label={BLOCK_LABELS[block].subtotal} values={columnSum(rows.map((row) => row.headcount)).map((value) => Math.round(value * 100) / 100)} format={headcountCell} tone="bg-amber-50" strong />
          </React.Fragment>
        ))}
        <HeadcountRow label="Tổng cộng" values={headcountTotal} format={headcountCell} tone="bg-amber-100" strong />

        <HeadcountRow label="CP lương cho NLĐ" values={salaryTotal} format={moneyCell} tone="bg-amber-50" strong />
        {departments.map((row) => (
          <HeadcountRow key={`sal-${row.code}`} label={row.name} values={row.salary} format={moneyCell} />
        ))}

        <HeadcountRow label="Doanh thu sau thuế" values={totalRevenue} format={moneyCell} tone="bg-orange-50" strong />
        {revenueDetailRows.map((row) => (
          <HeadcountRow key={`rev-${row.key}`} label={row.label} values={row.values} format={moneyCell} tone="bg-orange-50/60" />
        ))}

        <HeadcountRow label="% CP lương / DT sau thuế" values={data.months.map((_, index) => ratioOf(salaryTotal[index], totalRevenue[index]))} format={percentCell} tone="bg-emerald-50" strong />
        {departments.map((row) => (
          <HeadcountRow key={`pct-${row.code}`} label={row.name} values={data.months.map((_, index) => ratioOf(row.salary[index], row.revenueBase[index]))} format={percentCell} tone="bg-emerald-50/50" />
        ))}

        <HeadcountRow label="CP lương / người" values={data.months.map((_, index) => ratioOf(salaryTotal[index], headcountTotal[index]))} format={moneyCell} strong />
        {departments.map((row) => (
          <HeadcountRow key={`spp-${row.code}`} label={row.name} values={data.months.map((_, index) => ratioOf(row.salary[index], row.headcount[index]))} format={moneyCell} />
        ))}

        <HeadcountRow label="DT / người" values={data.months.map((_, index) => ratioOf(totalRevenue[index], headcountTotal[index]))} format={moneyCell} tone="bg-orange-50" strong />
        {departments.map((row) => (
          <HeadcountRow key={`rpp-${row.code}`} label={row.name} values={data.months.map((_, index) => ratioOf(row.revenueBase[index], row.headcount[index]))} format={moneyCell} tone="bg-orange-50/60" />
        ))}
      </Table>
    </section>
  );
}
