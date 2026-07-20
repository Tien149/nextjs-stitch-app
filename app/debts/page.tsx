"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type DebtRow = {
  partnerCode: string;
  partnerName: string;
  openingAmount: number;
  depositHolding: number;
  bankMatched: number;
  voucherNet: number;
  purchasePayable: number;
  debtReceivable: number;
  debtPayable: number;
  partnerGroup: string;
  nearestDueDate: string | null;
  overdueAmount: number;
  dueSoonAmount: number;
  openDebtCount: number;
  debtStatus: string;
  balance: number;
};

type LedgerDetail = {
  partnerCode: string;
  partnerName: string;
  balance: number;
  rows: {
    date: string;
    dueDate?: string | null;
    source: string;
    code: string;
    description: string;
    amount: number;
    status?: string;
    agingBucket?: string;
  }[];
};

export default function DebtsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<DebtRow[]>([]);
  const [ledger, setLedger] = useState<LedgerDetail | null>(null);
  const [user, setUser] = useState<DemoSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [debtType, setDebtType] = useState<"ALL" | "RECEIVABLE" | "PAYABLE">("ALL");
  const [partnerGroup, setPartnerGroup] = useState<"ALL" | "EXTERNAL" | "INTERNAL">("ALL");
  const [agingFilter, setAgingFilter] = useState<"ALL" | "OVERDUE" | "DUE_7" | "OPEN">("ALL");
  const [branchScope, setBranchScope] = useState("ALL");

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
      setBranchScope(resolveInitialBranchScope(session));
      setLoading(false);
    }, 0);
  }, [router]);

  const loadRows = useCallback(async () => {
    const response = await fetch(`/api/debts?branchCode=${encodeURIComponent(branchScope)}`);
    if (response.ok) setRows((await response.json()) as DebtRow[]);
  }, [branchScope]);

  const loadLedger = useCallback(async (partnerCode: string) => {
    const response = await fetch(`/api/debts?partnerCode=${encodeURIComponent(partnerCode)}&branchCode=${encodeURIComponent(branchScope)}`);
    if (response.ok) setLedger((await response.json()) as LedgerDetail);
  }, [branchScope]);

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadRows();
        setLedger(null);
      }, 0);
    }
  }, [loading, loadRows]);

  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  const filteredRows = rows.filter((row) => {
    if (partnerGroup !== "ALL" && row.partnerGroup !== partnerGroup) return false;
    if (agingFilter !== "ALL" && row.debtStatus !== agingFilter) return false;
    if (debtType === "RECEIVABLE" && row.balance <= 0) return false;
    if (debtType === "PAYABLE" && row.balance >= 0) return false;
    return true;
  });
  const overdueTotal = rows.reduce((sum, row) => sum + row.overdueAmount, 0);
  const dueSoonTotal = rows.reduce((sum, row) => sum + row.dueSoonAmount, 0);

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
        <div className="flex items-center gap-3">
          <BranchScopeSelect session={user} value={branchScope} onChange={setBranchScope} />
          <p className="hidden text-xs font-bold text-slate-500 sm:block">{user?.role}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="grid md:grid-cols-5 gap-4">
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
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <p className="text-xs text-slate-500">Quá hạn / sắp hạn</p>
            <p className="text-lg font-bold text-rose-700">{money(overdueTotal)} đ</p>
            <p className="text-xs font-bold text-amber-600">{money(dueSoonTotal)} đ trong 7 ngày</p>
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex gap-1" role="tablist" aria-label="Loại công nợ">
              {(["ALL", "RECEIVABLE", "PAYABLE"] as const).map((value) => (
                <button key={value} type="button" onClick={() => setDebtType(value)} className={`border-b-2 px-3 py-2 text-sm font-bold ${debtType === value ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500"}`}>
                  {value === "ALL" ? "Tất cả" : value === "RECEIVABLE" ? "Phải thu" : "Phải trả"}
                </button>
              ))}
            </div>
            <select value={partnerGroup} onChange={(event) => setPartnerGroup(event.target.value as "ALL" | "EXTERNAL" | "INTERNAL")} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="ALL">Tất cả đối tượng</option>
              <option value="EXTERNAL">Bên ngoài</option>
              <option value="INTERNAL">Nội bộ</option>
            </select>
            <select value={agingFilter} onChange={(event) => setAgingFilter(event.target.value as "ALL" | "OVERDUE" | "DUE_7" | "OPEN")} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
              <option value="ALL">Tất cả hạn</option>
              <option value="OVERDUE">Quá hạn</option>
              <option value="DUE_7">Sắp đến hạn 7 ngày</option>
              <option value="OPEN">Còn hạn</option>
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-3">Đối tác</th>
                  <th className="px-4 py-3">Nhóm</th>
                  <th className="px-4 py-3">Hạn gần nhất</th>
                  <th className="px-4 py-3 text-right">Đầu kỳ</th>
                  <th className="px-4 py-3 text-right">CN phải thu</th>
                  <th className="px-4 py-3 text-right">CN phải trả</th>
                  <th className="px-4 py-3 text-right">Nhập hàng</th>
                  <th className="px-4 py-3 text-right">Cọc còn giữ</th>
                  <th className="px-4 py-3 text-right">Sao kê match</th>
                  <th className="px-4 py-3 text-right">Phiếu thu/chi</th>
                  <th className="px-4 py-3 text-right">Số dư</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRows.map((row) => (
                  <tr key={row.partnerCode} onClick={() => loadLedger(row.partnerCode)} className="hover:bg-slate-50 cursor-pointer">
                    <td className="px-4 py-3"><b>{row.partnerName}</b><p className="text-xs text-slate-500">{row.partnerCode}</p></td>
                    <td className="px-4 py-3 text-xs font-bold text-slate-500">{row.partnerGroup === "INTERNAL" ? "Nội bộ" : "Bên ngoài"}</td>
                    <td className="px-4 py-3">
                      <p className={`text-xs font-bold ${row.debtStatus === "OVERDUE" ? "text-rose-700" : row.debtStatus === "DUE_7" ? "text-amber-700" : "text-slate-500"}`}>
                        {row.nearestDueDate ? new Date(row.nearestDueDate).toLocaleDateString("vi-VN") : "-"}
                      </p>
                      <p className="text-[11px] text-slate-400">{row.openDebtCount ? `${row.openDebtCount} khoản mở` : "Không có hạn"}</p>
                    </td>
                    <td className="px-4 py-3 text-right">{money(row.openingAmount)}</td>
                    <td className="px-4 py-3 text-right text-blue-700">{money(row.debtReceivable)}</td>
                    <td className="px-4 py-3 text-right text-rose-700">{money(row.debtPayable)}</td>
                    <td className="px-4 py-3 text-right text-rose-700">{money(row.purchasePayable)}</td>
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
                    <th className="px-4 py-3">Hạn/TT</th>
                    <th className="px-4 py-3">Diễn giải</th>
                    <th className="px-4 py-3 text-right">Phát sinh</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.rows.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Chưa có phát sinh.</td></tr>
                  ) : ledger.rows.map((item, index) => (
                    <tr key={`${item.source}-${item.code}-${index}`} className="hover:bg-slate-50">
                      <td className="px-4 py-3">{new Date(item.date).toLocaleDateString("vi-VN")}</td>
                      <td className="px-4 py-3">{item.source}</td>
                      <td className="px-4 py-3 font-bold">{item.code}</td>
                      <td className="px-4 py-3">
                        <p className={`text-xs font-bold ${item.agingBucket === "OVERDUE" ? "text-rose-700" : item.agingBucket === "DUE_7" ? "text-amber-700" : "text-slate-500"}`}>
                          {item.dueDate ? new Date(item.dueDate).toLocaleDateString("vi-VN") : "-"}
                        </p>
                        <p className="text-[11px] text-slate-400">{item.status || "-"}</p>
                      </td>
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
