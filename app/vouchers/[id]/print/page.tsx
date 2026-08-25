"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { storeLabel } from "@/lib/branch-labels";
import { moneySourceDisplayName, type MoneySourceOption } from "@/lib/money-sources";
import { type VoucherDocumentChannel, voucherTypeLabel } from "@/lib/voucher-channel";

type Voucher = {
  id: string;
  code: string;
  voucherType: string;
  documentChannel: VoucherDocumentChannel;
  voucherDate: string;
  partnerName: string;
  branchCode: string;
  moneySourceCode: string;
  amount: number;
  description: string;
  status: string;
  createdBy: string | null;
  approvedBy: string | null;
  recipientName?: string | null;
  partnerAllocations?: Array<{ id: string; partnerCode: string; partnerName: string; amount: number; debtReference: string | null }>;
};

type BranchOption = { code: string; name: string };

export default function VoucherPrintPage() {
  const params = useParams<{ id: string }>();
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [moneySources, setMoneySources] = useState<MoneySourceOption[]>([]);

  useEffect(() => {
    fetch(`/api/vouchers?id=${params.id}`).then(async (response) => {
      if (response.ok) setVoucher((await response.json()) as Voucher);
    });
    // Chứng từ in ra phải mang TÊN nhà hàng và TÊN nguồn tiền — mã nội bộ (NME, FDSTIENBINH)
    // chỉ có ý nghĩa với người làm hệ thống, người nhận tiền cầm tờ phiếu không hiểu.
    fetch("/api/branding").then(async (response) => {
      if (response.ok) {
        const data = (await response.json()) as { branches?: BranchOption[] };
        setBranches(data.branches || []);
      }
    });
    fetch("/api/master-data?type=MONEY_SOURCE").then(async (response) => {
      if (response.ok) setMoneySources((await response.json()) as MoneySourceOption[]);
    });
  }, [params.id]);

  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  if (!voucher) return <div className="p-10">Đang tải chứng từ...</div>;

  const branchName = branches.find((branch) => branch.code === voucher.branchCode)?.name
    || storeLabel(voucher.branchCode);
  const source = moneySources.find((item) => item.code === voucher.moneySourceCode);
  const moneySourceName = source ? moneySourceDisplayName(source) : voucher.moneySourceCode;

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-3xl mx-auto border border-slate-200 p-8 print:border-0">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <h1 className="text-2xl font-bold uppercase">{branchName}</h1>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In chứng từ</button>
        </div>

        {/* Tên chứng từ là thứ đọc đầu tiên nên để lớn và đậm; mã phiếu chỉ dùng để tra cứu
            nên thu nhỏ lại, không còn chiếm vai trò tiêu đề. */}
        <section className="text-center py-8">
          <h2 className="text-3xl font-bold uppercase tracking-wide">{voucherTypeLabel(voucher.voucherType, voucher.documentChannel || "CASH")}</h2>
          <p className="mt-2 text-sm uppercase tracking-widest text-slate-500">{voucher.code}</p>
          <p className="text-sm text-slate-500 mt-2">Ngày {new Date(voucher.voucherDate).toLocaleDateString("vi-VN")}</p>
        </section>

        <div className="space-y-4 text-sm">
          {/* Chỗ ghi họ tên người cầm tiền. Chưa khai trong hệ thống thì để dòng kẻ trống
              cho người nhận tự điền khi ký. */}
          <div className="grid grid-cols-[160px_1fr] gap-3">
            <b>Họ tên</b>
            <span className={voucher.recipientName ? "" : "border-b border-dotted border-slate-400"}>{voucher.recipientName || ""}</span>
          </div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Đối tác</b><span>{voucher.partnerName}</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Nguồn tiền</b><span>{moneySourceName}</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Nội dung</b><span>{voucher.description}</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Số tiền</b><span className="text-xl font-bold">{money(voucher.amount)} đ</span></div>
        </div>

        {(voucher.partnerAllocations?.length || 0) > 0 && (
          <table className="mt-6 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b-2 border-slate-300 text-left text-xs uppercase text-slate-500">
                <th className="py-2">STT</th>
                <th className="py-2">Đối tác</th>
                <th className="py-2">Mã công nợ</th>
                <th className="py-2 text-right">Số tiền</th>
              </tr>
            </thead>
            <tbody>
              {voucher.partnerAllocations?.map((line, index) => (
                <tr key={line.id} className="border-b border-slate-100">
                  <td className="py-2">{index + 1}</td>
                  <td className="py-2">{line.partnerCode} — {line.partnerName}</td>
                  <td className="py-2">{line.debtReference || "-"}</td>
                  <td className="py-2 text-right font-bold">{money(line.amount)} đ</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="py-2 font-bold">CỘNG</td>
                <td className="py-2 text-right text-base font-bold">
                  {money(voucher.partnerAllocations?.reduce((sum, line) => sum + line.amount, 0) || 0)} đ
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {/* Ô "Phê duyệt" để trống cho người duyệt ký tay trên bản in — không in sẵn tên
            người đã bấm duyệt trong hệ thống. */}
        <div className="grid grid-cols-3 gap-8 text-center mt-16 text-sm">
          <div><b>Người lập</b><div className="h-20" /><p>{voucher.createdBy || ""}</p></div>
          <div><b>Phê duyệt</b><div className="h-20" /></div>
          <div><b>Người nhận tiền</b><div className="h-20" /><p>{voucher.recipientName || ""}</p></div>
        </div>
      </div>
    </main>
  );
}
