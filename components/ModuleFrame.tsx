"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

export function ModuleFrame({ title, subtitle, role, children }: { title: string; subtitle: string; role?: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-4 sm:px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <button type="button" title="Quay lại Dashboard" onClick={() => router.push("/")} className="h-9 w-9 shrink-0 rounded-lg bg-slate-100 hover:bg-slate-200 grid place-items-center">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold truncate">{title}</h1>
            <p className="text-xs text-slate-500 truncate">{subtitle}</p>
          </div>
        </div>
        <p className="hidden sm:block text-xs font-bold text-slate-500">{role}</p>
      </header>
      <main className="max-w-7xl mx-auto p-4 sm:p-6">{children}</main>
    </div>
  );
}

export function ModuleTabs({ tabs, active, onChange }: { tabs: Array<{ id: string; label: string; icon: string }>; active: string; onChange: (id: string) => void }) {
  return (
    <div className="flex gap-1 border-b border-slate-200 overflow-x-auto mb-5">
      {tabs.map((tab) => (
        <button key={tab.id} type="button" onClick={() => onChange(tab.id)} className={`px-4 py-3 text-sm font-bold whitespace-nowrap border-b-2 flex items-center gap-2 ${active === tab.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
          <span className="material-symbols-outlined text-lg">{tab.icon}</span>{tab.label}
        </button>
      ))}
    </div>
  );
}
