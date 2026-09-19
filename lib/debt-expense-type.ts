/**
 * Cột "Loại phát sinh" của file import công nợ phải trả.
 *
 * Công nợ phải trả có hai bản chất hoàn toàn khác nhau mà file của khách trước giờ không phân
 * biệt được: SỐ DƯ ĐẦU KỲ (chi phí đã phát sinh từ kỳ trước, mang sang để theo dõi trả nợ) và
 * CHI PHÍ PHÁT SINH TRONG KỲ (phải ghi Nợ 632/6428 ngay, dù chưa trả tiền). Hệ thống cũ mặc
 * định mọi khoản import là số dư đầu kỳ nên khách đổ công nợ hàng tháng bằng file thì chi phí
 * không bao giờ lên P&L (khách báo 19/09/2026).
 *
 * Bỏ trống vẫn là số dư đầu kỳ để file cũ import lại không đổi số. Khai chữ lạ thì báo lỗi ngay
 * ở bước xem trước, không đoán — đoán sai một chữ là lệch cả dòng chi phí trên P&L.
 */

export type DebtExpenseType = "INCURRED" | "OPENING";

/** Bỏ dấu, viết hoa, gộp khoảng trắng — để "Phát sinh" và "PHAT_SINH" là một. */
function normalize(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/Đ/g, "D")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

const INCURRED_WORDS = new Set([
  "PHAT SINH",
  "PHAT SINH TRONG KY",
  "CHI PHI",
  "CHI PHI TRONG KY",
  "GHI CHI PHI",
  "X",
  "1",
  "CO",
  "TRUE",
  "YES",
  "INCURRED",
]);

const OPENING_WORDS = new Set([
  "DAU KY",
  "SO DU DAU KY",
  "SO DU",
  "MANG SANG",
  "0",
  "KHONG",
  "FALSE",
  "NO",
  "OPENING",
]);

/**
 * Đọc cột "Loại phát sinh". Trống = số dư đầu kỳ (mặc định cũ); chữ không nhận ra trả null để
 * bên gọi báo lỗi.
 */
export function parseDebtExpenseType(value: unknown): DebtExpenseType | null {
  const text = normalize(value);
  if (!text) return "OPENING";
  if (INCURRED_WORDS.has(text)) return "INCURRED";
  if (OPENING_WORDS.has(text)) return "OPENING";
  return null;
}

/** Câu báo lỗi dùng chung cho preview import và API. */
export const DEBT_EXPENSE_TYPE_ERROR =
  'Cột "Loại phát sinh" chỉ nhận "Phát sinh" (chi phí trong kỳ, lên P&L) hoặc "Đầu kỳ" (số dư mang sang, không lên P&L). Bỏ trống được hiểu là Đầu kỳ.';
