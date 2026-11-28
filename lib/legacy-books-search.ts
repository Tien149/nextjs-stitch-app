/**
 * Chuẩn hoá chữ để tìm trong "Sổ sách kế toán trước 08/2026" — dùng chung máy chủ (dựng
 * searchText lúc nạp file, tách từ khoá lúc tìm) và trình duyệt (tô màu chữ tìm thấy).
 *
 * - Bỏ dấu tiếng Việt, đ → d, chữ thường: gõ "chi phi" vẫn ra "Chi phí".
 * - Số tiền: ô "1.500.000" / "1,500,000" / "1500000" đều lưu thêm bản chỉ có chữ số, từ khoá
 *   dạng số cũng quy về chữ số → gõ kiểu nào cũng ra.
 */

export function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Ô trông như số tiền (chữ số + dấu chấm/phẩy/cách, có thể kèm đ/vnd, âm hoặc ngoặc) → chỉ chữ số. */
export function numericDigits(value: string) {
  const text = value.trim();
  if (!/^[-+(]?\s*\d[\d.,\s]*\)?\s*(đ|d|vnd)?$/i.test(text)) return "";
  const digits = text.replace(/\D/g, "");
  return digits.length >= 4 ? digits : "";
}

/** Chuỗi tìm kiếm của một dòng: các ô đã chuẩn hoá + bản chỉ-chữ-số của các ô số. */
export function rowSearchText(cells: string[]) {
  const words = cells.map((cell) => normalizeSearch(cell)).filter(Boolean);
  const numbers = cells.map(numericDigits).filter(Boolean);
  return [words.join(" | "), numbers.join(" ")].filter(Boolean).join(" || ");
}

/**
 * Tách ô tìm kiếm thành các từ khoá (dòng phải chứa ĐỦ mọi từ khoá). Cụm trong ngoặc kép là một từ
 * khoá. Từ khoá dạng số ("1.500.000") quy về chữ số.
 */
export function searchTerms(query: string) {
  const terms: string[] = [];
  const pattern = /"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query))) {
    const raw = (match[1] ?? match[2] ?? "").trim();
    if (!raw) continue;
    const digits = /^[\d.,]+$/.test(raw) ? raw.replace(/\D/g, "") : "";
    const term = digits.length >= 4 ? digits : normalizeSearch(raw);
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 8);
}

/** Ô này có chứa từ khoá không (để tô màu trên bảng). */
export function cellMatches(cell: string, terms: string[]) {
  if (!cell || terms.length === 0) return false;
  const normalized = normalizeSearch(cell);
  const digits = numericDigits(cell);
  return terms.some((term) => normalized.includes(term) || (digits && /^\d+$/.test(term) && digits.includes(term)));
}
