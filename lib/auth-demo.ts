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
    branch: "Tổng công ty",
    email: "admin@fin-erp.vn",
    password: "123456",
  },
  {
    id: "ktth",
    name: "Kế toán tổng hợp",
    role: "Kế toán tổng hợp",
    branch: "Tổng công ty",
    email: "ktth@fin-erp.vn",
    password: "123456",
  },
  {
    id: "congno",
    name: "Kế toán công nợ",
    role: "Kế toán công nợ",
    branch: "Chi nhánh HCM",
    email: "congno@fin-erp.vn",
    password: "123456",
  },
  {
    id: "quanly",
    name: "Quản lý",
    role: "Quản lý",
    branch: "Chi nhánh Hà Nội",
    email: "quanly@fin-erp.vn",
    password: "123456",
  },
  {
    id: "viewer",
    name: "Viewer",
    role: "Viewer",
    branch: "Tổng công ty",
    email: "viewer@fin-erp.vn",
    password: "123456",
  },
];

export const appMenuItems: AppMenuItem[] = [
  {
    name: "Báo cáo & BI",
    icon: "dashboard",
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý", "Viewer"],
  },
  {
    name: "Tài chính & Sổ quỹ",
    icon: "account_balance_wallet",
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp"],
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
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp", "Quản lý"],
  },
  {
    name: "Import Sao kê",
    icon: "upload_file",
    href: "/imports/bank-statements",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
  },
  {
    name: "Import Doanh thu",
    icon: "point_of_sale",
    href: "/imports/revenue",
    roles: ["Admin", "Kế toán tổng hợp"],
  },
  {
    name: "Chứng từ",
    icon: "receipt_long",
    href: "/",
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
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ", "Quản lý"],
  },
  {
    name: "Cung ứng & Recipe",
    icon: "inventory_2",
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp"],
  },
  {
    name: "Tài sản & Khấu hao",
    icon: "precision_manufacturing",
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp"],
  },
  {
    name: "Nhập liệu AI",
    icon: "smart_toy",
    href: "/",
    roles: ["Admin", "Kế toán tổng hợp"],
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

export function findDemoUser(userIdOrEmail: string) {
  const normalized = userIdOrEmail.trim().toLowerCase();
  return demoUsers.find(
    (user) => user.id === normalized || user.email.toLowerCase() === normalized,
  );
}

export function createDemoSession(user: DemoUser): DemoSession {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    branch: user.branch,
    email: user.email,
    loginAt: new Date().toISOString(),
  };
}

export function canAccessMenu(role: DemoRole, item: AppMenuItem) {
  return item.roles.includes(role);
}

export function canPerformAction(role: DemoRole, action: AppAction) {
  return roleActions[role]?.includes(action) ?? false;
}
