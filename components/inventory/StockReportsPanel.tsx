"use client";

import { useMemo, useState } from "react";
import CopyableText from "@/components/CopyableText";
import { money, quantity as qty, unitPrice } from "@/lib/format-number";
import { movementTypeLabel } from "@/lib/inventory-movement-labels";
import {
  IN_CATEGORIES, IN_TYPES, OUT_CATEGORIES, OUT_TYPES,
  aggregateNxtByStore, foldSearchText, isEmptyNxtRow, movementDirection, sortNxtRows, summarizeMovements, toNxtRow,
  type MovementInput, type MovementSummaryBy, type MovementSummaryRow, type NxtRow, type StockSummaryInput,
} from "@/lib/stock-report";

/**
 * Tab Tồn kho (khách yêu cầu 03/10/2026, note "Update 17/06/26"):
 * 1. Bộ lọc dùng chung (cửa hàng, kho, nhóm hàng hóa, kỳ, tìm mã).
 * 2. Nhập - Xuất - Tồn có SL + TRỊ GIÁ: "Theo cửa hàng" gộp mọi kho; "Theo từng kho" tách nhập /
 *    xuất theo loại giao dịch.
 * 3. Báo cáo phát sinh: chi tiết phát sinh, tổng hợp / chi tiết nhập, tổng hợp / chi tiết xuất.
 * Bảng chỉ vẽ tối đa RENDER_LIMIT dòng; Xuất Excel lấy đủ mọi dòng.
 */

type Warehouse = { code: string; name?: string | null; branch?: string | null };
type Range = { from: string; to: string };

type Props = {
  summary: StockSummaryInput[];
  movements: MovementInput[];
  warehouses: Warehouse[];
  branchOf: (warehouseCode: string) => string;
  storeOptions: Array<{ code: string }>;
  storeLabel: (code: string) => string;
  store: string; setStore: (value: string) => void;
  warehouse: string; setWarehouse: (value: string) => void;
  goodsGroup: string; setGoodsGroup: (value: string) => void;
  search: string; setSearch: (value: string) => void;
  range: Range; setRange: (value: Range) => void;
  reload: () => void;
};

const RENDER_LIMIT = 1000;
const NO_GROUP = "__NONE__";
const WASTE_SUBTYPE: Record<string, string> = { HET_HAN_SU_DUNG: "hết hạn", KHONG_DAM_BAO_CHAT_LUONG: "không đảm bảo chất lượng" };

type Format = "qty" | "money" | "price" | "text" | "int" | "percent";
type Column<R> = {
  /** Đường tiêu đề từ trên xuống, vd ["Nhập trong kỳ", "Nhập mua", "SL"]. */
  path: string[];
  format: Format;
  value: (row: R, index: number) => string | number;
  render?: (row: R, index: number) => React.ReactNode;
  /** Có ô cộng ở dòng tổng. */
  total?: boolean;
  /** Cột chữ dài (tên hàng, diễn giải): giữ bề ngang tối thiểu cho khỏi xuống dòng từng chữ. */
  wide?: boolean;
};

