/**
 * Báo cáo & BI chia 5 nhóm (khách 25/11/2026). CHỈ là cách xếp hiển thị — quyền vẫn tick theo
 * từng tab của /reports như cũ:
 *
 * - Menu trái: mỗi nhóm là một mục, mở tab đầu tiên vai trò được xem trong nhóm (lib/menu-layout).
 * - Hàng tab trên trang Báo cáo: chỉ hiện các tab cùng nhóm với tab đang mở.
 * - Màn Phân quyền: tab Báo cáo xếp theo nhóm, có dòng tiêu đề nhóm.
 *
 * Tab không thuộc nhóm nào (`REPORT_TABS_ELSEWHERE`) mở từ chỗ khác của menu: Thu chi ngày, Nguồn
 * tiền, Dự báo dòng tiền, Tiền về đủ chưa ở nhóm Tiền; Kỳ & Log gộp vào Nhật ký hệ thống (chỉ Admin,
 * khoá/mở kỳ đã có ở Khóa sổ kỳ kế toán) nên không còn mục menu. Mở các tab này thì hàng tab chỉ
 * hiện đúng tab đó.
 */
export type ReportTabGroup = { id: string; label: string; icon: string; tabs: string[] };

export const REPORT_TAB_GROUPS: ReportTabGroup[] = [
  { id: "operations", label: "Vận hành", icon: "speed", tabs: ["dashboard", "operations"] },
  { id: "budget", label: "Ngân sách", icon: "account_balance", tabs: ["budget", "payroll-budget"] },
  { id: "revenue", label: "Báo cáo doanh thu", icon: "point_of_sale", tabs: ["revenue-ledger", "sales-analysis"] },
  { id: "pnl", label: "P&L", icon: "query_stats", tabs: ["pnl", "daily-pnl", "yoy"] },
  { id: "finance", label: "Báo cáo tài chính", icon: "balance", tabs: ["balance", "legacy-books"] },
];

/** Tab của /reports hiện ở chỗ khác trên menu — nhãn dùng cho dòng tiêu đề ở màn Phân quyền. */
export const REPORT_TABS_ELSEWHERE: Record<string, string> = {
  "daily-cash": "Hiện ở nhóm Tiền",
  "cash-source": "Hiện ở nhóm Tiền",
  cashflow: "Hiện ở nhóm Tiền",
  "revenue-settlement": "Hiện ở nhóm Tiền",
  activity: "Kỳ & Log — gộp vào Nhật ký hệ thống (Admin)",
};

export function reportTabGroupOf(tab: string) {
  return REPORT_TAB_GROUPS.find((group) => group.tabs.includes(tab)) || null;
}

/** Nhãn nhóm của một tab Báo cáo cho màn Phân quyền. */
export function reportTabSectionLabel(tab: string) {
  return reportTabGroupOf(tab)?.label || REPORT_TABS_ELSEWHERE[tab] || "Khác";
}
