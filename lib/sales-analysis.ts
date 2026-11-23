/**
 * Báo cáo doanh thu theo ca & theo món (khách yêu cầu 20/11/2026): đồ ăn / đồ uống, từng món, top
 * 20 bán chạy và top 10 bán chậm trong tháng, lượt khách.
 *
 * Ca khai THEO TỪNG NHÀ HÀNG (khách 20/11/2026: NME hai ca Sáng 10:00 / Tối 15:00, ASA ba ca Sáng /
 * Trưa 10:30 / Tối 15:00) — bảng SalesShiftConfig, sửa ngay trên màn báo cáo.
 *
 * Máy chủ chỉ gom dòng import POS về ô (mã món × nhóm × cửa hàng × giờ:phút) —
 * `lib/sales-analysis-server.ts`. Phần chia ca nằm ở đây, chạy được cả phía trình duyệt: sửa ca
 * xong là tính lại ngay. File thuần (không Prisma) để test bằng node.
 *
 * Hai con số tiền:
 * - `amount` = doanh thu bán món = thành tiền − giảm giá, CHƯA gồm SVC và thuế GTGT. Dùng để
 *   xếp hạng món (SVC/thuế chia theo hoá đơn, không nói gì về món).
 * - `total` = cột Doanh thu (netAmount) của dòng import = món − giảm giá + SVC + thuế, cùng số
 *   với dòng Doanh thu của P&L.
 */

export type SalesKind = "FOOD" | "DRINK" | "SERVICE" | "OTHER";
export const SALES_KINDS: SalesKind[] = ["FOOD", "DRINK", "SERVICE", "OTHER"];

export const salesKindLabels: Record<SalesKind, string> = {
  FOOD: "Đồ ăn",
  DRINK: "Đồ uống",
  SERVICE: "Phụ thu",
  OTHER: "Chưa phân nhóm",
};

/** Ca của dòng không có giờ bán (file chỉ có ngày). */
export const NO_HOUR = "Không có giờ";

/**
 * Mốc bắt đầu ca chọn theo bước 15 phút (00 / 15 / 30 / 45). Phút bán lưu ĐÚNG như file từ
 * 23/11/2026 (trước đó 20–23/11 làm tròn khung 15 phút), chia ca theo phút thật.
 */
export const SHIFT_SLOT_MINUTES = 15;

/** Một ca: tên + giờ bắt đầu "HH:MM". Ca kéo tới giờ bắt đầu của ca sau; ca cuối kéo tới hết ngày. */
export type ShiftDef = { name: string; from: string };
/** Ca theo mã cửa hàng. */
export type ShiftConfigs = Record<string, ShiftDef[]>;

export const DEFAULT_SHIFTS: ShiftDef[] = [
  { name: "Sáng", from: "05:00" },
  { name: "Trưa", from: "11:00" },
  { name: "Tối", from: "17:00" },
];

