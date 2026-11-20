/**
 * Báo cáo doanh thu theo ca & theo món (khách yêu cầu 20/11/2026): sáng / trưa / tối, đồ ăn /
 * đồ uống, từng món, top 20 bán chạy và top 10 bán chậm trong tháng.
 *
 * Máy chủ chỉ gom dòng import POS về ô (mã món × nhóm × giờ) — `lib/sales-analysis-server.ts`.
 * Phần chia ca nằm ở đây, chạy được cả phía trình duyệt: mốc giờ ca đổi trên màn là tính lại
 * ngay, không gọi lại máy chủ. File thuần (không Prisma) để test bằng node.
 *
 * Hai con số tiền:
 * - `amount` = doanh thu bán món = thành tiền − giảm giá, CHƯA gồm SVC và thuế GTGT. Dùng để
 *   xếp hạng món (SVC/thuế chia theo hoá đơn, không nói gì về món).
 * - `total` = cột Doanh thu (netAmount) của dòng import = món − giảm giá + SVC + thuế, cùng số
 *   với dòng Doanh thu của P&L.
 */

export type SalesKind = "FOOD" | "DRINK" | "SERVICE" | "OTHER";
export type SalesShift = "MORNING" | "NOON" | "EVENING" | "NO_HOUR";

export const SALES_KINDS: SalesKind[] = ["FOOD", "DRINK", "SERVICE", "OTHER"];
export const SALES_SHIFTS: SalesShift[] = ["MORNING", "NOON", "EVENING", "NO_HOUR"];

export const salesKindLabels: Record<SalesKind, string> = {
  FOOD: "Đồ ăn",
  DRINK: "Đồ uống",
  SERVICE: "Phụ thu",
  OTHER: "Chưa phân nhóm",
};

export const salesShiftLabels: Record<SalesShift, string> = {
  MORNING: "Sáng",
  NOON: "Trưa",
  EVENING: "Tối",
  NO_HOUR: "Không có giờ",
};

/** Một ô gom sẵn từ máy chủ: mã món × nhóm × giờ bán (null = file chỉ có ngày). */
export type SalesCell = {
  code: string;
  kind: SalesKind;
  hour: number | null;
  quantity: number;
  amount: number;
  total: number;
  /** Số dòng import gom vào ô — để báo bao nhiêu dòng không có giờ. */
  rows: number;
};

/**
 * Mốc bắt đầu từng ca (giờ VN, 0–23). Giờ trước mốc Sáng tính vào ca Tối của ngày đó — nhà hàng
 * mở khuya thì 0h–4h là đuôi ca tối, không phải bữa sáng.
 */
export type ShiftBounds = { morningFrom: number; noonFrom: number; eveningFrom: number };
export const DEFAULT_SHIFT_BOUNDS: ShiftBounds = { morningFrom: 5, noonFrom: 11, eveningFrom: 17 };

export function normalizeShiftBounds(bounds: Partial<ShiftBounds>): ShiftBounds {
  const clamp = (value: unknown, fallback: number) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number >= 0 && number <= 23 ? number : fallback;
  };
  const morningFrom = clamp(bounds.morningFrom, DEFAULT_SHIFT_BOUNDS.morningFrom);
  const noonFrom = Math.max(clamp(bounds.noonFrom, DEFAULT_SHIFT_BOUNDS.noonFrom), morningFrom + 1);
  const eveningFrom = Math.max(clamp(bounds.eveningFrom, DEFAULT_SHIFT_BOUNDS.eveningFrom), noonFrom + 1);
  return { morningFrom, noonFrom: Math.min(noonFrom, 22), eveningFrom: Math.min(eveningFrom, 23) };
}

export function shiftOfHour(hour: number | null, bounds: ShiftBounds = DEFAULT_SHIFT_BOUNDS): SalesShift {
  if (hour === null || hour === undefined || !Number.isFinite(hour)) return "NO_HOUR";
  if (hour < bounds.morningFrom) return "EVENING";
  if (hour < bounds.noonFrom) return "MORNING";
  if (hour < bounds.eveningFrom) return "NOON";
  return "EVENING";
}

