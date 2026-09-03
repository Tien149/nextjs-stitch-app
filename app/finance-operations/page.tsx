"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ExportExcelButton from "@/components/ExportExcelButton";
import { DateInput, MonthInput } from "@/components/DateInput";
import { storeLabel, updateDynamicBranches, visibleBranchScopeOptions, visibleStoreOptions } from "@/lib/branch-labels";
import { canPerformMenuAction, filterModuleTabs, isCashierSubject } from "@/lib/auth-demo";
import { useModuleAuth } from "@/lib/use-module-auth";
import { filterCashierCashSources, filterMoneySources, isGrabMoneySource, moneySourceDebugLabel, moneySourceDisplayName, summaryMoneySourceGroups } from "@/lib/money-sources";
import CopyableText from "@/components/CopyableText";
import StickyFilterBar from "@/components/StickyFilterBar";
import { shiftLabels } from "@/lib/shifts";
import { normalizeCashflowCategoryType } from "@/lib/voucher-rules";
import { transferBranches } from "@/lib/internal-transfer";

type CashEntry = { id: string; date: string; createdAt: string; code: string; type: string; moneySourceCode: string; description: string; receipt: number; payment: number; balance: number };
type Schedule = { id: string; period: string; amount: number; status: string };
type Accrual = { id: string; code: string; name: string; branchCode: string; categoryCode: string; totalAmount: number; startPeriod: string; numberOfPeriods: number; status: string; schedules: Schedule[] };
type Check = { key: string; label: string; passed: boolean; count: number };
type MoneyTransferDenomination = { id: string; denomination: number; quantity: number; amount: number };
type MoneyTransfer = {
  id: string;
  code: string;
  transferDate: string;
  actualTransferDate?: string | null;
  branchCode: string;
  fromBranchCode?: string | null;
  toBranchCode?: string | null;
  fromMoneySourceCode: string;
  toMoneySourceCode: string;
  amount: number;
  feeAmount: number;
  /** Phần chi phí bán hàng Grab nằm trong feeAmount; phần còn lại là phí quẹt thẻ bán hàng. */
  grabExpenseAmount?: number;
  description: string;
  externalRef?: string | null;
  status: string;
  internalReceivableDebtCode?: string | null;
  internalPayableDebtCode?: string | null;
  transferPurpose?: string | null;
  depositTargetType?: string | null;
  sourceReportDate?: string | null;
  sourceShift?: string | null;
  denominations?: MoneyTransferDenomination[];
};
type OpeningBasis = { anchorPeriod: string | null; declaredThisPeriod: boolean };
type Data = { openingAmount: number; openingBasis: OpeningBasis; closingBalance: number; cashbook: CashEntry[]; accruals: Accrual[]; moneyTransfers: MoneyTransfer[]; accountingPeriod: { status: string; closedBy?: string; closedAt?: string }; checklist: Check[] };
type MasterDataOption = { id: string; type: string; code: string; name: string; group: string | null; branch: string | null; status?: string; summarySourceName?: string | null };
type CashDepositEditForm = {
  transfer: MoneyTransfer;
  depositTargetType: "PKT" | "CO";
  fromMoneySourceCode: string;
  toMoneySourceCode: string;
  denominations: Array<{ denomination: number; quantity: string }>;
};
type InternalTransferEditForm = {
  transfer: MoneyTransfer;
  transferDate: string;
  fromMoneySourceCode: string;
  toMoneySourceCode: string;
  amount: string;
  externalRef: string;
  description: string;
};

