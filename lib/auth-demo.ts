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

export function canPerformAction(role: DemoRole, action: AppAction) {
  return roleActions[role]?.includes(action) ?? false;
}

export function canPerformMenuAction(role: DemoRole, href: string, action: AppAction) {
  const configuredActions = menuActionOverrides[href]?.[role];
  return configuredActions ? configuredActions.includes(action) : canPerformAction(role, action);
}
