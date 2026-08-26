import { isSalesReceiptCategory } from "@/lib/voucher-rules";

/** Bucket theo hình thức thanh toán dùng chung cho báo cáo Thu chi ngày. */
export type DailyCashBucket = { total: number; cash: number; transfer: number; card: number; grab: number; other: number };
export type DailyCashBucketKey = keyof Omit<DailyCashBucket, "total">;

export type DailyCashReceiptRow = {
  branchCode: string;
  moneySourceCode: string;
  amount: number;
  categoryCode: string | null;
  depositAction: string | null;
  /** Nhóm hình thức thanh toán đã nối từ danh mục nguồn tiền của phiếu. */
  bucketKey: DailyCashBucketKey;
  /** Nguồn tiền của phiếu thuộc nhóm CASH theo danh mục. */
  isCashSource: boolean;
};

export function emptyDailyCashBucket(): DailyCashBucket {
  return { total: 0, cash: 0, transfer: 0, card: 0, grab: 0, other: 0 };
}

export type DailyCashSummaryRow = { label: string; bucket: DailyCashBucket; expense?: number; cashToDeposit?: number };

/**
 * Các dòng của bảng "Tổng hợp thu trong ngày".
 *
 * Dòng "Doanh thu bán hàng" chỉ gộp doanh thu POS/nhập tay với phiếu thu loại Thu bán hàng.
 * Các khoản thu khác (hoàn tiền NCC chi trùng, thu hoàn tạm ứng...) là tiền vào quỹ thật nhưng
 * không phải doanh thu nên đứng riêng dòng "Thu khác"; phần tiền mặt của cả hai đều vào số nộp.
 *
 * Payload cũ chưa có trường tách thì rơi về `receiptRevenue` như trước để màn hình không vỡ.
 */
export function buildDailyCashSummaryRows(summary: {
  revenue: DailyCashBucket;
  receipt: DailyCashBucket;
  receiptRevenue?: DailyCashBucket;
  receiptSalesRevenue?: DailyCashBucket;
  receiptOther?: DailyCashBucket;
  deposit: DailyCashBucket;
  cashExpenseTotal: number;
}): DailyCashSummaryRow[] {
  const salesReceipts = summary.receiptSalesRevenue || summary.receiptRevenue || summary.receipt;
  const otherReceipts = summary.receiptSalesRevenue ? summary.receiptOther : null;
  const revenueWithSalesReceipts: DailyCashBucket = {
    total: summary.revenue.total + salesReceipts.total,
    cash: summary.revenue.cash + salesReceipts.cash,
    transfer: summary.revenue.transfer + salesReceipts.transfer,
    card: summary.revenue.card + salesReceipts.card,
    grab: summary.revenue.grab + salesReceipts.grab,
    other: summary.revenue.other + salesReceipts.other,
  };
  const rows: DailyCashSummaryRow[] = [
    {
      label: "Doanh thu bán hàng",
      bucket: revenueWithSalesReceipts,
      expense: summary.cashExpenseTotal,
      cashToDeposit: revenueWithSalesReceipts.cash - summary.cashExpenseTotal,
    },
  ];
  // Ngày không có khoản thu ngoài bán hàng thì khỏi chiếm một dòng 0 đ.
  if (otherReceipts && Math.round(otherReceipts.total) !== 0) {
    rows.push({ label: "Thu khác (ngoài bán hàng)", bucket: otherReceipts, cashToDeposit: otherReceipts.cash });
  }
  // Đặt cọc không gánh chi tiền mặt nên số nộp đúng bằng phần tiền mặt của nó.
  rows.push({ label: "Đặt cọc", bucket: summary.deposit, cashToDeposit: summary.deposit.cash });
  return rows;
}

function addToBucket(bucket: DailyCashBucket, key: DailyCashBucketKey, amount: number) {
  bucket.total += amount;
  bucket[key] += amount;
}

