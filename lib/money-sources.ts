export type MoneySourceOption = {
  id?: string;
  code: string;
  name: string;
  group: string | null;
  branch: string | null;
  status?: string;
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
