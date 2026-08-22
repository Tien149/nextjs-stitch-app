export type MoneySourceOption = {
  id?: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
  status?: string;
  /** Tên "Nguồn tiền tổng" khai trên danh mục: các nguồn cùng tên gộp thành một dòng/một lựa chọn lọc. */
  summarySourceName?: string | null;
};

export function normalizeMoneySourceGroup(group: string | null | undefined) {
  const raw = (group || "").trim().toUpperCase();
  const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/Đ/g, "D");
  if (["CASH", "TIEN MAT", "QUY TIEN MAT"].includes(normalized)) return "CASH";
  if (["BANK", "NGAN HANG", "TAI KHOAN NGAN HANG"].includes(normalized)) return "BANK";
  if (["WALLET", "VI", "VI/POS", "VI DIEN TU", "POS", "CONG POS"].includes(normalized)) return "WALLET";
  return raw;
}

export function moneySourceMatchesBranch(source: MoneySourceOption, branchCode: string | null | undefined) {
  const branch = (branchCode || "").trim().toUpperCase();
  const sourceBranch = (source.branch || "").trim().toUpperCase();
  if (!branch || branch === "ALL") return true;
  return !sourceBranch || sourceBranch === "ALL" || sourceBranch === branch;
}

export function filterMoneySources(
  sources: MoneySourceOption[],
  branchCode: string | null | undefined,
  groups?: string[],
) {
  const allowedGroups = groups?.map((group) => group.toUpperCase());
  return sources.filter((source) => {
    if (source.status && source.status !== "ACTIVE") return false;
    if (!moneySourceMatchesBranch(source, branchCode)) return false;
    if (allowedGroups?.length && !allowedGroups.includes(normalizeMoneySourceGroup(source.group))) return false;
    return true;
  });
}

export function firstMoneySourceCode(
  sources: MoneySourceOption[],
  branchCode: string | null | undefined,
  groups?: string[],
) {
  return filterMoneySources(sources, branchCode, groups)[0]?.code || "";
}

export function isMoneySourceAllowed(
  sources: MoneySourceOption[],
  code: string | null | undefined,
  branchCode: string | null | undefined,
  groups?: string[],
) {
  if (!code) return false;
  return filterMoneySources(sources, branchCode, groups).some((source) => source.code === code);
}

function humanizeCodeLabel(label: string) {
  return label
    .replace(/\bTIENMAT\b/gi, "Tiền mặt")
    .replace(/\bTHUNGAN\b/gi, "Thu ngân")
    .replace(/\bNGANHANG\b/gi, "Ngân hàng")
    .replace(/\bVIETINBANK\b/gi, "Vietinbank")
    .replace(/\bTECHCOMBANK\b/gi, "Techcombank")
    .replace(/\bVPBANK\b/gi, "VPBank")
    .replace(/\bMOMO\b/gi, "Momo")
    .replace(/\bVNPay\b/gi, "VNPay");
}

