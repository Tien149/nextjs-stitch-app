import { allowedMenuTabs, appMenuItems, canAccessMenu, menuBasePath, type DemoSession } from "@/lib/auth-demo";
import { permittedImportTabs } from "@/lib/import-tabs";

/**
 * Bố cục menu bên trái theo nhóm (khách 23/11/2026). CHỈ là cách xếp hiển thị:
 *
 * - Quyền vẫn đọc từ appMenuItems / menuAccess như cũ, không vai trò nào phải tick lại.
 * - "Sổ quỹ" (/finance-operations) hiện thành 4 mục ở hai nhóm — Sổ quỹ, Trích trước & Phân bổ,
 *   Tổng hợp chi phí, Khóa sổ kỳ kế toán — mỗi mục là một tab của trang đó, hiện khi vai trò mở
 *   được tab ấy (đúng luật allowedMenuTabs). Ma trận Phân quyền giữ nguyên dòng "Sổ quỹ" + 4 tab.
 * - "Điều tiền" và "Chi phí lương nhân viên" là khung import đặt ra màn riêng: hiện khi vai trò
 *   mở được Import dữ liệu VÀ được loại import đó (cùng luật màn Import dữ liệu).
 * - "Import dữ liệu" không còn ở menu (đợt 2): nút Import Excel nằm trên từng màn nghiệp vụ.
 * - Mục menu nào chưa xếp vào nhóm (mục mới thêm sau này) tự rơi vào nhóm "Khác" để không mất.
 */

export type MenuLayoutLink =
  | { kind: "menu"; href: string }
  | { kind: "tab"; base: string; tab: string; name: string; icon: string }
  | { kind: "import"; href: string; name: string; icon: string; importTabs: string[] };

export type MenuLayoutSection = { label?: string; links: MenuLayoutLink[] };
export type MenuLayoutGroup = { id: string; label: string; icon: string; sections: MenuLayoutSection[] };

const FINANCE = "/finance-operations";

export const MENU_TOP_LINKS: MenuLayoutLink[] = [{ kind: "menu", href: "/" }];

export const MENU_GROUPS: MenuLayoutGroup[] = [
  {
    id: "money",
    label: "Tiền",
    icon: "payments",
    sections: [
      { label: "Tiền mặt", links: [{ kind: "menu", href: "/vouchers" }, { kind: "menu", href: "/reports?tab=daily-cash" }] },
      { label: "Tiền gửi ngân hàng", links: [{ kind: "menu", href: "/bank-vouchers" }, { kind: "menu", href: "/reconciliations" }] },
      {
        links: [
          { kind: "import", href: "/money-transfers", name: "Điều tiền", icon: "swap_horiz", importTabs: ["internal-transfer"] },
          { kind: "menu", href: "/deposits" },
        ],
      },
      {
        label: "Báo cáo",
        links: [
          { kind: "tab", base: FINANCE, tab: "cashbook", name: "Sổ quỹ", icon: "account_balance_wallet" },
          { kind: "menu", href: "/reports?tab=cashflow" },
          { kind: "menu", href: "/reports?tab=cash-source" },
        ],
      },
    ],
  },
  {
    id: "stock",
    label: "Kho & Mua hàng",
    icon: "inventory_2",
    sections: [{
      links: [
        { kind: "menu", href: "/procurement" },
        { kind: "menu", href: "/inventory" },
        // Tab Mặt hàng của Kho tách ra mục riêng (khách 23/11/2026), quyền vẫn là tab "items" của /inventory.
        { kind: "tab", base: "/inventory", tab: "items", name: "Danh sách mặt hàng", icon: "category" },
      ],
    }],
  },
  {
    id: "assets",
    label: "CCDC & Tài sản",
    icon: "precision_manufacturing",
    sections: [{ links: [{ kind: "menu", href: "/assets" }, { kind: "menu", href: "/assets/operations?tab=stocktake" }] }],
  },
  {
    id: "costs",
    label: "Chi phí & Công nợ",
    icon: "request_quote",
    sections: [
      {
        links: [
          { kind: "menu", href: "/debts" },
          { kind: "import", href: "/payroll-costs", name: "Chi phí lương nhân viên", icon: "badge", importTabs: ["payroll-department", "payroll"] },
          { kind: "menu", href: "/cost-reallocations" },
          { kind: "tab", base: FINANCE, tab: "accruals", name: "Trích trước & Phân bổ", icon: "calendar_month" },
          { kind: "tab", base: FINANCE, tab: "expenses", name: "Tổng hợp chi phí", icon: "payments" },
          { kind: "menu", href: "/accounting" },
          { kind: "tab", base: FINANCE, tab: "closing", name: "Khóa sổ kỳ kế toán", icon: "lock" },
        ],
      },
    ],
  },
  {
    id: "reports",
    label: "Báo cáo & BI",
    icon: "monitoring",
    sections: [{ links: [{ kind: "menu", href: "/opening-balances" }, { kind: "menu", href: "/reports" }] }],
  },
  {
    id: "settings",
    label: "Cấu hình & Phân quyền",
    icon: "settings",
    sections: [
      {
        links: [
          { kind: "menu", href: "/settings" },
          { kind: "menu", href: "/permissions" },
          { kind: "menu", href: "/audit-logs" },
          { kind: "menu", href: "/trash" },
        ],
      },
    ],
  },
];

