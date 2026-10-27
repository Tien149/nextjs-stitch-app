"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/** Đường dẫn mở đúng màn + đúng phiếu của một mã chứng từ (xem app/api/doc-link). */
export function docHref(code: string) {
  return `/open/${encodeURIComponent(code.trim())}`;
}

/**
 * Mã chứng từ KHÁC bấm được (khách 27/10/2026): mở màn của phiếu đó, lọc + tô sáng đúng phiếu, cùng
 * tab. `codes` nhận cả chuỗi nhiều mã "PO-a, PO-b" (phiếu nhập gộp nhiều PO) — mỗi mã một link.
 */
export function DocLink({ code, children, className = "" }: { code: string | null | undefined; children?: ReactNode; className?: string }) {
  const codes = String(code || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (codes.length === 0) return null;
  if (children !== undefined && codes.length === 1) {
    return <Link href={docHref(codes[0])} onClick={(event) => event.stopPropagation()} className={`text-sky-700 hover:underline ${className}`}>{children}</Link>;
  }
  return (
    <>
      {codes.map((part, index) => (
        <span key={part}>
          {index > 0 && ", "}
          <Link href={docHref(part)} onClick={(event) => event.stopPropagation()} className={`text-sky-700 hover:underline ${className}`}>{part}</Link>
        </span>
      ))}
    </>
  );
}
