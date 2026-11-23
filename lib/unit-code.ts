/**
 * Mã ĐVT chuẩn hoá (khách 23/11/2026): người gõ "thùng", người gõ "THUNG", người gõ "Thung 24" là
 * ba ĐVT khác nhau trong danh mục. Quy về một mã: bỏ dấu, đ -> D, viết hoa, bỏ khoảng trắng.
 * File thuần (không import gì) để dùng được cả ở trình duyệt lẫn máy chủ.
 */
export function normalizeUnitCode(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/\s+/g, "");
}
