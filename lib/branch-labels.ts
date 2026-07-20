export const branchScopeOptions = [
  { code: "ALL", label: "Admin / Tất cả cửa hàng" },
  { code: "HCM", label: "Chủ cửa hàng - Cửa hàng 1" },
  { code: "HN", label: "Chủ cửa hàng - Cửa hàng 2" },
] as const;

export const storeOptions = branchScopeOptions.filter((option) => option.code !== "ALL");

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
  if (codes.includes("ALL")) return "Admin / Tất cả cửa hàng";
  if (codes.length === 0) return "Chưa gán cửa hàng";
  return codes.map(branchLabel).join(", ");
}

export function displayRoleName(role?: string | null) {
  if (!role) return "";
  return role === "Quản lý" ? "Chủ cửa hàng" : role;
}
