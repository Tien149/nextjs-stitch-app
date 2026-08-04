import { branchAccessLabel } from "@/lib/branch-labels";

export type DemoRole =
  | "Admin"
  | "Kế toán tổng hợp"
  | "Kế toán công nợ"
  | "Quản lý"
  | "Viewer";

export type AppAction = "view" | "create" | "edit" | "delete" | "approve" | "export" | "config";

export type DemoUser = {
  id: string;
  name: string;
  role: DemoRole;
  branch: string;
  email: string;
  password: string;
};

export type DemoSession = Omit<DemoUser, "password"> & {
  loginAt: string;
  allowedBranches: string[];
  menuAccess?: string[];
  /** Quyền thao tác của vai trò tuỳ chỉnh, lấy từ bảng Role khi đăng nhập. */
  actions?: string[];
};

export type AppMenuItem = {
  name: string;
  icon: string;
  href: string;
  roles: DemoRole[];
};

const standardRoles: DemoRole[] = ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"];

function isDemoRole(role: string): role is DemoRole {
  return standardRoles.includes(role as DemoRole);
}

export const SESSION_KEY = "user_session";

export const demoUsers: DemoUser[] = [
  {
    id: "admin",
    name: "Admin Kế toán",
    role: "Admin",
    branch: "Admin / Tất cả cửa hàng",
    email: "admin@fin-erp.vn",
    password: "123456",
  },
  {
    id: "ktth",
    name: "Kế toán tổng hợp",
    role: "Kế toán tổng hợp",
    branch: "Admin / Tất cả cửa hàng",
    email: "ktth@fin-erp.vn",
    password: "123456",
  },
  {
    id: "congno",
    name: "Kế toán công nợ",
    role: "Kế toán công nợ",
    branch: "Cửa hàng 1",
    email: "congno@fin-erp.vn",
    password: "123456",
  },
  {
    id: "quanly",
    name: "Chủ cửa hàng",
    role: "Quản lý",
    branch: "Cửa hàng 2",
    email: "quanly@fin-erp.vn",
    password: "123456",
  },
  {
    id: "viewer",
    name: "Viewer",
    role: "Viewer",
    branch: "Admin / Tất cả cửa hàng",
    email: "viewer@fin-erp.vn",
    password: "123456",
  },
];

export const appMenuItems: AppMenuItem[] = [
  {
    name: "Dashboard",
    icon: "dashboard",
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Sổ quỹ",
    icon: "account_balance_wallet",
    href: "/finance-operations",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"],
  },
  {
    name: "Số dư đầu kỳ",
    icon: "database",
    href: "/opening-balances",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"],
  },
  {
    name: "Dòng tiền",
    icon: "timeline",
    href: "/reports?tab=cashflow",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Import dữ liệu",
    icon: "upload_file",
    href: "/imports",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
  },
  {
    name: "Đối soát",
    icon: "rule",
    href: "/reconciliations",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
  },
  {
    name: "Chứng từ",
    icon: "receipt_long",
    href: "/vouchers",
    roles: ["Admin", "Kế toán tổng hợp"],
  },
  {
    name: "Sổ cái Kế toán",
    icon: "menu_book",
    href: "/accounting",
    roles: ["Admin", "Kế toán tổng hợp"],
  },
  {
    name: "Tiền cọc",
    icon: "savings",
    href: "/deposits",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"],
  },
  {
    name: "Công nợ Đối tác",
    icon: "handshake",
    href: "/debts",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý"],
  },
  {
    name: "Mua hàng",
    icon: "shopping_cart",
    href: "/procurement",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý"],
  },
  {
    name: "Kho & Định lượng",
    icon: "inventory_2",
    href: "/inventory",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý", "Viewer"],
  },
  {
    name: "Tài sản & Khấu hao",
    icon: "precision_manufacturing",
    href: "/assets",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Công việc",
    icon: "task_alt",
    href: "/work-management",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý", "Viewer"],
  },
  {
    name: "Thu chi ngày",
    icon: "receipt",
    href: "/reports?tab=daily-cash",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Báo cáo nguồn tiền",
    icon: "savings",
    href: "/reports?tab=cash-source",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Báo cáo & BI",
    icon: "monitoring",
    href: "/reports",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Cấu hình Danh mục",
    icon: "settings",
    href: "/settings",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"],
  },
  {
    name: "Phân quyền & Người dùng",
    icon: "admin_panel_settings",
    href: "/permissions",
    roles: ["Admin"],
  },
  {
    name: "Nhật ký Hệ thống",
    icon: "history",
    href: "/audit-logs",
    roles: ["Admin"],
  },
  {
    name: "Thùng rác",
    icon: "delete",
    href: "/trash",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý"],
  },
];

