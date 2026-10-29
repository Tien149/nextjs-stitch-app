/**
 * Trạng thái rã nguyên liệu của một dòng doanh thu (RevenueImportRow.inventoryStatus) để hiện lên
 * Sổ doanh thu và màn Đối chiếu bán – rã (khách 29/10/2026: cột Rã BOM để "—" chung cho dòng chờ rã
 * lẫn dòng không rã nên không biết dòng nào chưa trừ kho). Dùng chung máy chủ + bảng.
 */
export type RevenueExplosionKind = "POSTED" | "PENDING" | "SKIPPED";

const COMBO_NOTE = /Món con combo (.*?) — không rã/;

export function revenueExplosionKind(inventoryStatus: string | null | undefined): RevenueExplosionKind {
  const status = String(inventoryStatus || "").toUpperCase();
  if (status.startsWith("POSTED")) return "POSTED";
  if (status === "PENDING") return "PENDING";
  return "SKIPPED";
}

/** Mã lần rã (RA-…) của dòng đã rã. */
export function revenueExplosionRun(inventoryStatus: string | null | undefined) {
  return String(inventoryStatus || "").replace(/^POSTED:?/i, "") || "Đã rã";
}

/** Vì sao dòng KHÔNG rã (inventoryStatus NOT_REQUIRED). */
export function revenueSkipReason(row: { note?: string | null; productCode?: string | null; productQuantity?: number | null }) {
  const combo = row.note?.match(COMBO_NOTE);
  if (combo) return `Món con combo ${combo[1]}`;
  if (!row.productCode) return "Không có mã món";
  if (!(Number(row.productQuantity) > 0)) return "Không có số lượng";
  return "Nhóm không theo dõi kho";
}
