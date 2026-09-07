"use client";

import ExportExcelButton from "@/components/ExportExcelButton";
import { storeLabel } from "@/lib/branch-labels";
import { buildRevenueDaySummary, type RevenueDayInput, type RevenueDayRow } from "@/lib/revenue-day-summary";

/**
 * Bảng "Doanh thu theo ngày" đứng ngay trên màn Import doanh thu POS (yêu cầu chị Bình
 * 08/09/2026): mỗi ngày bán × cửa hàng một dòng, để import xong là thấy ngay ngày nào bán bao
 * nhiêu mà không phải qua Báo cáo hay tự cộng vài nghìn dòng chi tiết.
 *
 * Dùng ở hai chỗ: preview (số của file sắp commit) và chi tiết batch đã import (số thật trong
 * hệ thống). Cách tách tiền nằm ở lib/revenue-day-summary.ts, chung công thức với bút toán
 * doanh thu POS nên cột Tổng tiền khớp dòng Doanh thu trên P&L.
 */

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(value));

/** Ngày đã là chuỗi ngày nghiệp vụ nên đọc ở UTC, không để múi giờ trình duyệt kéo lùi một ngày. */
const dayLabel = (value: string) =>
  value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("vi-VN", { timeZone: "UTC" }) : "Không đọc được ngày";

/**
 * Cột tiền của bảng. Bốn cột `optional` chỉ hiện khi trong dữ liệu có số: file chỉ khai Tổng
 * tiền thì bảng gọn còn Doanh thu hàng bán và Tổng tiền, không bày một dãy cột toàn số 0.
 */
const AMOUNT_COLUMNS: Array<{ key: keyof RevenueDayRow; label: string; optional?: boolean }> = [
  { key: "salesRevenue", label: "Doanh thu hàng bán" },
  { key: "discount", label: "Giảm giá", optional: true },
  { key: "svc", label: "SVC", optional: true },
  { key: "vat", label: "Thuế GTGT", optional: true },
  { key: "adjust", label: "Chênh lệch", optional: true },
  { key: "net", label: "Tổng tiền" },
];

export default function RevenueDaySummary({
  rows,
  tableId,
  fileName,
  subtitle,
}: {
  rows: RevenueDayInput[];
  /** id của khối bảng — nút Xuất Excel trỏ vào đây vì nút nằm ngoài khối. */
  tableId: string;
  fileName: string;
  subtitle: string;
}) {
  const summary = buildRevenueDaySummary(rows);
  if (summary.rows.length === 0) return null;

  const columns = AMOUNT_COLUMNS.filter((column) => !column.optional || summary.totals[column.key] !== 0);
  const dayCount = new Set(summary.rows.map((row) => row.date)).size;

  return (
    <div className="border-b border-slate-100">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="font-bold">Doanh thu theo ngày</p>
          <p className="mt-1 text-xs text-slate-500">
            {subtitle} · {dayCount} ngày bán · {summary.rows.length} dòng. Cột Tổng tiền cộng lại đúng bằng doanh thu cùng kỳ trên báo cáo P&L.
          </p>
        </div>
        <ExportExcelButton
          fileName={fileName}
          sheetName="Doanh thu theo ngay"
          targetId={tableId}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
        />
      </div>
      <div id={tableId} className="max-h-[360px] overflow-auto border-t border-slate-100">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Ngày</th>
              <th className="px-4 py-3">Cửa hàng</th>
              <th className="px-4 py-3 text-right">Số dòng</th>
              {columns.map((column) => (
                <th key={column.key} className="whitespace-nowrap px-4 py-3 text-right">{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {summary.rows.map((row) => (
              <tr key={`${row.date}-${row.branchCode}`} className="hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2.5 font-bold">{dayLabel(row.date)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{row.branchCode === "—" ? "—" : storeLabel(row.branchCode)}</td>
                <td className="px-4 py-2.5 text-right text-slate-500">{row.rowCount}</td>
                {columns.map((column) => (
                  <td key={column.key} className="whitespace-nowrap px-4 py-2.5 text-right">
                    {column.key === "net"
                      ? <b>{money(row[column.key] as number)}</b>
                      : money(row[column.key] as number)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {/* Dòng Cộng dính đáy khối cuộn: nền tô cả ở tr vì tfoot dính không phải trình duyệt
              nào cũng vẽ nền, để lọt là chữ đè lên dòng dữ liệu bên dưới. */}
          <tfoot className="sticky bottom-0 font-bold">
            <tr className="border-t border-slate-200 bg-slate-50">
              <td className="px-4 py-3">Cộng</td>
              <td className="px-4 py-3">{dayCount} ngày</td>
              <td className="px-4 py-3 text-right">{summary.totals.rowCount}</td>
              {columns.map((column) => (
                <td key={column.key} className="whitespace-nowrap px-4 py-3 text-right">
                  {money(summary.totals[column.key] as number)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