/** Mục menu đã sẵn sàng để vẽ: đã lọc quyền, có nhãn/biểu tượng/đường dẫn. */
export type ResolvedMenuLink = { key: string; name: string; icon: string; href: string };
export type ResolvedMenuGroup = { id: string; label: string; icon: string; sections: Array<{ label?: string; links: ResolvedMenuLink[] }> };

function resolveLink(session: DemoSession, link: MenuLayoutLink): ResolvedMenuLink | null {
  if (link.kind === "menu") {
    const item = appMenuItems.find((menu) => menu.href === link.href);
    if (!item || !canAccessMenu(session, item)) return null;
    return { key: item.href, name: item.name, icon: item.icon, href: item.href };
  }
  if (link.kind === "tab") {
    const base = appMenuItems.find((menu) => menu.href === link.base);
    if (!base || !canAccessMenu(session, base)) return null;
    const tabs = allowedMenuTabs(session, link.base);
    if (tabs && !tabs.includes(link.tab)) return null;
    const href = `${link.base}?tab=${link.tab}`;
    return { key: href, name: link.name, icon: link.icon, href };
  }
  const allowed = permittedImportTabs(session).map((tab) => tab.id);
  if (!link.importTabs.some((tab) => allowed.includes(tab))) return null;
  return { key: link.href, name: link.name, icon: link.icon, href: link.href };
}

/** Các href của appMenuItems đã có chỗ trong bố cục (kể cả trang được trải thành mục tab). */
/**
 * Mục trong appMenuItems chỉ còn là QUYỀN, không hiện ở menu: "Import dữ liệu" (đợt 2, 23/11/2026)
 * — nút Import nằm trên từng màn nghiệp vụ (components/ImportLauncher).
 */
const PERMISSION_ONLY_HREFS = ["/imports"];

function placedMenuHrefs() {
  const placed = new Set<string>(PERMISSION_ONLY_HREFS);
  const visit = (link: MenuLayoutLink) => {
    if (link.kind === "menu") placed.add(link.href);
    if (link.kind === "tab") placed.add(link.base);
  };
  MENU_TOP_LINKS.forEach(visit);
  MENU_GROUPS.forEach((group) => group.sections.forEach((section) => section.links.forEach(visit)));
  return placed;
}

export function resolveMenuLayout(session: DemoSession | null) {
  if (!session) return { top: [] as ResolvedMenuLink[], groups: [] as ResolvedMenuGroup[] };
  const pick = (links: MenuLayoutLink[]) => links.map((link) => resolveLink(session, link)).filter((link): link is ResolvedMenuLink => Boolean(link));
  const placed = placedMenuHrefs();
  const leftovers = appMenuItems.filter((item) => !placed.has(item.href) && !placed.has(menuBasePath(item.href)) && canAccessMenu(session, item));
  const groups: ResolvedMenuGroup[] = MENU_GROUPS
    .map((group) => ({
      id: group.id,
      label: group.label,
      icon: group.icon,
      sections: group.sections.map((section) => ({ label: section.label, links: pick(section.links) })).filter((section) => section.links.length > 0),
    }))
    .filter((group) => group.sections.length > 0);
  if (leftovers.length > 0) {
    groups.push({
      id: "other",
      label: "Khác",
      icon: "more_horiz",
      sections: [{ links: leftovers.map((item) => ({ key: item.href, name: item.name, icon: item.icon, href: item.href })) }],
    });
  }
  return { top: pick(MENU_TOP_LINKS), groups };
}
