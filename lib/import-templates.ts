export type ImportType =
  | "BANK_STATEMENT"
  | "REVENUE_POS"
  | "OPENING_BALANCE"
  | "PRODUCTION"
  | "WASTE"
  | "ASSET_STOCKTAKE"
  | "PAYROLL"
  | "MASTER_DATA"
  | "INVENTORY_ITEM"
  | "INVENTORY_TRANSACTION"
  | "BOM"
  | "STOCKTAKE"
  | "ASSET"
  | "VOUCHER"
  | "INTERNAL_TRANSFER"
  | "DEBT_OPENING";

export const masterDataImportTypes = [
  "BRANCH",
  "DEPARTMENT",
  "WAREHOUSE",
  "PARTNER",
  "MONEY_SOURCE",
  "PNL_GROUP",
  "PNL_ITEM",
  "REVENUE_EXPENSE_CATEGORY",
  "ASSET_GROUP",
  "INVENTORY_ITEM_GROUP",
  "ACCOUNTING_PERIOD",
  "DOCUMENT_TYPE",
  "DOCUMENT_NUMBER_RULE",
  "SYSTEM_PARAM",
] as const;

export function isMasterDataImportType(value: string) {
  return (masterDataImportTypes as readonly string[]).includes(value);
}

export type ImportFieldType = "text" | "date" | "number" | "integer";

export type ImportFieldDefinition = {
  field: string;
  label: string;
  required: boolean;
  type: ImportFieldType;
  aliases: string[];
  hiddenFromMapping?: boolean;
  /** In ra cột Ghi chú của sheet "Huong dan" trong file mẫu — chỗ người dùng tra khi không biết điền gì. */
  note?: string;
};

export type ImportTemplateDefinition = {
  code: string;
  importType: ImportType;
  name: string;
  description: string;
  fields: ImportFieldDefinition[];
  preferredSheetNames?: string[];
  sectionMarkers?: string[];
  stopSectionMarkers?: string[];
  defaultValues?: Record<string, string | number>;
  /**
   * Gộp các dòng chi tiết thành một dòng cho mỗi tổ hợp chiều nghiệp vụ, cộng dồn các cột số.
   * Dùng cho file xuất thẳng từ máy bán hàng: mỗi món ăn là một dòng, nhưng kế toán chỉ cần
   * doanh thu theo ngày và theo phương thức thanh toán.
   */
  aggregate?: { by: string[]; sum: string[] };
};