const money = (value: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(value);
/** Kỳ liền trước, dạng YYYY-MM. Tự tính tại đây để màn client không phải kéo theo lib server. */
const previousPeriod = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(year, (month || 1) - 2, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const WALLET_GRAB_EXPENSE_LABEL = "Chi phí bán hàng Grab";
const WALLET_CARD_FEE_LABEL = "Chi phí quẹt thẻ bán hàng";
/**
 * Phí của phiếu quyết toán ví gọi đúng tên khoản mục nó sẽ vào trên Báo cáo nguồn tiền:
 * phần chi phí bán hàng Grab tách riêng, phần còn lại là phí quẹt thẻ bán hàng. Phiếu nộp
 * tiền mặt vẫn là chênh lệch làm tròn như cũ.
 */
function transferFeeLabels(transfer: MoneyTransfer, fromSourceName?: string | null) {
  if (transfer.transferPurpose !== "WALLET_SETTLEMENT") {
    return [{ label: "Chi phí làm tròn", amount: transfer.feeAmount }];
  }
  const grabExpense = transfer.grabExpenseAmount || 0;
  const cardFee = transfer.feeAmount - grabExpense;
  if (grabExpense && cardFee) {
    return [{ label: WALLET_GRAB_EXPENSE_LABEL, amount: grabExpense }, { label: WALLET_CARD_FEE_LABEL, amount: cardFee }];
  }
  if (grabExpense) return [{ label: WALLET_GRAB_EXPENSE_LABEL, amount: grabExpense }];
  // Chưa tách phần Grab thì cả cục phí về khoản mục của ví: ví Grab -> Grab, còn lại -> quẹt thẻ.
  return [{
    label: isGrabMoneySource(transfer.fromMoneySourceCode, fromSourceName) ? WALLET_GRAB_EXPENSE_LABEL : WALLET_CARD_FEE_LABEL,
    amount: transfer.feeAmount,
  }];
}
/** Ngày hôm nay theo giờ máy trạm, tránh lệch một ngày khi ca tối duyệt sau 0h. */
const todayInput = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/**
 * Nguồn tiền được chọn cho phiếu điều tiền: gồm nguồn của cửa hàng phiếu và của cửa hàng
 * bên kia khi đây là phiếu liên nhà hàng, để sửa phiếu không làm mất nguồn của bên nhận.
 */
const transferSourceOptions = (sources: MasterDataOption[], transfer: MoneyTransfer) => {
  const { fromBranchCode, toBranchCode } = transferBranches(transfer);
  const branches = [...new Set([transfer.branchCode, fromBranchCode, toBranchCode])];
  const seen = new Set<string>();
  return branches.flatMap((branch) => filterMoneySources(sources, branch)
    .filter((source) => {
      if (seen.has(source.code)) return false;
      seen.add(source.code);
      return true;
    })
    .map((source) => ({ source, branch })));
};
const cashDepositTargetLabels: Record<string, string> = { PKT: "Nộp Tiền PKT", CO: "Nộp Tiền Cô" };
const cashDepositDenominations = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000];

export default function FinanceOperationsPage() {
  const href = "/finance-operations";
  const { user, loading } = useModuleAuth(href);

  const [active, setActive] = useState("cashbook");
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const [branchCode, setBranchCode] = useState("ALL");
  /** Lọc chi tiết sổ quỹ: khoảng ngày nằm trong kỳ kế toán và một nguồn tiền cụ thể. */
  const [cashbookRange, setCashbookRange] = useState({ startDate: "", endDate: "" });
  const [cashbookSource, setCashbookSource] = useState("");
  const [data, setData] = useState<Data>({ openingAmount: 0, openingBasis: { anchorPeriod: null, declaredThisPeriod: false }, closingBalance: 0, cashbook: [], accruals: [], moneyTransfers: [], accountingPeriod: { status: "OPEN" }, checklist: [] });
  const [message, setMessage] = useState("");
  const [transferQuery, setTransferQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingCashDeposit, setEditingCashDeposit] = useState<CashDepositEditForm | null>(null);
  const [editingInternalTransfer, setEditingInternalTransfer] = useState<InternalTransferEditForm | null>(null);
  const [selectedCashDepositIds, setSelectedCashDepositIds] = useState<string[]>([]);
  const [cashApproval, setCashApproval] = useState<{ ids: string[]; actualTransferDate: string } | null>(null);
  const [moneySources, setMoneySources] = useState<MasterDataOption[]>([]);
  /** Tra tên nguồn tiền theo mã: nhãn phí quyết toán ví đọc theo cả mã lẫn tên, giống báo cáo. */
  const moneySourceNameByCode = useMemo(() => new Map(moneySources.map((row) => [row.code, row.name])), [moneySources]);
  const [feeCategories, setFeeCategories] = useState<MasterDataOption[]>([]);
  const [settlement, setSettlement] = useState({
    transferDate: new Date().toISOString().slice(0, 10),
    branchCode: "",
    fromMoneySourceCode: "",
    toMoneySourceCode: "",
    grossAmount: "",
    amount: "",
    feeCategoryCode: "",
    externalRef: "",
  });

  const [adjustment, setAdjustment] = useState({
    entryDate: new Date().toISOString().slice(0, 10),
    entryType: "RECEIPT",
    // Cửa hàng/quỹ để trống: hai ô này bám theo bộ lọc "Phạm vi cửa hàng" của trang
    // (xem adjustmentBranchCode), không đặt cứng một cửa hàng nào.
    branchCode: "",
    moneySourceCode: "",
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

  // Khoảng ngày chỉ có nghĩa trong kỳ đang xem, còn nguồn tiền gắn với cửa hàng -> đổi thì bỏ lọc cũ.
  const changePeriod = (value: string) => {
    setPeriod(value);
    setCashbookRange({ startDate: "", endDate: "" });
  };
  const changeBranchScope = (value: string) => {
    setBranchCode(value);
    setCashbookSource("");
  };

  /**
   * Thu ngân chỉ nhìn thấy quỹ tiền mặt của thu ngân — cùng danh sách với màn "Thu chi ngày".
   * API cũng lọc y hệt, chỗ này chỉ để ô lọc không chào những quỹ chọn vào cũng ra sổ trống.
   */
  const cashierScoped = isCashierSubject(user);
  const cashbookSourceOptions = useMemo(
    () => (cashierScoped
      ? filterCashierCashSources(moneySources, branchCode)
      : filterMoneySources(moneySources, branchCode)),
    [moneySources, branchCode, cashierScoped],
  );
  /** Nhóm "Nguồn tiền tổng": chọn một dòng là lọc được cả cụm nguồn chi tiết cùng tài khoản. */
  const cashbookSummaryGroups = useMemo(
    () => summaryMoneySourceGroups(cashbookSourceOptions),
    [cashbookSourceOptions],
  );
  // Sổ quỹ chỉ hiển thị "Nguồn tiền tổng" trên từng dòng (chốt meeting 22/08/2026): chuyển
  // khoản hay quẹt thẻ chỉ là phương thức thanh toán, số cuối cùng vẫn về một tài khoản.
  // Nguồn chi tiết vẫn tra được ở ô lọc và tooltip của dòng.
  const moneySourceSummaryLabel = useMemo(() => {
    const labels = new Map<string, string>();
    for (const source of moneySources) {
      labels.set(source.code, (source.summarySourceName || "").trim() || moneySourceDisplayName(source));
    }
    return labels;
  }, [moneySources]);
  /**
   * Form Điều chỉnh quỹ luôn bám theo bộ lọc "Phạm vi cửa hàng" của trang.
   *
   * Trước đây form giữ cửa hàng riêng: chọn Asa trên thanh lọc mà form vẫn còn Nam Mê của lần
   * trước, ô Nguồn tiền cũng vẫn liệt kê quỹ của Nam Mê — người dùng ghi kiểm kê vào quỹ của
   * cửa hàng khác lúc nào không hay. Chỉ khi lọc "Tất cả cửa hàng" thì form mới để tự chọn.
   */
  const adjustmentBranchCode = branchCode === "ALL" ? adjustment.branchCode : branchCode;
  const adjustmentCashSources = useMemo(
    () => filterMoneySources(moneySources, adjustmentBranchCode, ["CASH"]),
    [moneySources, adjustmentBranchCode],
  );
  // Quỹ đã chọn của cửa hàng cũ không còn hợp lệ sau khi đổi cửa hàng -> rơi về quỹ đầu tiên.
  const adjustmentMoneySourceCode = adjustmentCashSources.some((source) => source.code === adjustment.moneySourceCode)
    ? adjustment.moneySourceCode
    : (adjustmentCashSources[0]?.code || "");

  const cashbookRangeInvalid = Boolean(
    cashbookRange.startDate && cashbookRange.endDate && cashbookRange.startDate > cashbookRange.endDate,
  );
  const hasCashbookRange = Boolean(cashbookRange.startDate || cashbookRange.endDate);
  /**
   * Số dư đầu kỳ chỉ khai tay một lần ở kỳ gốc, các kỳ sau kế thừa số dư cuối kỳ trước.
   * Ghi rõ số đang đứng đây đến từ đâu để không ai đi nhập lại số dư mỗi tháng nữa.
   */
  const openingBasisHint = useMemo(() => {
    const { anchorPeriod, declaredThisPeriod } = data.openingBasis;
    const label = (value: string) => `${value.slice(5, 7)}/${value.slice(0, 4)}`;
    const previous = label(previousPeriod(period));
    if (declaredThisPeriod) return { label: `Khai số dư gốc kỳ ${label(period)}`, title: "Kỳ này có bản khai số dư đầu kỳ nhập tay — thường chỉ dùng cho kỳ đầu tiên dùng hệ thống hoặc khi cần chốt lại sổ." };
    if (anchorPeriod) return { label: `Kế thừa số dư cuối kỳ ${previous}`, title: `Số dư gốc khai ở kỳ ${label(anchorPeriod)}, cộng toàn bộ phát sinh thu/chi/điều tiền tới hết kỳ ${previous}.` };
    return { label: "Chưa khai số dư gốc — đang cộng từ phát sinh", title: "Chưa có bản khai số dư đầu kỳ nào cho phạm vi này. Số đang hiện là tổng phát sinh thu/chi/điều tiền trước kỳ này. Vào màn Số dư đầu kỳ khai một lần cho kỳ đầu tiên dùng hệ thống." };
  }, [data.openingBasis, period]);

  const visibleTabs = useMemo(() => filterModuleTabs(user, href), [user]);
  const normalizedTransferQuery = transferQuery.trim().toLowerCase();
  const filteredCashbook = useMemo(() => {
    if (!normalizedTransferQuery) return data.cashbook;
    return data.cashbook.filter((row) => [row.code, row.moneySourceCode, moneySourceSummaryLabel.get(row.moneySourceCode) || "", row.description]
      .some((value) => value.toLowerCase().includes(normalizedTransferQuery)));
  }, [data.cashbook, normalizedTransferQuery, moneySourceSummaryLabel]);
  const selectedTransfer = useMemo(() => {
    if (!normalizedTransferQuery) return null;
    return data.moneyTransfers.find((row) => row.code.toLowerCase() === normalizedTransferQuery) || null;
  }, [data.moneyTransfers, normalizedTransferQuery]);
  const pendingCashDeposits = useMemo(
    () => data.moneyTransfers.filter((row) => row.status === "PENDING_REVIEW" && row.transferPurpose === "CASH_DEPOSIT"),
    [data.moneyTransfers],
  );
  const activeSelectedCashDepositIds = useMemo(() => {
    const eligibleIds = new Set(pendingCashDeposits.map((row) => row.id));
    return selectedCashDepositIds.filter((id) => eligibleIds.has(id));
  }, [pendingCashDeposits, selectedCashDepositIds]);
  /**
   * Tổng của riêng các phiếu đang tick, để kế toán đối chiếu với số tiền bó lại đem nộp
   * trước khi bấm duyệt. Cộng cả clear vì đó mới là số thực nộp sau chi phí làm tròn.
   */
  const selectedCashDepositTotals = useMemo(() => {
    const selected = new Set(activeSelectedCashDepositIds);
    return pendingCashDeposits.filter((row) => selected.has(row.id)).reduce(
      (sum, row) => ({ count: sum.count + 1, amount: sum.amount + row.amount, feeAmount: sum.feeAmount + row.feeAmount }),
      { count: 0, amount: 0, feeAmount: 0 },
    );
  }, [pendingCashDeposits, activeSelectedCashDepositIds]);

  // Deep-link từ màn Đối soát: mở đúng kỳ/cửa hàng và định vị phiếu QTVI thay vì chỉ mở trang chung.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedPeriod = params.get("period") || "";
    const linkedBranch = params.get("branchCode") || "";
    const linkedTransfer = params.get("transfer") || "";
    window.setTimeout(() => {
      if (/^\d{4}-\d{2}$/.test(linkedPeriod)) setPeriod(linkedPeriod);
      if (linkedBranch) setBranchCode(linkedBranch);
      if (linkedTransfer) setTransferQuery(linkedTransfer);
    }, 0);
  }, []);

  // Tab mặc định có thể nằm ngoài quyền -> chuyển về tab đầu tiên được phép.
  useEffect(() => {
    if (visibleTabs.length === 0) return;
    if (visibleTabs.some((tab) => tab.id === active)) return;
    const fallback = visibleTabs[0].id;
    window.setTimeout(() => setActive(fallback), 0);
  }, [active, visibleTabs]);
  const canCreate = user ? canPerformMenuAction(user, href, "create") : false;
  const canEdit = user ? canPerformMenuAction(user, href, "edit") : false;
  const canClose = user?.role === "Admin";
  const canApproveTransfer = user ? canPerformMenuAction(user, href, "approve") : false;

  const loadData = useCallback(async () => {
    // Từ ngày lớn hơn đến ngày thì không gọi API, tránh hiển thị sổ quỹ rỗng gây hiểu nhầm mất dữ liệu.
    if (cashbookRange.startDate && cashbookRange.endDate && cashbookRange.startDate > cashbookRange.endDate) return;
    const query = new URLSearchParams({ period, branchCode });
    if (cashbookRange.startDate) query.set("startDate", cashbookRange.startDate);
    if (cashbookRange.endDate) query.set("endDate", cashbookRange.endDate);
    if (cashbookSource) query.set("moneySourceCode", cashbookSource);
    const response = await fetch(`/api/finance-operations?${query.toString()}`);
    if (response.ok) setData((await response.json()) as Data);
  }, [branchCode, period, cashbookRange.startDate, cashbookRange.endDate, cashbookSource]);

  const loadMoneySources = useCallback(async () => {
    void fetch("/api/master-data?type=REVENUE_EXPENSE_CATEGORY&status=ACTIVE")
      .then((res) => (res.ok ? res.json() : []))
      .then((items: MasterDataOption[]) => setFeeCategories(items.filter((item) => normalizeCashflowCategoryType(item.group) === "PAYMENT")))
      .catch(() => setFeeCategories([]));
    // Danh sách cửa hàng thật phải nạp ngay tại trang này. Mã mặc định trong các form dưới là
    // dữ liệu demo (HCM/HN): nếu không nắn về cửa hàng có thật thì ô Cửa hàng hiển thị cửa hàng
    // đầu danh sách trong khi state vẫn giữ mã demo, khiến ô Nguồn tiền lọc ra rỗng.
    const branchResponse = await fetch("/api/master-data?type=BRANCH&status=ACTIVE");
    let storeCodes: string[] = [];
    if (branchResponse.ok) {
      const branchItems = (await branchResponse.json()) as MasterDataOption[];
      const allowed = user?.allowedBranches?.length ? user.allowedBranches : ["ALL"];
      const visible = allowed.includes("ALL") ? branchItems : branchItems.filter((item) => allowed.includes(item.code));
      updateDynamicBranches(visible.map((item) => ({ code: item.code, name: item.name })));
      storeCodes = visible.map((item) => item.code);
    }

    const response = await fetch("/api/master-data?type=MONEY_SOURCE&status=ACTIVE");
    if (!response.ok) return;
    const sources = (await response.json()) as MasterDataOption[];
    setMoneySources(sources);
    const toRealStore = (code: string) => (storeCodes.length && !storeCodes.includes(code) ? storeCodes[0] : code);
    // Cửa hàng của form chỉ có nghĩa khi lọc "Tất cả cửa hàng"; danh mục về thì đưa về một cửa
    // hàng có thật. Quỹ tiền mặt không cần chỉnh ở đây vì đã dẫn xuất theo cửa hàng đang chọn.
    setAdjustment((current) => {
      const nextBranch = toRealStore(current.branchCode);
      return nextBranch === current.branchCode ? current : { ...current, branchCode: nextBranch, moneySourceCode: "" };
    });
    setAccrual((current) => {
      const nextBranch = toRealStore(current.branchCode);
      return nextBranch === current.branchCode ? current : { ...current, branchCode: nextBranch };
    });
  }, [user]);

  useEffect(() => {
    if (!loading) {
      window.setTimeout(() => {
        void loadData();
        void loadMoneySources();
      }, 0);
    }
  }, [loading, loadData, loadMoneySources]);

  const settlementFee = Math.max(0, Number(settlement.grossAmount || 0)) - Math.max(0, Number(settlement.amount || 0));
  const editingDenominationTotal = editingCashDeposit?.denominations.reduce((sum, row) => {
    return sum + row.denomination * Math.max(0, Math.floor(Number(row.quantity) || 0));
  }, 0) || 0;

  const openCashDepositEdit = (transfer: MoneyTransfer) => {
    const quantityByDenomination = new Map((transfer.denominations || []).map((row) => [row.denomination, row.quantity]));
    setEditingCashDeposit({
      transfer,
      depositTargetType: transfer.depositTargetType === "CO" ? "CO" : "PKT",
      fromMoneySourceCode: transfer.fromMoneySourceCode,
      toMoneySourceCode: transfer.toMoneySourceCode,
      denominations: cashDepositDenominations.map((denomination) => ({
        denomination,
        quantity: quantityByDenomination.get(denomination) ? String(quantityByDenomination.get(denomination)) : "",
      })),
    });
    setMessage("");
  };

  const openInternalTransferEdit = (transfer: MoneyTransfer) => {
    setEditingInternalTransfer({
      transfer,
      transferDate: transfer.transferDate.slice(0, 10),
      fromMoneySourceCode: transfer.fromMoneySourceCode,
      toMoneySourceCode: transfer.toMoneySourceCode,
      amount: String(transfer.amount),
      externalRef: transfer.externalRef || "",
      description: transfer.description,
    });
    setMessage("");
  };

  const saveInternalTransferEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingInternalTransfer || submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "UPDATE_PENDING_INTERNAL_TRANSFER", id: editingInternalTransfer.transfer.id, ...editingInternalTransfer, transfer: undefined }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không sửa được phiếu điều tiền nội bộ.");
        return;
      }
      setEditingInternalTransfer(null);
      setMessage(`Đã cập nhật phiếu ${payload.code}.`);
      await loadData();
    } catch {
      setMessage("Lỗi kết nối máy chủ khi sửa phiếu điều tiền nội bộ.");
    } finally {
      setSubmitting(false);
    }
  };

  /** Mở popup duyệt: mặc định lấy ngày bấm duyệt, kế toán duyệt trễ thì sửa lại đúng ngày nộp tiền thực tế. */
  const openCashApproval = (ids: string[]) => {
    if (ids.length === 0) return;
    setCashApproval({ ids, actualTransferDate: todayInput() });
    setMessage("");
  };

  const approveCashDeposits = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!cashApproval || !cashApproval.actualTransferDate || submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "APPROVE_CASH_DEPOSIT_TRANSFERS", ...cashApproval }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không duyệt được phiếu nộp tiền.");
        return;
      }
      setCashApproval(null);
      setSelectedCashDepositIds([]);
      setMessage(`Đã duyệt ${payload.count} phiếu theo ngày thực tế ${new Date(`${payload.actualTransferDate.slice(0, 10)}T00:00:00`).toLocaleDateString("vi-VN")}.`);
      await loadData();
    } catch {
      setMessage("Lỗi kết nối máy chủ khi duyệt phiếu nộp tiền.");
    } finally {
      setSubmitting(false);
    }
  };

  const saveCashDepositEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingCashDeposit || submitting) return;
    if (editingDenominationTotal !== editingCashDeposit.transfer.amount) {
      setMessage(`Tổng bảng kê phải bằng ${money(editingCashDeposit.transfer.amount)} đ.`);
      return;
    }
    setSubmitting(true);
    setMessage("");
    try {
      const response = await fetch("/api/finance-operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "UPDATE_PENDING_CASH_DEPOSIT",
          id: editingCashDeposit.transfer.id,
          depositTargetType: editingCashDeposit.depositTargetType,
          fromMoneySourceCode: editingCashDeposit.fromMoneySourceCode,
          toMoneySourceCode: editingCashDeposit.toMoneySourceCode,
          denominations: editingCashDeposit.denominations.map((row) => ({
            denomination: row.denomination,
            quantity: Math.max(0, Math.floor(Number(row.quantity) || 0)),
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setMessage(payload.error || "Không sửa được phiếu nộp tiền.");
        return;
      }
      setEditingCashDeposit(null);
      setMessage(`Đã cập nhật phiếu ${payload.code}; số thực nộp và tổng clear được giữ nguyên.`);
      await loadData();
    } catch {
      setMessage("Lỗi kết nối máy chủ khi sửa phiếu nộp tiền.");
    } finally {
      setSubmitting(false);
    }
  };

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
          branchCode: adjustment.branchCode,
          moneySourceCode: "",
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

      <main className="max-w-[1600px] mx-auto px-6 mt-8 space-y-6">
        {/* Modern Filter Card */}
        <StickyFilterBar className="!bg-slate-100/90">
          <section className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold text-slate-600">Kỳ kế toán</span>
                <MonthInput className="w-44" value={period} onChange={changePeriod} ariaLabel="Kỳ sổ quỹ" />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold text-slate-600">Phạm vi cửa hàng</span>
                <div className="relative">
                  <select
                    value={branchCode}
                    onChange={(e) => changeBranchScope(e.target.value)}
                    className="w-48 pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer font-medium"
                  >
                    {visibleBranchScopeOptions(user).map((option) => (
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

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold text-slate-600">Khoảng thời gian</span>
                <div className="flex items-center gap-2">
                  <DateInput
                    className="w-36"
                    value={cashbookRange.startDate}
                    onChange={(startDate) => setCashbookRange((current) => ({ ...current, startDate }))}
                    ariaLabel="Sổ quỹ từ ngày"
                  />
                  <span className="text-xs font-bold text-slate-400">→</span>
                  <DateInput
                    className="w-36"
                    value={cashbookRange.endDate}
                    onChange={(endDate) => setCashbookRange((current) => ({ ...current, endDate }))}
                    ariaLabel="Sổ quỹ đến ngày"
                  />
                </div>
                {cashbookRangeInvalid && (
                  <span className="text-[11px] font-bold text-rose-600">Từ ngày đang lớn hơn đến ngày.</span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-bold text-slate-600">Nguồn tiền</span>
                <div className="relative">
                  <select
                    value={cashbookSource}
                    onChange={(event) => setCashbookSource(event.target.value)}
                    className="w-56 pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all appearance-none cursor-pointer font-medium"
                  >
                    <option value="">{cashierScoped ? "Tất cả quỹ thu ngân" : "Tất cả nguồn tiền"}</option>
                    {cashbookSummaryGroups.length > 0 ? (
                      <>
                        <optgroup label="Nguồn tiền tổng">
                          {cashbookSummaryGroups.map((group) => (
                            <option key={group.value} value={group.value} title={group.codes.join(", ")}>
                              {group.name} · Tổng {group.codes.length} nguồn
                              {branchCode === "ALL" && group.branch && group.branch !== "ALL" ? ` · ${storeLabel(group.branch)}` : ""}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Nguồn chi tiết">
                          {cashbookSourceOptions.map((source) => (
                            <option key={source.code} value={source.code} title={moneySourceDebugLabel(source)}>
                              {moneySourceDisplayName(source)}
                              {branchCode === "ALL" && source.branch && source.branch !== "ALL" ? ` · ${storeLabel(source.branch)}` : ""}
                            </option>
                          ))}
                        </optgroup>
                      </>
                    ) : cashbookSourceOptions.map((source) => (
                      <option key={source.code} value={source.code} title={moneySourceDebugLabel(source)}>
                        {moneySourceDisplayName(source)}
                        {branchCode === "ALL" && source.branch && source.branch !== "ALL" ? ` · ${storeLabel(source.branch)}` : ""}
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
                onClick={() => { void loadData(); void loadMoneySources(); }}
                className="h-10 px-3 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-bold flex items-center gap-1.5 transition-colors bg-white shadow-sm"
                title="Tải lại số liệu và danh mục nguồn tiền — sửa Nguồn tiền tổng bên Cấu hình xong bấm nút này là thấy ngay, không cần đăng nhập lại"
              >
                <span className="material-symbols-outlined text-sm">refresh</span>
                Tải lại
              </button>

              <span className={`px-4 py-2 rounded-xl text-xs font-bold border flex items-center gap-1.5 shadow-sm ${data.accountingPeriod.status === "CLOSED"
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
        </StickyFilterBar>

        {/* Tab Navigation */}
        <nav className="flex gap-1.5 border-b border-slate-200 overflow-x-auto">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActive(tab.id);
                setMessage("");
              }}
              className={`px-5 py-3 text-sm font-bold whitespace-nowrap border-b-2 flex items-center gap-2 transition-all duration-150 ${active === tab.id
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
            <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-6">
              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">{hasCashbookRange ? "Số dư đầu khoảng" : "Số dư đầu kỳ"}</p>
                  <p className="text-2xl font-black text-slate-800">{money(data.openingAmount)} đ</p>
                  {!hasCashbookRange && (
                    <p className="text-[11px] font-medium text-slate-400" title={openingBasisHint.title}>{openingBasisHint.label}</p>
                  )}
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
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Tổng phát sinh Chi</p>
                  <p className="text-2xl font-black text-rose-800">
                    -{money(data.cashbook.reduce((sum, row) => sum + row.payment, 0))} đ
                  </p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">arrow_upward</span>
                </div>
              </div>

              <div className="bg-white/80 backdrop-blur-md border border-slate-200/60 shadow-lg shadow-slate-100/50 rounded-2xl p-5 flex items-center justify-between group hover:shadow-xl hover:shadow-slate-200/50 transition-all duration-300">
                <div className="space-y-1">
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">{hasCashbookRange ? "Số dư cuối khoảng" : "Số dư cuối kỳ"}</p>
                  <p className="text-2xl font-black text-indigo-900">{money(data.closingBalance)} đ</p>
                </div>
                <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shadow-sm">
                  <span className="material-symbols-outlined text-2xl font-bold">account_balance_wallet</span>
                </div>
              </div>
            </div>

            {cashierScoped && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-900">
                Màn hình này chỉ hiện <b>quỹ tiền mặt của thu ngân</b> tại cửa hàng bạn phụ trách và chỉ để tra cứu.
                Các quỹ khác (két quản lý, tài khoản ngân hàng, ví/POS) cùng mọi thao tác ghi sổ thuộc phần việc của kế toán.
              </div>
            )}

            {canCreate && (
              <section className="overflow-hidden rounded-xl border border-indigo-200 bg-white shadow-sm">
                <div className="border-b border-indigo-100 bg-indigo-50 px-5 py-3">
                  <h3 className="text-sm font-bold text-indigo-900">Quyết toán ví / POS về ngân hàng</h3>
                  <p className="mt-0.5 text-xs text-indigo-700">
                    Doanh thu quẹt thẻ đã ghi đủ ở ví. Khi sao kê báo tiền về, nhập số gốc ở ví và số thực nhận —
                    hệ thống cộng tiền vào ngân hàng, xoá số treo ở ví và đẩy phần chênh sang chi phí trên P&amp;L.
                  </p>
                </div>
                <form
                  className="grid gap-3 p-5 md:grid-cols-3 xl:grid-cols-6"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send(
                      { action: "CREATE_WALLET_SETTLEMENT", ...settlement, branchCode: settlement.branchCode || (branchCode === "ALL" ? "" : branchCode) },
                      "Đã ghi nhận quyết toán ví về ngân hàng.",
                    );
                  }}
                >
                  <label className="text-xs font-bold text-slate-600">
                    Ngày về tài khoản
                    <DateInput className="mt-1.5 w-full" value={settlement.transferDate} onChange={(value) => setSettlement({ ...settlement, transferDate: value })} ariaLabel="Ngày quyết toán" />
                  </label>
                  <label className="text-xs font-bold text-slate-600">
                    Cửa hàng
                    <select
                      className="control"
                      value={settlement.branchCode || (branchCode === "ALL" ? "" : branchCode)}
                      onChange={(event) => setSettlement({ ...settlement, branchCode: event.target.value, fromMoneySourceCode: "", toMoneySourceCode: "" })}
                      required
                    >
                      <option value="">-- Chọn cửa hàng --</option>
                      {visibleStoreOptions(user).map((option) => (
                        <option key={option.code} value={option.code}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-slate-600">
                    Nguồn ví / POS
                    <select
                      className="control"
                      value={settlement.fromMoneySourceCode}
                      onChange={(event) => setSettlement({ ...settlement, fromMoneySourceCode: event.target.value })}
                      required
                    >
                      <option value="">-- Chọn ví --</option>
                      {filterMoneySources(moneySources, settlement.branchCode || branchCode, ["WALLET"]).map((source) => (
                        <option key={source.code} value={source.code} title={moneySourceDebugLabel(source)}>{moneySourceDisplayName(source)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-slate-600">
                    Tài khoản nhận
                    <select
                      className="control"
                      value={settlement.toMoneySourceCode}
                      onChange={(event) => setSettlement({ ...settlement, toMoneySourceCode: event.target.value })}
                      required
                    >
                      <option value="">-- Chọn ngân hàng --</option>
                      {filterMoneySources(moneySources, settlement.branchCode || branchCode, ["BANK"]).map((source) => (
                        <option key={source.code} value={source.code} title={moneySourceDebugLabel(source)}>{moneySourceDisplayName(source)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-slate-600">
                    Số gốc ở ví
                    <input
                      className="control text-right"
                      inputMode="numeric"
                      placeholder="50000000"
                      value={settlement.grossAmount}
                      onChange={(event) => setSettlement({ ...settlement, grossAmount: event.target.value.replace(/\D/g, "") })}
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600">
                    Thực nhận về ngân hàng
                    <input
                      className="control text-right"
                      inputMode="numeric"
                      placeholder="49000000"
                      value={settlement.amount}
                      onChange={(event) => setSettlement({ ...settlement, amount: event.target.value.replace(/\D/g, "") })}
                      required
                    />
                  </label>
                  <label className="text-xs font-bold text-slate-600 md:col-span-2">
                    Khoản mục phí (lên P&amp;L)
                    <select
                      className="control"
                      value={settlement.feeCategoryCode}
                      onChange={(event) => setSettlement({ ...settlement, feeCategoryCode: event.target.value })}
                      required={settlementFee > 0}
                    >
                      <option value="">{feeCategories.length === 0 ? "-- Chưa khai báo khoản mục chi phí --" : "-- Chọn khoản mục phí --"}</option>
                      {feeCategories.map((category) => (
                        <option key={category.code} value={category.code}>{category.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs font-bold text-slate-600 md:col-span-2">
                    Tham chiếu sao kê
                    <input
                      className="control"
                      placeholder="Số tham chiếu dòng sao kê"
                      value={settlement.externalRef}
                      onChange={(event) => setSettlement({ ...settlement, externalRef: event.target.value })}
                    />
                  </label>
                  <div className="flex items-end gap-3 md:col-span-2">
                    <div className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] font-semibold text-slate-500">Phí quẹt thẻ</p>
                      <p className={`text-sm font-bold ${settlementFee < 0 ? "text-rose-600" : "text-slate-900"}`}>{money(settlementFee)} đ</p>
                    </div>
                    <button type="submit" disabled={submitting || settlementFee < 0} className="h-10 rounded-lg bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50">
                      Ghi nhận
                    </button>
                  </div>
                </form>
              </section>
            )}

            {data.moneyTransfers.some((transfer) => transfer.status === "PENDING_REVIEW") && (
              <section className="overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-amber-100 bg-amber-50 px-5 py-3">
                  <div>
                    <h3 className="text-sm font-bold text-amber-900">Điều tiền chờ duyệt</h3>
                    <p className="mt-0.5 text-xs text-amber-700">Dữ liệu import chỉ vào sổ quỹ sau khi Admin duyệt.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {canApproveTransfer && activeSelectedCashDepositIds.length > 0 && (
                      <button type="button" onClick={() => openCashApproval(activeSelectedCashDepositIds)} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-700">
                        Duyệt đã chọn ({activeSelectedCashDepositIds.length})
                      </button>
                    )}
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-amber-800">
                      {data.moneyTransfers.filter((transfer) => transfer.status === "PENDING_REVIEW").length}
                    </span>
                    <ExportExcelButton fileName="dieu_tien_cho_duyet" sheetName="Cho duyet" targetId="pending-transfer-table" />
                  </div>
                </div>
                <div id="pending-transfer-table" className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="w-10 px-3 py-3 text-center">
                          {canApproveTransfer && (
                            <input
                              type="checkbox"
                              aria-label="Chọn tất cả phiếu nộp tiền mặt"
                              checked={pendingCashDeposits.length > 0 && pendingCashDeposits.every((row) => activeSelectedCashDepositIds.includes(row.id))}
                              onChange={(event) => setSelectedCashDepositIds(event.target.checked ? pendingCashDeposits.map((row) => row.id) : [])}
                            />
                          )}
                        </th>
                        <th className="px-4 py-3">Ngày / Mã</th>
                        <th className="px-4 py-3">Ngày thực tế nộp tiền</th>
                        <th className="px-4 py-3">Từ nguồn</th>
                        <th className="px-4 py-3">Đến nguồn</th>
                        <th className="px-4 py-3 text-right">Số tiền</th>
                        <th className="px-4 py-3 text-right">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.moneyTransfers.filter((transfer) => transfer.status === "PENDING_REVIEW").map((transfer) => (
                        <tr key={transfer.id}>
                          <td className="px-3 py-3 text-center">
                            {canApproveTransfer && transfer.transferPurpose === "CASH_DEPOSIT" && (
                              <input
                                type="checkbox"
                                aria-label={`Chọn phiếu ${transfer.code}`}
                                checked={activeSelectedCashDepositIds.includes(transfer.id)}
                                onChange={(event) => setSelectedCashDepositIds((current) => event.target.checked ? [...new Set([...current, transfer.id])] : current.filter((id) => id !== transfer.id))}
                              />
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <CopyableText value={transfer.code}><b>{transfer.code}</b></CopyableText>
                            <p className="text-slate-500">{new Date(transfer.transferDate).toLocaleDateString("vi-VN")}</p>
                            {transfer.transferPurpose === "CASH_DEPOSIT" && (
                              <p className="mt-1 inline-flex rounded bg-blue-50 px-2 py-0.5 text-[11px] font-bold text-blue-700">
                                {cashDepositTargetLabels[transfer.depositTargetType || ""] || "Nộp tiền"} · {shiftLabels[transfer.sourceShift || ""] || transfer.sourceShift}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-500">{transfer.actualTransferDate ? new Date(transfer.actualTransferDate).toLocaleDateString("vi-VN", { timeZone: "UTC" }) : "—"}</td>
                          <td className="px-4 py-3">
                            <p>{transfer.fromMoneySourceCode}</p>
                            {transferBranches(transfer).isCrossBranch && (
                              <p className="mt-1 text-[11px] font-bold text-indigo-700">{storeLabel(transferBranches(transfer).fromBranchCode)}</p>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <p>{transfer.toMoneySourceCode}</p>
                            {transferBranches(transfer).isCrossBranch && (
                              <p className="mt-1 text-[11px] font-bold text-indigo-700">
                                {storeLabel(transferBranches(transfer).toBranchCode)} · ghi công nợ nội bộ hai đầu
                              </p>
                            )}
                            {transfer.denominations && transfer.denominations.length > 0 && (
                              <p className="mt-1 text-[11px] font-medium text-slate-500">
                                {transfer.denominations.map((row) => `${money(row.denomination)} x ${row.quantity}`).join(", ")}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className="font-bold">{money(transfer.amount)} đ</p>
                            {transfer.feeAmount !== 0 && (
                              <p className={`mt-1 text-[11px] font-medium ${transfer.feeAmount > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                                {transferFeeLabels(transfer, moneySourceNameByCode.get(transfer.fromMoneySourceCode)).map((line) => `${line.label}: ${money(line.amount)} đ`).join(" · ")} · Clear: {money(transfer.amount + transfer.feeAmount)} đ
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              {canEdit && transfer.transferPurpose === "CASH_DEPOSIT" && (
                                <button
                                  type="button"
                                  onClick={() => openCashDepositEdit(transfer)}
                                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 font-bold text-blue-700 hover:bg-blue-100"
                                >
                                  Sửa
                                </button>
                              )}
                              {canEdit && transfer.code.startsWith("CTNB") && (
                                <button
                                  type="button"
                                  onClick={() => openInternalTransferEdit(transfer)}
                                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 font-bold text-blue-700 hover:bg-blue-100"
                                >
                                  Sửa
                                </button>
                              )}
                              {canApproveTransfer ? (
                                <button type="button" onClick={() => transfer.transferPurpose === "CASH_DEPOSIT" ? openCashApproval([transfer.id]) : void send({ action: "APPROVE_TRANSFER", id: transfer.id }, "Đã duyệt giao dịch điều tiền.")} className="rounded-lg bg-emerald-600 px-3 py-2 font-bold text-white hover:bg-emerald-700">Duyệt</button>
                              ) : <span className="self-center text-slate-400">Chờ Admin</span>}
                              {canEdit && (
                                <button type="button" onClick={() => void send({ action: "CANCEL_PENDING_TRANSFER", id: transfer.id }, "Đã hủy giao dịch chờ duyệt.")} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 font-bold text-rose-700 hover:bg-rose-100">Hủy</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {canApproveTransfer && pendingCashDeposits.length > 0 && (
                      <tfoot className="border-t-2 border-slate-300 bg-slate-50">
                        <tr>
                          <td className="px-3 py-3" />
                          <td className="px-4 py-3" colSpan={4}>
                            {selectedCashDepositTotals.count > 0 ? (
                              <b className="text-slate-900">Tổng đã chọn · {selectedCashDepositTotals.count}/{pendingCashDeposits.length} phiếu nộp tiền mặt</b>
                            ) : (
                              <span className="text-slate-400">Tick ô đầu dòng để cộng tổng số tiền cần nộp</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <p className={`text-sm font-bold ${selectedCashDepositTotals.count > 0 ? "text-slate-900" : "text-slate-400"}`}>
                              {money(selectedCashDepositTotals.amount)} đ
                            </p>
                            {selectedCashDepositTotals.feeAmount !== 0 && (
                              <p className={`mt-1 text-[11px] font-medium ${selectedCashDepositTotals.feeAmount > 0 ? "text-amber-700" : "text-emerald-700"}`}>
                                Chi phí làm tròn: {money(selectedCashDepositTotals.feeAmount)} đ · Clear: {money(selectedCashDepositTotals.amount + selectedCashDepositTotals.feeAmount)} đ
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3" />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </section>
            )}

            {/* Content Split: Form & Table */}
            <div className="grid xl:grid-cols-[340px_minmax(0,1fr)] gap-5 items-start">
              {canCreate && data.accountingPeriod.status !== "CLOSED" ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!adjustmentBranchCode) {
                      setMessage("Chọn cửa hàng cần điều chỉnh quỹ.");
                      return;
                    }
                    if (!adjustmentMoneySourceCode) {
                      setMessage("Cửa hàng này chưa có quỹ tiền mặt để điều chỉnh.");
                      return;
                    }
                    void send(
                      { action: "CREATE_ADJUSTMENT", ...adjustment, branchCode: adjustmentBranchCode, moneySourceCode: adjustmentMoneySourceCode },
                      "Đã ghi nhận điều chỉnh sổ quỹ.",
                    );
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
                        value={adjustmentBranchCode}
                        // Lọc đang ở một cửa hàng cụ thể thì ô này chỉ hiển thị lại cửa hàng đó;
                        // đổi cửa hàng bằng bộ lọc phía trên để sổ quỹ và form luôn cùng một chỗ.
                        disabled={branchCode !== "ALL"}
                        onChange={(e) => setAdjustment({ ...adjustment, branchCode: e.target.value, moneySourceCode: "" })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500"
                        title={branchCode !== "ALL" ? "Theo bộ lọc Phạm vi cửa hàng phía trên" : undefined}
                      >
                        <option value="">-- Chọn cửa hàng --</option>
                        {visibleStoreOptions(user).map((option) => (
                          <option key={option.code} value={option.code}>
                            {storeLabel(option.code)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-bold text-slate-600">Nguồn tiền</span>
                      <select
                        value={adjustmentMoneySourceCode}
                        onChange={(e) => setAdjustment({ ...adjustment, moneySourceCode: e.target.value })}
                        className="w-full pl-3 pr-8 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none shadow-sm transition-all cursor-pointer"
                      >
                        <option value="">-- Chọn quỹ tiền mặt --</option>
                        {adjustmentCashSources.map((source) => (
                          <option key={source.id || source.code} value={source.code} title={moneySourceDebugLabel(source, storeLabel(adjustmentBranchCode))}>
                            {moneySourceDisplayName(source, storeLabel(adjustmentBranchCode))}
                          </option>
                        ))}
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
              <section className="min-w-0 bg-white border border-slate-200 rounded-2xl shadow-lg overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900">Phát sinh dòng tiền trong kỳ</h3>
                    <p className="text-xs text-slate-500 mt-1">Danh sách thu/chi và biến động số dư thực tế theo nguồn quỹ.</p>
                  </div>
                  <div className="flex w-full max-w-md gap-2">
                    <input
                      value={transferQuery}
                      onChange={(event) => setTransferQuery(event.target.value)}
                      placeholder="Tìm mã phiếu QTVI..."
                      className="h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-indigo-500"
                    />
                    {transferQuery && (
                      <button type="button" onClick={() => setTransferQuery("")} className="h-10 rounded-lg border border-slate-300 px-3 text-sm font-bold text-slate-600 hover:bg-slate-50">Xóa</button>
                    )}
                    <ExportExcelButton fileName="dong_tien_trong_ky" sheetName="Dong tien" targetId="cashflow-movement-table" className="h-10 shrink-0 rounded-lg border border-slate-300 bg-white px-3 text-sm font-bold text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5" />
                  </div>
                </div>

                {selectedTransfer?.transferPurpose === "WALLET_SETTLEMENT" && (
                  <div className="border-b border-indigo-100 bg-indigo-50/70 px-6 py-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-indigo-600">Chi tiết quyết toán Ví/POS</p>
                        <p className="mt-1 font-bold text-slate-900">{selectedTransfer.code}</p>
                        <p className="mt-1 text-xs text-slate-600">{selectedTransfer.fromMoneySourceCode} → {selectedTransfer.toMoneySourceCode} · Ngày doanh thu {selectedTransfer.sourceReportDate ? new Date(selectedTransfer.sourceReportDate).toLocaleDateString("vi-VN", { timeZone: "UTC" }) : "—"}</p>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-right">
                        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] font-semibold text-slate-500">Thực nhận</p>
                          <p className="font-bold text-emerald-700">{money(selectedTransfer.amount)} đ</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] font-semibold text-slate-500">Phí</p>
                          <p className="font-bold text-amber-700">{money(selectedTransfer.feeAmount)} đ</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] font-semibold text-slate-500">Gross đã clear</p>
                          <p className="font-bold text-indigo-700">{money(selectedTransfer.amount + selectedTransfer.feeAmount)} đ</p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div id="cashflow-movement-table" className="max-h-[640px] overflow-auto overscroll-contain [scrollbar-gutter:stable]">
                  <table className="min-w-[1050px] w-full text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-200 shadow-[0_1px_0_rgba(148,163,184,0.25)]">
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
                      {filteredCashbook.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-5 py-12 text-center text-slate-400 font-medium">
                            Chưa có phát sinh dòng tiền nào trong kỳ này.
                          </td>
                        </tr>
                      ) : (
                        filteredCashbook.map((row) => (
                          <tr key={`${row.type}-${row.id}`} className={`${normalizedTransferQuery && row.code.toLowerCase().includes(normalizedTransferQuery) ? "bg-indigo-50/70" : ""} hover:bg-slate-50/40 transition-colors`}>
                            <td className="px-5 py-4 whitespace-nowrap text-slate-500 text-xs font-medium">
                              {new Date(row.date).toLocaleDateString("vi-VN")}
                            </td>
                            <td className="px-5 py-4 whitespace-nowrap text-xs font-bold text-slate-800">
                              <div className="flex flex-col gap-0.5">
                                <CopyableText value={row.code}><span>{row.code}</span></CopyableText>
                                <span className="text-[10px] text-slate-400 font-semibold" title={`Nguồn chi tiết: ${row.moneySourceCode}`}>
                                  {moneySourceSummaryLabel.get(row.moneySourceCode) || row.moneySourceCode}
                                </span>
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
                      {visibleStoreOptions(user).map((option) => (
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
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${schedule.status === "POSTED"
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
                        <span className={`material-symbols-outlined text-2xl ${item.passed ? "text-emerald-500 font-bold" : "text-rose-500 font-bold animate-pulse"
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

                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${item.passed
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
                <div className={`h-12 w-12 rounded-xl grid place-items-center shadow-sm ${data.accountingPeriod.status === "CLOSED"
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

      {cashApproval && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4 backdrop-blur-sm">
          <form onSubmit={approveCashDeposits} className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-600">Xác nhận duyệt tiền mặt</p>
                <h2 className="mt-1 text-lg font-bold text-slate-900">Ngày thực tế nộp tiền</h2>
                <p className="mt-1 text-xs text-slate-500">Áp dụng cho {cashApproval.ids.length} phiếu đã chọn.</p>
              </div>
              <button type="button" onClick={() => setCashApproval(null)} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="space-y-4 p-5">
              <label className="block text-xs font-bold text-slate-600">
                Ngày thực tế nộp tiền *
                <DateInput className="mt-1.5 w-full" value={cashApproval.actualTransferDate} onChange={(value) => setCashApproval((current) => current ? { ...current, actualTransferDate: value } : current)} ariaLabel="Ngày thực tế nộp tiền" />
                <p className="mt-1.5 text-[11px] font-medium text-slate-500">Mặc định là ngày bấm duyệt. Nếu duyệt trễ, sửa lại đúng ngày tiền thực nộp.</p>
              </label>
              <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-xs text-emerald-900">
                <p className="font-bold">Tổng tiền: {money(data.moneyTransfers.filter((row) => cashApproval.ids.includes(row.id)).reduce((sum, row) => sum + row.amount, 0))} đ</p>
                <p className="mt-1">Ngày này sẽ là ngày giảm nguồn tiền mặt và tăng nguồn nhận trên Báo cáo nguồn tiền, Sổ quỹ và Sổ cái.</p>
              </div>
            </div>
            {message && <p className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{message}</p>}
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4">
              <button type="button" onClick={() => setCashApproval(null)} className="secondary-button">Hủy</button>
              <button disabled={submitting || !cashApproval.actualTransferDate} className="primary-button disabled:opacity-50">{submitting ? "Đang duyệt..." : `Xác nhận duyệt (${cashApproval.ids.length})`}</button>
            </div>
          </form>
        </div>
      )}

      {editingInternalTransfer && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4 backdrop-blur-sm">
          <form onSubmit={saveInternalTransferEdit} className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-blue-600">Sửa điều tiền nội bộ chờ duyệt</p>
                <h2 className="mt-1 text-lg font-bold text-slate-900">{editingInternalTransfer.transfer.code}</h2>
                <p className="mt-1 text-xs text-slate-500">{storeLabel(editingInternalTransfer.transfer.branchCode)}</p>
              </div>
              <button type="button" onClick={() => setEditingInternalTransfer(null)} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <label className="text-xs font-bold text-slate-600">Ngày điều tiền *<DateInput className="mt-1.5 w-full" value={editingInternalTransfer.transferDate} onChange={(value) => setEditingInternalTransfer((current) => current ? { ...current, transferDate: value } : current)} ariaLabel="Ngày điều tiền nội bộ" /></label>
              <label className="text-xs font-bold text-slate-600">Số tiền *<input className="control mt-1.5 text-right" inputMode="numeric" value={editingInternalTransfer.amount} onChange={(event) => setEditingInternalTransfer((current) => current ? { ...current, amount: event.target.value.replace(/\D/g, "") } : current)} /></label>
              <label className="text-xs font-bold text-slate-600">Từ nguồn *<select className="control mt-1.5" value={editingInternalTransfer.fromMoneySourceCode} onChange={(event) => setEditingInternalTransfer((current) => current ? { ...current, fromMoneySourceCode: event.target.value } : current)}>{transferSourceOptions(moneySources, editingInternalTransfer.transfer).map(({ source, branch }) => <option key={source.code} value={source.code}>{moneySourceDisplayName(source, storeLabel(branch))} · {storeLabel(branch)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600">Đến nguồn *<select className="control mt-1.5" value={editingInternalTransfer.toMoneySourceCode} onChange={(event) => setEditingInternalTransfer((current) => current ? { ...current, toMoneySourceCode: event.target.value } : current)}>{transferSourceOptions(moneySources, editingInternalTransfer.transfer).filter(({ source }) => source.code !== editingInternalTransfer.fromMoneySourceCode).map(({ source, branch }) => <option key={source.code} value={source.code}>{moneySourceDisplayName(source, storeLabel(branch))} · {storeLabel(branch)}</option>)}</select></label>
              <label className="text-xs font-bold text-slate-600 sm:col-span-2">Tham chiếu ngoài<input className="control mt-1.5" value={editingInternalTransfer.externalRef} onChange={(event) => setEditingInternalTransfer((current) => current ? { ...current, externalRef: event.target.value } : current)} /></label>
              <label className="text-xs font-bold text-slate-600 sm:col-span-2">Diễn giải *<textarea className="control mt-1.5 min-h-24" value={editingInternalTransfer.description} onChange={(event) => setEditingInternalTransfer((current) => current ? { ...current, description: event.target.value } : current)} /></label>
            </div>
            {message && <p className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{message}</p>}
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4">
              <button type="button" onClick={() => setEditingInternalTransfer(null)} className="secondary-button">Hủy</button>
              <button disabled={submitting || !editingInternalTransfer.transferDate || !editingInternalTransfer.amount || !editingInternalTransfer.fromMoneySourceCode || !editingInternalTransfer.toMoneySourceCode || editingInternalTransfer.fromMoneySourceCode === editingInternalTransfer.toMoneySourceCode || !editingInternalTransfer.description.trim()} className="primary-button disabled:opacity-50">{submitting ? "Đang lưu..." : "Lưu thay đổi"}</button>
            </div>
          </form>
        </div>
      )}

      {editingCashDeposit && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/45 p-4 backdrop-blur-sm">
          <form onSubmit={saveCashDepositEdit} className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-wide text-blue-600">Sửa phiếu nộp tiền chờ duyệt</p>
                <h2 className="mt-1 text-lg font-bold text-slate-900">{editingCashDeposit.transfer.code}</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {new Date(editingCashDeposit.transfer.transferDate).toLocaleDateString("vi-VN")} · {storeLabel(editingCashDeposit.transfer.branchCode)} · {shiftLabels[editingCashDeposit.transfer.sourceShift || ""] || editingCashDeposit.transfer.sourceShift}
                </p>
              </div>
              <button type="button" onClick={() => setEditingCashDeposit(null)} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="grid min-h-0 flex-1 gap-5 overflow-auto p-5 lg:grid-cols-[320px_1fr]">
              <div className="space-y-4">
                <label className="block text-xs font-bold text-slate-600">
                  Loại nộp tiền
                  <select
                    className="control"
                    value={editingCashDeposit.depositTargetType}
                    onChange={(event) => setEditingCashDeposit((current) => current ? { ...current, depositTargetType: event.target.value === "CO" ? "CO" : "PKT" } : current)}
                  >
                    <option value="PKT">Nộp Tiền PKT</option>
                    <option value="CO">Nộp Tiền Cô</option>
                  </select>
                </label>

                <label className="block text-xs font-bold text-slate-600">
                  Nguồn tiền mặt đi
                  <select
                    className="control"
                    value={editingCashDeposit.fromMoneySourceCode}
                    onChange={(event) => {
                      const nextFrom = event.target.value;
                      setEditingCashDeposit((current) => {
                        if (!current) return current;
                        const nextTarget = current.toMoneySourceCode === nextFrom
                          ? filterMoneySources(moneySources, current.transfer.branchCode).find((source) => source.code !== nextFrom)?.code || ""
                          : current.toMoneySourceCode;
                        return { ...current, fromMoneySourceCode: nextFrom, toMoneySourceCode: nextTarget };
                      });
                    }}
                  >
                    {filterMoneySources(moneySources, editingCashDeposit.transfer.branchCode, ["CASH"]).map((source) => (
                      <option key={source.code} value={source.code}>{moneySourceDisplayName(source, storeLabel(editingCashDeposit.transfer.branchCode))}</option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs font-bold text-slate-600">
                  Nguồn tiền nhận
                  <select
                    className="control"
                    value={editingCashDeposit.toMoneySourceCode}
                    onChange={(event) => setEditingCashDeposit((current) => current ? { ...current, toMoneySourceCode: event.target.value } : current)}
                  >
                    {filterMoneySources(moneySources, editingCashDeposit.transfer.branchCode)
                      .filter((source) => source.code !== editingCashDeposit.fromMoneySourceCode)
                      .map((source) => (
                        <option key={source.code} value={source.code}>{moneySourceDisplayName(source, storeLabel(editingCashDeposit.transfer.branchCode))}</option>
                      ))}
                  </select>
                </label>

                <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-xs">
                  <p className="font-bold text-blue-900">Số tiền được khóa</p>
                  <div className="mt-3 space-y-2 text-blue-800">
                    <p className="flex justify-between"><span>Thực nộp</span><b>{money(editingCashDeposit.transfer.amount)} đ</b></p>
                    <p className="flex justify-between"><span>Chi phí làm tròn</span><b>{money(editingCashDeposit.transfer.feeAmount)} đ</b></p>
                    <p className="flex justify-between border-t border-blue-200 pt-2"><span>Tổng clear</span><b>{money(editingCashDeposit.transfer.amount + editingCashDeposit.transfer.feeAmount)} đ</b></p>
                  </div>
                </div>
              </div>

              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">Bảng kê mệnh giá</h3>
                    <p className="text-xs text-slate-500">Được đổi cơ cấu số tờ nhưng không đổi tổng thực nộp.</p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-slate-500">Đã kê</p>
                    <p className={`font-bold ${editingDenominationTotal === editingCashDeposit.transfer.amount ? "text-emerald-700" : "text-rose-600"}`}>
                      {money(editingDenominationTotal)} / {money(editingCashDeposit.transfer.amount)} đ
                    </p>
                  </div>
                </div>
                <div className="max-h-[430px] overflow-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="sticky top-0 bg-white text-xs uppercase text-slate-500 shadow-[inset_0_-1px_0_#e2e8f0]">
                      <tr><th className="px-4 py-3">Mệnh giá</th><th className="px-4 py-3">Số tờ</th><th className="px-4 py-3 text-right">Thành tiền</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {editingCashDeposit.denominations.map((row) => {
                        const quantity = Math.max(0, Math.floor(Number(row.quantity) || 0));
                        return (
                          <tr key={row.denomination}>
                            <td className="px-4 py-2.5 font-bold">{money(row.denomination)} đ</td>
                            <td className="px-4 py-2.5">
                              <input
                                className="control mt-0 h-9 w-28 py-1.5 text-right"
                                inputMode="numeric"
                                value={row.quantity}
                                placeholder="0"
                                onChange={(event) => {
                                  const quantityValue = event.target.value.replace(/\D/g, "");
                                  setEditingCashDeposit((current) => current ? {
                                    ...current,
                                    denominations: current.denominations.map((item) => item.denomination === row.denomination ? { ...item, quantity: quantityValue } : item),
                                  } : current);
                                }}
                              />
                            </td>
                            <td className="px-4 py-2.5 text-right font-bold">{money(row.denomination * quantity)} đ</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {editingDenominationTotal !== editingCashDeposit.transfer.amount && (
                  <p className="border-t border-rose-100 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">
                    Tổng bảng kê phải bằng {money(editingCashDeposit.transfer.amount)} đ.
                  </p>
                )}
              </div>
            </div>

            {message && <p className="mx-5 mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">{message}</p>}
            <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 p-4">
              <button type="button" onClick={() => setEditingCashDeposit(null)} className="secondary-button">Hủy</button>
              <button
                disabled={submitting || editingDenominationTotal !== editingCashDeposit.transfer.amount || !editingCashDeposit.fromMoneySourceCode || !editingCashDeposit.toMoneySourceCode}
                className="primary-button disabled:opacity-50"
              >
                {submitting ? "Đang lưu..." : "Lưu thay đổi"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