export function moneySourceDisplayName(source: MoneySourceOption, currentBranchLabel?: string | null) {
  // Keep this parameter for existing callers; branch context must not rewrite
  // a user-configured money-source name.
  void currentBranchLabel;

  const configuredName = (source.name || "").trim();
  if (configuredName) return configuredName;

  return humanizeCodeLabel(
    (source.code || "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function moneySourceDebugLabel(source: MoneySourceOption, currentBranchLabel?: string | null) {
  const group = source.group ? ` (${source.group})` : "";
  return `[${source.code}] ${moneySourceDisplayName(source, currentBranchLabel)}${group}`;
}

export function moneySourceAccountCode(source: MoneySourceOption | null | undefined) {
  const group = normalizeMoneySourceGroup(source?.group);
  return group === "CASH" ? "1111" : "1121";
}

/**
 * Cụm mô tả HÌNH THỨC thanh toán bị bỏ khỏi TÊN nguồn tiền: tên chỉ nên nói tiền nằm ở đâu
 * ("FDS Vietinbank"), còn "quẹt thẻ" / "chuyển khoản" là cách tiền đi — thông tin đó đã nằm ở
 * nhóm nguồn tiền (CASH/BANK/WALLET) và ở khoản mục thu chi, để lại trong tên chỉ làm báo cáo
 * dài dòng và cùng một ngân hàng lại hiện thành nhiều tên khác nhau.
 *
 * Chỉ đụng tới TÊN. Mã nguồn tiền (code) không bao giờ được cắt: mọi phiếu thu/chi, sao kê,
 * điều tiền đều tham chiếu theo code.
 */
const MONEY_SOURCE_LABEL_NOISE = /(quẹt|quet)\s*(thẻ|the)|(chuyển|chuyen)\s*(khoản|khoan)/gi;

export function stripMoneySourceLabel(value: string | null | undefined) {
  return String(value || "")
    .replace(MONEY_SOURCE_LABEL_NOISE, " ")
    // "(Quẹt thẻ)" cắt xong còn lại cặp ngoặc rỗng.
    .replace(/\(\s*\)|\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    // "FDS - Quẹt Thẻ - Vietinbank" cắt xong còn hai dấu nối dính nhau.
    .replace(/([-–—/|])(?:\s*[-–—/|])+/g, "$1")
    .replace(/^[\s\-–—/|]+|[\s\-–—/|]+$/g, "")
    .trim();
}

/**
 * Tên đã cắt, nhưng không bao giờ trả về rỗng: nguồn tiền đặt tên đúng bằng cụm bị cắt
 * ("Chuyển khoản") mà mất tên thì danh mục không còn chỗ dựa để nhận ra dòng.
 */
export function cleanMoneySourceName(value: string | null | undefined) {
  const raw = String(value || "").trim();
  return stripMoneySourceLabel(raw) || raw;
}

export type MoneySourceSummaryGroup = {
  /** Giá trị đưa vào ô lọc: các mã nguồn chi tiết nối bằng dấu phẩy — API tách lại bằng parseMoneySourceCodes. */
  value: string;
  name: string;
  branch: string | null;
  codes: string[];
};

/**
 * Gom các nguồn cùng "Nguồn tiền tổng" (khai trên danh mục) thành một lựa chọn lọc, ví dụ
 * "FDS - Quẹt Thẻ Vietinbank" + "FDS - Vietinbank" cùng tổng "FDS - Vietinbank" thì ô lọc
 * có thêm dòng tổng chọn được cả hai. Gom theo cửa hàng, cùng luật với báo cáo nguồn tiền
 * (lib/reports.ts) để hai nơi không ra hai cách gộp khác nhau.
 *
 * Nhận danh sách ĐÃ lọc theo màn hình (cửa hàng, nhóm nguồn, trạng thái) để nhóm tổng chỉ
 * gồm những nguồn mà màn đó thực sự cho chọn. Nhóm một thành viên bị bỏ: chọn nó không khác
 * gì chọn thẳng nguồn chi tiết, chỉ làm ô lọc dài ra.
 */
export function summaryMoneySourceGroups(options: MoneySourceOption[]): MoneySourceSummaryGroup[] {
  const grouped = new Map<string, { name: string; branch: string | null; codes: string[] }>();
  for (const option of options) {
    const name = (option.summarySourceName || "").trim();
    if (!name) continue;
    const branch = (option.branch || "ALL").trim().toUpperCase();
    const key = `${branch}|${name.toUpperCase()}`;
    const current = grouped.get(key) || { name, branch: option.branch || null, codes: [] };
    if (!current.codes.includes(option.code)) current.codes.push(option.code);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .filter((group) => group.codes.length > 1)
    .map((group) => ({ ...group, codes: [...group.codes].sort(), value: [...group.codes].sort().join(",") }))
    .sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

/**
 * Tách giá trị ô lọc nguồn tiền thành danh sách mã: một mã chi tiết, hoặc nhiều mã của một
 * nhóm tổng nối bằng dấu phẩy. Rỗng / "ALL" nghĩa là không lọc.
 */
export function parseMoneySourceCodes(value: string | null | undefined): string[] {
  const raw = (value || "").trim();
  if (!raw || raw.toUpperCase() === "ALL") return [];
  return [...new Set(raw.split(",").map((code) => code.trim()).filter(Boolean))];
}
