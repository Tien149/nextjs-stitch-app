export type ImportType =
  | "BANK_STATEMENT"
  | "REVENUE_POS"
  | "OPENING_BALANCE"
  | "PAYROLL"
  | "MASTER_DATA"
  | "INVENTORY_ITEM"
  | "VOUCHER"
  | "INTERNAL_TRANSFER"
  | "DEBT_OPENING";

export type ImportFieldType = "text" | "date" | "number" | "integer";

export type ImportFieldDefinition = {
  field: string;
  label: string;
  required: boolean;
  type: ImportFieldType;
  aliases: string[];
  hiddenFromMapping?: boolean;
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
};

export const importTemplates: ImportTemplateDefinition[] = [
  {
    code: "BANK_STATEMENT_STANDARD_V1",
    importType: "BANK_STATEMENT",
    name: "Sao kê ngân hàng chuẩn",
    description: "Template sao kê ngân hàng gồm ngày, tài khoản, số tham chiếu, diễn giải, ghi nợ/có.",
    fields: [
      {
        field: "transaction_date",
        label: "Ngày giao dịch",
        required: true,
        type: "date",
        aliases: ["ngay giao dich", "ngay gd", "transaction date", "date"],
      },
      {
        field: "bank_account",
        label: "Tài khoản",
        required: true,
        type: "text",
        aliases: ["tai khoan", "so tai khoan", "bank account", "account"],
      },
      {
        field: "transaction_code",
        label: "Số tham chiếu",
        required: true,
        type: "text",
        aliases: ["so tham chieu", "ma giao dich", "ref no", "reference", "transaction code"],
      },
      {
        field: "description",
        label: "Diễn giải",
        required: true,
        type: "text",
        aliases: ["dien giai", "noi dung", "description", "content"],
      },
      {
        field: "debit_amount",
        label: "Ghi nợ",
        required: false,
        type: "number",
        aliases: ["ghi no", "rut tien", "debit", "withdrawal", "money out"],
      },
      {
        field: "credit_amount",
        label: "Ghi có",
        required: false,
        type: "number",
        aliases: ["ghi co", "nop tien", "credit", "deposit", "money in"],
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
        aliases: ["goi y doi tac", "doi tac", "partner", "partner hint"],
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
        required: true,
        type: "text",
        aliases: ["ma tham chieu pos", "external ref", "pos ref", "reference"],
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
      { field: "partner_group", label: "Nhóm đối tượng", required: false, type: "text", aliases: ["nhom doi tuong", "ben trong ben ngoai", "partner group"] },
      { field: "branch", label: "Cửa hàng", required: false, type: "text", aliases: ["chi nhanh", "branch", "branch code"] },
      { field: "tax_code", label: "Mã số thuế", required: false, type: "text", aliases: ["mst", "ma so thue", "tax code"] },
      { field: "account_no", label: "Số tài khoản", required: false, type: "text", aliases: ["so tai khoan", "stk", "account number", "account no"] },
    ],
  },
  {
    code: "INVENTORY_ITEM_STANDARD_V1",
    importType: "INVENTORY_ITEM",
    name: "Danh mục mặt hàng",
    description: "Import danh mục nguyên vật liệu, bao bì, CCDC, tài sản.",
    fields: [
      { field: "code", label: "Mã mặt hàng", required: true, type: "text", aliases: ["ma hang", "ma mat hang", "code", "item code"] },
      { field: "name", label: "Tên mặt hàng", required: true, type: "text", aliases: ["ten hang", "ten mat hang", "name", "item name"] },
      { field: "item_type", label: "Loại hàng", required: true, type: "text", aliases: ["loai hang", "loai mat hang", "item type"] },
      { field: "unit", label: "Đơn vị tính", required: true, type: "text", aliases: ["dvt", "don vi tinh", "unit"] },
      { field: "min_stock", label: "Tồn tối thiểu", required: false, type: "number", aliases: ["ton toi thieu", "min stock", "min_stock"] },
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
    description: "Chuyển tiền giữa hai nguồn tiền, không ghi nhận doanh thu hoặc chi phí.",
    fields: [
      { field: "branch_code", label: "Cửa hàng", required: true, type: "text", aliases: ["chi nhanh", "branch"], hiddenFromMapping: true },
      { field: "transfer_date", label: "Ngày", required: true, type: "date", aliases: ["ngay", "ngay chuyen", "ngay giao dich"] },
      { field: "from_money_source_code", label: "Từ nguồn tiền", required: true, type: "text", aliases: ["tu nguon tien", "nguon chuyen", "tai khoan chuyen"] },
      { field: "to_money_source_code", label: "Đến nguồn tiền", required: true, type: "text", aliases: ["den nguon tien", "nguon nhan", "tai khoan nhan"] },
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
