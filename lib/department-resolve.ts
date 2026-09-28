import { normalizeHeader } from "@/lib/import-templates";

/**
 * Quy chữ ô "Phòng ban" của bảng lương về MÃ danh mục DEPARTMENT: khớp mã (không phân biệt hoa
 * thường) hoặc đúng tên ("Team Bar", "bộ phận bar"). Không khớp gì thì trả null để nơi gọi tự
 * quyết (báo cáo giữ nguyên chữ thành một dòng riêng; script sửa dữ liệu thì liệt kê ra).
 *
 * Import bảng lương từng lưu nguyên chữ đó (trước 28/09/2026), nên lương thực tế không khớp bộ
 * phận set tỷ trọng ở Ngân sách nhân sự. Báo cáo (lib/report-budget.ts) và
 * scripts/repair-payroll-department.mjs dùng chung một luật để không lệch nhau.
 */
export function createDepartmentResolver(departments: Array<{ code: string; name: string }>) {
  const byKey = new Map<string, string>();
  // Tên trùng nhau giữa hai bộ phận thì không đoán — chỉ nhận khi đúng một bộ phận mang tên đó.
  const ambiguousNames = new Set<string>();
  for (const item of departments) {
    const key = normalizeHeader(item.name);
    if (!key) continue;
    if (byKey.has(key) && byKey.get(key) !== item.code) ambiguousNames.add(key);
    else byKey.set(key, item.code);
  }
  for (const key of ambiguousNames) byKey.delete(key);
  // Mã đứng sau để luôn thắng tên (mã viết hoa, tên đã hạ chữ thường nên không đè nhau).
  for (const item of departments) byKey.set(item.code.toUpperCase(), item.code);

  return (raw: string | null | undefined): string | null => {
    const value = (raw || "").trim();
    if (!value) return null;
    return byKey.get(value.toUpperCase()) || byKey.get(normalizeHeader(value)) || null;
  };
}
