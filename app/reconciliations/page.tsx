"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { filterMoneySources, type MoneySourceOption } from "@/lib/money-sources";
import { visibleStoreOptions } from "@/lib/branch-labels";

type Allocation = { id: string; sourceRowNumber: number; sheetName: string; revenueDate: string | null; sourceDate: string | null; grossAmount: number | null; grabExpenseAmount: number; cardFeeAmount: number };
type MatchRow = { targetCode: string; targetType: string; targetHref?: string };
type BankRow = {
  id: string; transactionDate: string; sourceDate: string | null; accountingDate: string | null;
  bankAccount: string; transactionCode: string; description: string; debitAmount: number; creditAmount: number;
  branchCode: string | null; categoryCode: string | null; operationType: string | null; partnerCode: string | null;
  pnlItemCode: string | null; increaseMoneySourceCode: string | null; decreaseMoneySourceCode: string | null;
  reconcileStatus: string; revenueDates: string[]; allocations: Allocation[]; currentMatch: MatchRow | null;
};

const operationLabels: Record<string, string> = {
  REVENUE_RECEIPT: "Thu doanh thu", DIRECT_EXPENSE: "Chi phí trực tiếp", AR_COLLECTION: "Thu công nợ",
  AP_PAYMENT: "Trả công nợ", DEPOSIT_RECEIPT: "Thu tiền cọc", DEPOSIT_REFUND: "Hoàn tiền cọc",
  INTERNAL_TRANSFER: "Điều tiền nội bộ", WALLET_SETTLEMENT: "Quyết toán Ví/Grab", BANK_FEE: "Phí ngân hàng",
  OTHER_RECEIPT: "Thu khác", OTHER_PAYMENT: "Chi khác",
};

function dateText(value: string | null | undefined) {
  return value ? new Date(value).toLocaleDateString("vi-VN", { timeZone: "UTC" }) : "—";
}

const emptyFilters = { from: "", to: "", dateType: "TRANSACTION", branchCode: "ALL", bankAccount: "", operationType: "", q: "" };

