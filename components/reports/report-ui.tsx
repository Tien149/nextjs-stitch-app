"use client";

import React from "react";

/**
 * Bản sao gọn của các primitive trong app/reports/page.tsx cho các tab báo cáo tách file
 * (ngân sách nhân sự, P&L 12 tháng, xu hướng doanh thu). Giữ đúng class để hai bên nhìn
 * đồng nhất; page.tsx không export các hàm này nên tách ra đây thay vì import chéo.
 */

export const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

export function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="p-4 border-b border-slate-200">
      <h2 className="font-bold">{title}</h2>
      <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
    </div>
  );
}

export function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
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
  );
}

export function Cell({ children, right, center }: { children: React.ReactNode; right?: boolean; center?: boolean }) {
  return <td className={`px-4 py-3 whitespace-nowrap ${right ? "text-right" : center ? "text-center" : ""}`}>{children}</td>;
}
