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
