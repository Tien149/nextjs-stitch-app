"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ModuleFrame, ModuleTabs } from "@/components/ModuleFrame";
import { MonthInput } from "@/components/DateInput";
import { branchScopeOptions, storeLabel, storeOptions } from "@/lib/branch-labels";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type Pnl = {
  revenue: number;
  cogs: number;
  payroll: number;
  depreciation: number;
  otherOpex: number;
  otherIncome: number;
  otherExpense: number;
  grossProfit: number;
  opexBeforeDepreciation: number;
  ebitda: number;
  operatingProfit: number;
  netProfit: number;
  grossMargin: number;
  ebitdaMargin: number;
};

type PnlCut = Pnl & { code: string };
type BalanceRow = { code: string; name: string; accountType: string; reportGroup: string; amount: number };
type BalanceData = { rows: BalanceRow[]; assets: number; liabilities: number; contributedEquity: number; retainedEarnings: number; equity: number; difference: number; balanced: boolean };
type DashboardData = { pnl: { total: Pnl; byBranch: PnlCut[] }; trend: Array<Pnl & { period: string }>; balance: BalanceData; targets: Array<{ metric: string; targetValue: number }> };
type PnlData = { total: Pnl; byBranch: PnlCut[]; byDepartment: PnlCut[] };
type YoyData = { previousPeriod: string; rows: Array<{ metric: string; currentValue: number; previousValue: number; variance: number; varianceRate: number | null }> };
type CashflowData = { scenario: string; startingCash: number; schedule: Array<{ period: string; inflow: number; outflow: number; closingCash: number; risk: boolean }> };
type OperationGroup = { departmentCode: string; departmentName: string; count: number; amount: number; statusCounts: Record<string, number>; overdue?: number };
type OperationDetail = { id: string; code: string; date: string; branchCode: string; departmentCode: string; departmentName: string; status: string; amount: number; owner: string; note: string; overdue?: boolean };
type OperationKey = "purchaseRequests" | "purchaseOrders" | "receipts" | "workItems" | "assets";
type OperationsData = {
  summary: {
    purchaseRequests: { count: number; amount: number };
    purchaseOrders: { count: number; amount: number };
    receipts: { count: number; amount: number };
    workItems: { count: number; overdue: number };
    assets: { count: number; amount: number };
  };
  groups: Record<OperationKey, OperationGroup[]>;
  details: Record<OperationKey, OperationDetail[]>;
};
type BudgetRow = { metric: string; label: string; kind: "REVENUE" | "EXPENSE" | "PROFIT"; actual: number; target: number; variance: number; usageRate: number | null; isGood: boolean };
type BudgetData = { summary: { expenseActual: number; expenseTarget: number; revenueActual: number; revenueTarget: number }; rows: BudgetRow[] };
type ActivityLog = { id: string; time: string; module: string; action: string; actor: string; branchCode: string; code: string; note: string };
type AccountingPeriodStatus = { period: string; branchCode: string; status: string; closedBy: string | null; closedAt: string | null; reopenedBy: string | null; reopenedAt: string | null; reason: string | null };
type ActivityData = { accountingPeriod: AccountingPeriodStatus; periods: AccountingPeriodStatus[]; logs: ActivityLog[] };
type ReportData = DashboardData | PnlData | YoyData | CashflowData | BalanceData | OperationsData | BudgetData | ActivityData;

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);
const metricLabels: Record<string, string> = {
  revenue: "Doanh thu",
  cogs: "Giá vốn",
  grossProfit: "Lợi nhuận gộp",
  payroll: "Chi phí nhân sự",
  otherOpex: "OPEX khác",
  depreciation: "Khấu hao",
  opexBeforeDepreciation: "OPEX trước khấu hao",
  ebitda: "EBITDA",
  netProfit: "Lợi nhuận ròng",
};