/** "05:00 – 10:59" — nhãn khung giờ của ca để in lên đầu cột. */
export function shiftRangeLabel(shift: SalesShift, bounds: ShiftBounds) {
  const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  const end = (hour: number) => `${String((hour + 23) % 24).padStart(2, "0")}:59`;
  if (shift === "MORNING") return `${hh(bounds.morningFrom)} – ${end(bounds.noonFrom)}`;
  if (shift === "NOON") return `${hh(bounds.noonFrom)} – ${end(bounds.eveningFrom)}`;
  if (shift === "EVENING") return bounds.morningFrom === 0 ? `${hh(bounds.eveningFrom)} – 23:59` : `${hh(bounds.eveningFrom)} – ${end(bounds.morningFrom)}`;
  return "File chỉ có ngày";
}

export type SalesMoney = { quantity: number; amount: number; total: number; rows: number };
const emptyMoney = (): SalesMoney => ({ quantity: 0, amount: 0, total: 0, rows: 0 });
function addMoney(target: SalesMoney, cell: Pick<SalesCell, "quantity" | "amount" | "total" | "rows">) {
  target.quantity += cell.quantity;
  target.amount += cell.amount;
  target.total += cell.total;
  target.rows += cell.rows;
}

export type SalesItemSummary = SalesMoney & {
  code: string;
  kind: SalesKind;
  byShift: Record<SalesShift, SalesMoney>;
};

export type SalesSummary = {
  total: SalesMoney;
  byShift: Record<SalesShift, SalesMoney & { byKind: Record<SalesKind, SalesMoney> }>;
  byKind: Record<SalesKind, SalesMoney>;
  /** Doanh thu theo từng giờ 0–23 (bỏ dòng không có giờ). */
  byHour: Array<SalesMoney & { hour: number }>;
  items: SalesItemSummary[];
};

const perShift = <T,>(make: () => T) => Object.fromEntries(SALES_SHIFTS.map((shift) => [shift, make()])) as Record<SalesShift, T>;
const perKind = <T,>(make: () => T) => Object.fromEntries(SALES_KINDS.map((kind) => [kind, make()])) as Record<SalesKind, T>;

/**
 * Chia các ô theo ca. `kinds` rỗng/không truyền = mọi nhóm. Một mã có dòng ở nhiều nhóm (file
 * khai lệch giữa các ngày) vẫn là MỘT món; nhóm của món lấy theo nhóm mang nhiều doanh thu nhất.
 */
export function summarizeSales(cells: SalesCell[], bounds: ShiftBounds = DEFAULT_SHIFT_BOUNDS, kinds?: SalesKind[]): SalesSummary {
  const keep = kinds && kinds.length > 0 ? new Set(kinds) : null;
  const total = emptyMoney();
  const byShift = perShift(() => ({ ...emptyMoney(), byKind: perKind(emptyMoney) }));
  const byKind = perKind(emptyMoney);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyMoney() }));
  const items = new Map<string, SalesItemSummary & { kindWeight: Map<SalesKind, number> }>();
  for (const cell of cells) {
    if (keep && !keep.has(cell.kind)) continue;
    const shift = shiftOfHour(cell.hour, bounds);
    addMoney(total, cell);
    addMoney(byShift[shift], cell);
    addMoney(byShift[shift].byKind[cell.kind], cell);
    addMoney(byKind[cell.kind], cell);
    if (cell.hour !== null && cell.hour >= 0 && cell.hour <= 23) addMoney(byHour[cell.hour], cell);
    const code = cell.code || "(không mã)";
    let item = items.get(code);
    if (!item) {
      item = { code, kind: cell.kind, ...emptyMoney(), byShift: perShift(emptyMoney), kindWeight: new Map() };
      items.set(code, item);
    }
    addMoney(item, cell);
    addMoney(item.byShift[shift], cell);
    item.kindWeight.set(cell.kind, (item.kindWeight.get(cell.kind) || 0) + Math.abs(cell.amount) + Math.abs(cell.quantity) * 1e-6);
  }
  const itemList = [...items.values()].map(({ kindWeight, ...item }) => {
    const kind = [...kindWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || item.kind;
    return { ...item, kind };
  });
  itemList.sort((a, b) => b.amount - a.amount || b.quantity - a.quantity || a.code.localeCompare(b.code));
  return { total, byShift, byKind, byHour, items: itemList };
}

export type RankBy = "quantity" | "amount";

