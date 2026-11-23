"use client";

import { useEffect, useState } from "react";
import ImportUploadPage from "@/app/imports/ImportUploadPage";
import { SESSION_KEY, type DemoSession } from "@/lib/auth-demo";
import { allowedImportTabsForRole, type ImportTab } from "@/lib/import-tabs";

/**
 * Mục "Chi phí lương nhân viên" ở nhóm Chi phí & Công nợ (khách 23/11/2026: "bốc ra từ màn hình
 * import"). Hai khung import bảng lương của màn Import dữ liệu: Bảng lương theo bộ phận (mẫu đang
 * dùng) và mẫu cũ theo nhân viên. Quyền vẫn theo Import dữ liệu như cũ.
 */
const PAYROLL_TAB_IDS = ["payroll-department", "payroll"];

function readRole() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as DemoSession).role : "";
  } catch {
    return "";
  }
}

export default function PayrollCostsPage() {
  const [tabs, setTabs] = useState<ImportTab[]>([]);
  const [active, setActive] = useState(PAYROLL_TAB_IDS[0]);

  useEffect(() => {
    const allowed = allowedImportTabsForRole(readRole()).filter((tab) => PAYROLL_TAB_IDS.includes(tab.id));
    const requested = new URLSearchParams(window.location.search).get("tab") || "";
    const timer = window.setTimeout(() => {
      setTabs(allowed);
      if (allowed.some((tab) => tab.id === requested)) setActive(requested);
      else if (allowed[0]) setActive(allowed[0].id);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const current = tabs.find((tab) => tab.id === active) || tabs[0];
  // Chưa có phiên hoặc không được import bảng lương: ImportUploadPage tự đưa về đăng nhập / trang chủ.
  const fallback = current || allowedImportTabsForRole("").find((tab) => tab.id === PAYROLL_TAB_IDS[0]);
  if (!fallback) return null;

  const changeTab = (id: string) => {
    setActive(id);
    window.history.replaceState(null, "", `/payroll-costs?tab=${id}`);
  };
  const navigation = tabs.length > 1 ? (
    <nav className="rounded-lg border border-slate-200 bg-white p-1.5 shadow-sm" aria-label="Loại bảng lương">
      <div className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={fallback.id === tab.id}
            onClick={() => changeTab(tab.id)}
            className={`flex min-w-max items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm font-bold transition-colors duration-150 lg:min-w-0 ${fallback.id === tab.id
              ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900"
            }`}
          >
            <span className={`material-symbols-outlined text-lg ${fallback.id === tab.id ? "text-blue-600" : "text-slate-500"}`}>{tab.icon}</span>
            <span className="truncate">{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  ) : undefined;

  return (
    <ImportUploadPage
      title={fallback.id === "payroll" ? "Chi phí lương nhân viên — mẫu cũ theo nhân viên" : "Chi phí lương nhân viên"}
      subtitle={fallback.subtitle}
      menuHref="/imports"
      apiPath={fallback.apiPath}
      templatePath={fallback.templatePath}
      templateCode={fallback.templateCode}
      primaryFields={fallback.primaryFields}
      requiresBranch={fallback.requiresBranch}
      navigation={navigation}
    />
  );
}
