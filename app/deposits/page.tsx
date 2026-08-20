"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { BranchScopeSelect, resolveInitialBranchScope } from "@/components/BranchScopeSelect";
import { DateInput } from "@/components/DateInput";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { storeLabel } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, canPerformMenuAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { filterMoneySources, firstMoneySourceCode, isMoneySourceAllowed, moneySourceDebugLabel, moneySourceDisplayName } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import { PartnerPicker } from "@/components/PartnerPicker";

type DepositHistory = {
  id: string;
  action: string;
  amount: number | null;
  actionDate: string | null;
  treatmentNote: string | null;
  note: string | null;
  actor: string | null;
  createdAt: string;
};

type Deposit = {
  id: string;
  code: string;
  receivedDate: string;
  partnerCode: string;
  partnerName: string;
  objectName: string | null;
  branchCode: string;
  moneySourceCode: string | null;
  amount: number;
  remainingAmount: number;
  purpose: string;
  status: string;
  note: string | null;
  histories: DepositHistory[];
};

type MasterDataOption = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
};

// Không đặt sẵn số tiền hay khách hàng: giá trị mẫu bị bỏ quên sẽ tạo ra phiếu cọc sai số tiền
// mà mọi lớp kiểm tra đều cho qua, vì nó vẫn là một số hợp lệ.
const emptyForm = {
  receivedDate: new Date().toISOString().slice(0, 10),
  partnerCode: "",
  partnerName: "",
  objectName: "",
  branchCode: "",
  moneySourceCode: "",
  amount: "",
  purpose: "Đặt cọc hợp đồng dịch vụ",
  note: "",
};

const statusLabels: Record<string, string> = {
  HOLDING: "Đang giữ cọc",
  OFFSET: "Đã cấn trừ",
  REFUNDED: "Đã hoàn",
  CANCELLED: "Đã hủy",
  REVENUE: "Chuyển doanh thu",
};

/** Các bút toán lịch sử chỉ mang tính ghi nhận ban đầu, không tính là đã xử lý cọc. */
const initialDepositActions = ["CREATE", "COLLECT", "UPDATE"];

// Ba lựa chọn hoàn cùng ghi sổ REFUND, chỉ khác lý do (lưu ở treatmentNote) để thống kê
// được vì sao hoàn — theo đúng các hướng xử lý trên file theo dõi cọc của khách.
const depositActionOptions = [
  { key: "OFFSET", value: "OFFSET", label: "Can tru vao bill", requiresAmount: true },
  { key: "SUPPLEMENT", value: "SUPPLEMENT", label: "Khach chuyen bo sung", requiresAmount: true },
  { key: "REFUND", value: "REFUND", label: "Hoan coc", requiresAmount: false },
  { key: "REFUND_AFTER_PAYMENT", value: "REFUND", label: "Hoan coc khi cty khach thanh toan lai", requiresAmount: false },
  { key: "REFUND_NO_ACTIVITY", value: "REFUND", label: "Hoan coc do khong co phat sinh", requiresAmount: false },
  { key: "TRANSFER_REVENUE", value: "TRANSFER_REVENUE", label: "Chuyen doanh thu", requiresAmount: false },
] as const;