export const ALL_APP_ACTIONS: { key: AppAction; label: string; desc: string }[] = [
  { key: "view", label: "view", desc: "Xem dữ liệu" },
  { key: "create", label: "create", desc: "Tạo mới" },
  { key: "edit", label: "edit", desc: "Chỉnh sửa" },
  { key: "delete", label: "delete", desc: "Xóa dữ liệu" },
  { key: "approve", label: "approve", desc: "Phê duyệt" },
  { key: "export", label: "export", desc: "Xuất Excel / Báo cáo" },
  { key: "config", label: "config", desc: "Cấu hình hệ thống" },
];

export const roleActions: Record<DemoRole, AppAction[]> = {
  Admin: ["view", "create", "edit", "delete", "approve", "export", "config"],
  "Kế toán tổng hợp": ["view", "create", "edit", "export", "config"],
  "Kế toán công nợ": ["view", "create", "edit", "export"],
  "Quản lý": ["view", "approve", "export"],
  Viewer: ["view"],
};

const menuActionOverrides: Partial<Record<string, Partial<Record<DemoRole, AppAction[]>>>> = {
  "/procurement": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export"],
    "Kế toán công nợ": ["view", "export"],
    "Quản lý": ["view", "create", "approve", "export"],
  },
  "/inventory": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export"],
    "Quản lý": ["view", "create", "edit", "export"],
    Viewer: ["view"],
  },
  "/assets": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export"],
    "Quản lý": ["view", "create", "edit", "export"],
  },
  "/finance-operations": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export", "config"],
    "Kế toán công nợ": ["view", "export"],
    "Quản lý": ["view", "export"],
    Viewer: ["view"],
  },
  "/imports": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export"],
    "Kế toán công nợ": ["view", "create", "export"],
  },
  "/accounting": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export", "config"],
  },
  "/work-management": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export"],
    "Quản lý": ["view", "create", "edit", "approve", "export"],
    Viewer: ["view"],
  },
  "/reports": {
    Admin: roleActions.Admin,
    "Kế toán tổng hợp": ["view", "create", "edit", "export", "config"],
    "Quản lý": ["view", "export"],
  },
};

const financialDashboardRoles: DemoRole[] = ["Admin", "Kế toán tổng hợp", "Quản lý"];
const standardRolesList = ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý", "Viewer"];

export function canViewFinancialDashboard(role: DemoRole | string) {
  if (financialDashboardRoles.includes(role as DemoRole)) return true;
  if (!standardRolesList.includes(role)) return true;
  return false;
}

export function getDefaultRouteForRole(role: DemoRole | string) {
  if (canViewFinancialDashboard(role as DemoRole)) return "/";
  if (role === "Kế toán công nợ") return "/debts";
  if (role === "Viewer") return "/work-management";
  const firstAllowed = appMenuItems.find((item) => canAccessMenu(role, item));
  return firstAllowed?.href || "/work-management";
}

export function findDemoUser(userIdOrEmail: string) {
  const normalized = userIdOrEmail.trim().toLowerCase();
  return demoUsers.find(
    (user) => user.id === normalized || user.email.toLowerCase() === normalized,
  );
}

