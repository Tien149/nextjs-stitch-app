"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { ModuleFrame } from "@/components/ModuleFrame";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { storeLabel, visibleStoreOptions } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { filterMoneySources, firstMoneySourceCode, isMoneySourceAllowed, moneySourceDebugLabel, moneySourceDisplayName } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import { shiftLabel, WORK_SHIFTS } from "@/lib/shifts";

const voucherMoneySourceGroups = ["CASH"];

type Voucher = {
  id: string;
  code: string;
  voucherType: string;
  voucherDate: string;
  partnerCode: string | null;
  partnerName: string;
  branchCode: string;
  moneySourceCode: string;
  categoryCode: string | null;
  amount: number;
  description: string;
  status: string;
  shift: string | null;
  depositAction: string | null;
  depositCode: string | null;
};

type MasterDataOption = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
  partnerType?: string | null;
  partnerGroup?: string | null;
  status?: string;
};

const fallbackVoucherCategories: MasterDataOption[] = [
  { id: "fallback-rev-food", type: "REVENUE_EXPENSE_CATEGORY", code: "REV_FOOD", name: "Doanh thu am thuc", group: "REVENUE_SOURCE", branch: null },
  { id: "fallback-rev-other", type: "REVENUE_EXPENSE_CATEGORY", code: "REV_OTHER", name: "Doanh thu khac", group: "REVENUE_SOURCE", branch: null },
  { id: "fallback-exp-rent", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_RENT", name: "Chi phi thue mat bang", group: "OPEX", branch: null },
  { id: "fallback-exp-salary", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_SALARY", name: "Chi phi luong nhan vien", group: "OPEX", branch: null },
  { id: "fallback-exp-marketing", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_MARKETING", name: "Chi phi Marketing", group: "OPEX", branch: null },
  { id: "fallback-exp-other", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_OTHER", name: "Chi phi khac", group: "OPEX", branch: null },
];

function normalizeCategoryGroup(group: string | null | undefined) {
  const raw = (group || "").toUpperCase();
  if (raw.includes("REVENUE") || raw.includes("DOANH") || raw.includes("NGUON")) return "REVENUE_SOURCE";
  if (raw.includes("COGS") || raw.includes("GIA")) return "COGS";
  if (raw.includes("CAPEX")) return "CAPEX";
  if (raw.includes("OPEX")) return "OPEX";
  return raw;
}

const emptyForm = {
  voucherType: "RECEIPT",
  voucherDate: new Date().toISOString().slice(0, 10),
  shift: "MORNING",
  depositAction: "",
  depositCode: "",
  partnerCode: "",
  partnerName: "Khách hàng mua lẻ",
  branchCode: "HCM",
  moneySourceCode: "CASH_HCM",
  categoryCode: "",
  amount: "50000000",
  description: "Thu tiền bán hàng hàng ngày / thanh toán đối tác",
  status: "DRAFT",
};

export default function VouchersPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [branchCode, setBranchCode] = useState("ALL");
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  /** Chứng từ đang sửa; null nghĩa là biểu mẫu đang ở chế độ tạo mới. */
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);
  const [deletingVoucher, setDeletingVoucher] = useState<Voucher | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [moneySources, setMoneySources] = useState<MasterDataOption[]>([]);
  const [categories, setCategories] = useState<MasterDataOption[]>([]);
  const [partners, setPartners] = useState<MasterDataOption[]>([]);

  const loadVouchers = useCallback(async (branch: string) => {
    const response = await fetch(`/api/vouchers?branchCode=${branch}`);
    if (response.ok) setVouchers((await response.json()) as Voucher[]);
  }, []);

  const loadMasterData = useCallback(async () => {
    const rawSession = localStorage.getItem(SESSION_KEY);
    const headers: Record<string, string> = rawSession ? { "x-demo-session": encodeURIComponent(rawSession) } : {};
    const [moneyResponse, categoryResponse, partnerResponse] = await Promise.all([
      fetch("/api/master-data?type=MONEY_SOURCE&status=ACTIVE", { headers }),
      fetch("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE", { headers }),
      fetch("/api/master-data?type=PARTNER&status=ACTIVE", { headers }),
    ]);
    if (moneyResponse.ok) {
      const sources = (await moneyResponse.json()) as MasterDataOption[];
      setMoneySources(sources);
      setForm((current) => {
        const nextBranch = current.branchCode || "HCM";
        const nextSource = isMoneySourceAllowed(sources, current.moneySourceCode, nextBranch, voucherMoneySourceGroups)
          ? current.moneySourceCode
          : firstMoneySourceCode(sources, nextBranch, voucherMoneySourceGroups);
        return { ...current, branchCode: nextBranch, moneySourceCode: nextSource };
      });
    }
    if (categoryResponse.ok) {
      setCategories((await categoryResponse.json()) as MasterDataOption[]);
    }
    if (partnerResponse.ok) {
      setPartners((await partnerResponse.json()) as MasterDataOption[]);
    }
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/vouchers");
    if (!raw) {
      router.push("/login?next=/vouchers");
      return;
    }
    const session = JSON.parse(raw) as DemoSession;
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }

    let initialBranch = "ALL";
    if (session.allowedBranches?.length === 1 && !session.allowedBranches.includes("ALL")) {
      initialBranch = session.allowedBranches[0];
    } else {
      initialBranch = localStorage.getItem("global_branch_code") || "ALL";
    }

    window.setTimeout(() => {
      setUser(session);
      setBranchCode(initialBranch);
      setLoading(false);
      void loadVouchers(initialBranch);
      void loadMasterData();
    }, 0);
  }, [router, loadVouchers, loadMasterData]);

  useEffect(() => {
    window.setTimeout(() => {
      setForm((f) => ({
        ...f,
        branchCode: branchCode === "ALL" ? f.branchCode || "HCM" : branchCode,
        moneySourceCode: isMoneySourceAllowed(moneySources, f.moneySourceCode, branchCode === "ALL" ? f.branchCode || "HCM" : branchCode, voucherMoneySourceGroups)
          ? f.moneySourceCode
          : firstMoneySourceCode(moneySources, branchCode === "ALL" ? f.branchCode || "HCM" : branchCode, voucherMoneySourceGroups),
      }));
    }, 0);
  }, [branchCode, moneySources]);

  const handleBranchChange = (code: string) => {
    setBranchCode(code);
    void loadVouchers(code);
  };

  const canCreate = user ? canPerformAction(user, "create") : false;
  const canApprove = user ? canPerformAction(user, "approve") : false;
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  const categoryName = (code: string | null) => {
    if (!code) return "Chưa gán khoản mục";
    const source = categories.length > 0 ? categories : fallbackVoucherCategories;
    return source.find((item) => item.code === code)?.name || code;
  };
  const normalizedCategoryOptions = useMemo(() => {
    const source = categories.length > 0 ? categories : fallbackVoucherCategories;
    return source.map((category) => ({
      ...category,
      group: normalizeCategoryGroup(category.group),
    }));
  }, [categories]);
  const categoryOptionsForType = useCallback(
    (voucherType: string) =>
      normalizedCategoryOptions.filter((category) => {
        const group = normalizeCategoryGroup(category.group);
        return voucherType === "RECEIPT" ? group === "REVENUE_SOURCE" : ["OPEX", "CAPEX", "COGS"].includes(group);
      }),
    [normalizedCategoryOptions],
  );
  const voucherCategoryOptions = useMemo(
    () => categoryOptionsForType(form.voucherType),
    [categoryOptionsForType, form.voucherType],
  );
  const partnerOptions = useMemo(() => {
    const availablePartners = partners.filter((partner) => {
      if (partner.status && partner.status !== "ACTIVE") return false;
      if (!partner.branch || partner.branch === "ALL") return true;
      return partner.branch === form.branchCode;
    }).filter((partner) => {
      const type = (partner.partnerType || partner.group || "").toUpperCase();
      if (form.voucherType === "RECEIPT") return ["CUSTOMER", "BOTH", "OTHER_PARTNER"].includes(type);
      return ["SUPPLIER", "BOTH", "EMPLOYEE", "OTHER_PARTNER"].includes(type);
    });
    const retailOption = { id: "retail-customer", type: "PARTNER", code: "", name: "Khách hàng mua lẻ", group: "CUSTOMER", branch: null };
    return form.voucherType === "RECEIPT" ? [
      retailOption,
      ...availablePartners,
    ] : [
      ...availablePartners,
    ];
  }, [form.branchCode, form.voucherType, partners]);

  const partnerSelectValue = useMemo(() => {
    const selected = partnerOptions.find((partner) =>
      (partner.code && partner.code === form.partnerCode) || partner.name === form.partnerName
    );
    return selected ? selected.id || selected.code || selected.name : "__CURRENT__";
  }, [form.partnerCode, form.partnerName, partnerOptions]);

  const applyPartnerSelection = (selectedKey: string) => {
    const selected = partnerOptions.find((partner) => (partner.id || partner.code || partner.name) === selectedKey);
    if (!selected) return;
    setForm((current) => ({
      ...current,
      partnerCode: selected.code,
      partnerName: selected.name,
    }));
  };

  useEffect(() => {
    if (editingVoucher || partnerOptions.length === 0) return;
    const currentPartnerStillAllowed = partnerOptions.some((partner) =>
      (partner.code && partner.code === form.partnerCode) || partner.name === form.partnerName
    );
    if (currentPartnerStillAllowed) return;
    const nextPartner = partnerOptions[0];
    window.setTimeout(() => {
      setForm((current) => ({
        ...current,
        partnerCode: nextPartner.code,
        partnerName: nextPartner.name,
      }));
    }, 0);
  }, [editingVoucher, form.partnerCode, form.partnerName, partnerOptions]);

  useEffect(() => {
    if (!form.categoryCode || voucherCategoryOptions.length === 0) return;
    if (voucherCategoryOptions.some((category) => category.code === form.categoryCode)) return;
    // Khoản mục đang chọn không thuộc loại phiếu hiện tại -> bỏ chọn thay vì ép sang mục khác.
    window.setTimeout(() => {
      setForm((current) => ({ ...current, categoryCode: "" }));
    }, 0);
  }, [form.categoryCode, voucherCategoryOptions]);

  /** Chứng từ đã ghi sổ hoặc đã huỷ thì không cho sửa/xoá; trả về lý do để hiện tooltip. */
  const lockedForChange = (voucher: Voucher) => {
    if (voucher.status === "APPROVED") return "Chứng từ đã duyệt. Bấm \"Bỏ duyệt\" để đưa về bản nháp rồi sửa hoặc xoá.";
    if (voucher.status === "POSTED") return "Chứng từ đã ghi sổ, không thể sửa hoặc xoá";
    if (voucher.status === "CANCELLED") return "Chứng từ đã huỷ";
    return null;
  };

  const resetForm = () => {
    setEditingVoucher(null);
    setForm({
      ...emptyForm,
      branchCode: branchCode === "ALL" ? "HCM" : branchCode,
      moneySourceCode: firstMoneySourceCode(moneySources, branchCode === "ALL" ? "HCM" : branchCode, voucherMoneySourceGroups),
      categoryCode: emptyForm.categoryCode,
    });
  };

  const startEditVoucher = (voucher: Voucher) => {
    setMessage("");
    setEditingVoucher(voucher);
    setForm({
      voucherType: voucher.voucherType,
      shift: voucher.shift || "MORNING",
      depositAction: voucher.depositAction || "",
      depositCode: voucher.depositCode || "",
      voucherDate: voucher.voucherDate.slice(0, 10),
      partnerCode: voucher.partnerCode || "",
      partnerName: voucher.partnerName,
      branchCode: voucher.branchCode,
      moneySourceCode: isMoneySourceAllowed(moneySources, voucher.moneySourceCode, voucher.branchCode, voucherMoneySourceGroups)
        ? voucher.moneySourceCode
        : firstMoneySourceCode(moneySources, voucher.branchCode, voucherMoneySourceGroups),
      categoryCode: voucher.categoryCode || "",
      amount: String(voucher.amount),
      description: voucher.description,
      status: voucher.status,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const submitVoucher = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");

    const response = editingVoucher
      ? await fetch("/api/vouchers", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, action: "UPDATE", id: editingVoucher.id }),
        })
      : await fetch("/api/vouchers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });

    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || (editingVoucher ? "Không lưu được thay đổi" : "Không tạo được chứng từ"));
      return;
    }

    setMessage(editingVoucher ? "Đã lưu thay đổi chứng từ." : "Đã tạo chứng từ.");
    resetForm();
    await loadVouchers(branchCode);
  };

  const confirmDeleteVoucher = async (reason: string) => {
    if (!deletingVoucher) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingVoucher.id });
      if (reason) query.set("reason", reason);
      const response = await fetch(`/api/vouchers?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) {
        setDeleteError(payload.error || "Không xoá được chứng từ");
        return;
      }
      setMessage(`Đã chuyển chứng từ ${deletingVoucher.code} vào Thùng rác.`);
      if (editingVoucher?.id === deletingVoucher.id) resetForm();
      setDeletingVoucher(null);
      await loadVouchers(branchCode);
    } finally {
      setDeleting(false);
    }
  };

  const approveVoucher = async (id: string) => {
    const response = await fetch("/api/vouchers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "APPROVED" }),
    });
    if (response.ok) await loadVouchers(branchCode);
  };

  const unapproveVoucher = async (voucher: Voucher) => {
    if (!window.confirm(
      `Bỏ duyệt chứng từ ${voucher.code}?\n\nChứng từ sẽ quay về bản nháp để sửa lại. Các phát sinh từ lần duyệt trước (tiền cọc, công nợ, khoản phân bổ) sẽ được hoàn tác.`
    )) return;
    const response = await fetch("/api/vouchers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: voucher.id, status: "DRAFT" }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không bỏ duyệt được chứng từ");
      return;
    }
    setMessage(`Đã bỏ duyệt chứng từ ${voucher.code}. Giờ có thể sửa hoặc xoá.`);
    await loadVouchers(branchCode);
  };

  const cancelVoucher = async (id: string) => {
    const response = await fetch("/api/vouchers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status: "CANCELLED" }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error || "Không hủy được chứng từ");
      return;
    }
    setMessage("Đã hủy chứng từ.");
    await loadVouchers(branchCode);
  };

  const totalReceipts = vouchers.filter(v => v.voucherType === "RECEIPT").reduce((sum, v) => sum + v.amount, 0);
  const totalPayments = vouchers.filter(v => v.voucherType === "PAYMENT").reduce((sum, v) => sum + v.amount, 0);
  const pendingCount = vouchers.filter(v => ["DRAFT", "PENDING_REVIEW"].includes(v.status)).length;

  if (loading || !user) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame
      title="Phiếu Thu / Chi"
      subtitle="Quản lý hóa đơn chứng từ thu chi, tạm ứng và thanh toán đối tác"
      role={user.role}
      branchCode={branchCode}
      onChangeBranch={handleBranchChange}
    >
      <div className="space-y-6">
        {/* Operational Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">Tổng thu trong kỳ</span>
              <span className="material-symbols-outlined text-emerald-500 text-xl">arrow_downward</span>
            </div>
            <p className="text-lg font-bold text-emerald-600 mt-1">{money(totalReceipts)} đ</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">Tổng chi trong kỳ</span>
              <span className="material-symbols-outlined text-rose-500 text-xl">arrow_upward</span>
            </div>
            <p className="text-lg font-bold text-rose-600 mt-1">{money(totalPayments)} đ</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">Chờ duyệt / Nháp</span>
              <span className="material-symbols-outlined text-amber-500 text-xl">pending_actions</span>
            </div>
            <p className="text-lg font-bold text-amber-600 mt-1">{pendingCount} phiếu</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">Tổng số chứng từ</span>
              <span className="material-symbols-outlined text-slate-400 text-xl">receipt_long</span>
            </div>
            <p className="text-lg font-bold text-slate-800 mt-1">{vouchers.length} chứng từ</p>
          </div>
        </div>

        <main className="grid xl:grid-cols-[380px_1fr] gap-6 items-start">
          {(canCreate || editingVoucher) && (
            <form onSubmit={submitVoucher} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
              <div>
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full uppercase">
                  6.3 Receipt / Payment
                </span>
                <h2 className="font-bold text-lg mt-2 text-slate-800">
                  {editingVoucher ? `Sửa phiếu ${editingVoucher.code}` : "Tạo phiếu thu/chi"}
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Loại phiếu *
                  <select
                    value={form.voucherType}
                    onChange={(event) => {
                      const voucherType = event.target.value;
                      setForm((value) => ({
                        ...value,
                        voucherType,
                        categoryCode: "",
                        depositAction: voucherType === "RECEIPT" ? value.depositAction : "",
                        depositCode: voucherType === "RECEIPT" ? value.depositCode : "",
                      }));
                    }}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                  >
                    <option value="RECEIPT">Phiếu thu (Receipt)</option>
                    <option value="PAYMENT">Phiếu chi (Payment)</option>
                  </select>
                </label>

                <div className="flex flex-col">
                  <span className="text-xs font-bold text-slate-600 mb-1">Ngày lập phiếu *</span>
                  <DateInput
                    value={form.voucherDate}
                    onChange={(d) => setForm((value) => ({ ...value, voucherDate: d }))}
                    className="w-full"
                    ariaLabel="Ngày lập phiếu"
                  />
                </div>
              </div>

              <label className="text-xs font-bold text-slate-600 block">
                Ca làm việc *
                <select
                  value={form.shift}
                  onChange={(event) => setForm((value) => ({ ...value, shift: event.target.value }))}
                  className="control"
                >
                  {WORK_SHIFTS.map((option) => (
                    <option key={option.id} value={option.id}>{option.label} ({option.hint})</option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] font-medium text-slate-500">
                  Quyết định phiếu này nằm ở ca nào trong báo cáo Thu chi ngày.
                </span>
              </label>

              {form.voucherType === "RECEIPT" && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-bold text-slate-600 block">
                    Nội dung thu *
                    <select
                      value={form.depositAction}
                      onChange={(event) => setForm((value) => ({ ...value, depositAction: event.target.value, depositCode: event.target.value ? value.depositCode : "" }))}
                      className="control"
                    >
                      <option value="">Thu doanh thu (ghi nhận toàn bộ)</option>
                      <option value="COLLECT">Thu tiền đặt cọc (khách sẽ dùng sau)</option>
                    </select>
                    <span className="mt-1 block text-[11px] font-medium text-slate-500">
                      {form.depositAction === "COLLECT"
                        ? "Khi duyệt sẽ sinh một khoản tiền cọc theo dõi riêng."
                        : "Tiền vào doanh thu ngay, không theo dõi số dư cọc."}
                    </span>
                  </label>

                  {form.depositAction === "COLLECT" && (
                    <label className="text-xs font-bold text-slate-600 block">
                      Mã tiền cọc
                      <input
                        type="text"
                        value={form.depositCode}
                        onChange={(event) => setForm((value) => ({ ...value, depositCode: event.target.value }))}
                        placeholder="Để trống sẽ tự sinh theo mã phiếu"
                        className="control"
                      />
                      <span className="mt-1 block text-[11px] font-medium text-slate-500">
                        Phải chọn đối tác có mã thì mới thu cọc được.
                      </span>
                    </label>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Mã đối tác
                  <input
                    type="text"
                    value={form.partnerCode}
                    placeholder="Tự điền khi chọn đối tác"
                    readOnly
                    className="mt-1 w-full border border-slate-300 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600"
                  />
                </label>

                <label className="text-xs font-bold text-slate-600 block">
                  Tên đối tác *
                  <select
                    value={partnerSelectValue}
                    onChange={(event) => applyPartnerSelection(event.target.value)}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                    required
                  >
                    {partnerSelectValue === "__CURRENT__" && (
                      <option value="__CURRENT__">{form.partnerName || "-- Chọn đối tác --"}</option>
                    )}
                    {partnerOptions.map((partner) => (
                      <option key={partner.id || partner.code || partner.name} value={partner.id || partner.code || partner.name}>
                        {partner.code ? `${partner.code} - ${partner.name}` : partner.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Cửa hàng *
                  <select
                    value={form.branchCode}
                    onChange={(event) => {
                      const nextBranch = event.target.value;
                      setForm((value) => ({
                        ...value,
                        branchCode: nextBranch,
                        moneySourceCode: isMoneySourceAllowed(moneySources, value.moneySourceCode, nextBranch, voucherMoneySourceGroups)
                          ? value.moneySourceCode
                          : firstMoneySourceCode(moneySources, nextBranch, voucherMoneySourceGroups),
                      }));
                    }}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white disabled:opacity-75"
                    disabled={branchCode !== "ALL"}
                    required
                  >
                    {visibleStoreOptions(user).map((option) => (
                      <option key={option.code} value={option.code}>
                        {storeLabel(option.code)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs font-bold text-slate-600 block">
                  Nguồn tiền *
                  <select
                    value={form.moneySourceCode}
                    onChange={(event) => setForm((value) => ({ ...value, moneySourceCode: event.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white text-ellipsis overflow-hidden"
                    required
                  >
                    <option value="">-- Chọn nguồn tiền --</option>
                    {filterMoneySources(moneySources, form.branchCode, voucherMoneySourceGroups).map((source) => (
                      <option key={source.id || source.code} value={source.code} title={moneySourceDebugLabel(source, storeLabel(form.branchCode))}>
                        {moneySourceDisplayName(source, storeLabel(form.branchCode))}
                      </option>
                    ))}
                    {filterMoneySources(moneySources, form.branchCode, voucherMoneySourceGroups).length === 0 && (
                      <option value="" disabled>Chưa có nguồn tiền mặt cho cửa hàng này</option>
                    )}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Khoản mục thu/chi
                  <select
                    value={form.categoryCode}
                    onChange={(event) => setForm((value) => ({ ...value, categoryCode: event.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                  >
                    <option value="">-- Không phân loại --</option>
                    {voucherCategoryOptions.map((category) => (
                      <option key={category.id || category.code} value={category.code}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs font-bold text-slate-600 block">
                  Số tiền (đ) *
                  <input
                    type="number"
                    value={form.amount}
                    onChange={(event) => setForm((value) => ({ ...value, amount: event.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-bold focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    required
                  />
                </label>
              </div>

              <label className="text-xs font-bold text-slate-600 block">
                Diễn giải *
                <textarea
                  value={form.description}
                  onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>

              {message && <p className="text-sm rounded-lg bg-blue-50 border border-blue-100 text-blue-700 px-3 py-2">{message}</p>}
              <div className="flex gap-2">
                {editingVoucher && (
                  <button type="button" onClick={resetForm} className="px-4 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-xl py-2.5 text-sm font-bold transition-all">Huỷ</button>
                )}
                <button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-2.5 text-sm font-bold transition-all shadow-sm active:scale-[0.99]">
                  {editingVoucher ? "Lưu thay đổi" : "Tạo chứng từ"}
                </button>
              </div>
            </form>
          )}

          <section className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
              <div>
                <h2 className="font-bold text-slate-800">Danh sách phiếu</h2>
                <p className="text-xs text-slate-500 mt-1">Dùng nút In để mở print view/PDF browser.</p>
              </div>
              <button onClick={() => void loadVouchers(branchCode)} className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs font-bold hover:bg-slate-50 text-slate-700 transition-colors">Tải lại</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-500 text-xs uppercase font-bold border-b border-slate-200">
                  <tr>
                    <th className="px-4 py-3 text-left">Chứng từ</th>
                    <th className="px-4 py-3 text-left">Đối tác</th>
                    <th className="px-4 py-3 text-right">Số tiền</th>
                    <th className="px-4 py-3 text-left">Trạng thái</th>
                    <th className="px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vouchers.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Chưa có chứng từ cho chi nhánh này.</td></tr>
                  ) : vouchers.map((voucher) => (
                    <tr key={voucher.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            voucher.voucherType === "RECEIPT"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-rose-50 text-rose-700 border border-rose-200"
                          }`}>
                            {voucher.voucherType === "RECEIPT" ? "Thu" : "Chi"}
                          </span>
                          {voucher.voucherType === "RECEIPT" && (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              voucher.depositAction
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-blue-50 text-blue-700 border border-blue-200"
                            }`}>
                              {voucher.depositAction ? "Tiền cọc" : "Doanh thu"}
                            </span>
                          )}
                          <CopyableText value={voucher.code}><b className="text-slate-800 font-semibold">{voucher.code}</b></CopyableText>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {categoryName(voucher.categoryCode)} · {new Date(voucher.voucherDate).toLocaleDateString("vi-VN")}
                          {voucher.shift && (
                            <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                              {shiftLabel(voucher.shift)}
                            </span>
                          )}
                        </p>
                      </td>
                      <td className="px-4 py-3.5">
                        <b className="text-slate-800 font-medium">{voucher.partnerName}</b>
                        <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{voucher.description}</p>
                      </td>
                      <td className="px-4 py-3.5 text-right font-bold text-slate-900 whitespace-nowrap">{money(voucher.amount)} đ</td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wider ${
                          voucher.status === "APPROVED"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : voucher.status === "DRAFT" || voucher.status === "PENDING_REVIEW"
                            ? "bg-amber-50 text-amber-700 border border-amber-200"
                            : "bg-rose-50 text-rose-700 border border-rose-200"
                        }`}>
                          {voucher.status === "APPROVED" ? "Đã duyệt" : voucher.status === "DRAFT" ? "Bản nháp" : voucher.status}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right whitespace-nowrap space-x-1.5">
                        {canApprove && ["DRAFT", "PENDING_REVIEW"].includes(voucher.status) && (
                          <button onClick={() => void approveVoucher(voucher.id)} className="px-2.5 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-xs font-bold transition-colors">Duyệt</button>
                        )}
                        {canApprove && ["DRAFT", "PENDING_REVIEW"].includes(voucher.status) && (
                          <button onClick={() => void cancelVoucher(voucher.id)} className="px-2.5 py-1 bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 rounded-lg text-xs font-bold transition-colors">Hủy</button>
                        )}
                        {canApprove && voucher.status === "APPROVED" && (
                          <button
                            onClick={() => void unapproveVoucher(voucher)}
                            title="Đưa chứng từ về bản nháp để sửa lại"
                            className="px-2.5 py-1 bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 rounded-lg text-xs font-bold transition-colors"
                          >
                            Bỏ duyệt
                          </button>
                        )}
                        <button onClick={() => window.open(`/vouchers/${voucher.id}/print`, "_blank")} className="px-2.5 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-bold transition-colors">In</button>
                        <RowActions
                          session={user}
                          module="/vouchers"
                          compact
                          onEdit={() => startEditVoucher(voucher)}
                          onDelete={() => {
                            setDeleteError(null);
                            setDeletingVoucher(voucher);
                          }}
                          editDisabledReason={lockedForChange(voucher)}
                          deleteDisabledReason={lockedForChange(voucher)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>

      <ConfirmDeleteDialog
        open={Boolean(deletingVoucher)}
        title={`Xoá chứng từ ${deletingVoucher?.code || ""}?`}
        description={deletingVoucher ? `${deletingVoucher.partnerName} · ${money(deletingVoucher.amount)} đ` : undefined}
        submitting={deleting}
        error={deleteError}
        onCancel={() => {
          setDeletingVoucher(null);
          setDeleteError(null);
        }}
        onConfirm={confirmDeleteVoucher}
      />
    </ModuleFrame>
  );
}
