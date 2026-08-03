/**
 * Ca làm việc dùng chung cho phiếu thu/chi, báo cáo Thu chi ngày và phiếu nộp tiền.
 * Khung giờ ở đây phải khớp với cách báo cáo cắt ngày (xem dayRange trong api/reports).
 */
export const WORK_SHIFTS = [
  { id: "MORNING", label: "Ca sáng", hint: "00:00 – 15:00" },
  { id: "EVENING", label: "Ca tối", hint: "15:00 – 24:00" },
  { id: "FULL", label: "Cả ngày", hint: "00:00 – 24:00" },
] as const;

export type WorkShift = (typeof WORK_SHIFTS)[number]["id"];

export const shiftLabels: Record<string, string> = Object.fromEntries(
  WORK_SHIFTS.map((shift) => [shift.id, shift.label]),
);

export function isWorkShift(value: unknown): value is WorkShift {
  return typeof value === "string" && WORK_SHIFTS.some((shift) => shift.id === value);
}

export function shiftLabel(value?: string | null) {
  if (!value) return "";
  return shiftLabels[value] || value;
}

/** Ca suy ra từ giờ lập phiếu, dùng cho phiếu cũ chưa có cột shift. */
export function shiftFromDate(date: Date) {
  return date.getHours() < 15 ? "MORNING" : "EVENING";
}

/**
 * Phiếu có thuộc ca đang xem hay không.
 * Phiếu ghi "Cả ngày" luôn được tính; phiếu chưa khai ca thì xét theo giờ.
 */
export function voucherMatchesShift(voucherShift: string | null | undefined, date: Date, viewShift: string) {
  if (viewShift === "FULL") return true;
  if (voucherShift === "FULL") return true;
  if (voucherShift) return voucherShift === viewShift;
  return shiftFromDate(date) === viewShift;
}