export function parseClock(value: unknown): number | null {
  const match = /^(\d{1,2})(?::|h)?(\d{2})?$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatClock(minutes: number) {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/**
 * Chuẩn hoá danh sách ca người dùng gửi lên: bỏ dòng thiếu tên/giờ, giờ làm tròn xuống khung 15
 * phút, xếp theo giờ bắt đầu, trùng tên hoặc trùng giờ thì giữ dòng đầu. Rỗng thì trả rỗng —
 * nơi gọi tự quyết dùng mặc định hay báo lỗi.
 */
export function normalizeShiftDefs(input: unknown): ShiftDef[] {
  if (!Array.isArray(input)) return [];
  const seenNames = new Set<string>();
  const seenStarts = new Set<number>();
  const result: Array<{ name: string; start: number }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const name = String((raw as { name?: unknown }).name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const clock = parseClock((raw as { from?: unknown }).from);
    if (!name || clock === null) continue;
    const start = Math.floor(clock / SHIFT_SLOT_MINUTES) * SHIFT_SLOT_MINUTES;
    const nameKey = name.toLocaleLowerCase("vi");
    if (seenNames.has(nameKey) || seenStarts.has(start) || name === NO_HOUR) continue;
    seenNames.add(nameKey);
    seenStarts.add(start);
    result.push({ name, start });
  }
  return result.sort((a, b) => a.start - b.start).map((shift) => ({ name: shift.name, from: formatClock(shift.start) }));
}

/**
 * Ca chứa thời điểm hour:minute. Dòng có giờ mà không có phút (import trước 20/11/2026) tính như
 * phút 00. Giờ trước ca đầu tiên tính vào ca CUỐI — quán bán qua nửa đêm thì 0h–2h là đuôi ca tối.
 */
export function shiftNameAt(defs: ShiftDef[], hour: number | null, minute: number | null = null) {
  if (hour === null || hour === undefined || !Number.isFinite(hour)) return NO_HOUR;
  const shifts = defs.length > 0 ? defs : DEFAULT_SHIFTS;
  const at = hour * 60 + (minute ?? 0);
  let picked = shifts[shifts.length - 1].name;
  for (const shift of shifts) {
    const start = parseClock(shift.from) ?? 0;
    if (start <= at) picked = shift.name;
  }
  return picked;
}

/** "10:30 – 14:59" của một ca theo cấu hình một cửa hàng; ca không có ở cửa hàng đó trả "". */
export function shiftRangeOf(defs: ShiftDef[], name: string) {
  const shifts = defs.length > 0 ? defs : DEFAULT_SHIFTS;
  const index = shifts.findIndex((shift) => shift.name === name);
  if (index < 0) return "";
  const start = parseClock(shifts[index].from) ?? 0;
  const next = index + 1 < shifts.length ? parseClock(shifts[index + 1].from) ?? 1440 : (parseClock(shifts[0].from) ?? 0) + 1440;
  const end = formatClock(next - 1);
  return `${formatClock(start)} – ${end}`;
}

/** Bộ ca của một cửa hàng: đã khai thì theo khai báo, chưa khai thì mặc định. */
export function shiftsOf(configs: ShiftConfigs, branchCode: string) {
  const defs = configs[branchCode];
  return defs && defs.length > 0 ? defs : DEFAULT_SHIFTS;
}

/**
 * Thứ tự các ca khi xem nhiều cửa hàng cùng lúc: cùng tên là cùng một ca (Sáng của NME cộng với
 * Sáng của ASA), xếp theo giờ bắt đầu sớm nhất của ca đó ở bất kỳ cửa hàng nào.
 */
export function orderedShiftNames(configs: ShiftConfigs, branchCodes: string[]) {
  const earliest = new Map<string, number>();
  for (const branch of branchCodes) {
    for (const shift of shiftsOf(configs, branch)) {
      const start = parseClock(shift.from) ?? 0;
      earliest.set(shift.name, Math.min(earliest.get(shift.name) ?? Infinity, start));
    }
  }
  return [...earliest.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/** Một ô gom sẵn từ máy chủ: mã món × nhóm × cửa hàng × giờ:phút (giờ null = file chỉ có ngày). */
export type SalesCell = {
  code: string;
  kind: SalesKind;
  branchCode: string;
  hour: number | null;
  /** Phút bán (0–59); null = dòng import trước khi lưu phút (tính như phút 00). */
  minute: number | null;
  quantity: number;
  amount: number;
  total: number;
  /** Số dòng import gom vào ô — để báo bao nhiêu dòng không có giờ. */
  rows: number;
};

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
  byShift: Record<string, SalesMoney>;
};

export type SalesSummary = {
  total: SalesMoney;
  byShift: Record<string, SalesMoney & { byKind: Record<SalesKind, SalesMoney> }>;
  byKind: Record<SalesKind, SalesMoney>;
  /** Doanh thu theo từng giờ 0–23 (bỏ dòng không có giờ). */
  byHour: Array<SalesMoney & { hour: number }>;
  items: SalesItemSummary[];
};

const perKind = <T,>(make: () => T) => Object.fromEntries(SALES_KINDS.map((kind) => [kind, make()])) as Record<SalesKind, T>;
/** Bảng theo ca luôn đủ mọi ca của danh sách (ca không bán vẫn có dòng 0), ca lạ thì thêm vào. */
function shiftTable<T>(names: string[], make: () => T) {
  const table: Record<string, T> = {};
  for (const name of [...names, NO_HOUR]) table[name] = make();
  return (name: string) => (table[name] ??= make());
}

/**
 * Chia các ô theo ca của từng cửa hàng. `kinds` rỗng/không truyền = mọi nhóm. Một mã có dòng ở
 * nhiều nhóm (file khai lệch giữa các ngày) vẫn là MỘT món; nhóm của món lấy theo nhóm mang
 * nhiều doanh thu nhất.
 */
export function summarizeSales(cells: SalesCell[], configs: ShiftConfigs, shiftNames: string[], kinds?: SalesKind[]): SalesSummary {
  const keep = kinds && kinds.length > 0 ? new Set(kinds) : null;
  const total = emptyMoney();
  const byShiftTable: Record<string, SalesMoney & { byKind: Record<SalesKind, SalesMoney> }> = {};
  const shiftOf = shiftTable(shiftNames, () => ({ ...emptyMoney(), byKind: perKind(emptyMoney) }));
  for (const name of [...shiftNames, NO_HOUR]) byShiftTable[name] = shiftOf(name);
  const byKind = perKind(emptyMoney);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyMoney() }));
  const items = new Map<string, SalesItemSummary & { kindWeight: Map<SalesKind, number> }>();
  for (const cell of cells) {
    if (keep && !keep.has(cell.kind)) continue;
    const shift = shiftNameAt(shiftsOf(configs, cell.branchCode), cell.hour, cell.minute);
    const bucket = (byShiftTable[shift] ??= shiftOf(shift));
    addMoney(total, cell);
    addMoney(bucket, cell);
    addMoney(bucket.byKind[cell.kind], cell);
    addMoney(byKind[cell.kind], cell);
    if (cell.hour !== null && cell.hour >= 0 && cell.hour <= 23) addMoney(byHour[cell.hour], cell);
    const code = cell.code || "(không mã)";
    let item = items.get(code);
    if (!item) {
      const itemShift = shiftTable(shiftNames, emptyMoney);
      const byShift: Record<string, SalesMoney> = {};
      for (const name of [...shiftNames, NO_HOUR]) byShift[name] = itemShift(name);
      item = { code, kind: cell.kind, ...emptyMoney(), byShift, kindWeight: new Map() };
      items.set(code, item);
    }
    addMoney(item, cell);
    addMoney((item.byShift[shift] ??= emptyMoney()), cell);
    item.kindWeight.set(cell.kind, (item.kindWeight.get(cell.kind) || 0) + Math.abs(cell.amount) + Math.abs(cell.quantity) * 1e-6);
  }
  const itemList = [...items.values()].map(({ kindWeight, ...item }) => {
    const kind = [...kindWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || item.kind;
    return { ...item, kind };
  });
  itemList.sort((a, b) => b.amount - a.amount || b.quantity - a.quantity || a.code.localeCompare(b.code));
  return { total, byShift: byShiftTable, byKind, byHour, items: itemList };
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
 * Lượt khách (khách 20/11/2026): ô gom theo ngày × cửa hàng × giờ:phút × kênh bán. `guests` = cột
 * Số khách, `bills` = số hoá đơn (chỉ có khi file có cột Số hoá đơn), `amount` = doanh thu món.
 */
export type VisitCell = {
  date: string;
  branchCode: string;
  hour: number | null;
  minute: number | null;
  channel: string;
  guests: number;
  bills: number;
  amount: number;
  total: number;
};
export type VisitMoney = { guests: number; bills: number; amount: number; total: number; /** DT món của kênh có khách — mẫu số DT/khách. */ guestAmount: number };
const emptyVisit = (): VisitMoney => ({ guests: 0, bills: 0, amount: 0, total: 0, guestAmount: 0 });

export type VisitSummary = {
  total: VisitMoney;
  byShift: Record<string, VisitMoney>;
  byDay: Array<VisitMoney & { date: string; byShift: Record<string, VisitMoney> }>;
  byChannel: Array<VisitMoney & { channel: string }>;
  /** Kênh có ghi số khách trong kỳ. Kênh giao hàng (Grab...) không có khách ngồi nên không vào DT/khách. */
  guestChannels: string[];
};

/** DT trung bình mỗi khách: chỉ lấy doanh thu của kênh có ghi số khách (bỏ Grab/giao hàng). */
export function revenuePerGuest(value: VisitMoney) {
  return value.guests > 0 ? value.guestAmount / value.guests : null;
}

export function summarizeVisits(cells: VisitCell[], configs: ShiftConfigs, shiftNames: string[]): VisitSummary {
  const guestChannels = new Set(cells.filter((cell) => cell.guests > 0).map((cell) => cell.channel));
  const add = (target: VisitMoney, cell: VisitCell) => {
    target.guests += cell.guests;
    target.bills += cell.bills;
    target.amount += cell.amount;
    target.total += cell.total;
    if (guestChannels.has(cell.channel)) target.guestAmount += cell.amount;
  };
  const makeShiftTable = () => {
    const table: Record<string, VisitMoney> = {};
    for (const name of [...shiftNames, NO_HOUR]) table[name] = emptyVisit();
    return table;
  };
  const total = emptyVisit();
  const byShift = makeShiftTable();
  const days = new Map<string, VisitMoney & { date: string; byShift: Record<string, VisitMoney> }>();
  const channels = new Map<string, VisitMoney & { channel: string }>();
  for (const cell of cells) {
    const shift = shiftNameAt(shiftsOf(configs, cell.branchCode), cell.hour, cell.minute);
    add(total, cell);
    add((byShift[shift] ??= emptyVisit()), cell);
    let day = days.get(cell.date);
    if (!day) {
      day = { date: cell.date, ...emptyVisit(), byShift: makeShiftTable() };
      days.set(cell.date, day);
    }
    add(day, cell);
    add((day.byShift[shift] ??= emptyVisit()), cell);
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
