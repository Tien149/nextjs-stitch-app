"use client";

import { isProfitDistributionDebt } from "@/lib/profit-distribution";
import { useEffect, useState } from "react";
import { storeLabel } from "@/lib/branch-labels";
import { money } from "@/lib/format-number";
import { vatRateLabel } from "@/lib/inventory-vat";

/**
 * Bản in CHỨNG TỪ CÔNG NỢ (khách 13/11/2026) — mở từ nút In trên sổ công nợ hoặc nút "Tạo & in"
 * của hộp thoại Thêm công nợ: `/debts/print?code=CNPT-202611-0007`. Một phiếu nhiều dòng hạng
 * mục in chung một tờ. Cùng kiểu trang in phiếu thu/chi và phiếu kho: tên nhà hàng, tiêu đề lớn,
 * bảng dòng, ô ký tay để trống.
 */
type DebtRecord = {
  id: string;
  code: string;
  debtType: string;
  partnerCode: string;
  partnerName: string;
  branchCode: string;
  documentDate: string;
  dueDate: string | null;
  pnlItemCode: string | null;
  pnlGroupCode: string | null;
  originalAmount: number;
  outstandingAmount: number;
  amountBeforeTax: number | null;
  vatRate: number | null;
  vatAmount: number | null;
  description: string;
  allocationMonths: number | null;
  allocationStartPeriod: string | null;
  sourceType?: string | null;
};
type Payload = { groupCode: string; records: DebtRecord[]; pnlNames: Record<string, string> };
type BranchOption = { code: string; name: string };

const dateText = (value: string | null) => (value ? new Date(value).toLocaleDateString("vi-VN") : "");

