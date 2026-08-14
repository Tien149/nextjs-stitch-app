"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DateInput } from "@/components/DateInput";
import { ModuleFrame } from "@/components/ModuleFrame";
import { ConfirmDeleteDialog, RowActions } from "@/components/RowActions";
import { storeLabel, updateDynamicBranches } from "@/lib/branch-labels";
import { appMenuItems, canAccessMenu, canEditPastVoucher, canPerformAction, canPerformMenuAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { isSameCalendarDay, normalizeCashflowCategoryType, voucherEditWindowError } from "@/lib/voucher-rules";
import { filterMoneySources, firstMoneySourceCode, isMoneySourceAllowed, moneySourceDebugLabel, moneySourceDisplayName } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";
import { shiftLabel, WORK_SHIFTS } from "@/lib/shifts";
import { type VoucherDocumentChannel, voucherChannelLabel, voucherTypeLabel } from "@/lib/voucher-channel";

const MAX_BULK_SELECTION = 100;

type Voucher = {
  id: string;
  code: string;
  voucherType: string;
  voucherDate: string;
  partnerCode: string | null;
  partnerName: string;
  branchCode: string;
  documentChannel: VoucherDocumentChannel;
  businessEffect: string;
  sourceScope: string;
  sourceDocumentCode: string | null;
  moneySourceCode: string;
  categoryCode: string | null;
  pnlItemCode: string | null;
  amount: number;
  description: string;
  status: string;
  shift: string | null;
  depositAction: string | null;
  depositCode: string | null;
  updatedAt: string;
};

type VoucherTypeFilter = "ALL" | "RECEIPT" | "PAYMENT";

type VoucherFilters = {
  startDate: string;
  endDate: string;
  voucherType: VoucherTypeFilter;
};

type VoucherListSummary = {
  totalReceipts: number;
  totalPayments: number;
  pendingCount: number;
  totalCount: number;
};

type VoucherListPagination = {
  page: number;
  pageSize: number;
  totalPages: number;
  totalCount: number;
};

type VoucherListResponse = {
  rows: Voucher[];
  summary: VoucherListSummary;
  pagination: VoucherListPagination;
};

type BulkActionKind = "APPROVE" | "UNAPPROVE" | "DELETE";

type BulkActionDialogState = {
  kind: BulkActionKind;
  ids: string[];
  requiresReason: boolean;
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
  { id: "fallback-rev-food", type: "REVENUE_EXPENSE_CATEGORY", code: "REV_FOOD", name: "Doanh thu am thuc", group: "RECEIPT", branch: null },
  { id: "fallback-rev-other", type: "REVENUE_EXPENSE_CATEGORY", code: "REV_OTHER", name: "Doanh thu khac", group: "RECEIPT", branch: null },
  { id: "fallback-exp-rent", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_RENT", name: "Chi phi thue mat bang", group: "PAYMENT", branch: null },
  { id: "fallback-exp-salary", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_SALARY", name: "Chi phi luong nhan vien", group: "PAYMENT", branch: null },
  { id: "fallback-exp-marketing", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_MARKETING", name: "Chi phi Marketing", group: "PAYMENT", branch: null },
  { id: "fallback-exp-other", type: "REVENUE_EXPENSE_CATEGORY", code: "EXP_OTHER", name: "Chi phi khac", group: "PAYMENT", branch: null },
];

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
  pnlItemCode: "",
  amount: "50000000",
  description: "Thu tiền bán hàng hàng ngày / thanh toán đối tác",
};

const initialVoucherFilters: VoucherFilters = {
  startDate: "",
  endDate: "",
  voucherType: "ALL",
};

const emptyVoucherSummary: VoucherListSummary = {
  totalReceipts: 0,
  totalPayments: 0,
  pendingCount: 0,
  totalCount: 0,
};

const initialVoucherPagination: VoucherListPagination = {
  page: 1,
  pageSize: 50,
  totalPages: 1,
  totalCount: 0,
};

type VoucherManagementPageProps = { documentChannel?: VoucherDocumentChannel };

export function VoucherManagementPage({ documentChannel = "CASH" }: VoucherManagementPageProps) {
  const router = useRouter();
  const isBankChannel = documentChannel === "BANK";
  const moduleHref = isBankChannel ? "/bank-vouchers" : "/vouchers";
  const sourceGroups = useMemo(() => [documentChannel], [documentChannel]);
  const screenLabel = voucherChannelLabel(documentChannel);
  const [user, setUser] = useState<DemoSession | null>(null);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [filterDraft, setFilterDraft] = useState<VoucherFilters>(initialVoucherFilters);
  const [appliedFilters, setAppliedFilters] = useState<VoucherFilters>(initialVoucherFilters);
  const [voucherSummary, setVoucherSummary] = useState<VoucherListSummary>(emptyVoucherSummary);
  const [voucherPagination, setVoucherPagination] = useState<VoucherListPagination>(initialVoucherPagination);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [branchCode, setBranchCode] = useState("ALL");
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [loading, setLoading] = useState(true);
  /** Chứng từ đang sửa; null nghĩa là biểu mẫu đang ở chế độ tạo mới. */
  const [editingVoucher, setEditingVoucher] = useState<Voucher | null>(null);
  const [deletingVoucher, setDeletingVoucher] = useState<Voucher | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pastEditDialogOpen, setPastEditDialogOpen] = useState(false);
  const [pastEditReason, setPastEditReason] = useState("");
  const [pastEditError, setPastEditError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDialog, setBulkDialog] = useState<BulkActionDialogState | null>(null);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkDialogError, setBulkDialogError] = useState("");
  const [moneySources, setMoneySources] = useState<MasterDataOption[]>([]);
  const [moneySourcesLoading, setMoneySourcesLoading] = useState(false);
  const [moneySourcesError, setMoneySourcesError] = useState("");
  const [formBranches, setFormBranches] = useState<MasterDataOption[]>([]);
  const [categories, setCategories] = useState<MasterDataOption[]>([]);
  const [pnlItems, setPnlItems] = useState<MasterDataOption[]>([]);
  const [partners, setPartners] = useState<MasterDataOption[]>([]);
  const moneySourceRequestRef = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const loadVouchers = useCallback(async (branch: string, filters: VoucherFilters, requestedPage = 1) => {
    setListLoading(true);
    setListError("");
    try {
      const query = new URLSearchParams({
        branchCode: branch,
        channel: documentChannel,
        voucherType: filters.voucherType,
        page: String(requestedPage),
        pageSize: String(initialVoucherPagination.pageSize),
      });
      if (filters.startDate) query.set("startDate", filters.startDate);
      if (filters.endDate) query.set("endDate", filters.endDate);

      const response = await fetch(`/api/vouchers?${query.toString()}`);
      const payload = await response.json().catch(() => null) as VoucherListResponse | { error?: string } | null;
      if (!response.ok || !payload || !("rows" in payload)) {
        throw new Error(payload && "error" in payload ? payload.error || "Không tải được danh sách chứng từ" : "Không tải được danh sách chứng từ");
      }
      setVouchers(payload.rows);
      setVoucherSummary(payload.summary);
      setVoucherPagination(payload.pagination);
      // Không giữ lựa chọn cũ sau khi đổi trang, đổi bộ lọc hoặc tải lại danh sách.
      setSelectedIds([]);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Không tải được danh sách chứng từ");
    } finally {
      setListLoading(false);
    }
  }, [documentChannel]);

  const loadMasterData = useCallback(async (session: DemoSession, initialBranch: string) => {
    const rawSession = localStorage.getItem(SESSION_KEY);
    const headers: Record<string, string> = rawSession ? { "x-demo-session": encodeURIComponent(rawSession) } : {};
    const [branchResponse, categoryResponse, pnlItemResponse, partnerResponse] = await Promise.all([
      fetch("/api/master-data?type=BRANCH&status=ACTIVE", { headers }),
      fetch("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE", { headers }),
      fetch("/api/master-data?type=PNL_ITEM", { headers }),
      fetch("/api/master-data?type=PARTNER&status=ACTIVE", { headers }),
    ]);
    if (branchResponse.ok) {
      const branchItems = (await branchResponse.json()) as MasterDataOption[];
      const allowedBranches = session.allowedBranches?.length ? session.allowedBranches : ["ALL"];
      const visibleBranches = allowedBranches.includes("ALL")
        ? branchItems
        : branchItems.filter((branch) => allowedBranches.includes(branch.code));
      updateDynamicBranches(visibleBranches.map((branch) => ({ code: branch.code, name: branch.name })));
      setFormBranches(visibleBranches);
      setForm((current) => {
        const preferredBranch = initialBranch !== "ALL" ? initialBranch : current.branchCode;
        const nextBranch = visibleBranches.some((branch) => branch.code === preferredBranch)
          ? preferredBranch
          : visibleBranches[0]?.code || "";
        return nextBranch === current.branchCode
          ? current
          : { ...current, branchCode: nextBranch, moneySourceCode: "" };
      });
    }
    if (categoryResponse.ok) {
      setCategories((await categoryResponse.json()) as MasterDataOption[]);
    }
    if (pnlItemResponse.ok) {
      setPnlItems((await pnlItemResponse.json()) as MasterDataOption[]);
    }
    if (partnerResponse.ok) {
      setPartners((await partnerResponse.json()) as MasterDataOption[]);
    }
  }, []);

  const loadMoneySources = useCallback(async (selectedBranch: string) => {
    const branch = selectedBranch.trim().toUpperCase();
    const requestId = ++moneySourceRequestRef.current;
    if (!branch || branch === "ALL") {
      setMoneySources([]);
      setMoneySourcesError("");
      setMoneySourcesLoading(false);
      return;
    }

    setMoneySourcesLoading(true);
    setMoneySourcesError("");
    try {
      const rawSession = localStorage.getItem(SESSION_KEY);
      const headers: Record<string, string> = rawSession ? { "x-demo-session": encodeURIComponent(rawSession) } : {};
      const response = await fetch(`/api/master-data?type=MONEY_SOURCE&branchCode=${encodeURIComponent(branch)}`, { headers });
      const payload = await response.json().catch(() => null) as MasterDataOption[] | { error?: string } | null;
      if (requestId !== moneySourceRequestRef.current) return;
      if (!response.ok || !Array.isArray(payload)) {
        const error = payload && !Array.isArray(payload) ? payload.error : null;
        throw new Error(error || "Không tải được nguồn tiền của cửa hàng đã chọn");
      }

      setMoneySources(payload);
      setForm((current) => {
        if (current.branchCode.trim().toUpperCase() !== branch) return current;
        const keepsActiveSource = isMoneySourceAllowed(payload, current.moneySourceCode, branch, sourceGroups);
        const keepsHistoricalSource = Boolean(
          editingVoucher
          && editingVoucher.moneySourceCode === current.moneySourceCode
          && payload.some((source) => source.code === current.moneySourceCode),
        );
        return {
          ...current,
          moneySourceCode: keepsActiveSource || keepsHistoricalSource
            ? current.moneySourceCode
            : firstMoneySourceCode(payload, branch, sourceGroups),
        };
      });
    } catch (error) {
      if (requestId !== moneySourceRequestRef.current) return;
      setMoneySources([]);
      setForm((current) => current.branchCode.trim().toUpperCase() === branch
        ? { ...current, moneySourceCode: "" }
        : current);
      setMoneySourcesError(error instanceof Error ? error.message : "Không tải được nguồn tiền của cửa hàng đã chọn");
    } finally {
      if (requestId === moneySourceRequestRef.current) setMoneySourcesLoading(false);
    }
  }, [editingVoucher, sourceGroups]);

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === moduleHref);
    if (!raw) {
      router.push(`/login?next=${moduleHref}`);
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
      void loadVouchers(initialBranch, initialVoucherFilters, 1);
      void loadMasterData(session, initialBranch);
    }, 0);
  }, [router, loadVouchers, loadMasterData, moduleHref]);

  useEffect(() => {
    window.setTimeout(() => {
      setForm((current) => {
        if (branchCode === "ALL" || current.branchCode === branchCode) return current;
        return { ...current, branchCode, moneySourceCode: "" };
      });
    }, 0);
  }, [branchCode]);

  useEffect(() => {
    if (!user || !form.branchCode) return;
    const timer = window.setTimeout(() => void loadMoneySources(form.branchCode), 0);
    return () => window.clearTimeout(timer);
  }, [user, form.branchCode, loadMoneySources]);

  const handleBranchChange = (code: string) => {
    setBranchCode(code);
    void loadVouchers(code, appliedFilters, 1);
  };

  const applyVoucherFilters = (event: React.FormEvent) => {
    event.preventDefault();
    if (filterDraft.startDate && filterDraft.endDate && filterDraft.startDate > filterDraft.endDate) {
      setListError("Từ ngày không được lớn hơn đến ngày.");
      return;
    }
    const nextFilters = { ...filterDraft };
    setAppliedFilters(nextFilters);
    void loadVouchers(branchCode, nextFilters, 1);
  };

  const resetVoucherFilters = () => {
    const nextFilters = { ...initialVoucherFilters };
    setFilterDraft(nextFilters);
    setAppliedFilters(nextFilters);
    void loadVouchers(branchCode, nextFilters, 1);
  };

  const changeVoucherPage = (page: number) => {
    if (listLoading || page < 1 || page > voucherPagination.totalPages || page === voucherPagination.page) return;
    void loadVouchers(branchCode, appliedFilters, page);
  };

  const canCreate = user ? canPerformAction(user, "create") : false;
  const canApprove = user ? canPerformMenuAction(user, moduleHref, "approve") : false;
  const canDelete = user ? canPerformMenuAction(user, moduleHref, "delete") : false;
  /** Quyền sửa/bỏ duyệt chứng từ đã qua ngày (mặc định Admin và Kế toán tổng hợp). */
  const canEditPast = canEditPastVoucher(user);
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(value);
  const categoryName = (code: string | null) => {
    if (!code) return "Chưa gán khoản mục";
    const source = categories.length > 0 ? categories : fallbackVoucherCategories;
    return source.find((item) => item.code === code)?.name || code;
  };
  const pnlItemName = (code: string | null) => {
    if (!code) return null;
    return pnlItems.find((item) => item.code === code)?.name || code;
  };
  const normalizedCategoryOptions = useMemo(() => {
    const source = categories.length > 0 ? categories : fallbackVoucherCategories;
    return source.map((category) => ({
      ...category,
      group: normalizeCashflowCategoryType(category.group),
    }));
  }, [categories]);
  const categoryOptionsForType = useCallback(
    (voucherType: string) =>
      normalizedCategoryOptions.filter((category) => {
        return normalizeCashflowCategoryType(category.group) === voucherType;
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

  /**
   * Phiếu duyệt ngay khi tạo nên "đã duyệt" không còn là lý do khoá sửa. Chặn theo cửa
   * sổ ngày: trong ngày ai có quyền sửa đều sửa được, qua ngày phải có quyền edit_past.
   */
  const lockedForChange = (voucher: Voucher) => {
    if (voucher.status === "POSTED") return "Chứng từ đã ghi sổ, không thể sửa hoặc xoá";
    if (voucher.status === "CANCELLED") return "Chứng từ đã huỷ";
    return voucherEditWindowError(new Date(voucher.voucherDate), canEditPast);
  };

  const resetFormState = (clearSavedFields: boolean) => {
    const nextBranch = branchCode === "ALL" ? form.branchCode : branchCode;
    setEditingVoucher(null);
    setPastEditDialogOpen(false);
    setPastEditReason("");
    setPastEditError("");
    setForm({
      ...emptyForm,
      branchCode: nextBranch,
      moneySourceCode: firstMoneySourceCode(moneySources, nextBranch, sourceGroups),
      categoryCode: emptyForm.categoryCode,
      amount: clearSavedFields ? "" : emptyForm.amount,
      description: clearSavedFields ? "" : emptyForm.description,
    });
  };

  const resetForm = () => resetFormState(false);
  const resetFormAfterSave = () => resetFormState(true);
  const clearPreviousSuccess = () => {
    if (messageType === "success" && message) setMessage("");
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
      // Không tự thay nguồn lịch sử bằng nguồn ACTIVE đầu tiên khi mở phiếu cũ để sửa.
      moneySourceCode: voucher.moneySourceCode,
      categoryCode: voucher.categoryCode || "",
      pnlItemCode: voucher.pnlItemCode || "",
      amount: String(voucher.amount),
      description: voucher.description,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveVoucher = async (reason = "") => {
    if (saving) return;
    setMessage("");
    setSaving(true);

    try {
      const response = editingVoucher
        ? await fetch("/api/vouchers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...form,
              documentChannel,
              action: "UPDATE",
              id: editingVoucher.id,
              expectedUpdatedAt: editingVoucher.updatedAt,
              reason: reason || undefined,
            }),
          })
        : await fetch("/api/vouchers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...form, documentChannel }),
          });

      const payload = await response.json();
      if (!response.ok) {
        const error = payload.error || (editingVoucher ? "Không lưu được thay đổi" : "Không tạo được chứng từ");
        if (pastEditDialogOpen) setPastEditError(error);
        else {
          setMessage(error);
          setMessageType("error");
        }
        return;
      }

      setMessage(editingVoucher
        ? payload.status === "APPROVED"
          ? `Đã lưu thay đổi và tự động duyệt lại phiếu ${payload.code || editingVoucher.code}.`
          : `Đã lưu thay đổi phiếu ${payload.code || editingVoucher.code}.`
        : `Đã tạo và tự động duyệt phiếu ${payload.code || ""}.`);
      setMessageType("success");
      resetFormAfterSave();
      await loadVouchers(branchCode, appliedFilters, voucherPagination.page);
    } catch {
      const error = "Không kết nối được máy chủ. Vui lòng thử lại.";
      if (pastEditDialogOpen) setPastEditError(error);
      else {
        setMessage(error);
        setMessageType("error");
      }
    } finally {
      setSaving(false);
    }
  };

  const submitVoucher = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");

    const now = new Date();
    const originalDateIsDifferent = editingVoucher
      ? !isSameCalendarDay(new Date(editingVoucher.voucherDate), now)
      : false;
    const editedDateIsDifferent = editingVoucher && form.voucherDate
      ? !isSameCalendarDay(new Date(form.voucherDate), now)
      : false;

    if (editingVoucher && (originalDateIsDifferent || editedDateIsDifferent)) {
      setPastEditReason("");
      setPastEditError("");
      setPastEditDialogOpen(true);
      return;
    }

    await saveVoucher();
  };

  const confirmPastEdit = async () => {
    const reason = pastEditReason.trim();
    if (!reason) {
      setPastEditError("Vui lòng nhập lý do chỉnh sửa phiếu ngày cũ.");
      return;
    }
    setPastEditError("");
    await saveVoucher(reason);
  };

  const confirmDeleteVoucher = async (reason: string) => {
    if (!deletingVoucher) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const query = new URLSearchParams({ id: deletingVoucher.id, channel: documentChannel });
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
      await loadVouchers(branchCode, appliedFilters, voucherPagination.page);
    } finally {
      setDeleting(false);
    }
  };

  const canBulkApproveVoucher = (voucher: Voucher) =>
    canApprove
    && ["DRAFT", "PENDING_REVIEW"].includes(voucher.status)
    && !lockedForChange(voucher);

  const canBulkUnapproveVoucher = (voucher: Voucher) =>
    canApprove
    && voucher.status === "APPROVED"
    && !lockedForChange(voucher);

  const canBulkDeleteVoucher = (voucher: Voucher) =>
    canDelete && !lockedForChange(voucher);

  // Chỉ cho chọn phiếu có ít nhất một thao tác hàng loạt mà user hiện tại được phép dùng.
  const selectableVouchers = vouchers.filter((voucher) =>
    canBulkApproveVoucher(voucher)
    || canBulkUnapproveVoucher(voucher)
    || canBulkDeleteVoucher(voucher));
  const selectableIds = new Set(selectableVouchers.map((voucher) => voucher.id));
  const selectedVouchers = vouchers.filter((voucher) => selectedIds.includes(voucher.id));
  const bulkApproveIds = selectedVouchers.filter(canBulkApproveVoucher).map((voucher) => voucher.id);
  const bulkUnapproveIds = selectedVouchers.filter(canBulkUnapproveVoucher).map((voucher) => voucher.id);
  const bulkDeleteIds = selectedVouchers.filter(canBulkDeleteVoucher).map((voucher) => voucher.id);
  const allSelectableChecked = selectableVouchers.length > 0 && selectableVouchers.every((voucher) => selectedIds.includes(voucher.id));
  const someSelectableChecked = selectableVouchers.some((voucher) => selectedIds.includes(voucher.id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelectableChecked && !allSelectableChecked;
    }
  }, [allSelectableChecked, someSelectableChecked]);

  const toggleSelectAll = () => {
    setSelectedIds(allSelectableChecked ? [] : selectableVouchers.map((voucher) => voucher.id));
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  /**
   * Gọi API cho cả lô rồi tóm tắt lại: API trả về danh sách phiếu hỏng kèm lý do nên
   * người dùng biết chính xác phiếu nào không xử lý được thay vì chỉ thấy "có lỗi".
   */
  const openBulkDialog = (kind: BulkActionKind) => {
    const targetIds = kind === "APPROVE"
      ? bulkApproveIds
      : kind === "UNAPPROVE"
        ? bulkUnapproveIds
        : bulkDeleteIds;
    const labels = { APPROVE: "duyệt", UNAPPROVE: "bỏ duyệt", DELETE: "xoá" } as const;
    if (targetIds.length === 0) {
      setMessage(`Không có chứng từ phù hợp để ${labels[kind]}.`);
      setMessageType("error");
      return;
    }
    if (targetIds.length > MAX_BULK_SELECTION) {
      setMessage(`Chỉ được xử lý tối đa ${MAX_BULK_SELECTION} chứng từ mỗi lần.`);
      setMessageType("error");
      return;
    }

    const targetIdSet = new Set(targetIds);
    const requiresReason = kind !== "APPROVE" && selectedVouchers.some((voucher) =>
      targetIdSet.has(voucher.id) && !isSameCalendarDay(new Date(voucher.voucherDate), new Date()));
    setBulkReason("");
    setBulkDialogError("");
    setBulkDialog({ kind, ids: targetIds, requiresReason });
  };

  const closeBulkDialog = () => {
    if (bulkRunning) return;
    setBulkDialog(null);
    setBulkReason("");
    setBulkDialogError("");
  };

  const runBulk = async () => {
    if (!bulkDialog || bulkRunning) return;
    const { kind, ids: targetIds, requiresReason } = bulkDialog;
    const reason = bulkReason.trim();
    const labels = { APPROVE: "duyệt", UNAPPROVE: "bỏ duyệt", DELETE: "xoá" } as const;
    if (requiresReason && !reason) {
      setBulkDialogError("Vui lòng nhập lý do vì danh sách có chứng từ ngày cũ.");
      return;
    }

    setBulkRunning(true);
    setMessage("");
    setBulkDialogError("");
    try {
      const response = kind === "DELETE"
        ? await fetch("/api/vouchers", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: targetIds, reason: reason || undefined, documentChannel }),
          })
        : await fetch("/api/vouchers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ids: targetIds,
              documentChannel,
              status: kind === "APPROVE" ? "APPROVED" : "DRAFT",
              reason: reason || undefined,
            }),
          });
      const payload = await response.json();
      if (!response.ok) {
        setBulkDialogError(payload.error || `Không ${labels[kind]} được chứng từ.`);
        return;
      }
      const failed = (payload.failed || []) as Array<{ code?: string; error?: string }>;
      setMessage(
        failed.length === 0
          ? `Đã ${labels[kind]} ${payload.succeeded}/${payload.total} chứng từ.`
          : `Đã ${labels[kind]} ${payload.succeeded}/${payload.total} chứng từ. Không xử lý được: ${failed.map((row) => `${row.code || "?"} (${row.error})`).join("; ")}`,
      );
      setMessageType(failed.length === 0 ? "success" : "error");
      setBulkDialog(null);
      setBulkReason("");
      setBulkDialogError("");
      setSelectedIds([]);
      await loadVouchers(branchCode, appliedFilters, voucherPagination.page);
    } catch {
      setBulkDialogError("Lỗi kết nối máy chủ.");
    } finally {
      setBulkRunning(false);
    }
  };

  const { totalReceipts, totalPayments, pendingCount, totalCount } = voucherSummary;

  if (loading || !user) return <div className="h-screen grid place-items-center bg-slate-100">Đang tải...</div>;

  return (
    <ModuleFrame
      title={screenLabel}
      subtitle={isBankChannel
        ? "Quản lý Ủy nhiệm thu/chi và chứng từ phát sinh trên tài khoản ngân hàng"
        : "Quản lý Phiếu thu/chi sử dụng nguồn tiền mặt tại cửa hàng"}
      role={user.role}
      branchCode={branchCode}
      onChangeBranch={handleBranchChange}
      contentClassName="max-w-[1600px]"
    >
      <div className="space-y-6">
        {/* Operational Summary Cards */}
        <StickyFilterBar className="!mb-0">
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
            <p className="text-lg font-bold text-amber-600 mt-1">{pendingCount} chứng từ</p>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500">Tổng số chứng từ</span>
              <span className="material-symbols-outlined text-slate-400 text-xl">receipt_long</span>
            </div>
            <p className="text-lg font-bold text-slate-800 mt-1">{totalCount} chứng từ</p>
          </div>
        </div>
        </StickyFilterBar>

        <main className="grid gap-4 items-start xl:grid-cols-[calc((100%-3rem)/4)_minmax(0,1fr)]">
          {(canCreate || editingVoucher) && (
            <form
              onSubmit={submitVoucher}
              onChangeCapture={clearPreviousSuccess}
              onInvalidCapture={clearPreviousSuccess}
              className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4"
            >
              <div>
                <span className="text-[10px] font-bold text-blue-600 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded-full uppercase">
                  {isBankChannel ? "Bank Receipt / Payment" : "6.3 Receipt / Payment"}
                </span>
                <h2 className="font-bold text-lg mt-2 text-slate-800">
                  {editingVoucher ? `Sửa ${voucherTypeLabel(editingVoucher.voucherType, documentChannel).toLowerCase()} ${editingVoucher.code}` : `Tạo ${screenLabel.toLowerCase()}`}
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs font-bold text-slate-600 block">
                  Loại chứng từ *
                  <select
                    value={form.voucherType}
                    onChange={(event) => {
                      const voucherType = event.target.value;
                      setForm((value) => ({
                        ...value,
                        voucherType,
                        categoryCode: "",
                        pnlItemCode: "",
                        depositAction: voucherType === "RECEIPT" ? value.depositAction : "",
                        depositCode: voucherType === "RECEIPT" ? value.depositCode : "",
                      }));
                    }}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                  >
                    <option value="RECEIPT">{voucherTypeLabel("RECEIPT", documentChannel)}</option>
                    <option value="PAYMENT">{voucherTypeLabel("PAYMENT", documentChannel)}</option>
                  </select>
                </label>

                <div className="flex flex-col">
                  <span className="text-xs font-bold text-slate-600 mb-1">Ngày chứng từ *</span>
                  <DateInput
                    value={form.voucherDate}
                    onChange={(d) => setForm((value) => ({ ...value, voucherDate: d }))}
                    className="w-full"
                    ariaLabel="Ngày chứng từ"
                  />
                </div>
              </div>

              {!isBankChannel && <label className="text-xs font-bold text-slate-600 block">
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
              </label>}

              {form.voucherType === "RECEIPT" && (
                <div className={`grid gap-3 ${form.depositAction === "COLLECT" ? "grid-cols-2" : "grid-cols-1"}`}>
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
                        moneySourceCode: "",
                      }));
                    }}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white disabled:opacity-75"
                    disabled={branchCode !== "ALL" || Boolean(editingVoucher)}
                    required
                  >
                    {formBranches.map((option) => (
                      <option key={option.code} value={option.code}>
                        {storeLabel(option.code)}
                      </option>
                    ))}
                  </select>
                  {editingVoucher && (
                    <span className="mt-1 block text-[11px] font-medium text-slate-500">
                      Mã chứng từ đã gắn với cửa hàng; muốn đổi cửa hàng cần hủy và lập phiếu mới.
                    </span>
                  )}
                </label>

                <label className="text-xs font-bold text-slate-600 block">
                  Nguồn tiền *
                  <select
                    value={form.moneySourceCode}
                    onChange={(event) => setForm((value) => ({ ...value, moneySourceCode: event.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white text-ellipsis overflow-hidden"
                    disabled={moneySourcesLoading || !form.branchCode}
                    required
                  >
                    <option value="">{moneySourcesLoading ? "-- Đang tải nguồn tiền --" : "-- Chọn nguồn tiền --"}</option>
                    {editingVoucher && form.moneySourceCode && !isMoneySourceAllowed(moneySources, form.moneySourceCode, form.branchCode, sourceGroups) && (() => {
                      const historicalSource = moneySources.find((source) => source.code === form.moneySourceCode);
                      return historicalSource ? (
                        <option key={historicalSource.id || historicalSource.code} value={historicalSource.code}>
                          {moneySourceDisplayName(historicalSource, storeLabel(form.branchCode))} (Đã ngừng)
                        </option>
                      ) : null;
                    })()}
                    {filterMoneySources(moneySources, form.branchCode, sourceGroups).map((source) => (
                      <option key={source.id || source.code} value={source.code} title={moneySourceDebugLabel(source, storeLabel(form.branchCode))}>
                        {moneySourceDisplayName(source, storeLabel(form.branchCode))}
                      </option>
                    ))}
                    {filterMoneySources(moneySources, form.branchCode, sourceGroups).length === 0 && (
                      <option value="" disabled>{moneySourcesError || `Chưa có nguồn ${isBankChannel ? "ngân hàng" : "tiền mặt"} cho cửa hàng này`}</option>
                    )}
                  </select>
                  {moneySourcesError && <span className="mt-1 block text-[11px] font-medium text-rose-600">{moneySourcesError}</span>}
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

              {form.voucherType === "PAYMENT" && (
                <label className="text-xs font-bold text-slate-600 block">
                  Hạng mục P&amp;L <span className="font-medium text-slate-400">(không bắt buộc)</span>
                  <select
                    value={form.pnlItemCode}
                    onChange={(event) => setForm((value) => ({ ...value, pnlItemCode: event.target.value }))}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                  >
                    <option value="">-- Chưa phân loại P&amp;L --</option>
                    {editingVoucher && form.pnlItemCode && !pnlItems.some((item) => item.code === form.pnlItemCode && item.status === "ACTIVE") && (() => {
                      const historicalItem = pnlItems.find((item) => item.code === form.pnlItemCode);
                      return historicalItem ? (
                        <option key={historicalItem.id || historicalItem.code} value={historicalItem.code}>
                          {historicalItem.name} (Đã ngừng)
                        </option>
                      ) : null;
                    })()}
                    {pnlItems
                      .filter((item) => item.status === "ACTIVE" && ["OPEX", "COGS"].includes((item.group || "").toUpperCase()))
                      .map((item) => (
                        <option key={item.id || item.code} value={item.code}>
                          {item.code} - {item.name}
                        </option>
                      ))}
                  </select>
                  <span className="mt-1 block text-[11px] font-medium text-slate-500">
                    Dùng để phân loại chi tiết trên báo cáo P&amp;L; không thay thế khoản mục thu/chi của báo cáo dòng tiền.
                  </span>
                </label>
              )}

              <label className="text-xs font-bold text-slate-600 block">
                Diễn giải *
                <textarea
                  value={form.description}
                  onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))}
                  className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-20 resize-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>

              {message && (
                <div
                  className={`text-sm rounded-lg px-3.5 py-2.5 font-medium border flex items-center gap-2 ${
                    messageType === "error"
                      ? "bg-rose-50 border-rose-200 text-rose-700"
                      : "bg-emerald-50 border-emerald-200 text-emerald-700"
                  }`}
                >
                  <span className="material-symbols-outlined text-base shrink-0">
                    {messageType === "error" ? "error" : "check_circle"}
                  </span>
                  <span>{message}</span>
                </div>
              )}
              <div className="flex gap-2">
                {editingVoucher && (
                  <button type="button" onClick={resetForm} className="px-4 bg-white border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-xl py-2.5 text-sm font-bold transition-all">Huỷ</button>
                )}
                <button disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white rounded-xl py-2.5 text-sm font-bold transition-all shadow-sm active:scale-[0.99]">
                  {saving ? "Đang lưu..." : editingVoucher ? "Lưu thay đổi" : "Tạo chứng từ"}
                </button>
              </div>
            </form>
          )}

          <section className="min-w-0 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div>
                <h2 className="font-bold text-slate-800">Danh sách {screenLabel.toLowerCase()}</h2>
                <p className="text-xs text-slate-500 mt-1">
                  {isBankChannel
                    ? "Chứng từ từ sao kê ở trạng thái chờ duyệt; chứng từ lập tay được duyệt ngay."
                    : "Phiếu tiền mặt được duyệt ngay khi lập. Tích chọn để duyệt, bỏ duyệt hoặc xoá hàng loạt."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectedIds.length > 0 && (
                  <>
                    <span className="rounded-lg bg-blue-50 border border-blue-200 px-2.5 py-1.5 text-xs font-bold text-blue-700">
                      Đã chọn {selectedIds.length}
                    </span>
                    {canApprove && (
                      <button
                        type="button"
                        disabled={bulkRunning || bulkApproveIds.length === 0}
                        onClick={() => openBulkDialog("APPROVE")}
                        className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        Duyệt ({bulkApproveIds.length})
                      </button>
                    )}
                    {canApprove && (
                      <button
                        type="button"
                        disabled={bulkRunning || bulkUnapproveIds.length === 0}
                        onClick={() => openBulkDialog("UNAPPROVE")}
                        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                      >
                        Bỏ duyệt ({bulkUnapproveIds.length})
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        disabled={bulkRunning || bulkDeleteIds.length === 0}
                        onClick={() => openBulkDialog("DELETE")}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                      >
                        Xoá ({bulkDeleteIds.length})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedIds([])}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
                    >
                      Bỏ chọn
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={listLoading}
                  onClick={() => void loadVouchers(branchCode, appliedFilters, voucherPagination.page)}
                  className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs font-bold hover:bg-slate-50 text-slate-700 transition-colors disabled:opacity-50"
                >
                  {listLoading ? "Đang tải..." : "Tải lại"}
                </button>
              </div>
            </div>
            <form onSubmit={applyVoucherFilters} className="flex flex-wrap items-end gap-3 border-b border-slate-200 bg-slate-50/70 px-5 py-3">
              <div className="min-w-[150px] flex-1 sm:max-w-[190px]">
                <label className="mb-1 block text-xs font-bold text-slate-600">Từ ngày</label>
                <DateInput
                  value={filterDraft.startDate}
                  onChange={(startDate) => {
                    setFilterDraft((current) => ({ ...current, startDate }));
                    setListError("");
                  }}
                  ariaLabel="Lọc chứng từ từ ngày"
                  className="w-full"
                />
              </div>
              <div className="min-w-[150px] flex-1 sm:max-w-[190px]">
                <label className="mb-1 block text-xs font-bold text-slate-600">Đến ngày</label>
                <DateInput
                  value={filterDraft.endDate}
                  onChange={(endDate) => {
                    setFilterDraft((current) => ({ ...current, endDate }));
                    setListError("");
                  }}
                  ariaLabel="Lọc chứng từ đến ngày"
                  className="w-full"
                />
              </div>
              <label className="min-w-[170px] flex-1 text-xs font-bold text-slate-600 sm:max-w-[210px]">
                Loại thu/chi
                <select
                  value={filterDraft.voucherType}
                  onChange={(event) => {
                    setFilterDraft((current) => ({ ...current, voucherType: event.target.value as VoucherTypeFilter }));
                    setListError("");
                  }}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  <option value="ALL">Tất cả thu và chi</option>
                  <option value="RECEIPT">Thu</option>
                  <option value="PAYMENT">Chi</option>
                </select>
              </label>
              <button
                type="submit"
                disabled={listLoading}
                className="h-[38px] rounded-lg bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {listLoading ? "Đang lọc..." : "Lọc dữ liệu"}
              </button>
              <button
                type="button"
                disabled={listLoading}
                onClick={resetVoucherFilters}
                className="h-[38px] rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Xóa lọc
              </button>
              {listError && <p className="w-full text-xs font-semibold text-rose-600">{listError}</p>}
            </form>
            <div className="h-[calc(100vh-245px)] min-h-[720px] max-h-[900px] overflow-auto overscroll-contain">
              <table className="w-full min-w-[820px] table-fixed text-left text-sm">
                <thead className="sticky top-0 z-10 bg-slate-50 text-slate-500 text-xs uppercase font-bold border-b border-slate-200 shadow-[0_1px_0_0_rgb(226_232_240)]">
                  <tr>
                    <th className="w-10 px-4 py-3 text-left">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        title="Chọn tất cả phiếu sửa được"
                        className="h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
                        checked={allSelectableChecked}
                        disabled={selectableVouchers.length === 0}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th className="w-[200px] px-4 py-3 text-left">Chứng từ</th>
                    <th className="w-[180px] px-4 py-3 text-left">Đối tác</th>
                    <th className="w-[120px] px-4 py-3 text-right">Số tiền</th>
                    <th className="w-[135px] px-4 py-3 text-left">Trạng thái</th>
                    <th className="w-[145px] px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {vouchers.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                        {listLoading ? "Đang tải danh sách..." : "Không có chứng từ phù hợp với bộ lọc."}
                      </td>
                    </tr>
                  ) : vouchers.map((voucher) => {
                    const lockReason = lockedForChange(voucher);
                    const bulkSelectionDisabledReason = lockReason
                      || (!selectableIds.has(voucher.id) ? "Bạn không có thao tác hàng loạt phù hợp với chứng từ này" : null);
                    return (
                    <tr key={voucher.id} className={`transition-colors ${selectedIds.includes(voucher.id) ? "bg-blue-50/60" : "hover:bg-slate-50/80"}`}>
                      <td className="px-4 py-3.5 align-top">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4 cursor-pointer accent-blue-600 disabled:cursor-not-allowed"
                          checked={selectedIds.includes(voucher.id)}
                          disabled={Boolean(bulkSelectionDisabledReason)}
                          title={bulkSelectionDisabledReason || "Chọn chứng từ"}
                          onChange={() => toggleSelect(voucher.id)}
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            voucher.voucherType === "RECEIPT"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-rose-50 text-rose-700 border border-rose-200"
                          }`}>
                            {voucherTypeLabel(voucher.voucherType, documentChannel)}
                          </span>
                          {voucher.voucherType === "RECEIPT" && (
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              voucher.depositAction
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-blue-50 text-blue-700 border border-blue-200"
                            }`}>
                              {voucher.depositAction
                                ? "Tiền cọc"
                                : voucher.businessEffect === "SETTLEMENT"
                                  ? "Đối soát POS"
                                  : isBankChannel ? "Thu ngân hàng" : "Thu khác"}
                            </span>
                          )}
                          <CopyableText value={voucher.code}><b className="text-slate-800 font-semibold">{voucher.code}</b></CopyableText>
                        </div>
                        <p className="mt-0.5 text-xs leading-4 text-slate-500">{categoryName(voucher.categoryCode)}</p>
                        {voucher.pnlItemCode && (
                          <p className="mt-1 text-[11px] font-medium text-indigo-600">
                            P&amp;L: {pnlItemName(voucher.pnlItemCode)}
                          </p>
                        )}
                        <p className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-xs leading-4 text-slate-500">
                          <span>{new Date(voucher.voucherDate).toLocaleDateString("vi-VN")}</span>
                          {voucher.shift && (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                              {shiftLabel(voucher.shift)}
                            </span>
                          )}
                        </p>
                      </td>
                      <td className="px-4 py-3.5 align-top whitespace-normal break-words">
                        <b className="block text-slate-800 font-medium leading-5">{voucher.partnerName}</b>
                        <p className="mt-0.5 text-xs leading-4 text-slate-500 whitespace-normal break-words">{voucher.description}</p>
                        {isBankChannel && (
                          <p className="mt-1 text-[11px] font-medium text-blue-700">
                            Tài khoản: {voucher.moneySourceCode}
                            {voucher.sourceDocumentCode ? ` · POS: ${voucher.sourceDocumentCode}` : ""}
                          </p>
                        )}
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
                      <td className="px-4 py-3.5 text-right align-top whitespace-nowrap space-x-1.5">
                        <button onClick={() => window.open(`/vouchers/${voucher.id}/print`, "_blank")} className="px-2.5 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg text-xs font-bold transition-colors">In</button>
                        <RowActions
                          session={user}
                          module={moduleHref}
                          compact
                          onEdit={() => startEditVoucher(voucher)}
                          onDelete={() => {
                            setDeleteError(null);
                            setDeletingVoucher(voucher);
                          }}
                          editDisabledReason={lockReason}
                          deleteDisabledReason={lockReason}
                        />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs text-slate-600">
              <span>
                Trang <b>{voucherPagination.page}</b>/{voucherPagination.totalPages} · Tổng <b>{voucherPagination.totalCount}</b> chứng từ
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={listLoading || voucherPagination.page <= 1}
                  onClick={() => changeVoucherPage(voucherPagination.page - 1)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-bold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Trang trước
                </button>
                <button
                  type="button"
                  disabled={listLoading || voucherPagination.page >= voucherPagination.totalPages}
                  onClick={() => changeVoucherPage(voucherPagination.page + 1)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-bold hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Trang sau
                </button>
              </div>
            </div>
          </section>
        </main>
      </div>

      {bulkDialog && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-labelledby="bulk-action-title">
          <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-blue-600">Thao tác hàng loạt</p>
                <h3 id="bulk-action-title" className="mt-1 text-base font-bold text-slate-900">
                  {bulkDialog.kind === "APPROVE"
                    ? `Duyệt ${bulkDialog.ids.length} chứng từ?`
                    : bulkDialog.kind === "UNAPPROVE"
                      ? `Bỏ duyệt ${bulkDialog.ids.length} chứng từ?`
                      : `Xoá ${bulkDialog.ids.length} chứng từ?`}
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  {vouchers
                    .filter((voucher) => bulkDialog.ids.includes(voucher.id))
                    .slice(0, 4)
                    .map((voucher) => voucher.code)
                    .join(", ")}
                  {bulkDialog.ids.length > 4 ? ` và ${bulkDialog.ids.length - 4} phiếu khác` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={bulkRunning}
                onClick={closeBulkDialog}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                aria-label="Đóng"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <p className={`rounded-xl border px-3 py-2.5 text-xs leading-5 ${
                bulkDialog.kind === "APPROVE"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}>
                {bulkDialog.kind === "APPROVE"
                  ? "Các chứng từ sẽ được duyệt và ghi nhận các hệ quả liên quan vào sổ quỹ."
                  : bulkDialog.kind === "UNAPPROVE"
                    ? "Các chứng từ sẽ về Bản nháp; dòng tiền, tiền cọc, công nợ và phân bổ liên quan sẽ được hoàn tác."
                    : "Các chứng từ đã duyệt sẽ được hoàn tác hệ quả liên quan trước khi chuyển vào Thùng rác."}
              </p>

              {bulkDialog.kind !== "APPROVE" && (
                <div>
                  <label htmlFor="bulk-action-reason" className="text-sm font-bold text-slate-700">
                    Lý do {bulkDialog.requiresReason
                      ? <span className="text-rose-600">*</span>
                      : <span className="font-normal text-slate-400">(không bắt buộc)</span>}
                  </label>
                  <textarea
                    id="bulk-action-reason"
                    autoFocus
                    value={bulkReason}
                    onChange={(event) => {
                      setBulkReason(event.target.value);
                      if (bulkDialogError) setBulkDialogError("");
                    }}
                    rows={3}
                    placeholder={bulkDialog.requiresReason
                      ? "Nhập lý do xử lý chứng từ ngày cũ..."
                      : "VD: Điều chỉnh phiếu nhập nhầm"}
                    className="mt-2 w-full resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                  />
                  {bulkDialog.requiresReason && (
                    <p className={`mt-1 text-[11px] font-medium ${bulkReason.trim() ? "text-emerald-600" : "text-rose-600"}`}>
                      {bulkReason.trim() ? "Đã nhập lý do." : "Lý do là bắt buộc."}
                    </p>
                  )}
                </div>
              )}

              {bulkDialogError && (
                <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm font-semibold text-rose-700">
                  {bulkDialogError}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
              <button
                type="button"
                disabled={bulkRunning}
                onClick={closeBulkDialog}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Huỷ
              </button>
              <button
                type="button"
                disabled={bulkRunning || (bulkDialog.requiresReason && !bulkReason.trim())}
                onClick={() => void runBulk()}
                className={`rounded-xl px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${
                  bulkDialog.kind === "APPROVE"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : bulkDialog.kind === "UNAPPROVE"
                      ? "bg-amber-600 hover:bg-amber-700"
                      : "bg-rose-600 hover:bg-rose-700"
                }`}
              >
                {bulkRunning
                  ? "Đang xử lý..."
                  : bulkDialog.kind === "APPROVE"
                    ? "Xác nhận duyệt"
                    : bulkDialog.kind === "UNAPPROVE"
                      ? "Xác nhận bỏ duyệt"
                      : "Xác nhận xoá"}
              </button>
            </div>
          </div>
        </div>
      )}

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

      {pastEditDialogOpen && editingVoucher && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-labelledby="past-edit-title">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wider text-amber-600">Phiếu đã qua ngày</p>
                <h3 id="past-edit-title" className="mt-1 text-base font-bold text-slate-900">Lý do chỉnh sửa phiếu ngày cũ</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {editingVoucher.code} · {new Date(editingVoucher.voucherDate).toLocaleDateString("vi-VN")}
                </p>
              </div>
              <button
                type="button"
                disabled={saving}
                onClick={() => setPastEditDialogOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                aria-label="Đóng"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>
            <div className="space-y-3 px-5 py-4">
              <p className="text-xs leading-5 text-slate-600">
                Sau khi lưu, hệ thống sẽ tự động duyệt lại phiếu và ghi dữ liệu trước/sau cùng lý do này vào Audit Log.
              </p>
              <textarea
                autoFocus
                value={pastEditReason}
                onChange={(event) => {
                  setPastEditReason(event.target.value);
                  if (pastEditError) setPastEditError("");
                }}
                placeholder="Nhập lý do chỉnh sửa..."
                className="h-28 w-full resize-none rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
              <div className="flex items-center justify-between gap-3">
                <span className={`text-[11px] font-medium ${pastEditReason.trim() ? "text-emerald-600" : "text-rose-600"}`}>
                  {pastEditReason.trim() ? "Đã nhập lý do." : "Lý do là bắt buộc."}
                </span>
                {pastEditError && <span className="text-right text-xs font-semibold text-rose-600">{pastEditError}</span>}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
              <button
                type="button"
                disabled={saving}
                onClick={() => setPastEditDialogOpen(false)}
                className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Huỷ
              </button>
              <button
                type="button"
                disabled={saving || !pastEditReason.trim()}
                onClick={() => void confirmPastEdit()}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {saving ? "Đang lưu..." : "Lưu và tự động duyệt lại"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ModuleFrame>
  );
}

export default function VouchersPage() {
  return <VoucherManagementPage documentChannel="CASH" />;
}
