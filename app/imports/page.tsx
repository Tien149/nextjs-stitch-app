"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ImportUploadPage from "@/app/imports/ImportUploadPage";
import { appMenuItems, canAccessMenu, type DemoRole, type DemoSession, SESSION_KEY } from "@/lib/auth-demo";

type ImportTab = {
  id: string;
  label: string;
  icon: string;
  roles: DemoRole[];
  title: string;
  subtitle: string;
  apiPath: string;
  templatePath: string;
  templateCode: string;
  primaryFields: string[];
  requiresBranch?: boolean;
};

const importTabs: ImportTab[] = [
  {
    id: "bank-statements",
    label: "Sao kê ngân hàng",
    icon: "account_balance",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Sao kê Ngân hàng",
    subtitle: "Nhập giao dịch ngân hàng để đối soát các khoản tiền vào và tiền ra.",
    apiPath: "/api/imports?importType=BANK_STATEMENT&templateCode=BANK_STATEMENT_STANDARD_V1",
    templatePath: "/templates/mau_sao_ke_ngan_hang.xlsx",
    templateCode: "BANK_STATEMENT_STANDARD_V1",
    primaryFields: ["transaction_date", "bank_account", "transaction_code", "description", "debit_amount", "credit_amount"],
  },
  {
    id: "revenue",
    label: "Doanh thu POS",
    icon: "point_of_sale",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Doanh thu POS",
    subtitle: "Nhập doanh thu theo ngày, chi nhánh, kênh bán và phương thức thanh toán.",
    apiPath: "/api/imports?importType=REVENUE_POS&templateCode=REVENUE_POS_STANDARD_V1",
    templatePath: "/templates/mau_doanh_thu_pos.xlsx",
    templateCode: "REVENUE_POS_STANDARD_V1",
    primaryFields: ["sale_date", "branch_code", "channel", "payment_method", "gross_amount", "net_amount", "external_ref"],
  },
  {
    id: "payroll",
    label: "Bảng lương",
    icon: "request_quote",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Bảng lương",
    subtitle: "Nhập dữ liệu lương theo kỳ, nhân viên, phòng ban và chi nhánh.",
    apiPath: "/api/imports?importType=PAYROLL&templateCode=PAYROLL_STANDARD_V1",
    templatePath: "/api/imports?importType=PAYROLL&templateCode=PAYROLL_STANDARD_V1&template=1",
    templateCode: "PAYROLL_STANDARD_V1",
    primaryFields: ["period", "employee_code", "employee_name", "branch_code", "department_code", "base_salary", "net_amount"],
  },
  {
    id: "master-data",
    label: "Danh mục hệ thống",
    icon: "settings",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Danh mục hệ thống",
    subtitle: "Nhập danh mục Đối tác (khách hàng/nhà cung cấp), Kho hàng, Nguồn tiền đồng loạt.",
    apiPath: "/api/imports?importType=MASTER_DATA&templateCode=MASTER_DATA_STANDARD_V1",
    templatePath: "/api/imports?importType=MASTER_DATA&templateCode=MASTER_DATA_STANDARD_V1&template=1",
    templateCode: "MASTER_DATA_STANDARD_V1",
    primaryFields: ["type", "code", "name", "group", "branch"],
  },
  {
    id: "inventory-item",
    label: "Danh mục mặt hàng",
    icon: "inventory_2",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Danh mục mặt hàng",
    subtitle: "Nhập danh mục nguyên vật liệu, bao bì, công cụ dụng cụ, tài sản cố định.",
    apiPath: "/api/imports?importType=INVENTORY_ITEM&templateCode=INVENTORY_ITEM_STANDARD_V1",
    templatePath: "/api/imports?importType=INVENTORY_ITEM&templateCode=INVENTORY_ITEM_STANDARD_V1&template=1",
    templateCode: "INVENTORY_ITEM_STANDARD_V1",
    primaryFields: ["code", "name", "item_type", "unit"],
  },
  {
    id: "opening-balance",
    label: "Số dư đầu kỳ",
    icon: "database",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Số dư Đầu kỳ",
    subtitle: "Nhập số dư đầu kỳ của tài sản, nguồn tiền, công nợ và tồn kho để đối chiếu.",
    apiPath: "/api/imports?importType=OPENING_BALANCE&templateCode=OPENING_BALANCE_STANDARD_V1",
    templatePath: "/api/imports?importType=OPENING_BALANCE&templateCode=OPENING_BALANCE_STANDARD_V1&template=1",
    templateCode: "OPENING_BALANCE_STANDARD_V1",
    primaryFields: ["period", "branch_code", "balance_type", "money_source_code", "object_code", "warehouse_code", "allocation_months", "amount"],
  },
  {
    id: "receipt",
    label: "Thu",
    icon: "south_west",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Chi tiết Thu",
    subtitle: "Nhập phiếu Thu theo mẫu khách; có thể liên kết tiền cọc hoặc giảm công nợ phải thu.",
    apiPath: "/api/imports?importType=VOUCHER&templateCode=CUSTOMER_RECEIPT_V1",
    templatePath: "/api/imports?importType=VOUCHER&templateCode=CUSTOMER_RECEIPT_V1&template=1",
    templateCode: "CUSTOMER_RECEIPT_V1",
    primaryFields: ["voucher_date", "source_scope", "category_code", "amount", "money_source_code", "partner_name", "deposit_action", "debt_reference"],
    requiresBranch: true,
  },
  {
    id: "payment",
    label: "Chi",
    icon: "north_east",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Chi tiết Chi",
    subtitle: "Nhập phiếu Chi theo mẫu khách; hỗ trợ hoàn cọc, thanh toán công nợ và chi phí phân bổ.",
    apiPath: "/api/imports?importType=VOUCHER&templateCode=CUSTOMER_PAYMENT_V1",
    templatePath: "/api/imports?importType=VOUCHER&templateCode=CUSTOMER_PAYMENT_V1&template=1",
    templateCode: "CUSTOMER_PAYMENT_V1",
    primaryFields: ["voucher_date", "source_scope", "category_code", "amount", "money_source_code", "partner_name", "deposit_action", "debt_reference", "allocation_months"],
    requiresBranch: true,
  },
  {
    id: "internal-transfer",
    label: "Điều tiền",
    icon: "swap_horiz",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Điều tiền Nội bộ",
    subtitle: "Chuyển tiền giữa quỹ, ngân hàng hoặc ví trong cùng chi nhánh mà không tính doanh thu/chi phí.",
    apiPath: "/api/imports?importType=INTERNAL_TRANSFER&templateCode=INTERNAL_TRANSFER_STANDARD_V1",
    templatePath: "/api/imports?importType=INTERNAL_TRANSFER&templateCode=INTERNAL_TRANSFER_STANDARD_V1&template=1",
    templateCode: "INTERNAL_TRANSFER_STANDARD_V1",
    primaryFields: ["transfer_date", "from_money_source_code", "to_money_source_code", "amount", "external_ref", "description"],
    requiresBranch: true,
  },
  {
    id: "debt-receivable",
    label: "CN phải thu",
    icon: "handshake",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Công nợ Phải thu",
    subtitle: "Nhập phải thu khách hàng bên ngoài, dùng để giảm trừ khi import Thu.",
    apiPath: "/api/imports?importType=DEBT_OPENING&templateCode=DEBT_RECEIVABLE_EXTERNAL_V1",
    templatePath: "/api/imports?importType=DEBT_OPENING&templateCode=DEBT_RECEIVABLE_EXTERNAL_V1&template=1",
    templateCode: "DEBT_RECEIVABLE_EXTERNAL_V1",
    primaryFields: ["document_date", "partner_code", "partner_name", "amount", "due_date"],
    requiresBranch: true,
  },
  {
    id: "debt-payable",
    label: "CN phải trả",
    icon: "assignment_late",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Công nợ Phải trả",
    subtitle: "Nhập phải trả nhà cung cấp bên ngoài, có thể khai báo kỳ phân bổ chi phí.",
    apiPath: "/api/imports?importType=DEBT_OPENING&templateCode=DEBT_PAYABLE_EXTERNAL_V1",
    templatePath: "/api/imports?importType=DEBT_OPENING&templateCode=DEBT_PAYABLE_EXTERNAL_V1&template=1",
    templateCode: "DEBT_PAYABLE_EXTERNAL_V1",
    primaryFields: ["document_date", "partner_code", "partner_name", "amount", "allocation_months", "due_date"],
    requiresBranch: true,
  },
  {
    id: "debt-internal",
    label: "CN nội bộ",
    icon: "lan",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Công nợ Nội bộ",
    subtitle: "Nhập phải thu hoặc phải trả nội bộ, phân biệt bằng cột Loại công nợ.",
    apiPath: "/api/imports?importType=DEBT_OPENING&templateCode=DEBT_INTERNAL_V1",
    templatePath: "/api/imports?importType=DEBT_OPENING&templateCode=DEBT_INTERNAL_V1&template=1",
    templateCode: "DEBT_INTERNAL_V1",
    primaryFields: ["debt_type", "document_date", "partner_code", "partner_name", "amount", "due_date"],
    requiresBranch: true,
  },
];

