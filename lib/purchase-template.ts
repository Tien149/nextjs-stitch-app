/**
 * Mẫu đặt hàng (PurchaseRequestTemplate) — khách yêu cầu 03/10/2026:
 * - Ngày áp dụng / ngày kết thúc: để trống là không chặn đầu đó; ngoài khoảng mẫu không dùng
 *   để đặt hàng được (vẫn xem / sửa được).
 * - Import Excel nhiều mẫu một lần: mỗi dòng một mặt hàng, gom theo Mã mẫu (sửa mẫu có sẵn)
 *   hoặc Tên mẫu + Cửa hàng (mẫu mới; trùng tên mẫu đang có thì ghi đè mẫu đó).
 *
 * Phần thuần để script kiểm thử dùng chung.
 */
import { vnDay } from "@/lib/recipe-validity";
import { parseDay } from "@/lib/supplier-price-list";

export type TemplateWindowStatus = "ACTIVE" | "UPCOMING" | "EXPIRED";

export function templateWindow(template: { effectiveFrom?: Date | string | null; effectiveTo?: Date | string | null }) {
  return {
    from: template.effectiveFrom ? vnDay(template.effectiveFrom) : null,
    to: template.effectiveTo ? vnDay(template.effectiveTo) : null,
  };
}

export function templateWindowStatus(template: { effectiveFrom?: Date | string | null; effectiveTo?: Date | string | null }, today: string): TemplateWindowStatus {
  const window = templateWindow(template);
  if (window.from && window.from > today) return "UPCOMING";
  if (window.to && window.to < today) return "EXPIRED";
  return "ACTIVE";
}