/**
 * Xếp hạng món. Bán chạy: lớn trước. Bán chậm: nhỏ trước, chỉ món có bán trong kỳ (SL > 0) —
 * món không bán dòng nào thì file POS không có, báo cáo không biết tới.
 * `skipFree`: bỏ món tổng doanh thu 0 đ (món con trong combo, topping/khăn tặng) — không thì
 * mấy món kèm theo chiếm hết bảng bán chạy theo số lượng.
 */
export function rankSalesItems(items: SalesItemSummary[], options: { by: RankBy; order: "best" | "worst"; limit: number; skipFree?: boolean }) {
  const pool = items.filter((item) => item.quantity > 0 && (!options.skipFree || Math.abs(item.amount) >= 0.5));
  const primary = (item: SalesItemSummary) => (options.by === "quantity" ? item.quantity : item.amount);
  const secondary = (item: SalesItemSummary) => (options.by === "quantity" ? item.amount : item.quantity);
  const sign = options.order === "best" ? -1 : 1;
  return [...pool]
    .sort((a, b) => sign * (primary(a) - primary(b)) || sign * (secondary(a) - secondary(b)) || a.code.localeCompare(b.code))
    .slice(0, Math.max(0, options.limit));
}

/**
 * Lượt khách (khách 20/11/2026): ô gom theo ngày × giờ × kênh bán. `guests` = cột Số khách,
 * `bills` = số hoá đơn (chỉ có khi file có cột Số hoá đơn), `amount` = doanh thu món của ô.
 */
export type VisitCell = { date: string; hour: number | null; channel: string; guests: number; bills: number; amount: number; total: number };
export type VisitMoney = { guests: number; bills: number; amount: number; total: number; /** DT món của kênh có khách — mẫu số DT/khách. */ guestAmount: number };
const emptyVisit = (): VisitMoney => ({ guests: 0, bills: 0, amount: 0, total: 0, guestAmount: 0 });

export type VisitSummary = {
  total: VisitMoney;
  byShift: Record<SalesShift, VisitMoney>;
  byDay: Array<VisitMoney & { date: string; byShift: Record<SalesShift, VisitMoney> }>;
  byChannel: Array<VisitMoney & { channel: string }>;
  /** Kênh có ghi số khách trong kỳ. Kênh giao hàng (Grab...) không có khách ngồi nên không vào DT/khách. */
  guestChannels: string[];
};

/** DT trung bình mỗi khách: chỉ lấy doanh thu của kênh có ghi số khách (bỏ Grab/giao hàng). */
export function revenuePerGuest(value: VisitMoney) {
  return value.guests > 0 ? value.guestAmount / value.guests : null;
}

export function summarizeVisits(cells: VisitCell[], bounds: ShiftBounds = DEFAULT_SHIFT_BOUNDS): VisitSummary {
  const guestChannels = new Set(cells.filter((cell) => cell.guests > 0).map((cell) => cell.channel));
  const add = (target: VisitMoney, cell: VisitCell) => {
    target.guests += cell.guests;
    target.bills += cell.bills;
    target.amount += cell.amount;
    target.total += cell.total;
    if (guestChannels.has(cell.channel)) target.guestAmount += cell.amount;
  };
  const total = emptyVisit();
  const byShift = perShift(emptyVisit);
  const days = new Map<string, VisitMoney & { date: string; byShift: Record<SalesShift, VisitMoney> }>();
  const channels = new Map<string, VisitMoney & { channel: string }>();
  for (const cell of cells) {
    const shift = shiftOfHour(cell.hour, bounds);
    add(total, cell);
    add(byShift[shift], cell);
    let day = days.get(cell.date);
    if (!day) {
      day = { date: cell.date, ...emptyVisit(), byShift: perShift(emptyVisit) };
      days.set(cell.date, day);
    }
    add(day, cell);
    add(day.byShift[shift], cell);
    let channel = channels.get(cell.channel);
    if (!channel) {
      channel = { channel: cell.channel, ...emptyVisit() };
      channels.set(cell.channel, channel);
    }
    add(channel, cell);
  }
  return {
    total,
    byShift,
    byDay: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byChannel: [...channels.values()].sort((a, b) => b.guests - a.guests || b.amount - a.amount),
    guestChannels: [...guestChannels],
  };
}
