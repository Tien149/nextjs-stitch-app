"use client";

import React from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { toFileSlug } from "@/lib/export-table-excel";

/**
 * Bản sao gọn của các primitive trong app/reports/page.tsx cho các tab báo cáo tách file
 * (ngân sách nhân sự, P&L 12 tháng, xu hướng doanh thu). Giữ đúng class để hai bên nhìn
 * đồng nhất; page.tsx không export các hàm này nên tách ra đây thay vì import chéo.
 */

export const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

/**
 * Cỡ chữ cho số lớn trên thẻ KPI, tự co theo độ dài.
 *
 * Số tiền của chuỗi lên tới hàng tỷ ("3.928.699.540 đ" = 15 ký tự). Để cỡ cố định thì thẻ hẹp
 * sẽ cắt đuôi hoặc tràn khung — đúng phần cần đọc lại bị giấu. Số dài thì chữ nhỏ đi một nấc,
 * không bao giờ cắt.
 */
export function statValueTextClass(value: string) {
  const length = value.length;
  if (length <= 13) return "text-2xl";
  if (length <= 16) return "text-xl";
  if (length <= 19) return "text-lg";
  if (length <= 23) return "text-base";
  return "text-sm";
}

export function PanelHeader({ title, subtitle, exportFileName, exportable = true }: { title: string; subtitle: string; exportFileName?: string; exportable?: boolean }) {
  return (
    <div className="p-4 border-b border-slate-200 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="font-bold">{title}</h2>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      {exportable && <ExportExcelButton fileName={exportFileName || toFileSlug(title)} sheetName={title.slice(0, 31)} />}
    </div>
  );
}

export function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  // Bọc khung cuộn ngang ngay tại đây: số ghi đủ chữ số nên bảng nhiều cột dễ vượt bề ngang,
  // để bảng tự cuộn còn hơn bóp cột lại rồi cắt số.
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500">
            {headers.map((header) => (
              <th key={header} className="px-4 py-3 font-semibold whitespace-nowrap">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// Cột số canh phải: thêm tabular-nums để các chữ số thẳng hàng khi số dài ngắn khác nhau.
export function Cell({ children, right, center }: { children: React.ReactNode; right?: boolean; center?: boolean }) {
  return <td className={`px-4 py-3 whitespace-nowrap ${right ? "text-right tabular-nums" : center ? "text-center" : ""}`}>{children}</td>;
}

export function Kpi({ label, value, icon, tone = "default" }: { label: string; value: number; icon: string; tone?: "default" | "green" | "blue" | "rose" | "amber" }) {
  const toneClasses = {
    default: "text-slate-800",
    green: "text-emerald-600",
    blue: "text-blue-600",
    rose: "text-rose-600",
    amber: "text-amber-600",
  }[tone];

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center justify-between text-slate-400">
        <span className="text-xs font-semibold text-slate-500">{label}</span>
        <span className="material-symbols-outlined text-xl">{icon}</span>
      </div>
      <p className={`font-bold mt-2 leading-tight tabular-nums whitespace-nowrap ${statValueTextClass(`${money(value)} đ`)} ${toneClasses}`}>{money(value)} đ</p>
    </div>
  );
}