/** Ngày "YYYY-MM-DD" từ ô form; rỗng = null. */
export function templateDayToDate(day: string | null | undefined): Date | null {
  const value = (day || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+07:00`) : null;
}

export const TEMPLATE_IMPORT_HEADERS = [
  "Mã mẫu",
  "Tên mẫu",
  "Cửa hàng",
  "Bộ phận",
  "Ngày áp dụng",
  "Ngày kết thúc",
  "Mã hàng",
  "Tên hàng",
  "ĐVT",
  "Ghi chú",
] as const;

const fold = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]/g, "");
const HEADER_KEYS: Record<string, string> = Object.fromEntries(TEMPLATE_IMPORT_HEADERS.map((header) => [fold(header), header]));

export type TemplateImportItem = { id: string; code: string; name: string; unit: string; status?: string | null; itemType?: string | null; unitConversions?: Array<{ unitCode: string }> };

export type TemplateImportGroup = {
  /** Mã mẫu có sẵn để ghi đè; null = mẫu mới (hoặc trùng tên + cửa hàng thì ghi đè mẫu đó). */
  code: string | null;
  name: string;
  branchCode: string | null;
  departmentCode: string | null;
  from: string | null;
  to: string | null;
  lines: Array<{ itemId: string; itemCode: string; unitCode: string | null; note: string | null; row: number }>;
};

export function buildTemplateImport(
  rawRows: Array<Record<string, unknown>>,
  lookup: {
    items: Map<string, TemplateImportItem>;
    branches: Set<string>;
    departments: Set<string>;
    /** Mã mẫu đang có → tên (để dòng chỉ ghi Mã mẫu vẫn có tên). */
    templates: Map<string, string>;
  },
): { groups: TemplateImportGroup[]; errors: Array<{ row: number; message: string }> } {
  const errors: Array<{ row: number; message: string }> = [];
  const groups = new Map<string, TemplateImportGroup>();
  rawRows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const header = HEADER_KEYS[fold(key)];
      if (header) row[header] = value;
    }
    const text = (header: string) => String(row[header] ?? "").trim();
    if (TEMPLATE_IMPORT_HEADERS.every((header) => !text(header))) return;
    const fail = (message: string) => errors.push({ row: rowNumber, message });

    const code = text("Mã mẫu").toUpperCase() || null;
    if (code && !lookup.templates.has(code)) return fail(`Mã mẫu ${code} không có — bỏ trống Mã mẫu để tạo mẫu mới`);
    const name = text("Tên mẫu") || (code ? lookup.templates.get(code) || "" : "");
    if (!name) return fail("Thiếu Tên mẫu (hoặc Mã mẫu có sẵn)");
    const branchCode = text("Cửa hàng").toUpperCase() || null;
    if (branchCode && !lookup.branches.has(branchCode)) return fail(`Cửa hàng ${branchCode} không có trong danh mục`);
    const departmentCode = text("Bộ phận").toUpperCase() || null;
    if (departmentCode && !lookup.departments.has(departmentCode)) return fail(`Bộ phận ${departmentCode} không có trong danh mục`);
    const from = parseDay(row["Ngày áp dụng"]);
    if (text("Ngày áp dụng") && !from) return fail(`Ngày áp dụng "${text("Ngày áp dụng")}" không đọc được (ghi dạng dd/mm/yyyy)`);
    const to = parseDay(row["Ngày kết thúc"]);
    if (text("Ngày kết thúc") && !to) return fail(`Ngày kết thúc "${text("Ngày kết thúc")}" không đọc được (ghi dạng dd/mm/yyyy)`);
    if (from && to && to < from) return fail(`Ngày kết thúc ${to} trước Ngày áp dụng ${from}`);

    const itemCode = text("Mã hàng").toUpperCase();
    if (!itemCode) return fail("Thiếu Mã hàng");
    const item = lookup.items.get(itemCode);
    if (!item) return fail(`Mã hàng ${itemCode} không có trong danh mục Mặt hàng`);
    if (item.status && item.status !== "ACTIVE") return fail(`Mã hàng ${itemCode} đang ngưng hoạt động`);
    if (item.itemType === "FINISHED") return fail(`${itemCode} là Thành phẩm bán tại POS, không đưa vào mẫu mua hàng`);
    const unitText = text("ĐVT").toUpperCase();
    let unitCode: string | null = null;
    if (unitText) {
      const conversion = (item.unitConversions || []).find((candidate) => candidate.unitCode.toUpperCase() === unitText);
      if (conversion) unitCode = conversion.unitCode;
      else if (unitText === item.unit.toUpperCase()) unitCode = item.unit.toUpperCase();
      else return fail(`ĐVT ${unitText} chưa khai quy đổi cho ${itemCode} (ĐVT tồn: ${item.unit})`);
    }

    // Mã mẫu có thì gom theo mã. Không có: theo Tên mẫu + Cửa hàng; dòng bỏ trống Cửa hàng nhập
    // vào nhóm cùng tên vừa gặp gần nhất (thông tin cấp mẫu chỉ cần ghi ở dòng đầu).
    let key = code || `${fold(name)}|${branchCode || ""}`;
    if (!code && !branchCode && !groups.has(key)) {
      const sameName = [...groups.keys()].filter((candidate) => candidate.startsWith(`${fold(name)}|`));
      if (sameName.length > 0) key = sameName[sameName.length - 1];
    }
    const group = groups.get(key);
    if (group) {
      // Thông tin cấp mẫu ghi ở dòng nào cũng được, nhưng không được mâu thuẫn nhau.
      if (branchCode && group.branchCode && branchCode !== group.branchCode) return fail(`Mẫu "${name}" ghi hai cửa hàng khác nhau`);
      if (departmentCode && group.departmentCode && departmentCode !== group.departmentCode) return fail(`Mẫu "${name}" ghi hai bộ phận khác nhau`);
      if (from && group.from && from !== group.from) return fail(`Mẫu "${name}" ghi hai Ngày áp dụng khác nhau`);
      if (to && group.to && to !== group.to) return fail(`Mẫu "${name}" ghi hai Ngày kết thúc khác nhau`);
      group.branchCode ||= branchCode;
      group.departmentCode ||= departmentCode;
      group.from ||= from;
      group.to ||= to;
      if (group.lines.some((line) => line.itemId === item.id)) return fail(`${itemCode} bị lặp trong mẫu "${name}"`);
      group.lines.push({ itemId: item.id, itemCode: item.code, unitCode, note: text("Ghi chú") || null, row: rowNumber });
      return;
    }
    groups.set(key, { code, name, branchCode, departmentCode, from, to, lines: [{ itemId: item.id, itemCode: item.code, unitCode, note: text("Ghi chú") || null, row: rowNumber }] });
  });
  return { groups: [...groups.values()], errors };
}
