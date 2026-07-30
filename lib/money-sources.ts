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

export function moneySourceAccountCode(source: MoneySourceOption | null | undefined) {
  const group = normalizeMoneySourceGroup(source?.group);
  return group === "CASH" ? "1111" : "1121";
}
