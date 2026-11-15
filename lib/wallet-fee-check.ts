/**
 * Bảng kiểm phí ví đã ghi sổ (khách 15/11/2026: "tại sao các con số luôn không khớp").
 *
 * Phí ví thật của một ngày = doanh thu POS của ví − tiền thật đã về cho đúng ngày doanh thu đó —
 * cùng công thức thẻ "Chi phí quẹt thẻ / Chi phí bán hàng Grab" của tab Tiền về đủ chưa. Phí
 * trên P&L lại là số đã chốt trên từng phiếu QTVI (bút toán MONEY_TRANSFER_FEE theo ngày doanh
 * thu), nên doanh thu nạp lại / sao kê tách ngày / nạp trùng làm hai bên lệch mà không ai biết
 * cho tới khi soi P&L. Bảng này liệt kê ngay những ngày × ví lệch để bấm Chạy lại đúng phiếu.
 *
 * Phần thuần để kiểm thử và để client dùng chung kiểu dữ liệu.
 */

/** Lệch dưới ngưỡng này là làm tròn khi chia phí cho nhiều phiếu — không báo. */
export const WALLET_FEE_CHECK_TOLERANCE = 1000;

export type WalletFeeCell = {
  date: string;
  moneySourceCode: string;
  moneySourceName: string;
  branchCode: string;
  group: string;
  revenue: number;
  received: number;
  /** Doanh thu − tiền về − phần đã đưa vào chi phí ngay trên bảng Tiền về đủ chưa. */
  remaining: number;
};

export type BookedWalletFee = { date: string; moneySourceCode: string; amount: number; voucherCode: string };

export type WalletFeeCheckRow = {
  date: string;
  moneySourceCode: string;
  moneySourceName: string;
  branchCode: string;
  revenue: number;
  received: number;
  expectedFee: number;
  bookedFee: number;
  /** Đã ghi sổ − phí đúng: dương là P&L đang cao hơn. */
  gap: number;
  voucherCodes: string[];
};

/**
 * Phí đúng của một ô: chỉ ví ĐÃ có tiền về mà còn thiếu mới là phí. Ví chưa về đồng nào là tiền
 * đang trên đường (chưa có phiếu QTVI để ghi phí), về dư thì không có phí.
 */
export function expectedWalletFee(cell: Pick<WalletFeeCell, "group" | "received" | "remaining">) {
  if (cell.group !== "WALLET") return 0;
  if (!(cell.received > 0) || !(cell.remaining > 0)) return 0;
  return Math.round(cell.remaining);
}

export function buildWalletFeeCheck(input: {
  cells: WalletFeeCell[];
  booked: BookedWalletFee[];
  /** Tên / cửa hàng của ví có phí ghi sổ mà bảng không có ô (ngày không doanh thu, không tiền về). */
  sourceOf: (code: string) => { name: string; branchCode: string } | null;
  /** Mã phiếu QTVI đã nối với tiền về của từng ngày × ví (để chỉ đúng phiếu cần chạy lại). */
  vouchersOf?: (date: string, moneySourceCode: string) => string[];
}) {
  const key = (date: string, code: string) => `${date}|${code}`;
  const bookedByKey = new Map<string, { amount: number; codes: Set<string> }>();
  for (const row of input.booked) {
    const current = bookedByKey.get(key(row.date, row.moneySourceCode)) || { amount: 0, codes: new Set<string>() };
    current.amount += row.amount;
    if (row.voucherCode) current.codes.add(row.voucherCode);
    bookedByKey.set(key(row.date, row.moneySourceCode), current);
  }

  const walletCells = input.cells.filter((cell) => cell.group === "WALLET");
  const seen = new Set<string>();
  const all: WalletFeeCheckRow[] = [];
  const push = (base: Omit<WalletFeeCheckRow, "gap" | "voucherCodes" | "bookedFee">) => {
    const booked = bookedByKey.get(key(base.date, base.moneySourceCode));
    const bookedFee = Math.round(booked?.amount || 0);
    const codes = new Set<string>(booked?.codes || []);
    for (const code of input.vouchersOf?.(base.date, base.moneySourceCode) || []) codes.add(code);
    all.push({ ...base, bookedFee, gap: bookedFee - base.expectedFee, voucherCodes: [...codes].sort() });
  };
  for (const cell of walletCells) {
    seen.add(key(cell.date, cell.moneySourceCode));
    push({
      date: cell.date,
      moneySourceCode: cell.moneySourceCode,
      moneySourceName: cell.moneySourceName,
      branchCode: cell.branchCode,
      revenue: Math.round(cell.revenue),
      received: Math.round(cell.received),
      expectedFee: expectedWalletFee(cell),
    });
  }
  // Phí ghi sổ vào ngày × ví mà bảng không có ô nào: phí không có doanh thu đi kèm, sai trọn.
  for (const [cellKey, booked] of bookedByKey) {
    if (seen.has(cellKey) || Math.abs(booked.amount) < 0.5) continue;
    const [date, code] = cellKey.split("|");
    const source = input.sourceOf(code);
    push({ date, moneySourceCode: code, moneySourceName: source?.name || code, branchCode: source?.branchCode || "", revenue: 0, received: 0, expectedFee: 0 });
  }

  const rows = all
    .filter((row) => Math.abs(row.gap) >= WALLET_FEE_CHECK_TOLERANCE)
    .sort((a, b) => a.date.localeCompare(b.date) || a.moneySourceName.localeCompare(b.moneySourceName, "vi"));
  return {
    rows,
    expectedTotal: all.reduce((sum, row) => sum + row.expectedFee, 0),
    bookedTotal: all.reduce((sum, row) => sum + row.bookedFee, 0),
    checkedCells: all.length,
  };
}

export type WalletFeeCheck = ReturnType<typeof buildWalletFeeCheck>;
