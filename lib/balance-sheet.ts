/**
 * Bảng cân đối kế toán & số dư đầu kỳ nguồn vốn (khách yêu cầu 04/10/2026).
 *
 * Trước đây mọi dòng số dư đầu kỳ ghi đối ứng thẳng vào 411: tài sản Nợ tài sản / Có 411, nợ
 * phải trả Nợ 411 / Có 331. 411 vì thế là con số TỰ CÂN (tài sản − nợ) gộp cả vốn góp, lợi nhuận
 * các năm trước khi lên hệ thống, khoản vay chưa khai... chứ không phải vốn góp thật; còn bảng
 * cân đối liệt kê lẫn cả 511/711/632/642 nên nhìn như doanh thu chi phí "treo" chưa kết chuyển.
 *
 * Nay:
 * - Đối ứng của số dư đầu kỳ là 4199 "Chênh lệch số dư đầu kỳ chưa phân loại". Khai đủ nguồn vốn
 *   (vốn góp 411, lợi nhuận chưa phân phối 421, vay 341) thì 4199 về 0; còn số là phần chưa khai.
 * - Bảng cân đối chỉ gồm Tài sản / Nợ phải trả / Vốn chủ sở hữu. Doanh thu – chi phí không kết
 *   chuyển bằng bút toán (không có 911): khi lập bảng, lợi nhuận lũy kế tự cộng vào dòng 421 =
 *   số đầu kỳ + lợi nhuận các năm trước + lợi nhuận năm nay.
 *
 * Phần thuần (không kéo prisma) để kiểm thử.
 */
export const CONTRIBUTED_CAPITAL_ACCOUNT = "411";
export const RETAINED_EARNINGS_ACCOUNT = "421";
export const OPENING_DIFFERENCE_ACCOUNT = "4199";
export const LOAN_ACCOUNT = "341";

/** Loại số dư đầu kỳ thuộc nguồn vốn — không sinh nghiệp vụ phụ (kho, tài sản, phân bổ). */
export const EQUITY_OPENING_TYPES = ["EQUITY_CAPITAL", "RETAINED_EARNINGS", "LOAN"] as const;

export function isEquityOpeningType(balanceType: string | null | undefined) {
  return (EQUITY_OPENING_TYPES as readonly string[]).includes((balanceType || "").toUpperCase());
}

/** Lợi nhuận chưa phân phối được ghi số âm (lỗ lũy kế); các loại khác phải dương. */
export function openingAmountAllowsNegative(balanceType: string | null | undefined) {
  return (balanceType || "").toUpperCase() === "RETAINED_EARNINGS";
}

type JournalLine = { accountCode: string; debit?: number; credit?: number; partnerCode?: string | null };

/** Bút toán của số dư đầu kỳ nguồn vốn: Nợ 4199 / Có tài khoản nguồn vốn (lỗ lũy kế thì ngược lại). */
export function equityOpeningJournalLines(row: { balanceType: string; amount: number; objectCode?: string | null }): JournalLine[] {
  const type = row.balanceType.toUpperCase();
  const account = type === "EQUITY_CAPITAL" ? CONTRIBUTED_CAPITAL_ACCOUNT
    : type === "RETAINED_EARNINGS" ? RETAINED_EARNINGS_ACCOUNT
    : type === "LOAN" ? LOAN_ACCOUNT
    : null;
  if (!account || !row.amount) return [];
  const amount = Math.abs(row.amount);
  const partnerCode = type === "LOAN" ? row.objectCode || null : null;
  return row.amount > 0
    ? [{ accountCode: OPENING_DIFFERENCE_ACCOUNT, debit: amount }, { accountCode: account, credit: amount, partnerCode }]
    : [{ accountCode: account, debit: amount, partnerCode }, { accountCode: OPENING_DIFFERENCE_ACCOUNT, credit: amount }];
}

const PROFIT_ACCOUNT_TYPES = new Set(["REVENUE", "OTHER_INCOME", "COGS", "OPEX", "OTHER_EXPENSE"]);
const SECTION_OF: Record<string, BalanceSection> = { ASSET: "ASSET", LIABILITY: "LIABILITY", EQUITY: "EQUITY" };

export type BalanceSection = "ASSET" | "LIABILITY" | "EQUITY";

/** Số cộng dồn của một tài khoản tới cuối kỳ, kèm phần phát sinh trước ngày đầu năm của kỳ. */
export type BalanceAccountTotal = {
  code: string;
  name: string;
  accountType: string;
  reportGroup: string;
  normalBalance: string;
  debit: number;
  credit: number;
  debitBeforeYear: number;
  creditBeforeYear: number;
};

