"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Voucher = {
  id: string;
  code: string;
  voucherType: string;
  voucherDate: string;
  partnerName: string;
  branchCode: string;
  moneySourceCode: string;
  amount: number;
  description: string;
  status: string;
  createdBy: string | null;
  approvedBy: string | null;
};

export default function VoucherPrintPage() {
  const params = useParams<{ id: string }>();
  const [voucher, setVoucher] = useState<Voucher | null>(null);

  useEffect(() => {
    fetch(`/api/vouchers?id=${params.id}`).then(async (response) => {
      if (response.ok) setVoucher((await response.json()) as Voucher);
    });
  }, [params.id]);

  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  if (!voucher) return <div className="p-10">Đang tải chứng từ...</div>;

  return (
    <main className="min-h-screen bg-white text-slate-950 p-8 print:p-0">
      <div className="max-w-3xl mx-auto border border-slate-200 p-8 print:border-0">
        <div className="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold">FIN ERP</h1>
            <p className="text-sm text-slate-500">Chi nhánh: {voucher.branchCode}</p>
          </div>
          <button onClick={() => window.print()} className="print:hidden rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-bold">In chứng từ</button>
        </div>

        <section className="text-center py-8">
          <p className="text-sm uppercase tracking-widest text-slate-500">{voucher.voucherType === "RECEIPT" ? "Phiếu thu" : "Phiếu chi"}</p>
          <h2 className="text-3xl font-bold mt-2">{voucher.code}</h2>
          <p className="text-sm text-slate-500 mt-2">Ngày {new Date(voucher.voucherDate).toLocaleDateString("vi-VN")}</p>
        </section>

        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Đối tác</b><span>{voucher.partnerName}</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Nguồn tiền</b><span>{voucher.moneySourceCode}</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Nội dung</b><span>{voucher.description}</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Số tiền</b><span className="text-xl font-bold">{money(voucher.amount)} đ</span></div>
          <div className="grid grid-cols-[160px_1fr] gap-3"><b>Trạng thái</b><span>{voucher.status}</span></div>
        </div>

        <div className="grid grid-cols-3 gap-8 text-center mt-16 text-sm">
          <div><b>Người lập</b><div className="h-20" /><p>{voucher.createdBy || "-"}</p></div>
          <div><b>Kế toán</b><div className="h-20" /><p>-</p></div>
          <div><b>Người duyệt</b><div className="h-20" /><p>{voucher.approvedBy || "-"}</p></div>
        </div>
      </div>
    </main>
  );
}
