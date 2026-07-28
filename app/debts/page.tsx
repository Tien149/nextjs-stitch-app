"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
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

/** Một dòng phát sinh trong sổ chi tiết công nợ của đối tác. */
type LedgerRow = {
  /** Chỉ dòng đến từ khoản công nợ (RECEIVABLE/PAYABLE) mới có id để sửa/xoá. */
  id?: string;
  date: string;
  dueDate?: string | null;
  source: string;
  code: string;
  description: string;
  amount: number;
  status?: string;
  agingBucket?: string;
};

type LedgerDetail = {
  partnerCode: string;
  partnerName: string;
  balance: number;
  rows: LedgerRow[];
};

/** Nguồn phát sinh không thuộc màn hình Công nợ thì phải sửa ở màn hình gốc. */
const externalSourceLabels: Record<string, string> = {
  OPENING_BALANCE: "Phát sinh từ số dư đầu kỳ, hãy chỉnh tại màn hình Số dư đầu kỳ",
  DEPOSIT: "Phát sinh từ phiếu cọc, hãy chỉnh tại màn hình Tiền cọc",
  BANK_STATEMENT: "Phát sinh từ sao kê ngân hàng, hãy chỉnh tại màn hình Đối chiếu",
  VOUCHER: "Phát sinh từ phiếu thu/chi, hãy chỉnh tại màn hình Chứng từ",
  PURCHASE_ORDER: "Phát sinh từ đơn mua hàng, hãy chỉnh tại màn hình Mua hàng",
};

const emptyDebtForm = {
  documentDate: new Date().toISOString().slice(0, 10),
  dueDate: "",
  description: "",
  originalAmount: "",
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
  const [message, setMessage] = useState("");
  /** Khoản công nợ đang sửa trong hộp thoại; null nghĩa là hộp thoại đang đóng. */
  const [editingDebt, setEditingDebt] = useState<LedgerRow | null>(null);
  const [debtForm, setDebtForm] = useState(emptyDebtForm);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletingDebt, setDeletingDebt] = useState<LedgerRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

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

  /** Chỉ khoản công nợ còn nguyên gốc (OPEN) mới được sửa/xoá tại đây. */
  const debtLockReason = (row: LedgerRow) => {
    if (!row.id) return externalSourceLabels[row.source] || "Phát sinh này không sửa/xoá được tại màn hình Công nợ";
    if (row.status && row.status !== "OPEN") {
      return "Khoản công nợ đã có phát sinh thanh toán hoặc đã tất toán, không thể sửa/xoá. Hãy điều chỉnh bằng phiếu thu/chi.";
    }
    return null;
  };

  const startEditDebt = (row: LedgerRow) => {
    setMessage("");
    setEditError(null);
    setEditingDebt(row);
    setDebtForm({
      documentDate: row.date.slice(0, 10),
      dueDate: row.dueDate ? row.dueDate.slice(0, 10) : "",
      description: row.description,
      originalAmount: String(Math.abs(row.amount)),
    });
  };

  const submitDebtEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingDebt?.id) return;
    setSaving(true);
    setEditError(null);
    try {
      const response = await fetch("/api/debts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "UPDATE",
          id: editingDebt.id,
          documentDate: debtForm.documentDate,
          dueDate: debtForm.dueDate,
          description: debtForm.description,
          originalAmount: debtForm.originalAmount,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setEditError(payload.error || "Không lưu được thay đổi công nợ");
        return;
      }
      const savedCode = editingDebt.code;
      setEditingDebt(null);
      await loadRows();
      if (ledger) await loadLedger(ledger.partnerCode);
      setMessage(`Đã lưu thay đổi khoản công nợ ${savedCode}.`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDeleteDebt = async (reason: string) => {
    if (!deletingDebt?.id) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingDebt.id });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/debts?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được khoản công nợ");
        return;
      }
      const deletedCode = deletingDebt.code;
      if (editingDebt?.id === deletingDebt.id) setEditingDebt(null);
      setDeletingDebt(null);
      await loadRows();
      if (ledger) await loadLedger(ledger.partnerCode);
      setMessage(`Đã chuyển khoản công nợ ${deletedCode} vào Thùng rác.`);
    } finally {
      setDeleting(false);
    }
  };

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
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto custom-scrollbar">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-200 sticky top-0 z-10 shadow-sm">
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
                {message && (
                  <p className="mt-2 text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>
                )}
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
                    <th className="px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ledger.rows.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">Chưa có phát sinh.</td></tr>
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
                      <td className="px-4 py-3 text-right">
                        <RowActions
                          session={user}
                          module="/debts"
                          compact
                          onEdit={() => startEditDebt(item)}
                          onDelete={() => {
                            setDeleteError(null);
                            setDeletingDebt(item);
                          }}
                          editDisabledReason={debtLockReason(item)}
                          deleteDisabledReason={debtLockReason(item)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {editingDebt && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={submitDebtEdit} className="bg-white rounded-xl w-full max-w-md shadow-xl">
            <div className="p-5 border-b border-slate-200">
              <h3 className="font-bold text-slate-900">Sửa khoản công nợ {editingDebt.code}</h3>
              <p className="text-sm text-slate-500 mt-1">
                {editingDebt.source === "RECEIVABLE" ? "Công nợ phải thu" : "Công nợ phải trả"} · {ledger?.partnerName}
              </p>
            </div>

            <div className="p-5 space-y-4">
              <label className="text-xs font-bold text-slate-600 block">
                Ngày chứng từ *
                <DateInput
                  value={debtForm.documentDate}
                  onChange={(documentDate) => setDebtForm((value) => ({ ...value, documentDate }))}
                  className="mt-1"
                  required
                  ariaLabel="Ngày chứng từ công nợ"
                />
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Hạn thanh toán
                <DateInput
                  value={debtForm.dueDate}
                  onChange={(dueDate) => setDebtForm((value) => ({ ...value, dueDate }))}
                  className="mt-1"
                  ariaLabel="Hạn thanh toán công nợ"
                />
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Số tiền (đ) *
                <input
                  type="number"
                  min="1"
                  value={debtForm.originalAmount}
                  onChange={(event) => setDebtForm((value) => ({ ...value, originalAmount: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>

              <label className="text-xs font-bold text-slate-600 block">
                Diễn giải *
                <textarea
                  value={debtForm.description}
                  onChange={(event) => setDebtForm((value) => ({ ...value, description: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>

              {editError && (
                <p className="text-sm rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2">{editError}</p>
              )}
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingDebt(null);
                  setEditError(null);
                }}
                className="px-4 py-2 rounded-lg text-sm font-bold text-slate-600 hover:bg-slate-100"
              >
                Huỷ
              </button>
              <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg text-sm font-bold bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white">
                {saving ? "Đang lưu..." : "Lưu thay đổi"}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDeleteDialog
        open={Boolean(deletingDebt)}
        title={`Xoá khoản công nợ ${deletingDebt?.code || ""}?`}
        description={deletingDebt ? `${deletingDebt.description} · ${money(Math.abs(deletingDebt.amount))} đ` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => {
          setDeletingDebt(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDeleteDebt}
      />
    </div>
  );
}
