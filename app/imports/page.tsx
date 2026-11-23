"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { importTabHomeHref } from "@/lib/import-tabs";

/**
 * Màn Import dữ liệu đã bỏ (khách 23/11/2026, đợt 2): mỗi loại import là nút "Import Excel" trên
 * màn nghiệp vụ của nó (components/ImportLauncher). Link / bookmark cũ "/imports?tab=..." được
 * chuyển thẳng tới màn đó và tự mở khung import. "Import dữ liệu" vẫn còn trong Phân quyền như
 * một QUYỀN (ai không được tick thì không thấy nút).
 */
export default function ImportsPage() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab") || "";
    router.replace(importTabHomeHref(tab) || "/");
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center bg-slate-100">
      <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
    </div>
  );
}
