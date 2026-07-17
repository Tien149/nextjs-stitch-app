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
};

const importTabs: ImportTab[] = [
  {
    id: "bank-statements",
    label: "Sao kê ngân hàng",
    icon: "account_balance",
    roles: ["Admin", "Kế toán tổng hợp", "Kế toán công nợ"],
    title: "Import Sao kê Ngân hàng",
    subtitle: "Nhập giao dịch ngân hàng để đối soát các khoản tiền vào và tiền ra.",
    apiPath: "/api/imports/bank-statements",
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
    apiPath: "/api/imports/revenue",
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
    apiPath: "/api/imports/payroll",
    templatePath: "/api/imports/payroll?template=1",
    templateCode: "PAYROLL_STANDARD_V1",
    primaryFields: ["period", "employee_code", "employee_name", "branch_code", "department_code", "base_salary", "net_amount"],
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
    return <div className="grid min-h-screen place-items-center bg-slate-100"><div className="h-10 w-10 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" /></div>;
  }

  const allowedTabs = importTabs.filter((tab) => tab.roles.includes(session.role));
  const current = allowedTabs.find((tab) => tab.id === active) || allowedTabs[0];
  const changeTab = (tabId: string) => {
    setActive(tabId);
    window.history.replaceState(null, "", `/imports?tab=${tabId}`);
  };
  const navigation = (
    <div className="flex min-w-max gap-1" role="tablist" aria-label="Loại dữ liệu import">
      {allowedTabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => changeTab(tab.id)}
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-bold transition-colors duration-150 ${active === tab.id ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
        >
          <span className="material-symbols-outlined text-lg">{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </div>
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
      navigation={navigation}
    />
  );
}