export default function DepositsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState("");
  const [focusedCode, setFocusedCode] = useState("");
  const [focusedHistoryId, setFocusedHistoryId] = useState("");
  const [hasLoadedDeposits, setHasLoadedDeposits] = useState(false);
  const [message, setMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [branches, setBranches] = useState<MasterDataOption[]>([]);
  const [partners, setPartners] = useState<MasterDataOption[]>([]);
  const [moneySources, setMoneySources] = useState<MasterDataOption[]>([]);
  const [branchScope, setBranchScope] = useState("ALL");
  /** Phiếu cọc đang sửa; null nghĩa là biểu mẫu đang ở chế độ tạo mới. */
  const [editingDeposit, setEditingDeposit] = useState<Deposit | null>(null);
  const [deletingDeposit, setDeletingDeposit] = useState<Deposit | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [processForm, setProcessForm] = useState({
    depositId: "",
    action: "OFFSET",
    actionDate: new Date().toISOString().slice(0, 10),
    amount: "",
    note: "",
  });

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/deposits");
    if (!raw) {
      router.push("/login?next=/deposits");
      return;
    }
    try {
      const session = JSON.parse(raw) as DemoSession;
      if (!menu || !canAccessMenu(session.role, menu)) {
        router.push("/");
        return;
      }
      window.setTimeout(() => {
        const query = new URLSearchParams(window.location.search);
        setSearch(query.get("search")?.trim() || "");
        setFocusedCode(query.get("focus")?.trim() || "");
        setFocusedHistoryId(query.get("history")?.trim() || "");
        setUser(session);
        const initialBranch = resolveInitialBranchScope(session);
        setBranchScope(initialBranch);
        if (initialBranch !== "ALL") {
          setForm((current) => ({ ...current, branchCode: initialBranch }));
        }
        setIsCheckingAuth(false);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/deposits");
    }
  }, [router]);

  const formatCurrency = (amount: number) => new Intl.NumberFormat("vi-VN").format(amount);
  const canCreateDeposits = user ? canPerformAction(user, "create") : false;
  const canProcessDeposits = user ? canPerformAction(user, "edit") : false;
  // Nút "+" tạo nhanh đối tác đi qua API danh mục nên cần đúng quyền cấu hình danh mục.
  const canCreatePartner = user ? canPerformMenuAction(user, "/settings", "config") : false;
  /** Biểu mẫu bên trái hiện ra khi được tạo mới hoặc khi đang sửa một phiếu cọc. */
  const showDepositForm = canCreateDeposits || Boolean(editingDeposit);
  const depositFormRef = useRef<HTMLFormElement>(null);
  const focusedRowRef = useRef<HTMLTableRowElement>(null);
  const [depositPanelHeight, setDepositPanelHeight] = useState<number | null>(null);

  useEffect(() => {
    const formElement = depositFormRef.current;
    if (!showDepositForm || !formElement) {
      setDepositPanelHeight(null);
      return;
    }
    const updateHeight = () => setDepositPanelHeight(Math.ceil(formElement.getBoundingClientRect().height));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(formElement);
    return () => observer.disconnect();
  }, [showDepositForm]);

  useEffect(() => {
    if (!focusedCode || !focusedRowRef.current) return;
    const timer = window.setTimeout(() => {
      focusedRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    return () => window.clearTimeout(timer);
  }, [deposits, focusedCode]);

  /** Phiếu cọc đã cấn trừ/hoàn/hủy thì không cho sửa; trả về lý do để hiện tooltip. */
  const editLockReason = (deposit: Deposit) => {
    if (deposit.status !== "HOLDING") return "Phiếu cọc đã cấn trừ/hoàn/hủy, không thể sửa";
    return null;
  };

  /** Đã phát sinh xử lý cọc thì phải giữ lại để không mất dấu dòng tiền. */
  const deleteLockReason = (deposit: Deposit) => {
    if (deposit.status !== "HOLDING") return "Phiếu cọc đã cấn trừ/hoàn/hủy, không thể xoá";
    if (deposit.remainingAmount !== deposit.amount) {
      return "Phiếu cọc đã phát sinh cấn trừ/hoàn cọc, không thể xoá. Hãy dùng thao tác hủy phiếu cọc.";
    }
    if (deposit.histories.some((history) => !initialDepositActions.includes(history.action))) {
      return "Phiếu cọc đã phát sinh xử lý, không thể xoá. Hãy dùng thao tác hủy phiếu cọc.";
    }
    return null;
  };

  const loadDeposits = async (searchOverride?: string) => {
    setHasLoadedDeposits(false);
    setMessage("");
    const params = new URLSearchParams();
    const effectiveSearch = searchOverride ?? search;
    if (effectiveSearch.trim()) params.set("search", effectiveSearch.trim());
    params.set("branchCode", branchScope);
    const response = await fetch(`/api/deposits?${params.toString()}`);
    if (!response.ok) {
      setMessage("Không tải được danh sách tiền cọc");
      setHasLoadedDeposits(true);
      return;
    }
    setDeposits((await response.json()) as Deposit[]);
    setHasLoadedDeposits(true);
  };

  const clearDepositSearch = async () => {
    setSearch("");
    setFocusedCode("");
    setFocusedHistoryId("");
    router.replace("/deposits");
    await loadDeposits("");
  };

  const loadMasterData = async () => {
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      const headers: Record<string, string> = rawSession ? { "x-demo-session": encodeURIComponent(rawSession) } : {};
      const response = await fetch("/api/master-data?status=ACTIVE", { headers });
      if (response.ok) {
        const data = (await response.json()) as MasterDataOption[];
        const activeBranches = data.filter((item) => item.type === "BRANCH");
        const activePartners = data.filter((item) => item.type === "PARTNER");
        const activeMoneySources = data.filter((item) => item.type === "MONEY_SOURCE");
        setBranches(activeBranches);
        setPartners(activePartners);
        setMoneySources(activeMoneySources);
        
        // Update form with default values if they are empty
        setForm(prev => {
          const firstBranch = branchScope !== "ALL" ? branchScope : activeBranches[0]?.code || "";
          const firstMoneySource = firstMoneySourceCode(activeMoneySources, firstBranch);
          return {
            ...prev,
            branchCode: branchScope !== "ALL" ? firstBranch : prev.branchCode || firstBranch,
            // Khách hàng phải do người lập chọn, không tự lấy đối tác đầu danh mục.
            partnerCode: prev.partnerCode,
            partnerName: prev.partnerName,
            moneySourceCode: isMoneySourceAllowed(activeMoneySources, prev.moneySourceCode, branchScope !== "ALL" ? firstBranch : prev.branchCode || firstBranch)
              ? prev.moneySourceCode
              : firstMoneySource,
          };
        });
      }
    } catch (error) {
      console.error("Failed to load master data", error);
    }
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        loadDeposits();
        loadMasterData();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCheckingAuth, branchScope]);

  const handlePartnerChange = (code: string) => {
    const p = partners.find(item => item.code === code);
    setForm(value => ({
      ...value,
      partnerCode: code,
      partnerName: p ? p.name : "",
    }));
  };

  const resetDepositForm = () => {
    setEditingDeposit(null);
    setForm((current) => {
      const nextBranch = branchScope !== "ALL" ? branchScope : current.branchCode;
      return { ...emptyForm, branchCode: nextBranch, moneySourceCode: firstMoneySourceCode(moneySources, nextBranch) };
    });
  };

  const startEditDeposit = (deposit: Deposit) => {
    setMessage("");
    setEditingDeposit(deposit);
    setForm({
      receivedDate: deposit.receivedDate.slice(0, 10),
      partnerCode: deposit.partnerCode,
      partnerName: deposit.partnerName,
      objectName: deposit.objectName || "",
      branchCode: deposit.branchCode,
      moneySourceCode: deposit.moneySourceCode || "",
      amount: String(deposit.amount),
      purpose: deposit.purpose,
      note: deposit.note || "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitDeposit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingDeposit && !canCreateDeposits) {
      setMessage("Bạn chỉ có quyền xem tiền cọc.");
      return;
    }
    if (!form.partnerCode.trim()) {
      setMessage("Vui lòng chọn Khách hàng cho phiếu cọc.");
      return;
    }
    const amountValue = Number(form.amount);
    if (!form.amount.trim() || !Number.isFinite(amountValue) || amountValue <= 0) {
      setMessage("Vui lòng nhập Số tiền cọc lớn hơn 0.");
      return;
    }
    setIsSaving(true);
    setMessage("");
    try {
      const response = editingDeposit
        ? await fetch("/api/deposits", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...form, action: "UPDATE", id: editingDeposit.id, actor: user?.name }),
          })
        : await fetch("/api/deposits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...form, actor: user?.name }),
          });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || (editingDeposit ? "Không lưu được thay đổi" : "Không tạo được phiếu cọc"));
      }
      const savedMessage = editingDeposit ? `Đã lưu thay đổi phiếu cọc ${editingDeposit.code}.` : "Đã tạo phiếu cọc mới.";
      resetDepositForm();
      // loadDeposits() tự xoá thông báo cũ nên phải báo thành công sau khi tải lại danh sách.
      await loadDeposits();
      setMessage(savedMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Có lỗi khi lưu phiếu cọc");
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDeleteDeposit = async (reason: string) => {
    if (!deletingDeposit) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingDeposit.id });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/deposits?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được phiếu cọc");
        return;
      }
      if (editingDeposit?.id === deletingDeposit.id) resetDepositForm();
      const deletedCode = deletingDeposit.code;
      setDeletingDeposit(null);
      await loadDeposits();
      setMessage(`Đã chuyển phiếu cọc ${deletedCode} vào Thùng rác.`);
    } finally {
      setDeleting(false);
    }
  };

  const selectedDeposit = deposits.find((deposit) => deposit.id === processForm.depositId) || null;
  // processForm.action giữ `key` của lựa chọn (ba kiểu hoàn cùng value REFUND nên value không đủ phân biệt).
  const selectedAction = depositActionOptions.find((action) => action.key === processForm.action) || depositActionOptions[0];

  const openProcessForm = (deposit: Deposit, action = "OFFSET") => {
    const option = depositActionOptions.find((item) => item.key === action) || depositActionOptions[0];
    setProcessForm({
      depositId: deposit.id,
      action: option.key,
      actionDate: new Date().toISOString().slice(0, 10),
      amount: option.requiresAmount && option.value !== "SUPPLEMENT" ? String(deposit.remainingAmount) : "",
      note: option.label,
    });
  };

  const submitProcessDeposit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canProcessDeposits) {
      setMessage("Bạn không có quyền xử lý tiền cọc.");
      return;
    }
    if (!selectedDeposit) return;

    const amount = selectedAction.requiresAmount ? Number(processForm.amount) : selectedDeposit.remainingAmount;
    if (selectedAction.requiresAmount && (!amount || amount <= 0)) {
      setMessage("Số tiền xử lý phải lớn hơn 0.");
      return;
    }

    const response = await fetch("/api/deposits", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: selectedDeposit.id,
        action: selectedAction.value,
        actionDate: processForm.actionDate,
        amount,
        actor: user?.name,
        treatmentNote: selectedAction.label,
        note: processForm.note || selectedAction.label,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không xử lý được phiếu cọc");
      return;
    }
    setProcessForm({ depositId: "", action: "OFFSET", actionDate: new Date().toISOString().slice(0, 10), amount: "", note: "" });
    setMessage("Đã xử lý phiếu cọc.");
    await loadDeposits();
  };

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold">Quản trị Tiền cọc</h1>
            <p className="text-xs text-slate-500">Nhóm B 2.1 - 2.3: ghi nhận, cấn trừ, hoàn/hủy cọc.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <BranchScopeSelect session={user} value={branchScope} onChange={setBranchScope} />
          <p className="hidden text-xs font-bold text-slate-500 sm:block">{user?.role}</p>
        </div>
      </header>

      <main
        className="max-w-[1800px] mx-auto p-4 xl:p-5 grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] items-start gap-4 xl:gap-5"
        style={{ "--deposit-panel-height": depositPanelHeight ? `${depositPanelHeight}px` : "auto" } as CSSProperties}
      >
        {!canCreateDeposits && !editingDeposit && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-5 h-fit">
            <p className="text-xs font-bold text-blue-600 uppercase">Quyền truy cập</p>
            <h2 className="font-bold text-lg mt-1">Chỉ xem tiền cọc</h2>
            <p className="text-sm text-slate-500 mt-2">
              Vai trò hiện tại được xem danh sách tiền cọc, không được tạo phiếu mới.
            </p>
          </div>
        )}

        <form ref={depositFormRef} onSubmit={submitDeposit} className={`bg-white border border-slate-200 rounded-xl shadow-sm p-5 space-y-4 ${showDepositForm ? "" : "hidden"}`}>
          <div>
            <p className="text-xs font-bold text-blue-600 uppercase">2.1 Ghi nhận cọc</p>
            <h2 className="font-bold text-lg mt-1">
              {editingDeposit ? `Sửa phiếu cọc ${editingDeposit.code}` : "Tạo phiếu cọc"}
            </h2>
          </div>

          <label className="text-xs font-bold text-slate-600 block">
            Ngày nhận cọc *
            <DateInput value={form.receivedDate} onChange={(receivedDate) => setForm((value) => ({ ...value, receivedDate }))} className="mt-1" required ariaLabel="Ngày nhận cọc" />
          </label>

          <div className="text-xs font-bold text-slate-600 block">
            Khách hàng *
            <PartnerPicker
              className="mt-1"
              value={form.partnerCode}
              onChange={handlePartnerChange}
              options={partners.map((item) => ({ value: item.code, label: `[${item.code}] ${item.name}` }))}
              required
              canCreate={canCreatePartner}
              defaultPartnerType="CUSTOMER"
              onCreated={(partner) => {
                setPartners((current) => [...current, partner]);
                setForm((value) => ({ ...value, partnerCode: partner.code, partnerName: partner.name }));
              }}
            />
          </div>

          <label className="text-xs font-bold text-slate-600 block">
            Tên khách hàng
            <input
              value={form.partnerName}
              readOnly
              className="mt-1 w-full border border-slate-200 bg-slate-50 text-slate-500 rounded-lg px-3 py-2 text-sm outline-none cursor-not-allowed"
              placeholder="Tên khách hàng tự động điền"
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Đối tượng
            <input
              type="text"
              value={form.objectName}
              onChange={(event) => setForm((value) => ({ ...value, objectName: event.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              placeholder="Nhập đối tượng (không bắt buộc)"
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Cửa hàng *
            <select
              value={form.branchCode}
              onChange={(e) => {
                const nextBranch = e.target.value;
                setForm((val) => ({
                  ...val,
                  branchCode: nextBranch,
                  moneySourceCode: isMoneySourceAllowed(moneySources, val.moneySourceCode, nextBranch)
                    ? val.moneySourceCode
                    : firstMoneySourceCode(moneySources, nextBranch),
                }));
              }}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">-- Chọn cửa hàng --</option>
              {branches
                .filter((item) => branchScope === "ALL" || item.code === branchScope)
                .map(item => (
                  <option key={item.id} value={item.code}>
                    {storeLabel(item.code)}
                  </option>
                ))}
            </select>
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Nguồn tiền *
            <select
              value={form.moneySourceCode}
              onChange={(e) => setForm(val => ({ ...val, moneySourceCode: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            >
              <option value="">-- Chọn nguồn tiền --</option>
              {filterMoneySources(moneySources, form.branchCode).map(item => (
                <option key={item.id} value={item.code} title={moneySourceDebugLabel(item, storeLabel(form.branchCode))}>
                  {moneySourceDisplayName(item, storeLabel(form.branchCode))}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Số tiền *
            <input
              type="number"
              min="1"
              value={form.amount}
              onChange={(e) => setForm(val => ({ ...val, amount: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              placeholder="Nhập số tiền cọc"
              required
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Nội dung cọc *
            <input
              type="text"
              value={form.purpose}
              onChange={(e) => setForm(val => ({ ...val, purpose: e.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              required
            />
          </label>

          <label className="text-xs font-bold text-slate-600 block">
            Ghi chú
            <textarea
              value={form.note}
              onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
              className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              placeholder="Nhập ghi chú thêm..."
            />
          </label>

          {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}

          <div className="flex gap-2">
            {editingDeposit && (
              <button
                type="button"
                onClick={resetDepositForm}
                className="px-4 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-lg py-2.5 text-sm font-bold transition-colors"
              >
                Huỷ
              </button>
            )}
            <button disabled={isSaving} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold transition-colors">
              {isSaving ? "Đang lưu..." : editingDeposit ? "Lưu thay đổi" : "Tạo phiếu cọc"}
            </button>
          </div>
        </form>

        <section className="flex h-fit flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm xl:h-[var(--deposit-panel-height)]">
          <div className="p-5 border-b border-slate-200 flex flex-col md:flex-row gap-3 md:items-center justify-between">
            <div>
              <h2 className="font-bold">Danh sách tiền cọc</h2>
              <p className="text-xs text-slate-500 mt-1">Cấn trừ không được vượt số tiền còn lại.</p>
            </div>
            <div className="flex gap-2">
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setFocusedCode("");
                  setFocusedHistoryId("");
                }}
                className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
                placeholder="Tìm mã/khách hàng/đối tượng..."
              />
              <button onClick={() => void loadDeposits()} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold hover:bg-slate-50">Tìm</button>
              {(search || focusedCode) && (
                <button
                  type="button"
                  onClick={() => void clearDepositSearch()}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50"
                >
                  Xóa lọc
                </button>
              )}
            </div>
          </div>

          {focusedCode && hasLoadedDeposits && (
            <div className={`mx-5 mt-4 rounded-lg border px-3 py-2 text-sm ${deposits.some((deposit) => deposit.code === focusedCode) ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700"}`}>
              {deposits.some((deposit) => deposit.code === focusedCode)
                ? (() => {
                    const focusedDeposit = deposits.find((deposit) => deposit.code === focusedCode);
                    const focusedHistory = focusedDeposit?.histories.find((history) => history.id === focusedHistoryId);
                    if (!focusedHistoryId || !focusedHistory) {
                      return <>Đang hiển thị phiếu nguồn <strong>{focusedCode}</strong>.</>;
                    }
                    const historyAmount = Math.abs(focusedHistory.amount || 0);
                    const historyLabel = focusedHistory.action === "UPDATE"
                      ? (Number(focusedHistory.amount) < 0 ? "Điều chỉnh giảm phiếu cọc" : "Điều chỉnh tăng phiếu cọc")
                      : (focusedHistory.treatmentNote || focusedHistory.action);
                    return (
                      <>
                        Đang truy vết: <strong>{historyLabel}</strong>
                        {historyAmount > 0 ? <> · <strong>{formatCurrency(historyAmount)} đ</strong></> : null}
                        {focusedDeposit ? <> · Giá trị hiện tại của phiếu: <strong>{formatCurrency(focusedDeposit.amount)} đ</strong></> : null}.
                      </>
                    );
                  })()
                : <>Không tìm thấy phiếu nguồn <strong>{focusedCode}</strong> trong phạm vi cửa hàng hiện tại.</>}
            </div>
          )}

          {message && !showDepositForm && (
            <p className="mx-5 mt-4 text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>
          )}

          {selectedDeposit && (
            <form onSubmit={submitProcessDeposit} className="border-b border-slate-200 bg-blue-50/60 p-4">
              <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_140px_1fr_1.4fr_auto] lg:items-end">
                <div>
                  <p className="text-[11px] font-bold uppercase text-blue-700">Xử lý tiền cọc</p>
                  <p className="mt-1 text-sm font-bold text-slate-900"><CopyableText value={selectedDeposit.code} /> - {selectedDeposit.partnerName}</p>
                  <p className="text-xs text-slate-500">Còn giữ: {formatCurrency(selectedDeposit.remainingAmount)} đ</p>
                </div>
                <label className="text-xs font-bold text-slate-600">
                  Hướng xử lý
                  <select
                    value={processForm.action}
                    onChange={(event) => {
                      const nextAction = depositActionOptions.find((item) => item.key === event.target.value) || depositActionOptions[0];
                      setProcessForm((value) => ({
                        ...value,
                        action: nextAction.key,
                        amount: nextAction.requiresAmount && nextAction.value !== "SUPPLEMENT" ? String(selectedDeposit.remainingAmount) : "",
                        note: nextAction.label,
                      }));
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  >
                    {depositActionOptions.map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Ngày xử lý
                  <DateInput
                    value={processForm.actionDate}
                    onChange={(actionDate) => setProcessForm((value) => ({ ...value, actionDate }))}
                    className="mt-1"
                    required
                    ariaLabel="Ngày xử lý tiền cọc"
                  />
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Số tiền
                  <input
                    type="number"
                    value={selectedAction.requiresAmount ? processForm.amount : selectedDeposit.remainingAmount}
                    onChange={(event) => setProcessForm((value) => ({ ...value, amount: event.target.value }))}
                    readOnly={!selectedAction.requiresAmount}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 read-only:bg-slate-100"
                  />
                </label>
                <label className="text-xs font-bold text-slate-600">
                  Ghi chú xử lý
                  <input
                    value={processForm.note}
                    onChange={(event) => setProcessForm((value) => ({ ...value, note: event.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  />
                </label>
                <div className="flex gap-2">
                  <button type="submit" className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-bold text-white hover:bg-blue-700">Lưu</button>
                  <button type="button" onClick={() => setProcessForm({ depositId: "", action: "OFFSET", actionDate: new Date().toISOString().slice(0, 10), amount: "", note: "" })} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50">Hủy</button>
                </div>
              </div>
            </form>
          )}

          <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto custom-scrollbar">
            <table className="w-full min-w-[1030px] text-left text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b border-slate-200 sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="w-[130px] px-4 py-3">Phiếu cọc</th>
                  <th className="w-[150px] px-4 py-3">Khách hàng</th>
                  <th className="w-[180px] px-4 py-3">Đối tượng</th>
                  <th className="w-[130px] px-4 py-3">Số tiền</th>
                  <th className="w-[150px] px-4 py-3">Trạng thái</th>
                  <th className="w-[290px] px-4 py-3 text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deposits.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-slate-400">Chưa có phiếu cọc.</td></tr>
                ) : deposits.map((deposit) => {
                  const isFocused = deposit.code === focusedCode;
                  return (
                  <tr
                    key={deposit.id}
                    ref={isFocused ? focusedRowRef : undefined}
                    className={isFocused ? "bg-amber-50 ring-2 ring-inset ring-amber-300" : "hover:bg-slate-50"}
                  >
                    <td className="px-4 py-3">
                      <p className="font-bold"><CopyableText value={deposit.code} /></p>
                      <p className="text-xs text-slate-500">{storeLabel(deposit.branchCode)} - {deposit.moneySourceCode || "Số dư đầu kỳ"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold">{deposit.partnerName}</p>
                      <p className="text-xs text-slate-500">{deposit.purpose}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-700">{deposit.objectName || "—"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-bold">{formatCurrency(deposit.amount)} đ</p>
                      <p className="text-xs text-emerald-600">Còn: {formatCurrency(deposit.remainingAmount)} đ</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-bold bg-slate-100 rounded px-2 py-1">{statusLabels[deposit.status] || deposit.status}</span>
                      {deposit.histories[0] && (
                        <p className="mt-1 text-[11px] text-slate-500">
                          {deposit.histories[0].treatmentNote || deposit.histories[0].action}
                          {" · "}
                          {new Date(deposit.histories[0].actionDate || deposit.histories[0].createdAt).toLocaleDateString("vi-VN")}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                        {canProcessDeposits && (
                          <>
                            <button onClick={() => openProcessForm(deposit, "OFFSET")} disabled={deposit.remainingAmount <= 0} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-bold text-blue-700 transition hover:bg-blue-100 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300">Cấn trừ</button>
                            <button onClick={() => openProcessForm(deposit, "SUPPLEMENT")} className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-bold text-slate-700 transition hover:bg-slate-100">Bổ sung</button>
                            <button onClick={() => openProcessForm(deposit, "REFUND")} disabled={deposit.remainingAmount <= 0} className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 transition hover:bg-emerald-100 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300">Hoàn</button>
                            <button onClick={() => openProcessForm(deposit, "TRANSFER_REVENUE")} disabled={deposit.remainingAmount <= 0} className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700 transition hover:bg-amber-100 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-300">Chuyển DT</button>
                          </>
                        )}
                        <RowActions
                          session={user}
                          module="/deposits"
                          compact
                          onEdit={() => startEditDeposit(deposit)}
                          onDelete={() => {
                            setDeleteError(null);
                            setDeletingDeposit(deposit);
                          }}
                          editDisabledReason={editLockReason(deposit)}
                          deleteDisabledReason={deleteLockReason(deposit)}
                        />
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <ConfirmDeleteDialog
        open={Boolean(deletingDeposit)}
        title={`Xoá phiếu cọc ${deletingDeposit?.code || ""}?`}
        description={deletingDeposit ? `${deletingDeposit.partnerName} · ${formatCurrency(deletingDeposit.amount)} đ` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => {
          setDeletingDeposit(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDeleteDeposit}
      />
    </div>
  );
}
