export const branchScopeOptions = [
  { code: "ALL", label: "Tất cả cửa hàng" },
  { code: "HCM", label: "Chủ cửa hàng - Cửa hàng 1" },
  { code: "HN", label: "Chủ cửa hàng - Cửa hàng 2" },
];

export const storeOptions = [
  { code: "HCM", label: "Chủ cửa hàng - Cửa hàng 1" },
  { code: "HN", label: "Chủ cửa hàng - Cửa hàng 2" },
];

export function updateDynamicBranches(branches: Array<{ code: string; name: string }>) {
  if (!branches || branches.length === 0) return;

  const newScope = [{ code: "ALL", label: "Tất cả cửa hàng" }];
  const newStores: Array<{ code: string; label: string }> = [];

  branches.forEach((b) => {
    const label = b.name.startsWith("Chủ cửa hàng - ") ? b.name : `Chủ cửa hàng - ${b.name}`;
    newScope.push({ code: b.code, label });
    newStores.push({ code: b.code, label });
  });

  // Mutate in place
  branchScopeOptions.length = 0;
  branchScopeOptions.push(...newScope);

  storeOptions.length = 0;
  storeOptions.push(...newStores);
}

export function branchLabel(code?: string | null) {
  if (!code) return "-";
  return branchScopeOptions.find((option) => option.code === code)?.label || code;
}

export function storeLabel(code?: string | null) {
  if (!code) return "-";
  if (code === "ALL") return "Tất cả cửa hàng";
  return storeOptions.find((option) => option.code === code)?.label.replace("Chủ cửa hàng - ", "") || code;
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
