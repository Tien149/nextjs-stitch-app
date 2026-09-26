import type { DemoSession } from "@/lib/auth-demo";

/**
 * Phạm vi PHÒNG BAN của người dùng — dùng cho kiểm kê CCDC/tài sản theo bộ phận (khách yêu cầu
 * 26/09/2026): nhân viên bộ phận chỉ thấy và chỉ duyệt được tài sản của phòng ban mình.
 *
 * Khác với phạm vi cửa hàng (lib/accounting.ts), phạm vi phòng ban là tuỳ chọn: user không gán
 * phòng ban nào (mọi tài khoản đang có) thì thấy mọi phòng ban như trước. Admin luôn thấy hết.
 */
export function allowedDepartmentsOf(session: DemoSession | null | undefined): string[] | null {
  if (!session || session.role === "Admin") return null;
  const list = Array.isArray(session.allowedDepartments) ? session.allowedDepartments.filter(Boolean) : [];
  return list.length > 0 ? list.map((code) => code.toUpperCase()) : null;
}

export function hasDepartmentScope(session: DemoSession | null | undefined) {
  return allowedDepartmentsOf(session) !== null;
}

/** Tài sản chưa gán phòng ban không thuộc phạm vi của ai — user bị giới hạn không thấy nó. */
export function departmentAllowed(session: DemoSession | null | undefined, departmentCode: string | null | undefined) {
  const allowed = allowedDepartmentsOf(session);
  if (!allowed) return true;
  return Boolean(departmentCode) && allowed.includes((departmentCode as string).toUpperCase());
}

export function assertDepartmentAccess(session: DemoSession, departmentCode: string | null | undefined, label: string) {
  if (departmentAllowed(session, departmentCode)) return;
  const allowed = allowedDepartmentsOf(session) || [];
  throw new Error(`BUSINESS:${label} thuộc phòng ban ${departmentCode || "(chưa gán)"}, ngoài phạm vi bộ phận được phân công (${allowed.join(", ")}).`);
}
