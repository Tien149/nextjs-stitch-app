/**
 * Số kỳ phân bổ / khấu hao: số thực, giữ 2 chữ số thập phân (khách yêu cầu 03/10/2026 — số dư
 * đầu kỳ có khoản phân bổ dở với số kỳ lẻ, làm tròn về số nguyên thì số mỗi kỳ chuyển qua sai).
 * Không hợp lệ / âm → 0.
 */
export function roundPeriodCount(value: unknown): number {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 100) / 100;
}

/** Hiển thị số kỳ kiểu Việt: 2,5 / 10,37 / 12 (không đuôi ",00"). */
export function formatPeriodCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "?";
  return Number(value).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}
