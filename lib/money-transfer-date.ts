export type MoneyTransferDateRow = {
  transferDate: Date;
  actualTransferDate?: Date | null;
  transferPurpose?: string | null;
};

/**
 * NGÀY GHI SỔ của phiếu điều tiền.
 *
 * Phiếu NỘP TIỀN MẶT ghi theo `actualTransferDate` — ngày KẾ TOÁN ĐIỀN lúc duyệt: sổ quỹ nguồn
 * nộp trừ VÀ nguồn nhận cộng đúng ngày đó, kể cả khi một lô nhiều phiếu của nhiều ngày được điền
 * chung một ngày (khách chốt lại 21/10/2026: "10 phiếu các ngày khác nhau, kế toán điền 21/10 thì
 * cả 10 phiếu trừ / cộng ngày 21/10"). Phiếu chưa có ngày thực tế lấy ngày chứng từ. Các loại điều
 * tiền khác vẫn theo ngày chứng từ.
 *
 * Luật này đã đổi ba lần: 15/08 ngày thực tế (f0acd17) → 21/09 ngày chứng từ (39de6dd) → 21/10
 * quay lại ngày thực tế. Đổi nữa thì hỏi chốt trước.
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