export default function BankStatementLedgerPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [moneySources, setMoneySources] = useState<MoneySourceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [batchId, setBatchId] = useState("");
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/reconciliations");
    if (!raw) return void router.push("/login?next=/reconciliations");
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) return void router.push("/");
    window.setTimeout(() => {
      setUser(session);
      setBatchId(new URLSearchParams(window.location.search).get("batchId")?.trim() || "");
    }, 0);
    void fetch("/api/master-data?type=MONEY_SOURCE&status=ACTIVE")
      .then((response) => response.ok ? response.json() : [])
      .then((data: MoneySourceOption[]) => setMoneySources(data));
  }, [router]);

  const loadRows = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const params = new URLSearchParams({ status: "ALL", ledger: "1", page: String(page), dateType: applied.dateType });
    Object.entries(applied).forEach(([key, value]) => {
      if (value && !["dateType", "branchCode"].includes(key)) params.set(key, value);
    });
    if (applied.branchCode !== "ALL") params.set("branchCode", applied.branchCode);
    if (batchId) params.set("batchId", batchId);
    const response = await fetch(`/api/reconciliations?${params}`);
    const payload = await response.json();
    if (response.ok) {
      setRows(payload.rows || []);
      setTotal(Number(payload.pagination?.total || 0));
      setTotalPages(Math.max(1, Number(payload.pagination?.totalPages || 1)));
    }
    setLoading(false);
  }, [applied, batchId, page, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRows(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRows]);
  const applyFilters = () => { setPage(1); setApplied(filters); };
  const clearFilters = () => {
    setFilters(emptyFilters); setApplied(emptyFilters); setBatchId(""); setPage(1);
    window.history.replaceState(null, "", "/reconciliations");
  };
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  const recorded = rows.filter((row) => row.reconcileStatus === "MATCHED").length;

  return <div className="min-h-screen bg-slate-100 text-slate-800">
    <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
      <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4">
        <div><h1 className="text-xl font-bold">Sổ sao kê ngân hàng</h1><p className="text-xs text-slate-500">Dữ liệu tích lũy theo các file đã Commit; mỗi dòng truy vết được về chứng từ nguồn.</p></div>
        <button onClick={() => router.push("/imports?tab=bank-statement")} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700">Import sao kê bổ sung</button>
      </div>
    </header>

    <main className="mx-auto max-w-[1800px] space-y-4 p-4 sm:p-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-7">
          <label className="text-xs font-bold text-slate-600">Loại ngày<select className="control" value={filters.dateType} onChange={(e) => setFilters({ ...filters, dateType: e.target.value })}><option value="TRANSACTION">Ngày giao dịch</option><option value="SOURCE">Ngày nguồn tiền</option><option value="REVENUE">Ngày doanh thu</option></select></label>
          <label className="text-xs font-bold text-slate-600">Từ ngày<input className="control" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-600">Đến ngày<input className="control" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-600">Cửa hàng<select className="control" value={filters.branchCode} onChange={(e) => setFilters({ ...filters, branchCode: e.target.value })}><option value="ALL">Tất cả cửa hàng</option>{visibleStoreOptions(user).map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Tài khoản ngân hàng<select className="control" value={filters.bankAccount} onChange={(e) => setFilters({ ...filters, bankAccount: e.target.value })}><option value="">Tất cả tài khoản</option>{filterMoneySources(moneySources, filters.branchCode, ["BANK"]).map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Loại nghiệp vụ<select className="control" value={filters.operationType} onChange={(e) => setFilters({ ...filters, operationType: e.target.value })}><option value="">Tất cả nghiệp vụ</option>{Object.entries(operationLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Từ khóa<input className="control" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} onKeyDown={(e) => e.key === "Enter" && applyFilters()} placeholder="Mã GD, diễn giải, chứng từ..." /></label>
        </div>
        <div className="mt-3 flex justify-end gap-2"><button onClick={clearFilters} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold">Xóa lọc</button><button onClick={applyFilters} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white">Lọc dữ liệu</button></div>
      </section>

      {batchId && <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">Đang hiển thị {total} giao dịch của batch vừa import.</div>}
      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Tổng giao dịch</p><b className="text-2xl">{total}</b></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Đã ghi nhận trên trang</p><b className="text-2xl text-emerald-700">{recorded}</b></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs text-slate-500">Chế độ</p><b className="text-lg">Tra cứu tích lũy</b></div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4"><h2 className="font-bold">Danh sách giao dịch sao kê đã import</h2><p className="mt-1 text-xs text-slate-500">Không cần match thủ công; file hợp lệ được ghi nhận trực tiếp khi Commit.</p></div>
        <div className="overflow-x-auto"><table className="min-w-[1500px] w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{["Ngày GD / nguồn / DT", "Sao kê", "Nợ", "Có", "Cửa hàng", "Nghiệp vụ / loại", "Nguồn tăng / giảm", "Đối tác / P&L", "Chứng từ", "Trạng thái"].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead>
          <tbody>{loading ? <tr><td colSpan={10} className="p-10 text-center text-slate-400">Đang tải...</td></tr> : rows.length === 0 ? <tr><td colSpan={10} className="p-10 text-center text-slate-400">Không có giao dịch phù hợp.</td></tr> : rows.map((row) => <tr key={row.id} className="border-t border-slate-100 align-top hover:bg-slate-50">
            <td className="px-3 py-3 text-xs"><b>{dateText(row.transactionDate)}</b><p>Nguồn: {dateText(row.sourceDate)}</p><p>DT: {row.revenueDates.length ? row.revenueDates.map(dateText).join(", ") : "—"}</p></td>
            <td className="max-w-sm px-3 py-3"><b className="break-all">{row.transactionCode}</b><p className="mt-1 text-xs text-slate-500">{row.bankAccount}</p><p className="mt-1 line-clamp-3 text-xs">{row.description}</p>{row.allocations.length > 1 && <span className="mt-1 inline-block rounded bg-indigo-50 px-2 py-0.5 text-xs font-bold text-indigo-700">{row.allocations.length} dòng phân bổ</span>}</td>
            <td className="px-3 py-3 text-right font-bold text-rose-700">{row.debitAmount ? `${money(row.debitAmount)} đ` : "—"}</td>
            <td className="px-3 py-3 text-right font-bold text-emerald-700">{row.creditAmount ? `${money(row.creditAmount)} đ` : "—"}</td>
            <td className="px-3 py-3">{row.branchCode || "—"}</td>
            <td className="px-3 py-3"><b>{operationLabels[row.operationType || ""] || row.operationType || "Dữ liệu cũ"}</b><p className="text-xs text-slate-500">{row.categoryCode || "—"}</p></td>
            <td className="px-3 py-3 text-xs"><p className="text-emerald-700">+ {row.increaseMoneySourceCode || "—"}</p><p className="text-rose-700">− {row.decreaseMoneySourceCode || "—"}</p></td>
            <td className="px-3 py-3 text-xs"><p>{row.partnerCode || "—"}</p><p className="text-slate-500">P&amp;L: {row.pnlItemCode || "—"}</p></td>
            <td className="px-3 py-3">{row.currentMatch ? <a href={row.currentMatch.targetHref || "/bank-vouchers"} className="font-bold text-blue-700 hover:underline">{row.currentMatch.targetCode}</a> : <span className="text-xs text-slate-400">Dữ liệu lịch sử chưa liên kết</span>}</td>
            <td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${row.reconcileStatus === "MATCHED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{row.reconcileStatus === "MATCHED" ? "ĐÃ GHI NHẬN" : "DỮ LIỆU CŨ"}</span></td>
          </tr>)}</tbody>
        </table></div>
        <div className="flex items-center justify-between border-t border-slate-200 p-4 text-sm"><span>Trang {page}/{totalPages} · {total} giao dịch</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-3 py-1.5 disabled:opacity-40">Trang trước</button><button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border px-3 py-1.5 disabled:opacity-40">Trang sau</button></div></div>
      </section>
    </main>
  </div>;
}
