export type BankStatementCategoryReference = {
  code?: string | null;
  name?: string | null;
};

function normalizeCategoryText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bankStatementSpecialCategory(category?: BankStatementCategoryReference | null) {
  const value = normalizeCategoryText(`${category?.code || ""} ${category?.name || ""}`);
  // "datcoc" bắt các mã kiểu THU_DATCOC: sau chuẩn hóa thành "thu datcoc" nên không tách
  // được "tien"/"coc" riêng lẻ, mà danh mục thì không phải lúc nào cũng có tên đầy đủ.
  if (
    value.includes("deposit")
    || value.includes("datcoc")
    || value.includes("dat coc")
    || (value.includes("tien") && value.includes("coc"))
  ) return "DEPOSIT";
  if (value.includes("cong no")) return "DEBT";
  if (value.includes("phan bo")) return "ALLOCATION";
  if (value.includes("tra truoc")) return "PREPAYMENT";
  return null;
}
