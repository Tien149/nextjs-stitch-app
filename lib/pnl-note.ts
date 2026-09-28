import { prisma } from "@/lib/prisma";

/**
 * Ghi chú nhận định trên chart "Biến động Doanh thu – Chi phí – Lợi nhuận – EBITDA" của
 * Dashboard P&L (khách 28/09/2026, học theo slide "LỢI NHUẬN VẬN HÀNH"): mỗi tháng x cửa hàng
 * (kể cả ALL) một đoạn văn.
 *
 * Lưu vào ForecastAssumption dưới một scenario riêng thay vì mở bảng mới: bảng đó đã có đúng
 * khoá kỳ + cửa hàng + cột note, và mọi nơi đọc giả định dòng tiền đều lọc theo scenario
 * (BASE/…), nên dòng PNL_NOTE không lọt vào dự báo. amount luôn 0.
 */
export const PNL_NOTE_SCENARIO = "PNL_NOTE";
const PNL_NOTE_TYPE = "DASHBOARD";

export type PnlNote = { period: string; note: string; updatedBy: string | null; updatedAt: string };

export async function getPnlNotes(year: string, branchCode: string): Promise<PnlNote[]> {
  const rows = await prisma.forecastAssumption.findMany({
    where: { scenario: PNL_NOTE_SCENARIO, assumptionType: PNL_NOTE_TYPE, branchCode, period: { startsWith: `${year}-` } },
    select: { period: true, note: true, createdBy: true, updatedAt: true },
    orderBy: { period: "asc" },
  });
  return rows
    .filter((row) => row.note)
    .map((row) => ({ period: row.period, note: row.note || "", updatedBy: row.createdBy, updatedAt: row.updatedAt.toISOString() }));
}

/** Ghi đè ghi chú của một tháng; để trống là xoá hẳn. */
export async function savePnlNote(period: string, branchCode: string, note: string, userName: string) {
  const key = { period, branchCode, scenario: PNL_NOTE_SCENARIO, assumptionType: PNL_NOTE_TYPE };
  if (!note) {
    await prisma.forecastAssumption.deleteMany({ where: key });
    return null;
  }
  return prisma.forecastAssumption.upsert({
    where: { period_branchCode_scenario_assumptionType: key },
    create: { ...key, amount: 0, note, createdBy: userName },
    update: { note, createdBy: userName },
  });
}
