"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { displayRoleName, storeLabel } from "@/lib/branch-labels";
import { exportRowsToExcel } from "@/lib/export-table-excel";
import { appMenuItems, canAccessMenu, canPerformAction, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";
import { logout } from "@/lib/session-client";
import { MonthInput } from "@/components/DateInput";
import CopyableText from "@/components/CopyableText";
import { moneySourceMatchesBranch, normalizeMoneySourceGroup } from "@/lib/money-sources";

type MasterDataItem = {
  id: string;
  type: string;
  code: string;
  name: string;
  group: string | null;
  subGroup: string | null;
  partnerType: string | null;
  partnerGroup: string | null;
  branch: string | null;
  taxCode: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  accountNo: string | null;
  codePrefix: string | null;
  settlementBankCode: string | null;
  summarySourceName: string | null;
  matchKeywords: string | null;
  skipInventory: boolean;
  status: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

type MasterDataForm = {
  id?: string;
  type: string;
  code: string;
  name: string;
  group: string;
  subGroup: string;
  partnerType: string;
  partnerGroup: string;
  branch: string;
  taxCode: string;
  contactName: string;
  phone: string;
  email: string;
  accountNo: string;
  codePrefix: string;
  settlementBankCode: string;
  summarySourceName: string;
  matchKeywords: string;
  skipInventory: boolean;
  note: string;
  status: string;
};

type GroupOption = { value: string; label: string };

/** Kết quả API chuẩn hoá nhóm doanh thu của dữ liệu đã import (app/api/master-data/revenue-normalize). */
type RevenueNormalizeResult = {
  applied: boolean;
  total: number;
  unchanged: number;
  unresolved: number;
  changedRows: number;
  journalLines: number;
  /** Dòng của nhóm doanh thu không theo dõi tồn kho được thả khỏi hàng chờ rã nguyên liệu. */
  releasedRows: number;
  groups: { revenueSource: string; departmentCode: string | null; rows: number }[];
};

const tabs = [
  { type: "BRANCH", label: "Cửa hàng", icon: "storefront", hint: "1.1 - Đơn vị vận hành" },
  { type: "DEPARTMENT", label: "Phòng ban", icon: "groups", hint: "1.1 - Bộ phận nội bộ" },
  { type: "WAREHOUSE", label: "Kho hàng", icon: "warehouse", hint: "1.1 - Địa điểm lưu kho" },
  { type: "PARTNER", label: "Đối tác", icon: "handshake", hint: "1.1 - Khách hàng, NCC, Đối tác" },
  { type: "MONEY_SOURCE", label: "Nguồn tiền", icon: "account_balance_wallet", hint: "1.1 - Quỹ/Ngân hàng/Ví" },
  { type: "PNL_GROUP", label: "Nhóm hạng mục P&L", icon: "account_tree", hint: "1.2 - Nhóm lớn trên báo cáo P&L" },
  { type: "PNL_ITEM", label: "Hạng mục P&L", icon: "list_alt", hint: "1.2 - Dòng chi tiết trong từng nhóm P&L" },
  { type: "REVENUE_EXPENSE_CATEGORY", label: "Thu / Chi", icon: "category", hint: "1.2 - Danh mục dòng tiền: nhóm doanh thu, thu khác, chi" },
  { type: "ASSET_GROUP", label: "Nhóm tài sản", icon: "precision_manufacturing", hint: "1.2 - Tài sản/CCDC" },
  { type: "INVENTORY_ITEM_GROUP", label: "Nhóm mặt hàng", icon: "inventory_2", hint: "1.2 - Nguyên liệu, hàng hóa" },
  { type: "ACCOUNTING_PERIOD", label: "Kỳ kế toán", icon: "calendar_month", hint: "1.4 - Mở/khóa kỳ ghi sổ" },
  { type: "DOCUMENT_TYPE", label: "Loại chứng từ", icon: "receipt_long", hint: "1.4 - Phiếu thu/chi/cọc" },
  { type: "DOCUMENT_NUMBER_RULE", label: "Quy tắc mã", icon: "tag", hint: "1.4 - Thiết lập số chứng tự tự sinh" },
  { type: "SYSTEM_PARAM", label: "Tham số hệ thống", icon: "tune", hint: "1.4 - Thuế VAT/trạng thái nghiệp vụ" },
];

const emptyForm: MasterDataForm = {
  type: "BRANCH",
  code: "",
  name: "",
  group: "",
  subGroup: "",
  partnerType: "",
  partnerGroup: "EXTERNAL",
  branch: "",
  taxCode: "",
  contactName: "",
  phone: "",
  email: "",
  accountNo: "",
  codePrefix: "",
  settlementBankCode: "",
  summarySourceName: "",
  matchKeywords: "",
  skipInventory: false,
  note: "",
  status: "ACTIVE",
};

/** Giá trị ảo của ô chọn Nguồn tiền tổng để mở ô nhập tên mới. */
const NEW_SUMMARY_SOURCE_NAME = "__NEW_SUMMARY_SOURCE__";

const groupPlaceholders: Record<string, string> = {
  PNL_GROUP: "VD: OPEX / CAPEX / Gia von / Nguon doanh thu",
  PNL_ITEM: "VD: OPEX / CAPEX / Gia von / Nguon doanh thu",
  BRANCH: "VD: Branch / Head Office",
  DEPARTMENT: "VD: Back office / Operation",
  WAREHOUSE: "VD: BEP / BAR / FOH (khớp Nhóm kho của phân nhóm mặt hàng)",
  PARTNER: "VD: Khach hang / Nha cung cap / Doi tac",
  MONEY_SOURCE: "VD: Tien mat / Ngan hang / Vi/POS",
  REVENUE_EXPENSE_CATEGORY: "Nhóm doanh thu (bán hàng) / Thu khác / Chi",
  ASSET_GROUP: "VD: Tai san co dinh / CCDC / May moc",
  INVENTORY_ITEM_GROUP: "VD: Nguyen lieu / Ban thanh pham / Thanh pham",
  ACCOUNTING_PERIOD: "VD: OPEN / CLOSED",
  DOCUMENT_TYPE: "VD: Thu / Chi / Tien coc",
  DOCUMENT_NUMBER_RULE: "VD: PT / PC / COC",
  SYSTEM_PARAM: "VD: Thue / Trang thai nghiep vu",
};

const codePlaceholders: Record<string, string> = {
  PNL_GROUP: "VD: PNL_CP_QUAN_LY",
  PNL_ITEM: "VD: PNL_CP_LUONG",
  BRANCH: "VD: HCM_STORE",
  DEPARTMENT: "VD: KE_TOAN",
  WAREHOUSE: "VD: KHO_TONG",
  PARTNER: "VD: NCC_001",
  MONEY_SOURCE: "VD: VCB_01",
  REVENUE_EXPENSE_CATEGORY: "VD: CHIPHI_OPEX",
  ASSET_GROUP: "VD: EQUIPMENT",
  INVENTORY_ITEM_GROUP: "VD: NVL",
  ACCOUNTING_PERIOD: "VD: 2026-07",
  DOCUMENT_TYPE: "VD: PHIEU_THU",
  DOCUMENT_NUMBER_RULE: "VD: RULE_PT",
  SYSTEM_PARAM: "VD: VAT_RATE",
};

const namePlaceholders: Record<string, string> = {
  PNL_GROUP: "VD: Chi phí quản lý doanh nghiệp",
  PNL_ITEM: "VD: Chi phí lương và phụ cấp",
  BRANCH: "VD: Cửa hàng Hồ Chí Minh",
  DEPARTMENT: "VD: Phòng Kế toán",
  WAREHOUSE: "VD: Kho tổng miền Nam",
  PARTNER: "VD: Công ty TNHH Nam Mới",
  MONEY_SOURCE: "VD: Ngân hàng VCB - 0123456789",
  REVENUE_EXPENSE_CATEGORY: "VD: Chi phí thuê mặt bằng",
  ASSET_GROUP: "VD: Máy móc thiết bị",
  INVENTORY_ITEM_GROUP: "VD: Nguyên vật liệu",
  ACCOUNTING_PERIOD: "VD: Kỳ kế toán Tháng 07/2026",
  DOCUMENT_TYPE: "VD: Phiếu thu tiền mặt",
  DOCUMENT_NUMBER_RULE: "VD: Quy tắc mã phiếu thu",
  SYSTEM_PARAM: "VD: Thuế suất VAT mặc định",
};

const notePlaceholders: Record<string, string> = {
  REVENUE_EXPENSE_CATEGORY: "VD: dùng phân loại dòng tiền trên phiếu thu/chi",
  ASSET_GROUP: "VD: dung de phan loai tai san, CCDC, bao tri va khau hao",
  INVENTORY_ITEM_GROUP: "VD: dung de loc ton kho, dinh luong, mua hang",
  ACCOUNTING_PERIOD: "VD: ngay bat dau/ket thuc ky, ghi chu khoa so",
  DOCUMENT_TYPE: "VD: chung tu thu tien, chi tien, ghi nhan tien coc",
  DOCUMENT_NUMBER_RULE: "VD: PTHU-2607-ASA-00001 (MãPhiếu-YYMM-ChiNhánh-STT5)",
  SYSTEM_PARAM: "VD: VAT 8%, trang thai nghiep vu...",
};

const groupOptions: Record<string, GroupOption[]> = {
  PARTNER: [
    { value: "CUSTOMER", label: "CUSTOMER - Khách hàng" },
    { value: "SUPPLIER", label: "SUPPLIER - Nhà cung cấp" },
    { value: "BOTH", label: "BOTH - Khách hàng & NCC" },
    { value: "EMPLOYEE", label: "EMPLOYEE - Nhân viên" },
    { value: "OTHER_PARTNER", label: "OTHER_PARTNER - Đối tác khác" },
  ],
  MONEY_SOURCE: [
    { value: "CASH", label: "CASH - Tiền mặt" },
    { value: "BANK", label: "BANK - Tài khoản ngân hàng" },
    { value: "WALLET", label: "WALLET - Ví điện tử / Cổng POS" },
  ],
  REVENUE_EXPENSE_CATEGORY: [
    // Thu tách làm hai: chỉ NHÓM DOANH THU mới gán được cho mặt hàng và lên dòng doanh thu P&L.
    { value: "REVENUE_SOURCE", label: "1 - Thu: Nhóm doanh thu (bán hàng)" },
    { value: "RECEIPT", label: "2 - Thu: Loại thu khác (không phải doanh thu)" },
    { value: "PAYMENT", label: "3 - Chi" },
  ],
  PNL_GROUP: [
    { value: "OPEX", label: "OPEX - Chi phí vận hành" },
    { value: "CAPEX", label: "CAPEX - Chi phí đầu tư" },
    { value: "COGS", label: "COGS - Giá vốn" },
    { value: "REVENUE_SOURCE", label: "REVENUE_SOURCE - Nguồn doanh thu" },
  ],
  PNL_ITEM: [
    { value: "OPEX", label: "OPEX - Chi phí vận hành" },
    { value: "CAPEX", label: "CAPEX - Chi phí đầu tư" },
    { value: "COGS", label: "COGS - Giá vốn" },
    { value: "REVENUE_SOURCE", label: "REVENUE_SOURCE - Nguồn doanh thu" },
  ],
  ASSET_GROUP: [
    { value: "FIXED_ASSET", label: "FIXED_ASSET - Tài sản cố định" },
    { value: "CCDC", label: "CCDC - Công cụ dụng cụ" },
    { value: "TOOL", label: "TOOL - Dụng cụ vận hành" },
    { value: "OTHER", label: "OTHER - Nhóm tài sản khác" },
  ],
  INVENTORY_ITEM_GROUP: [
    { value: "RAW_MATERIAL", label: "RAW_MATERIAL - Nguyên liệu thô" },
    { value: "SEMI_FINISHED", label: "SEMI_FINISHED - Bán thành phẩm" },
    { value: "FINISHED", label: "FINISHED - Thành phẩm bán/POS" },
    { value: "PACKAGING", label: "PACKAGING - Bao bì/vật tư phụ" },
    { value: "TOOL", label: "TOOL - CCDC trong kho" },
    { value: "ASSET", label: "ASSET - Tài sản theo dõi kho" },
    { value: "OTHER", label: "OTHER - Nhóm mặt hàng khác" },
  ],
  ACCOUNTING_PERIOD: [
    { value: "OPEN", label: "OPEN - Đang mở" },
    { value: "LOCKED", label: "LOCKED - Khóa nhập liệu" },
    { value: "CLOSED", label: "CLOSED - Đã chốt sổ" },
  ],
  DOCUMENT_TYPE: [
    { value: "RECEIPT", label: "RECEIPT - Phiếu thu" },
    { value: "PAYMENT", label: "PAYMENT - Phiếu chi" },
    { value: "DEPOSIT", label: "DEPOSIT - Tiền cọc" },
    { value: "TRANSFER", label: "TRANSFER - Điều tiền" },
  ],
};

/** Phân cấp P&L chỉ còn Nhóm P&L -> Hạng mục P&L. */
const parentTypeOf: Record<string, string> = {
  PNL_ITEM: "PNL_GROUP",
};

const parentFieldLabels: Record<string, string> = {
  PNL_ITEM: "Nhóm hạng mục P&L",
};

const parentFieldHints: Record<string, string> = {
  PNL_ITEM: "Khai báo thêm ở tab “Nhóm hạng mục P&L”.",
};

const groupEmptyLabels: Record<string, string> = {
  PNL_GROUP: "-- Chọn nhóm lớn --",
  PNL_ITEM: "-- Chọn nhóm lớn --",
  PARTNER: "-- Chọn loại đối tác --",
  MONEY_SOURCE: "-- Chọn nhóm nguồn tiền --",
  REVENUE_EXPENSE_CATEGORY: "-- Chọn nhóm doanh thu / thu khác / chi --",
  ASSET_GROUP: "-- Chọn nhóm tài sản --",
  INVENTORY_ITEM_GROUP: "-- Chọn nhóm mặt hàng --",
  ACCOUNTING_PERIOD: "-- Chọn trạng thái kỳ --",
  DOCUMENT_TYPE: "-- Chọn nhóm chứng từ --",
};

const legacyGroupAliases: Record<string, Record<string, string>> = {
  REVENUE_EXPENSE_CATEGORY: {
    THU: "RECEIPT",
    INCOME: "RECEIPT",
    "NGUON DOANH THU": "REVENUE_SOURCE",
    "NGUỒN DOANH THU": "REVENUE_SOURCE",
    "DOANH THU": "REVENUE_SOURCE",
    CHI: "PAYMENT",
    EXPENSE: "PAYMENT",
    OPEX: "PAYMENT",
    CAPEX: "PAYMENT",
    COGS: "PAYMENT",
    "GIA VON": "PAYMENT",
    "GIÁ VỐN": "PAYMENT",
  },
  DOCUMENT_TYPE: {
    THU: "RECEIPT",
    CHI: "PAYMENT",
    "TIEN COC": "DEPOSIT",
    "TIỀN CỌC": "DEPOSIT",
    "DIEU TIEN": "TRANSFER",
    "ĐIỀU TIỀN": "TRANSFER",
  },
};

function normalizeGroupValue(type: string, group?: string | null) {
  if (!group) return "";
  const normalized = group.trim().toUpperCase();
  return legacyGroupAliases[type]?.[normalized] || normalized;
}

/**
 * Dòng này có nội dung nào để hiện ở cột "Chi tiết / Ghi chú" không.
 * Dùng để ẩn hẳn cột khi cả danh mục không có gì: loại Thu/Chi chẳng hạn, cả 27 dòng đều
 * trống nên cột chỉ toàn dấu gạch, vừa xấu vừa ăn mất bề ngang của bảng.
 */
function hasDetailContent(item: MasterDataItem) {
  if (item.type === "ASSET_GROUP" && item.codePrefix) return true;
  if (item.type === "MONEY_SOURCE" && (item.summarySourceName || item.settlementBankCode)) return true;
  if (item.type === "REVENUE_EXPENSE_CATEGORY" && item.matchKeywords) return true;
  return Boolean(item.contactName || item.accountNo || item.phone || item.email || item.taxCode || item.note);
}

function formatGroupLabel(type: string, group?: string | null) {
  if (!group) return "-";
  const normalized = normalizeGroupValue(type, group);
  const matched = groupOptions[type]?.find((option) => option.value === normalized);
  return matched?.label || group;
}

function getSessionFromStorage(): DemoSession | null {
  const rawSession = localStorage.getItem(SESSION_KEY);
  if (!rawSession) return null;
  try {
    return JSON.parse(rawSession) as DemoSession;
  } catch {
    return null;
  }
}

export default function SettingsPage() {
  const router = useRouter();
  const [user, setUser] = useState<DemoSession | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [items, setItems] = useState<MasterDataItem[]>([]);
  const [allItems, setAllItems] = useState<MasterDataItem[]>([]);
  /** Đang nhập một tên Nguồn tiền tổng chưa có trong danh sách. */
  const [creatingSummaryName, setCreatingSummaryName] = useState(false);
  /** Tên Nguồn tiền tổng đang được sửa (rỗng = không sửa), và tên mới đang gõ. */
  const [renamingSummaryFrom, setRenamingSummaryFrom] = useState("");
  const [renameSummaryValue, setRenameSummaryValue] = useState("");
  const [isRenamingSummary, setIsRenamingSummary] = useState(false);
  /** Nguồn tiền CHI TIẾT đang được sửa tên nhanh trong danh sách nhóm tổng (rỗng = không sửa). */
  const [renamingMemberId, setRenamingMemberId] = useState("");
  const [renameMemberValue, setRenameMemberValue] = useState("");
  const [isRenamingMember, setIsRenamingMember] = useState(false);
  const [activeType, setActiveType] = useState("BRANCH");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<MasterDataForm>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Kết quả lần bấm "Chuẩn hoá nhóm doanh thu đã import" gần nhất: xem trước rồi mới ghi.
  const [revenueNormalize, setRevenueNormalize] = useState<RevenueNormalizeResult | null>(null);
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [showDrawer, setShowDrawer] = useState(false);
  const [brandingLogo, setBrandingLogo] = useState("");
  const [confirmDeleteTarget, setConfirmDeleteTarget] = useState<MasterDataItem | null>(null);

  const dynamicStores = useMemo(() => {
    const dbStores = allItems.filter((item) => item.type === "BRANCH" && item.status === "ACTIVE");
    if (dbStores.length > 0) {
      return dbStores.map((item) => ({ code: item.code, name: item.name }));
    }
    return [
      { code: "HCM", name: "Cửa hàng 1" },
      { code: "HN", name: "Cửa hàng 2" },
    ];
  }, [allItems]);

  const activeTab = tabs.find((tab) => tab.type === activeType) || tabs[0];

  useEffect(() => {
    const session = getSessionFromStorage();
    const menu = appMenuItems.find((item) => item.href === "/settings");
    if (!session) {
      router.push("/login?next=/settings");
      return;
    }
    if (!menu || !canAccessMenu(session.role, menu)) {
      router.push("/");
      return;
    }
    window.setTimeout(() => {
      setUser(session);
      setIsCheckingAuth(false);
    }, 0);
  }, [router]);

  const loadItems = async () => {
    setIsLoading(true);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const params = new URLSearchParams();
      params.set("type", activeType);
      if (search.trim()) params.set("search", search.trim());

      const [activeResponse, allResponse] = await Promise.all([
        fetch(`/api/master-data?${params.toString()}`),
        fetch("/api/master-data"),
      ]);

      // Cookie phiên hết hạn (8 tiếng) trong khi localStorage vẫn còn phiên: màn hình vẫn mở
      // được nhưng mọi API trả 401, người dùng chỉ thấy "Không tải được danh mục" mà không hiểu
      // vì sao. Dọn phiên cũ và đưa thẳng về đăng nhập.
      if (activeResponse.status === 401 || allResponse.status === 401) {
        localStorage.removeItem(SESSION_KEY);
        router.push("/login?next=/settings");
        return;
      }

      // Báo đúng lý do máy chủ từ chối (mã HTTP + thông báo của API) thay vì một câu chung chung:
      // "Không tải được danh mục" không cho biết là hết quyền, lỗi dữ liệu hay máy chủ chết.
      if (!activeResponse.ok || !allResponse.ok) {
        const failed = !activeResponse.ok ? activeResponse : allResponse;
        const detail = await failed.text().then(
          (body) => {
            try {
              return (JSON.parse(body) as { error?: string }).error || "";
            } catch {
              return body.replace(/\s+/g, " ").trim().slice(0, 200);
            }
          },
          () => "",
        );
        throw new Error(`Không tải được danh mục (HTTP ${failed.status})${detail ? `: ${detail}` : ""}`);
      }

      setItems((await activeResponse.json()) as MasterDataItem[]);
      const allPayload = (await allResponse.json()) as MasterDataItem[];
      setAllItems(allPayload);
      setBrandingLogo(allPayload.find((item) => item.type === "SYSTEM_PARAM" && item.code === "APP_LOGO")?.note || "");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi tải danh mục");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isCheckingAuth) {
      window.setTimeout(() => {
        void loadItems();
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeType, isCheckingAuth]);

  /** Danh mục cha khả dụng theo nhóm lớn đang chọn (P&L nhóm -> hạng mục -> thu/chi). */
  const subGroupOptions = useMemo(
    () => {
      const parentType = parentTypeOf[form.type];
      if (!parentType) return [];
      return allItems.filter(
        (item) => item.type === parentType && item.status === "ACTIVE" && item.group === form.group,
      );
    },
    [allItems, form.group, form.type],
  );

  /** Nhóm kho gợi ý cho phân nhóm mặt hàng: gom từ cột group của các kho và các phân nhóm đã gán. */
  const warehouseGroupOptions = useMemo(() => {
    const values = new Set<string>();
    for (const item of allItems) {
      if (item.type === "WAREHOUSE" && item.group) values.add(item.group.toUpperCase());
      if (item.type === "INVENTORY_ITEM_GROUP" && item.subGroup) values.add(item.subGroup.toUpperCase());
    }
    return [...values].sort();
  }, [allItems]);

  /** Tên "Nguồn tiền tổng" đã khai ở các nguồn cùng cửa hàng: chọn lại cho khỏi gõ lệch chữ,
   *  vì báo cáo gộp theo đúng chuỗi tên nên sai một ký tự là tách thành hai dòng. */
  const summarySourceNameOptions = useMemo(
    () => [...new Set(
      allItems
        .filter((item) => item.type === "MONEY_SOURCE"
          && item.summarySourceName
          && moneySourceMatchesBranch(item, form.branch || null))
        .map((item) => item.summarySourceName as string),
    )].sort((a, b) => a.localeCompare(b, "vi")),
    [allItems, form.branch],
  );
  // Tên đang giữ không nằm trong danh sách (vừa gõ mới, hoặc vừa đổi cửa hàng) thì phải
  // hiện ô nhập để không âm thầm làm mất giá trị.
  const showNewSummaryNameInput = creatingSummaryName
    || (Boolean(form.summarySourceName) && !summarySourceNameOptions.includes(form.summarySourceName));

  /** Các nguồn tiền đang gộp vào tên tổng đang chọn: đổi tên là sửa hết chỗ này. */
  const summarySourceMembers = useMemo(() => {
    const name = form.summarySourceName.trim().toLowerCase();
    if (!name) return [] as MasterDataItem[];
    return allItems.filter((item) => item.type === "MONEY_SOURCE"
      && (item.summarySourceName || "").trim().toLowerCase() === name);
  }, [allItems, form.summarySourceName]);

  /** Tên mới trùng một nhóm tổng khác nghĩa là gộp hai nhóm làm một - phải nói trước. */
  const renameMergesIntoExisting = useMemo(() => {
    const next = renameSummaryValue.trim().toLowerCase();
    if (!next || next === renamingSummaryFrom.trim().toLowerCase()) return false;
    return allItems.some((item) => item.type === "MONEY_SOURCE"
      && (item.summarySourceName || "").trim().toLowerCase() === next);
  }, [allItems, renameSummaryValue, renamingSummaryFrom]);

  // Đổi nhóm lớn thì nhóm chi tiết cũ không còn hợp lệ (chỉ áp dụng cho danh mục có tầng cha).
  useEffect(() => {
    if (!parentTypeOf[form.type]) return;
    if (!form.subGroup) return;
    if (subGroupOptions.some((option) => option.code === form.subGroup)) return;
    window.setTimeout(() => setForm((value) => ({ ...value, subGroup: "" })), 0);
  }, [form.type, form.subGroup, subGroupOptions]);

  const stats = useMemo(() => {
    return tabs.map((tab) => {
      const tabItems = allItems.filter((item) => item.type === tab.type);
      return {
        ...tab,
        count: tabItems.length,
        active: tabItems.filter((item) => item.status === "ACTIVE").length,
      };
    });
  }, [allItems]);

  const canManageSettings = user ? canPerformAction(user, "config") : false;

  // Danh mục nào không dùng tới cột nào thì bỏ hẳn cột đó: Thu/Chi không gắn cửa hàng và
  // không có ghi chú nên trước đây bảng có hai cột chỉ toàn dấu gạch, vừa xấu vừa đẩy bảng
  // rộng quá khung khiến phải kéo ngang.
  const showBranchColumn = items.some((item) => Boolean(item.branch));
  const showDetailColumn = items.some(hasDetailContent);
  const tableColumnCount = 3 + (showBranchColumn ? 1 : 0) + (showDetailColumn ? 1 : 0) + (canManageSettings ? 1 : 0);

  const resetForm = (type = activeType) => {
    setCreatingSummaryName(false);
    setRenamingSummaryFrom("");
    setRenamingMemberId("");
    setForm({ ...emptyForm, type, partnerGroup: "EXTERNAL" });
    setSuccessMessage("");
    setErrorMessage("");
  };

  const selectTab = (type: string) => {
    setActiveType(type);
    resetForm(type);
  };

  const editItem = (item: MasterDataItem) => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setCreatingSummaryName(false);
    setRenamingSummaryFrom("");
    setRenamingMemberId("");
    setForm({
      id: item.id,
      type: item.type,
      code: item.code,
      name: item.name,
      group: normalizeGroupValue(item.type, item.group),
      subGroup: parentTypeOf[item.type] || item.type === "INVENTORY_ITEM_GROUP" ? item.subGroup || "" : "",
      partnerType: normalizeGroupValue("PARTNER", item.partnerType || item.group),
      partnerGroup: item.partnerGroup || "EXTERNAL",
      branch: item.branch || "",
      taxCode: item.taxCode || "",
      contactName: item.contactName || "",
      phone: item.phone || "",
      email: item.email || "",
      accountNo: item.accountNo || "",
      codePrefix: item.codePrefix || "",
      settlementBankCode: item.settlementBankCode || "",
      summarySourceName: item.summarySourceName || "",
      matchKeywords: item.matchKeywords || "",
      skipInventory: item.skipInventory === true,
      note: item.note || "",
      status: item.status,
    });
    setShowDrawer(true);
  };

  const handleLinkBranchChange = (branchCode: string) => {
    setForm((prev) => {
      const updated = { ...prev, branch: branchCode };
      if (!branchCode) return updated;

      const store = allItems.find((item) => item.type === "BRANCH" && item.code === branchCode);
      if (store) {
        return {
          ...updated,
          taxCode: store.taxCode || "",
          accountNo: store.accountNo || "",
          contactName: store.contactName || "",
          phone: store.phone || "",
          email: store.email || "",
          note: store.note || "",
        };
      }
      return updated;
    });
  };

  /** Mở ô sửa tên nhóm tổng đang chọn. */
  const startRenameSummarySource = () => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setRenamingSummaryFrom(form.summarySourceName);
    setRenameSummaryValue(form.summarySourceName);
  };

  /** Đổi tên nhóm tổng: server sửa đồng loạt mọi nguồn đang mang tên cũ, vì báo cáo gộp theo
   *  đúng chuỗi tên - sửa lẻ một nguồn là nhóm tách làm hai dòng. */
  const renameSummarySource = async () => {
    const nextName = renameSummaryValue.trim();
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    if (!nextName) {
      setErrorMessage("Tên nguồn tiền tổng mới không được để trống.");
      return;
    }
    if (nextName === renamingSummaryFrom) {
      setRenamingSummaryFrom("");
      return;
    }
    setIsRenamingSummary(true);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/master-data/summary-source", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentName: renamingSummaryFrom, nextName }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Không đổi được tên nguồn tiền tổng");
      }
      const savedName = (payload.name as string) || nextName;
      setForm((value) => ({ ...value, summarySourceName: savedName }));
      setRenamingSummaryFrom("");
      await loadItems();
      setSuccessMessage(`Đã đổi tên nguồn tiền tổng thành "${savedName}" cho ${payload.updated} nguồn tiền.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi đổi tên nguồn tiền tổng");
    } finally {
      setIsRenamingSummary(false);
    }
  };

  /** Mở ô sửa tên nhanh cho một nguồn tiền chi tiết trong nhóm tổng. */
  const startRenameMemberSource = (item: MasterDataItem) => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setRenamingSummaryFrom("");
    setRenamingMemberId(item.id);
    setRenameMemberValue(item.name);
  };

  /** Đổi TÊN một nguồn tiền chi tiết ngay tại drawer, khỏi phải đóng ra rồi mở lại từng nguồn.
   *  Chỉ gửi id + name nên mã, cửa hàng, phân loại và tên tổng giữ nguyên - đổi mã/cửa hàng là
   *  việc khác, có ràng buộc chứng từ riêng nên vẫn phải làm qua form đầy đủ. */
  const renameMemberSource = async (item: MasterDataItem) => {
    const nextName = renameMemberValue.trim();
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    if (!nextName) {
      setErrorMessage("Tên nguồn tiền chi tiết không được để trống.");
      return;
    }
    if (nextName === item.name) {
      setRenamingMemberId("");
      return;
    }
    setIsRenamingMember(true);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/master-data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, name: nextName }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Không đổi được tên nguồn tiền chi tiết");
      }
      const savedName = (payload.name as string) || nextName;
      // Đang sửa đúng nguồn mở trong form thì phải đồng bộ ô "Tên danh mục", nếu không bấm Lưu
      // sẽ ghi đè lại tên cũ.
      if (form.id === item.id) setForm((value) => ({ ...value, name: savedName }));
      setRenamingMemberId("");
      await loadItems();
      setSuccessMessage(`Đã đổi tên nguồn tiền chi tiết ${item.code} thành "${savedName}".`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi đổi tên nguồn tiền chi tiết");
    } finally {
      setIsRenamingMember(false);
    }
  };

  const saveItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setIsSaving(true);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/master-data", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Không lưu được danh mục");
      }
      resetForm(form.type);
      setShowDrawer(false);
      setSuccessMessage(form.id ? "Đã cập nhật danh mục thành công." : "Đã thêm danh mục mới thành công.");
      await loadItems();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi lưu danh mục");
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Chạy lại luật nhóm doanh thu cho dữ liệu doanh thu ĐÃ import. apply = false chỉ đếm thử,
   * để kế toán nhìn con số rồi mới quyết định ghi — không ai phải gõ lệnh backfill nữa.
   */
  const runRevenueNormalize = async (apply: boolean) => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setIsNormalizing(true);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/master-data/revenue-normalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apply }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Không chuẩn hoá được nhóm doanh thu");
      setRevenueNormalize(payload as RevenueNormalizeResult);
      if (apply) {
        setSuccessMessage(payload.changedRows > 0
          ? `Đã chuẩn hoá ${payload.changedRows} dòng doanh thu và ${payload.journalLines} dòng bút toán 511.`
          : "Không có dòng nào cần đổi.");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi chuẩn hoá nhóm doanh thu");
    } finally {
      setIsNormalizing(false);
    }
  };

  const toggleStatus = async (item: MasterDataItem) => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    const nextStatus = item.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const response = await fetch("/api/master-data", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, status: nextStatus }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || "Không đổi được trạng thái");
      }
      await loadItems();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi đổi trạng thái");
    }
  };

  const deleteItem = async (item: MasterDataItem) => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    setConfirmDeleteTarget(item);
  };

  const executeDelete = async (item: MasterDataItem) => {
    setConfirmDeleteTarget(null);
    setSuccessMessage("");
    setErrorMessage("");
    try {
      const response = await fetch(`/api/master-data?id=${item.id}`, {
        method: "DELETE",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Không xóa được danh mục");
      }
      setSuccessMessage("Đã xóa danh mục thành công.");
      await loadItems();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Có lỗi khi xóa danh mục");
    }
  };

  /** Nút ghi "Xuất Excel" nên xuất .xlsx thật, không phải CSV đổi tên. */
  const exportDanhMuc = async () => {
    if (items.length === 0) {
      alert("Không có dữ liệu để xuất");
      return;
    }
    await exportRowsToExcel(
      items.map((item) => ({
        "Mã danh mục": item.code,
        "Tên hiển thị": item.name,
        "Phân loại/Nhóm": item.type === "PARTNER"
          ? `${formatGroupLabel("PARTNER", item.partnerType || item.group)} (${item.partnerGroup || "EXTERNAL"})`
          : formatGroupLabel(item.type, item.group),
        "Cửa hàng": storeLabel(item.branch),
        "MST/STK/Ghi chú": item.contactName || item.accountNo || item.note || "-",
        "Trạng thái": item.status === "ACTIVE" ? "Hoạt động" : "Ngừng hoạt động",
      })),
      { fileName: `danh_muc_${activeType.toLowerCase()}`, sheetName: "Danh muc" },
    );
  };

  const handleLogoUpload = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorMessage("Vui lòng chọn file logo dạng hình ảnh.");
      return;
    }
    if (file.size > 1_500_000) {
      setErrorMessage("Logo nên nhỏ hơn 1.5MB để tải nhanh.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setBrandingLogo(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const saveBrandingLogo = async () => {
    if (!canManageSettings) {
      setErrorMessage("Bạn chỉ có quyền xem danh mục.");
      return;
    }
    const existing = allItems.find((item) => item.type === "SYSTEM_PARAM" && item.code === "APP_LOGO");
    const payload = {
      ...(existing ? { id: existing.id } : {}),
      type: "SYSTEM_PARAM",
      code: "APP_LOGO",
      name: "FIN ERP",
      group: "Finance Suite",
      note: brandingLogo,
      status: "ACTIVE",
    };
    const response = await fetch("/api/master-data", {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      setErrorMessage(body.error || "Không lưu được logo hệ thống.");
      return;
    }
    setSuccessMessage("Đã cập nhật logo hệ thống. Refresh trang để thấy logo mới ở sidebar/login.");
    await loadItems();
  };

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  if (isCheckingAuth) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 font-sans">
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in {
          animation: slideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>

      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Cấu hình Danh mục & Tham số</h1>
            <p className="text-xs text-slate-500">
              Nhóm A 1.1 - 1.4: dữ liệu nền cho thu/chi, tiền cọc, số dư đầu kỳ và cung ứng.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden sm:block text-right">
            <p className="text-xs font-bold text-slate-900">{user?.name}</p>
            <p className="text-[11px] text-slate-500">{displayRoleName(user?.role)}</p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold hover:bg-slate-50 transition"
          >
            Đăng xuất
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
          {/* Left Excel-sheet Sidebar */}
          <aside className="bg-white border border-slate-200 rounded-xl shadow-sm p-3 grid gap-1 sticky top-24">
            <p className="text-[11px] font-bold text-slate-400 px-3 py-1 uppercase tracking-wider">Danh mục Excel</p>
            {stats.map((tab) => (
              <button
                key={tab.type}
                onClick={() => selectTab(tab.type)}
                className={`text-left rounded-lg px-3 py-2.5 transition flex items-center gap-3 border ${
                  activeType === tab.type
                    ? "border-blue-200 bg-blue-50 text-blue-700 font-semibold shadow-sm"
                    : "border-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <span className="material-symbols-outlined text-lg">{tab.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{tab.label}</p>
                </div>
                <span className={`text-[11px] font-bold rounded-full px-2 py-0.5 ${
                  activeType === tab.type ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-600"
                }`}>
                  {tab.active}/{tab.count}
                </span>
              </button>
            ))}
          </aside>

          {/* Right Workspace Content */}
          <div className="space-y-6">
            {successMessage && (
              <p className="text-sm rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700 px-4 py-3 shadow-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg">check_circle</span>
                {successMessage}
              </p>
            )}

            {errorMessage && (
              <p className="text-sm rounded-lg bg-rose-50 border border-rose-100 text-rose-700 px-4 py-3 shadow-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-lg">error</span>
                {errorMessage}
              </p>
            )}

            <section className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              {/* Toolbar */}
              <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50/50">
                {/* min-w-0 + truncate: câu mô tả dài (VD "1.2 - Danh mục dòng tiền, chỉ phân loại
                    Thu hoặc Chi") trước đây giành hết bề ngang nên cụm nút bị đẩy xuống hàng dưới.
                    Giờ mô tả tự co lại (rê chuột xem đủ), nhường chỗ cho hàng nút. */}
                <div className="min-w-0">
                  <h2 className="font-bold text-lg text-slate-900">{activeTab.label}</h2>
                  <p className="mt-0.5 truncate text-xs text-slate-500" title={activeTab.hint}>{activeTab.hint}</p>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:shrink-0 sm:justify-end">
                  {/* Search Box */}
                  <div className="flex border border-slate-300 rounded-lg overflow-hidden bg-white shadow-sm focus-within:ring-2 focus-within:ring-blue-500 transition">
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      className="w-32 px-3 py-1.5 text-xs text-slate-700 outline-none sm:w-40"
                      placeholder="Tìm mã/tên/nhóm..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void loadItems();
                      }}
                    />
                    <button
                      onClick={loadItems}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 text-xs font-bold transition border-l border-slate-200 flex items-center gap-1"
                    >
                      <span className="material-symbols-outlined text-[15px]">search</span>
                      Tìm
                    </button>
                  </div>

                  {canManageSettings && (
                    <button
                      onClick={() => {
                        resetForm();
                        setShowDrawer(true);
                      }}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
                    >
                      <span className="material-symbols-outlined text-[16px]">add</span>
                      Thêm mới
                    </button>
                  )}

                  <button
                    onClick={() => router.push(`/imports?tab=master-data&masterType=${activeType}`)}
                    className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">upload_file</span>
                    Import
                  </button>

                  <button
                    onClick={() => void exportDanhMuc()}
                    className="bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[16px]">download</span>
                    Xuất Excel
                  </button>
                </div>
              </div>

              {/* Nhóm doanh thu là thứ quyết định doanh thu lên dòng nào của P&L, mà file POS lại
                  ghi bằng chữ. Khai từ khoá ngay trên danh mục rồi bấm chuẩn hoá là xong, không
                  cần ai vào sửa mã nguồn hay chạy lệnh backfill. */}
              {activeType === "REVENUE_EXPENSE_CATEGORY" && (
                <div className="border-b border-slate-200 bg-white px-5 py-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="max-w-2xl">
                      <h3 className="text-sm font-bold text-slate-900">Nhóm doanh thu khi import</h3>
                      <p className="mt-0.5 text-xs text-slate-500">
                        File doanh thu ghi &quot;ĐỒ ĂN&quot;, &quot;ĐỒ UỐNG&quot;... thay vì mã danh mục thì mở danh mục Thu tương ứng,
                        khai chữ đó vào ô <b>Từ khoá nhận dạng khi import</b>. Món nào file để trống cột này thì hệ thống lấy
                        Nhóm doanh thu khai ở <b>Kho &amp; Định lượng &gt; Danh mục mặt hàng</b>. Sửa xong bấm nút bên cạnh để áp
                        cho cả doanh thu đã import trước đó (chỉ đổi nhãn phân loại, không đụng số tiền).
                      </p>
                    </div>
                    {canManageSettings && (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void runRevenueNormalize(false)}
                          disabled={isNormalizing}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                        >
                          {isNormalizing ? "Đang kiểm tra..." : "Kiểm tra dữ liệu đã import"}
                        </button>
                        {revenueNormalize && !revenueNormalize.applied && (revenueNormalize.changedRows > 0 || revenueNormalize.releasedRows > 0) && (
                          <button
                            type="button"
                            onClick={() => void runRevenueNormalize(true)}
                            disabled={isNormalizing}
                            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-blue-700 disabled:opacity-60"
                          >
                            Chuẩn hoá {revenueNormalize.changedRows + revenueNormalize.releasedRows} dòng
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {revenueNormalize && (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                      <p className="font-bold text-slate-900">
                        {revenueNormalize.applied
                          ? `Đã chuẩn hoá ${revenueNormalize.changedRows} dòng doanh thu (${revenueNormalize.journalLines} dòng bút toán 511).`
                          : revenueNormalize.changedRows > 0
                            ? `Có ${revenueNormalize.changedRows}/${revenueNormalize.total} dòng doanh thu sẽ đổi nhóm:`
                            : revenueNormalize.releasedRows > 0
                              ? `Nhóm doanh thu đã đúng cả ${revenueNormalize.total} dòng, chỉ còn việc thả hàng chờ rã nguyên liệu.`
                              : `Cả ${revenueNormalize.total} dòng doanh thu đã đúng nhóm, không phải sửa gì.`}
                      </p>
                      {/* Dòng của nhóm khai "không theo dõi tồn kho" đang kẹt ở hàng chờ rã nguyên
                          liệu (import trước khi khai cờ) sẽ được thả ra ngay trong lần chuẩn hoá này. */}
                      {revenueNormalize.releasedRows > 0 && (
                        <p className="mt-1.5 font-bold text-blue-700">
                          {revenueNormalize.applied ? "Đã thả" : "Sẽ thả"} {revenueNormalize.releasedRows} dòng thuộc nhóm doanh thu
                          không theo dõi tồn kho khỏi hàng chờ &quot;Rã nguyên liệu&quot;.
                        </p>
                      )}
                      {revenueNormalize.groups.length > 0 && (
                        <ul className="mt-1.5 space-y-0.5">
                          {revenueNormalize.groups.map((group) => (
                            <li key={`${group.revenueSource}|${group.departmentCode || ""}`}>
                              <b>{group.revenueSource}</b>
                              {group.departmentCode ? ` / bộ phận ${group.departmentCode}` : " / chưa suy được bộ phận"}
                              : {group.rows} dòng
                            </li>
                          ))}
                        </ul>
                      )}
                      {revenueNormalize.unresolved > 0 && (
                        <p className="mt-1.5 font-bold text-amber-700">
                          {revenueNormalize.unresolved} dòng chưa quy được nhóm — khai thêm từ khoá ở đây, hoặc gán Nhóm doanh thu
                          cho món đó bên Kho &amp; Định lượng &gt; Danh mục mặt hàng rồi kiểm tra lại.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeType === "SYSTEM_PARAM" && (
                <div className="border-b border-slate-200 bg-white px-5 py-4">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-4">
                      <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                        {brandingLogo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={brandingLogo} alt="Logo hệ thống" className="h-full w-full object-contain p-2" />
                        ) : (
                          <span className="material-symbols-outlined text-3xl text-slate-400">account_balance</span>
                        )}
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-slate-900">Logo hệ thống</h3>
                        <p className="text-xs text-slate-500">Logo này hiển thị ở sidebar Dashboard và màn hình đăng nhập.</p>
                      </div>
                    </div>
                    {canManageSettings && (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(event) => handleLogoUpload(event.target.files?.[0] || null)}
                          className="max-w-[260px] rounded-lg border border-slate-300 px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-blue-50 file:px-3 file:py-1 file:text-xs file:font-bold file:text-blue-700"
                        />
                        <button
                          type="button"
                          onClick={() => void saveBrandingLogo()}
                          className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-bold text-white hover:bg-blue-700"
                        >
                          Lưu logo
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Data Table */}
              {/* Cột nào cả danh mục đều trống thì bỏ hẳn, không dựng một cột toàn dấu gạch. */}
              {/* Danh mục dài (Đối tác 109 dòng, Hạng mục P&L 46 dòng) kéo trang dài lê thê và
                  cuộn xuống là mất luôn tiêu đề cột. Giới hạn chiều cao khung: ít dòng thì khung
                  tự co, nhiều dòng mới hiện thanh cuộn, và tiêu đề cột dính lại trên cùng.
                  Viền dưới của tiêu đề vẽ bằng shadow vì border-collapse làm border của thead
                  dính sticky bị mất khi cuộn. */}
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500 shadow-[inset_0_-1px_0_#e2e8f0] [&_th]:whitespace-nowrap">
                    <tr>
                      <th className="px-4 py-3">Mã / Tên</th>
                      <th className="px-4 py-3">Phân loại</th>
                      {showBranchColumn && <th className="px-4 py-3">Cửa hàng</th>}
                      {showDetailColumn && <th className="px-4 py-3">Chi tiết / Ghi chú</th>}
                      <th className="px-4 py-3">Trạng thái</th>
                      {canManageSettings && <th className="px-4 py-3 text-right">Thao tác</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {isLoading ? (
                      <tr>
                        <td colSpan={tableColumnCount} className="px-4 py-12 text-center text-slate-400">
                          Đang tải dữ liệu danh mục...
                        </td>
                      </tr>
                    ) : items.length === 0 ? (
                      <tr>
                        <td colSpan={tableColumnCount} className="px-4 py-12 text-center text-slate-400">
                          Chưa có dữ liệu cho danh mục này.
                        </td>
                      </tr>
                    ) : (
                      items.map((item) => (
                        <tr key={item.id} className="align-middle transition hover:bg-slate-50 [&>td]:py-3.5">
                          <td className="px-4 py-3">
                            <p className="break-words font-bold text-slate-900"><CopyableText value={item.code} /></p>
                            <p className="mt-0.5 text-xs text-slate-500">{item.name}</p>
                          </td>
                          <td className="px-4 py-3">
                            {/* Thu/Chi cho ra viên màu đọc phát biết, thay vì chip xám "1 - Thu" —
                                số thứ tự chỉ có nghĩa trong ô chọn của form. Nhóm doanh thu là một
                                loại Thu riêng nên có viên riêng: chỉ nó mới gán được cho mặt hàng. */}
                            {item.type === "REVENUE_EXPENSE_CATEGORY" ? (
                              <p className={`w-fit whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                                normalizeGroupValue(item.type, item.group) === "REVENUE_SOURCE"
                                  ? "border-blue-200 bg-blue-50 text-blue-700"
                                  : normalizeGroupValue(item.type, item.group) === "RECEIPT"
                                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                    : "border-rose-200 bg-rose-50 text-rose-700"
                              }`}>
                                {normalizeGroupValue(item.type, item.group) === "REVENUE_SOURCE"
                                  ? "Nhóm doanh thu"
                                  : normalizeGroupValue(item.type, item.group) === "RECEIPT" ? "Thu khác" : "Chi"}
                              </p>
                            ) : (
                              <p className="w-fit whitespace-nowrap rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                                {item.type === "PARTNER" ? formatGroupLabel("PARTNER", item.partnerType || item.group) : formatGroupLabel(item.type, item.group)}
                              </p>
                            )}
                            {/* Nhóm doanh thu miễn kho: doanh thu vẫn lên đủ nhưng dòng bán không vào
                                hàng chờ Rã nguyên liệu — phải thấy ngay trên bảng vì nó đổi việc của kho. */}
                            {item.type === "REVENUE_EXPENSE_CATEGORY" && item.skipInventory && (
                              <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-amber-700">
                                <span className="material-symbols-outlined text-[13px]">inventory_2</span>
                                Không theo dõi tồn kho
                              </p>
                            )}
                            {item.subGroup && parentTypeOf[item.type] && (
                              <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-slate-600">
                                <span className="material-symbols-outlined text-[13px] text-slate-300">subdirectory_arrow_right</span>
                                {allItems.find((row) => row.type === parentTypeOf[item.type] && row.code === item.subGroup)?.name || item.subGroup}
                              </p>
                            )}
                            {item.subGroup && item.type === "INVENTORY_ITEM_GROUP" && (
                              <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-slate-600">
                                <span className="material-symbols-outlined text-[13px] text-slate-300">warehouse</span>
                                Nhóm kho: {item.subGroup}
                              </p>
                            )}
                            {item.type === "PARTNER" && (
                              <p className="text-[10px] text-slate-500 mt-0.5 font-bold uppercase">{item.partnerGroup || "EXTERNAL"}</p>
                            )}
                          </td>
                          {showBranchColumn && (
                            <td className="whitespace-nowrap px-4 py-3 font-medium">{storeLabel(item.branch)}</td>
                          )}
                          {showDetailColumn && (
                          <td className="max-w-xs px-4 py-3">
                            <p className="truncate text-xs font-medium text-slate-800">
                              {item.type === "ASSET_GROUP" && item.codePrefix
                                ? <>Tiền tố mã: <CopyableText value={item.codePrefix} /></>
                                : item.type === "MONEY_SOURCE" && (item.summarySourceName || item.settlementBankCode)
                                  ? <>
                                      {item.summarySourceName && <>Tổng: {item.summarySourceName}</>}
                                      {item.summarySourceName && item.settlementBankCode && " · "}
                                      {item.settlementBankCode && <>Quyết toán về: <CopyableText value={item.settlementBankCode} /></>}
                                    </>
                                  : item.type === "REVENUE_EXPENSE_CATEGORY" && item.matchKeywords
                                    ? <>Từ khoá import: {item.matchKeywords}</>
                                    : item.contactName || (item.accountNo ? <CopyableText value={item.accountNo} /> : "-")}
                            </p>
                            <p className="mt-0.5 truncate text-[11px] italic text-slate-500">
                              {item.phone ? <CopyableText value={item.phone} />
                                : item.email ? <CopyableText value={item.email} />
                                : item.taxCode ? <CopyableText value={item.taxCode} />
                                : item.note || ""}
                            </p>
                          </td>
                          )}
                          <td className="px-4 py-3">
                            <span
                              className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                                item.status === "ACTIVE"
                                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                                  : "bg-slate-100 text-slate-500"
                              }`}
                            >
                              {item.status === "ACTIVE" ? "Hoạt động" : "Ngừng dùng"}
                            </span>
                          </td>
                          {canManageSettings && (
                            <td className="px-4 py-3 text-right">
                              {/* Cùng ngôn ngữ với cụm thao tác ở màn Tiền cọc: việc đổi trạng thái là
                                  một nút chữ dạng viên, còn sửa/xoá là biểu tượng. whitespace-nowrap để
                                  ba nút luôn nằm một hàng, trước đây cột hẹp là chúng xếp chồng lên nhau. */}
                              <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                                <button
                                  onClick={() => toggleStatus(item)}
                                  title={item.status === "ACTIVE" ? "Ngừng dùng danh mục này" : "Cho phép dùng lại danh mục này"}
                                  className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition ${
                                    item.status === "ACTIVE"
                                      ? "border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100"
                                      : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                  }`}
                                >
                                  {item.status === "ACTIVE" ? "Ngừng" : "Kích hoạt"}
                                </button>
                                <button
                                  onClick={() => editItem(item)}
                                  title="Chỉnh sửa"
                                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-700"
                                >
                                  <span className="material-symbols-outlined text-base">edit</span>
                                </button>
                                <button
                                  onClick={() => deleteItem(item)}
                                  title="Xoá"
                                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-700"
                                >
                                  <span className="material-symbols-outlined text-base">delete</span>
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* Slide-out Drawer Panel for Add/Edit form */}
      {showDrawer && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Overlay mask */}
          <div
            className="absolute inset-0 bg-slate-900/20 transition-opacity cursor-pointer"
            onClick={() => setShowDrawer(false)}
          />
          {/* Drawer content */}
          <div className="relative w-full max-w-lg bg-white h-full shadow-2xl flex flex-col animate-slide-in border-l border-slate-200">
            {/* Drawer Header */}
            <div className="px-6 py-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div>
                <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{activeTab.hint}</p>
                <h2 className="font-bold text-lg text-slate-900 mt-0.5">
                  {form.id ? "Cập nhật" : "Thêm mới"} {activeTab.label.toLowerCase()}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowDrawer(false)}
                className="h-8 w-8 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition"
              >
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>

            {/* Form */}
            <form onSubmit={saveItem} className="flex-1 overflow-y-auto p-6 space-y-5">
              <input type="hidden" value={form.type} />

              <div className="grid grid-cols-2 gap-4">
                <label className="text-xs font-bold text-slate-700 block">
                  {activeType === "ACCOUNTING_PERIOD" ? "Chọn Tháng / Năm *" : "Mã danh mục *"}
                  {activeType === "ACCOUNTING_PERIOD" ? (
                    <div className="mt-1.5">
                      <MonthInput
                        value={form.code}
                        onChange={(newMonthVal) => {
                          if (!newMonthVal) return;
                          const parts = newMonthVal.split("-");
                          const autoName = parts.length === 2 ? `Kỳ kế toán Tháng ${parts[1]}/${parts[0]}` : form.name;
                          setForm((prev) => ({
                            ...prev,
                            code: newMonthVal,
                            name: autoName,
                          }));
                        }}
                      />
                    </div>
                  ) : (
                    <input
                      data-input-kind="code"
                      value={form.code}
                      onChange={(event) => setForm((value) => ({ ...value, code: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm uppercase outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder={codePlaceholders[activeType] || "VD: CODE_01"}
                      required
                    />
                  )}
                </label>
                <label className="text-xs font-bold text-slate-700 block">
                  Trạng thái
                  <select
                    value={form.status}
                    onChange={(event) => setForm((value) => ({ ...value, status: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                  >
                    <option value="ACTIVE">Hoạt động</option>
                    <option value="INACTIVE">Ngừng dùng</option>
                  </select>
                </label>
              </div>

              <label className="text-xs font-bold text-slate-700 block">
                Tên danh mục *
                <input
                  value={form.name}
                  onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))}
                  className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  placeholder={namePlaceholders[activeType] || "Tên hiển thị trực quan"}
                  required
                />
              </label>

              <div className="grid grid-cols-2 gap-4">
                <label className="text-xs font-bold text-slate-700 block">
                  {activeType === "REVENUE_EXPENSE_CATEGORY" ? "Loại Thu/Chi" : "Nhóm / Loại"}
                  {activeType === "PARTNER" ? (
                    <select
                      value={form.partnerType || form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value, partnerType: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      required
                    >
                      <option value="">{groupEmptyLabels.PARTNER}</option>
                      {groupOptions.PARTNER.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : activeType === "MONEY_SOURCE" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      required
                    >
                      <option value="">{groupEmptyLabels.MONEY_SOURCE}</option>
                      {groupOptions.MONEY_SOURCE.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : ["REVENUE_EXPENSE_CATEGORY", "PNL_GROUP", "PNL_ITEM"].includes(activeType) ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      required
                    >
                      <option value="">{groupEmptyLabels[activeType]}</option>
                      {(groupOptions[activeType] || []).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : activeType === "ASSET_GROUP" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      required
                    >
                      <option value="">{groupEmptyLabels.ASSET_GROUP}</option>
                      {groupOptions.ASSET_GROUP.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : activeType === "INVENTORY_ITEM_GROUP" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      required
                    >
                      <option value="">{groupEmptyLabels.INVENTORY_ITEM_GROUP}</option>
                      {groupOptions.INVENTORY_ITEM_GROUP.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : activeType === "ACCOUNTING_PERIOD" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">{groupEmptyLabels.ACCOUNTING_PERIOD}</option>
                      {groupOptions.ACCOUNTING_PERIOD.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : activeType === "DOCUMENT_TYPE" ? (
                    <select
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="">{groupEmptyLabels.DOCUMENT_TYPE}</option>
                      {groupOptions.DOCUMENT_TYPE.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={form.group}
                      onChange={(event) => setForm((value) => ({ ...value, group: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder={groupPlaceholders[activeType] || "VD: Nhóm"}
                    />
                  )}
                </label>

                {parentTypeOf[activeType] && (
                  <label className="text-xs font-bold text-slate-700 block">
                    {parentFieldLabels[activeType]}
                    <select
                      value={form.subGroup}
                      onChange={(event) => setForm((value) => ({ ...value, subGroup: event.target.value }))}
                      disabled={!form.group}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer disabled:bg-slate-100 disabled:cursor-not-allowed"
                    >
                      <option value="">
                        {!form.group
                          ? "-- Chọn nhóm lớn trước --"
                          : subGroupOptions.length === 0
                            ? `-- Chưa khai báo ${parentFieldLabels[activeType].toLowerCase()} --`
                            : `-- Không gán ${parentFieldLabels[activeType].toLowerCase()} --`}
                      </option>
                      {subGroupOptions.map((option) => (
                        <option key={option.code} value={option.code}>{option.name}</option>
                      ))}
                    </select>
                    <span className="mt-1 block text-[11px] font-medium text-slate-500">
                      {parentFieldHints[activeType]}
                    </span>
                  </label>
                )}

                {activeType === "INVENTORY_ITEM_GROUP" && (
                  <label className="text-xs font-bold text-slate-700 block">
                    Nhóm kho tương ứng
                    <input
                      value={form.subGroup}
                      onChange={(event) => setForm((value) => ({ ...value, subGroup: event.target.value }))}
                      list="warehouse-group-options"
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder="VD: BEP / BAR / FOH"
                    />
                    <datalist id="warehouse-group-options">
                      {warehouseGroupOptions.map((option) => (
                        <option key={option} value={option} />
                      ))}
                    </datalist>
                    <span className="mt-1 block text-[11px] font-medium text-slate-500">
                      Khớp với ô “Nhóm / Loại” của kho ở từng cửa hàng để hệ thống tự gợi ý kho nhận khi mua hàng.
                    </span>
                  </label>
                )}

                {activeType === "PARTNER" && (
                  <label className="text-xs font-bold text-slate-700 block">
                    Nhóm đối tượng
                    <select
                      value={form.partnerGroup}
                      onChange={(event) => setForm((value) => ({ ...value, partnerGroup: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                    >
                      <option value="EXTERNAL">EXTERNAL (Bên ngoài)</option>
                      <option value="INTERNAL">INTERNAL (Nội bộ)</option>
                    </select>
                  </label>
                )}

                {["WAREHOUSE", "MONEY_SOURCE", "PARTNER", "DEPARTMENT"].includes(activeType) && (
                  <label className="text-xs font-bold text-slate-700 block">
                    Cửa hàng liên kết
                    {activeType === "WAREHOUSE" ? (
                      <select
                        value={form.branch}
                        onChange={(event) => handleLinkBranchChange(event.target.value)}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      >
                        <option value="">-- Chọn cửa hàng --</option>
                        {dynamicStores.map((store) => (
                          <option key={store.code} value={store.code}>
                            {store.name}
                          </option>
                        ))}
                      </select>
                    ) : activeType === "MONEY_SOURCE" ? (
                      <select
                        value={form.branch}
                        onChange={(event) => handleLinkBranchChange(event.target.value)}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                      >
                        <option value="">-- Chọn cửa hàng --</option>
                        <option value="ALL">Tất cả cửa hàng</option>
                        {dynamicStores.map((store) => (
                          <option key={store.code} value={store.code}>
                            {store.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        data-input-kind="code"
                        value={form.branch}
                        onChange={(event) => setForm((value) => ({ ...value, branch: event.target.value }))}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                        placeholder="VD: STORE_01"
                      />
                    )}
                  </label>
                )}
              </div>

              {["PARTNER", "BRANCH", "MONEY_SOURCE"].includes(activeType) && (
                <div className="grid grid-cols-2 gap-4">
                  {["PARTNER", "BRANCH"].includes(activeType) && (
                    <label className="text-xs font-bold text-slate-700">
                      Mã số thuế (MST)
                      <input
                        data-input-kind="tax-code"
                        value={form.taxCode}
                        onChange={(event) => setForm((value) => ({ ...value, taxCode: event.target.value }))}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                        placeholder="VD: 0101234567"
                      />
                    </label>
                  )}
                  {["PARTNER", "MONEY_SOURCE"].includes(activeType) && (
                    <label className="text-xs font-bold text-slate-700">
                      Số tài khoản ngân hàng
                      <input
                        data-input-kind="account-number"
                        value={form.accountNo}
                        onChange={(event) => setForm((value) => ({ ...value, accountNo: event.target.value }))}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                        placeholder="VD: 19031234567019"
                      />
                    </label>
                  )}
                </div>
              )}

              {["PARTNER", "BRANCH", "DEPARTMENT", "WAREHOUSE"].includes(activeType) && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <label className="text-xs font-bold text-slate-700">
                      Người liên hệ chính
                      <input
                        value={form.contactName}
                        onChange={(event) => setForm((value) => ({ ...value, contactName: event.target.value }))}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                        placeholder="VD: Nguyễn Văn A"
                      />
                    </label>
                    <label className="text-xs font-bold text-slate-700">
                      Số điện thoại
                      <input
                        data-input-kind="phone"
                        value={form.phone}
                        onChange={(event) => setForm((value) => ({ ...value, phone: event.target.value }))}
                        className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                        placeholder="VD: 0901234567"
                      />
                    </label>
                  </div>

                  <label className="text-xs font-bold text-slate-700 block">
                    Địa chỉ email
                    <input
                      data-input-kind="email"
                      type="email"
                      value={form.email}
                      onChange={(event) => setForm((value) => ({ ...value, email: event.target.value }))}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder="VD: contact@company.com"
                    />
                  </label>
                </>
              )}

              {activeType === "MONEY_SOURCE" && (
                <div className="space-y-2">
                <label className="text-xs font-bold text-slate-700 block">
                  Nguồn tiền tổng
                  <select
                    value={showNewSummaryNameInput ? NEW_SUMMARY_SOURCE_NAME : form.summarySourceName}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      if (nextValue === NEW_SUMMARY_SOURCE_NAME) {
                        setCreatingSummaryName(true);
                        setForm((value) => ({ ...value, summarySourceName: "" }));
                        return;
                      }
                      setCreatingSummaryName(false);
                      setForm((value) => ({ ...value, summarySourceName: nextValue }));
                    }}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition cursor-pointer"
                  >
                    <option value="">-- Không gộp, để riêng nguồn này --</option>
                    {summarySourceNameOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                    <option value={NEW_SUMMARY_SOURCE_NAME}>+ Đặt tên nguồn tiền tổng mới...</option>
                  </select>
                  {showNewSummaryNameInput && (
                    <input
                      value={form.summarySourceName}
                      onChange={(event) => setForm((value) => ({ ...value, summarySourceName: event.target.value }))}
                      className="mt-2 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder="VD: FDS - Vietinbank"
                    />
                  )}
                  <span className="mt-1 block text-[11px] font-medium text-slate-500">
                    Các nguồn tiền cùng tên tổng sẽ gộp thành một dòng trên Báo cáo nguồn tiền; bỏ trống thì báo cáo hiện riêng từng nguồn.
                  </span>
                </label>

                {/* Sửa tên nhóm tổng: nằm ngoài <label> để bấm nút không kích hoạt ô chọn ở trên. */}
                {!showNewSummaryNameInput && Boolean(form.summarySourceName) && !renamingSummaryFrom && (
                  <button
                    type="button"
                    onClick={startRenameSummarySource}
                    disabled={!canManageSettings}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-700 disabled:text-slate-400 disabled:cursor-not-allowed transition"
                  >
                    <span className="material-symbols-outlined text-[14px]">edit</span>
                    Sửa tên &quot;{form.summarySourceName}&quot;
                    {summarySourceMembers.length > 0 && <> ({summarySourceMembers.length} nguồn)</>}
                  </button>
                )}

                {Boolean(renamingSummaryFrom) && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
                    <span className="block text-[11px] font-bold text-slate-700">
                      Đổi tên nguồn tiền tổng &quot;{renamingSummaryFrom}&quot;
                    </span>
                    <input
                      value={renameSummaryValue}
                      onChange={(event) => setRenameSummaryValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        void renameSummarySource();
                      }}
                      className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                      placeholder="VD: FDS - Vietinbank"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void renameSummarySource()}
                        disabled={isRenamingSummary}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-60 transition"
                      >
                        {isRenamingSummary ? "Đang lưu..." : "Lưu tên tổng"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingSummaryFrom("")}
                        disabled={isRenamingSummary}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60 transition"
                      >
                        Hủy
                      </button>
                    </div>
                    <span className="mt-2 block text-[11px] font-medium text-slate-500">
                      Lưu tên là đổi ngay cho cả {summarySourceMembers.length} nguồn tiền đang gộp vào tên này
                      {summarySourceMembers.length > 0 && <> ({summarySourceMembers.map((item) => item.code).join(", ")})</>}, không cần bấm Lưu cập nhật.
                    </span>
                    {renameMergesIntoExisting && (
                      <span className="mt-1 block text-[11px] font-bold text-amber-600">
                        Tên này đã có ở nhóm khác — lưu xong hai nhóm sẽ gộp thành một dòng trên báo cáo.
                      </span>
                    )}
                  </div>
                )}

                {/* Sửa tên từng NGUỒN CHI TIẾT đang gộp vào tên tổng: báo cáo chỉ hiện dòng tổng,
                    nên muốn dò xem tên nào đang lệch phải mở lần lượt từng nguồn - liệt kê sẵn ở
                    đây để sửa tại chỗ. Chỉ đổi tên; mã/cửa hàng/phân loại vẫn phải sửa qua form. */}
                {summarySourceMembers.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
                    <span className="block text-[11px] font-bold text-slate-700">
                      Nguồn tiền chi tiết trong nhóm này ({summarySourceMembers.length})
                    </span>
                    <ul className="mt-2 space-y-1.5">
                      {summarySourceMembers.map((item) => (
                        <li key={item.id} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2">
                          {renamingMemberId === item.id ? (
                            <>
                              <input
                                value={renameMemberValue}
                                onChange={(event) => setRenameMemberValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.preventDefault();
                                    setRenamingMemberId("");
                                    return;
                                  }
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  void renameMemberSource(item);
                                }}
                                autoFocus
                                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                                placeholder="VD: KCF - Vietcombank (HKD)"
                              />
                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => void renameMemberSource(item)}
                                  disabled={isRenamingMember}
                                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 disabled:opacity-60 transition"
                                >
                                  {isRenamingMember ? "Đang lưu..." : "Lưu tên"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setRenamingMemberId("")}
                                  disabled={isRenamingMember}
                                  className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-60 transition"
                                >
                                  Hủy
                                </button>
                                <span className="text-[11px] font-medium text-slate-500">{item.code}</span>
                              </div>
                            </>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-800 truncate">
                                  {item.name}
                                  {form.id === item.id && <span className="ml-1 font-medium text-blue-600">(đang mở)</span>}
                                </p>
                                <p className="text-[11px] font-medium text-slate-500">
                                  {item.code}
                                  {item.branch && <> · {item.branch}</>}
                                  {item.status !== "ACTIVE" && <> · Ngừng dùng</>}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => startRenameMemberSource(item)}
                                disabled={!canManageSettings}
                                className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-700 disabled:text-slate-400 disabled:cursor-not-allowed transition"
                              >
                                <span className="material-symbols-outlined text-[14px]">edit</span>
                                Sửa tên
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    <span className="mt-2 block text-[11px] font-medium text-slate-500">
                      Sửa ở đây là đổi ngay tên của riêng nguồn chi tiết đó, không cần bấm Lưu cập nhật và
                      không ảnh hưởng tên tổng. Đổi mã, cửa hàng hay phân loại thì vẫn phải mở đúng nguồn ở
                      danh sách bên ngoài.
                    </span>
                  </div>
                )}
                </div>
              )}

              {activeType === "MONEY_SOURCE" && normalizeMoneySourceGroup(form.group) === "WALLET" && (
                <label className="text-xs font-bold text-slate-700 block">
                  Ngân hàng quyết toán về
                  <select
                    value={form.settlementBankCode}
                    onChange={(event) => setForm((value) => ({ ...value, settlementBankCode: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  >
                    <option value="">-- Chưa khai báo --</option>
                    {items
                      .filter((item) => item.type === "MONEY_SOURCE"
                        && item.status === "ACTIVE"
                        && normalizeMoneySourceGroup(item.group) === "BANK"
                        && moneySourceMatchesBranch(item, form.branch || null))
                      .map((item) => <option key={item.code} value={item.code}>{item.name} ({item.code})</option>)}
                  </select>
                  <span className="mt-1 block text-[11px] font-medium text-slate-500">
                    Tiền trong ví này sẽ về tài khoản ngân hàng nào. Khai báo xong thì doanh thu ví chưa có
                    sao kê sẽ hiện ở cột Dự thu trong kỳ của ngân hàng đó trên Báo cáo nguồn tiền.
                  </span>
                </label>
              )}

              {["ASSET_GROUP", "DEPARTMENT"].includes(activeType) && (
                <label className="text-xs font-bold text-slate-700 block">
                  Tiền tố mã tự động
                  <input
                    data-input-kind="code"
                    value={form.codePrefix}
                    onChange={(event) => setForm((value) => ({ ...value, codePrefix: event.target.value.toUpperCase() }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm uppercase outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                    placeholder={activeType === "DEPARTMENT" ? "VD: KIT" : form.group === "CCDC" || form.group === "TOOL" ? "VD: CCDC" : "VD: TSCD"}
                    maxLength={activeType === "DEPARTMENT" ? 3 : 4}
                  />
                  <span className="mt-1 block text-[11px] font-medium text-slate-500">
                    {activeType === "DEPARTMENT"
                      ? "Đúng 3 ký tự. Để trống sẽ dùng mã phòng ban nếu mã đó có đúng 3 ký tự."
                      : "Đúng 4 ký tự. Để trống sẽ dùng mặc định CCDC hoặc TSCD theo phân loại nhóm."}
                  </span>
                </label>
              )}

              {activeType === "REVENUE_EXPENSE_CATEGORY" && (
                <label className="text-xs font-bold text-slate-700 block">
                  Từ khoá nhận dạng khi import
                  <input
                    value={form.matchKeywords}
                    onChange={(event) => setForm((value) => ({ ...value, matchKeywords: event.target.value }))}
                    className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                    placeholder="VD: ĐỒ ĂN, MÓN ĂN, FOOD"
                  />
                  <span className="mt-1 block text-[11px] font-medium text-slate-500">
                    File doanh thu ghi chữ thay vì mã danh mục thì khai chữ đó ở đây, ngăn nhau bằng dấu phẩy.
                    Import gặp đúng chữ này sẽ tính vào danh mục hiện tại. Sửa xong bấm
                    &quot;Chuẩn hoá nhóm doanh thu đã import&quot; ở màn hình danh sách để áp cho dữ liệu cũ.
                  </span>
                </label>
              )}

              {/* Phụ thu / dịch vụ / thuê không gian: file POS vẫn ghi thành dòng có mã hàng và số
                  lượng, nhưng bán ra không rút gì khỏi kho. Khai một lần cho cả nhóm thay vì phải
                  khai lại từng mã hàng. */}
              {activeType === "REVENUE_EXPENSE_CATEGORY" && normalizeGroupValue(activeType, form.group) === "REVENUE_SOURCE" && (
                <label className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={form.skipInventory}
                    onChange={(event) => setForm((value) => ({ ...value, skipInventory: event.target.checked }))}
                    className="mt-0.5 h-4 w-4 accent-blue-600"
                  />
                  <span className="text-xs font-bold text-slate-700">
                    Không theo dõi tồn kho
                    <span className="mt-1 block text-[11px] font-medium text-slate-500">
                      Doanh thu vẫn ghi nhận đủ và lên P&amp;L như thường, nhưng dòng bán của nhóm này không
                      vào hàng chờ &quot;Rã nguyên liệu&quot; và import không tự tạo mặt hàng cho mã của nó.
                      Dùng cho phụ thu / dịch vụ / thuê không gian.
                    </span>
                  </span>
                </label>
              )}

              <label className="text-xs font-bold text-slate-700 block">
                Ghi chú / Giá trị cấu hình
                <textarea
                  value={form.note}
                  onChange={(event) => setForm((value) => ({ ...value, note: event.target.value }))}
                  className="mt-1.5 w-full border border-slate-300 rounded-lg px-3 py-2 text-sm h-24 resize-none outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition"
                  placeholder={notePlaceholders[activeType] || "Thông tin bổ sung..."}
                />
              </label>
            </form>

            {/* Footer actions of drawer */}
            <div className="px-6 py-4 border-t border-slate-200 flex gap-3 bg-slate-50">
              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowDrawer(false);
                }}
                className="flex-1 border border-slate-300 rounded-lg py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-100 transition"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={isSaving}
                onClick={saveItem}
                className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-bold transition shadow-sm"
              >
                {isSaving ? "Đang lưu..." : form.id ? "Lưu cập nhật" : "Thêm mới"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/20">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full shadow-2xl overflow-hidden flex flex-col p-6 animate-scale-up">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 shrink-0 bg-rose-50 text-rose-500 rounded-full grid place-items-center">
                <span className="material-symbols-outlined text-xl">warning</span>
              </div>
              <h3 className="font-bold text-slate-900 text-base">Xác nhận xóa danh mục</h3>
            </div>

            <p className="text-slate-600 text-xs leading-5 mt-4">
              Hành động này sẽ xóa vĩnh viễn danh mục <b>{confirmDeleteTarget.name}</b> (Mã: <code>{confirmDeleteTarget.code}</code>) khỏi hệ thống.
            </p>
            <p className="text-slate-400 text-[11px] leading-4 mt-2">
              Lưu ý: Bạn không thể xóa nếu danh mục này đang được liên kết bởi các chứng từ hoặc báo cáo thực tế.
            </p>

            <div className="flex items-center gap-3 justify-end mt-6">
              <button
                type="button"
                onClick={() => setConfirmDeleteTarget(null)}
                className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 bg-white hover:bg-slate-50 font-bold text-xs transition"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={() => executeDelete(confirmDeleteTarget)}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-lg text-xs transition shadow-sm"
              >
                Đồng ý xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