const formatValue = (format: Format, raw: string | number) => {
  if (typeof raw === "string") return raw;
  // Bụi số khi lùi trị giá (−0,3 đ) không được hiện thành "-0".
  const value = format === "money" && Math.abs(raw) < 0.5 ? 0 : raw;
  if (format === "qty") return qty(value);
  if (format === "money") return money(value);
  if (format === "price") return unitPrice(value);
  if (format === "percent") return `${(value * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
  return String(value);
};
const exportValue = (format: Format, value: string | number) => {
  if (typeof value === "string") return value;
  if (format === "money") return Math.round(value) || 0;
  if (format === "qty") return Math.round(value * 1000) / 1000;
  if (format === "price") return Math.round(value * 100) / 100;
  if (format === "percent") return Math.round(value * 1000) / 10;
  return value;
};
const isNumeric = (format: Format) => format !== "text";

/** Ô tiêu đề nhiều tầng: gộp ngang các cột cùng nhóm, gộp dọc cột không có tầng con. */
function headerCells<R>(columns: Column<R>[]) {
  const depth = Math.max(1, ...columns.map((column) => column.path.length));
  const levels: Array<Array<{ label: string; colSpan: number; rowSpan: number; numeric: boolean; start: number }>> = Array.from({ length: depth }, () => []);
  columns.forEach((column, index) => {
    column.path.forEach((label, level) => {
      const leaf = level === column.path.length - 1;
      const row = levels[level];
      const last = row[row.length - 1];
      const prev = columns[index - 1];
      const samePrefix = !!prev && !leaf && prev.path.length > level + 1 && prev.path.slice(0, level + 1).join("|") === column.path.slice(0, level + 1).join("|");
      if (samePrefix && last && last.start + last.colSpan === index) last.colSpan += 1;
      else row.push({ label, colSpan: 1, rowSpan: leaf ? depth - level : 1, numeric: leaf && isNumeric(column.format), start: index });
    });
  });
  return levels;
}

async function exportReport<R>(title: string, fileName: string, columns: Column<R>[], rows: R[], footer: boolean) {
  const XLSX = await import("xlsx");
  const levels = headerCells(columns);
  const width = columns.length;
  const aoa: Array<Array<string | number>> = [[title]];
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, width - 1) } }];
  levels.forEach((cells, level) => {
    const line: Array<string | number> = Array.from({ length: width }, () => "");
    for (const cell of cells) {
      line[cell.start] = cell.label;
      if (cell.colSpan > 1 || cell.rowSpan > 1) merges.push({ s: { r: level + 1, c: cell.start }, e: { r: level + cell.rowSpan, c: cell.start + cell.colSpan - 1 } });
    }
    aoa.push(line);
  });
  rows.forEach((row, index) => aoa.push(columns.map((column) => exportValue(column.format, column.value(row, index)))));
  if (footer) {
    aoa.push(columns.map((column, index) => index === 0 ? "Cộng" : column.total ? exportValue(column.format, rows.reduce((sum, row, rowIndex) => sum + Number(column.value(row, rowIndex) || 0), 0)) : ""));
  }
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!merges"] = merges;
  sheet["!cols"] = columns.map((column) => ({ wch: column.format === "text" ? Math.min(40, Math.max(10, ...rows.slice(0, 200).map((row, index) => String(column.value(row, index)).length + 2))) : 14 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31));
  XLSX.writeFile(workbook, `${fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function ReportTable<R>({ columns, rows, rowKey, footer = true, emptyText }: { columns: Column<R>[]; rows: R[]; rowKey: (row: R, index: number) => string; footer?: boolean; emptyText: string }) {
  const levels = headerCells(columns);
  const shown = rows.slice(0, RENDER_LIMIT);
  return (
    <>
      {rows.length > RENDER_LIMIT && (
        <p className="px-5 pb-3 text-xs text-amber-700">Có {qty(rows.length)} dòng, bảng đang hiện {qty(RENDER_LIMIT)} dòng đầu — bấm Xuất Excel để lấy đủ, hoặc thu hẹp bộ lọc.</p>
      )}
      <div className="overflow-x-auto max-h-[620px] overflow-y-auto custom-scrollbar">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-slate-50 text-[11px] text-slate-500 uppercase sticky top-0 z-10 shadow-sm">
            {levels.map((cells, level) => (
              <tr key={level}>
                {cells.map((cell) => (
                  <th
                    key={`${level}-${cell.start}`}
                    colSpan={cell.colSpan}
                    rowSpan={cell.rowSpan}
                    className={`px-3 py-2 font-bold whitespace-nowrap border border-slate-200 ${cell.colSpan > 1 ? "text-center" : cell.numeric ? "text-right" : "text-left"}`}
                  >
                    {cell.label}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={columns.length} className="cell text-center text-slate-400">{emptyText}</td></tr>}
            {shown.map((row, index) => (
              <tr key={rowKey(row, index)} className="border-t border-slate-100 hover:bg-slate-50/60">
                {columns.map((column, columnIndex) => (
                  <td key={columnIndex} className={`px-3 py-2 border-x border-slate-100 ${isNumeric(column.format) ? "text-right tabular-nums whitespace-nowrap" : column.wide ? "min-w-[220px]" : "whitespace-nowrap"}`}>
                    {column.render ? column.render(row, index) : formatValue(column.format, column.value(row, index))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && rows.length > 0 && (
            <tfoot className="sticky bottom-0 bg-slate-100 font-bold">
              <tr>
                {columns.map((column, index) => (
                  <td key={index} className={`px-3 py-2 border-t border-slate-300 ${isNumeric(column.format) ? "text-right tabular-nums whitespace-nowrap" : ""}`}>
                    {index === 0 ? "Cộng" : column.total ? formatValue(column.format, rows.reduce((sum, row, rowIndex) => sum + Number(column.value(row, rowIndex) || 0), 0)) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Xuất mọi dòng theo bộ lọc ra Excel" className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 shadow-sm">
      <span className="material-symbols-outlined text-[16px]">download</span>Xuất Excel
    </button>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={`px-3 py-1.5 text-xs font-bold rounded-md transition ${value === option.id ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

type NxtView = "store" | "warehouse";
type ReportKind = "all" | "in-summary" | "in-detail" | "out-summary" | "out-detail";
const REPORTS: Array<{ id: ReportKind; label: string }> = [
  { id: "in-summary", label: "Tổng hợp nhập" },
  { id: "in-detail", label: "Chi tiết nhập" },
  { id: "out-summary", label: "Tổng hợp xuất" },
  { id: "out-detail", label: "Chi tiết xuất" },
  { id: "all", label: "Chi tiết phát sinh (nhập + xuất)" },
];

export default function StockReportsPanel(props: Props) {
  const { summary, movements, warehouses, branchOf, storeOptions, storeLabel, store, setStore, warehouse, setWarehouse, goodsGroup, setGoodsGroup, search, setSearch, range, setRange, reload } = props;
  const [view, setView] = useState<NxtView>("store");
  const [hideEmpty, setHideEmpty] = useState(true);
  const [report, setReport] = useState<ReportKind>("in-summary");
  const [summaryBy, setSummaryBy] = useState<MovementSummaryBy>("item");
  const [reportType, setReportType] = useState("ALL");

  const storeKey = store.toUpperCase();
  const warehouseOptions = warehouses.filter((row) => store === "ALL" || (row.branch || "").toUpperCase() === storeKey);
  const warehouseName = (code: string) => warehouses.find((row) => row.code === code)?.name || "";
  const keyword = foldSearchText(search.trim());

  const groupOptions = useMemo(() => {
    const groups = new Set<string>();
    for (const row of summary) if (row.item.goodsGroup) groups.add(row.item.goodsGroup);
    for (const row of movements) if (row.goodsGroup) groups.add(row.goodsGroup);
    return [...groups].sort((a, b) => a.localeCompare(b, "vi"));
  }, [summary, movements]);

  const passes = (warehouseCode: string, code: string, name: string, group: string | null | undefined) => {
    if (store !== "ALL" && branchOf(warehouseCode) !== storeKey) return false;
    if (warehouse !== "ALL" && warehouseCode !== warehouse) return false;
    if (goodsGroup === NO_GROUP ? !!group : goodsGroup !== "ALL" && group !== goodsGroup) return false;
    return !keyword || foldSearchText(code).includes(keyword) || foldSearchText(name).includes(keyword);
  };

  // ---------- Nhập - Xuất - Tồn ----------
  const warehouseRows = summary
    .filter((row) => passes(row.warehouseCode, row.item.code, row.item.name, row.item.goodsGroup))
    .map((row) => toNxtRow(row, branchOf(row.warehouseCode)));
  const nxtRows = sortNxtRows((view === "store" ? aggregateNxtByStore(warehouseRows) : warehouseRows).filter((row) => !hideEmpty || !isEmptyNxtRow(row)));
  const showStoreColumn = view === "store" && store === "ALL";

  const pair = (group: string[], pick: (row: NxtRow) => { quantity: number; value: number }): Column<NxtRow>[] => [
    { path: [...group, "SL"], format: "qty", value: (row) => pick(row).quantity },
    { path: [...group, "Trị giá"], format: "money", value: (row) => pick(row).value, total: true },
  ];
  const itemColumns: Column<NxtRow>[] = [
    { path: ["STT"], format: "int", value: (_, index) => index + 1 },
    ...(showStoreColumn ? [{ path: ["Cửa hàng"], format: "text" as const, value: (row: NxtRow) => storeLabel(row.branchCode) || row.branchCode || "(Chưa gán)" }] : []),
    ...(view === "warehouse" ? [{ path: ["Kho"], format: "text" as const, value: (row: NxtRow) => row.warehouseCode }] : []),
    { path: ["Nhóm"], format: "text", value: (row) => row.item.goodsGroup || "" },
    { path: ["Mã hàng"], format: "text", value: (row) => row.item.code, render: (row) => <CopyableText value={row.item.code}><b>{row.item.code}</b></CopyableText> },
    { path: ["Tên hàng"], format: "text", value: (row) => row.item.name, wide: true },
    { path: ["ĐVT tồn kho"], format: "text", value: (row) => row.item.unit },
  ];
  const zeroPair = { quantity: 0, value: 0 };
  const nxtColumns: Column<NxtRow>[] = view === "store"
    ? [
        ...itemColumns,
        ...pair(["Đầu kỳ"], (row) => row.opening),
        ...pair(["Nhập trong kỳ"], (row) => row.inbound),
        ...pair(["Xuất trong kỳ"], (row) => row.outbound),
        ...pair(["Cuối kỳ"], (row) => row.closing),
      ]
    : [
        ...itemColumns,
        ...pair(["Đầu kỳ"], (row) => row.opening),
        ...IN_CATEGORIES.flatMap((category) => pair(["Nhập trong kỳ", category.label], (row) => row.byCategory[`IN:${category.key}`] || zeroPair)),
        ...pair(["Nhập trong kỳ", "Cộng nhập"], (row) => row.inbound),
        ...OUT_CATEGORIES.flatMap((category) => pair(["Xuất trong kỳ", category.label], (row) => row.byCategory[`OUT:${category.key}`] || zeroPair)),
        ...pair(["Xuất trong kỳ", "Cộng xuất"], (row) => row.outbound),
        ...pair(["Cuối kỳ"], (row) => row.closing),
      ];
  const periodText = `${range.from ? range.from.split("-").reverse().join("/") : "đầu"} → ${range.to ? range.to.split("-").reverse().join("/") : "nay"}`;
  const scopeText = `${store === "ALL" ? "Tất cả cửa hàng" : storeLabel(store)}${warehouse === "ALL" ? "" : ` — kho ${warehouse}`}`;

  // ---------- Báo cáo phát sinh ----------
  const direction = report.startsWith("in-") ? "IN" : report.startsWith("out-") ? "OUT" : null;
  const typeOptions = direction === "IN" ? IN_TYPES : direction === "OUT" ? OUT_TYPES : [...IN_TYPES, ...OUT_TYPES];
  const effectiveType = typeOptions.includes(reportType) ? reportType : "ALL";
  const reportRows = useMemo(() => movements.filter((row) => {
    const day = String(row.transactionDate).slice(0, 10);
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    const moved = movementDirection(row);
    if (direction && moved.direction !== direction) return false;
    if (effectiveType !== "ALL" && moved.type !== effectiveType) return false;
    return true;
  }), [movements, range.from, range.to, direction, effectiveType]).filter((row) => passes(row.warehouseCode, row.itemCode, row.itemName, row.goodsGroup));

  const typeText = (row: MovementInput) => {
    const { type } = movementDirection(row);
    const sub = type === "XUAT_HUY" && row.subType ? WASTE_SUBTYPE[row.subType] : "";
    return `${movementTypeLabel(type)}${sub ? ` · ${sub}` : ""}`;
  };
  const counterpart = (row: MovementInput) => {
    if (row.transactionType === "DIEU_CHUYEN") {
      const other = row.counterpartWarehouseCode || "";
      return other ? `${movementDirection(row).direction === "IN" ? "Từ" : "Đến"} kho ${other}` : "";
    }
    return row.partnerCode ? `${row.partnerCode}${row.partnerName ? ` - ${row.partnerName}` : ""}` : "";
  };
  const dateText = (value: string) => new Date(value).toLocaleDateString("vi-VN");

  const detailColumns: Column<MovementInput>[] = [
    { path: ["STT"], format: "int", value: (_, index) => index + 1 },
    { path: ["Ngày"], format: "text", value: (row) => dateText(row.transactionDate) },
    { path: ["Số phiếu"], format: "text", value: (row) => row.code, render: (row) => <CopyableText value={row.code}><b>{row.code}</b></CopyableText> },
    { path: ["Loại"], format: "text", value: typeText },
    { path: ["Kho"], format: "text", value: (row) => row.warehouseCode },
    { path: [direction === "IN" ? "NCC / kho xuất" : direction === "OUT" ? "Kho nhận / đối tượng" : "Đối tượng"], format: "text", value: counterpart },
    { path: ["Nhóm"], format: "text", value: (row) => row.goodsGroup || "" },
    { path: ["Mã hàng"], format: "text", value: (row) => row.itemCode },
    { path: ["Tên hàng"], format: "text", value: (row) => row.itemName, wide: true },
    { path: ["ĐVT"], format: "text", value: (row) => row.unit },
    ...(direction === null
      ? [
          { path: ["SL nhập"], format: "qty" as const, value: (row: MovementInput) => row.inboundQuantity },
          { path: ["SL xuất"], format: "qty" as const, value: (row: MovementInput) => row.outboundQuantity },
        ]
      : [{ path: ["Số lượng"], format: "qty" as const, value: (row: MovementInput) => row.inboundQuantity || row.outboundQuantity }]),
    { path: ["Đơn giá"], format: "price", value: (row) => row.unitCost ?? ((row.inboundQuantity || row.outboundQuantity) ? row.value / (row.inboundQuantity || row.outboundQuantity) : 0) },
    { path: ["Thành tiền"], format: "money", value: (row) => row.value, total: true },
    { path: ["Tham chiếu / diễn giải"], format: "text", value: (row) => [row.referenceCode, row.note].filter(Boolean).join(" · "), wide: true },
  ];

  const summaryByOptions: Array<{ id: MovementSummaryBy; label: string }> = [
    { id: "item", label: "Theo mặt hàng" },
    { id: "type", label: direction === "IN" ? "Theo loại nhập" : "Theo loại xuất" },
    { id: "warehouse", label: "Theo kho" },
    ...(direction === "IN" ? [{ id: "partner" as const, label: "Theo nhà cung cấp" }] : []),
  ];
  const by = summaryByOptions.some((option) => option.id === summaryBy) ? summaryBy : "item";
  const summaryRows = summarizeMovements(reportRows, by, { type: movementTypeLabel, warehouse: warehouseName });
  const summaryTotal = summaryRows.reduce((sum, row) => sum + row.value, 0);
  const summaryColumns: Column<MovementSummaryRow>[] = by === "item"
    ? [
        { path: ["STT"], format: "int", value: (_, index) => index + 1 },
        { path: ["Nhóm"], format: "text", value: (row) => row.goodsGroup },
        { path: ["Mã hàng"], format: "text", value: (row) => row.label, render: (row) => <CopyableText value={row.label}><b>{row.label}</b></CopyableText> },
        { path: ["Tên hàng"], format: "text", value: (row) => row.detail, wide: true },
        { path: ["ĐVT"], format: "text", value: (row) => row.unit },
        { path: [direction === "IN" ? "SL nhập" : "SL xuất"], format: "qty", value: (row) => row.quantity },
        { path: ["Đơn giá bình quân"], format: "price", value: (row) => (row.quantity ? row.value / row.quantity : 0) },
        { path: [direction === "IN" ? "Trị giá nhập" : "Trị giá xuất"], format: "money", value: (row) => row.value, total: true },
        { path: ["Số phiếu"], format: "int", value: (row) => row.documentCount },
      ]
    : [
        { path: ["STT"], format: "int", value: (_, index) => index + 1 },
        { path: [by === "type" ? "Loại" : by === "warehouse" ? "Kho" : "Mã NCC"], format: "text", value: (row) => row.label },
        ...(by === "type" ? [] : [{ path: [by === "warehouse" ? "Tên kho" : "Tên NCC"], format: "text" as const, value: (row: MovementSummaryRow) => row.detail, wide: true }]),
        { path: ["Số phiếu"], format: "int", value: (row) => row.documentCount, total: true },
        { path: ["Số dòng hàng"], format: "int", value: (row) => row.lineCount, total: true },
        { path: [direction === "IN" ? "Trị giá nhập" : "Trị giá xuất"], format: "money", value: (row) => row.value, total: true },
        { path: ["Tỷ trọng"], format: "percent", value: (row) => (summaryTotal ? row.value / summaryTotal : 0) },
      ];
  const reportLabel = REPORTS.find((option) => option.id === report)?.label || "";
  const isSummary = report.endsWith("-summary");

  const exportNxt = () => void exportReport(
    `NHẬP - XUẤT - TỒN ${view === "store" ? "THEO CỬA HÀNG" : "THEO TỪNG KHO"} — ${scopeText} — kỳ ${periodText}`,
    view === "store" ? "nhap_xuat_ton_theo_cua_hang" : "nhap_xuat_ton_theo_kho",
    nxtColumns, nxtRows, true,
  );
  const exportMovementReport = () => {
    const title = `${reportLabel.toUpperCase()}${isSummary ? ` (${summaryByOptions.find((option) => option.id === by)?.label.toLowerCase()})` : ""} — ${scopeText} — kỳ ${periodText}${effectiveType !== "ALL" ? ` — ${movementTypeLabel(effectiveType)}` : ""}`;
    const file = { all: "chi_tiet_phat_sinh_kho", "in-summary": "tong_hop_nhap_kho", "in-detail": "chi_tiet_nhap_kho", "out-summary": "tong_hop_xuat_kho", "out-detail": "chi_tiet_xuat_kho" }[report];
    if (isSummary) void exportReport(title, file, summaryColumns, summaryRows, true);
    else void exportReport(title, file, detailColumns, reportRows, true);
  };

  return (
    <>
      <section className="table-panel shadow-sm mb-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="font-bold text-slate-800">Bộ lọc báo cáo kho</h2>
            <p className="text-xs text-slate-500 mt-0.5">Áp cho bảng Nhập - Xuất - Tồn, các báo cáo nhập / xuất và bảng tồn hiện tại bên dưới.</p>
          </div>
          <button type="button" title="Tải lại" onClick={reload} className="icon-button"><span className="material-symbols-outlined text-lg">refresh</span></button>
        </div>
        <div className="grid sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <label className="text-xs font-bold text-slate-500">Cửa hàng
            <select
              className="control mt-1"
              value={store}
              onChange={(e) => {
                const next = e.target.value;
                setStore(next);
                const picked = warehouses.find((row) => row.code === warehouse);
                if (next !== "ALL" && picked && (picked.branch || "").toUpperCase() !== next.toUpperCase()) setWarehouse("ALL");
              }}
            >
              <option value="ALL">Tất cả cửa hàng</option>
              {storeOptions.map((option) => <option key={option.code} value={option.code}>{storeLabel(option.code)}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Kho
            <select className="control mt-1" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
              <option value="ALL">Tất cả kho</option>
              {warehouseOptions.map((row) => <option key={row.code} value={row.code}>{row.name || row.code}</option>)}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Nhóm hàng hóa
            <select className="control mt-1" value={goodsGroup} onChange={(e) => setGoodsGroup(e.target.value)}>
              <option value="ALL">Tất cả nhóm</option>
              {groupOptions.map((group) => <option key={group} value={group}>{group}</option>)}
              <option value={NO_GROUP}>(Chưa gán nhóm)</option>
            </select>
          </label>
          <label className="text-xs font-bold text-slate-500">Từ ngày
            <input type="date" className="control mt-1" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </label>
          <label className="text-xs font-bold text-slate-500">Đến ngày
            <input type="date" className="control mt-1" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </label>
          <label className="text-xs font-bold text-slate-500">Tìm mã / tên hàng
            <input className="control mt-1" placeholder="Gõ mã hoặc tên..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>
      </section>

      <section className="table-panel shadow-sm mb-5">
        <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800">Nhập - Xuất - Tồn</h2>
            <p className="text-xs text-slate-500 mt-1">
              {scopeText} · kỳ {periodText} · {qty(nxtRows.length)} dòng. Trị giá đầu / cuối kỳ tính lùi từ giá trị tồn hiện tại theo trị giá các phiếu phát sinh: Đầu kỳ + Nhập − Xuất = Cuối kỳ.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={view} onChange={setView} options={[{ id: "store", label: "Theo cửa hàng" }, { id: "warehouse", label: "Theo từng kho" }]} />
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer select-none">
              <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />Ẩn mã không tồn, không phát sinh
            </label>
            <ExportButton onClick={exportNxt} />
          </div>
        </div>
        <ReportTable columns={nxtColumns} rows={nxtRows} rowKey={(row) => row.key} emptyText="Không có mặt hàng khớp bộ lọc." />
      </section>

      <section className="table-panel shadow-sm mb-5">
        <div className="p-5 pb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800">Báo cáo nhập / xuất kho</h2>
            <p className="text-xs text-slate-500 mt-1">{scopeText} · kỳ {periodText}</p>
          </div>
          <ExportButton onClick={exportMovementReport} />
        </div>
        <div className="px-5 pb-3 flex flex-wrap items-end gap-3">
          <Segmented value={report} onChange={setReport} options={REPORTS} />
          {isSummary && <Segmented value={by} onChange={setSummaryBy} options={summaryByOptions} />}
          <label className="text-xs font-bold text-slate-500">Loại giao dịch
            <select className="control mt-1 min-w-[200px]" value={effectiveType} onChange={(e) => setReportType(e.target.value)}>
              <option value="ALL">{direction === "IN" ? "Mọi loại nhập" : direction === "OUT" ? "Mọi loại xuất" : "Mọi loại"}</option>
              {typeOptions.map((type) => <option key={type} value={type}>{movementTypeLabel(type)}</option>)}
            </select>
          </label>
        </div>
        {isSummary
          ? <ReportTable columns={summaryColumns} rows={summaryRows} rowKey={(row) => row.key || "_"} emptyText="Không có phát sinh khớp bộ lọc." />
          : <ReportTable columns={detailColumns} rows={reportRows} rowKey={(row, index) => `${row.transactionId}-${row.itemCode}-${row.warehouseCode}-${index}`} emptyText="Không có phát sinh khớp bộ lọc." />}
      </section>
    </>
  );
}
