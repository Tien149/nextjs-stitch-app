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

/**
 * Hạng mục P&L thuộc dòng Chi phí nhân sự khi NHÓM CHA của nó là nhóm lương/nhân sự.
 * Yêu cầu chị Bình 06/09/2026: bảng P&L phải xếp theo đúng cột "Phân loại" của danh mục,
 * nên hạng mục đứng ở nhóm nào thì lên theo nhóm đó — "CP Lương Tháng 13" khai trong Chi phí
 * cố định thì ở lại Chi phí cố định, không bị tên "lương" kéo sang dòng nhân sự nữa.
 * Chỉ khi hạng mục chưa gắn nhóm mới đoán theo tên của chính nó.
 */
export function isPayrollPnlItem(item: { name: string | null | undefined; groupName?: string | null } | null | undefined) {
  if (!item) return false;
  if (item.groupName) return isPayrollPnlName(item.groupName);
  return isPayrollPnlName(item.name);
}

/**
 * Hạng mục "khấu hao" trong danh mục (VD "CPCĐ - CP Khấu Hao"): bút toán khấu hao tự động
 * (TK 6424, không gắn hạng mục) sẽ đứng vào hạng mục này trong Chi phí cố định — P&L không còn
 * dòng Khấu hao riêng (feedback chị Bình 06/09/2026).
 */
export function isDepreciationPnlName(name: string | null | undefined) {
  const text = normalizeName(name);
  return /\bkhau hao\b|\bdepreciation\b/.test(text);
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

/** Thứ tự loại lớn trên cột "Phân loại" — trùng thứ tự các dòng trên bảng P&L. */
const PNL_TYPE_RANK: Record<string, number> = { REVENUE_SOURCE: 0, COGS: 1, OPEX: 2, CAPEX: 3 };

type PnlCatalogRow = { type: string; code: string; name: string; group: string | null; subGroup: string | null };

/**
 * Sắp danh mục Nhóm hạng mục P&L / Hạng mục P&L trên màn Tham số theo đúng cột "Phân loại"
 * (yêu cầu chị Bình 06/09/2026): loại lớn (Doanh thu -> Giá vốn -> OPEX -> CAPEX) -> nhóm P&L
 * (cùng thứ tự nhóm với bảng P&L) -> mã hạng mục. Trước đây xếp theo ngày tạo nên hai màn nhìn
 * khác nhau. Các loại danh mục khác giữ nguyên chỗ.
 */
export function sortPnlCatalogRows<T extends PnlCatalogRow>(rows: T[]): T[] {
  const isPnl = (row: PnlCatalogRow) => row.type === "PNL_GROUP" || row.type === "PNL_ITEM";
  const groupByCode = new Map(rows.filter((row) => row.type === "PNL_GROUP").map((row) => [row.code, row]));
  const parentOf = (row: PnlCatalogRow) => (row.type === "PNL_ITEM" && row.subGroup ? groupByCode.get(row.subGroup) || null : null);
  const typeRank = (row: PnlCatalogRow) => PNL_TYPE_RANK[(parentOf(row)?.group ?? row.group ?? "").toUpperCase()] ?? 9;
  const groupKey = (row: PnlCatalogRow) => {
    if (row.type === "PNL_GROUP") return { name: row.name, last: false };
    const parent = parentOf(row);
    return { name: parent?.name || row.subGroup || "", last: !row.subGroup };
  };
  const sorted = rows.filter(isPnl).sort((a, b) =>
    a.type.localeCompare(b.type)
    || typeRank(a) - typeRank(b)
    || comparePnlGroups(groupKey(a), groupKey(b))
    || a.code.localeCompare(b.code, "vi", { sensitivity: "base" }),
  );
  let index = 0;
  return rows.map((row) => (isPnl(row) ? sorted[index++] : row));
}