export default function ImportsPage() {
  const router = useRouter();
  const [session, setSession] = useState<DemoSession | null>(null);
  const [active, setActive] = useState("bank-statements");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const rawSession = localStorage.getItem(SESSION_KEY);
    const menu = appMenuItems.find((item) => item.href === "/imports");
    if (!rawSession) {
      router.push("/login?next=/imports");
      return;
    }

    try {
      const parsedSession = JSON.parse(rawSession) as DemoSession;
      if (!menu || !canAccessMenu(parsedSession.role, menu)) {
        router.push("/");
        return;
      }
      const allowedTabs = importTabs.filter((tab) => tab.roles.includes(parsedSession.role));
      const requestedTab = new URLSearchParams(window.location.search).get("tab") || "bank-statements";
      const selectedTab = allowedTabs.some((tab) => tab.id === requestedTab) ? requestedTab : allowedTabs[0].id;
      window.setTimeout(() => {
        setSession(parsedSession);
        setActive(selectedTab);
        setLoading(false);
      }, 0);
    } catch {
      localStorage.removeItem(SESSION_KEY);
      router.push("/login?next=/imports");
    }
  }, [router]);

  if (loading || !session) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  const allowedTabs = importTabs.filter((tab) => tab.roles.includes(session.role));
  const current = allowedTabs.find((tab) => tab.id === active) || allowedTabs[0];
  const changeTab = (tabId: string) => {
    setActive(tabId);
    window.history.replaceState(null, "", `/imports?tab=${tabId}`);
  };
  const navigation = (
    <nav className="rounded-lg border border-slate-200 bg-white p-1.5 shadow-sm" aria-label="Loại dữ liệu import">
      <div className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible" role="tablist">
      {allowedTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => changeTab(tab.id)}
          className={`flex min-w-max items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm font-bold transition-colors duration-150 lg:min-w-0 ${
            active === tab.id
              ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-transparent text-slate-600 hover:border-slate-200 hover:bg-slate-50 hover:text-slate-900"
          }`}
        >
          <span className={`material-symbols-outlined text-lg ${active === tab.id ? "text-blue-600" : "text-slate-500"}`}>{tab.icon}</span>
          <span className="truncate">{tab.label}</span>
        </button>
      ))}
      </div>
    </nav>
  );

  return (
    <ImportUploadPage
      title={current.title}
      subtitle={current.subtitle}
      menuHref="/imports"
      apiPath={current.apiPath}
      templatePath={current.templatePath}
      templateCode={current.templateCode}
      primaryFields={current.primaryFields}
      requiresBranch={current.requiresBranch}
      navigation={navigation}
    />
  );
}
