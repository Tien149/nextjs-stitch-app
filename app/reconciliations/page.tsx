"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { appMenuItems, canAccessMenu, canPerformMenuAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { DateInput } from "@/components/DateInput";
import { MoneyInput } from "@/components/MoneyInput";
import { filterMoneySources, type MoneySourceOption } from "@/lib/money-sources";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { exportRowsToExcel } from "@/lib/export-table-excel";

type Allocation = { id: string; sourceRowNumber: number; sheetName: string; revenueDate: string | null; sourceDate: string | null; debitAmount: number; creditAmount: number; grossAmount: number | null; grabExpenseAmount: number; cardFeeAmount: number };
type MatchRow = { targetCode: string; targetType: string; targetHref?: string };
type BankRow = {
  id: string; transactionDate: string; sourceDate: string | null; accountingDate: string | null;
  bankAccount: string; transactionCode: string; description: string; debitAmount: number; creditAmount: number;
  branchCode: string | null; categoryCode: string | null; operationType: string | null; partnerCode: string | null;
  pnlItemCode: string | null; summaryMoneySourceCode: string | null; increaseMoneySourceCode: string | null; decreaseMoneySourceCode: string | null;
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

/** Ngày lưu ở UTC nửa đêm nên cắt chuỗi ISO là đúng ngày nghiệp vụ, không lệch múi giờ. */
function dateInputValue(value: string | null | undefined) {
  return value ? String(value).slice(0, 10) : "";
}

/** Một dòng Ngày doanh thu đang sửa trong bảng tách; `id` rỗng là dòng mới thêm. */
type SplitLine = { key: string; id: string | null; revenueDate: string; amount: string };

let splitLineSeq = 0;
function newSplitKey() {
  splitLineSeq += 1;
  return `new-${splitLineSeq}`;
}

const emptyFilters = { from: "", to: "", dateType: "TRANSACTION", branchCode: "ALL", moneySource: "", category: "", operationType: "", q: "", missingCategory: "" };

export default function BankStatementLedgerPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [moneySources, setMoneySources] = useState<MoneySourceOption[]>([]);
  const [categories, setCategories] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [batchId, setBatchId] = useState("");
  const [filters, setFilters] = useState(emptyFilters);
  const [applied, setApplied] = useState(emptyFilters);
  const [isExporting, setIsExporting] = useState(false);
  const [splitRow, setSplitRow] = useState<BankRow | null>(null);
  const [splitLines, setSplitLines] = useState<SplitLine[]>([]);
  const [splitError, setSplitError] = useState("");
  const [splitSaving, setSplitSaving] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/reconciliations");
    if (!raw) return void router.push("/login?next=/reconciliations");
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) return void router.push("/");
    // Link từ dòng "Chưa phân loại" của Báo cáo nguồn tiền mang sẵn kỳ + cửa hàng + cờ lọc,
    // để mở ra là thấy đúng những dòng sao kê đang thiếu Loại thu/chi.
    const urlParams = new URLSearchParams(window.location.search);
    const urlDateType = (urlParams.get("dateType") || "").toUpperCase();
    const urlFilters = {
      ...emptyFilters,
      from: urlParams.get("from") || "",
      to: urlParams.get("to") || "",
      dateType: ["TRANSACTION", "SOURCE", "REVENUE"].includes(urlDateType) ? urlDateType : emptyFilters.dateType,
      branchCode: (urlParams.get("branchCode") || "ALL").toUpperCase() || "ALL",
      missingCategory: urlParams.get("missingCategory") === "1" ? "1" : "",
    };
    const hasUrlFilters = Boolean(urlFilters.from || urlFilters.to || urlFilters.missingCategory);
    window.setTimeout(() => {
      setUser(session);
      setBatchId(urlParams.get("batchId")?.trim() || "");
      if (hasUrlFilters) {
        setFilters(urlFilters);
        setApplied(urlFilters);
      }
    }, 0);
    void fetch("/api/master-data?type=MONEY_SOURCE&status=ACTIVE")
      .then((response) => response.ok ? response.json() : [])
      .then((data: MoneySourceOption[]) => setMoneySources(data));
    void fetch("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE")
      .then((response) => response.ok ? response.json() : [])
      .then((data: Array<{ id: string; code: string; name: string }>) => setCategories(data));
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
  const canEdit = Boolean(user && canPerformMenuAction(user, "/reconciliations", "edit"));

  /**
   * Sửa Ngày doanh thu ngay trên dòng sao kê. File của khách hay gộp 3-4 ngày doanh thu vào
   * cùng một lần ví trả tiền; trước đây chỉ có đường rollback lô rồi import lại, còn bảng
   * "Tiền về đủ chưa" thì dồn hết tiền vào một ngày và báo các ngày kia thiếu tiền.
   */
  const splitTotal = splitRow ? Math.round(splitRow.creditAmount || splitRow.debitAmount) : 0;
  const splitAssigned = splitLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const splitRemaining = splitTotal - splitAssigned;

  const openSplit = (row: BankRow) => {
    const lines: SplitLine[] = row.allocations.length > 0
      ? row.allocations.map((allocation) => ({
          key: allocation.id,
          id: allocation.id,
          revenueDate: dateInputValue(allocation.revenueDate),
          amount: String(Math.round(allocation.creditAmount || allocation.debitAmount || 0)),
        }))
      : [{
          key: newSplitKey(),
          id: null,
          revenueDate: dateInputValue(row.revenueDates[0] || row.sourceDate || row.transactionDate),
          amount: String(Math.round(row.creditAmount || row.debitAmount)),
        }];
    setSplitRow(row);
    setSplitLines(lines);
    setSplitError("");
  };

  const updateSplitLine = (key: string, patch: Partial<SplitLine>) => {
    setSplitLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  };

  /** Tách đôi số tiền của một dòng: tổng không đổi nên người dùng chỉ còn phải sửa ngày. */
  const halveSplitLine = (key: string) => {
    setSplitLines((current) => current.flatMap((line) => {
      if (line.key !== key) return [line];
      const amount = Math.round(Number(line.amount) || 0);
      const half = Math.floor(amount / 2);
      return [
        { ...line, amount: String(amount - half) },
        { key: newSplitKey(), id: null, revenueDate: line.revenueDate, amount: String(half) },
      ];
    }));
  };

  const addSplitLine = () => {
    setSplitLines((current) => [...current, {
      key: newSplitKey(),
      id: null,
      revenueDate: "",
      amount: splitRemaining > 0 ? String(splitRemaining) : "",
    }]);
  };

  /** Xoá dòng thì dồn tiền của nó về dòng đầu còn lại, để tổng luôn khớp số tiền giao dịch. */
  const removeSplitLine = (key: string) => {
    setSplitLines((current) => {
      if (current.length <= 1) return current;
      const removed = current.find((line) => line.key === key);
      const rest = current.filter((line) => line.key !== key);
      const moved = Math.round(Number(removed?.amount) || 0);
      if (moved > 0) rest[0] = { ...rest[0], amount: String(Math.round(Number(rest[0].amount) || 0) + moved) };
      return rest;
    });
  };

  const saveSplit = async () => {
    if (!splitRow) return;
    setSplitSaving(true);
    setSplitError("");
    try {
      const response = await fetch("/api/reconciliations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SPLIT_REVENUE_DATES",
          bankTransactionId: splitRow.id,
          lines: splitLines.map((line) => ({ id: line.id, revenueDate: line.revenueDate, amount: Number(line.amount) || 0 })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Không lưu được Ngày doanh thu");
      setSplitRow(null);
      setSplitLines([]);
      await loadRows();
    } catch (error) {
      setSplitError(error instanceof Error ? error.message : "Không lưu được Ngày doanh thu");
    } finally {
      setSplitSaving(false);
    }
  };

  /**
   * Trang này phân trang phía máy chủ (50 dòng/trang) nên nút xuất phải gọi lần lượt hết các
   * trang của đúng bộ lọc đang áp dụng — kế toán cần soát đủ cả kỳ chứ không phải trang đang xem.
   */
  const exportAllRows = async () => {
    if (total === 0) return void window.alert("Không có giao dịch nào để xuất.");
    setIsExporting(true);
    try {
      const collected: BankRow[] = [];
      for (let current = 1; current <= totalPages; current += 1) {
        const params = new URLSearchParams({ status: "ALL", ledger: "1", page: String(current), dateType: applied.dateType });
        Object.entries(applied).forEach(([key, value]) => {
          if (value && !["dateType", "branchCode"].includes(key)) params.set(key, value);
        });
        if (applied.branchCode !== "ALL") params.set("branchCode", applied.branchCode);
        if (batchId) params.set("batchId", batchId);
        const response = await fetch(`/api/reconciliations?${params}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || "Không tải được dữ liệu để xuất");
        collected.push(...((payload.rows || []) as BankRow[]));
      }
      await exportRowsToExcel(
        collected.map((row) => ({
          "Ngày giao dịch": dateText(row.transactionDate),
          "Ngày nguồn tiền": dateText(row.sourceDate),
          "Ngày doanh thu": row.revenueDates.map(dateText).join(", "),
          "Mã giao dịch": row.transactionCode,
          "Tài khoản": row.bankAccount,
          "Diễn giải": row.description,
          "Nợ": row.debitAmount,
          "Có": row.creditAmount,
          "Cửa hàng": storeLabel(row.branchCode),
          "Mã cửa hàng": row.branchCode || "",
          "Nghiệp vụ": operationLabels[row.operationType || ""] || row.operationType || "",
          "Loại thu/chi": row.categoryCode || "",
          "Nguồn tiền tổng": row.summaryMoneySourceCode || "",
          "Nguồn tiền tăng": row.increaseMoneySourceCode || "",
          "Nguồn tiền giảm": row.decreaseMoneySourceCode || "",
          "Đối tác": row.partnerCode || "",
          "Hạng mục P&L": row.pnlItemCode || "",
          "Chứng từ": row.currentMatch?.targetCode || "",
          "Số dòng phân bổ": row.allocations.length,
          "Trạng thái": row.reconcileStatus === "MATCHED" ? "ĐÃ GHI NHẬN" : "DỮ LIỆU CŨ",
        })),
        { fileName: "so_sao_ke_ngan_hang", sheetName: "Sao ke" },
      );
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Không xuất được file Excel");
    } finally {
      setIsExporting(false);
    }
  };

  return <div className="min-h-screen bg-slate-100 text-slate-800">
    <header className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
      <div className="mx-auto flex max-w-[1800px] items-center justify-between gap-4">
        <div><h1 className="text-xl font-bold">Sổ sao kê ngân hàng</h1><p className="text-xs text-slate-500">Dữ liệu tích lũy theo các file đã Commit; mỗi dòng truy vết được về chứng từ nguồn.</p></div>
        <button onClick={() => router.push("/imports?tab=bank-statement")} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700">Import sao kê bổ sung</button>
      </div>
    </header>

    <main className="mx-auto max-w-[1800px] space-y-4 p-4 sm:p-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
          <label className="text-xs font-bold text-slate-600">Loại ngày<select className="control" value={filters.dateType} onChange={(e) => setFilters({ ...filters, dateType: e.target.value })}><option value="TRANSACTION">Ngày giao dịch</option><option value="SOURCE">Ngày nguồn tiền</option><option value="REVENUE">Ngày doanh thu</option></select></label>
          <label className="text-xs font-bold text-slate-600">Từ ngày<input className="control" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-600">Đến ngày<input className="control" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-600">Cửa hàng<select className="control" value={filters.branchCode} onChange={(e) => setFilters({ ...filters, branchCode: e.target.value })}><option value="ALL">Tất cả cửa hàng</option>{visibleStoreOptions(user).map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Nguồn tiền<select className="control" value={filters.moneySource} onChange={(e) => setFilters({ ...filters, moneySource: e.target.value })}><option value="">Tất cả nguồn tiền</option>{filterMoneySources(moneySources, filters.branchCode, ["BANK", "WALLET", "CASH"]).map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Loại thu/chi<select className="control" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">Tất cả loại thu/chi</option>{categories.map((item) => <option key={item.id || item.code} value={item.code}>{item.code} - {item.name}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Loại nghiệp vụ<select className="control" value={filters.operationType} onChange={(e) => setFilters({ ...filters, operationType: e.target.value })}><option value="">Tất cả nghiệp vụ</option>{Object.entries(operationLabels).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
          <label className="text-xs font-bold text-slate-600">Loại thu/chi đã gán<select className="control" value={filters.missingCategory} onChange={(e) => setFilters({ ...filters, missingCategory: e.target.value })}><option value="">Tất cả dòng</option><option value="1">Chưa gán loại thu/chi</option></select></label>
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
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div><h2 className="font-bold">Danh sách giao dịch sao kê đã import</h2><p className="mt-1 text-xs text-slate-500">Không cần match thủ công; file hợp lệ được ghi nhận trực tiếp khi Commit.</p></div>
          <button type="button" onClick={() => void exportAllRows()} disabled={isExporting} title="Xuất đủ toàn bộ giao dịch của bộ lọc hiện tại, không chỉ trang đang xem" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60">
            <span className="material-symbols-outlined text-[16px]">download</span>
            {isExporting ? "Đang xuất..." : `Xuất Excel (${total} dòng)`}
          </button>
        </div>
        <div className="overflow-x-auto"><table className="min-w-[1500px] w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{["Ngày GD / nguồn / DT", "Sao kê", "Nợ", "Có", "Cửa hàng", "Nghiệp vụ / loại", "Nguồn tổng / tăng / giảm", "Đối tác / P&L", "Chứng từ", "Trạng thái"].map((label) => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead>
          <tbody>{loading ? <tr><td colSpan={10} className="p-10 text-center text-slate-400">Đang tải...</td></tr> : rows.length === 0 ? <tr><td colSpan={10} className="p-10 text-center text-slate-400">Không có giao dịch phù hợp.</td></tr> : rows.map((row) => <tr key={row.id} className="border-t border-slate-100 align-top hover:bg-slate-50">
            <td className="px-3 py-3 text-xs"><b>{dateText(row.transactionDate)}</b><p>Nguồn: {dateText(row.sourceDate)}</p><p>DT: {row.revenueDates.length ? row.revenueDates.map(dateText).join(", ") : "—"}</p>{canEdit && <button type="button" onClick={() => openSplit(row)} title="Tách hoặc sửa Ngày doanh thu ngay trên dòng này, không phải import lại" className="mt-1.5 inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-bold text-blue-700 hover:bg-blue-50"><span className="material-symbols-outlined text-[14px]">call_split</span>Sửa ngày DT</button>}</td>
            <td className="max-w-sm px-3 py-3"><b className="break-all">{row.transactionCode}</b><p className="mt-1 text-xs text-slate-500">{row.bankAccount}</p><p className="mt-1 line-clamp-3 text-xs">{row.description}</p>{row.allocations.length > 1 && <span className="mt-1 inline-block rounded bg-indigo-50 px-2 py-0.5 text-xs font-bold text-indigo-700">{row.allocations.length} dòng phân bổ</span>}</td>
            <td className="px-3 py-3 text-right font-bold text-rose-700">{row.debitAmount ? `${money(row.debitAmount)} đ` : "—"}</td>
            <td className="px-3 py-3 text-right font-bold text-emerald-700">{row.creditAmount ? `${money(row.creditAmount)} đ` : "—"}</td>
            <td className="px-3 py-3"><b>{storeLabel(row.branchCode)}</b>{row.branchCode && <p className="text-xs text-slate-500">{row.branchCode}</p>}</td>
            <td className="px-3 py-3"><b>{operationLabels[row.operationType || ""] || row.operationType || "Dữ liệu cũ"}</b><p className="text-xs text-slate-500">{row.categoryCode || "—"}</p></td>
            <td className="px-3 py-3 text-xs">{row.summaryMoneySourceCode && <p className="font-bold text-slate-700">Tổng: {row.summaryMoneySourceCode}</p>}<p className="text-emerald-700">+ {row.increaseMoneySourceCode || "—"}</p><p className="text-rose-700">− {row.decreaseMoneySourceCode || "—"}</p></td>
            <td className="px-3 py-3 text-xs"><p>{row.partnerCode || "—"}</p><p className="text-slate-500">P&amp;L: {row.pnlItemCode || "—"}</p></td>
            <td className="px-3 py-3">{row.currentMatch ? <a href={row.currentMatch.targetHref || "/bank-vouchers"} className="font-bold text-blue-700 hover:underline">{row.currentMatch.targetCode}</a> : <span className="text-xs text-slate-400">Dữ liệu lịch sử chưa liên kết</span>}</td>
            <td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-xs font-bold ${row.reconcileStatus === "MATCHED" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{row.reconcileStatus === "MATCHED" ? "ĐÃ GHI NHẬN" : "DỮ LIỆU CŨ"}</span></td>
          </tr>)}</tbody>
        </table></div>
        <div className="flex items-center justify-between border-t border-slate-200 p-4 text-sm"><span>Trang {page}/{totalPages} · {total} giao dịch</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded border px-3 py-1.5 disabled:opacity-40">Trang trước</button><button disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded border px-3 py-1.5 disabled:opacity-40">Trang sau</button></div></div>
      </section>
    </main>

    {splitRow && <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="mt-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-4">
          <div>
            <h3 className="font-bold">Tách Ngày doanh thu</h3>
            <p className="mt-1 text-xs text-slate-500">{splitRow.transactionCode} · {dateText(splitRow.transactionDate)} · {storeLabel(splitRow.branchCode)} · {splitRow.creditAmount ? "Ghi có" : "Ghi nợ"} <b className="text-slate-700">{money(splitTotal)} đ</b></p>
            <p className="mt-1 text-xs text-slate-500">Chia số tiền này về đúng từng ngày doanh thu. Tổng tiền, chứng từ {splitRow.currentMatch?.targetCode || "đã lập"} và bút toán không đổi — chỉ đổi chỗ đứng trên bảng &quot;Tiền về đủ chưa&quot;.</p>
          </div>
          <button type="button" onClick={() => setSplitRow(null)} className="rounded p-1 text-slate-400 hover:bg-slate-100"><span className="material-symbols-outlined">close</span></button>
        </div>

        <div className="space-y-3 p-4">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500"><tr><th className="w-10 py-2 text-left">#</th><th className="py-2 text-left">Ngày doanh thu</th><th className="py-2 text-left">Số tiền</th><th className="w-24 py-2"></th></tr></thead>
            <tbody>{splitLines.map((line, index) => <tr key={line.key} className="border-t border-slate-100">
              <td className="py-2 text-xs text-slate-500">{index + 1}</td>
              <td className="py-2 pr-3"><DateInput value={line.revenueDate} onChange={(value) => updateSplitLine(line.key, { revenueDate: value })} ariaLabel={`Ngày doanh thu dòng ${index + 1}`} /></td>
              <td className="py-2 pr-3"><MoneyInput value={line.amount} onChange={(value) => updateSplitLine(line.key, { amount: value })} className="control text-right" ariaLabel={`Số tiền dòng ${index + 1}`} /></td>
              <td className="py-2 text-right">
                <button type="button" onClick={() => halveSplitLine(line.key)} title="Tách đôi dòng này (tổng không đổi)" className="rounded p-1 text-slate-500 hover:bg-slate-100"><span className="material-symbols-outlined text-[18px]">call_split</span></button>
                <button type="button" disabled={splitLines.length <= 1} onClick={() => removeSplitLine(line.key)} title="Xoá dòng, dồn tiền về dòng đầu" className="rounded p-1 text-rose-600 hover:bg-rose-50 disabled:opacity-30"><span className="material-symbols-outlined text-[18px]">delete</span></button>
              </td>
            </tr>)}</tbody>
          </table>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <button type="button" onClick={addSplitLine} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"><span className="material-symbols-outlined text-[16px]">add</span>Thêm ngày doanh thu</button>
            <p>Đã phân bổ <b>{money(splitAssigned)} đ</b> / {money(splitTotal)} đ · {splitRemaining === 0
              ? <b className="text-emerald-700">khớp đủ</b>
              : <b className="text-rose-700">{splitRemaining > 0 ? "còn thiếu" : "đang dư"} {money(Math.abs(splitRemaining))} đ</b>}</p>
          </div>

          <p className="text-xs text-slate-500">Gross ví và hai khoản phí (Grab, cà thẻ) được chia theo tỷ trọng số tiền của từng dòng, tổng giữ nguyên đến từng đồng.</p>
          {splitError && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">{splitError}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
          <button type="button" onClick={() => setSplitRow(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold">Hủy</button>
          <button type="button" onClick={() => void saveSplit()} disabled={splitSaving || splitRemaining !== 0 || splitLines.some((line) => !line.revenueDate)} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{splitSaving ? "Đang lưu..." : "Lưu Ngày doanh thu"}</button>
        </div>
      </div>
    </div>}
  </div>;
}
