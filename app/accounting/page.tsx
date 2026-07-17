"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MonthInput, DateInput } from "@/components/DateInput";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type Account = { id: string; code: string; name: string; accountType: string; reportGroup: string };
type Line = { id: string; debit: number; credit: number; departmentCode: string | null; account: Account };
type Entry = { id: string; code: string; entryDate: string; branchCode: string; sourceType: string; sourceCode: string | null; description: string; lines: Line[] };
type Data = { accounts: Account[]; entries: Entry[]; totals: { debit: number; credit: number; difference: number } };

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

export default function AccountingPage() {
  const router = useRouter();
  const href = "/accounting";
  const { user, loading } = useModuleAuth(href);
  
  const [active, setActive] = useState("ledger");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [branchCode, setBranchCode] = useState("ALL");
  const [data, setData] = useState<Data>({ accounts: [], entries: [], totals: { debit: 0, credit: 0, difference: 0 } });
  const [message, setMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  
  const [manual, setManual] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    branchCode: "HCM",
    description: "Bút toán điều chỉnh",
    debitAccount: "6428",
    creditAccount: "1121",
    amount: "1000000",
  });

  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canSync = user ? canPerformMenuAction(user.role, href, "config") : false;

  const loadData = useCallback(async () => {
    const response = await fetch(`/api/accounting?period=${period}&branchCode=${branchCode}`);
    if (response.ok) {
      setData((await response.json()) as Data);
    }
  }, [branchCode, period]);

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => void loadData(), 0);
    }
  }, [loading, loadData]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setMessage("");
    try {
      const response = await fetch("/api/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SYNC_PERIOD", period, branchCode }),
      });
      const payload = await response.json();
      if (response.ok) {
        setMessage("Đã đồng bộ thành công dữ liệu nguồn vào sổ cái.");
        await loadData();
      } else {
        setMessage(payload.error || "Không đồng bộ được dữ liệu.");
      }
    } catch {
      setMessage("Lỗi kết nối máy chủ.");
    } finally {
      setSyncing(false);
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/accounting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CREATE_MANUAL",
          entryDate: manual.entryDate,
          branchCode: manual.branchCode,
          description: manual.description,
          lines: [
            { accountCode: manual.debitAccount, debit: toNumber(manual.amount) },
            { accountCode: manual.creditAccount, credit: toNumber(manual.amount) },
          ],
        }),
      });
      const payload = await response.json();
      if (response.ok) {
        setMessage("Đã ghi thành công bút toán điều chỉnh.");
        setManual((prev) => ({ ...prev, amount: "1000000", description: "Bút toán điều chỉnh" }));
        await loadData();
      } else {
        setMessage(payload.error || "Không ghi được bút toán.");
      }
    } catch {
      setMessage("Lỗi kết nối máy chủ.");
    } finally {
      setSubmitting(false);
    }
  };

  const toNumber = (val: string) => {
    const parsed = parseFloat(val);
    return isNaN(parsed) ? 0 : parsed;
  };

  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">Đang tải...</p>
        </div>
      </div>
    );
  }

  // Get dynamic source badge styling
  const getSourceBadgeClass = (sourceType: string) => {
    switch (sourceType) {
      case "BANK_STATEMENT":
        return "bg-blue-50 text-blue-700 border border-blue-100";
      case "REVENUE_POS":
        return "bg-emerald-50 text-emerald-700 border border-emerald-100";
      case "VOUCHER":
        return "bg-amber-50 text-amber-700 border border-amber-100";
      case "MANUAL":
        return "bg-purple-50 text-purple-700 border border-purple-100";
      case "DEPOSIT":
        return "bg-orange-50 text-orange-700 border border-orange-100";
      default:
        return "bg-slate-50 text-slate-700 border border-slate-100";
    }
  };

  const getAccountTypeBadge = (type: string) => {
    switch (type) {
      case "ASSET":
        return "bg-emerald-50 text-emerald-700 border border-emerald-100";
      case "LIABILITY":
        return "bg-rose-50 text-rose-700 border border-rose-100";
      case "EQUITY":
        return "bg-indigo-50 text-indigo-700 border border-indigo-100";
      case "REVENUE":
        return "bg-teal-50 text-teal-700 border border-teal-100";
      case "EXPENSE":
        return "bg-orange-50 text-orange-700 border border-orange-100";
      default:
        return "bg-slate-50 text-slate-700 border border-slate-100";
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#f8fafc] via-[#f1f5f9] to-[#e2e8f0] text-slate-800 antialiased pb-12">
      {/* Premium Header */}
      <header className="sticky top-0 z-30 backdrop-blur-md bg-white/80 border-b border-slate-200/60 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <button
            type="button"
            title="Quay lại Dashboard"
            onClick={() => router.push("/")}
            className="h-10 w-10 shrink-0 rounded-xl bg-slate-100 hover:bg-slate-200 grid place-items-center active:scale-95 transition-all shadow-sm"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
          </button>
          <div>
            <h1 className="text-xl font-bold bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 bg-clip-text text-transparent">
              Sổ cái Kế toán
            </h1>
            <p className="text-xs text-slate-500 font-medium">
              Phân hệ Giai đoạn 4 • Hệ thống bút toán Nợ/Có và Đồng bộ dữ liệu lõi
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-100 font-semibold px-2.5 py-1 rounded-full shadow-sm">
            {user?.role}
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 mt-8 space-y-6">
        {/* Modern Filter Card */}
        <section className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-bold text-slate-600">Kỳ kế toán</span>
              <MonthInput className="w-44" value={period} onChange={setPeriod} ariaLabel="Kỳ kế toán" />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-bold text-slate-600">Chi nhánh</span>
              <div className="relative">
                <select
                  value={branchCode}
                  onChange={(e) => setBranchCode(e.target.value)}
                  className="w-48 pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer font-medium"
                >
                  <option value="ALL">Tất cả chi nhánh</option>
                  <option value="HCM">Chi nhánh HCM</option>
                  <option value="HN">Chi nhánh Hà Nội</option>
                </select>
                <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-lg">
                  unfold_more
                </span>
              </div>
            </div>
          </div>

          {canSync && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-700 hover:to-blue-700 active:from-indigo-800 text-white px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-md hover:shadow-lg active:scale-98 transition-all disabled:opacity-50 group"
            >
              <span className={`material-symbols-outlined text-lg ${syncing ? "animate-spin" : "group-hover:rotate-180 transition-transform duration-500"}`}>
                sync
              </span>
              {syncing ? "Đang đồng bộ..." : "Đồng bộ ghi sổ"}
            </button>
          )}
        </section>

        {/* Tab Navigation */}
        <nav className="flex gap-1.5 border-b border-slate-200 overflow-x-auto">
          {[
            { id: "ledger", label: "Nhật ký chung", icon: "receipt_long" },
            { id: "manual", label: "Bút toán tay", icon: "edit_note" },
            { id: "accounts", label: "Hệ thống tài khoản", icon: "account_tree" },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActive(tab.id);
                setMessage("");
              }}
              className={`px-5 py-3 text-sm font-bold whitespace-nowrap border-b-2 flex items-center gap-2 transition-all duration-150 ${
                active === tab.id
                  ? "border-indigo-600 text-indigo-700"
                  : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300"
              }`}
            >
              <span className="material-symbols-outlined text-lg">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>

        {/* Notification Banner */}
        {message && (
          <div className="px-5 py-4 rounded-xl border border-indigo-100 bg-indigo-50/50 backdrop-blur-sm text-sm text-indigo-800 font-medium flex items-center gap-2 animate-fadeIn shadow-sm">
            <span className="material-symbols-outlined text-indigo-600">info</span>
            {message}
          </div>
        )}

        {/* TAB 1: General Journal */}
        {active === "ledger" && (
          <div className="space-y-6">
            {/* KPI Metrics */}
            <div className="grid sm:grid-cols-3 gap-6">
              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tổng phát sinh Nợ</p>
                  <p className="text-2xl font-black text-indigo-900">{money(data.totals.debit)} đ</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">arrow_downward</span>
                </div>
              </div>

              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tổng phát sinh Có</p>
                  <p className="text-2xl font-black text-emerald-800">{money(data.totals.credit)} đ</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">arrow_upward</span>
                </div>
              </div>

              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Trạng thái cân đối</p>
                  {Math.abs(data.totals.difference) <= 0.01 ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="text-xs font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                        Cân đối (Balanced)
                      </span>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1 mt-1">
                      <span className="text-xs font-bold bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full w-fit">
                        Lệch: {money(data.totals.difference)} đ
                      </span>
                    </div>
                  )}
                </div>
                {Math.abs(data.totals.difference) <= 0.01 ? (
                  <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm">
                    <span className="material-symbols-outlined text-2xl font-bold">task_alt</span>
                  </div>
                ) : (
                  <div className="w-12 h-12 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shadow-sm animate-pulse">
                    <span className="material-symbols-outlined text-2xl font-bold">warning</span>
                  </div>
                )}
              </div>
            </div>

            {/* General Ledger Table Card */}
            <section className="bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-slate-900">Sổ Nhật ký chung</h3>
                  <p className="text-xs text-slate-500 mt-1">Liệt kê tất cả bút toán kép được đồng bộ hoặc tạo thủ công trong kỳ.</p>
                </div>
                <button
                  onClick={loadData}
                  className="h-9 px-3 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold flex items-center gap-1.5 transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">refresh</span>
                  Tải lại
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50/80 backdrop-blur-sm text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                    <tr>
                      <th className="px-5 py-3.5 text-left">Ngày</th>
                      <th className="px-5 py-3.5 text-left">Bút toán</th>
                      <th className="px-5 py-3.5 text-left">Nguồn dữ liệu</th>
                      <th className="px-5 py-3.5 text-left">Diễn giải</th>
                      <th className="px-5 py-3.5 text-left">Tài khoản hạch toán</th>
                      <th className="px-5 py-3.5 text-right">Phát sinh Nợ</th>
                      <th className="px-5 py-3.5 text-right">Phát sinh Có</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.entries.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-12 text-center text-slate-400 font-medium">
                          Chưa có phát sinh kế toán trong kỳ. Nhấp &quot;Đồng bộ ghi sổ&quot; hoặc tạo bút toán tay.
                        </td>
                      </tr>
                    ) : (
                      data.entries.flatMap((entry) =>
                        entry.lines.map((line, index) => (
                          <tr key={line.id} className="hover:bg-slate-50/40 transition-colors">
                            <td className="px-5 py-4 whitespace-nowrap text-slate-500 text-xs font-medium align-top">
                              {index === 0 ? new Date(entry.entryDate).toLocaleDateString("vi-VN") : ""}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-xs font-bold text-slate-800 align-top">
                              {index === 0 && (
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-semibold">{entry.code}</span>
                                  <span className="text-[10px] text-slate-400 font-semibold">{entry.branchCode}</span>
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-xs align-top">
                              {index === 0 && (
                                <div className="flex flex-col gap-0.5">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${getSourceBadgeClass(entry.sourceType)}`}>
                                    {entry.sourceType}
                                  </span>
                                  {entry.sourceCode && (
                                    <span className="text-[10px] text-slate-400 font-semibold">{entry.sourceCode}</span>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-4 text-xs font-medium text-slate-700 max-w-xs truncate align-top">
                              {index === 0 ? entry.description : ""}
                            </td>
                            <td className="px-5 py-4 text-xs text-slate-700 align-top">
                              <div className="flex flex-col gap-0.5">
                                <div>
                                  <span className="font-bold text-indigo-950 bg-indigo-50/40 border border-indigo-100/30 px-1.5 py-0.5 rounded text-[11px] mr-1.5">
                                    {line.account.code}
                                  </span>
                                  <span className="font-medium text-slate-800">{line.account.name}</span>
                                </div>
                                {line.departmentCode && (
                                  <span className="text-[10px] text-slate-400 font-semibold">Phòng: {line.departmentCode}</span>
                                )}
                              </div>
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-right text-xs font-semibold text-slate-900 align-top">
                              {line.debit > 0 ? `${money(line.debit)} đ` : <span className="text-slate-300">-</span>}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-right text-xs font-semibold text-slate-900 align-top">
                              {line.credit > 0 ? `${money(line.credit)} đ` : <span className="text-slate-300">-</span>}
                            </td>
                          </tr>
                        ))
                      )
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: Manual Adjustment */}
        {active === "manual" && (
          <div className="max-w-2xl mx-auto">
            {canCreate ? (
              <form
                onSubmit={handleManualSubmit}
                className="bg-white border border-slate-200 rounded-2xl shadow-xl p-6 space-y-5"
              >
                <div>
                  <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase tracking-wider">
                    Ghi sổ thủ công (Adjustment)
                  </span>
                  <h2 className="font-bold text-lg text-slate-900 mt-2">Tạo bút toán tay điều chỉnh</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Hệ thống sẽ tự động hạch toán kép đối xứng cân bằng Nợ/Có.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Ngày bút toán</span>
                    <DateInput className="w-full" value={manual.entryDate} onChange={(d) => setManual({ ...manual, entryDate: d })} ariaLabel="Ngày bút toán" />
                  </div>
                  
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Chi nhánh</span>
                    <div className="relative">
                      <select
                        value={manual.branchCode}
                        onChange={(e) => setManual({ ...manual, branchCode: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer"
                      >
                        <option value="HCM">CN Hồ Chí Minh</option>
                        <option value="HN">CN Hà Nội</option>
                      </select>
                      <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-lg">
                        unfold_more
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold text-slate-600">Diễn giải nội dung</span>
                  <input
                    className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all"
                    value={manual.description}
                    onChange={(e) => setManual({ ...manual, description: e.target.value })}
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Tài khoản ghi NỢ (Debit)</span>
                    <div className="relative">
                      <select
                        value={manual.debitAccount}
                        onChange={(e) => setManual({ ...manual, debitAccount: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer"
                      >
                        {data.accounts.map((acc) => (
                          <option key={acc.id} value={acc.code}>
                            {acc.code} — {acc.name}
                          </option>
                        ))}
                      </select>
                      <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-lg">
                        unfold_more
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Tài khoản ghi CÓ (Credit)</span>
                    <div className="relative">
                      <select
                        value={manual.creditAccount}
                        onChange={(e) => setManual({ ...manual, creditAccount: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer"
                      >
                        {data.accounts.map((acc) => (
                          <option key={acc.id} value={acc.code}>
                            {acc.code} — {acc.name}
                          </option>
                        ))}
                      </select>
                      <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-lg">
                        unfold_more
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold text-slate-600">Số tiền hạch toán (đ)</span>
                  <input
                    type="number"
                    min="1"
                    className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all font-bold"
                    value={manual.amount}
                    onChange={(e) => setManual({ ...manual, amount: e.target.value })}
                    required
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white rounded-xl py-3 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-98 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-lg">save</span>
                  {submitting ? "Đang lưu..." : "Ghi sổ bút toán"}
                </button>
              </form>
            ) : (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-500">
                <span className="material-symbols-outlined text-4xl text-slate-300 mb-2">lock</span>
                <p className="text-sm font-medium">Bạn chỉ có quyền xem, không được hạch toán bút toán thủ công.</p>
              </div>
            )}
          </div>
        )}

        {/* TAB 3: Chart of Accounts */}
        {active === "accounts" && (
          <section className="bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">Hệ thống Tài khoản Kế toán</h3>
              <p className="text-xs text-slate-500 mt-1">Danh mục tài khoản kế toán áp dụng cho hệ thống ERP nội bộ.</p>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50/80 backdrop-blur-sm text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                  <tr>
                    <th className="px-6 py-4">Mã tài khoản</th>
                    <th className="px-6 py-4">Tên tài khoản</th>
                    <th className="px-6 py-4">Loại tài khoản</th>
                    <th className="px-6 py-4">Nhóm báo cáo tài chính</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.accounts.map((account) => (
                    <tr key={account.id} className="hover:bg-slate-50/40 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-black text-indigo-950">
                        {account.code}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-slate-700">
                        {account.name}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-xs">
                        <span className={`px-2 py-0.5 rounded font-bold ${getAccountTypeBadge(account.accountType)}`}>
                          {account.accountType}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-500">
                        {account.reportGroup}
                      </td>
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