export default function ReportsPage() {
  const href = "/reports";
  const { user, loading } = useModuleAuth(href);
  const [active, setActive] = useState("dashboard");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [branchCode, setBranchCode] = useState("ALL");
  const [scenario, setScenario] = useState("BASE");
  const [data, setData] = useState<ReportData | null>(null);
  const [message, setMessage] = useState("");
  const [forecast, setForecast] = useState({ period: new Date().toISOString().slice(0, 7), branchCode: "HCM", scenario: "BASE", assumptionType: "INFLOW", amount: "100000000", note: "Kế hoạch dòng tiền" });
  const [targetForm, setTargetForm] = useState({ metric: "otherOpex", targetValue: "50000000" });
  const [reopenReason, setReopenReason] = useState("Bổ sung hoặc điều chỉnh dữ liệu kỳ trước");

  const canConfigure = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canAdminPeriod = user?.role === "Admin";

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab && ["dashboard", "operations", "budget", "activity", "pnl", "yoy", "cashflow", "balance"].includes(tab)) {
      window.setTimeout(() => setActive(tab), 0);
    }
  }, []);

  const loadData = useCallback(async () => {
    const response = await fetch(`/api/reports?type=${active}&period=${period}&branchCode=${branchCode}&scenario=${scenario}`);
    if (response.ok) setData(await response.json());
  }, [active, branchCode, period, scenario]);

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadData(), 0);
  }, [loading, loadData]);

  const saveForecast = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "UPSERT_FORECAST", ...forecast }) });
    const payload = await response.json();
    setMessage(response.ok ? "Đã lưu giả định dự báo." : payload.error || "Không lưu được giả định");
    if (response.ok) await loadData();
  };

  const saveTarget = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "UPSERT_TARGET", period, branchCode, metric: targetForm.metric, targetValue: targetForm.targetValue }),
    });
    const payload = await response.json();
    setMessage(response.ok ? "Đã lưu ngân sách/target báo cáo." : payload.error || "Không lưu được ngân sách");
    if (response.ok) await loadData();
  };

  const updatePeriodStatus = async (action: "CLOSE_PERIOD" | "REOPEN_PERIOD") => {
    const response = await fetch("/api/finance-operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, period, branchCode, reason: reopenReason }),
    });
    const payload = await response.json();
    setMessage(response.ok ? (action === "CLOSE_PERIOD" ? "Đã khóa kỳ kế toán." : "Đã mở lại kỳ kế toán.") : payload.error || "Không cập nhật được kỳ");
    if (response.ok) await loadData();
  };

  const dashboard = active === "dashboard" ? data as DashboardData | null : null;
  const pnl = active === "pnl" ? data as PnlData | null : null;
  const yoy = active === "yoy" ? data as YoyData | null : null;
  const cashflow = active === "cashflow" ? data as CashflowData | null : null;
  const balance = active === "balance" ? data as BalanceData | null : null;
  const operations = active === "operations" ? data as OperationsData | null : null;
  const budget = active === "budget" ? data as BudgetData | null : null;
  const activity = active === "activity" ? data as ActivityData | null : null;

  const operationRows = useMemo(() => {
    if (!operations) return [] as Array<OperationDetail & { module: string }>;
    return [
      ...operations.details.purchaseRequests.map((row) => ({ ...row, module: "PR" })),
      ...operations.details.purchaseOrders.map((row) => ({ ...row, module: "PO" })),
      ...operations.details.receipts.map((row) => ({ ...row, module: "Nhập hàng" })),
      ...operations.details.workItems.map((row) => ({ ...row, module: "Công việc" })),
      ...operations.details.assets.map((row) => ({ ...row, module: "Tài sản/CCDC" })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [operations]);

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame title="Báo cáo & BI" subtitle="GĐ4 - Dashboard, báo cáo vận hành, ngân sách, kỳ kế toán và nhật ký" role={user?.role}>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Field label="Kỳ báo cáo">
          <MonthInput className="mt-1.5 w-40" value={period} onChange={setPeriod} ariaLabel="Kỳ báo cáo" />
        </Field>
        <Field label="Phạm vi cửa hàng">
          <select className="control w-56" value={branchCode} onChange={(event) => setBranchCode(event.target.value)}>
            {branchScopeOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
          </select>
        </Field>
        {active === "cashflow" && (
          <Field label="Kịch bản">
            <select className="control w-40" value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="BASE">Cơ sở</option>
              <option value="UPSIDE">Tích cực</option>
              <option value="DOWNSIDE">Thận trọng</option>
            </select>
          </Field>
        )}
        <button type="button" className="icon-button" title="Tải lại" onClick={() => void loadData()}>
          <span className="material-symbols-outlined text-lg">refresh</span>
        </button>
      </div>

      <ModuleTabs
        active={active}
        onChange={setActive}
        tabs={[
          { id: "dashboard", label: "Điều hành", icon: "dashboard" },
          { id: "operations", label: "Vận hành", icon: "fact_check" },
          { id: "budget", label: "Ngân sách", icon: "price_check" },
          { id: "activity", label: "Kỳ & Log", icon: "history" },
          { id: "pnl", label: "P&L đa chiều", icon: "finance" },
          { id: "yoy", label: "Biến động YoY", icon: "query_stats" },
          { id: "cashflow", label: "Dự báo dòng tiền", icon: "timeline" },
          { id: "balance", label: "Bảng cân đối", icon: "account_balance" },
        ]}
      />

      {message && <p className="mb-4 px-4 py-3 rounded-lg border border-blue-100 bg-blue-50 text-sm text-blue-700">{message}</p>}

      {operations && (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 xl:grid-cols-5 gap-4">
            <OpsKpi label="PR" count={operations.summary.purchaseRequests.count} amount={operations.summary.purchaseRequests.amount} icon="assignment" />
            <OpsKpi label="PO" count={operations.summary.purchaseOrders.count} amount={operations.summary.purchaseOrders.amount} icon="shopping_cart" />
            <OpsKpi label="Nhập hàng" count={operations.summary.receipts.count} amount={operations.summary.receipts.amount} icon="inventory" />
            <OpsKpi label="Công việc" count={operations.summary.workItems.count} extra={`${operations.summary.workItems.overdue} quá hạn`} icon="task_alt" />
            <OpsKpi label="Tài sản/CCDC" count={operations.summary.assets.count} amount={operations.summary.assets.amount} icon="precision_manufacturing" />
          </div>
          <div className="grid xl:grid-cols-2 gap-5">
            <OperationGroupTable title="PR theo phòng ban" rows={operations.groups.purchaseRequests} />
            <OperationGroupTable title="PO theo phòng ban" rows={operations.groups.purchaseOrders} />
            <OperationGroupTable title="Nhập hàng theo phòng ban" rows={operations.groups.receipts} />
            <OperationGroupTable title="Công việc theo phòng ban" rows={operations.groups.workItems} />
            <OperationGroupTable title="Tài sản/CCDC theo phòng ban" rows={operations.groups.assets} />
          </div>
          <section className="table-panel">
            <PanelHeader title="Danh sách chi tiết vận hành" subtitle="Scroll để xem PR, PO, nhập hàng, công việc và tài sản/CCDC trong kỳ." />
            <div className="max-h-[520px] overflow-auto">
              <Table headers={["Phần hành", "Mã", "Ngày", "Cửa hàng", "Phòng ban", "Trạng thái", "Giá trị/Phụ trách"]}>
                {operationRows.map((row) => (
                  <tr key={`${row.module}-${row.id}`} className="border-t border-slate-100">
                    <Cell><b>{row.module}</b></Cell>
                    <Cell><b>{row.code}</b><small className="block text-slate-500">{row.note}</small></Cell>
                    <Cell>{new Date(row.date).toLocaleDateString("vi-VN")}</Cell>
                    <Cell>{storeLabel(row.branchCode)}</Cell>
                    <Cell>{row.departmentName}</Cell>
                    <Cell><span className={`status ${row.overdue ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-700"}`}>{row.status}</span></Cell>
                    <Cell right>{row.amount ? `${money(row.amount)} đ` : row.owner || "-"}</Cell>
                  </tr>
                ))}
              </Table>
            </div>
          </section>
        </div>
      )}

      {budget && (
        <div className="space-y-5">
          <div className="grid md:grid-cols-4 gap-4">
            <Kpi label="Doanh thu thực tế" value={budget.summary.revenueActual} icon="payments" tone="blue" />
            <Kpi label="Target doanh thu" value={budget.summary.revenueTarget} icon="flag" />
            <Kpi label="Chi phí thực tế" value={budget.summary.expenseActual} icon="receipt_long" tone="amber" />
            <Kpi label="Ngân sách chi phí" value={budget.summary.expenseTarget} icon="price_check" tone="green" />
          </div>

          <div className="grid xl:grid-cols-[360px_1fr] gap-5">
            {canConfigure && (
              <form onSubmit={saveTarget} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit">
                <h2 className="font-bold">Thiết lập ngân sách/target</h2>
                <Field label="Chỉ tiêu">
                  <select className="control" value={targetForm.metric} onChange={(event) => setTargetForm({ ...targetForm, metric: event.target.value })}>
                    <option value="revenue">Doanh thu</option>
                    <option value="cogs">Giá vốn</option>
                    <option value="payroll">Chi phí nhân sự</option>
                    <option value="otherOpex">OPEX khác</option>
                    <option value="depreciation">Khấu hao</option>
                    <option value="opexBeforeDepreciation">OPEX trước khấu hao</option>
                    <option value="ebitda">EBITDA</option>
                  </select>
                </Field>
                <Field label="Giá trị ngân sách/target">
                  <input type="number" min="0" className="control" value={targetForm.targetValue} onChange={(event) => setTargetForm({ ...targetForm, targetValue: event.target.value })} />
                </Field>
                <button className="primary-button w-full">
                  <span className="material-symbols-outlined text-lg">save</span>Lưu ngân sách
                </button>
              </form>
            )}
            <section className="table-panel">
              <PanelHeader title="So sánh thực tế với ngân sách" subtitle="Chi phí vượt ngân sách được đánh dấu đỏ; doanh thu/lợi nhuận đạt target được đánh dấu xanh." />
              <div className="max-h-[560px] overflow-auto">
                <Table headers={["Chỉ tiêu", "Thực tế", "Ngân sách/Target", "Chênh lệch", "Tỷ lệ dùng"]}>
                  {budget.rows.map((row) => (
                    <tr key={row.metric} className="border-t border-slate-100">
                      <Cell><b>{row.label}</b><small className="block text-slate-500">{row.kind === "EXPENSE" ? "Chi phí" : row.kind === "REVENUE" ? "Doanh thu" : "Lợi nhuận"}</small></Cell>
                      <Cell right>{money(row.actual)} đ</Cell>
                      <Cell right>{row.target ? `${money(row.target)} đ` : "Chưa nhập"}</Cell>
                      <Cell right><span className={row.isGood ? "text-emerald-700" : "text-rose-700"}>{money(row.variance)} đ</span></Cell>
                      <Cell right>{row.usageRate === null ? "-" : `${(row.usageRate * 100).toFixed(1)}%`}</Cell>
                    </tr>
                  ))}
                </Table>
              </div>
            </section>
          </div>
        </div>
      )}

      {activity && (
        <div className="space-y-5">
          <div className="grid xl:grid-cols-[360px_1fr] gap-5">
            <section className="bg-white border border-slate-200 rounded-lg p-5 h-fit">
              <p className="text-xs font-bold text-blue-600 uppercase">Kỳ kế toán</p>
              <h2 className="text-xl font-bold mt-2">{period} - {branchCode === "ALL" ? "Tất cả cửa hàng" : storeLabel(branchCode)}</h2>
              <div className="mt-4 flex items-center gap-2">
                <span className={`status ${activity.accountingPeriod.status === "CLOSED" ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"}`}>{activity.accountingPeriod.status}</span>
                <span className="text-xs text-slate-500">{activity.accountingPeriod.reason || "Có thể nhập bổ sung ngày trước nếu kỳ còn mở."}</span>
              </div>
              {canAdminPeriod && (
                <div className="mt-5 space-y-3">
                  <Field label="Lý do mở lại kỳ">
                    <textarea className="control h-20 resize-none" value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" className="secondary-button" onClick={() => void updatePeriodStatus("REOPEN_PERIOD")}>Mở kỳ</button>
                    <button type="button" className="primary-button" onClick={() => void updatePeriodStatus("CLOSE_PERIOD")}>Khóa kỳ</button>
                  </div>
                </div>
              )}
            </section>
            <section className="table-panel">
              <PanelHeader title="Nhật ký kiểm tra" subtitle="Tổng hợp import, ghi sổ kế toán, workflow và thao tác khóa/mở kỳ trong kỳ đang xem." />
              <div className="max-h-[620px] overflow-auto">
                <Table headers={["Thời gian", "Module", "Người thao tác", "Cửa hàng", "Mã", "Nội dung"]}>
                  {activity.logs.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Chưa có log trong kỳ.</td></tr>
                  ) : activity.logs.map((log) => (
                    <tr key={`${log.module}-${log.id}`} className="border-t border-slate-100">
                      <Cell><b>{new Date(log.time).toLocaleDateString("vi-VN")}</b><small className="block text-slate-500">{new Date(log.time).toLocaleTimeString("vi-VN")}</small></Cell>
                      <Cell><span className="status bg-slate-100 text-slate-700">{log.module}</span><small className="block text-slate-500 mt-1">{log.action}</small></Cell>
                      <Cell>{log.actor}</Cell>
                      <Cell>{log.branchCode === "ALL" ? "Tất cả" : storeLabel(log.branchCode)}</Cell>
                      <Cell><b>{log.code}</b></Cell>
                      <Cell right={false}>{log.note}</Cell>
                    </tr>
                  ))}
                </Table>
              </div>
            </section>
          </div>
        </div>
      )}

      {dashboard && (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Kpi label="Doanh thu" value={dashboard.pnl.total.revenue} icon="payments" />
            <Kpi label="Lợi nhuận gộp" value={dashboard.pnl.total.grossProfit} icon="trending_up" tone="green" />
            <Kpi label="EBITDA" value={dashboard.pnl.total.ebitda} icon="monitoring" tone="blue" />
            <Kpi label="Tiền hiện có" value={dashboard.balance.rows.filter((row) => row.reportGroup === "CASH").reduce((sum, row) => sum + row.amount, 0)} icon="account_balance_wallet" tone="amber" />
          </div>
          <div className="grid xl:grid-cols-[1.4fr_1fr] gap-5">
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="font-bold">Xu hướng 6 tháng</h2>
              <p className="text-xs text-slate-500 mt-1">Doanh thu và EBITDA từ dữ liệu đã ghi sổ.</p>
              <div className="mt-6 space-y-4">
                {dashboard.trend.map((row) => {
                  const max = Math.max(...dashboard.trend.map((item) => Math.abs(item.revenue)), 1);
                  return (
                    <div key={row.period} className="grid grid-cols-[70px_1fr_120px] gap-3 items-center text-sm">
                      <b>{row.period}</b>
                      <div className="h-6 bg-slate-100 rounded overflow-hidden"><div className="h-full bg-blue-600" style={{ width: `${Math.max(2, Math.abs(row.revenue) / max * 100)}%` }} /></div>
                      <span className="text-right font-bold">{money(row.revenue)} đ</span>
                    </div>
                  );
                })}
              </div>
            </section>
            <section className="bg-white border border-slate-200 rounded-lg p-5">
              <h2 className="font-bold">Hiệu quả theo cửa hàng</h2>
              <div className="mt-4 divide-y divide-slate-100">
                {dashboard.pnl.byBranch.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Chưa có dữ liệu ghi sổ.</p> : dashboard.pnl.byBranch.map((row) => (
                  <div key={row.code} className="py-3 flex justify-between gap-3">
                    <div><b>{storeLabel(row.code)}</b><p className="text-xs text-slate-500 mt-1">Biên gộp {(row.grossMargin * 100).toFixed(1)}%</p></div>
                    <div className="text-right"><b>{money(row.revenue)} đ</b><p className={`text-xs mt-1 ${row.ebitda >= 0 ? "text-emerald-600" : "text-rose-600"}`}>EBITDA {money(row.ebitda)} đ</p></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      )}

      {pnl && (
        <div className="space-y-5">
          <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <PanelHeader title="Báo cáo Kết quả Kinh doanh" subtitle="Đơn vị: VND" />
            <PnlTable value={pnl.total} />
          </section>
          <div className="grid xl:grid-cols-2 gap-5">
            <CutTable title="Theo cửa hàng" rows={pnl.byBranch} />
            <CutTable title="Theo phòng ban" rows={pnl.byDepartment} />
          </div>
        </div>
      )}

      {yoy && (
        <section className="table-panel">
          <PanelHeader title={`So sánh ${period} với ${yoy.previousPeriod}`} subtitle="Chỉ hiển thị tỷ lệ khi kỳ trước có dữ liệu." />
          <Table headers={["Chỉ tiêu", period, yoy.previousPeriod, "Chênh lệch", "Tỷ lệ"]}>
            {yoy.rows.map((row) => (
              <tr key={row.metric} className="border-t border-slate-100">
                <Cell><b>{metricLabels[row.metric] || row.metric}</b></Cell>
                <Cell right>{money(row.currentValue)} đ</Cell>
                <Cell right>{money(row.previousValue)} đ</Cell>
                <Cell right><span className={row.variance >= 0 ? "text-emerald-700" : "text-rose-700"}>{money(row.variance)} đ</span></Cell>
                <Cell right>{row.varianceRate === null ? "Thiếu dữ liệu" : `${(row.varianceRate * 100).toFixed(1)}%`}</Cell>
              </tr>
            ))}
          </Table>
        </section>
      )}

      {cashflow && (
        <div className="grid xl:grid-cols-[360px_1fr] gap-5">
          {canConfigure && (
            <form onSubmit={saveForecast} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 h-fit">
              <h2 className="font-bold">Giả định dòng tiền</h2>
              <Field label="Kỳ dự kiến"><MonthInput className="mt-1.5" value={forecast.period} onChange={(value) => setForecast({ ...forecast, period: value })} ariaLabel="Kỳ dự kiến" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cửa hàng"><select className="control" value={forecast.branchCode} onChange={(event) => setForecast({ ...forecast, branchCode: event.target.value })}>{storeOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}</select></Field>
                <Field label="Kịch bản"><select className="control" value={forecast.scenario} onChange={(event) => setForecast({ ...forecast, scenario: event.target.value })}><option value="BASE">Cơ sở</option><option value="UPSIDE">Tích cực</option><option value="DOWNSIDE">Thận trọng</option></select></Field>
              </div>
              <Field label="Loại"><select className="control" value={forecast.assumptionType} onChange={(event) => setForecast({ ...forecast, assumptionType: event.target.value })}><option value="INFLOW">Dòng tiền vào</option><option value="OUTFLOW">Dòng tiền ra</option></select></Field>
              <Field label="Số tiền"><input type="number" className="control" value={forecast.amount} onChange={(event) => setForecast({ ...forecast, amount: event.target.value })} /></Field>
              <Field label="Ghi chú"><textarea className="control h-20 resize-none" value={forecast.note} onChange={(event) => setForecast({ ...forecast, note: event.target.value })} /></Field>
              <button className="primary-button w-full">Lưu giả định</button>
            </form>
          )}
          <section className="table-panel">
            <PanelHeader title={`Dự báo 3 tháng - ${cashflow.scenario}`} subtitle={`Số dư bắt đầu: ${money(cashflow.startingCash)} đ`} />
            <Table headers={["Kỳ", "Dòng tiền vào", "Dòng tiền ra", "Số dư dự kiến", "Cảnh báo"]}>
              {cashflow.schedule.map((row) => (
                <tr key={row.period} className="border-t border-slate-100">
                  <Cell><b>{row.period}</b></Cell>
                  <Cell right className="text-emerald-700">{money(row.inflow)} đ</Cell>
                  <Cell right className="text-rose-700">{money(row.outflow)} đ</Cell>
                  <Cell right><b>{money(row.closingCash)} đ</b></Cell>
                  <Cell>{row.risk ? <span className="status bg-rose-50 text-rose-700">Thiếu tiền</span> : <span className="status bg-emerald-50 text-emerald-700">An toàn</span>}</Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}

      {balance && (
        <div className="space-y-5">
          <div className="grid sm:grid-cols-3 gap-4">
            <Kpi label="Tổng tài sản" value={balance.assets} icon="apartment" />
            <Kpi label="Nợ phải trả" value={balance.liabilities} icon="credit_card" tone="amber" />
            <Kpi label="Vốn chủ sở hữu" value={balance.equity} icon="savings" tone="green" />
          </div>
          <section className="table-panel">
            <div className="p-5 flex items-center justify-between">
              <div><h2 className="font-bold">Phân tích Bảng cân đối</h2><p className="text-xs text-slate-500 mt-1">Lợi nhuận lũy kế: {money(balance.retainedEarnings)} đ</p></div>
              <span className={`status ${balance.balanced ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>{balance.balanced ? "CÂN" : `LỆCH ${money(balance.difference)} đ`}</span>
            </div>
            <Table headers={["Tài khoản", "Tên", "Nhóm", "Loại", "Số dư"]}>
              {balance.rows.map((row) => (
                <tr key={row.code} className="border-t border-slate-100">
                  <Cell><b>{row.code}</b></Cell>
                  <Cell>{row.name}</Cell>
                  <Cell>{row.reportGroup}</Cell>
                  <Cell>{row.accountType}</Cell>
                  <Cell right><b>{money(row.amount)} đ</b></Cell>
                </tr>
              ))}
            </Table>
          </section>
        </div>
      )}
    </ModuleFrame>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return <div className="p-5"><h2 className="font-bold">{title}</h2>{subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}</div>;
}

function Kpi({ label, value, icon, tone = "slate" }: { label: string; value: number; icon: string; tone?: "slate" | "green" | "blue" | "amber" }) {
  const style = tone === "green" ? "bg-emerald-50 text-emerald-600" : tone === "blue" ? "bg-blue-50 text-blue-600" : tone === "amber" ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-600";
  return <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center gap-3"><div className={`h-11 w-11 rounded-lg grid place-items-center ${style}`}><span className="material-symbols-outlined">{icon}</span></div><div><p className="text-xs text-slate-500">{label}</p><p className="text-lg font-bold mt-1">{money(value)} đ</p></div></div>;
}

function OpsKpi({ label, count, amount, extra, icon }: { label: string; count: number; amount?: number; extra?: string; icon: string }) {
  return <div className="bg-white border border-slate-200 rounded-lg p-4 flex items-center gap-3"><div className="h-11 w-11 rounded-lg grid place-items-center bg-blue-50 text-blue-600"><span className="material-symbols-outlined">{icon}</span></div><div><p className="text-xs text-slate-500">{label}</p><p className="text-lg font-bold mt-1">{count}</p><p className="text-[11px] text-slate-500 mt-0.5">{amount !== undefined ? `${money(amount)} đ` : extra || ""}</p></div></div>;
}

function OperationGroupTable({ title, rows }: { title: string; rows: OperationGroup[] }) {
  return (
    <section className="table-panel">
      <PanelHeader title={title} />
      <Table headers={["Phòng ban", "Số dòng", "Giá trị", "Trạng thái"]}>
        {rows.length === 0 ? (
          <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">Chưa có dữ liệu trong kỳ.</td></tr>
        ) : rows.map((row) => (
          <tr key={row.departmentCode} className="border-t border-slate-100">
            <Cell><b>{row.departmentName}</b>{row.overdue ? <small className="block text-rose-600">{row.overdue} quá hạn</small> : null}</Cell>
            <Cell>{row.count}</Cell>
            <Cell right>{row.amount ? `${money(row.amount)} đ` : "-"}</Cell>
            <Cell>{Object.entries(row.statusCounts).map(([status, count]) => <span key={status} className="status bg-slate-100 text-slate-700 mr-1 mb-1">{status}: {count}</span>)}</Cell>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function PnlTable({ value }: { value: Pnl }) {
  const rows = [["Doanh thu", value.revenue], ["Giá vốn", -value.cogs], ["Lợi nhuận gộp", value.grossProfit], ["Chi phí nhân sự", -value.payroll], ["OPEX khác", -value.otherOpex], ["EBITDA", value.ebitda], ["Khấu hao", -value.depreciation], ["Lợi nhuận hoạt động", value.operatingProfit], ["Thu nhập khác", value.otherIncome], ["Lợi nhuận ròng", value.netProfit]] as const;
  return <div className="divide-y divide-slate-100">{rows.map(([label, amount]) => <div key={label} className={`px-5 py-3 flex justify-between ${["Lợi nhuận gộp", "EBITDA", "Lợi nhuận ròng"].includes(label) ? "bg-slate-50 font-bold" : ""}`}><span>{label}</span><span className={amount < 0 ? "text-rose-700" : ""}>{money(amount)} đ</span></div>)}</div>;
}

function CutTable({ title, rows }: { title: string; rows: PnlCut[] }) {
  return (
    <section className="table-panel">
      <PanelHeader title={title} />
      <Table headers={["Đơn vị", "Doanh thu", "Lợi nhuận gộp", "EBITDA"]}>
        {rows.map((row) => (
          <tr key={row.code} className="border-t border-slate-100">
            <Cell><b>{storeLabel(row.code)}</b></Cell>
            <Cell right>{money(row.revenue)} đ</Cell>
            <Cell right>{money(row.grossProfit)} đ</Cell>
            <Cell right>{money(row.ebitda)} đ</Cell>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs font-bold text-slate-600">{label}{children}</label>;
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500 uppercase"><tr>{headers.map((header) => <th key={header} className="px-4 py-3 text-left last:text-right">{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

function Cell({ children, right = false, className = "" }: { children: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={`cell ${right ? "text-right" : ""} ${className}`}>{children}</td>;
}
