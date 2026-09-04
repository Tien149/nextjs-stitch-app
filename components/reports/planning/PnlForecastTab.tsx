"use client";

import React, { useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { opexGroupRank } from "@/lib/pnl-ordering";
import { money } from "@/components/reports/report-ui";
import { Card, NoPlanNotice, PlanActualCell, Tag, pctText, ratioOf, type Tone } from "@/components/reports/planning/planning-ui";
import { type PlanningData, type PlannedGroup, type PlannedItem, type StatementLine } from "@/components/reports/planning/planning-types";

/**
 * Màn "Dự báo P&L" — bảng hoạch định 12 tháng học theo phần mềm mẫu: mỗi khối (Doanh thu,
 * Giá vốn, OPEX...) là một dải màu, dưới là hạng mục, cuối khối là dòng TỔNG; mỗi ô tháng
 * ghi số KẾ HOẠCH đậm và chip THỰC ĐẠT xanh/đỏ kèm % hoàn thành. Ba dòng lợi nhuận là dải
 * đậm hơn, kèm dòng tỷ suất so với doanh thu.
 */

type LineStyle = { tone: Tone; icon: string; title: string; band: string; total: string };
const LINE_STYLE: Record<string, LineStyle> = {
  revenue: { tone: "emerald", icon: "trending_up", title: "DOANH THU", band: "bg-emerald-50 text-emerald-700", total: "bg-emerald-100 text-emerald-900" },
  cogs: { tone: "amber", icon: "inventory_2", title: "GIÁ VỐN HÀNG BÁN (COGS)", band: "bg-amber-50 text-amber-700", total: "bg-amber-100 text-amber-900" },
  grossProfit: { tone: "emerald", icon: "functions", title: "LỢI NHUẬN GỘP", band: "", total: "bg-emerald-200/70 text-emerald-900" },
  payroll: { tone: "sky", icon: "groups", title: "CHI PHÍ NHÂN SỰ", band: "bg-sky-50 text-sky-700", total: "bg-sky-100 text-sky-900" },
  otherOpex: { tone: "blue", icon: "receipt_long", title: "CHI PHÍ HOẠT ĐỘNG (OPEX)", band: "bg-blue-50 text-blue-700", total: "bg-blue-100 text-blue-900" },
  depreciation: { tone: "slate", icon: "trending_down", title: "KHẤU HAO TÀI SẢN/CCDC", band: "bg-slate-50 text-slate-600", total: "bg-slate-200/70 text-slate-800" },
  ebitda: { tone: "violet", icon: "functions", title: "EBITDA (LN HOẠT ĐỘNG TRƯỚC KHẤU HAO)", band: "", total: "bg-violet-200/60 text-violet-900" },
  otherIncome: { tone: "teal", icon: "savings", title: "THU NHẬP KHÁC", band: "bg-teal-50 text-teal-700", total: "bg-teal-100 text-teal-900" },
  otherExpense: { tone: "rose", icon: "money_off", title: "CHI PHÍ KHÁC", band: "bg-rose-50 text-rose-700", total: "bg-rose-100 text-rose-900" },
  netProfit: { tone: "indigo", icon: "workspace_premium", title: "LỢI NHUẬN RÒNG", band: "", total: "bg-indigo-200/60 text-indigo-900" },
};
const INCOME_LINES = new Set(["revenue", "otherIncome", "grossProfit", "ebitda", "netProfit"]);
const RATIO_AFTER: Record<string, string> = { grossProfit: "Tỷ suất LN gộp", ebitda: "Tỷ suất EBITDA", netProfit: "Tỷ suất LN ròng" };

const isEmptyNode = (node: { months: number[]; plan: number[] | null }) =>
  node.months.every((value) => Math.abs(value) <= 0.5) && (!node.plan || node.plan.every((value) => Math.abs(value) <= 0.5));

/** Chip CĐ/MKT/BĐ cho nhóm OPEX — đọc từ tên nhóm giống thứ tự sắp xếp trên bảng. */
function natureTag(lineKey: string, name: string) {
  if (lineKey !== "otherOpex") return null;
  const rank = opexGroupRank(name);
  if (rank === 0) return <Tag tone="slate">CĐ</Tag>;
  if (rank === 1) return <Tag tone="violet">MKT</Tag>;
  if (rank === 2) return <Tag tone="amber">BĐ</Tag>;
  return null;
}

export default function PnlForecastTab({ data, onRefresh, onOpenBudget }: { data: PlanningData; onRefresh: () => void; onOpenBudget?: () => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hideEmpty, setHideEmpty] = useState(true);
  const monthHeaders = data.months.map((month) => `T${Number(month.slice(5))}`);
  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  const setAll = (next: boolean) => {
    const map: Record<string, boolean> = {};
    if (next) for (const line of data.statement) { map[line.key] = true; for (const group of line.groups) map[`${line.key}:${group.code}`] = true; }
    setCollapsed(map);
  };

  const exportExcel = async () => {
    // xlsx chỉ nạp khi bấm xuất — tránh cộng vào bundle của trang báo cáo.
    const XLSX = await import("xlsx");
    const header = ["Chỉ tiêu", ...monthHeaders.flatMap((label) => [`${label} KH`, `${label} TT`]), "Cả năm KH", "Cả năm TT", "% hoàn thành"];
    const rows: Array<Array<string | number>> = [header];
    const push = (prefix: string, label: string, node: { months: number[]; total: number; plan: number[] | null; planTotal: number | null }) => {
      const rate = node.planTotal ? node.total / node.planTotal : null;
      rows.push([
        `${prefix}${label}`,
        ...node.months.flatMap((value, index) => [Math.round(node.plan?.[index] || 0), Math.round(value)]),
        Math.round(node.planTotal || 0),
        Math.round(node.total),
        rate === null ? "" : Number((rate * 100).toFixed(1)),
      ]);
    };
    for (const line of data.statement) {
      push("", line.label, line);
      for (const group of line.groups) {
        if (hideEmpty && isEmptyNode(group)) continue;
        push("    ", group.name, group);
        for (const item of group.items) {
          if (hideEmpty && isEmptyNode(item)) continue;
          push("        ", item.name, item);
        }
      }
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, `Hoach dinh P&L ${data.year}`);
    XLSX.writeFile(workbook, `hoach_dinh_pnl_${data.year}_${data.branchCode}.xlsx`);
  };

  const cells = (node: { months: number[]; total: number; plan: number[] | null; planTotal: number | null }, income: boolean, cls = "") => (
    <>
      {node.months.map((value, index) => (
        <td key={index} className={`px-3 py-2 align-top ${cls}`}>
          <PlanActualCell plan={node.plan ? node.plan[index] : null} actual={value} income={income} />
        </td>
      ))}
      <td className={`px-3 py-2 align-top border-l border-slate-200 ${cls}`}>
        <PlanActualCell plan={node.planTotal} actual={node.total} income={income} />
      </td>
    </>
  );

  const stickyCell = (bg: string, children: React.ReactNode, extra = "") => (
    <td className={`px-4 py-2 sticky left-0 z-10 ${bg} ${extra}`}>{children}</td>
  );

  const renderItem = (line: StatementLine, group: PlannedGroup, item: PlannedItem) => {
    const bg = item.code === "UNCLASSIFIED" ? "bg-amber-50" : "bg-white";
    return (
      <tr key={`${line.key}:${group.code}:${item.code}`} className={`border-t border-slate-100 ${bg} hover:bg-slate-50`}>
        {stickyCell(bg, (
          <div className="pl-12">
            <p className="text-[13px] font-semibold text-slate-700 whitespace-nowrap">{item.name}</p>
            <p className="mt-0.5 flex items-center gap-1">
              {item.code !== "UNCLASSIFIED" && <span className="text-[10px] text-slate-400">{item.code}</span>}
              {item.plan === null && <span className="text-[10px] text-slate-400">KH set ở cấp dòng</span>}
            </p>
          </div>
        ))}
        {cells(item, INCOME_LINES.has(line.key))}
      </tr>
    );
  };

  const renderGroup = (line: StatementLine, group: PlannedGroup) => {
    const key = `${line.key}:${group.code}`;
    const items = hideEmpty ? group.items.filter((item) => !isEmptyNode(item)) : group.items;
    const bg = group.code === "UNGROUPED" ? "bg-amber-50" : "bg-slate-50/60";
    return (
      <React.Fragment key={key}>
        <tr className={`border-t border-slate-100 ${bg} ${items.length > 0 ? "cursor-pointer hover:bg-slate-100" : ""}`} onClick={items.length > 0 ? () => toggle(key) : undefined}>
          {stickyCell(bg, (
            <div className="pl-5 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base text-slate-400">{items.length === 0 ? "remove" : collapsed[key] ? "chevron_right" : "expand_more"}</span>
              <div>
                <p className="text-[13px] font-bold text-slate-700 whitespace-nowrap">{group.name}</p>
                <p className="mt-0.5 flex items-center gap-1">
                  {natureTag(line.key, group.name)}
                  <span className="text-[10px] text-slate-400">{group.items.length} hạng mục</span>
                </p>
              </div>
            </div>
          ))}
          {cells(group, INCOME_LINES.has(line.key))}
        </tr>
        {!collapsed[key] && items.map((item) => renderItem(line, group, item))}
      </React.Fragment>
    );
  };

  const renderRatioRow = (line: StatementLine) => {
    const revenue = data.statement.find((row) => row.key === "revenue");
    if (!revenue) return null;
    const cell = (plan: number | null, actual: number | null) => (
      <div className="flex flex-col items-end gap-0.5 text-[11px] whitespace-nowrap">
        <span className="text-slate-500">KH: <b className="text-slate-700">{pctText(plan)}</b></span>
        <span className="text-slate-500">TT: <b className={actual !== null && plan !== null ? (actual >= plan ? "text-emerald-600" : "text-rose-600") : "text-slate-700"}>{pctText(actual)}</b></span>
      </div>
    );
    return (
      <tr className="border-t border-slate-100 bg-white">
        {stickyCell("bg-white", <p className="pl-5 text-[12px] font-semibold text-slate-500 flex items-center gap-1"><span className="material-symbols-outlined text-sm">percent</span>{RATIO_AFTER[line.key]}</p>)}
        {line.months.map((value, index) => (
          <td key={index} className="px-3 py-1.5 align-top">{cell(ratioOf(line.plan[index], revenue.plan[index]), ratioOf(value, revenue.months[index]))}</td>
        ))}
        <td className="px-3 py-1.5 align-top border-l border-slate-200">{cell(ratioOf(line.planTotal, revenue.planTotal), ratioOf(line.total, revenue.total))}</td>
      </tr>
    );
  };

  const renderLine = (line: StatementLine) => {
    const style = LINE_STYLE[line.key] || LINE_STYLE.otherExpense;
    const income = INCOME_LINES.has(line.key);
    if (line.subtotal) {
      return (
        <React.Fragment key={line.key}>
          <tr className={`border-t border-slate-200 ${style.total}`}>
            {stickyCell(style.total, <p className="text-[12px] font-extrabold tracking-wide flex items-center gap-1.5 whitespace-nowrap"><span className="material-symbols-outlined text-base">{style.icon}</span>{style.title}</p>)}
            {cells(line, income)}
          </tr>
          {RATIO_AFTER[line.key] && renderRatioRow(line)}
        </React.Fragment>
      );
    }
    const groups = hideEmpty ? line.groups.filter((group) => !isEmptyNode(group)) : line.groups;
    const itemCount = line.groups.reduce((sum, group) => sum + group.items.length, 0);
    return (
      <React.Fragment key={line.key}>
        <tr className={`border-t border-slate-200 ${style.band} ${groups.length > 0 ? "cursor-pointer" : ""}`} onClick={groups.length > 0 ? () => toggle(line.key) : undefined}>
          {stickyCell(style.band, (
            <p className="text-[12px] font-extrabold tracking-wide flex items-center gap-1.5 whitespace-nowrap">
              <span className="material-symbols-outlined text-base">{groups.length === 0 ? style.icon : collapsed[line.key] ? "chevron_right" : "expand_more"}</span>
              {style.title}
              <span className="ml-1 rounded-md bg-white/70 px-1.5 py-0.5 text-[10px] font-bold">{itemCount > 0 ? `${line.groups.length} nhóm · ${itemCount} hạng mục` : `${line.groups.length} nguồn`}</span>
            </p>
          ))}
          <td colSpan={13} className="px-3 py-2 text-[11px] font-semibold opacity-80 whitespace-nowrap">Kế hoạch (đậm) · Thực đạt (chip) · % hoàn thành</td>
        </tr>
        {!collapsed[line.key] && groups.map((group) => renderGroup(line, group))}
        <tr className={`border-t border-slate-200 ${style.total}`}>
          {stickyCell(style.total, <p className="text-[12px] font-extrabold tracking-wide whitespace-nowrap">TỔNG {style.title}</p>)}
          {cells(line, income)}
        </tr>
      </React.Fragment>
    );
  };

  return (
    <div className="space-y-4">
      {!data.hasPlan && <NoPlanNotice year={data.year} />}
      <Card bodyClassName="" className="">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2.5 w-2.5 rounded-full bg-indigo-500 shrink-0" />
            <p className="font-bold text-slate-800 truncate">Hoạch định P&L năm {data.year} — {storeLabel(data.branchCode)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white">
              <input type="checkbox" checked={hideEmpty} onChange={(event) => setHideEmpty(event.target.checked)} />Ẩn dòng bằng 0
            </label>
            <button type="button" onClick={() => setAll(false)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50">Mở tất cả</button>
            <button type="button" onClick={() => setAll(true)} className="text-xs font-bold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50">Thu gọn</button>
            <button type="button" onClick={onRefresh} className="flex items-center gap-1 text-xs font-bold text-slate-600 border border-slate-200 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50">
              <span className="material-symbols-outlined text-base">refresh</span>Làm mới
            </button>
            {onOpenBudget && (
              <button type="button" onClick={onOpenBudget} className="flex items-center gap-1 text-xs font-bold text-indigo-700 border border-indigo-200 rounded-lg px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100">
                <span className="material-symbols-outlined text-base">edit_calendar</span>Set kế hoạch
              </button>
            )}
            <button type="button" onClick={() => void exportExcel()} className="flex items-center gap-1 text-xs font-bold text-emerald-700 border border-emerald-200 rounded-lg px-3 py-1.5 bg-emerald-50 hover:bg-emerald-100">
              <span className="material-symbols-outlined text-base">download</span>Xuất Excel
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[760px] overflow-y-auto">
          <table className="w-full text-left text-sm border-separate border-spacing-0">
            <thead className="sticky top-0 z-20 bg-white">
              <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-bold sticky left-0 bg-white z-30 min-w-[300px] border-b border-slate-200">Danh mục</th>
                {monthHeaders.map((header, index) => (
                  <th key={header} className="px-3 py-3 font-bold text-right min-w-[128px] border-b border-slate-200 whitespace-nowrap">Tháng {index + 1}</th>
                ))}
                <th className="px-3 py-3 font-bold text-right min-w-[140px] border-b border-l border-slate-200 whitespace-nowrap">Cả năm</th>
              </tr>
            </thead>
            <tbody>{data.statement.map(renderLine)}</tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-200 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><b className="text-slate-800">1.000.000 đ</b> kế hoạch</span>
          <span className="flex items-center gap-1"><span className="rounded bg-emerald-50 text-emerald-700 px-1.5 py-0.5 font-semibold">900.000 đ</span> thực đạt tốt hơn kế hoạch</span>
          <span className="flex items-center gap-1"><span className="rounded bg-rose-50 text-rose-700 px-1.5 py-0.5 font-semibold">1.200.000 đ</span> thực đạt xấu hơn kế hoạch</span>
          <span className="flex items-center gap-1"><Tag tone="slate">CĐ</Tag> cố định · <Tag tone="violet">MKT</Tag> marketing · <Tag tone="amber">BĐ</Tag> biến đổi</span>
          <span className="ml-auto">{money(Math.round(data.statement.find((line) => line.key === "netProfit")?.total || 0))} đ lợi nhuận ròng thực tế cả năm</span>
        </div>
      </Card>
    </div>
  );
}
