"use client";

import { visibleBranchScopeOptions } from "@/lib/branch-labels";
import type { DemoSession } from "@/lib/auth-demo";

type BranchScopeSelectProps = {
  session: DemoSession | null;
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

export function resolveInitialBranchScope(session: DemoSession | null, fallback = "ALL") {
  if (!session) return fallback;
  const allowed = session.allowedBranches?.length ? session.allowedBranches : ["ALL"];
  if (allowed.length === 1 && !allowed.includes("ALL")) return allowed[0];
  const stored = typeof window === "undefined" ? "" : localStorage.getItem("global_branch_code") || "";
  if (stored && (allowed.includes("ALL") || allowed.includes(stored))) return stored;
  return allowed.includes("ALL") ? "ALL" : allowed[0] || fallback;
}

export function BranchScopeSelect({ session, value, onChange, className = "" }: BranchScopeSelectProps) {
  const allowed = session?.allowedBranches?.length ? session.allowedBranches : ["ALL"];
  const locked = allowed.length === 1 && !allowed.includes("ALL");
  const options = visibleBranchScopeOptions(allowed);

  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          localStorage.setItem("global_branch_code", event.target.value);
        }}
        disabled={locked}
        className="h-9 min-w-[190px] appearance-none rounded-lg border border-slate-200 bg-slate-100 py-1.5 pl-3 pr-8 text-xs font-bold outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-75"
      >
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-base text-slate-400">
        unfold_more
      </span>
    </div>
  );
}
