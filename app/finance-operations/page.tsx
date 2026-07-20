"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput, MonthInput } from "@/components/DateInput";
import { branchScopeOptions, storeLabel, storeOptions } from "@/lib/branch-labels";
import { canPerformMenuAction } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";

type CashEntry = { id: string; date: string; code: string; type: string; moneySourceCode: string; description: string; receipt: number; payment: number; balance: number };
type Schedule = { id: string; period: string; amount: number; status: string };
type Accrual = { id: string; code: string; name: string; branchCode: string; categoryCode: string; totalAmount: number; startPeriod: string; numberOfPeriods: number; status: string; schedules: Schedule[] };
type Check = { key: string; label: string; passed: boolean; count: number };
type MoneyTransfer = { id: string; code: string; transferDate: string; fromMoneySourceCode: string; toMoneySourceCode: string; amount: number; description: string; status: string };
type Data = { openingAmount: number; closingBalance: number; cashbook: CashEntry[]; accruals: Accrual[]; moneyTransfers: MoneyTransfer[]; accountingPeriod: { status: string; closedBy?: string; closedAt?: string }; checklist: Check[] };

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);

export default function FinanceOperationsPage() {
  const router = useRouter();
  const href = "/finance-operations";
  const { user, loading } = useModuleAuth(href);
  
  const [active, setActive] = useState("cashbook");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [branchCode, setBranchCode] = useState("ALL");
  const [data, setData] = useState<Data>({ openingAmount: 0, closingBalance: 0, cashbook: [], accruals: [], moneyTransfers: [], accountingPeriod: { status: "OPEN" }, checklist: [] });
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  
  const [adjustment, setAdjustment] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    entryType: "RECEIPT",
    branchCode: "HCM",
    moneySourceCode: "CASH_HCM",
    amount: "1000000",
    description: "Điều chỉnh kiểm kê quỹ",
  });
  
  const [accrual, setAccrual] = useState({
    name: "Chi phí trả trước",
    branchCode: "HCM",
    categoryCode: "OPEX",
    totalAmount: "12000000",
    startPeriod: new Date().toISOString().slice(0, 7),
    numberOfPeriods: "12",
    note: "",
  });

  const canCreate = user ? canPerformMenuAction(user.role, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user.role, href, "edit") : false;
  const canClose = user?.role === "Admin";
  const canApproveTransfer = user?.role === "Admin";

  const loadData = useCallback(async () => {
    const response = await fetch(`/api/finance-operations?period=${period}&branchCode=${branchCode}`);
    if (response.ok) setData((await response.json()) as Data);
  }, [branchCode, period]);

  useEffect(() => {
    if (!loading) window.setTimeout(() => void loadData(), 0);
  }, [loading, loadData]);

  const send = async (body: object, success: string) => {
    if (submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (response.ok) {
        setMessage(success);
        setAdjustment({
          entryDate: new Date().toISOString().slice(0, 10),
          entryType: "RECEIPT",
          branchCode: "HCM",
          moneySourceCode: "CASH_HCM",
          amount: "1000000",
          description: "Điều chỉnh kiểm kê quỹ",
        });
        await loadData();
      } else {
        setMessage(payload.error || "Không thực hiện được thao tác");
      }
    } catch {
      setMessage("Lỗi kết nối máy chủ.");
    } finally {
      setSubmitting(false);
    }
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
              Sổ quỹ & Cuối kỳ
            </h1>
            <p className="text-xs text-slate-500 font-medium">
              Phân hệ Giai đoạn 3 • Quản lý dòng tiền Sổ quỹ, trích trước chi phí và khóa sổ kỳ kế toán
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
              <MonthInput className="w-44" value={period} onChange={setPeriod} ariaLabel="Kỳ sổ quỹ" />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-bold text-slate-600">Phạm vi cửa hàng</span>
              <div className="relative">
                <select
                  value={branchCode}
                  onChange={(e) => setBranchCode(e.target.value)}
                  className="w-48 pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer font-medium"
                >
                  {branchScopeOptions.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none text-lg">
                  unfold_more
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => void loadData()}
              className="h-10 px-3 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold flex items-center gap-1.5 transition-colors bg-white shadow-sm"
              title="Tải lại"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              Tải lại
            </button>

            <span className={`px-4 py-2 rounded-xl text-xs font-bold border flex items-center gap-1.5 shadow-sm ${
              data.accountingPeriod.status === "CLOSED"
                ? "bg-rose-50 text-rose-700 border-rose-100"
                : "bg-emerald-50 text-emerald-700 border-emerald-100"
            }`}>
              <span className="material-symbols-outlined text-base">
                {data.accountingPeriod.status === "CLOSED" ? "lock" : "lock_open"}
              </span>
              {data.accountingPeriod.status === "CLOSED" ? "KỲ ĐÃ KHÓA" : "KỲ ĐANG MỞ"}
            </span>
          </div>
        </section>

        {/* Tab Navigation */}
        <nav className="flex gap-1.5 border-b border-slate-200 overflow-x-auto">
          {[
            { id: "cashbook", label: "Sổ quỹ dòng tiền", icon: "account_balance_wallet" },
            { id: "accruals", label: "Trích trước & Phân bổ", icon: "calendar_month" },
            { id: "closing", label: "Khóa sổ kỳ kế toán", icon: "lock" },
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

        {/* TAB 1: Cashbook */}
        {active === "cashbook" && (
          <div className="space-y-6">
            {/* KPI Metrics */}
            <div className="grid sm:grid-cols-3 gap-6">
              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Số dư đầu kỳ</p>
                  <p className="text-2xl font-black text-slate-800">{money(data.openingAmount)} đ</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-slate-50 text-slate-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">payments</span>
                </div>
              </div>

              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tổng phát sinh Thu</p>
                  <p className="text-2xl font-black text-emerald-800">
                    +{money(data.cashbook.reduce((sum, row) => sum + row.receipt, 0))} đ
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">arrow_downward</span>
                </div>
              </div>

              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Số dư cuối kỳ</p>
                  <p className="text-2xl font-black text-indigo-900">{money(data.closingBalance)} đ</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">account_balance_wallet</span>
                </div>
              </div>
            </div>

            {data.moneyTransfers.some((transfer) => transfer.status === "PENDING_REVIEW") && (
              <section className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-amber-100 bg-amber-50 px-5 py-3">
                  <div>
                    <h3 className="text-sm font-bold text-amber-900">Điều tiền chờ duyệt</h3>
                    <p className="mt-0.5 text-xs text-amber-700">Dữ liệu import chỉ vào sổ quỹ sau khi Admin duyệt.</p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-amber-800">
                    {data.moneyTransfers.filter((transfer) => transfer.status === "PENDING_REVIEW").length}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr><th className="px-4 py-3">Ngày / Mã</th><th className="px-4 py-3">Từ nguồn</th><th className="px-4 py-3">Đến nguồn</th><th className="px-4 py-3 text-right">Số tiền</th><th className="px-4 py-3 text-right">Thao tác</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.moneyTransfers.filter((transfer) => transfer.status === "PENDING_REVIEW").map((transfer) => (
                        <tr key={transfer.id}>
                          <td className="px-4 py-3"><b>{transfer.code}</b><p className="text-slate-500">{new Date(transfer.transferDate).toLocaleDateString("vi-VN")}</p></td>
                          <td className="px-4 py-3">{transfer.fromMoneySourceCode}</td>
                          <td className="px-4 py-3">{transfer.toMoneySourceCode}</td>
                          <td className="px-4 py-3 text-right font-bold">{money(transfer.amount)} đ</td>
                          <td className="px-4 py-3 text-right">
                            {canApproveTransfer ? (
                              <button type="button" onClick={() => void send({ action: "APPROVE_TRANSFER", id: transfer.id }, "Đã duyệt giao dịch điều tiền.")} className="rounded-lg bg-emerald-600 px-3 py-2 font-bold text-white hover:bg-emerald-700">Duyệt</button>
                            ) : <span className="text-slate-400">Chờ Admin</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Content Split: Form & Table */}
            <div className="grid xl:grid-cols-[380px_1fr] gap-6 items-start">
              {canCreate && data.accountingPeriod.status !== "CLOSED" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send({ action: "CREATE_ADJUSTMENT", ...adjustment }, "Đã ghi nhận điều chỉnh sổ quỹ.");
                  }}
                  className="bg-white border border-slate-200 rounded-2xl shadow-lg p-6 space-y-5"
                >
                  <div>
                    <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase tracking-wider">
                      Khớp số dư thực tế
                    </span>
                    <h2 className="font-bold text-base text-slate-900 mt-2">Điều chỉnh quỹ</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Ghi nhận chênh lệch kiểm kê quỹ tiền mặt hoặc số dư tài khoản.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-bold text-slate-600">Ngày điều chỉnh</span>
                      <DateInput className="w-full" value={adjustment.entryDate} onChange={(d) => setAdjustment({ ...adjustment, entryDate: d })} ariaLabel="Ngày điều chỉnh quỹ" />
                    </div>
                    
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-bold text-slate-600">Loại điều chỉnh</span>
                      <select
                        value={adjustment.entryType}
                        onChange={(e) => setAdjustment({ ...adjustment, entryType: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer"
                      >
                        <option value="RECEIPT">Thu (Tăng tiền)</option>
                        <option value="PAYMENT">Chi (Giảm tiền)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-bold text-slate-600">Cửa hàng</span>
                      <select
                        value={adjustment.branchCode}
                        onChange={(e) => setAdjustment({ ...adjustment, branchCode: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer"
                      >
                        {storeOptions.map((option) => (
                          <option key={option.code} value={option.code}>
                            {storeLabel(option.code)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-bold text-slate-600">Nguồn tiền</span>
                      <select
                        value={adjustment.moneySourceCode}
                        onChange={(e) => setAdjustment({ ...adjustment, moneySourceCode: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer"
                      >
                        <option value="CASH_HCM">Tiền mặt Cửa hàng 1</option>
                        <option value="CASH_HN">Tiền mặt Cửa hàng 2</option>
                        <option value="VCB_HCM">Vietcombank Cửa hàng 1</option>
                        <option value="VCB_HN">Vietcombank Cửa hàng 2</option>
                        <option value="MOMO_POS">Momo POS</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Số tiền (đ)</span>
                    <input
                      type="number"
                      min="1"
                      className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all font-bold"
                      value={adjustment.amount}
                      onChange={(e) => setAdjustment({ ...adjustment, amount: e.target.value })}
                      required
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Diễn giải lý do</span>
                    <textarea
                      className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg h-20 resize-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all"
                      value={adjustment.description}
                      onChange={(e) => setAdjustment({ ...adjustment, description: e.target.value })}
                      required
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white rounded-xl py-3 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-98"
                  >
                    {submitting ? "Đang ghi nhận..." : "Ghi nhận điều chỉnh"}
                  </button>
                </form>
              ) : (
                <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-500 shadow-sm">
                  <span className="material-symbols-outlined text-4xl text-slate-300 mb-2">lock</span>
                  <p className="text-sm font-medium">Kỳ kế toán đã khóa hoặc tài khoản không có quyền điều chỉnh quỹ.</p>
                </div>
              )}

              {/* Cashbook Table */}
              <section className="bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
                <div className="px-6 py-5 border-b border-slate-200">
                  <h3 className="font-bold text-slate-900">Phát sinh dòng tiền trong kỳ</h3>
                  <p className="text-xs text-slate-500 mt-1">Danh sách thu/chi và biến động số dư thực tế theo nguồn quỹ.</p>
                </div>
                
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50/80 backdrop-blur-sm text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                      <tr>
                        <th className="px-5 py-3.5 text-left">Ngày</th>
                        <th className="px-5 py-3.5 text-left">Chứng từ/Nguồn</th>
                        <th className="px-5 py-3.5 text-left">Diễn giải</th>
                        <th className="px-5 py-3.5 text-right">Phát sinh Thu</th>
                        <th className="px-5 py-3.5 text-right">Phát sinh Chi</th>
                        <th className="px-5 py-3.5 text-right">Số dư quỹ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.cashbook.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-5 py-12 text-center text-slate-400 font-medium">
                            Chưa có phát sinh dòng tiền nào trong kỳ này.
                          </td>
                        </tr>
                      ) : (
                        data.cashbook.map((row) => (
                          <tr key={`${row.type}-${row.id}`} className="hover:bg-slate-50/40 transition-colors">
                            <td className="px-5 py-4 whitespace-nowrap text-slate-500 text-xs font-medium">
                              {new Date(row.date).toLocaleDateString("vi-VN")}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-xs font-bold text-slate-800">
                              <div className="flex flex-col gap-0.5">
                                <span>{row.code}</span>
                                <span className="text-[10px] text-slate-400 font-semibold">{row.moneySourceCode}</span>
                              </div>
                            </td>
                            <td className="px-5 py-4 text-xs font-medium text-slate-700 max-w-xs truncate">
                              {row.description}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-right text-xs font-semibold text-emerald-700">
                              {row.receipt > 0 ? `+${money(row.receipt)} đ` : <span className="text-slate-300">-</span>}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-right text-xs font-semibold text-rose-700">
                              {row.payment > 0 ? `-${money(row.payment)} đ` : <span className="text-slate-300">-</span>}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-right text-xs font-bold text-slate-900">
                              {money(row.balance)} đ
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </div>
        )}

        {/* TAB 2: Accruals */}
        {active === "accruals" && (
          <div className="grid xl:grid-cols-[380px_1fr] gap-6 items-start">
            {canCreate ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({ action: "CREATE_ACCRUAL", ...accrual }, "Đã tạo lịch phân bổ chi phí.");
                }}
                className="bg-white border border-slate-200 rounded-2xl shadow-lg p-6 space-y-5"
              >
                <div>
                  <span className="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase tracking-wider">
                    Phân bổ nhiều kỳ (Prepaid Expense)
                  </span>
                  <h2 className="font-bold text-base text-slate-900 mt-2">Tạo khoản phân bổ</h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Khai báo chi phí trả trước (thuê nhà, bảo hiểm...) cần trích trước phân bổ hàng tháng.
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold text-slate-600">Tên khoản phân bổ *</span>
                  <input
                    type="text"
                    className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all"
                    value={accrual.name}
                    onChange={(e) => setAccrual({ ...accrual, name: e.target.value })}
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Cửa hàng</span>
                    <select
                      value={accrual.branchCode}
                      onChange={(e) => setAccrual({ ...accrual, branchCode: e.target.value })}
                      className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer"
                    >
                      {storeOptions.map((option) => (
                        <option key={option.code} value={option.code}>
                          {storeLabel(option.code)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Nhóm chi phí</span>
                    <select
                      value={accrual.categoryCode}
                      onChange={(e) => setAccrual({ ...accrual, categoryCode: e.target.value })}
                      className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer"
                    >
                      <option value="OPEX">OPEX (Vận hành)</option>
                      <option value="CAPEX">CAPEX (Đầu tư)</option>
                      <option value="COGS">COGS (Giá vốn)</option>
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold text-slate-600">Tổng giá trị phân bổ (đ) *</span>
                  <input
                    type="number"
                    min="1"
                    className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all font-bold"
                    value={accrual.totalAmount}
                    onChange={(e) => setAccrual({ ...accrual, totalAmount: e.target.value })}
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Từ kỳ kế toán</span>
                    <MonthInput className="w-full" value={accrual.startPeriod} onChange={(startPeriod) => setAccrual({ ...accrual, startPeriod })} ariaLabel="Kỳ bắt đầu phân bổ" />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold text-slate-600">Số kỳ phân bổ</span>
                    <input
                      type="number"
                      min="1"
                      className="w-full pl-3 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all"
                      value={accrual.numberOfPeriods}
                      onChange={(e) => setAccrual({ ...accrual, numberOfPeriods: e.target.value })}
                      required
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-700 hover:to-indigo-800 text-white rounded-xl py-3 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-98"
                >
                  {submitting ? "Đang lưu..." : "Tạo lịch phân bổ"}
                </button>
              </form>
            ) : (
              <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-500 shadow-sm">
                <span className="material-symbols-outlined text-4xl text-slate-300 mb-2">lock</span>
                <p className="text-sm font-medium">Tài khoản của bạn không có quyền lập lịch trích trước phân bổ.</p>
              </div>
            )}

            {/* Accruals List */}
            <section className="space-y-6">
              {data.accruals.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-slate-400 font-medium shadow-sm">
                  Chưa có khoản phân bổ chi phí trích trước nào được tạo.
                </div>
              ) : (
                data.accruals.map((row) => (
                  <div key={row.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-lg shadow-slate-100/50">
                    <div className="px-6 py-4 border-b border-slate-200 bg-slate-50/50 flex justify-between items-center gap-3">
                      <div>
                        <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full uppercase">
                          {row.code}
                        </span>
                        <h4 className="font-bold text-slate-900 mt-1">{row.name}</h4>
                        <p className="text-xs text-slate-500 font-semibold mt-0.5">
                          Cửa hàng: {storeLabel(row.branchCode)} · Nhóm: {row.categoryCode} · Thời gian: {row.numberOfPeriods} kỳ
                        </p>
                      </div>
                      
                      <div className="text-right">
                        <p className="text-sm font-bold text-slate-900">{money(row.totalAmount)} đ</p>
                        <span className="text-[10px] font-bold text-slate-500 bg-slate-100 border border-slate-200 px-2.5 py-0.5 rounded-full uppercase mt-1 inline-block">
                          {row.status}
                        </span>
                      </div>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-slate-50/40 text-[10px] font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">
                          <tr>
                            <th className="px-5 py-2.5">Kỳ phân bổ</th>
                            <th className="px-5 py-2.5 text-right">Số tiền chi phí</th>
                            <th className="px-5 py-2.5 text-center">Trạng thái hạch toán</th>
                            <th className="px-5 py-2.5 text-right">Thao tác</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {row.schedules.map((schedule) => (
                            <tr key={schedule.id} className="hover:bg-slate-50/30 transition-colors">
                              <td className="px-5 py-3 text-xs font-semibold text-slate-700">
                                {schedule.period}
                              </td>
                              <td className="px-5 py-3 text-right text-xs font-bold text-slate-900">
                                {money(schedule.amount)} đ
                              </td>
                              <td className="px-5 py-3 text-center text-xs">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  schedule.status === "POSTED"
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                    : "bg-slate-50 text-slate-500 border border-slate-200"
                                }`}>
                                  {schedule.status === "POSTED" ? "Đã phân bổ" : "Chờ phân bổ"}
                                </span>
                              </td>
                              <td className="px-5 py-3 text-right text-xs">
                                {canEdit && schedule.status === "PLANNED" && (
                                  <button
                                    onClick={() => void send({ action: "POST_ACCRUAL", scheduleId: schedule.id }, "Đã ghi nhận chi phí phân bổ.")}
                                    className="text-xs font-bold text-indigo-600 hover:underline"
                                  >
                                    Ghi nhận chi phí
                                  </button>
                                )}
                                {schedule.status === "POSTED" && (
                                  <span className="text-slate-400 font-semibold text-[10px]">Đã ghi sổ cái</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        )}

        {/* TAB 3: Closing Period */}
        {active === "closing" && (
          <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
            {/* Checklist */}
            <section className="bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
              <div className="px-6 py-5 border-b border-slate-200">
                <h3 className="font-bold text-slate-900">Checklist điều kiện khóa sổ {period}</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Hệ thống yêu cầu hoàn thành tất cả điều kiện kiểm tra (checklist) để đóng kỳ kế toán.
                </p>
              </div>
              
              <div className="divide-y divide-slate-100">
                {data.checklist.length === 0 ? (
                  <div className="px-6 py-8 text-center text-slate-400 font-medium text-sm">
                    Không có checklist kiểm tra được tải.
                  </div>
                ) : (
                  data.checklist.map((item) => (
                    <div key={item.key} className="px-6 py-4 flex items-center justify-between gap-4 hover:bg-slate-50/20 transition-colors">
                      <div className="flex items-center gap-3">
                        <span className={`material-symbols-outlined text-2xl ${
                          item.passed ? "text-emerald-500 font-bold" : "text-rose-500 font-bold animate-pulse"
                        }`}>
                          {item.passed ? "check_circle" : "error"}
                        </span>
                        <div>
                          <p className="text-sm font-bold text-slate-800">{item.label}</p>
                          {!item.passed && (
                            <p className="text-xs text-rose-600 font-semibold mt-0.5">
                              Phát hiện {item.count} bản ghi chưa xử lý triệt để.
                            </p>
                          )}
                        </div>
                      </div>
                      
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                        item.passed
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                          : "bg-rose-50 text-rose-700 border border-rose-100"
                      }`}>
                        {item.passed ? "Đạt" : "Chưa đạt"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Closing Period Widget */}
            <aside className="bg-white border border-slate-200 rounded-2xl p-6 h-fit space-y-5 shadow-lg">
              <div className="flex items-center gap-3">
                <div className={`h-12 w-12 rounded-xl grid place-items-center shadow-sm ${
                  data.accountingPeriod.status === "CLOSED"
                    ? "bg-rose-50 text-rose-600 border border-rose-100"
                    : "bg-emerald-50 text-emerald-600 border border-emerald-100"
                }`}>
                  <span className="material-symbols-outlined text-2xl font-bold">
                    {data.accountingPeriod.status === "CLOSED" ? "lock" : "lock_open"}
                  </span>
                </div>
                <div>
                  <h3 className="font-bold text-slate-900">
                    {data.accountingPeriod.status === "CLOSED" ? "Kỳ đã khóa" : "Kỳ đang mở"}
                  </h3>
                  <p className="text-xs text-slate-500 font-medium">Phạm vi lọc: {storeLabel(branchCode)}</p>
                </div>
              </div>

              <div className="text-xs text-slate-500 border-t border-b border-slate-100 py-3 space-y-2 font-medium">
                {data.accountingPeriod.status === "CLOSED" && (
                  <>
                    <p>Khóa bởi: <b>{data.accountingPeriod.closedBy || "Hệ thống"}</b></p>
                    <p>Khóa lúc: <b>{data.accountingPeriod.closedAt ? new Date(data.accountingPeriod.closedAt).toLocaleString("vi-VN") : "-"}</b></p>
                  </>
                )}
                {data.accountingPeriod.status === "OPEN" && (
                  <p>Kỳ kế toán đang hoạt động bình thường. Cho phép lập chứng từ, import dữ liệu và đối soát.</p>
                )}
              </div>

              {canClose ? (
                data.accountingPeriod.status !== "CLOSED" ? (
                  <button
                    disabled={data.checklist.some((item) => !item.passed) || submitting}
                    onClick={() => void send({ action: "CLOSE_PERIOD", period, branchCode }, "Đã khóa kỳ kế toán.")}
                    className="w-full bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-700 hover:to-rose-800 disabled:from-slate-100 disabled:to-slate-100 disabled:text-slate-400 disabled:shadow-none disabled:border-slate-200 text-white rounded-xl py-3 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-98 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-lg">lock</span>
                    Khóa kỳ kế toán
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      const reason = window.prompt("Lý do mở lại kỳ kế toán?");
                      if (reason) void send({ action: "REOPEN_PERIOD", period, branchCode, reason }, "Đã mở lại kỳ kế toán.");
                    }}
                    className="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-xl py-3 text-sm font-bold shadow-md hover:shadow-lg transition-all active:scale-98 flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-lg">lock_open</span>
                    Mở khóa kỳ
                  </button>
                )
              ) : (
                <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 p-3 rounded-lg text-center font-medium">
                  Chỉ tài khoản vai trò **Admin** mới được thực hiện khóa hoặc mở kỳ kế toán.
                </p>
              )}
            </aside>
          </div>
        )}
      </main>
    </div>
  );
}
