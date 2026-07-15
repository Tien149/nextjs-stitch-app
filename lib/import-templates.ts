export type ImportType = "BANK_STATEMENT" | "REVENUE_POS" | "OPENING_BALANCE";

export type ImportFieldType = "text" | "date" | "number" | "integer";

export type ImportFieldDefinition = {
  field: string;
  label: string;
  required: boolean;
  type: ImportFieldType;
  aliases: string[];
};

export type ImportTemplateDefinition = {
  code: string;
  importType: ImportType;
  name: string;
  description: string;
  fields: ImportFieldDefinition[];
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
        label: "Chi nhánh",
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
    description: "Template doanh thu theo ngày/chi nhánh/kênh bán/phương thức thanh toán.",
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
        label: "Chi nhánh",
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
    code: "OPENING_BALANCE_STANDARD_V1",
    importType: "OPENING_BALANCE",
    name: "Số dư đầu kỳ chuẩn",
    description: "Template số dư đầu kỳ dùng để đối chiếu với màn nhập tay Giai đoạn 1.",
    fields: [
      { field: "period", label: "Kỳ", required: true, type: "text", aliases: ["ky", "period"] },
      {
        field: "branch_code",
        label: "Chi nhánh",
        required: true,
        type: "text",
        aliases: ["chi nhanh", "branch", "branch code"],
      },
      {
        field: "balance_type",
        label: "Loại số dư",
        required: true,
        type: "text",
        aliases: ["loai so du", "balance type"],
      },
      {
        field: "object_code",
        label: "Mã đối tượng",
        required: false,
        type: "text",
        aliases: ["ma doi tuong", "object code"],
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
      { field: "amount", label: "Số tiền", required: true, type: "number", aliases: ["so tien", "amount"] },
      { field: "note", label: "Ghi chú", required: false, type: "text", aliases: ["ghi chu", "note"] },
    ],
  },
];

export function getImportTemplate(importType: ImportType, templateCode?: string) {
  return (
    importTemplates.find((template) => template.importType === importType && template.code === templateCode) ||
    importTemplates.find((template) => template.importType === importType)
  );
}

export function normalizeHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}
