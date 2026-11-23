import { appMenuItems, canAccessMenu, type DemoRole, type DemoSession } from "@/lib/auth-demo";

/**
 * Các loại import của màn Import dữ liệu. Tách khỏi app/imports/page.tsx (23/11/2026) để màn
 * nghiệp vụ dùng lại đúng cấu hình — Điều tiền (/money-transfers) và Chi phí lương nhân viên
 * (/payroll-costs) đặt khung import ngay trên màn của mình.
 */
export type ImportTab = {
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

export const importTabs: ImportTab[] = [
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
    primaryFields: ["sale_date", "branch_code", "channel", "payment_method", "gross_amount", "net_amount", "external_ref", "product_code", "product_quantity", "combo_code", "warehouse_code"],
  },
  {
    id: "revenue-raw",
    label: "Doanh thu POS (file thô)",
    icon: "receipt_long",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Doanh thu POS từ file máy bán hàng",
    subtitle: "Tải thẳng file máy bán hàng xuất ra, mỗi dòng một món. Hệ thống tự gộp theo ngày, nguồn tiền và mã hàng; dòng có mã hàng chờ nút Rã nguyên liệu bên Kho định lượng để sinh phiếu xuất bán.",
    apiPath: "/api/imports?importType=REVENUE_POS&templateCode=REVENUE_POS_RAW_V1",
    templatePath: "/api/imports?importType=REVENUE_POS&templateCode=REVENUE_POS_RAW_V1&template=1",
    templateCode: "REVENUE_POS_RAW_V1",
    primaryFields: ["sale_date", "branch_code", "product_code", "product_quantity", "combo_code", "payment_method", "gross_amount", "fee_amount", "vat_amount", "net_amount"],
  },
  {
    id: "payroll-department",
    label: "Bảng lương",
    icon: "request_quote",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Bảng lương theo bộ phận",
    subtitle: "Mỗi dòng là một bộ phận của một cửa hàng trong kỳ. TỔNG CHI PHÍ CÔNG TY lên chi phí nhân sự trên P&L; LƯƠNG THỰC NHẬN thành công nợ phải trả người lao động của bộ phận đó; Bảo hiểm (công ty chịu) + Bảo hiểm bắt buộc thành công nợ phải trả cơ quan BHXH.",
    apiPath: "/api/imports?importType=PAYROLL&templateCode=PAYROLL_DEPARTMENT_V1",
    templatePath: "/api/imports?importType=PAYROLL&templateCode=PAYROLL_DEPARTMENT_V1&template=1",
    templateCode: "PAYROLL_DEPARTMENT_V1",
    primaryFields: ["period", "branch_code", "department_code", "headcount", "total_company_cost", "net_amount"],
  },
  {
    id: "payroll",
    label: "Bảng lương (mẫu cũ theo nhân viên)",
    icon: "request_quote",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Bảng lương theo nhân viên",
    subtitle: "Mẫu cũ, mỗi dòng một nhân viên. Giữ lại để nhập bù các kỳ trước; các kỳ mới dùng tab Bảng lương.",
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
    id: "inventory-item-update",
    label: "Cập nhật bổ sung mặt hàng",
    icon: "edit_note",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Cập nhật bổ sung danh mục mặt hàng",
    subtitle: "Chỉ sửa mã ĐÃ CÓ: file chỉ cần cột Mã hàng + các cột muốn bổ sung (Nhóm hàng hóa, Nhóm doanh thu...). Ô trống giữ nguyên giá trị cũ; mã chưa có trong danh mục báo lỗi, không tạo mới.",
    apiPath: "/api/imports?importType=INVENTORY_ITEM&templateCode=INVENTORY_ITEM_UPDATE_V1",
    templatePath: "/api/imports?importType=INVENTORY_ITEM&templateCode=INVENTORY_ITEM_UPDATE_V1&template=1",
    templateCode: "INVENTORY_ITEM_UPDATE_V1",
    primaryFields: ["code", "name", "goods_group", "revenue_group", "category", "min_stock", "note", "status"],
  },
  {
    id: "inventory-transaction",
    label: "Nhập/Xuất kho",
    icon: "warehouse",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Nhập/Xuất kho",
    subtitle: "Nhập mua, xuất hủy, xuất khác và điều chuyển kho theo ĐVT quy đổi.",
    apiPath: "/api/imports?importType=INVENTORY_TRANSACTION&templateCode=INVENTORY_TRANSACTION_STANDARD_V1",
    templatePath: "/api/imports?importType=INVENTORY_TRANSACTION&templateCode=INVENTORY_TRANSACTION_STANDARD_V1&template=1",
    templateCode: "INVENTORY_TRANSACTION_STANDARD_V1",
    primaryFields: ["transaction_date", "transaction_type", "branch_code", "warehouse_code", "to_warehouse_code", "item_code", "quantity", "unit_code", "unit_cost", "partner_code", "reference_code"],
  },
  {
    id: "bom",
    label: "Định lượng/BOM",
    icon: "menu_book",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Định lượng/BOM",
    subtitle: "Nhập định lượng thành phẩm và bán thành phẩm theo mã sản phẩm, mã nguyên liệu.",
    apiPath: "/api/imports?importType=BOM&templateCode=BOM_STANDARD_V1",
    templatePath: "/api/imports?importType=BOM&templateCode=BOM_STANDARD_V1&template=1",
    templateCode: "BOM_STANDARD_V1",
    primaryFields: ["product_code", "product_name", "selling_price", "ingredient_code", "quantity", "waste_rate", "effective_date", "note"],
  },
  {
    id: "stocktake",
    label: "Kiểm kê kho",
    icon: "fact_check",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Kiểm kê kho",
    subtitle: "Nhập tồn thực tế hàng tồn kho để sinh điều chỉnh. CCDC và Tài sản kiểm kê ở mục Kiểm kê CCDC & Tài sản.",
    apiPath: "/api/imports?importType=STOCKTAKE&templateCode=STOCKTAKE_STANDARD_V1",
    templatePath: "/api/imports?importType=STOCKTAKE&templateCode=STOCKTAKE_STANDARD_V1&template=1",
    templateCode: "STOCKTAKE_STANDARD_V1",
    primaryFields: ["stocktake_date", "branch_code", "warehouse_code", "item_code", "actual_quantity", "unit_cost", "reason", "code"],
  },
  {
    id: "production",
    label: "Lệnh chế biến",
    icon: "blender",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Lệnh chế biến",
    subtitle: "Hệ thống tự xuất nguyên liệu theo BOM (có hao hụt) và nhập bán thành phẩm với giá vốn tổng nguyên liệu.",
    apiPath: "/api/imports?importType=PRODUCTION&templateCode=PRODUCTION_STANDARD_V1",
    templatePath: "/api/imports?importType=PRODUCTION&templateCode=PRODUCTION_STANDARD_V1&template=1",
    templateCode: "PRODUCTION_STANDARD_V1",
    primaryFields: ["production_date", "branch_code", "warehouse_code", "to_warehouse_code", "product_code", "product_quantity", "reference_code"],
  },
  {
    id: "waste",
    label: "Hủy hàng theo món",
    icon: "delete_sweep",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Hủy hàng theo định lượng",
    subtitle: "Hủy món theo BOM: tự xuất hủy nguyên liệu theo định lượng. Hủy nguyên liệu lẻ dùng import Nhập/Xuất kho (XUAT_HUY).",
    apiPath: "/api/imports?importType=WASTE&templateCode=WASTE_STANDARD_V1",
    templatePath: "/api/imports?importType=WASTE&templateCode=WASTE_STANDARD_V1&template=1",
    templateCode: "WASTE_STANDARD_V1",
    primaryFields: ["waste_date", "branch_code", "warehouse_code", "product_code", "product_quantity", "reason"],
  },
  {
    id: "asset-stocktake",
    label: "Kiểm kê tài sản",
    icon: "fact_check",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Kiểm kê CCDC & Tài sản",
    subtitle: "Số đếm thực tế từng mã tài sản; duyệt xong số lượng sổ sách cập nhật theo số đếm.",
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
    id: "opening-asset-tool",
    label: "CCDC đầu kỳ",
    icon: "construction",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Tài sản / CCDC đầu kỳ",
    subtitle: "CCDC/tài sản đang phân bổ dở khi lên hệ thống: nguyên giá, số kỳ và giá trị đã phân bổ, còn lại. Hệ thống phân bổ tiếp phần còn lại.",
    apiPath: "/api/imports?importType=OPENING_BALANCE&templateCode=OPENING_ASSET_TOOL_V1",
    templatePath: "/api/imports?importType=OPENING_BALANCE&templateCode=OPENING_ASSET_TOOL_V1&template=1",
    templateCode: "OPENING_ASSET_TOOL_V1",
    primaryFields: ["period", "object_code", "object_name", "asset_group", "original_cost", "allocation_months", "remaining_periods", "depreciated_amount", "amount"],
    requiresBranch: true,
  },
  {
    id: "assets",
    label: "Tài sản & CCDC",
    icon: "precision_manufacturing",
    roles: ["Admin", "Kế toán tổng hợp"],
    title: "Import Tài sản & CCDC",
    subtitle: "Nhập hàng loạt hồ sơ tài sản/CCDC, sau đó mở từng hồ sơ để bổ sung hình ảnh/logo.",
    apiPath: "/api/imports?importType=ASSET&templateCode=ASSET_STANDARD_V1",
    templatePath: "/api/imports?importType=ASSET&templateCode=ASSET_STANDARD_V1&template=1",
    templateCode: "ASSET_STANDARD_V1",
    primaryFields: ["asset_code", "asset_name", "branch_code", "warehouse_code", "department_code", "asset_group", "quantity", "purchase_date", "original_cost", "useful_life_months", "image_url"],
  },
  {
    id: "receipt",
    label: "Phiếu Thu",
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
    label: "Phiếu Chi",
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
    subtitle: "Chuyển tiền giữa quỹ, ngân hàng hoặc ví; nguồn nhận của nhà hàng khác thì phiếu tự sinh công nợ nội bộ hai đầu.",
    apiPath: "/api/imports?importType=INTERNAL_TRANSFER&templateCode=INTERNAL_TRANSFER_STANDARD_V1",
    templatePath: "/api/imports?importType=INTERNAL_TRANSFER&templateCode=INTERNAL_TRANSFER_STANDARD_V1&template=1",
    templateCode: "INTERNAL_TRANSFER_STANDARD_V1",
    primaryFields: ["transfer_date", "from_money_source_code", "to_money_source_code", "amount", "external_ref", "description"],
    requiresBranch: true,
  },
  {
    id: "debt-receivable",
    label: "Công nợ phải thu",
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
    label: "Công nợ phải trả",
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
    label: "Công nợ nội bộ",
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

// Vai trò tùy chỉnh chưa được khai báo trong importTabs -> mở toàn bộ tab thay vì trả về danh sách rỗng,
// đồng bộ với cách canAccessMenu xử lý vai trò ngoài 5 vai trò chuẩn.
export function allowedImportTabsForRole(role: string) {
  const matched = importTabs.filter((tab) => tab.roles.includes(role as DemoRole));
  return matched.length > 0 ? matched : importTabs;
}

export function importTabById(id: string) {
  return importTabs.find((tab) => tab.id === id) || null;
}

/**
 * Loại import một phiên được dùng: phải mở được mục "Import dữ liệu" trong Phân quyền (từ đợt 2,
 * 23/11/2026 mục này chỉ còn là QUYỀN, không hiện ở menu) và được loại import theo vai trò.
 * Khớp gác cổng của /api/imports (requireMenuAccess "/imports").
 */
export function permittedImportTabs(session: DemoSession | null | undefined) {
  if (!session) return [];
  const imports = appMenuItems.find((item) => item.href === "/imports");
  if (!imports || !canAccessMenu(session, imports)) return [];
  return allowedImportTabsForRole(session.role);
}

/**
 * Màn nghiệp vụ đang giữ nút import của từng loại (đợt 2, 23/11/2026). Link cũ "/imports?tab=..."
 * chuyển về đây kèm "import=<loại>" để nút tự mở khung import.
 */
const IMPORT_TAB_HOMES: Record<string, string> = {
  "bank-statements": "/reconciliations",
  revenue: "/reports?tab=revenue-ledger",
  "revenue-raw": "/reports?tab=revenue-ledger",
  "payroll-department": "/payroll-costs?tab=payroll-department",
  payroll: "/payroll-costs?tab=payroll",
  "master-data": "/settings",
  "inventory-item": "/inventory?tab=items",
  "inventory-item-update": "/inventory?tab=items",
  "inventory-transaction": "/inventory?tab=inbound",
  bom: "/inventory?tab=recipes",
  stocktake: "/inventory?tab=stocktake",
  production: "/inventory?tab=production",
  waste: "/inventory?tab=waste",
  "asset-stocktake": "/assets/operations?tab=stocktake",
  "opening-balance": "/opening-balances",
  "opening-asset-tool": "/opening-balances",
  assets: "/assets",
  receipt: "/vouchers",
  payment: "/vouchers",
  "internal-transfer": "/money-transfers",
  "debt-receivable": "/debts",
  "debt-payable": "/debts",
  "debt-internal": "/debts",
};

/** Đường dẫn mới cho link cũ "/imports?tab=<id>"; trang riêng của loại đó (lương, điều tiền) thì không cần mở khung. */
export function importTabHomeHref(id: string) {
  const home = IMPORT_TAB_HOMES[id];
  if (!home) return null;
  if (home.startsWith("/payroll-costs") || home === "/money-transfers") return home;
  return `${home}${home.includes("?") ? "&" : "?"}import=${encodeURIComponent(id)}`;
}

// Nhãn của danh mục mà người dùng bấm Import từ màn hình Cấu hình Danh mục.
export const masterTypeLabels: Record<string, string> = {
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
