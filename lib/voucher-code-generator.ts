/**
 * Voucher Code Generator Utility
 * Standard Format: [Mã Phiếu (4 ký tự)]-[NămTháng YYMM (4 ký tự)]-[Cửa hàng (3 ký tự)]-[STT (5 ký tự)]
 * Example: PTHU-2607-ASA-00001
 */

export interface VoucherCodeOptions {
  voucherType: string; // RECEIPT | PAYMENT | DEPOSIT | ADJUSTMENT | ACCRUAL | string
  documentChannel?: string | null; // CASH | BANK
  voucherDate?: Date | string | null;
  branchCode?: string | null;
  seqNumber: number;
}

/**
 * Normalizes 4-character Voucher Type prefix
 */
export function formatVoucherPrefix(voucherType: string, documentChannel?: string | null): string {
  const typeUpper = (voucherType || "").trim().toUpperCase();
  if ((documentChannel || "").trim().toUpperCase() === "BANK") {
    if (["RECEIPT", "PT", "PTHU", "UNT"].includes(typeUpper)) return "UNT";
    if (["PAYMENT", "PC", "PCHI", "UNC"].includes(typeUpper)) return "UNC";
  }
  switch (typeUpper) {
    case "RECEIPT":
    case "PT":
    case "PTHU":
      return "PTHU";
    case "PAYMENT":
    case "PC":
    case "PCHI":
      return "PCHI";
    case "DEPOSIT":
    case "COC":
    case "PCOC":
      return "PCOC";
    case "ADJUSTMENT":
    case "DCQ":
    case "DCQ1":
      return "DCQ1";
    case "ACCRUAL":
    case "PB":
    case "PBOU":
      return "PBOU";
    default:
      if (typeUpper.length >= 4) return typeUpper.slice(0, 4);
      return typeUpper.padEnd(4, "X");
  }
}

/**
 * Formats date into 4-character YYMM string (e.g. July 2026 -> 2607)
 */
export function formatYearMonth(dateInput?: Date | string | null): string {
  const d = dateInput ? new Date(dateInput) : new Date();
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const yy = String(validDate.getFullYear()).slice(-2);
  const mm = String(validDate.getMonth() + 1).padStart(2, "0");
  return `${yy}${mm}`;
}

/**
 * Normalizes Branch/Store code to 3 uppercase characters (e.g. ASA, HCM, STO)
 */
export function formatBranchCode3(branchCode?: string | null): string {
  const clean = (branchCode || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!clean || clean === "ALL") return "ALL";
  if (clean.length === 3) return clean;
  if (clean.length > 3) return clean.slice(0, 3);
  return clean.padEnd(3, "0");
}

/**
 * Formats 5-digit sequential number padded with leading zeros (e.g. 1 -> 00001)
 */
export function formatSeq5(seqNumber: number): string {
  const num = Math.max(1, Math.floor(seqNumber || 1));
  return String(num).padStart(5, "0");
}

/**
 * Generates standardized voucher code: PTHU-2607-ASA-00001
 */
export function generateFormattedVoucherCode(options: VoucherCodeOptions): string {
  const prefix = formatVoucherPrefix(options.voucherType, options.documentChannel);
  const ym = formatYearMonth(options.voucherDate);
  const branch = formatBranchCode3(options.branchCode);
  const seq = formatSeq5(options.seqNumber);
  return `${prefix}-${ym}-${branch}-${seq}`;
}

/**
 * Prefix cố định của một chuỗi mã: [Mã phiếu]-[YYMM]-[Cửa hàng]- (chưa có số thứ tự).
 * Dùng để tra các mã đã cấp trong đúng chuỗi này trước khi cấp số tiếp theo.
 */
export function voucherCodePrefix(options: Omit<VoucherCodeOptions, "seqNumber">): string {
  const prefix = formatVoucherPrefix(options.voucherType, options.documentChannel);
  const ym = formatYearMonth(options.voucherDate);
  const branch = formatBranchCode3(options.branchCode);
  return `${prefix}-${ym}-${branch}-`;
}

/**
 * Số thứ tự kế tiếp = số LỚN NHẤT đã cấp + 1, tính trên danh sách mã cùng prefix.
 *
 * Trước đây số thứ tự lấy bằng COUNT số phiếu đang có: rollback một batch import xoá phiếu
 * giữa chừng làm COUNT tụt xuống, mã cấp lần sau đâm trúng mã của batch sau vẫn còn sống,
 * và người dùng nhận đúng một câu "Dữ liệu bị trùng" không rõ trùng gì. Lấy max + 1 thì
 * mã đã xoá để lại lỗ trống nhưng không bao giờ cấp lại mã đang tồn tại.
 */
export function nextSeqFromCodes(codes: string[], prefix: string): number {
  let max = 0;
  for (const code of codes) {
    if (!code.startsWith(prefix)) continue;
    const seq = Number(code.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max + 1;
}
