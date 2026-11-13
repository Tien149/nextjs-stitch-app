"use client";

import { useState } from "react";
import { Cell, PanelHeader, Table, money } from "@/components/reports/report-ui";
import { storeLabel } from "@/lib/branch-labels";
import type { CashSourceCheck, CashSourceCheckRow, SuspectBankLine } from "@/lib/cash-source-check";

/**
 * Bảng ĐỐI CHIẾU SỔ QUỸ – NGUỒN TIỀN (khách 13/11/2026): từng quỹ tiền mặt / tài khoản ngân hàng,
 * số dư đầu kỳ và cuối kỳ theo hai màn, cột lệch, và cờ âm cuối kỳ. Nguồn lệch thì liệt kê luôn
 * dòng sao kê nghi nạp trùng và dòng sao kê chưa có chứng từ — hai nguyên nhân hay gặp nhất.
 * Dùng ở tab Nguồn tiền (Báo cáo) và tab Khóa sổ (Sổ quỹ & Cuối kỳ).
 */
export function CashSourceCheckPanel({ check, showBranch }: { check: CashSourceCheck; showBranch: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const problemRows = check.rows.filter((row) => !row.matched || row.negativeCashbook || row.negativeReport);
  const mismatched = check.rows.filter((row) => !row.matched).length;
  const negative = check.rows.filter((row) => row.negativeCashbook || row.negativeReport).length;
  const rows = showAll ? check.rows : problemRows;

  const dash = <span className="text-slate-300">—</span>;
  const amount = (value: number) => <span className={Math.round(value) < 0 ? "font-bold text-rose-600" : ""}>{money(value)} đ</span>;
  const diff = (value: number) => (Math.abs(value) <= 1 ? dash : <b className="text-rose-600">{value > 0 ? "+" : ""}{money(value)} đ</b>);
  const status = (row: CashSourceCheckRow) => {
    const tags: Array<{ text: string; tone: string }> = [];
    if (!row.matched) tags.push({ text: "Lệch", tone: "bg-rose-50 text-rose-700 border-rose-200" });
    if (row.negativeCashbook || row.negativeReport) tags.push({ text: "Âm", tone: "bg-amber-50 text-amber-800 border-amber-200" });
    if (tags.length === 0) tags.push({ text: "Khớp", tone: "bg-emerald-50 text-emerald-700 border-emerald-200" });
    return (
      <span className="inline-flex gap-1">
        {tags.map((tag) => <span key={tag.text} className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${tag.tone}`}>{tag.text}</span>)}
      </span>
    );
  };

  const headers = [
    ...(showBranch ? ["Nhà hàng"] : []),
    "Nguồn tiền", "Sổ quỹ đầu kỳ", "Nguồn tiền đầu kỳ", "Lệch đầu kỳ", "Sổ quỹ cuối kỳ", "Nguồn tiền cuối kỳ", "Lệch cuối kỳ", "Tình trạng",
  ];

  return (
    <section className="table-panel">
      <PanelHeader
        title="Đối chiếu Sổ quỹ – Nguồn tiền"
        subtitle="So số dư từng quỹ tiền mặt / tài khoản ngân hàng giữa màn Sổ quỹ (đọc chứng từ) và báo cáo Nguồn tiền (tài khoản ngân hàng đọc sổ sao kê). Lệch = Nguồn tiền − Sổ quỹ. Lệch đầu kỳ là do các tháng trước; lệch phát sinh trong kỳ thì soát chứng từ tháng này. Nguyên nhân hay gặp: dòng sao kê nạp trùng, dòng sao kê chưa có chứng từ, chứng từ gắn nhầm nguồn tiền hoặc nhầm ngày. Âm = số dư cuối kỳ dưới 0 ở một trong hai màn."
        exportFileName="doi_chieu_so_quy_nguon_tien"
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 text-xs" data-no-export>
        <span className="font-bold text-slate-600">{check.rows.length} nguồn</span>
        <span className={mismatched ? "font-bold text-rose-700" : "text-emerald-700"}>{mismatched ? `${mismatched} nguồn lệch` : "Tất cả khớp"}</span>
        {negative > 0 && <span className="font-bold text-amber-700">{negative} nguồn âm cuối kỳ</span>}
        <label className="ml-auto inline-flex items-center gap-1.5 text-slate-600">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          Hiện cả nguồn khớp
        </label>
      </div>
      <Table headers={headers} rightFrom={showBranch ? 2 : 1}>
        {rows.length === 0 && (
          <tr className="border-t border-slate-100">
            <td colSpan={headers.length} className="px-4 py-4 text-sm text-emerald-700">Sổ quỹ và Nguồn tiền khớp ở mọi nguồn, không có nguồn nào âm cuối kỳ.</td>
          </tr>
        )}
        {rows.map((row) => (
          <tr key={row.key} className="border-t border-slate-100">
            {showBranch && <Cell>{storeLabel(row.branchCode)}</Cell>}
            <Cell><b>{row.name}</b><small className="block text-slate-500">{row.codes.join(", ")}</small></Cell>
            <Cell right>{amount(row.cashbook.opening)}</Cell>
            <Cell right>{amount(row.report.opening)}</Cell>
            <Cell right>{diff(row.openingDiff)}</Cell>
            <Cell right>{amount(row.cashbook.closing)}</Cell>
            <Cell right>{amount(row.report.closing)}</Cell>
            <Cell right>{diff(row.closingDiff)}</Cell>
            <Cell>{status(row)}</Cell>
          </tr>
        ))}
      </Table>

      {check.duplicates.length > 0 && (
        <div className="border-t border-slate-200 p-4" data-no-export>
          <h3 className="text-sm font-bold text-rose-700">Dòng sao kê nghi nạp trùng ({check.duplicates.length} nhóm)</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Cùng tài khoản, ngày, số tiền, diễn giải nhưng đến từ hai lần import khác nhau — báo cáo Nguồn tiền đang tính hai lần. Giữ dòng đã khớp chứng từ, xoá dòng thừa ở Sổ sao kê ngân hàng.
          </p>
          <BankLineTable groups={check.duplicates} />
        </div>
      )}
      {check.unmatched.length > 0 && (
        <div className="border-t border-slate-200 p-4" data-no-export>
          <h3 className="text-sm font-bold text-amber-700">Dòng sao kê trong kỳ chưa có chứng từ ({check.unmatched.length})</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Của các tài khoản đang lệch. Báo cáo Nguồn tiền đã tính các dòng này, Sổ quỹ chưa có phiếu tương ứng — lập / nối chứng từ ở Sổ sao kê ngân hàng, hoặc xoá nếu là dòng thừa.
          </p>
          <BankLineTable groups={check.unmatched.map((line) => [line])} />
        </div>
      )}
    </section>
  );
}

function BankLineTable({ groups }: { groups: SuspectBankLine[][] }) {
  const day = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString("vi-VN", { timeZone: "UTC" });
  return (
    <div className="mt-2 max-h-[420px] overflow-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[960px] text-xs">
        <thead className="sticky top-0 bg-slate-100 text-[10px] uppercase text-slate-500">
          <tr>
            {["Tài khoản", "Ngày", "Chi", "Thu", "Diễn giải", "Mã giao dịch", "File import", "Ngày nạp", "Đối soát"].map((label) => (
              <th key={label} className={`px-2 py-2 ${["Chi", "Thu"].includes(label) ? "text-right" : "text-left"}`}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.flatMap((group, groupIndex) => group.map((line, index) => (
            <tr key={`${line.bankAccount}-${line.transactionCode}`} className={`${index === 0 ? "border-t-2 border-slate-200" : "border-t border-slate-100"} ${groupIndex % 2 ? "bg-slate-50/60" : ""}`}>
              <td className="px-2 py-1.5 whitespace-nowrap">{line.bankAccount}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{day(line.transactionDate)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{line.debitAmount ? money(line.debitAmount) : ""}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{line.creditAmount ? money(line.creditAmount) : ""}</td>
              <td className="px-2 py-1.5 max-w-[320px] truncate" title={line.description}>{line.description}</td>
              <td className="px-2 py-1.5 whitespace-nowrap font-semibold">{line.transactionCode}</td>
              <td className="px-2 py-1.5 max-w-[200px] truncate text-slate-500" title={line.fileName || ""}>{line.fileName || ""}</td>
              <td className="px-2 py-1.5 whitespace-nowrap text-slate-500">{line.importedAt}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                {line.reconcileStatus === "MATCHED"
                  ? <span className="font-bold text-emerald-700">Đã khớp</span>
                  : <span className="font-bold text-rose-700">Chưa khớp</span>}
              </td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  );
}
