/**
 * Luật sắp xếp và định vị hạng mục trên bảng P&L (feedback 03/09/2026):
 *  - Hạng mục "lương người lao động" là chi phí nhân sự: dù kế toán khai nó dưới nhóm OPEX
 *    nào (cố định / biến đổi...) thì trên báo cáo KQKD vẫn phải đứng ở dòng Chi phí nhân sự,
 *    không nằm chung với OPEX khác.
 *  - Nhóm OPEX hiện theo thứ tự: Chi phí cố định -> Chi phí marketing -> Chi phí biến đổi,
 *    các nhóm khác đứng sau.
 *  - Trong mỗi nhóm, hạng mục xếp theo chữ cái tên (tiếng Việt).
 * Danh mục không có cột "loại nhóm" riêng nên nhận diện theo tên; giữ luật ở một chỗ để
 * báo cáo một kỳ, bảng 12 tháng và drilldown cùng đọc một kiểu.
 */

/** Bỏ dấu tiếng Việt + hạ chữ thường để so khớp tên khai có dấu lẫn không dấu. */
function normalizeName(value: string | null | undefined) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hạng mục/nhóm mang tên lương, nhân sự, tiền công → thuộc dòng Chi phí nhân sự.
 * "lương" bỏ dấu thành "luong" nên phải loại các từ ghép không liên quan tới lương:
 * số lượng, năng lượng, khối lượng, định lượng, chất lượng, đo lường...
 */
export function isPayrollPnlName(name: string | null | undefined) {
  const text = normalizeName(name);
  if (!text) return false;
  if (/\b(nhan su|tien cong|payroll)\b/.test(text)) return true;
  return /(?<!\b(?:so|nang|khoi|dinh|chat|trong|san|luu|dung|do|lieu|ham|thanh) )\bluong\b/.test(text);
}

/** Hạng mục P&L thuộc dòng Chi phí nhân sự khi chính nó hoặc nhóm cha mang tên lương/nhân sự. */
export function isPayrollPnlItem(item: { name: string | null | undefined; groupName?: string | null } | null | undefined) {
  if (!item) return false;
  return isPayrollPnlName(item.name) || isPayrollPnlName(item.groupName);
}

/**
 * Thứ tự nhóm OPEX trên bảng: cố định (0) -> marketing (1) -> biến đổi (2) -> nhóm khác (3).
 * Nhóm "chưa phân loại" do nơi gọi tự đẩy xuống cuối.
 */
export function opexGroupRank(name: string | null | undefined) {
  const text = normalizeName(name);
  if (/\bco dinh\b|\bfixed\b/.test(text)) return 0;
  if (/marketing|\bquang cao\b|\btiep thi\b/.test(text)) return 1;
  if (/\bbien doi\b|\bvariable\b/.test(text)) return 2;
  return 3;
}

/** So sánh tên theo bảng chữ cái tiếng Việt, không phân biệt hoa thường. */
export function comparePnlName(a: string, b: string) {
  return a.localeCompare(b, "vi", { sensitivity: "base" });
}

/** Nhóm: theo thứ tự cố định/marketing/biến đổi rồi tới abc; dòng "chưa phân loại" luôn cuối. */
export function comparePnlGroups(a: { name: string; last?: boolean }, b: { name: string; last?: boolean }) {
  if (!!a.last !== !!b.last) return a.last ? 1 : -1;
  const rank = opexGroupRank(a.name) - opexGroupRank(b.name);
  if (rank !== 0) return rank;
  return comparePnlName(a.name, b.name);
}

/** Hạng mục trong nhóm: abc theo tên; dòng "chưa phân loại" luôn cuối. */
export function comparePnlItems(a: { name: string; last?: boolean }, b: { name: string; last?: boolean }) {
  if (!!a.last !== !!b.last) return a.last ? 1 : -1;
  return comparePnlName(a.name, b.name);
}
