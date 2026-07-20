"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { branchScopeOptions, displayRoleName } from "@/lib/branch-labels";
import { SESSION_KEY, type DemoSession } from "@/lib/auth-demo";

export function ModuleFrame({
  title,
  subtitle,
  role,
  branchCode,
  onChangeBranch,
  children,
}: {
  title: string;
  subtitle: string;
  role?: string;
  branchCode?: string;
  onChangeBranch?: (code: string) => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const [isLocked, setIsLocked] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DemoSession;
        if (parsed.allowedBranches?.length === 1 && !parsed.allowedBranches.includes("ALL")) {
          window.setTimeout(() => setIsLocked(true), 0);
        }
      } catch (e) {
        console.error(e);
      }
    }
  }, []);

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 sm:px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            title="Quay lại Dashboard"
            onClick={() => router.push("/")}
            className="h-9 w-9 shrink-0 rounded-lg bg-slate-100 hover:bg-slate-200 grid place-items-center"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold truncate">{title}</h1>
            <p className="text-xs text-slate-500 truncate">{subtitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {onChangeBranch && branchCode && (
            <div className="relative">
              <select
                value={branchCode}
                onChange={(e) => {
                  onChangeBranch(e.target.value);
                  localStorage.setItem("global_branch_code", e.target.value);
                }}
                disabled={isLocked}
                className="pl-3 pr-8 py-1.5 bg-slate-100 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-xs font-semibold outline-none cursor-pointer appearance-none transition-all disabled:opacity-75 disabled:cursor-not-allowed"
              >
                {branchScopeOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-base">
                unfold_more
              </span>
            </div>
          )}
          <p className="hidden sm:block text-xs font-bold text-slate-500">{displayRoleName(role)}</p>
        </div>
      </header>
      <main className="max-w-7xl mx-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}

export function ModuleTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string; icon: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-slate-200 overflow-x-auto mb-5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`px-4 py-3 text-sm font-bold whitespace-nowrap border-b-2 flex items-center gap-2 ${
            active === tab.id
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-slate-500 hover:text-slate-800"
          }`}
        >
          <span className="material-symbols-outlined text-lg">{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </div>
  );
}