export function createDemoSession(user: DemoUser): DemoSession {
  const allowedBranches = user.id === "congno" ? ["HCM"] : user.id === "quanly" ? ["HN"] : ["ALL"];

  return {
    id: user.id,
    name: user.name,
    role: user.role,
    branch: branchAccessLabel(allowedBranches),
    email: user.email,
    allowedBranches,
    loginAt: new Date().toISOString(),
  };
}

/**
 * Các tab của từng module, khai báo tập trung để màn Phân quyền dựng được checkbox
 * và các trang lọc được tab theo đúng quyền đã gán.
 */
export const moduleTabs: Record<string, Array<{ id: string; label: string }>> = {
  "/reports": [
    { id: "dashboard", label: "Điều hành" },
    { id: "operations", label: "Vận hành" },
    { id: "budget", label: "Ngân sách" },
    { id: "daily-cash", label: "Thu chi ngày" },
    { id: "cash-source", label: "Nguồn tiền" },
    { id: "activity", label: "Kỳ & Log" },
    { id: "pnl", label: "P&L đa chiều" },
    { id: "yoy", label: "Biến động YoY" },
    { id: "cashflow", label: "Dự báo dòng tiền" },
    { id: "balance", label: "Bảng cân đối" },
  ],
  "/finance-operations": [
    { id: "cashbook", label: "Sổ quỹ dòng tiền" },
    { id: "accruals", label: "Trích trước & Phân bổ" },
    { id: "closing", label: "Khóa sổ kỳ kế toán" },
  ],
  "/procurement": [
    { id: "requests", label: "Yêu cầu mua" },
    { id: "quotes", label: "So sánh giá" },
    { id: "orders", label: "Đơn mua hàng" },
  ],
  "/inventory": [
    { id: "stock", label: "Tồn kho" },
    { id: "transactions", label: "Nhập / Xuất" },
    { id: "items", label: "Mặt hàng" },
    { id: "recipes", label: "Định lượng" },
    { id: "production", label: "Chế biến" },
    { id: "stocktake", label: "Kiểm kê" },
    { id: "waste", label: "Hủy hàng" },
  ],
  "/assets/operations": [
    { id: "depreciation", label: "Khấu hao" },
    { id: "maintenance", label: "Bảo trì" },
    { id: "damage", label: "Sửa chữa" },
    { id: "disposal", label: "Thanh lý" },
  ],
};

/** Biểu tượng hiển thị của từng tab, tách khỏi khai báo quyền để giữ moduleTabs gọn. */
export const moduleTabIcons: Record<string, string> = {
  dashboard: "dashboard", operations: "fact_check", budget: "price_check", "daily-cash": "receipt", "cash-source": "savings",
  activity: "history", pnl: "finance", yoy: "query_stats", cashflow: "timeline", balance: "account_balance",
  cashbook: "account_balance_wallet", accruals: "calendar_month", closing: "lock",
  requests: "assignment", quotes: "compare_arrows", orders: "local_shipping",
  stock: "inventory", transactions: "swap_horiz", items: "category", recipes: "menu_book",
  production: "blender", stocktake: "fact_check", waste: "delete_sweep",
  depreciation: "trending_down", maintenance: "build", damage: "report_problem", disposal: "delete_sweep",
};

export function menuBasePath(href: string) {
  return href.split("?")[0];
}

/**
 * Một trang được mở nếu người dùng có BẤT KỲ mục menu nào trỏ tới nó — kể cả mục
 * chỉ trỏ tới một tab (ví dụ "/reports?tab=daily-cash" mở được trang "/reports").
 * Thanh menu bên trái vẫn chỉ hiện đúng những mục được gán.
 */
export function canOpenPath(session: DemoSession | string | null | undefined, path: string) {
  const base = menuBasePath(path);
  if (typeof session === "object" && session) {
    if (session.role === "Admin") return true;
    const list = session.menuAccess;
    if (Array.isArray(list) && list.length > 0) {
      const namedHrefs = appMenuItems.filter((item) => list.includes(item.name)).map((item) => item.href);
      return [...list, ...namedHrefs].some((entry) => menuBasePath(entry) === base);
    }
  }
  return appMenuItems.some((item) => menuBasePath(item.href) === base && canAccessMenu(session, item));
}

