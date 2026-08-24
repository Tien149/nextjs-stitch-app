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

/**
 * Quỹ tiền mặt do THU NGÂN giữ.
 *
 * "Thu chi ngày" là báo cáo của thu ngân theo ngày/ca, nên phần tiền mặt chỉ được tính các quỹ
 * thu ngân đang giữ; những quỹ tiền mặt khác (két quản lý, quỹ văn phòng) không thuộc trách
 * nhiệm nộp của ca đó và không được hiện lên báo cáo này.
 *
 * Nhận diện bằng chữ "thu ngân" khai trên danh mục — ưu tiên "Nguồn tiền tổng"
 * (summarySourceName), sau đó tới tên và mã nguồn. Viết hoa/dấu/khoảng trắng đều bỏ qua nên
 * "Tiền mặt Thu Ngân", "TIEN MAT THU NGAN" hay mã "TM_THUNGAN_HN" đều khớp.
 */
function normalizeVietnameseText(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/Đ/g, "D");
}

const CASHIER_PATTERN = /THU\s*_?\s*NGAN/;

/**
 * Vai trò thu ngân, nhận theo TÊN vai trò khai ở màn Phân quyền ("Thu ngân", "THU NGAN",
 * "Thu ngân ca tối"...). Dùng chung đúng bộ chữ với quỹ tiền mặt thu ngân ở trên, để danh mục
 * và phân quyền không hiểu hai kiểu khác nhau.
 *
 * Đánh đổi đã chốt với khách: đổi tên vai trò sang chữ không có "thu ngân" thì các giới hạn
 * dành cho thu ngân hết hiệu lực, vai trò đó quay về quyền bình thường.
 */
export function isCashierRoleName(role: string | null | undefined) {
  return CASHIER_PATTERN.test(normalizeVietnameseText(role));
}

export function isCashierCashSource(source: MoneySourceOption) {
  if (normalizeMoneySourceGroup(source.group) !== "CASH") return false;
  return CASHIER_PATTERN.test(normalizeVietnameseText(
    `${source.summarySourceName || ""} ${source.name || ""} ${source.code || ""}`,
  ));
}

/**
 * Bộ nhận diện quỹ thu ngân dùng chung cho một danh mục nguồn tiền.
 *
 * Cửa hàng nào CHƯA khai quỹ nào là của thu ngân thì mọi quỹ tiền mặt của cửa hàng đó vẫn được
 * coi là quỹ thu ngân — nếu không, báo cáo của các đơn vị chưa đặt tên theo quy ước sẽ trắng
 * trơn phần tiền mặt. Chỉ khi đã có ít nhất một quỹ khai rõ "thu ngân" thì các quỹ còn lại mới
 * bị loại, vì lúc đó việc tách quỹ là có chủ ý.
 */
export function createCashierCashMatcher(sources: MoneySourceOption[]) {
  const branchKey = (branch: string | null | undefined) => (branch || "ALL").trim().toUpperCase() || "ALL";
  const configuredBranches = new Set(
    sources.filter((source) => isCashierCashSource(source)).map((source) => branchKey(source.branch)),
  );
  return (source: MoneySourceOption | null | undefined) => {
    if (!source || normalizeMoneySourceGroup(source.group) !== "CASH") return false;
    if (isCashierCashSource(source)) return true;
    const key = branchKey(source.branch);
    const configured = key === "ALL"
      ? configuredBranches.size > 0
      : configuredBranches.has(key) || configuredBranches.has("ALL");
    return !configured;
  };
}

/** Danh sách quỹ tiền mặt thu ngân của một cửa hàng, dùng cho ô chọn nguồn khi nộp tiền. */
export function filterCashierCashSources(sources: MoneySourceOption[], branchCode: string | null | undefined) {
  const isCashierCash = createCashierCashMatcher(sources);
  return filterMoneySources(sources, branchCode, ["CASH"]).filter((source) => isCashierCash(source));
}