export type BalanceSheetRow = {
  code: string;
  name: string;
  accountType: string;
  reportGroup: string;
  section: BalanceSection;
  /** Số mang dấu trên bảng: hao mòn lũy kế (214) là số âm trong khối tài sản. */
  amount: number;
  detail?: Array<{ label: string; amount: number }>;
  warning?: string;
};

export function buildBalanceSheet(totals: BalanceAccountTotal[], year: string) {
  let profitPriorYears = 0;
  let profitCurrentYear = 0;
  let retainedOpening = 0;
  const rows: BalanceSheetRow[] = [];
  for (const account of totals) {
    if (PROFIT_ACCOUNT_TYPES.has(account.accountType)) {
      const prior = account.creditBeforeYear - account.debitBeforeYear;
      profitPriorYears += prior;
      profitCurrentYear += account.credit - account.debit - prior;
      continue;
    }
    const section = SECTION_OF[account.accountType];
    if (!section) continue;
    const natural = account.normalBalance === "DEBIT" ? account.debit - account.credit : account.credit - account.debit;
    if (account.code === RETAINED_EARNINGS_ACCOUNT) {
      retainedOpening += natural;
      continue;
    }
    // Hao mòn lũy kế nằm trong khối tài sản nhưng có số dư bên Có: hiện số âm cho cộng thẳng.
    const amount = section === "ASSET" && account.normalBalance === "CREDIT" ? -natural : natural;
    if (Math.abs(amount) <= 0.5) continue;
    rows.push({
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      reportGroup: account.reportGroup,
      section,
      amount,
      ...(account.code === OPENING_DIFFERENCE_ACCOUNT
        ? { warning: "Số dư đầu kỳ chưa khai đủ nguồn vốn: khai Vốn góp / Lợi nhuận chưa phân phối / Vay ở màn Số dư đầu kỳ cho tới khi dòng này về 0." }
        : {}),
    });
  }
  const retainedEarnings = retainedOpening + profitPriorYears + profitCurrentYear;
  if (Math.abs(retainedOpening) > 0.5 || Math.abs(profitPriorYears) > 0.5 || Math.abs(profitCurrentYear) > 0.5) {
    rows.push({
      code: RETAINED_EARNINGS_ACCOUNT,
      name: "Lợi nhuận sau thuế chưa phân phối",
      accountType: "EQUITY",
      reportGroup: "RETAINED_EARNINGS",
      section: "EQUITY",
      amount: retainedEarnings,
      detail: [
        { label: "Số dư đầu kỳ khai", amount: retainedOpening },
        { label: `Lợi nhuận trước năm ${year}`, amount: profitPriorYears },
        { label: `Lợi nhuận năm ${year} (lũy kế tới kỳ)`, amount: profitCurrentYear },
      ],
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const sum = (section: BalanceSection) => rows.filter((row) => row.section === section).reduce((total, row) => total + row.amount, 0);
  const assets = sum("ASSET");
  const liabilities = sum("LIABILITY");
  const equity = sum("EQUITY");
  const openingDifference = rows.find((row) => row.code === OPENING_DIFFERENCE_ACCOUNT)?.amount || 0;
  return {
    rows,
    assets,
    liabilities,
    equity,
    /** Vốn góp và nguồn vốn khác, không gồm 421 và chênh lệch đầu kỳ. */
    contributedEquity: equity - retainedEarnings - openingDifference,
    retainedEarnings,
    retainedOpening,
    profitPriorYears,
    profitCurrentYear,
    openingDifference,
    difference: assets - liabilities - equity,
    balanced: Math.abs(assets - liabilities - equity) <= 1,
  };
}

/** Loại số dư đầu kỳ nằm bên NGUỒN VỐN (Có): nợ phải trả, tiền cọc khách, vốn chủ sở hữu, vay. */
const OPENING_CREDIT_SIDE_TYPES = new Set(["AP", "DEPOSIT", ...EQUITY_OPENING_TYPES]);

/**
 * Số dư 4199 mà các dòng số dư đầu kỳ sẽ để lại: tài sản − nợ − nguồn vốn đã khai. Khác 0 nghĩa
 * là bảng cân đối còn một dòng "Chênh lệch số dư đầu kỳ chưa phân loại" — màn Số dư đầu kỳ hiện
 * để kế toán khai tiếp Vốn góp / Lợi nhuận chưa phân phối / Vay cho tới khi về 0.
 */
export function openingDifferenceOf(rows: Array<{ balanceType: string; amount: number }>) {
  return rows.reduce((total, row) => total + (OPENING_CREDIT_SIDE_TYPES.has(row.balanceType.toUpperCase()) ? -row.amount : row.amount), 0);
}