/**
 * Các tab của một trang mà người dùng được xem. Trả về null nghĩa là không giới hạn.
 * Chỉ giới hạn khi vai trò được gán menu riêng lẻ theo tab.
 */
export function allowedMenuTabs(session: DemoSession | null | undefined, path: string) {
  if (!session || session.role === "Admin") return null;
  const list = session.menuAccess;
  if (!Array.isArray(list) || list.length === 0) return null;
  const base = menuBasePath(path);
  const named = appMenuItems.filter((item) => list.includes(item.name)).map((item) => item.href);
  // Mục "trần" (không kèm ?tab=) chỉ để hiện menu ngoài sidebar; phạm vi tab do các mục
  // "?tab=..." quyết định. Không có mục nào như vậy nghĩa là xem được mọi tab.
  const tabs = [...list, ...named]
    .filter((entry) => menuBasePath(entry) === base)
    .map((entry) => new URLSearchParams(entry.split("?")[1] || "").get("tab"))
    .filter((tab): tab is string => Boolean(tab));
  return tabs.length > 0 ? [...new Set(tabs)] : null;
}

export function canAccessMenu(roleOrSession: DemoRole | DemoSession | string | null | undefined, item: AppMenuItem, menuAccessList?: string[] | null) {
  if (!roleOrSession) return false;
  let roleName: string;
  let customList = menuAccessList;

  if (typeof roleOrSession === "object") {
    roleName = roleOrSession.role;
    if (!customList && Array.isArray(roleOrSession.menuAccess)) {
      customList = roleOrSession.menuAccess;
    }
  } else {
    roleName = roleOrSession;
  }

  if (roleName === "Admin") return true;

  if (Array.isArray(customList) && customList.length > 0) {
    return customList.includes(item.href) || customList.includes(item.name);
  }

  if (!isDemoRole(roleName)) {
    return item.href !== "/permissions" && item.href !== "/audit-logs";
  }

  return item.roles.includes(roleName);
}

type ActionSubject = DemoRole | DemoSession | string | null | undefined;

function subjectRole(subject: ActionSubject) {
  return typeof subject === "object" && subject ? subject.role : (subject || "");
}

/** Quyền tự khai của vai trò tuỳ chỉnh; vai trò chuẩn không dùng danh sách này. */
function customActions(subject: ActionSubject) {
  if (typeof subject !== "object" || !subject) return null;
  if (isDemoRole(subject.role)) return null;
  return Array.isArray(subject.actions) && subject.actions.length > 0 ? subject.actions : null;
}

export function canPerformAction(subject: ActionSubject, action: AppAction) {
  const custom = customActions(subject);
  if (custom) return custom.includes(action);

  const role = subjectRole(subject);
  if (!isDemoRole(role)) {
    // Vai trò tuỳ chỉnh chưa kèm danh sách quyền (phiên cũ) -> giữ nguyên hành vi trước đây.
    return typeof subject === "object" && subject ? false : false;
  }
  return roleActions[role]?.includes(action) ?? false;
}

export function canPerformMenuAction(subject: ActionSubject, href: string, action: AppAction) {
  const custom = customActions(subject);
  if (custom) return custom.includes(action);

  const role = subjectRole(subject);
  const configuredActions = isDemoRole(role) ? menuActionOverrides[href]?.[role] : undefined;
  return configuredActions ? configuredActions.includes(action) : canPerformAction(subject, action);
}

/** Danh sách tab hiển thị của một module sau khi lọc theo quyền, kèm icon để render. */
export function filterModuleTabs(
  session: DemoSession | null | undefined,
  path: string,
  icons: Record<string, string> = moduleTabIcons,
) {
  const all = moduleTabs[menuBasePath(path)] || [];
  const permitted = allowedMenuTabs(session, path);
  return all
    .filter((tab) => !permitted || permitted.includes(tab.id))
    .map((tab) => ({ ...tab, icon: icons[tab.id] || "circle" }));
}
