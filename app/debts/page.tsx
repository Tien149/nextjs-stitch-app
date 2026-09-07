"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { appMenuItems, canAccessMenu, canPerformAction, canPerformMenuAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";
import { PartnerPicker } from "@/components/PartnerPicker";
import { SearchableSelect } from "@/components/SearchableSelect";
import { visibleStoreOptions } from "@/lib/branch-labels";

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
  /** Mã phiếu cha khi khoản này là một dòng của phiếu công nợ nhiều hạng mục P&L. */
  groupCode?: string | null;
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

/** Một dòng hạng mục trong popup Thêm công nợ; `key` chỉ để React theo dõi khi thêm/xoá dòng. */
type CreateLine = { key: number; pnlItemCode: string; amount: string; note: string };
const emptyCreateLine = (key: number): CreateLine => ({ key, pnlItemCode: "", amount: "", note: "" });

const isReceivableBalance = (balance: number) => balance < 0;
const isPayableBalance = (balance: number) => balance > 0;

function debtBalanceLabel(balance: number) {
  if (isReceivableBalance(balance)) return "Phải thu";
  if (isPayableBalance(balance)) return "Phải trả";
  return "Đã cân";
}

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
  /** Phiếu nhiều hạng mục đang chờ xoá cả cụm (mọi dòng `<mã phiếu>/n`). */
  const [deletingGroup, setDeletingGroup] = useState<{ groupCode: string; rows: LedgerRow[] } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Tạo tay công nợ ngay trên màn này: khoản phải trả NCC đã phát sinh chi phí nhưng chưa
  // thanh toán, hoặc công nợ nội bộ giữa hai nhà hàng (khoản chi hộ).
  const [createOpen, setCreateOpen] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState("");
  const [partners, setPartners] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [pnlItems, setPnlItems] = useState<Array<{ id: string; code: string; name: string; group: string | null; status?: string }>>([]);
  const [createForm, setCreateForm] = useState({
    debtType: "PAYABLE",
    partnerGroup: "EXTERNAL",
    partnerCode: "",
    branchCode: "",
    documentDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    description: "",
  });
  // Bảng chi tiết của phiếu: mỗi dòng một hạng mục P&L + số tiền riêng (trích trước cuối tháng
  // cùng NCC nhưng nhiều hạng mục). Một dòng thì tạo khoản đơn như trước.
  const [createLines, setCreateLines] = useState<CreateLine[]>([emptyCreateLine(1)]);
  const createTotal = createLines.reduce((sum, line) => sum + (Number(line.amount) > 0 ? Number(line.amount) : 0), 0);
  const updateCreateLine = (key: number, patch: Partial<CreateLine>) =>
    setCreateLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const addCreateLine = () => setCreateLines((current) => [...current, emptyCreateLine(Math.max(...current.map((line) => line.key)) + 1)]);
  const removeCreateLine = (key: number) => setCreateLines((current) => (current.length > 1 ? current.filter((line) => line.key !== key) : current));
  const canCreateDebts = user ? canPerformAction(user, "create") : false;
  const canDeleteDebts = user ? canPerformAction(user, "delete") : false;
  const canCreatePartner = user ? canPerformMenuAction(user, "/settings", "config") : false;

  const openCreateDialog = () => {
    setCreateError("");
    setCreateForm((current) => ({
      ...current,
      branchCode: current.branchCode || (branchScope !== "ALL" ? branchScope : visibleStoreOptions(user)[0]?.code || ""),
    }));
    setCreateOpen(true);
    if (partners.length === 0) {
      void fetch("/api/master-data?type=PARTNER&status=ACTIVE")
        .then((response) => response.ok ? response.json() : [])
        .then((data) => setPartners(data));
    }
    if (pnlItems.length === 0) {
      void fetch("/api/master-data?type=PNL_ITEM&status=ACTIVE")
        .then((response) => response.ok ? response.json() : [])
        .then((data) => setPnlItems(data));
    }
  };

  const submitCreateDebt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (createSaving) return;
    setCreateError("");
    if (!createForm.partnerCode || !createForm.branchCode || !createForm.description.trim()) {
      setCreateError("Cần chọn đối tác, cửa hàng và diễn giải.");
      return;
    }
    const badLine = createLines.findIndex((line) => !(Number(line.amount) > 0));
    if (badLine >= 0) {
      setCreateError(createLines.length === 1 ? "Số tiền phải lớn hơn 0." : `Dòng ${badLine + 1}: số tiền phải lớn hơn 0.`);
      return;
    }
    setCreateSaving(true);
    try {
      const response = await fetch("/api/debts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...createForm,
          lines: createLines.map((line) => ({ pnlItemCode: line.pnlItemCode, amount: line.amount, note: line.note })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setCreateError(payload.error || "Không tạo được công nợ.");
        return;
      }
      setCreateOpen(false);
      setCreateForm((current) => ({ ...current, partnerCode: "", description: "", dueDate: "" }));
      setCreateLines([emptyCreateLine(1)]);
      setMessage(payload.lineCount > 1 ? `Đã tạo phiếu công nợ ${payload.code} gồm ${payload.lineCount} dòng hạng mục.` : `Đã tạo công nợ ${payload.code}.`);
      await loadRows();
      if (ledger) await loadLedger(ledger.partnerCode);
    } catch {
      setCreateError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setCreateSaving(false);
    }
  };

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

  /** Xoá cả phiếu nhiều hạng mục: API kiểm tra từng dòng, một dòng vướng thì không xoá dòng nào. */
  const confirmDeleteGroup = async (reason: string) => {
    if (!deletingGroup) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ groupCode: deletingGroup.groupCode });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/debts?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được phiếu công nợ");
        return;
      }
      const deletedGroup = deletingGroup.groupCode;
      if (editingDebt?.groupCode === deletedGroup) setEditingDebt(null);
      setDeletingGroup(null);
      await loadRows();
      if (ledger) await loadLedger(ledger.partnerCode);
      setMessage(`Đã chuyển cả phiếu công nợ ${deletedGroup} (${payload.deleted?.length || 0} dòng) vào Thùng rác.`);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Dòng công nợ đầu tiên của mỗi phiếu nhiều hạng mục trong sổ, kèm các dòng còn lại — để chèn
   * một dải tiêu đề phiếu ngay phía trên dòng đầu (sổ đã xếp các dòng cùng phiếu liền nhau).
   */
  const ledgerGroupStarts = (() => {
    const starts = new Map<number, LedgerRow[]>();
    if (!ledger) return starts;
    ledger.rows.forEach((row, index) => {
      if (!row.groupCode || ledger.rows[index - 1]?.groupCode === row.groupCode) return;
      starts.set(index, ledger.rows.filter((item) => item.groupCode === row.groupCode));
    });
    return starts;
  })();

  const filteredRows = rows.filter((row) => {
    if (partnerGroup !== "ALL" && row.partnerGroup !== partnerGroup) return false;
    if (agingFilter !== "ALL" && row.debtStatus !== agingFilter) return false;
    if (debtType === "RECEIVABLE" && !isReceivableBalance(row.balance)) return false;
    if (debtType === "PAYABLE" && !isPayableBalance(row.balance)) return false;
    return true;
  });
  const receivableTotal = rows
    .filter((row) => isReceivableBalance(row.balance))
    .reduce((sum, row) => sum + Math.abs(row.balance), 0);
  const payableTotal = rows
    .filter((row) => isPayableBalance(row.balance))
    .reduce((sum, row) => sum + row.balance, 0);
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
          {canCreateDebts && (
            <button
              type="button"
              onClick={openCreateDialog}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
            >
              + Thêm công nợ
            </button>
          )}
          <BranchScopeSelect session={user} value={branchScope} onChange={setBranchScope} />
          <p className="hidden text-xs font-bold text-slate-500 sm:block">{user?.role}</p>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        <StickyFilterBar className="!-mx-6 !px-6 !mb-0">
          <div className="grid md:grid-cols-5 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Đối tác</p>
              <p className="text-2xl font-bold">{rows.length}</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Phải thu</p>
              <p className="text-2xl font-bold text-blue-700">{money(receivableTotal)} đ</p>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <p className="text-xs text-slate-500">Phải trả</p>
              <p className="text-2xl font-bold text-rose-700">{money(payableTotal)} đ</p>
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
        </StickyFilterBar>

        <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Bảng công nợ đối tác</h2>
              <p className="text-xs text-slate-500 mt-1">Số dư âm được phân loại là Phải thu, số dư dương là Phải trả. Bấm đối tác để xem ledger.</p>
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
            <ExportExcelButton fileName="cong_no_doi_tac" sheetName="Cong no" targetId="debt-summary-table" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5" />
          </div>
          <div id="debt-summary-table" className="overflow-x-auto max-h-[560px] overflow-y-auto custom-scrollbar">
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
                    <td className="px-4 py-3 text-right">
                      <p className={`font-bold ${isReceivableBalance(row.balance) ? "text-blue-700" : isPayableBalance(row.balance) ? "text-rose-700" : "text-slate-500"}`}>
                        {money(Math.abs(row.balance))}
                      </p>
                      <p className={`mt-0.5 text-[10px] font-bold uppercase ${isReceivableBalance(row.balance) ? "text-blue-600" : isPayableBalance(row.balance) ? "text-rose-600" : "text-slate-400"}`}>
                        {debtBalanceLabel(row.balance)}
                      </p>
                    </td>
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
                <p className="text-xs text-slate-500 mt-1">
                  Số dư hiện tại:{" "}
                  <b className={isReceivableBalance(ledger.balance) ? "text-blue-700" : isPayableBalance(ledger.balance) ? "text-rose-700" : "text-slate-600"}>
                    {money(Math.abs(ledger.balance))} đ · {debtBalanceLabel(ledger.balance)}
                  </b>
                </p>
                {message && (
                  <p className="mt-2 text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <ExportExcelButton fileName={`ledger_cong_no_${ledger.partnerCode || ledger.partnerName}`} sheetName="Ledger" targetId="debt-ledger-table" className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50 inline-flex items-center gap-1.5" />
                <button onClick={() => setLedger(null)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Đóng</button>
              </div>
            </div>
            <div id="debt-ledger-table" className="overflow-x-auto max-h-[420px]">
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
                  ) : ledger.rows.map((item, index) => {
                    const groupRows = ledgerGroupStarts.get(index);
                    const groupTotal = groupRows ? groupRows.reduce((sum, row) => sum + Math.abs(row.amount), 0) : 0;
                    const groupLocked = groupRows ? groupRows.map(debtLockReason).find(Boolean) || null : null;
                    return (
                    <Fragment key={`${item.source}-${item.code}-${index}`}>
                    {groupRows && (
                      <tr className="bg-blue-50/70">
                        <td colSpan={6} className="px-4 py-2 text-xs font-bold text-blue-700">
                          Phiếu {item.groupCode} · {groupRows.length} dòng hạng mục · {money(groupTotal)} đ
                        </td>
                        <td className="px-4 py-2 text-right">
                          {canDeleteDebts && (
                            <button
                              type="button"
                              disabled={Boolean(groupLocked)}
                              title={groupLocked || "Chuyển cả phiếu (mọi dòng) vào Thùng rác"}
                              onClick={() => {
                                setDeleteError(null);
                                setDeletingGroup({ groupCode: item.groupCode!, rows: groupRows });
                              }}
                              className="rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-[11px] font-bold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Xoá cả phiếu
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                    <tr className="hover:bg-slate-50">
                      <td className="px-4 py-3">{new Date(item.date).toLocaleDateString("vi-VN")}</td>
                      <td className="px-4 py-3">{item.source}</td>
                      <td className="px-4 py-3 font-bold"><CopyableText value={item.code} /></td>
                      <td className="px-4 py-3">
                        <p className={`text-xs font-bold ${item.agingBucket === "OVERDUE" ? "text-rose-700" : item.agingBucket === "DUE_7" ? "text-amber-700" : "text-slate-500"}`}>
                          {item.dueDate ? new Date(item.dueDate).toLocaleDateString("vi-VN") : "-"}
                        </p>
                        <p className="text-[11px] text-slate-400">{item.status || "-"}</p>
                      </td>
                      <td className="px-4 py-3">{item.description}</td>
                      <td className={`px-4 py-3 text-right font-bold ${item.amount < 0 ? "text-blue-700" : item.amount > 0 ? "text-rose-700" : "text-slate-500"}`}>{money(item.amount)} đ</td>
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
                    </Fragment>
                    );
                  })}
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

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <form onSubmit={submitCreateDebt} className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-xl">
            <div className="border-b border-slate-200 p-5">
              <h2 className="font-bold text-slate-900">Thêm công nợ</h2>
              <p className="mt-1 text-xs text-slate-500">
                Khai khoản phải trả đã phát sinh chi phí nhưng chưa thanh toán, hoặc công nợ nội bộ giữa hai nhà hàng.
                Khi thanh toán, phiếu chi/sao kê gạch thẳng vào mã công nợ này.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 p-5">
              <label className="text-xs font-bold text-slate-600 block">
                Loại công nợ *
                <select
                  value={createForm.debtType}
                  onChange={(event) => setCreateForm((value) => ({ ...value, debtType: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  <option value="PAYABLE">Phải trả</option>
                  <option value="RECEIVABLE">Phải thu</option>
                </select>
              </label>
              <label className="text-xs font-bold text-slate-600 block">
                Nhóm đối tác *
                <select
                  value={createForm.partnerGroup}
                  onChange={(event) => setCreateForm((value) => ({ ...value, partnerGroup: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                >
                  <option value="EXTERNAL">Bên ngoài (NCC/khách)</option>
                  <option value="INTERNAL">Nội bộ (giữa nhà hàng)</option>
                </select>
              </label>
              <div className="col-span-2 text-xs font-bold text-slate-600 block">
                Đối tác *
                <PartnerPicker
                  className="mt-1"
                  value={createForm.partnerCode}
                  onChange={(partnerCode) => setCreateForm((value) => ({ ...value, partnerCode }))}
                  options={partners.map((item) => ({ value: item.code, label: `${item.code} - ${item.name}` }))}
                  required
                  canCreate={canCreatePartner}
                  defaultPartnerType={createForm.debtType === "PAYABLE" ? "SUPPLIER" : "CUSTOMER"}
                  onCreated={(partner) => {
                    setPartners((current) => [...current, partner]);
                    setCreateForm((value) => ({ ...value, partnerCode: partner.code }));
                  }}
                />
              </div>
              <label className="text-xs font-bold text-slate-600 block">
                Cửa hàng *
                <select
                  value={createForm.branchCode}
                  onChange={(event) => setCreateForm((value) => ({ ...value, branchCode: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  required
                >
                  <option value="">-- Chọn cửa hàng --</option>
                  {visibleStoreOptions(user).map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col text-xs font-bold text-slate-600">
                <span>Ngày chứng từ *</span>
                <DateInput
                  value={createForm.documentDate}
                  onChange={(documentDate) => setCreateForm((value) => ({ ...value, documentDate }))}
                  className="mt-1"
                  required
                  ariaLabel="Ngày chứng từ công nợ"
                />
              </div>
              <div className="flex flex-col text-xs font-bold text-slate-600">
                <span>Hạn thanh toán</span>
                <DateInput
                  value={createForm.dueDate}
                  onChange={(dueDate) => setCreateForm((value) => ({ ...value, dueDate }))}
                  className="mt-1"
                  ariaLabel="Hạn thanh toán công nợ"
                />
              </div>
              <label className="col-span-2 text-xs font-bold text-slate-600 block">
                Diễn giải chung *
                <input
                  value={createForm.description}
                  onChange={(event) => setCreateForm((value) => ({ ...value, description: event.target.value }))}
                  placeholder="VD: Trích trước chi phí tháng 9 / Tiền hàng tháng 8 chưa thanh toán / B trả A khoản chi hộ..."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                  required
                />
              </label>

              {/* Mỗi dòng một hạng mục P&L + số tiền riêng; nhiều dòng → phiếu chung mã cha, dòng mang mã /1, /2... */}
              <div className="col-span-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-bold text-slate-600">Chi tiết theo hạng mục P&amp;L *</span>
                  <span className="text-[11px] text-slate-400">Mỗi dòng một hạng mục · số tiền riêng · nhiều dòng sẽ chung một số phiếu</span>
                </div>
                {/* Không overflow-hidden: dropdown chọn hạng mục là absolute bên trong bảng, cắt là mất danh sách. */}
                <div className="mt-1 rounded-lg border border-slate-200">
                  <table className="w-full text-left text-sm">
                    <thead className="text-[11px] uppercase text-slate-500 [&_th]:bg-slate-50 [&_th:first-child]:rounded-tl-lg [&_th:last-child]:rounded-tr-lg">
                      <tr>
                        <th className="w-8 px-3 py-2">#</th>
                        <th className="px-3 py-2">Hạng mục P&amp;L</th>
                        <th className="w-40 px-3 py-2 text-right">Số tiền (đ)</th>
                        <th className="w-44 px-3 py-2">Ghi chú dòng</th>
                        <th className="w-10 px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {createLines.map((line, index) => (
                        <tr key={line.key}>
                          <td className="px-3 py-2 text-xs font-bold text-slate-400">{index + 1}</td>
                          <td className="px-3 py-2">
                            <SearchableSelect
                              value={line.pnlItemCode}
                              onChange={(pnlItemCode) => updateCreateLine(line.key, { pnlItemCode })}
                              placeholder="-- Chưa phân loại P&L --"
                              options={[
                                { value: "", label: "-- Chưa phân loại P&L --" },
                                ...pnlItems
                                  .filter((item) => ["OPEX", "COGS"].includes((item.group || "").toUpperCase()))
                                  .map((item) => ({ value: item.code, label: `${item.code} - ${item.name}` })),
                              ]}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min="1"
                              value={line.amount}
                              onChange={(event) => updateCreateLine(line.key, { amount: event.target.value })}
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-right text-sm font-bold outline-none focus:border-blue-500"
                              required
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              value={line.note}
                              onChange={(event) => updateCreateLine(line.key, { note: event.target.value })}
                              placeholder="VD: Điện tháng 9"
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              type="button"
                              onClick={() => removeCreateLine(line.key)}
                              disabled={createLines.length === 1}
                              title={createLines.length === 1 ? "Phiếu cần ít nhất một dòng" : "Bỏ dòng này"}
                              className="text-slate-400 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30"
                              aria-label={`Bỏ dòng ${index + 1}`}
                            >
                              <span className="material-symbols-outlined text-[18px] leading-none">delete</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-200">
                        <td colSpan={5} className="px-3 py-2">
                          <button
                            type="button"
                            onClick={addCreateLine}
                            className="inline-flex items-center gap-1 rounded-lg border border-dashed border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700 hover:bg-blue-100"
                          >
                            <span className="material-symbols-outlined text-[16px] leading-none">add</span>
                            Thêm dòng hạng mục
                          </button>
                        </td>
                      </tr>
                      <tr className="border-t border-slate-200 [&_td]:bg-slate-50 [&_td:first-child]:rounded-bl-lg [&_td:last-child]:rounded-br-lg">
                        <td colSpan={2} className="px-3 py-2 text-xs font-bold text-slate-600">Tổng cộng · {createLines.length} {createLines.length > 1 ? "hạng mục" : "dòng"}</td>
                        <td className="px-3 py-2 text-right text-sm font-extrabold text-slate-900">{money(createTotal)}</td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
              {createError && (
                <p className="col-span-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">{createError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">
                Đóng
              </button>
              <button type="submit" disabled={createSaving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-60">
                {createSaving ? "Đang tạo..." : "Tạo công nợ"}
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

      <ConfirmDeleteDialog
        open={Boolean(deletingGroup)}
        title={`Xoá cả phiếu công nợ ${deletingGroup?.groupCode || ""}?`}
        description={deletingGroup ? `${deletingGroup.rows.length} dòng hạng mục · ${money(deletingGroup.rows.reduce((sum, row) => sum + Math.abs(row.amount), 0))} đ sẽ cùng chuyển vào Thùng rác.` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => {
          setDeletingGroup(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDeleteGroup}
      />
    </div>
  );
}