export default function DebtPrintPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);

  useEffect(() => {
    // Đọc ?code= ở đây thay vì useSearchParams để trang không cần bọc Suspense.
    const code = new URLSearchParams(window.location.search).get("code") || "";
    fetch(`/api/debts?print=${encodeURIComponent(code)}`).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) setPayload(data as Payload);
      else setError((data as { error?: string }).error || "Không tải được chứng từ công nợ");
    });
    fetch("/api/branding").then(async (response) => {
      if (response.ok) setBranches(((await response.json()) as { branches?: BranchOption[] }).branches || []);
    });
  }, []);

  if (error) return <div className="p-10 text-rose-700">{error}</div>;
  if (!payload) return <div className="p-10">Đang tải chứng từ công nợ...</div>;

  const { groupCode, records, pnlNames } = payload;
  const head = records[0];
  const isPayable = head.debtType === "PAYABLE";
  const isDistribution = isProfitDistributionDebt(head.sourceType);
  const branchName = branches.find((branch) => branch.code === head.branchCode)?.name || storeLabel(head.branchCode);
  const hasTax = records.some((row) => row.amountBeforeTax !== null);
  // Diễn giải chung = phần trước " · " của dòng đầu (các dòng nhiều hạng mục nối thêm mã/ghi chú).
  const commonDescription = records.length > 1 ? head.description.split(" · ")[0] : head.description;
  const lineNote = (row: DebtRecord) => (records.length > 1 ? row.description.split(" · ").slice(1).join(" · ") : "");
  const pnlCode = (row: DebtRecord) => row.pnlItemCode || row.pnlGroupCode || "";
  const total = (pick: (row: DebtRecord) => number) => records.reduce((sum, row) => sum + pick(row), 0);
  const beforeTaxOf = (row: DebtRecord) => row.amountBeforeTax ?? row.originalAmount;
  const vatOf = (row: DebtRecord) => row.vatAmount ?? 0;

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-5xl mx-auto border border-slate-200 p-8 print:border-0 print:max-w-none">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold uppercase">{branchName}</h1>
          </div>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In chứng từ</button>
        </div>

        <section className="text-center py-8">
          <h2 className="text-3xl font-bold uppercase tracking-wide">{isDistribution ? "Phiếu chia lợi nhuận" : isPayable ? "Chứng từ công nợ phải trả" : "Chứng từ công nợ phải thu"}</h2>
          <p className="mt-2 text-sm uppercase tracking-widest text-slate-500">{groupCode}</p>
          <p className="text-sm text-slate-500 mt-2">Ngày {dateText(head.documentDate)}</p>
        </section>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-[180px_1fr] gap-3"><b>{isPayable ? "Đối tác (bên được trả)" : "Đối tác (bên phải trả)"}</b><span>{head.partnerName} ({head.partnerCode})</span></div>
          <div className="grid grid-cols-[180px_1fr] gap-3"><b>Diễn giải</b><span>{commonDescription}</span></div>
          {head.dueDate && <div className="grid grid-cols-[180px_1fr] gap-3"><b>Hạn thanh toán</b><span>{dateText(head.dueDate)}</span></div>}
          {(head.allocationMonths || 0) > 1 && (
            <div className="grid grid-cols-[180px_1fr] gap-3"><b>Phân bổ chi phí</b><span>{head.allocationMonths} kỳ từ {head.allocationStartPeriod}</span></div>
          )}
        </div>

        <table className="mt-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y-2 border-slate-300 text-left text-xs uppercase text-slate-500">
              <th className="py-2 pr-2">STT</th>
              <th className="py-2 pr-2">{isDistribution ? "Tài khoản đối ứng" : isPayable ? "Hạng mục P&L" : "Nhóm hạng mục P&L"}</th>
              {hasTax && <th className="py-2 pr-2 text-right">Số tiền trước thuế</th>}
              {hasTax && <th className="py-2 pr-2 text-right">Thuế suất</th>}
              {hasTax && <th className="py-2 pr-2 text-right">Tiền thuế GTGT</th>}
              <th className="py-2 text-right">{hasTax ? "Số tiền sau thuế" : "Số tiền"}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((row, index) => (
              <tr key={row.id} className="border-b border-slate-100 align-top">
                <td className="py-2 pr-2">{index + 1}</td>
                <td className="py-2 pr-2">
                  {isDistribution ? "421 · Lợi nhuận chưa phân phối" : pnlCode(row) ? `${pnlNames[pnlCode(row)] || pnlCode(row)}` : "Chưa phân loại P&L"}
                  {lineNote(row) && <small className="block text-slate-500 italic">{lineNote(row)}</small>}
                </td>
                {hasTax && <td className="py-2 pr-2 text-right tabular-nums">{money(beforeTaxOf(row))}</td>}
                {hasTax && <td className="py-2 pr-2 text-right">{row.amountBeforeTax !== null ? vatRateLabel(row.vatRate) : ""}</td>}
                {hasTax && <td className="py-2 pr-2 text-right tabular-nums">{row.amountBeforeTax !== null ? money(vatOf(row)) : ""}</td>}
                <td className="py-2 text-right tabular-nums font-bold">{money(row.originalAmount)}</td>
              </tr>
            ))}
          </tbody>
          {/* tbody thay vì tfoot: tfoot bị lặp ở cuối mọi trang in. */}
          <tbody className="break-inside-avoid">
            <tr className="border-t-2 border-slate-300">
              <td colSpan={2} className="py-2 font-bold">Tổng cộng</td>
              {hasTax && <td className="py-2 pr-2 text-right tabular-nums font-bold">{money(total(beforeTaxOf))}</td>}
              {hasTax && <td />}
              {hasTax && <td className="py-2 pr-2 text-right tabular-nums font-bold">{money(total(vatOf))}</td>}
              <td className="py-2 text-right tabular-nums text-base font-bold">{money(total((row) => row.originalAmount))} đ</td>
            </tr>
          </tbody>
        </table>

        {/* Ô ký để trống cho ký tay trên bản in. */}
        <div className="grid grid-cols-3 gap-6 text-center mt-16 text-sm">
          <div><b>Người lập</b><div className="h-20" /></div>
          <div><b>Kế toán</b><div className="h-20" /></div>
          <div><b>Người duyệt</b><div className="h-20" /></div>
        </div>
      </div>
    </main>
  );
}
