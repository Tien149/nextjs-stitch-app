"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type DebtRow = {
  partnerCode: string;
  partnerName: string;
  openingAmount: number;
  depositHolding: number;
  bankMatched: number;
  voucherNet: number;
  balance: number;
};

type LedgerDetail = {
  partnerCode: string;
  partnerName: string;
  balance: number;
  rows: {
    date: string;
    source: string;
    code: string;
    description: string;
    amount: number;
  }[];
};

export default function DebtsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<DebtRow[]>([]);
  const [ledger, setLedger] = useState<LedgerDetail | null>(null);
  const [user, setUser] = useState<DemoSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/debts");
    if (!raw) {
      router.push("/login?next=/debts");
      return;
    }
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setLoading(false);
    }, 0);
  }, [router]);

  const loadRows = async () => {
    const response = await fetch("/api/debts");
    if (response.ok) setRows((await response.json()) as DebtRow[]);
  };

  const loadLedger = async (partnerCode: string) => {
    const response = await fetch(`/api/debts?partnerCode=${encodeURIComponent(partnerCode)}`);
    if (response.ok) setLedger((await response.json()) as LedgerDetail);
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadRows();
      }, 0);
    }
  }, [loading]);

  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/")} className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">Quản lý Công nợ</h1>
            <p className="text-xs text-slate-500">GĐ2 - 6.4: tổng hợp từ số dư đầu kỳ, tiền cọc, sao kê và phiếu thu/chi.</p>
          </div>
        </div>
        <p className="text-xs font-bold text-slate-500">{user?.role}</p>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="grid md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Đối tác</p>
            <p className="text-2xl font-bold">{rows.length}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Phải thu</p>
            <p className="text-2xl font-bold text-blue-700">{money(rows.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0))} đ</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Phải trả/đã thu dư</p>
            <p className="text-2xl font-bold text-rose-700">{money(Math.abs(rows.filter((r) => r.balance < 0).reduce((s, r) => s + r.balance, 0)))} đ</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Tiền cọc còn giữ</p>
            <p className="text-2xl font-bold text-emerald-700">{money(rows.reduce((s, r) => s + r.depositHolding, 0))} đ</p>
          </div>
        </div>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Bảng công nợ đối tác</h2>
              <p className="text-xs text-slate-500 mt-1">Số dư dương là còn phải thu, số dư âm là phải trả/thu dư. Bấm đối tác để xem ledger.</p>
            </div>
            <button onClick={loadRows} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tải lại</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">Đối tác</th>
                  <th className="px-4 py-3 text-right">Đầu kỳ</th>
                  <th className="px-4 py-3 text-right">Cọc còn giữ</th>
                  <th className="px-4 py-3 text-right">Sao kê match</th>
                  <th className="px-4 py-3 text-right">Phiếu thu/chi</th>
                  <th className="px-4 py-3 text-right">Số dư</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.partnerCode} onClick={() => loadLedger(row.partnerCode)} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-3"><b>{row.partnerName}</b><p className="text-xs text-slate-500">{row.partnerCode}</p></td>
                    <td className="px-4 py-3 text-right">{money(row.openingAmount)}</td>
                    <td className="px-4 py-3 text-right">{money(row.depositHolding)}</td>
                    <td className="px-4 py-3 text-right">{money(row.bankMatched)}</td>
                    <td className="px-4 py-3 text-right">{money(row.voucherNet)}</td>
                    <td className={`px-4 py-3 text-right font-bold ${row.balance >= 0 ? "text-blue-700" : "text-rose-700"}`}>{money(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {ledger && (
          <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 className="font-bold">Ledger: {ledger.partnerName}</h2>
                <p className="text-xs text-slate-500 mt-1">Số dư hiện tại: <b>{money(ledger.balance)} đ</b></p>
              </div>
              <button onClick={() => setLedger(null)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Đóng</button>
            </div>
            <div className="overflow-x-auto max-h-[420px]">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase sticky top-0">
                  <tr>
                    <th className="px-4 py-3">Ngày</th>
                    <th className="px-4 py-3">Nguồn</th>
                    <th className="px-4 py-3">Mã</th>
                    <th className="px-4 py-3">Diễn giải</th>
                    <th className="px-4 py-3 text-right">Phát sinh</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.rows.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Chưa có phát sinh.</td></tr>
                  ) : ledger.rows.map((item, index) => (
                    <tr key={`${item.source}-${item.code}-${index}`} className="hover:bg-slate-50">
                      <td className="px-4 py-3">{new Date(item.date).toLocaleDateString("vi-VN")}</td>
                      <td className="px-4 py-3">{item.source}</td>
                      <td className="px-4 py-3 font-bold">{item.code}</td>
                      <td className="px-4 py-3">{item.description}</td>
                      <td className={`px-4 py-3 text-right font-bold ${item.amount >= 0 ? "text-blue-700" : "text-rose-700"}`}>{money(item.amount)} đ</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