export const importTemplates: ImportTemplateDefinition[] = [
  {
    code: "BANK_STATEMENT_STANDARD_V1",
    importType: "BANK_STATEMENT",
    name: "Sao kê ngân hàng chuẩn",
    description: "Template sao kê ngân hàng gồm ngày, tài khoản, số tham chiếu, diễn giải, ghi nợ/có.",
    preferredSheetNames: ["Import chuyển khoản", "Sao kê", "Bank statement"],
    fields: [
      {
        field: "transaction_date",
        label: "Ngày giao dịch",
        required: true,
        type: "date",
        aliases: ["ngay giao dich", "ngay gd", "ngay hach toan", "accounting date", "transaction date", "date"],
      },
      {
        field: "bank_account",
        label: "Tài khoản",
        // Có thể suy ra từ Nguồn tiền cộng/tổng trong file đã phân loại.
        required: false,
        type: "text",
        aliases: ["tai khoan ngan hang", "bank account"],
      },
      {
        field: "transaction_code",
        label: "Số tham chiếu",
        required: true,
        type: "text",
        aliases: ["so tham chieu", "so giao dich", "ma giao dich", "transaction number", "ref no", "reference", "transaction code"],
      },
      {
        field: "description",
        label: "Diễn giải",
        required: true,
        type: "text",
        aliases: ["dien giai", "noi dung", "mo ta giao dich", "mo ta giao dich transaction description", "transaction description", "description", "content"],
      },
      {
        field: "debit_amount",
        label: "Ghi nợ",
        required: false,
        type: "number",
        aliases: ["ghi no", "no", "rut tien", "debit", "withdrawal", "money out"],
      },
      {
        field: "credit_amount",
        label: "Ghi có",
        required: false,
        type: "number",
        aliases: ["ghi co", "co", "nop tien", "credit", "deposit", "money in"],
      },
      {
        field: "balance_after",
        label: "Số dư",
        required: false,
        type: "number",
        aliases: ["so du", "balance", "balance after", "closing balance"],
      },
      {
        field: "branch_code",
        label: "Cửa hàng",
        required: false,
        type: "text",
        aliases: ["chi nhanh", "branch", "branch code"],
      },
      {
        field: "partner_hint",
        label: "Gợi ý đối tác",
        required: false,
        type: "text",
        aliases: ["goi y doi tac", "doi tac", "ten tai khoan doi ung", "corresponsive name", "partner", "partner hint"],
      },
      {
        // Khai ngay trên file để giao dịch được phân loại từ lúc import, không phải đợi đối soát.
        field: "category_code",
        label: "Loại thu/chi",
        required: false,
        type: "text",
        aliases: ["loai thu chi", "loai thu/chi", "khoan muc", "khoan muc thu chi", "danh muc thu chi", "category", "category code"],
      },
      {
        field: "source_date",
        label: "Ngày nguồn tiền",
        required: false,
        type: "date",
        aliases: ["ngay nguon tien", "ngay nguon", "source date"],
      },
      {
        field: "revenue_date",
        label: "Ngày doanh thu",
        required: false,
        type: "date",
        aliases: ["ngay doanh thu", "ngay dt", "revenue date"],
      },
      {
        field: "summary_money_source_code",
        label: "Nguồn tiền tổng",
        required: false,
        type: "text",
        aliases: ["nguon tien tong", "nguon tong", "summary money source", "source fund total"],
      },
      {
        field: "increase_money_source_code",
        label: "Cộng nguồn tiền chi tiết",
        required: false,
        type: "text",
        aliases: ["cong nguon tien chi tiet", "cong nguon chi tiet", "increase money source", "credit detail method"],
      },
      {
        field: "decrease_money_source_code",
        label: "Trừ nguồn tiền chi tiết",
        required: false,
        type: "text",
        aliases: ["tru nguon tien chi tiet", "tru nguon chi tiet", "decrease money source", "debit detail method"],
      },
      {
        field: "operation_type",
        label: "Loại nghiệp vụ đích",
        required: false,
        type: "text",
        aliases: ["loai nghiep vu dich", "loai nghiep vu", "nghiep vu dich", "operation type", "target operation"],
      },
      {
        field: "partner_code",
        label: "Mã đối tác",
        required: false,
        type: "text",
        aliases: ["ma doi tac", "ma ncc", "ma khach hang", "nha cung cap", "partner code", "supplier code", "customer code"],
      },
      {
        // Hai cột tách chiều công nợ theo yêu cầu khách: "Mã đối tác" cũ không nói được dòng
        // tiền ra là trả nợ NCC hay chi hộ cho đối tác phải thu. Khai một trong hai cột này
        // là đủ để hệ thống suy Loại nghiệp vụ đích công nợ, không cần khai Mã công nợ.
        field: "payable_partner_code",
        label: "Mã đối tác (phải trả)",
        required: false,
        type: "text",
        aliases: ["ma doi tac phai tra", "doi tac phai tra", "phai tra", "payable partner", "ap partner"],
      },
      {
        field: "receivable_partner_code",
        label: "Mã đối tác (phải thu)",
        required: false,
        type: "text",
        aliases: ["ma doi tac phai thu", "doi tac phai thu", "phai thu", "receivable partner", "ar partner"],
      },
      {
        field: "pnl_item_code",
        label: "Hạng mục P&L",
        required: false,
        type: "text",
        aliases: ["hang muc p&l", "hang muc pnl", "ma p&l", "ma pnl", "chi phi p&l", "pnl item", "pnl item code"],
      },
      {
        field: "debt_reference",
        label: "Mã công nợ",
        required: false,
        type: "text",
        aliases: ["ma cong no", "tham chieu cong no", "debt reference", "debt code"],
      },
      {
        field: "deposit_code",
        label: "Mã tiền cọc",
        required: false,
        type: "text",
        aliases: ["ma tien coc", "ma coc", "deposit code", "deposit reference"],
      },
      {
        field: "gross_amount",
        label: "Gross doanh thu Ví",
        required: false,
        type: "number",
        aliases: ["gross doanh thu vi", "gross vi", "doanh thu gross vi", "wallet gross", "gross amount"],
      },
      {
        field: "grab_expense_amount",
        label: "Phí Grab",
        required: false,
        type: "number",
        aliases: ["phi grab", "chi phi grab", "grab expense", "grab fee"],
      },
      {
        field: "card_fee_amount",
        label: "Phí cà thẻ/Ví khác",
        required: false,
        type: "number",
        aliases: ["phi ca the", "phi vi khac", "phi the vi", "card fee", "wallet fee"],
      },
    ],
  },
  {
    code: "REVENUE_POS_STANDARD_V1",
    importType: "REVENUE_POS",
    name: "Doanh thu POS chuẩn",
    description: "Template doanh thu theo ngày, chi nhánh, kênh dine-in/takeaway/delivery và phương thức thanh toán.",
    fields: [
      {
        field: "sale_date",
        label: "Ngày bán",
        required: true,
        type: "date",
        aliases: ["ngay ban", "ngay", "sale date", "business date"],
      },
      {
        field: "branch_code",
        label: "Cửa hàng",
        required: true,
        type: "text",
        aliases: ["chi nhanh", "branch", "branch code", "store"],
      },
      {
        field: "channel",
        label: "Kênh bán",
        required: false,
        type: "text",
        aliases: ["kenh ban", "channel", "sales channel"],
      },
      {
        field: "revenue_source",
        label: "Nguồn doanh thu",
        required: true,
        type: "text",
        aliases: ["nguon doanh thu", "revenue source", "source"],
      },
      {
        field: "payment_method",
        label: "Phương thức thanh toán",
        required: true,
        type: "text",
        aliases: ["phuong thuc thanh toan", "payment method", "payment", "method"],
      },
      {
        field: "order_count",
        label: "Số bill",
        required: false,
        type: "integer",
        aliases: ["so bill", "so don", "order count", "bill count"],
      },
      {
        field: "gross_amount",
        label: "Doanh thu gross",
        required: true,
        type: "number",
        aliases: ["doanh thu gross", "gross amount", "gross revenue"],
      },
      {
        field: "discount_amount",
        label: "Giảm giá",
        required: false,
        type: "number",
        aliases: ["giam gia", "discount", "discount amount"],
      },
      {
        field: "vat_amount",
        label: "VAT",
        required: false,
        type: "number",
        aliases: ["vat", "vat amount", "thue vat"],
      },
      {
        field: "fee_amount",
        label: "Phí nền tảng",
        required: false,
        type: "number",
        aliases: ["phi nen tang", "platform fee", "fee"],
      },
      {
        field: "net_amount",
        label: "Doanh thu net",
        required: true,
        type: "number",
        aliases: ["doanh thu net", "net amount", "net revenue"],
      },
      {
        field: "external_ref",
        label: "Mã tham chiếu POS",
        required: false,
        type: "text",
        aliases: ["ma tham chieu pos", "external ref", "pos ref", "reference"],
      },
      { field: "product_code", label: "Ma mon POS", required: false, type: "text", aliases: ["ma mon pos", "ma mon", "product code", "item code"] },
      { field: "product_quantity", label: "So luong ban", required: false, type: "number", aliases: ["so luong ban", "quantity sold", "qty", "product quantity"] },
      { field: "warehouse_code", label: "Kho xuat", required: false, type: "text", aliases: ["kho xuat", "kho", "warehouse", "warehouse code"] },
    ],
  },
  {
    code: "REVENUE_POS_RAW_V1",
    importType: "REVENUE_POS",
    name: "Doanh thu POS (file thô từ máy bán hàng)",
    description: "Mỗi dòng một món trong hoá đơn. Hệ thống tự gộp theo ngày, hình thức bán, nguồn tiền và mã hàng; dòng có Mã hàng + Số lượng chờ nút Rã nguyên liệu bên Kho định lượng để sinh phiếu xuất bán. Cột Tổng tiền là số tiền khách trả, lên báo cáo Tiền về đủ chưa.",
    preferredSheetNames: ["Import doanh thu", "Doanh thu", "Chi tiet doanh thu"],
    // Mỗi món là một dòng nên phải gộp lại; nếu không, các dòng cùng ngày và cùng nguồn tiền
    // sẽ trùng mã tham chiếu và bị báo lỗi hàng loạt. Có mã hàng thì gộp thêm theo mã hàng
    // để giữ số lượng bán từng món cho bước rã định lượng.
    aggregate: {
      by: ["sale_date", "branch_code", "channel", "revenue_source", "payment_method", "product_code"],
      sum: ["gross_amount", "discount_amount", "fee_amount", "vat_amount", "net_amount", "product_quantity"],
    },
    // Bố cục cột theo file "Theo dõi nguồn tiền" chị Bình chốt (meeting 22/08/2026), sheet
    // Import doanh thu: Cửa hàng, Mã hàng, Tên hàng, ..., PTTT, Nguồn, ..., Thời gian, Số lượng,
    // Đơn vị tính, Giá, Giá bán, Thành tiền, ..., Tổng tiền, Loại nguồn tiền, Năm, Tháng, Ngày.
    // Bẫy cột trùng tên phải né bằng thứ tự ưu tiên khớp-khít-trước:
    //  - "Ngày" trong file mới chỉ là SỐ NGÀY trong tháng (1-31); ngày bán thật nằm ở "Thời gian".
    //  - "VAT %" là phần trăm; tiền thuế thật nằm ở "Thuế" (né cả "Thuế khấu trừ").
    //  - "Tổng tiền" phải khớp khít, né "Tổng tiền (không bao gồm VAT)" và "(bao gồm hoa hồng)".
    // File thô đợt trước (Zalo 18/08/2026: Ngày, Nguồn tiền, Doanh thu, Tổng doanh thu...) vẫn
    // đọc được nhờ giữ nguyên các alias cũ.
    fields: [
      {
        field: "sale_date",
        label: "Thời gian",
        required: true,
        type: "date",
        aliases: ["thoi gian", "ngay", "ngay ban", "sale date", "business date"],
        note: "Ngày bán hàng trên máy POS (dd/mm/yyyy)",
      },
      {
        field: "branch_code",
        label: "Cửa hàng",
        required: true,
        type: "text",
        aliases: ["chi nhanh", "branch", "store"],
        note: "Mã hoặc tên cửa hàng (NME, ASA...)",
      },
      {
        field: "product_code",
        label: "Mã hàng",
        required: false,
        type: "text",
        aliases: ["ma hang", "ma mon", "ma mon pos", "ma mat hang", "ma san pham", "product code", "item code"],
        note: "Mã món bán ra — dòng có mã hàng + số lượng sẽ chờ Rã nguyên liệu bên Kho định lượng",
      },
      {
        field: "product_name",
        label: "Tên hàng",
        required: false,
        type: "text",
        aliases: ["ten hang", "ten mon", "ten mat hang", "product name", "item name"],
        note: "Tên món — dùng khi hệ thống tự tạo mặt hàng thành phẩm mới",
      },
      {
        field: "product_quantity",
        label: "Số lượng",
        required: false,
        type: "number",
        aliases: ["so luong", "so luong ban", "sl ban", "quantity", "qty"],
        note: "Số lượng bán — là số lượng cần rã định lượng (xuất bán)",
      },
      {
        field: "unit",
        label: "Đơn vị tính",
        required: false,
        type: "text",
        aliases: ["don vi tinh", "dvt", "unit"],
        note: "Phần, Ly, Món... — dùng khi hệ thống tự tạo mặt hàng mới",
      },
      {
        field: "channel",
        label: "Hình thức bán",
        required: false,
        type: "text",
        aliases: ["hinh thuc ban", "hinh thuc", "nguon", "kenh ban", "kenh", "channel"],
        note: "Tại chỗ, Grab, Mang về...",
      },
      {
        field: "revenue_source",
        label: "Nhóm doanh thu",
        required: false,
        type: "text",
        aliases: ["nhom doanh thu", "nhom dt", "loai mon", "revenue group", "revenue source"],
        note: "Nhóm doanh thu hoặc Loại món. Ghi mã (REV_FOOD), tên danh mục, hay chữ \"ĐỒ ĂN\"/\"ĐỒ UỐNG\" đều được — hệ thống tự quy về mã danh mục Thu. Để trống hoặc ghi chữ lạ thì lấy Nhóm doanh thu khai ở Danh mục mặt hàng theo mã hàng.",
      },
      {
        // Trên file của khách, cột này ghi MÃ hoặc TÊN nguồn tiền trong danh mục
        // (FDSGRABFOOD hoặc "FDS - Chuyển Khoản Vietinbank") — báo cáo Tiền về đủ chưa
        // khớp được cả hai vì matcher chuẩn hóa cả tên lẫn mã.
        field: "payment_method",
        label: "Nguồn tiền",
        required: true,
        type: "text",
        aliases: ["nguon tien", "ma nguon tien", "pttt", "phuong thuc thanh toan", "phuong thuc", "payment method"],
        note: "Mã hoặc tên nguồn tiền trong danh mục (cột PTTT của file POS)",
      },
      {
        field: "gross_amount",
        label: "Doanh thu",
        required: false,
        type: "number",
        aliases: ["doanh thu", "thanh tien", "doanh thu truoc thue"],
        note: "Doanh thu chưa gồm phí và thuế (cột Thành tiền của file POS)",
      },
      {
        field: "discount_amount",
        label: "Giảm giá",
        required: false,
        type: "number",
        aliases: ["giam gia", "discount"],
        note: "Tiền giảm giá trên dòng",
      },
      {
        field: "fee_amount",
        label: "SVC",
        required: false,
        type: "number",
        aliases: ["svc", "phi dich vu", "phi phuc vu", "service charge"],
        note: "Phí dịch vụ",
      },
      {
        field: "vat_amount",
        label: "Thuế",
        required: false,
        type: "number",
        aliases: ["thue gtgt", "thue vat", "tien thue", "vat"],
        note: "Tiền thuế GTGT (cột Thuế, không phải cột VAT %)",
      },
      {
        // "Tổng tiền" = số tiền khách thực trả cho dòng đó, và là số lên báo cáo
        // "Tiền về đủ chưa" cột Doanh thu trong ngày để so với tiền về tài khoản.
        field: "net_amount",
        label: "Tổng tiền",
        required: true,
        type: "number",
        aliases: ["tong tien", "tong doanh thu", "tong cong"],
        note: "Số tiền khách trả. Số này lên báo cáo Tiền về đủ chưa",
      },
    ],
  },
  {
    code: "PAYROLL_STANDARD_V1",
    importType: "PAYROLL",
    name: "Bảng lương chuẩn",
    description: "Template lương theo kỳ, nhân viên, chi nhánh và các khoản thu nhập/khấu trừ.",
    fields: [
      { field: "period", label: "Kỳ lương", required: true, type: "text", aliases: ["ky luong", "ky", "period", "payroll period"] },
      { field: "employee_code", label: "Mã nhân viên", required: true, type: "text", aliases: ["ma nhan vien", "ma nv", "employee code", "staff code"] },
      { field: "employee_name", label: "Tên nhân viên", required: true, type: "text", aliases: ["ten nhan vien", "ho ten", "employee name", "staff name"] },
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch", "store"] },
      { field: "department_code", label: "Phòng ban", required: true, type: "text", aliases: ["phong ban", "bo phan", "department"] },
      { field: "base_salary", label: "Lương cơ bản", required: true, type: "number", aliases: ["luong co ban", "base salary", "basic salary"] },
      { field: "allowance_amount", label: "Phụ cấp", required: false, type: "number", aliases: ["phu cap", "allowance"] },
      { field: "bonus_amount", label: "Thưởng", required: false, type: "number", aliases: ["thuong", "bonus"] },
      { field: "insurance_amount", label: "Bảo hiểm", required: false, type: "number", aliases: ["bao hiem", "insurance"] },
      { field: "tax_amount", label: "Thuế TNCN", required: false, type: "number", aliases: ["thue tncn", "thue", "personal income tax", "tax"] },
      { field: "deduction_amount", label: "Khấu trừ khác", required: false, type: "number", aliases: ["khau tru khac", "khau tru", "deduction"] },
      { field: "net_amount", label: "Thực nhận", required: true, type: "number", aliases: ["thuc nhan", "net amount", "net salary"] },
      { field: "external_ref", label: "Mã tham chiếu", required: false, type: "text", aliases: ["ma tham chieu", "reference", "external ref"] },
    ],
  },
  {
    code: "OPENING_BALANCE_STANDARD_V1",
    importType: "OPENING_BALANCE",
    name: "Số dư đầu kỳ chuẩn",
    description: "Template số dư đầu kỳ dùng để đối chiếu với các nguồn quỹ, công nợ, tồn kho.",
    fields: [
      { field: "period", label: "Kỳ", required: true, type: "text", aliases: ["ky", "period", "ky ke toan"] },
      {
        field: "branch_code",
        label: "Cửa hàng",
        required: true,
        type: "text",
        aliases: ["chi nhanh", "branch", "branch code"],
      },
      {
        field: "balance_type",
        label: "Loại số dư",
        required: true,
        type: "text",
        aliases: ["loai so du", "balance type", "loai"],
      },
      {
        field: "object_code",
        label: "Mã đối tượng",
        required: false,
        type: "text",
        aliases: ["ma doi tuong", "object code", "doi tuong"],
      },
      {
        field: "object_name",
        label: "Tên đối tượng",
        required: false,
        type: "text",
        aliases: ["ten doi tuong", "object name"],
      },
      {
        field: "money_source_code",
        label: "Nguồn tiền",
        required: false,
        type: "text",
        aliases: ["nguon tien", "money source", "money source code"],
      },
      { field: "warehouse_code", label: "Kho", required: false, type: "text", aliases: ["kho", "warehouse", "warehouse code"] },
      { field: "department_code", label: "Phòng ban", required: false, type: "text", aliases: ["phong ban", "department", "department code"] },
      { field: "quantity", label: "Số lượng", required: false, type: "number", aliases: ["so luong", "quantity", "qty"] },
      { field: "unit_cost", label: "Đơn giá", required: false, type: "number", aliases: ["don gia", "unit cost", "unit_cost"] },
      { field: "allocation_months", label: "Số kỳ phân bổ", required: false, type: "integer", aliases: ["so ky phan bo", "so thang phan bo"] },
      { field: "allocation_start_period", label: "Kỳ bắt đầu phân bổ", required: false, type: "text", aliases: ["ky bat dau phan bo", "bat dau phan bo"] },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "note", label: "Ghi chú", required: false, type: "text", aliases: ["ghi chu", "note"] },
    ],
  },
  {
    code: "MASTER_DATA_STANDARD_V1",
    importType: "MASTER_DATA",
    name: "Danh mục hệ thống",
    description: "Import danh mục Đối tác (khách hàng/nhà cung cấp), Kho hàng, Nguồn tiền đồng loạt.",
    fields: [
      { field: "type", label: "Loại danh mục", required: true, type: "text", aliases: ["loai", "loai danh muc", "type"] },
      { field: "code", label: "Mã danh mục", required: true, type: "text", aliases: ["ma", "code", "ma danh muc", "ma doi tuong"] },
      { field: "name", label: "Tên danh mục", required: true, type: "text", aliases: ["ten", "name", "ten danh muc", "ten doi tuong"] },
      { field: "group", label: "Nhóm/Phân loại", required: false, type: "text", aliases: ["nhom", "loai nhom", "group"] },
      { field: "sub_group", label: "Nhóm kho", required: false, type: "text", aliases: ["nhom kho", "nhom kho tuong ung", "sub group"], note: "Chi dung cho INVENTORY_ITEM_GROUP: nhom kho (BEP/BAR/FOH...) khop cot group cua kho WAREHOUSE." },
      { field: "partner_group", label: "Nhóm đối tượng", required: false, type: "text", aliases: ["nhom doi tuong", "ben trong ben ngoai", "partner group"] },
      { field: "branch", label: "Cửa hàng", required: false, type: "text", aliases: ["chi nhanh", "branch", "branch code"] },
      // Chỉ có nghĩa với MONEY_SOURCE: các nguồn cùng tên tổng được Báo cáo nguồn tiền gộp một dòng.
      { field: "summary_source_name", label: "Nguồn tiền tổng", required: false, type: "text", aliases: ["nguon tien tong", "nguon tong", "ten nguon tong", "summary source", "summary source name"] },
      { field: "tax_code", label: "Mã số thuế", required: false, type: "text", aliases: ["mst", "ma so thue", "tax code"] },
      { field: "account_no", label: "Số tài khoản", required: false, type: "text", aliases: ["so tai khoan", "stk", "account number", "account no"] },
      { field: "contact_name", label: "Người liên hệ", required: false, type: "text", aliases: ["nguoi lien he", "lien he", "contact", "contact name"] },
      { field: "phone", label: "Điện thoại", required: false, type: "text", aliases: ["dien thoai", "sdt", "so dien thoai", "phone"] },
      { field: "email", label: "Email", required: false, type: "text", aliases: ["email", "thu dien tu"] },
      { field: "note", label: "Ghi chú", required: false, type: "text", aliases: ["ghi chu", "note", "mo ta"] },
      { field: "status", label: "Trạng thái", required: false, type: "text", aliases: ["trang thai", "status"], note: "ACTIVE hoặc INACTIVE; bỏ trống = giữ nguyên" },
    ],
  },
  {
    code: "INVENTORY_ITEM_STANDARD_V1",
    importType: "INVENTORY_ITEM",
    name: "Danh mục mặt hàng",
    description: "Import danh mục mặt hàng. Loại chuẩn: RAW_MATERIAL, SEMI_FINISHED, FINISHED, PACKAGING, TOOL hoặc ASSET.",
    fields: [
      { field: "purchase_unit", label: "DVT mua", required: false, type: "text", aliases: ["dvt mua", "don vi mua", "purchase unit"] },
      { field: "conversion_rate", label: "Ty le quy doi", required: false, type: "number", aliases: ["ty le quy doi", "he so quy doi", "conversion rate"] },
      { field: "conversion_note", label: "Ghi chu quy doi", required: false, type: "text", aliases: ["ghi chu quy doi", "conversion note"] },
      { field: "code", label: "Mã mặt hàng", required: true, type: "text", aliases: ["ma hang", "ma mat hang", "code", "item code"] },
      { field: "name", label: "Tên mặt hàng", required: true, type: "text", aliases: ["ten hang", "ten mat hang", "name", "item name"] },
      { field: "item_type", label: "Loại hàng", required: true, type: "text", aliases: ["loai hang", "loai mat hang", "item type"] },
      { field: "category", label: "Nhóm mặt hàng", required: false, type: "text", aliases: ["nhom hang", "nhom mat hang", "category", "item group"] },
      { field: "revenue_group", label: "Nhóm doanh thu", required: false, type: "text", aliases: ["nhom doanh thu", "nhom dt", "loai mon", "revenue group", "revenue source"], note: "Ma danh muc Thu (vd REV_FOOD, REV_DRINK) hoac chu \"Do an\"/\"Do uong\". Import doanh thu POS lay cot nay khi file POS khong khai duoc Nhom doanh thu." },
      { field: "unit", label: "Đơn vị tính", required: true, type: "text", aliases: ["dvt", "don vi tinh", "unit"] },
      { field: "min_stock", label: "Tồn tối thiểu", required: false, type: "number", aliases: ["ton toi thieu", "min stock", "min_stock"] },
      { field: "requires_image", label: "Yêu cầu hình ảnh (1/0)", required: false, type: "integer", aliases: ["yeu cau hinh anh", "bat buoc hinh anh", "requires image"] },
      { field: "is_default_purchase", label: "ĐVT mua mặc định (1/0)", required: false, type: "integer", aliases: ["dvt mua mac dinh", "mac dinh mua", "default purchase"], note: "Khai nhiều ĐVT bằng cách lặp mã hàng trên nhiều dòng; đánh 1 cho ĐVT mua chính" },
      { field: "note", label: "Ghi chú", required: false, type: "text", aliases: ["ghi chu", "note", "mo ta"] },
      { field: "status", label: "Trạng thái", required: false, type: "text", aliases: ["trang thai", "status"], note: "ACTIVE hoặc INACTIVE; bỏ trống = giữ nguyên (mã mới = ACTIVE)" },
    ],
  },
  {
    code: "INVENTORY_TRANSACTION_STANDARD_V1",
    importType: "INVENTORY_TRANSACTION",
    name: "Nhap / Xuat kho",
    description: "Import giao dich nhap kho (NHAP_MUA, NHAP_KHAC), xuat kho (XUAT_HUY, XUAT_TEST_MON, XUAT_KHAC) va dieu chuyen kho (DIEU_CHUYEN) theo DVT quy doi.",
    fields: [
      { field: "transaction_date", label: "Ngay", required: true, type: "date", aliases: ["ngay", "ngay giao dich", "transaction date", "date"] },
      { field: "transaction_type", label: "Loai giao dich", required: true, type: "text", aliases: ["loai giao dich", "loai nhap xuat", "transaction type"], note: "NHAP_MUA, NHAP_KHAC, XUAT_HUY, XUAT_TEST_MON, XUAT_KHAC, DIEU_CHUYEN. Nhap che bien/kiem ke/xuat ban do he thong tu sinh." },
      { field: "waste_type", label: "Loai huy", required: false, type: "text", aliases: ["loai huy", "ly do huy", "waste type"], note: "Chi dung cho XUAT_HUY: HET_HAN_SU_DUNG hoac KHONG_DAM_BAO_CHAT_LUONG." },
      { field: "branch_code", label: "Cua hang", required: true, type: "text", aliases: ["cua hang", "chi nhanh", "branch", "store"] },
      { field: "warehouse_code", label: "Kho xuat / nhap", required: true, type: "text", aliases: ["kho", "kho xuat", "kho nhap", "warehouse", "warehouse code"] },
      { field: "to_warehouse_code", label: "Kho nhan", required: false, type: "text", aliases: ["kho nhan", "kho den", "to warehouse", "destination warehouse"] },
      { field: "item_code", label: "Ma mat hang", required: true, type: "text", aliases: ["ma mat hang", "ma hang", "item code", "code"] },
      { field: "quantity", label: "So luong", required: true, type: "number", aliases: ["so luong", "quantity", "qty"] },
      { field: "unit_code", label: "DVT", required: true, type: "text", aliases: ["dvt", "don vi tinh", "unit", "unit code"] },
      { field: "unit_cost", label: "Don gia", required: false, type: "number", aliases: ["don gia", "unit cost", "price"] },
      { field: "reference_code", label: "So chung tu", required: false, type: "text", aliases: ["so chung tu", "ma chung tu", "reference", "external ref"] },
      { field: "partner_code", label: "NCC / Doi tuong", required: false, type: "text", aliases: ["ncc", "ma ncc", "doi tuong", "partner"] },
      { field: "note", label: "Ghi chu", required: false, type: "text", aliases: ["ghi chu", "note", "dien giai"] },
    ],
  },
  {
    code: "BOM_STANDARD_V1",
    importType: "BOM",
    name: "Dinh luong / BOM",
    description: "Import dinh luong thanh pham va ban thanh pham theo sheet Chi tiet: moi dong mot nguyen lieu, DVT co the la DVT quy doi.",
    fields: [
      { field: "group", label: "Nhom", required: false, type: "text", aliases: ["nhom", "group", "loai"], note: "FINISHED hoac SEMI_FINISHED. De trong thi lay theo loai cua ma san pham." },
      { field: "product_code", label: "Ma san pham", required: true, type: "text", aliases: ["ma san pham", "ma mon", "product code"] },
      { field: "product_name", label: "Ten san pham", required: true, type: "text", aliases: ["ten san pham", "ten mon", "product name"] },
      { field: "product_unit", label: "DVT san pham", required: false, type: "text", aliases: ["dvt", "dvt san pham", "don vi tinh san pham", "product unit"], note: "DVT cua me chuan bi (1kg, 400gr, lit sot...). De trong = DVT ton kho." },
      { field: "output_conversion_rate", label: "He so quy doi ve DVT ton kho", required: false, type: "number", aliases: ["he so quy doi ve dvt ton kho", "he so quy doi", "quy doi ton kho", "output conversion"], note: "1 me DVT san pham = bao nhieu DVT ton kho. De trong = 1." },
      { field: "selling_price", label: "Gia ban", required: false, type: "number", aliases: ["gia ban", "selling price", "price"], note: "Chi khai cho FINISHED. Ban thanh pham bo trong." },
      { field: "ingredient_code", label: "Ma nguyen lieu", required: true, type: "text", aliases: ["ma nguyen lieu", "ma hang", "ingredient code"] },
      { field: "ingredient_unit", label: "DVT nguyen lieu", required: false, type: "text", aliases: ["dvt nguyen lieu", "don vi nguyen lieu", "ingredient unit"], note: "DVT ton kho hoac DVT quy doi da khai o danh muc mat hang (vd CHAI830GR)." },
      { field: "ingredient_conversion_rate", label: "He so quy doi nguyen lieu", required: false, type: "number", aliases: ["he so quy doi nguyen lieu", "quy doi nguyen lieu", "ingredient conversion"], note: "So luong x he so = DVT ton kho. De trong thi tra theo DVT nguyen lieu da khai." },
      { field: "quantity", label: "So luong dinh muc", required: true, type: "number", aliases: ["so luong dinh muc", "dinh luong", "quantity"] },
      { field: "waste_rate", label: "Hao hut %", required: false, type: "number", aliases: ["hao hut", "hao hut %", "waste rate"] },
      { field: "effective_date", label: "Ngay ap dung", required: true, type: "date", aliases: ["ngay ap dung", "effective date", "date"], note: "Công thức áp dụng từ ngày này; cùng món có thể khai nhiều phiên bản với ngày khác nhau" },
      { field: "note", label: "Ghi chu", required: false, type: "text", aliases: ["ghi chu", "note"] },
    ],
  },
  {
    code: "STOCKTAKE_STANDARD_V1",
    importType: "STOCKTAKE",
    name: "Kiem ke kho",
    description: "Import ton thuc te theo cua hang, kho va ma hang.",
    fields: [
      { field: "stocktake_date", label: "Ngay kiem ke", required: true, type: "date", aliases: ["ngay kiem ke", "ngay", "date"] },
      { field: "branch_code", label: "Cua hang", required: true, type: "text", aliases: ["cua hang", "chi nhanh", "branch"] },
      { field: "warehouse_code", label: "Kho", required: true, type: "text", aliases: ["kho", "warehouse", "warehouse code"] },
      { field: "item_code", label: "Ma hang", required: true, type: "text", aliases: ["ma hang", "ma mat hang", "item code"] },
      { field: "actual_quantity", label: "Ton thuc te", required: true, type: "number", aliases: ["ton thuc te", "actual quantity", "actual"] },
      { field: "unit_cost", label: "Don gia", required: false, type: "number", aliases: ["don gia", "gia von", "unit cost"], note: "Chỉ bắt buộc khi hàng đếm THỪA mà kho chưa có giá vốn" },
      { field: "reason", label: "Ly do", required: false, type: "text", aliases: ["ly do", "reason"] },
      { field: "code", label: "So phieu", required: false, type: "text", aliases: ["so phieu", "ma phieu", "code"], note: "Bỏ trống để hệ thống tự đánh số KK-YYYY-####" },
      { field: "note", label: "Ghi chu phieu", required: false, type: "text", aliases: ["ghi chu phieu", "ghi chu", "note"] },
    ],
  },
  {
    code: "PRODUCTION_STANDARD_V1",
    importType: "PRODUCTION",
    name: "Lenh che bien",
    description: "Import lenh che bien ban thanh pham theo BOM: he thong tu xuat nguyen lieu theo dinh luong (co hao hut) va nhap ban thanh pham voi gia von bang tong gia tri nguyen lieu.",
    preferredSheetNames: ["Che bien", "Lenh che bien", "Production"],
    fields: [
      { field: "production_date", label: "Ngay che bien", required: true, type: "date", aliases: ["ngay che bien", "ngay", "date"] },
      { field: "branch_code", label: "Cua hang", required: true, type: "text", aliases: ["cua hang", "chi nhanh", "branch"] },
      { field: "warehouse_code", label: "Kho xuat NVL", required: true, type: "text", aliases: ["kho xuat nvl", "kho xuat", "kho", "warehouse"] },
      { field: "to_warehouse_code", label: "Kho nhap BTP", required: false, type: "text", aliases: ["kho nhap btp", "kho nhap", "to warehouse"], note: "Bỏ trống = nhập lại chính kho xuất" },
      { field: "product_code", label: "Ma ban thanh pham", required: true, type: "text", aliases: ["ma ban thanh pham", "ma btp", "ma san pham", "product code"] },
      { field: "product_quantity", label: "So luong che bien", required: true, type: "number", aliases: ["so luong che bien", "so luong", "quantity"] },
      { field: "reference_code", label: "So chung tu", required: false, type: "text", aliases: ["so chung tu", "reference"], note: "Bỏ trống để hệ thống tự đánh số CB-YYYY-####" },
      { field: "note", label: "Ghi chu", required: false, type: "text", aliases: ["ghi chu", "note"] },
    ],
  },
  {
    code: "WASTE_STANDARD_V1",
    importType: "WASTE",
    name: "Huy hang theo dinh luong",
    description: "Import huy mon theo BOM: he thong tu xuat huy nguyen lieu theo dinh luong cua mon (co hao hut). Huy nguyen lieu le thi dung import Nhap/Xuat kho voi loai XUAT_HUY.",
    preferredSheetNames: ["Huy hang", "Huy mon", "Waste"],
    fields: [
      { field: "waste_date", label: "Ngay huy", required: true, type: "date", aliases: ["ngay huy", "ngay", "date"] },
      { field: "branch_code", label: "Cua hang", required: true, type: "text", aliases: ["cua hang", "chi nhanh", "branch"] },
      { field: "warehouse_code", label: "Kho", required: true, type: "text", aliases: ["kho", "warehouse"] },
      { field: "product_code", label: "Ma mon huy", required: true, type: "text", aliases: ["ma mon huy", "ma mon", "ma san pham", "product code"] },
      { field: "product_quantity", label: "So luong mon", required: true, type: "number", aliases: ["so luong mon", "so luong", "quantity"] },
      { field: "reason", label: "Ly do huy", required: true, type: "text", aliases: ["ly do huy", "ly do", "reason"] },
    ],
  },
  {
    code: "ASSET_STOCKTAKE_STANDARD_V1",
    importType: "ASSET_STOCKTAKE",
    name: "Kiem ke CCDC & Tai san",
    description: "Import ket qua kiem ke CCDC/Tai san: so dem thuc te va tinh trang tung ma tai san. Duyet xong he thong cap nhat so luong so sach theo so dem.",
    preferredSheetNames: ["Kiem ke tai san", "Kiem ke CCDC", "Asset stocktake"],
    fields: [
      { field: "stocktake_date", label: "Ngay kiem ke", required: true, type: "date", aliases: ["ngay kiem ke", "ngay", "date"] },
      { field: "branch_code", label: "Cua hang", required: true, type: "text", aliases: ["cua hang", "chi nhanh", "branch"] },
      { field: "asset_code", label: "Ma tai san", required: true, type: "text", aliases: ["ma tai san", "ma ccdc", "asset code"] },
      { field: "actual_quantity", label: "So dem thuc te", required: true, type: "number", aliases: ["so dem thuc te", "so thuc te", "actual quantity"] },
      { field: "condition", label: "Tinh trang", required: false, type: "text", aliases: ["tinh trang", "condition"], note: "Ví dụ: Tốt / Hỏng nhẹ / Chờ sửa" },
      { field: "note", label: "Ghi chu", required: false, type: "text", aliases: ["ghi chu", "note"] },
    ],
  },
  {
    code: "ASSET_STANDARD_V1",
    importType: "ASSET",
    name: "Tai san & CCDC",
    description: "Import ho so tai san/CCDC hang loat, sau do mo tung ho so de bo sung hinh anh/logo neu can.",
    preferredSheetNames: ["Tai san CCDC", "Tai san", "CCDC", "Asset"],
    fields: [
      { field: "asset_code", label: "Ma tai san", required: false, type: "text", aliases: ["ma tai san", "ma ccdc", "asset code", "code"] },
      { field: "asset_name", label: "Ten tai san", required: true, type: "text", aliases: ["ten tai san", "ten ccdc", "asset name", "name"] },
      { field: "branch_code", label: "Cua hang", required: true, type: "text", aliases: ["cua hang", "chi nhanh", "branch", "store"] },
      { field: "warehouse_code", label: "Kho/Vi tri", required: true, type: "text", aliases: ["kho", "vi tri", "location", "warehouse", "warehouse code"] },
      { field: "department_code", label: "Phong ban", required: false, type: "text", aliases: ["phong ban", "bo phan", "department"] },
      { field: "asset_group", label: "Nhom tai san", required: true, type: "text", aliases: ["nhom tai san", "nhom ccdc", "asset group", "group"] },
      { field: "quantity", label: "So luong", required: true, type: "number", aliases: ["so luong", "quantity", "qty"] },
      { field: "purchase_date", label: "Ngay mua", required: true, type: "date", aliases: ["ngay mua", "ngay nhap", "purchase date", "date"] },
      // Khách theo dõi tài sản kiểu quản trị (đếm cái, gắn phòng ban) chứ không làm kế toán,
      // nên nguyên giá không bắt buộc; chỉ tài sản ghi công nợ mới cần nguyên giá thật.
      { field: "original_cost", label: "Nguyen gia", required: false, type: "number", aliases: ["nguyen gia", "gia tri", "original cost", "cost"] },
      { field: "useful_life_months", label: "So ky phan bo/khau hao", required: false, type: "integer", aliases: ["so ky phan bo", "so thang phan bo", "so ky khau hao", "useful life months"] },
      { field: "depreciation_start_date", label: "Ngay bat dau phan bo", required: false, type: "date", aliases: ["ngay bat dau phan bo", "ngay bat dau khau hao", "depreciation start date"] },
      { field: "residual_value", label: "Gia tri thu hoi", required: false, type: "number", aliases: ["gia tri thu hoi", "gia tri con lai toi thieu", "residual value"] },
      { field: "supplier_code", label: "Ma nha cung cap", required: false, type: "text", aliases: ["ma nha cung cap", "ma ncc", "supplier code"] },
      { field: "supplier_name", label: "Ten nha cung cap", required: false, type: "text", aliases: ["ten nha cung cap", "ten ncc", "supplier name"] },
      { field: "payment_status", label: "Thanh toan", required: false, type: "text", aliases: ["thanh toan", "trang thai thanh toan", "payment status"] },
      { field: "payable_amount", label: "So tien cong no", required: false, type: "number", aliases: ["so tien cong no", "cong no phai tra", "payable amount"] },
      { field: "payment_due_date", label: "Han thanh toan", required: false, type: "date", aliases: ["han thanh toan", "ngay den han", "payment due date"] },
      { field: "status", label: "Trang thai", required: false, type: "text", aliases: ["trang thai", "status"] },
      { field: "image_url", label: "URL hinh anh", required: false, type: "text", aliases: ["url hinh anh", "hinh anh", "image", "image url"] },
      { field: "note", label: "Ghi chu", required: false, type: "text", aliases: ["ghi chu", "note"] },
    ],
  },
  {
    code: "CUSTOMER_RECEIPT_V1",
    importType: "VOUCHER",
    name: "Chi tiết Thu - mẫu khách",
    description: "Adapter bảng Chi tiết Thu trong feedback, hỗ trợ sheet Thu hoặc khối Chi tiết thu.",
    preferredSheetNames: ["Thu", "Chi tiet thu", "Chi tiết thu"],
    sectionMarkers: ["Chi tiet thu", "Chi tiết thu"],
    stopSectionMarkers: ["Chi tiet chi", "Chi tiết chi"],
    defaultValues: { voucher_type: "RECEIPT" },
    fields: [
      { field: "voucher_type", label: "Loại phiếu", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch", "branch code"], hiddenFromMapping: true },
      { field: "voucher_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chung tu", "ngay giao dich"] },
      { field: "source_document_code", label: "Số chứng từ", required: false, type: "text", aliases: ["so chung tu", "so chung tu he thong tu sinh", "so chung tu he thong tu sinh"] },
      { field: "source_scope", label: "Loại nguồn", required: true, type: "text", aliases: ["loai nguon"] },
      { field: "category_code", label: "Loại thu", required: true, type: "text", aliases: ["loai thu", "ma khoan muc", "nhom thu"] },
      { field: "description", label: "Mô tả giao dịch", required: true, type: "text", aliases: ["mo ta giao dich", "dien giai", "noi dung"] },
      { field: "amount", label: "Số tiền thực thu", required: true, type: "number", aliases: ["so tien thuc thu", "so tien", "tien thu"] },
      { field: "money_source_code", label: "Nguồn thu", required: true, type: "text", aliases: ["nguon thu", "nguon tien", "nguon quy", "ngan hang", "tai khoan"] },
      { field: "external_ref", label: "Số giao dịch", required: false, type: "text", aliases: ["so giao dich", "ma giao dich", "reference"] },
      { field: "counterparty_account_no", label: "Số tài khoản đối ứng", required: false, type: "text", aliases: ["so tai khoan doi ung", "tai khoan doi ung"] },
      { field: "counterparty_account_name", label: "Tên tài khoản đối ứng", required: false, type: "text", aliases: ["ten tai khoan doi ung"] },
      { field: "partner_code", label: "Mã khách hàng", required: false, type: "text", aliases: ["ma khach hang", "ma doi tac", "partner code"] },
      { field: "partner_name", label: "Tên khách hàng", required: false, type: "text", aliases: ["ten khach hang", "ten doi tac", "partner name"] },
      { field: "deposit_action", label: "Hướng xử lý", required: false, type: "text", aliases: ["huong xu ly", "xu ly tien coc", "deposit action", "can tru vao bill", "hoan coc", "khach chuyen bo sung"] },
      { field: "deposit_code", label: "Mã tiền cọc", required: false, type: "text", aliases: ["ma tien coc", "ma coc", "deposit code"] },
      { field: "debt_action", label: "Xử lý công nợ", required: false, type: "text", aliases: ["xu ly cong no", "giam tru cong no", "thanh toan cong no", "debt action"] },
      { field: "debt_reference", label: "Mã công nợ", required: false, type: "text", aliases: ["ma cong no", "so chung tu cong no", "debt reference"] },
    ],
  },
  {
    code: "CUSTOMER_PAYMENT_V1",
    importType: "VOUCHER",
    name: "Chi tiết Chi - mẫu khách",
    description: "Adapter bảng Chi tiết Chi trong feedback, hỗ trợ sheet Chi hoặc khối Chi tiết chi.",
    preferredSheetNames: ["Chi", "Chi tiet chi", "Chi tiết chi"],
    sectionMarkers: ["Chi tiet chi", "Chi tiết chi"],
    defaultValues: { voucher_type: "PAYMENT" },
    fields: [
      { field: "voucher_type", label: "Loại phiếu", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch", "branch code"], hiddenFromMapping: true },
      { field: "voucher_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chung tu", "ngay giao dich"] },
      { field: "source_document_code", label: "Số chứng từ", required: false, type: "text", aliases: ["so chung tu", "so chung tu he thong tu sinh", "so chung tu he thong tu sinh"] },
      { field: "source_scope", label: "Loại nguồn", required: true, type: "text", aliases: ["loai nguon"] },
      { field: "category_code", label: "Loại chi", required: true, type: "text", aliases: ["loai chi", "loai chi phi", "loai thu", "ma khoan muc", "nhom chi"] },
      { field: "description", label: "Mô tả giao dịch", required: true, type: "text", aliases: ["mo ta giao dich", "dien giai", "noi dung"] },
      { field: "amount", label: "Số tiền thực chi", required: true, type: "number", aliases: ["so tien thuc chi", "so tien", "tien chi"] },
      { field: "money_source_code", label: "Nguồn chi", required: true, type: "text", aliases: ["nguon chi", "nguon thu", "nguon tien", "nguon quy", "ngan hang", "tai khoan"] },
      { field: "external_ref", label: "Số giao dịch", required: false, type: "text", aliases: ["so giao dich", "ma giao dich", "reference"] },
      { field: "counterparty_account_no", label: "Số tài khoản đối ứng", required: false, type: "text", aliases: ["so tai khoan doi ung", "tai khoan doi ung"] },
      { field: "counterparty_account_name", label: "Tên tài khoản đối ứng", required: false, type: "text", aliases: ["ten tai khoan doi ung"] },
      { field: "partner_code", label: "Mã nhà cung cấp", required: false, type: "text", aliases: ["ma nha cung cap", "ma ncc", "ma doi tac"] },
      { field: "partner_name", label: "Tên nhà cung cấp", required: false, type: "text", aliases: ["ten nha cung cap", "ten ncc", "ten doi tac"] },
      { field: "deposit_action", label: "Hướng xử lý", required: false, type: "text", aliases: ["huong xu ly", "xu ly tien coc", "deposit action", "can tru vao bill", "hoan coc", "khach chuyen bo sung"] },
      { field: "deposit_code", label: "Mã tiền cọc", required: false, type: "text", aliases: ["ma tien coc", "ma coc", "deposit code"] },
      { field: "debt_action", label: "Xử lý công nợ", required: false, type: "text", aliases: ["xu ly cong no", "giam tru cong no", "thanh toan cong no", "debt action"] },
      { field: "debt_reference", label: "Mã công nợ", required: false, type: "text", aliases: ["ma cong no", "so chung tu cong no", "debt reference"] },
      { field: "allocation_months", label: "Số kỳ phân bổ", required: false, type: "integer", aliases: ["so ky phan bo", "so thang phan bo"] },
      { field: "allocation_start_period", label: "Kỳ bắt đầu phân bổ", required: false, type: "text", aliases: ["ky bat dau phan bo", "bat dau phan bo"] },
    ],
  },
  {
    code: "VOUCHER_STANDARD_V2",
    importType: "VOUCHER",
    name: "Chứng từ Thu/Chi chuẩn",
    description: "Template chuẩn khi một sheet chứa cả Thu và Chi và có cột Loại phiếu.",
    fields: [
      { field: "voucher_type", label: "Loại phiếu", required: true, type: "text", aliases: ["loai phieu", "loai chung tu", "voucher type", "type"] },
      { field: "voucher_date", label: "Ngày chứng từ", required: true, type: "date", aliases: ["ngay gd", "ngay", "ngay chung tu", "date", "voucher date"] },
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch", "branch code"] },
      { field: "source_scope", label: "Loại nguồn", required: false, type: "text", aliases: ["loai nguon", "source scope"] },
      { field: "money_source_code", label: "Nguồn tiền", required: true, type: "text", aliases: ["nguon tien", "nguon quy", "money source", "money source code"] },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "tien", "amount"] },
      { field: "partner_code", label: "Mã đối tác", required: false, type: "text", aliases: ["ma doi tac", "partner code", "partner"] },
      { field: "partner_name", label: "Tên đối tác", required: false, type: "text", aliases: ["ten doi tac", "partner name"] },
      { field: "category_code", label: "Mã khoản mục", required: true, type: "text", aliases: ["ma khoan muc", "nhom thu chi", "category code", "category"] },
      { field: "external_ref", label: "Số giao dịch", required: false, type: "text", aliases: ["so giao dich", "ma giao dich", "reference"] },
      { field: "description", label: "Diễn giải", required: true, type: "text", aliases: ["dien giai", "noi dung", "description", "mo ta giao dich"] },
    ],
  },
  {
    code: "INTERNAL_TRANSFER_STANDARD_V1",
    importType: "INTERNAL_TRANSFER",
    name: "Điều tiền nội bộ",
    description: "Chuyển tiền giữa hai nguồn tiền, không ghi nhận doanh thu hoặc chi phí. Nguồn nhận được phép thuộc nhà hàng khác — khi đó phiếu sinh công nợ nội bộ: bên chuyển phải thu, bên nhận phải trả.",
    fields: [
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch"], hiddenFromMapping: true },
      { field: "transfer_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chuyen", "ngay giao dich"] },
      { field: "from_money_source_code", label: "Từ nguồn tiền", required: true, type: "text", aliases: ["tu nguon tien", "nguon chuyen", "tai khoan chuyen"] },
      { field: "to_money_source_code", label: "Đến nguồn tiền", required: true, type: "text", aliases: ["den nguon tien", "nguon nhan", "tai khoan nhan"], note: "Được phép là nguồn tiền của nhà hàng khác (điều tiền qua lại giữa hai nhà hàng). Khi đó phiếu tự ghi công nợ nội bộ: bên chuyển phải thu, bên nhận phải trả." },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "external_ref", label: "Số giao dịch", required: false, type: "text", aliases: ["so giao dich", "ma giao dich", "reference"] },
      { field: "description", label: "Diễn giải", required: true, type: "text", aliases: ["dien giai", "noi dung", "mo ta giao dich"] },
    ],
  },
  {
    code: "DEBT_OPENING_STANDARD_V1",
    importType: "DEBT_OPENING",
    name: "Công nợ đầu kỳ",
    description: "Import phải thu/phải trả bên ngoài hoặc nội bộ trước khi go-live.",
    fields: [
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch"], hiddenFromMapping: true },
      { field: "debt_type", label: "Loại công nợ", required: true, type: "text", aliases: ["loai cong no", "phai thu phai tra"] },
      { field: "partner_group", label: "Nhóm đối tượng", required: true, type: "text", aliases: ["nhom doi tuong", "loai nguon", "ben trong ben ngoai"] },
      { field: "document_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chung tu"] },
      { field: "document_code", label: "Số chứng từ", required: false, type: "text", aliases: ["so chung tu", "ma chung tu"] },
      { field: "category_code", label: "Loại thu/chi", required: false, type: "text", aliases: ["loai thu", "loai chi", "loai chi phi"] },
      { field: "partner_code", label: "Mã đối tượng", required: true, type: "text", aliases: ["ma doi tuong", "ma khach hang", "ma nha cung cap", "ma ncc"] },
      { field: "partner_name", label: "Tên đối tượng", required: false, type: "text", aliases: ["ten doi tuong", "ten khach hang", "ten nha cung cap", "ten ncc"] },
      { field: "description", label: "Diễn giải", required: true, type: "text", aliases: ["dien giai", "mo ta giao dich", "noi dung"] },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "due_date", label: "Hạn thanh toán", required: false, type: "date", aliases: ["han thanh toan", "ngay den han"] },
      { field: "allocation_months", label: "Số kỳ phân bổ", required: false, type: "integer", aliases: ["so ky phan bo", "so thang phan bo"] },
      { field: "allocation_start_period", label: "Kỳ bắt đầu phân bổ", required: false, type: "text", aliases: ["ky bat dau phan bo", "bat dau phan bo"] },
    ],
  },
  {
    code: "DEBT_RECEIVABLE_EXTERNAL_V1",
    importType: "DEBT_OPENING",
    name: "Công nợ phải thu bên ngoài",
    description: "Import phải thu khách hàng bên ngoài theo mẫu công nợ của khách.",
    preferredSheetNames: ["Phai thu ngoai", "Phải thu ngoài", "Cong no phai thu", "Công nợ phải thu"],
    sectionMarkers: ["Phai thu ngoai", "Phải thu ngoài"],
    stopSectionMarkers: ["Phai tra ngoai", "Phải trả ngoài", "Phai thu phai tra noi bo", "Phải thu & phải trả nội bộ"],
    defaultValues: { debt_type: "RECEIVABLE", partner_group: "EXTERNAL" },
    fields: [
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch"], hiddenFromMapping: true },
      { field: "debt_type", label: "Loại công nợ", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "partner_group", label: "Nhóm đối tượng", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "document_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chung tu"] },
      { field: "document_code", label: "Số chứng từ", required: false, type: "text", aliases: ["so chung tu", "so chung tu he thong tu sinh", "ma chung tu"] },
      { field: "category_code", label: "Loại thu", required: false, type: "text", aliases: ["loai thu", "ma khoan muc"] },
      { field: "partner_code", label: "Mã khách hàng", required: true, type: "text", aliases: ["ma khach hang", "ma doi tuong"] },
      { field: "partner_name", label: "Tên khách hàng", required: false, type: "text", aliases: ["ten khach hang", "ten doi tuong"] },
      { field: "description", label: "Diễn giải", required: true, type: "text", aliases: ["dien giai", "mo ta giao dich", "noi dung"] },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "due_date", label: "Hạn thanh toán", required: false, type: "date", aliases: ["han thanh toan", "ngay den han"] },
    ],
  },
  {
    code: "DEBT_PAYABLE_EXTERNAL_V1",
    importType: "DEBT_OPENING",
    name: "Công nợ phải trả bên ngoài",
    description: "Import phải trả nhà cung cấp bên ngoài, có thể khai báo số kỳ phân bổ chi phí.",
    preferredSheetNames: ["Phai tra ngoai", "Phải trả ngoài", "Cong no phai tra", "Công nợ phải trả"],
    sectionMarkers: ["Phai tra ngoai", "Phải trả ngoài"],
    stopSectionMarkers: ["Phai thu ngoai", "Phải thu ngoài", "Phai thu phai tra noi bo", "Phải thu & phải trả nội bộ"],
    defaultValues: { debt_type: "PAYABLE", partner_group: "EXTERNAL" },
    fields: [
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch"], hiddenFromMapping: true },
      { field: "debt_type", label: "Loại công nợ", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "partner_group", label: "Nhóm đối tượng", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "document_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chung tu"] },
      { field: "document_code", label: "Số chứng từ", required: false, type: "text", aliases: ["so chung tu", "so chung tu he thong tu sinh", "ma chung tu"] },
      { field: "category_code", label: "Loại chi phí", required: false, type: "text", aliases: ["loai chi phi", "loai chi", "ma khoan muc"] },
      { field: "partner_code", label: "Mã nhà cung cấp", required: true, type: "text", aliases: ["ma nha cung cap", "ma ncc", "ma doi tuong"] },
      { field: "partner_name", label: "Tên nhà cung cấp", required: false, type: "text", aliases: ["ten nha cung cap", "ten ncc", "ten doi tuong"] },
      { field: "description", label: "Diễn giải", required: true, type: "text", aliases: ["dien giai", "mo ta giao dich", "noi dung"] },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "due_date", label: "Hạn thanh toán", required: false, type: "date", aliases: ["han thanh toan", "ngay den han"] },
      { field: "allocation_months", label: "Số kỳ phân bổ", required: false, type: "integer", aliases: ["so ky phan bo", "so thang phan bo"] },
      { field: "allocation_start_period", label: "Kỳ bắt đầu phân bổ", required: false, type: "text", aliases: ["ky bat dau phan bo", "bat dau phan bo"] },
    ],
  },
  {
    code: "DEBT_INTERNAL_V1",
    importType: "DEBT_OPENING",
    name: "Công nợ nội bộ",
    description: "Import phải thu/phải trả nội bộ giữa các đối tượng/cửa hàng.",
    preferredSheetNames: ["Noi bo", "Nội bộ", "Cong no noi bo", "Công nợ nội bộ"],
    sectionMarkers: ["Phai thu phai tra noi bo", "Phải thu & phải trả nội bộ", "Noi bo", "Nội bộ"],
    defaultValues: { partner_group: "INTERNAL" },
    fields: [
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch"], hiddenFromMapping: true },
      { field: "partner_group", label: "Nhóm đối tượng", required: true, type: "text", aliases: [], hiddenFromMapping: true },
      { field: "debt_type", label: "Loại công nợ", required: true, type: "text", aliases: ["loai cong no", "phai thu phai tra"] },
      { field: "document_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chung tu"] },
      { field: "document_code", label: "Số chứng từ", required: false, type: "text", aliases: ["so chung tu", "so chung tu he thong tu sinh", "ma chung tu"] },
      { field: "category_code", label: "Loại thu/chi", required: false, type: "text", aliases: ["loai thu", "loai chi", "loai chi phi"] },
      { field: "partner_code", label: "Mã đối tượng", required: true, type: "text", aliases: ["ma doi tuong", "ma khach hang", "ma nha cung cap", "ma ncc"] },
      { field: "partner_name", label: "Tên đối tượng", required: false, type: "text", aliases: ["ten doi tuong", "ten khach hang", "ten nha cung cap", "ten ncc"] },
      { field: "description", label: "Diễn giải", required: true, type: "text", aliases: ["dien giai", "mo ta giao dich", "noi dung"] },
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "due_date", label: "Hạn thanh toán", required: false, type: "date", aliases: ["han thanh toan", "ngay den han"] },
    ],
  },
];

export function getImportTemplate(importType: ImportType, templateCode?: string) {
  if (templateCode) {
    return importTemplates.find((template) => template.importType === importType && template.code === templateCode);
  }
  return importTemplates.find((template) => template.importType === importType);
}

export function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[()\[\]{}]/g, " ")
    .replace(/[\\/_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
