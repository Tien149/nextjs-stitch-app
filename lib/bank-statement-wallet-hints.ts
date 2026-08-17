/**
 * Đọc thông tin quyết toán ví nằm sẵn trong diễn giải sao kê.
 *
 * Ngân hàng in đủ dữ kiện cho một đợt quyết toán ví, ví dụ:
 *   "So GD goc: 10011820 MoMo TT ASA BISTRO tu 06/08/2026 den 06/08/2026.
 *    CT tu 0421000497559 CONG TY CP DICH VU DI DONG TRUC TUYEN toi 102884098304 HKD ASA BISTRO"
 *
 * Trong đó `tu ... den ...` là Ngày doanh thu và `toi <số tài khoản>` là tài khoản nhận tiền.
 * Nhờ vậy người dùng không phải đọc diễn giải rồi gõ tay sang cột khác.
 */

export type WalletHintSource = {
  code: string;
  name: string;
  group?: string | null;
  status: string;
  branch: string | null;
  settlementBankCode?: string | null;
};

function normalize(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Từ khoá cho biết dòng sao kê là tiền ví/cổng thanh toán đổ về. */
const walletKeywords = ["momo", "grab", "vnpay", "shopee", "zalopay", "payoo", "visa", "master"];

export function walletKeywordsInText(value: unknown) {
  const text = normalize(value);
  return walletKeywords.filter((keyword) => text.includes(keyword));
}

/**
 * Ngày doanh thu của đợt quyết toán, đọc từ đoạn "tu dd/mm/yyyy den dd/mm/yyyy".
 * Trả về ngày bắt đầu và ngày kết thúc; hai ngày bằng nhau nghĩa là quyết toán đúng một ngày.
 */
export function parseSettlementRevenueRange(description: unknown) {
  const text = String(description || "");
  const match = /\btu\s+(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+den\s+(\d{1,2})[/-](\d{1,2})[/-](\d{4}))?/i.exec(text);
  if (!match) return null;

  const toUtc = (day: string, month: string, year: string) => {
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const valid = date.getUTCFullYear() === Number(year)
      && date.getUTCMonth() === Number(month) - 1
      && date.getUTCDate() === Number(day);
    return valid ? date : null;
  };

  const from = toUtc(match[1], match[2], match[3]);
  if (!from) return null;
  const to = match[4] ? toUtc(match[4], match[5], match[6]) : from;
  return { from, to: to || from };
}

/**
 * Suy ra nguồn ví của dòng sao kê.
 *
 * Chỉ nhận khi kết quả là DUY NHẤT. Diễn giải một mình không đủ: "MoMo TT SAI GON KITCHEN"
 * không chứa mã ví KCF nào, nên phải dựa vào tài khoản ngân hàng nhận tiền — mỗi ví đã khai
 * "Ngân hàng quyết toán về" ở danh mục Nguồn tiền. Chưa khai thì không đoán bừa.
 */
export function resolveWalletFromDescription(input: {
  description: unknown;
  bankSourceCode: string;
  branchCode?: string | null;
  walletSources: WalletHintSource[];
}) {
  const keywords = walletKeywordsInText(input.description);
  if (keywords.length === 0 || !input.bankSourceCode) return null;

  const branch = String(input.branchCode || "").trim().toUpperCase();
  const linked = input.walletSources.filter((source) => source.status === "ACTIVE"
    && source.settlementBankCode === input.bankSourceCode
    && (!branch || !source.branch || source.branch.toUpperCase() === branch));
  if (linked.length === 0) return null;
  if (linked.length === 1) return linked[0];

  // Nhiều ví cùng đổ về một tài khoản thì lấy từ khoá trong diễn giải để tách.
  const matched = linked.filter((source) => {
    const label = normalize(`${source.code} ${source.name}`);
    return keywords.some((keyword) => label.includes(keyword));
  });
  return matched.length === 1 ? matched[0] : null;
}