/**
 * Tổng hợp phiếu thu cho báo cáo Thu chi ngày.
 *
 * Phiếu thu là dòng tiền độc lập, không mặc định là doanh thu bán hàng. Tách hai phần theo
 * Khoản mục thu để màn hình xếp đúng dòng:
 * - `receiptSales`: phiếu thu loại Thu bán hàng — thuộc dòng "Doanh thu bán hàng".
 * - `receiptOther`: các khoản thu còn lại (hoàn tiền NCC chi trùng, thu hoàn tạm ứng...) —
 *   thuộc dòng "Thu khác". Tiền mặt của phần này vẫn nằm trong quỹ thu ngân nên vẫn được
 *   cộng vào "Tiền mặt cần nộp", chỉ không được tính là doanh thu.
 * Khoản thu cọc (COLLECT/SUPPLEMENT) đã được tổng hợp từ bảng Deposit, cộng lại là đếm đôi.
 *
 * Khử trùng với POS: phiếu thu tiền mặt loại Thu bán hàng chính là chứng từ của khoản doanh
 * thu tiền mặt mà file POS đã ghi trong cùng ngày, không phải một khoản doanh thu thứ hai.
 * Cộng cả hai là đếm một khoản tiền hai lần và "Tiền mặt cần nộp" gấp đôi số thật. Phải xét
 * riêng TỪNG cửa hàng: chỉ cửa hàng nào có POS tiền mặt mới khử phiếu thu tiền mặt của chính
 * nó — khử theo tất cả cửa hàng thì NAM MÊ có POS sẽ kéo theo việc trừ luôn phiếu thu của ASA.
 * Chỉ phần Thu bán hàng mới bị khử; các khoản thu khác không có mặt trên file POS.
 */
export function summarizeDailyCashReceiptVouchers(rows: DailyCashReceiptRow[], branchesWithPosCash: ReadonlySet<string>) {
  const receipt = emptyDailyCashBucket();
  const receiptSales = emptyDailyCashBucket();
  const receiptOther = emptyDailyCashBucket();
  const cashBySource = new Map<string, number>();
  const addCash = (moneySourceCode: string, amount: number) => {
    cashBySource.set(moneySourceCode, (cashBySource.get(moneySourceCode) || 0) + amount);
  };
  const salesCashRows: Array<{ branchCode: string; moneySourceCode: string; amount: number }> = [];
  for (const row of rows) {
    if (["COLLECT", "SUPPLEMENT"].includes(row.depositAction || "")) continue;
    const isSales = isSalesReceiptCategory(row.categoryCode);
    addToBucket(receipt, row.bucketKey, row.amount);
    addToBucket(isSales ? receiptSales : receiptOther, row.bucketKey, row.amount);
    if (row.bucketKey === "cash") addCash(row.moneySourceCode, row.amount);
    if (isSales && row.isCashSource) {
      salesCashRows.push({ branchCode: row.branchCode, moneySourceCode: row.moneySourceCode, amount: row.amount });
    }
  }

  // Khử trùng cũng phải trừ đúng nguồn tiền của phiếu thu, không trừ vào một cục chung.
  let duplicatedCashReceipts = 0;
  for (const row of salesCashRows) {
    if (!branchesWithPosCash.has(row.branchCode)) continue;
    duplicatedCashReceipts += row.amount;
    addCash(row.moneySourceCode, -row.amount);
  }

  const receiptSalesRevenue: DailyCashBucket = {
    ...receiptSales,
    cash: receiptSales.cash - duplicatedCashReceipts,
    total: receiptSales.total - duplicatedCashReceipts,
  };
  const receiptRevenue: DailyCashBucket = {
    ...receipt,
    cash: receipt.cash - duplicatedCashReceipts,
    total: receipt.total - duplicatedCashReceipts,
  };
  return {
    receipt,
    receiptSales,
    receiptOther,
    receiptSalesRevenue,
    receiptRevenue,
    duplicatedCashReceipts,
    /** Phần tiền mặt (đã khử trùng) cộng vào "Tiền mặt cần nộp", tách theo từng quỹ. */
    cashToDepositBySource: [...cashBySource].map(([moneySourceCode, amount]) => ({ moneySourceCode, amount })),
  };
}
