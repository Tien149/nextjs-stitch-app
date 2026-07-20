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
};

export type AppMenuItem = {
  name: string;
  icon: string;
  href: string;
  roles: DemoRole[];
};

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
    branch: "Chủ cửa hàng - Cửa hàng 1",
    email: "congno@fin-erp.vn",
    password: "123456",
  },
  {
    id: "quanly",
    name: "Chủ cửa hàng",
    role: "Quản lý",
    branch: "Chủ cửa hàng - Cửa hàng 2",
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
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý", "Viewer"],
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
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý", "Viewer"],
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
    Viewer: ["view"],
  },
};

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

export function canAccessMenu(role: DemoRole, item: AppMenuItem) {
  return item.roles.includes(role);
}

export function canPerformAction(role: DemoRole, action: AppAction) {
  return roleActions[role]?.includes(action) ?? false;
}

export function canPerformMenuAction(role: DemoRole, href: string, action: AppAction) {
  const configuredActions = menuActionOverrides[href]?.[role];
  return configuredActions ? configuredActions.includes(action) : canPerformAction(role, action);
}
