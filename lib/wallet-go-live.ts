import { prisma } from "@/lib/prisma";

/**
 * Ngày cửa hàng lên hệ thống = ngày đầu của kỳ số dư đầu kỳ SỚM NHẤT của cửa hàng đó.
 *
 * Luật chung của ví (chốt 26/09/2026, ca QTVI-2608-NME-00090): phí quyết toán ví ghi theo NGÀY
 * DOANH THU, nên tiền về đầu tháng 8 cho doanh thu 31/07 đẩy phí sang tháng 7 — kỳ mà hệ thống
 * không có doanh thu nào của cửa hàng. Momo đã không ra phí (số thu ngân khai của ví thẻ chung
 * cho nhiều ví, không suy được gross) còn Grab thì ra — một ví có chi phí, ví kia không, và chi
 * phí đó không có doanh thu đi kèm. Ngày doanh thu trước ngày lên hệ thống: phí ví = 0, gross =
 * tiền thực về, cho MỌI ví.
 *
 * Trả về khoá ngày "YYYY-MM-DD" (so sánh chuỗi được với vietnamBusinessDayKey); null nếu cửa
 * hàng chưa khai số dư đầu kỳ nào — khi đó không chặn gì.
 */
export async function branchGoLiveDays(branchCodes: string[]): Promise<Map<string, string>> {
  const codes = [...new Set(branchCodes.filter(Boolean))];
  if (codes.length === 0) return new Map();
  const rows = await prisma.openingBalance.groupBy({
    by: ["branchCode"],
    where: { branchCode: { in: codes }, status: { in: ["POSTED", "CONFIRMED"] } },
    _min: { period: true },
  });
  return new Map(rows
    .filter((row) => row._min.period && /^\d{4}-\d{2}$/.test(row._min.period))
    .map((row) => [row.branchCode, `${row._min.period}-01`]));
}

export async function branchGoLiveDay(branchCode: string) {
  return (await branchGoLiveDays([branchCode])).get(branchCode) ?? null;
}

/** Ngày doanh thu `day` ("YYYY-MM-DD") nằm trước ngày lên hệ thống của cửa hàng. */
export function isBeforeGoLive(day: string, goLiveDay: string | null | undefined) {
  return Boolean(goLiveDay) && day < (goLiveDay as string);
}
