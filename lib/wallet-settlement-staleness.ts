import { prisma } from "@/lib/prisma";

/**
 * Phiếu quyết toán ví đã "lạc hậu" so với doanh thu hiện tại.
 *
 * Phiếu quyết toán chỉ lưu KẾT QUẢ (số về ngân hàng + phí), không lưu CĂN CỨ (đã cộng những
 * dòng doanh thu nào). Gross của nó = doanh thu của ví tại đúng thời điểm chạy. Nên khi doanh
 * thu ngày đó được import lại với số khác, phiếu vẫn giữ số cũ và phần chênh nằm lại vĩnh viễn
 * dưới dạng "phí" — không có cảnh báo, không có cờ, không ai biết cho tới lúc khách hỏi.
 *
 * Ca thật (khách phát hiện, 15/09/2026): QTVI-2608-NME-00022 chạy 18/08 theo doanh thu
 * 1.811.556 đ; ngày 05/09 file doanh thu 02/08 được import lại còn 1.782.837 đ. Tiền về ngân
 * hàng đúng 1.782.837 đ, tức phí phải bằng 0, nhưng phiếu vẫn ghi phí 28.719 đ và số đó đã lên
 * P&L tháng 8.
 *
 * Hàm này chạy sau mỗi lần import doanh thu, đối chiếu lại và trả về danh sách để màn Import
 * báo ngay lúc người dùng còn đang mở file.
 */
export type StaleWalletSettlement = {
  code: string;
  branchCode: string;
  reportDate: string;
  walletCode: string;
  /** Gross phiếu đang giữ = số về ngân hàng + phí. */
  settledGross: number;
  /** Doanh thu của ví đó trong ngày đó, tính lại theo dữ liệu hiện tại. */
  currentRevenue: number;
  feeAmount: number;
};

const dayKey = (value: Date) => value.toISOString().slice(0, 10);

export async function findStaleWalletSettlements(
  revenueRows: Array<{ branchCode: string; saleDate: Date }>,
): Promise<StaleWalletSettlement[]> {
  if (revenueRows.length === 0) return [];
  const branches = [...new Set(revenueRows.map((row) => row.branchCode))];
  const days = [...new Set(revenueRows.map((row) => dayKey(row.saleDate)))];
  const times = revenueRows.map((row) => row.saleDate.getTime());
  const rangeStart = new Date(Math.min(...times));
  const rangeEnd = new Date(Math.max(...times) + 86_400_000);

  const settlements = await prisma.moneyTransfer.findMany({
    where: {
      transferPurpose: "WALLET_SETTLEMENT",
      status: "APPROVED",
      deletedAt: null,
      branchCode: { in: branches },
      sourceReportDate: { gte: rangeStart, lt: rangeEnd },
    },
    select: {
      code: true, branchCode: true, sourceReportDate: true,
      fromMoneySourceCode: true, amount: true, feeAmount: true,
    },
  });
  const affected = settlements.filter((row) => row.sourceReportDate && days.includes(dayKey(row.sourceReportDate)));
  if (affected.length === 0) return [];

  /**
   * Doanh thu của ví = tổng netAmount các dòng POS ghi đúng mã ví ở cột phương thức thanh toán.
   * Cố ý so khớp CHÍNH XÁC theo mã: đây là cảnh báo để người dùng vào xem lại, không phải căn
   * cứ ghi sổ, nên thà bỏ sót ví khai tên lệch còn hơn báo động nhầm hàng loạt.
   */
  const revenue = await prisma.revenueImportRow.groupBy({
    by: ["branchCode", "saleDate", "paymentMethod"],
    where: {
      deletedAt: null,
      branchCode: { in: branches },
      saleDate: { gte: rangeStart, lt: rangeEnd },
      paymentMethod: { in: [...new Set(affected.map((row) => row.fromMoneySourceCode))] },
    },
    _sum: { netAmount: true },
  });
  const revenueByKey = new Map(
    revenue.map((row) => [`${row.branchCode}|${dayKey(row.saleDate)}|${row.paymentMethod}`, row._sum.netAmount || 0]),
  );

  return affected
    .map((row) => {
      const reportDate = dayKey(row.sourceReportDate as Date);
      const currentRevenue = Math.round(
        revenueByKey.get(`${row.branchCode}|${reportDate}|${row.fromMoneySourceCode}`) || 0,
      );
      return {
        code: row.code,
        branchCode: row.branchCode,
        reportDate,
        walletCode: row.fromMoneySourceCode,
        settledGross: Math.round(row.amount + row.feeAmount),
        currentRevenue,
        feeAmount: Math.round(row.feeAmount),
      };
    })
    // Import lại y hệt số cũ thì phiếu vẫn đúng, không việc gì phải làm phiền người dùng.
    // Doanh thu về 0 nghĩa là ví này không khớp mã nào trong file — cũng không kết luận được.
    .filter((row) => row.currentRevenue > 0 && Math.abs(row.settledGross - row.currentRevenue) > 1);
}

/**
 * Phiếu quyết toán ví đã lập cho những ngày sắp bị xoá doanh thu.
 *
 * Khác `findStaleWalletSettlements` ở chỗ KHÔNG so số: khi xoá doanh thu một ngày thì doanh thu
 * của ví về 0, mà hàm kia cố ý bỏ qua trường hợp 0 (không kết luận được). Ở đây chỉ cần liệt kê
 * để màn Import nhắc người dùng xem lại phiếu sau khi nạp lại file ngày đó — phiếu vẫn giữ số
 * cũ trong khi căn cứ đã bị xoá.
 */
export async function findWalletSettlementsOnDays(
  revenueRows: Array<{ branchCode: string; saleDate: Date }>,
): Promise<Array<{ code: string; branchCode: string; reportDate: string; walletCode: string }>> {
  if (revenueRows.length === 0) return [];
  const branches = [...new Set(revenueRows.map((row) => row.branchCode))];
  const days = [...new Set(revenueRows.map((row) => dayKey(row.saleDate)))];
  const times = revenueRows.map((row) => row.saleDate.getTime());

  const settlements = await prisma.moneyTransfer.findMany({
    where: {
      transferPurpose: "WALLET_SETTLEMENT",
      status: "APPROVED",
      deletedAt: null,
      branchCode: { in: branches },
      sourceReportDate: { gte: new Date(Math.min(...times)), lt: new Date(Math.max(...times) + 86_400_000) },
    },
    select: { code: true, branchCode: true, sourceReportDate: true, fromMoneySourceCode: true },
  });

  return settlements
    .filter((row) => row.sourceReportDate && days.includes(dayKey(row.sourceReportDate)))
    .map((row) => ({
      code: row.code,
      branchCode: row.branchCode,
      reportDate: dayKey(row.sourceReportDate as Date),
      walletCode: row.fromMoneySourceCode,
    }));
}
