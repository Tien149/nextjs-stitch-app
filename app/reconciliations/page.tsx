"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type Candidate = {
  targetType: string;
  targetId: string;
  targetCode: string;
  targetDate: string;
  targetAmount: number;
  label: string;
  score: number;
};

type BankRow = {
  id: string;
  transactionDate: string;
  bankAccount: string;
  transactionCode: string;
  description: string;
  debitAmount: number;
  creditAmount: number;
  partnerHint: string | null;
  reconcileStatus: string;
  candidates: Candidate[];
};

type MatchRow = {
  id: string;
  targetType: string;
  targetCode: string;
  matchedAmount: number;
  matchedBy: string | null;
  createdAt: string;
};

export default function ReconciliationsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [status, setStatus] = useState("UNMATCHED");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/reconciliations");
    if (!raw) {
      router.push("/login?next=/reconciliations");
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

  const canMatch = user ? canPerformAction(user.role, "edit") : false;
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);

  const loadRows = async () => {
    const response = await fetch(`/api/reconciliations?status=${status}`);
    if (response.ok) {
      const payload = await response.json();
      setRows(payload.rows as BankRow[]);
      setMatches(payload.matches as MatchRow[]);
    }
  };

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadRows();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, status]);

  const matchCandidate = async (bank: BankRow, candidate: Candidate) => {
    setMessage("");
    const response = await fetch("/api/reconciliations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankTransactionId: bank.id,
        targetType: candidate.targetType,
        targetId: candidate.targetId,
        targetCode: candidate.targetCode,
        targetDate: candidate.targetDate,
        targetAmount: candidate.targetAmount,
        note: `Auto suggested score ${candidate.score}`,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không đối soát được giao dịch");
      return;
    }
    setMessage("Đã đối soát giao dịch.");
    await loadRows();
  };

  if (loading) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/")} className="h-9 w-9 rounded-lg bg-slate-100 hover:bg-slate-200 flex items-center justify-center">
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold">Đối soát Sao kê</h1>
            <p className="text-xs text-slate-500">GĐ2: match sao kê với doanh thu POS, tiền cọc và phiếu thu/chi.</p>
          </div>
        </div>
        <p className="text-xs font-bold text-slate-500">{user?.role}</p>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <section className="grid md:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Giao dịch đang xem</p>
            <p className="text-2xl font-bold">{rows.length}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Match gần đây</p>
            <p className="text-2xl font-bold text-emerald-700">{matches.length}</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <p className="text-xs text-slate-500">Quyền thao tác</p>
            <p className="text-2xl font-bold">{canMatch ? "Có" : "Chỉ xem"}</p>
          </div>
        </section>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">Danh sách sao kê cần đối soát</h2>
              <p className="text-xs text-slate-500 mt-1">Gợi ý dựa trên số tiền, ngày giao dịch và mã đối tác nếu có.</p>
            </div>
            <div className="flex items-center gap-2">
              <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 outline-none">
                <option value="UNMATCHED">Chưa match</option>
                <option value="MATCHED">Đã match</option>
                <option value="ALL">Tất cả</option>
              </select>
              <button onClick={loadRows} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tải lại</button>
            </div>
          </div>
          {message && <div className="mx-5 mt-4 rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2 text-sm">{message}</div>}
          
          <div className="overflow-x-auto">
            <Table
              headers={[
                { label: "Sao kê" },
                { label: "Số tiền", align: "right" },
                { label: "Gợi ý match" },
                { label: "Thao tác", align: "right" },
              ]}
            >
              {rows.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-slate-400">Không có giao dịch.</td></tr>
              ) : rows.map((row) => {
                const first = row.candidates[0];
                return (
                  <tr key={row.id} className="hover:bg-slate-50 align-top border-t border-slate-100">
                    <td className="px-4 py-3">
                      <b>{row.transactionCode}</b>
                      <p className="text-xs text-slate-500">{new Date(row.transactionDate).toLocaleDateString("vi-VN")} · {row.bankAccount}</p>
                      <p className="text-xs text-slate-500 mt-1 max-w-md">{row.description}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-slate-900">{money(row.creditAmount || row.debitAmount)} đ</td>
                    <td className="px-4 py-3">
                      {first ? (
                        <div>
                          <p className="font-bold">{first.targetCode} · {first.targetType}</p>
                          <p className="text-xs text-slate-500">{first.label}</p>
                          <p className="text-xs text-emerald-700 mt-1">Score {first.score} · {money(first.targetAmount)} đ</p>
                        </div>
                      ) : (
                        <span className="text-xs text-amber-700">Chưa có gợi ý đủ khớp</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canMatch && first && row.reconcileStatus !== "MATCHED" ? (
                        <button onClick={() => matchCandidate(row, first)} className="text-xs font-bold text-blue-700 hover:underline">Match</button>
                      ) : (
                        <span className="text-xs text-slate-400 font-semibold">{row.reconcileStatus}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>
        </section>
      </main>
    </div>
  );
}

function Table({ headers, children }: { headers: { label: string; align?: "left" | "right" }[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-200">
        <tr>
          {headers.map((header, i) => (
            <th
              key={i}
              className={`px-4 py-3 font-bold ${header.align === "right" ? "text-right" : "text-left"}`}
            >
              {header.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
