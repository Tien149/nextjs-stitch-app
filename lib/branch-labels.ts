function cleanStoreName(label: string) {
  return label.replace(/^Chủ cửa hàng\s*-\s*/i, "").trim();
}

export const branchScopeOptions = [
  { code: "ALL", label: "Tất cả cửa hàng" },
  { code: "HCM", label: "Cửa hàng 1" },
  { code: "HN", label: "Cửa hàng 2" },
];

export const storeOptions = [
  { code: "HCM", label: "Cửa hàng 1" },
  { code: "HN", label: "Cửa hàng 2" },
];

type BranchAccess = { allowedBranches?: string[] | null } | string[] | null | undefined;

function normalizeAllowedBranches(access: BranchAccess) {
  const list = Array.isArray(access) ? access : access?.allowedBranches;
  return list && list.length > 0 ? list : ["ALL"];
}

export function hasFullBranchAccess(access: BranchAccess) {
  return normalizeAllowedBranches(access).includes("ALL");
}

/**
 * Danh sách cửa hàng được phép nhìn thấy, kèm mục "Tất cả cửa hàng".
 *
 * Người dùng chỉ được gán một cửa hàng thì không được thấy TÊN các cửa hàng khác trong
 * dropdown — khoá ô chọn thôi là chưa đủ, vì tên vẫn lộ ra.
 */
export function visibleBranchScopeOptions(access: BranchAccess) {
  const allowed = normalizeAllowedBranches(access);
  if (allowed.includes("ALL")) return [...branchScopeOptions];
  // Không đưa "Tất cả cửa hàng" cho tài khoản bị giới hạn: phía API, "ALL" nghĩa là
  // bỏ lọc chi nhánh, chọn vào sẽ kéo theo dữ liệu của cửa hàng chưa được gán.
  return branchScopeOptions.filter((option) => option.code !== "ALL" && allowed.includes(option.code));
}

/** Như trên nhưng dùng cho ô chọn cửa hàng cụ thể (không có mục "Tất cả cửa hàng"). */
export function visibleStoreOptions(access: BranchAccess) {
  const allowed = normalizeAllowedBranches(access);
  if (allowed.includes("ALL")) return [...storeOptions];
  return storeOptions.filter((option) => allowed.includes(option.code));
}

export function updateDynamicBranches(branches: Array<{ code: string; name: string }>) {
  if (!branches || branches.length === 0) return;

  const newScope = [{ code: "ALL", label: "Tất cả cửa hàng" }];
  const newStores: Array<{ code: string; label: string }> = [];

  branches.forEach((branch) => {
    const label = cleanStoreName(branch.name);
    newScope.push({ code: branch.code, label });
    newStores.push({ code: branch.code, label });
  });

  branchScopeOptions.length = 0;
  branchScopeOptions.push(...newScope);

  storeOptions.length = 0;
  storeOptions.push(...newStores);
}

export function branchLabel(code?: string | null) {
  if (!code) return "-";
  const label = branchScopeOptions.find((option) => option.code === code)?.label || code;
  return cleanStoreName(label);
}

export function storeLabel(code?: string | null) {
  if (!code) return "-";
  if (code === "ALL") return "Tất cả cửa hàng";
  const label = storeOptions.find((option) => option.code === code)?.label || code;
  return cleanStoreName(label);
}

export function branchAccessLabel(codes: string[]) {
  if (codes.includes("ALL")) return "Tất cả cửa hàng";
  if (codes.length === 0) return "Chưa gán cửa hàng";
  return codes.map(branchLabel).join(", ");
}

export function displayRoleName(role?: string | null) {
  if (!role) return "";
  return role === "Quản lý" ? "Chủ cửa hàng" : role;
}
