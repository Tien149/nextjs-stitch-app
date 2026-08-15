export type MoneyTransferDateRow = {
  transferDate: Date;
  actualTransferDate?: Date | null;
  transferPurpose?: string | null;
};

/**
 * Phiếu nộp tiền mặt được ghi nhận theo ngày thực tế nộp tiền. Các loại điều
 * tiền khác vẫn dùng ngày phiếu. Dữ liệu cũ chưa có ngày thực tế được fallback
 * về ngày phiếu để không làm thay đổi báo cáo lịch sử.
 */
export function effectiveMoneyTransferDate(row: MoneyTransferDateRow) {
  return row.transferPurpose === "CASH_DEPOSIT"
    ? row.actualTransferDate ?? row.transferDate
    : row.transferDate;
}

export function effectiveMoneyTransferDateFilter(start: Date, end: Date) {
  return {
    OR: [
      { transferPurpose: "CASH_DEPOSIT", actualTransferDate: { gte: start, lt: end } },
      { transferPurpose: "CASH_DEPOSIT", actualTransferDate: null, transferDate: { gte: start, lt: end } },
      { transferPurpose: null, transferDate: { gte: start, lt: end } },
      { transferPurpose: { not: "CASH_DEPOSIT" }, transferDate: { gte: start, lt: end } },
    ],
  };
}
