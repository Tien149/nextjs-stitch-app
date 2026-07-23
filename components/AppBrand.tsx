"use client";

import { useEffect, useState } from "react";

type Branding = {
  name: string;
  subtitle: string;
  logoUrl: string;
};

export function AppBrand({
  variant = "dark",
  compact = false,
  showText = false,
}: {
  variant?: "dark" | "light";
  compact?: boolean;
  showText?: boolean;
}) {
  const [branding, setBranding] = useState<Branding>({ name: "FIN ERP", subtitle: "Finance Suite", logoUrl: "" });
  const isDark = variant === "dark";

  useEffect(() => {
    let mounted = true;
    fetch("/api/branding")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (mounted && payload) setBranding(payload as Branding);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  if (branding.logoUrl) {
    return (
      <div className="flex items-center min-w-0 w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={branding.logoUrl}
          alt={branding.name}
          className={`${compact ? "h-11 max-h-11" : "h-14 max-h-14"} w-auto max-w-full object-contain rounded-md`}
        />
        {showText && (
          <div className="min-w-0 ml-3">
            <p className={`${compact ? "text-lg" : "text-xl"} font-bold tracking-wide truncate ${isDark ? "text-white" : "text-slate-900"}`}>{branding.name}</p>
            <p className={`${compact ? "text-[10px]" : "text-sm"} truncate ${isDark ? "text-white/60" : "text-slate-500"}`}>{branding.subtitle}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className={`${compact ? "h-10 w-10" : "h-12 w-12"} shrink-0 overflow-hidden rounded-lg ${isDark ? "bg-white/10" : "bg-slate-100"} grid place-items-center`}>
        <span className={`material-symbols-outlined ${isDark ? "text-white" : "text-blue-700"} ${compact ? "text-2xl" : "text-3xl"}`}>account_balance</span>
      </div>
      <div className="min-w-0">
        <p className={`${compact ? "text-lg" : "text-xl"} font-bold tracking-wide truncate ${isDark ? "text-white" : "text-slate-900"}`}>{branding.name}</p>
        <p className={`${compact ? "text-[10px]" : "text-sm"} truncate ${isDark ? "text-white/60" : "text-slate-500"}`}>{branding.subtitle}</p>
      </div>
    </div>
  );
}

