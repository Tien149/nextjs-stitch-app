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
    // "Hoàn cọc cho khách" / CHI_HOAN_COC không có chữ "tiền" nên vế dưới không bắt được;
    // thiếu nó thì chứng từ hoàn cọc mọc thành một dòng riêng trùng tên với dòng của sổ cọc.
    // Không bắt chữ "cọc" đứng một mình: nhà hàng có danh mục "cốc" (ly/cốc) sẽ dính nhầm.
    || value.includes("hoan coc")
    || value.includes("hoancoc")
    || (value.includes("tien") && value.includes("coc"))
  ) return "DEPOSIT";
  if (value.includes("cong no")) return "DEBT";
  if (value.includes("phan bo")) return "ALLOCATION";
  if (value.includes("tra truoc")) return "PREPAYMENT";
  return null;
}

/**
 * Danh mục cọc này là tiền RA (hoàn cọc) hay tiền VÀO (thu cọc)? Trả null nếu không phải
 * danh mục cọc. Hai chiều đi vào hai dòng khác nhau trên bảng thu/chi theo danh mục nên
 * không thể gộp chung một phép kiểm tra.
 */
export function depositCategoryDirection(category?: BankStatementCategoryReference | null) {
  if (bankStatementSpecialCategory(category) !== "DEPOSIT") return null;
  const value = normalizeCategoryText(`${category?.code || ""} ${category?.name || ""}`);
  return value.includes("hoan") || value.includes("refund") ? ("REFUND" as const) : ("RECEIPT" as const);
}
