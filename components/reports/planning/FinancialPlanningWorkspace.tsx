"use client";

import React, { useCallback, useEffect, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { PillTabs, Tag } from "@/components/reports/planning/planning-ui";
import { type PlanningData } from "@/components/reports/planning/planning-types";
import PnlForecastTab from "@/components/reports/planning/PnlForecastTab";
import PnlDashboardTab from "@/components/reports/planning/PnlDashboardTab";
import BudgetControlTab from "@/components/reports/planning/BudgetControlTab";
import BreakEvenTab from "@/components/reports/planning/BreakEvenTab";
import ScenarioTab from "@/components/reports/planning/ScenarioTab";

/**
 * Cụm "Hoạch định tài chính" trong tab P&L — học theo phần mềm Omni Plan mà khách hàng đã xem:
 * một thanh tab viên thuốc chuyển giữa Kỳ (bảng KQKD một tháng như cũ), Dự báo P&L, Dashboard
 * P&L, Định mức, Điểm hòa vốn, Giả định tài chính. Năm số liệu = năm của kỳ đang chọn; dữ liệu
 * type=pnl-matrix nạp một lần rồi dùng chung cho 5 màn.
 */

export type PlanningTabId = "period" | "forecast" | "dashboard" | "control" | "breakeven" | "scenario";
const TABS: Array<{ id: PlanningTabId; label: string; icon: string }> = [
  { id: "period", label: "Kỳ tháng", icon: "calendar_month" },
  { id: "forecast", label: "Dự báo P&L", icon: "table_chart" },
  { id: "dashboard", label: "Dashboard P&L", icon: "dashboard" },
  { id: "control", label: "Định mức", icon: "price_check" },
  { id: "breakeven", label: "Điểm hòa vốn", icon: "balance" },
  { id: "scenario", label: "Giả định tài chính", icon: "tune" },
];

export default function FinancialPlanningWorkspace({ period, branchCode, periodView, onOpenBudget, initialTab = "dashboard" }: {
  period: string; branchCode: string; periodView: React.ReactNode; onOpenBudget?: () => void; initialTab?: PlanningTabId;
}) {
  const [tab, setTab] = useState<PlanningTabId>(initialTab);
  const year = period.slice(0, 4);
  // Lũy kế mặc định tới tháng của kỳ đang chọn — đổi kỳ thì chip lũy kế đi theo.
  const [upTo, setUpTo] = useState(Math.max(0, Math.min(11, Number(period.slice(5)) - 1)));
  const [data, setData] = useState<PlanningData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    window.setTimeout(() => setUpTo(Math.max(0, Math.min(11, Number(period.slice(5)) - 1))), 0);
  }, [period]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ type: "pnl-matrix", period, branchCode });
      const response = await fetch(`/api/reports?${params.toString()}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error || "Không tải được số liệu hoạch định.");
        setData(null);
        return;
      }
      setData((await response.json()) as PlanningData);
    } catch {
      setError("Lỗi kết nối máy chủ khi tải số liệu hoạch định.");
    } finally {
      setLoading(false);
    }
  }, [period, branchCode]);

  // setTimeout 0 để tránh setState đồng bộ trong effect — cùng pattern với app/reports/page.tsx.
  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const yearContent = () => {
    if (loading && !data) return <p className="py-14 text-center text-sm text-slate-500 animate-pulse">Đang tổng hợp số liệu hoạch định năm {year}...</p>;
    if (error) return <p className="py-10 text-center text-sm text-rose-600">{error}</p>;
    if (!data) return null;
    if (tab === "forecast") return <PnlForecastTab data={data} onRefresh={() => void load()} onOpenBudget={onOpenBudget} />;
    if (tab === "dashboard") return <PnlDashboardTab data={data} upTo={upTo} onChangeUpTo={setUpTo} />;
    if (tab === "control") return <BudgetControlTab data={data} upTo={upTo} onChangeUpTo={setUpTo} onOpenBudget={onOpenBudget} />;
    if (tab === "breakeven") return <BreakEvenTab data={data} upTo={upTo} onChangeUpTo={setUpTo} />;
    if (tab === "scenario") return <ScenarioTab data={data} upTo={upTo} onChangeUpTo={setUpTo} />;
    return null;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PillTabs tabs={TABS} active={tab} onChange={(id) => setTab(id as PlanningTabId)} />
        <div className="ml-auto flex items-center gap-2">
          <Tag tone="indigo" className="text-[11px] px-2.5 py-1"><span className="material-symbols-outlined text-sm align-middle mr-1">calendar_today</span>{tab === "period" ? `Kỳ ${period}` : `Năm ${year}`}</Tag>
          <Tag tone="slate" className="text-[11px] px-2.5 py-1"><span className="material-symbols-outlined text-sm align-middle mr-1">storefront</span>{storeLabel(branchCode)}</Tag>
          {loading && data && <span className="material-symbols-outlined animate-spin text-indigo-500 text-lg">progress_activity</span>}
        </div>
      </div>
      {tab === "period" ? periodView : yearContent()}
    </div>
  );
}
