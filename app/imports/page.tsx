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
    templatePath: "/api/imports?importType=BANK_STATEMENT&templateCode=BANK_STATEMENT_STANDARD_V1&template=1",
    templateCode: "BANK_STATEMENT_STANDARD_V1",
    primaryFields: ["transaction_date", "transaction_code", "debit_amount", "credit_amount", "category_code", "increase_money_source_code", "decrease_money_source_code", "import_action", "auto_process_type", "auto_process_note"],
    requiresBranch: true,
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
    primaryFields: ["sale_date", "branch_code", "channel", "payment_method", "gross_amount", "net_amount", "external_ref", "product_code", "product_quantity", "warehouse_code"],
  },
  {
    id: "revenue-raw",
    label: "Doanh thu POS (file thô)",
    icon: "receipt_long",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Doanh thu POS từ file máy bán hàng",
    subtitle: "Tải thẳng file máy bán hàng xuất ra, mỗi dòng một món. Hệ thống tự gộp theo ngày và phương thức thanh toán, không cần sửa file.",
    apiPath: "/api/imports?importType=REVENUE_POS&templateCode=REVENUE_POS_RAW_V1",
    templatePath: "/api/imports?importType=REVENUE_POS&templateCode=REVENUE_POS_RAW_V1&template=1",
    templateCode: "REVENUE_POS_RAW_V1",
    primaryFields: ["sale_date", "branch_code", "channel", "revenue_source", "payment_method", "gross_amount", "fee_amount", "vat_amount", "net_amount"],
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
    subtitle: "Nhập đầy đủ danh mục mặt hàng, ĐVT mua, quy đổi, tồn tối thiểu và yêu cầu hình ảnh.",
    apiPath: "/api/imports?importType=INVENTORY_ITEM&templateCode=INVENTORY_ITEM_STANDARD_V1",
    templatePath: "/api/imports?importType=INVENTORY_ITEM&templateCode=INVENTORY_ITEM_STANDARD_V1&template=1",
    templateCode: "INVENTORY_ITEM_STANDARD_V1",
    primaryFields: ["code", "name", "item_type", "unit", "purchase_unit", "conversion_rate", "conversion_note", "min_stock", "requires_image"],
  },
  {
    id: "inventory-transaction",
    label: "Nhap/Xuat kho",
    icon: "warehouse",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Nhap/Xuat kho",
    subtitle: "Nhap mua, xuat huy, xuat khac va dieu chuyen kho theo DVT quy doi.",
    apiPath: "/api/imports?importType=INVENTORY_TRANSACTION&templateCode=INVENTORY_TRANSACTION_STANDARD_V1",
    templatePath: "/api/imports?importType=INVENTORY_TRANSACTION&templateCode=INVENTORY_TRANSACTION_STANDARD_V1&template=1",
    templateCode: "INVENTORY_TRANSACTION_STANDARD_V1",
    primaryFields: ["transaction_date", "transaction_type", "branch_code", "warehouse_code", "to_warehouse_code", "item_code", "quantity", "unit_code", "unit_cost", "partner_code", "reference_code"],
  },
  {
    id: "bom",
    label: "Dinh luong/BOM",
    icon: "menu_book",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Dinh luong/BOM",
    subtitle: "Nhap dinh luong thanh pham va ban thanh pham theo ma san pham, ma nguyen lieu.",
    apiPath: "/api/imports?importType=BOM&templateCode=BOM_STANDARD_V1",
    templatePath: "/api/imports?importType=BOM&templateCode=BOM_STANDARD_V1&template=1",
    templateCode: "BOM_STANDARD_V1",
    primaryFields: ["product_code", "product_name", "selling_price", "ingredient_code", "quantity", "waste_rate", "effective_date", "note"],
  },
  {
    id: "stocktake",
    label: "Kiem ke kho",
    icon: "fact_check",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Kiem ke kho",
    subtitle: "Nhap ton thuc te hang ton kho de sinh dieu chinh. CCDC va Tai san kiem ke tai phan he Tai san & khau hao.",
    apiPath: "/api/imports?importType=STOCKTAKE&templateCode=STOCKTAKE_STANDARD_V1",
    templatePath: "/api/imports?importType=STOCKTAKE&templateCode=STOCKTAKE_STANDARD_V1&template=1",
    templateCode: "STOCKTAKE_STANDARD_V1",
    primaryFields: ["stocktake_date", "branch_code", "warehouse_code", "item_code", "actual_quantity", "unit_cost", "reason", "code"],
  },
  {
    id: "production",
    label: "Lenh che bien",
    icon: "blender",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Lenh che bien",
    subtitle: "He thong tu xuat nguyen lieu theo BOM (co hao hut) va nhap ban thanh pham voi gia von tong nguyen lieu.",
    apiPath: "/api/imports?importType=PRODUCTION&templateCode=PRODUCTION_STANDARD_V1",
    templatePath: "/api/imports?importType=PRODUCTION&templateCode=PRODUCTION_STANDARD_V1&template=1",
    templateCode: "PRODUCTION_STANDARD_V1",
    primaryFields: ["production_date", "branch_code", "warehouse_code", "to_warehouse_code", "product_code", "product_quantity", "reference_code"],
  },
  {
    id: "waste",
    label: "Huy hang theo mon",
    icon: "delete_sweep",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Huy hang theo dinh luong",
    subtitle: "Huy mon theo BOM: tu xuat huy nguyen lieu theo dinh luong. Huy nguyen lieu le dung tab Nhap/Xuat kho (XUAT_HUY).",
    apiPath: "/api/imports?importType=WASTE&templateCode=WASTE_STANDARD_V1",
    templatePath: "/api/imports?importType=WASTE&templateCode=WASTE_STANDARD_V1&template=1",
    templateCode: "WASTE_STANDARD_V1",
    primaryFields: ["waste_date", "branch_code", "warehouse_code", "product_code", "product_quantity", "reason"],
  },
  {
    id: "asset-stocktake",
    label: "Kiem ke Tai san",
    icon: "fact_check",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Kiem ke CCDC & Tai san",
    subtitle: "So dem thuc te tung ma tai san; duyet xong so luong so sach cap nhat theo so dem.",
    apiPath: "/api/imports?importType=ASSET_STOCKTAKE&templateCode=ASSET_STOCKTAKE_STANDARD_V1",
    templatePath: "/api/imports?importType=ASSET_STOCKTAKE&templateCode=ASSET_STOCKTAKE_STANDARD_V1&template=1",
    templateCode: "ASSET_STOCKTAKE_STANDARD_V1",
    primaryFields: ["stocktake_date", "branch_code", "asset_code", "actual_quantity", "condition", "note"],
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
    id: "assets",
    label: "Tai san & CCDC",
    icon: "precision_manufacturing",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Tai san & CCDC",
    subtitle: "Nhap hang loat ho so tai san/CCDC, sau do mo tung ho so de bo sung hinh anh/logo.",
    apiPath: "/api/imports?importType=ASSET&templateCode=ASSET_STANDARD_V1",
    templatePath: "/api/imports?importType=ASSET&templateCode=ASSET_STANDARD_V1&template=1",
    templateCode: "ASSET_STANDARD_V1",
    primaryFields: ["asset_code", "asset_name", "branch_code", "warehouse_code", "department_code", "asset_group", "quantity", "purchase_date", "original_cost", "useful_life_months", "image_url"],
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

// Nhãn của danh mục mà người dùng bấm Import từ màn hình Cấu hình Danh mục.
const masterTypeLabels: Record<string, string> = {
  BRANCH: "Cửa hàng",
  DEPARTMENT: "Phòng ban",
  WAREHOUSE: "Kho hàng",
  PARTNER: "Đối tác (khách hàng/NCC)",
  MONEY_SOURCE: "Nguồn tiền",
  PNL_GROUP: "Nhóm hạng mục P&L",
  PNL_ITEM: "Hạng mục P&L",
  REVENUE_EXPENSE_CATEGORY: "Thu / Chi",
  ASSET_GROUP: "Nhóm tài sản",
  INVENTORY_ITEM_GROUP: "Nhóm mặt hàng",
  ACCOUNTING_PERIOD: "Kỳ kế toán",
  DOCUMENT_TYPE: "Loại chứng từ",
  DOCUMENT_NUMBER_RULE: "Quy tắc mã",
  SYSTEM_PARAM: "Tham số hệ thống",
};

// Vai trò tùy chỉnh chưa được khai báo trong importTabs -> mở toàn bộ tab thay vì trả về danh sách rỗng,
// đồng bộ với cách canAccessMenu xử lý vai trò ngoài 5 vai trò chuẩn.
function allowedTabsForRole(role: string) {
  const matched = importTabs.filter((tab) => tab.roles.includes(role as DemoRole));
  return matched.length > 0 ? matched : importTabs;
}

export default function ImportsPage() {
  const router = useRouter();
  const [session, setSession] = useState<DemoSession | null>(null);
  const [active, setActive] = useState("bank-statements");
  const [masterType, setMasterType] = useState("");
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
      const allowedTabs = allowedTabsForRole(parsedSession.role);
      const query = new URLSearchParams(window.location.search);
      const requestedTab = query.get("tab") || "bank-statements";
      const selectedTab = allowedTabs.some((tab) => tab.id === requestedTab) ? requestedTab : allowedTabs[0].id;
      window.setTimeout(() => {
        setSession(parsedSession);
        setActive(selectedTab);
        setMasterType((query.get("masterType") || "").toUpperCase());
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

  const allowedTabs = allowedTabsForRole(session.role);
  const current = allowedTabs.find((tab) => tab.id === active) || allowedTabs[0];
  const masterTypeHint = active === "master-data" && masterTypeLabels[masterType]
    ? ` Đang import danh mục ${masterTypeLabels[masterType]}: cột "Loại danh mục" của mọi dòng phải điền ${masterType}.`
    : "";
  const changeTab = (tabId: string) => {
    setActive(tabId);
    setMasterType("");
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
            className={`flex min-w-max items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm font-bold transition-colors duration-150 lg:min-w-0 ${active === tab.id
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
      subtitle={`${current.subtitle}${masterTypeHint}`}
      menuHref="/imports"
      apiPath={current.apiPath}
      templatePath={current.templatePath}
      templateCode={current.templateCode}
      primaryFields={current.primaryFields}
      requiresBranch={current.requiresBranch}
      navigation={navigation}
      expectedMasterType={active === "master-data" ? masterType : ""}
    />
  );
}
