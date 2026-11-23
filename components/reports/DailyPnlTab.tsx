"use client";

import { Cell, Kpi, PanelHeader, Table, money } from "@/components/reports/report-ui";
import type { DailyPnlData } from "@/lib/daily-pnl-server";

/**
 * Báo cáo theo ngày (khách 23/11/2026): mỗi ngày của tháng một dòng — Doanh thu (Sổ doanh thu, đã
 * gồm thuế), COGS (xuất bán theo rã BOM của ngày), Lương NLĐ / CAPEX / CP cố định / CP biến đổi
 * (số cả tháng trên P&L chia đều số ngày) và Số lượng nhân sự (bảng lương tháng). Số do máy chủ
 * tính sẵn (lib/daily-pnl-server.ts).
 */

const weekday = (date: string) => ["CN", "T2", "T3", "T4", "T5", "T6", "T7"][new Date(`${date}T00:00:00Z`).getUTCDay()];
const headcountText = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 2 }).format(value);

export default function DailyPnlTab({ data }: { data: DailyPnlData }) {
  const totals = data.rows.reduce(
    (sum, row) => ({
      revenue: sum.revenue + row.revenue,
      cogs: sum.cogs + row.cogs,
      payroll: sum.payroll + row.payroll,
      capex: sum.capex + row.capex,
      fixedCost: sum.fixedCost + row.fixedCost,
      variableCost: sum.variableCost + row.variableCost,
    }),
    { revenue: 0, cogs: 0, payroll: 0, capex: 0, fixedCost: 0, variableCost: 0 },
  );
  const resultOf = (row: { revenue: number; cogs: number; payroll: number; capex: number; fixedCost: number; variableCost: number }) =>
    row.revenue - row.cogs - row.payroll - row.capex - row.fixedCost - row.variableCost;
  const daysWithRevenue = data.rows.filter((row) => Math.abs(row.revenue) > 0.5).length;
  const daysWithoutCogs = data.rows.filter((row) => Math.abs(row.revenue) > 0.5 && Math.abs(row.cogs) < 0.5).length;
  const [year, month] = data.period.split("-");

  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Doanh thu cả tháng" value={totals.revenue} icon="point_of_sale" tone="blue" />
        <Kpi label="COGS theo rã BOM" value={totals.cogs} icon="inventory" tone="amber" />
        <Kpi label="Chi phí lương NLĐ" value={totals.payroll} icon="groups" />
        <Kpi label="Kết quả sau các khoản" value={resultOf(totals)} icon="trending_up" tone={resultOf(totals) >= 0 ? "green" : "rose"} />
      </section>

      <section className="bg-white border border-slate-200 rounded-lg">
        <PanelHeader
          title={`Báo cáo theo ngày ${month}/${year}`}
          subtitle={`${data.days} ngày · ${daysWithRevenue} ngày có doanh thu · ${data.branchCode === "ALL" ? "Tất cả cửa hàng" : data.branchCode}`}
          exportFileName={`bao_cao_theo_ngay_${data.period}_${data.branchCode}`}
        />
        <Table
          stickyHeader
          rightFrom={1}
          headers={["Ngày", "Doanh thu", "COGS", "Chi phí lương NLĐ", "CAPEX", "Chi phí cố định", "Chi phí biến đổi", "Kết quả", "Số lượng nhân sự"]}
        >
          {data.rows.map((row) => {
            const result = resultOf(row);
            return (
              <tr key={row.date} className={`border-t border-slate-100 ${Math.abs(row.revenue) < 0.5 ? "text-slate-400" : ""}`}>
                <Cell>{row.date.slice(8, 10)}/{month} <span className="text-[11px] text-slate-400">{weekday(row.date)}</span></Cell>
                <Cell right>{money(row.revenue)}</Cell>
                <Cell right>{money(row.cogs)}</Cell>
                <Cell right>{money(row.payroll)}</Cell>
                <Cell right>{money(row.capex)}</Cell>
                <Cell right>{money(row.fixedCost)}</Cell>
                <Cell right>{money(row.variableCost)}</Cell>
                <Cell right><span className={result < 0 ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold"}>{money(result)}</span></Cell>
                <Cell right>{headcountText(row.headcount)}</Cell>
              </tr>
            );
          })}
          <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
            <Cell>Tổng tháng</Cell>
            <Cell right>{money(totals.revenue)}</Cell>
            <Cell right>{money(totals.cogs)}</Cell>
            <Cell right>{money(totals.payroll)}</Cell>
            <Cell right>{money(totals.capex)}</Cell>
            <Cell right>{money(totals.fixedCost)}</Cell>
            <Cell right>{money(totals.variableCost)}</Cell>
            <Cell right><span className={resultOf(totals) < 0 ? "text-rose-600" : "text-emerald-700"}>{money(resultOf(totals))}</span></Cell>
            <Cell right>{headcountText(data.month.headcount)}</Cell>
          </tr>
        </Table>
        <div className="space-y-1 border-t border-slate-100 p-4 text-xs text-slate-500">
          <p><b>Doanh thu</b>: Sổ doanh thu, cột Tổng tiền (đã gồm SVC và thuế) theo ngày bán.</p>
          <p>
            <b>COGS</b>: giá vốn phiếu Xuất bán sinh ra khi Rã nguyên liệu (rã BOM) của từng ngày. Ngày chưa rã thì COGS = 0
            {daysWithoutCogs > 0 && <span className="font-semibold text-amber-700"> — tháng này còn {daysWithoutCogs} ngày có doanh thu nhưng chưa rã</span>}.
            COGS trên P&L tháng (tính theo xuất kho, hủy, kiểm kê) là {money(data.month.pnlCogs)} đ nên có thể lệch với tổng cột này.
          </p>
          <p>
            <b>Chi phí lương NLĐ, CAPEX, Chi phí cố định, Chi phí biến đổi</b>: số cả tháng trên P&L chia đều {data.days} ngày
            (lương {money(data.month.payroll)} đ · CAPEX {money(data.month.capex)} đ · cố định {money(data.month.fixedCost)} đ · biến đổi {money(data.month.variableCost)} đ).
            Chi phí biến đổi gồm cả nhóm Marketing ({money(data.month.marketing)} đ), giống cách tính Điểm hòa vốn.
          </p>
          <p><b>Số lượng nhân sự</b>: cột Số nhân sự của bảng lương theo bộ phận đã import cho tháng này{data.month.headcount === 0 ? " — tháng này chưa import bảng lương" : ""}.</p>
        </div>
      </section>
    </div>
  );
}
