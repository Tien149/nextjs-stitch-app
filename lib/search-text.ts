/**
 * Tìm kiếm "dễ tính" cho ô tìm theo mã/tên: không phân biệt hoa thường, bỏ dấu tiếng Việt
 * (đ → d), và gõ nhiều từ thì chỉ cần mỗi từ xuất hiện đâu đó, không cần đúng thứ tự.
 * "cay lau" hay "lau nhà" đều ra "Cây Lau Nhà"; dán mã có khoảng trắng thừa cũng vẫn khớp.
 */
export function normalizeSearchText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(query: unknown) {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(" ") : [];
}

/** true khi mọi từ trong `query` đều nằm trong ít nhất một trường của `fields`. Query rỗng = khớp hết. */
export function matchesSearch(query: unknown, fields: unknown[]) {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return true;
  const haystack = fields.map(normalizeSearchText).join(" ");
  return tokens.every((token) => haystack.includes(token));
}
