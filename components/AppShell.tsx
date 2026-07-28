"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/AppSidebar";

/** Cac route khong dung khung sidebar: man dang nhap va cac trang in chung tu. */
function isBareRoute(pathname: string) {
  return pathname === "/login" || pathname.endsWith("/print");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (isBareRoute(pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen w-full bg-[#f1f5f9]">
      <AppSidebar />
      <div className="flex-1 min-w-0 pl-64 flex flex-col min-h-screen overflow-x-hidden">{children}</div>
    </div>
  );
}
