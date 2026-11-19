/**
 * THỨ TỰ CHỐT GIẢI TRÌNH KIỂM KÊ (khách 19/11/2026).
 *
 * Luật khách: số đầu kỳ của đợt sau = số KIỂM KÊ của đợt trước (chênh lệch đợt trước đã vào CLKK
 * tháng đó). Hệ thống lấy đầu kỳ = tồn sổ tại giờ chốt − nhập + xuất trong kỳ, nên luật trên đúng
 * khi chênh lệch của đợt trước đã ghi vào sổ TRƯỚC lúc chốt đợt sau.
 *
 * Ca thật 18/11 kho ASA_KBEP: mở chốt T8 (KK-2026-0011) 18:16:22 → chốt T9 (KK-2026-0007) 18:16:59
 * → chốt lại T8 18:17:36. T9 chốt trên sổ CHƯA có chênh lệch T8 nên ghi lệch, T10 (KKT-2026-0050)
 * kéo theo: 374 mã có đầu kỳ ≠ số kiểm T9 (Bao Xốp 3Kg: kiểm T9 = 3, đầu kỳ T10 = −20).
 *
 * Từ đây: chỉ chốt được khi mọi đợt TRƯỚC của cùng kho đã chốt; chỉ mở chốt được khi mọi đợt SAU
 * đã mở chốt. Màn giải trình so đầu kỳ với số kiểm đợt trước và báo nếu lệch.
 */

type OrderRow = { sourceCode: string; periodTo: Date | string; status: string };
const time = (value: Date | string) => new Date(value).getTime();

/** Đợt trước chưa chốt (chặn Chốt) — `earlier` đã lọc bỏ bản mồ côi. */
export function lockBlockers(current: { periodTo: Date | string }, earlier: OrderRow[], lockedStatus: string) {
  return earlier
    .filter((row) => time(row.periodTo) < time(current.periodTo) && row.status !== lockedStatus)
    .sort((a, b) => time(a.periodTo) - time(b.periodTo))
    .map((row) => row.sourceCode);
}

/** Đợt sau còn đang chốt (chặn Mở chốt). */
export function unlockBlockers(current: { periodTo: Date | string }, later: OrderRow[], lockedStatus: string) {
  return later
    .filter((row) => time(row.periodTo) > time(current.periodTo) && row.status === lockedStatus)
    .sort((a, b) => time(b.periodTo) - time(a.periodTo))
    .map((row) => row.sourceCode);
}

type CountLine = { itemId: string; itemCode: string; itemName: string; opening: number; counted: number; notCounted?: boolean; countAsZero?: boolean };

/**
 * Mã có đầu kỳ ≠ số kiểm của đợt trước (mã không có ở đợt trước tính kiểm 0 — "không đếm là bằng 0").
 * Dòng "Không kiểm" của đợt trước không tính 0 thì bỏ qua (không có số kiểm để so).
 */
export function openingMismatches(previous: CountLine[], current: CountLine[], tolerance = 1e-6) {
  const prevById = new Map(previous.map((line) => [line.itemId, line]));
  const rows: Array<{ itemId: string; itemCode: string; itemName: string; opening: number; previousCounted: number }> = [];
  for (const line of current) {
    const prev = prevById.get(line.itemId);
    if (prev?.notCounted && !prev.countAsZero) continue;
    const previousCounted = prev ? prev.counted : 0;
    if (Math.abs(line.opening - previousCounted) > tolerance) {
      rows.push({ itemId: line.itemId, itemCode: line.itemCode, itemName: line.itemName, opening: line.opening, previousCounted });
    }
  }
  return rows;
}
