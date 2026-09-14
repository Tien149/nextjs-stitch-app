import { prisma } from "@/lib/prisma";

export function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toDate(value: unknown, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function periodFromDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function normalizePeriod(value: unknown) {
  const period = cleanText(value);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) ? period : "";
}

export function addPeriod(startPeriod: string, offset: number) {
  const [year, month] = startPeriod.split("-").map(Number);
  const date = new Date(year, month - 1 + offset, 1);
  return periodFromDate(date);
}

/**
 * Client tối thiểu để tra kỳ kế toán.
 *
 * Khai theo hình dạng chứ không theo kiểu sinh sẵn của Prisma để nhận được cả `prisma`,
 * `prismaRaw` lẫn client bên trong `$transaction` — luật khoá sổ phải chạy được ở cả ba chỗ,
 * nếu không thì mỗi nơi lại tự chép một bản kiểm tra riêng như trước đây.
 */
export type PeriodLockClient = {
  accountingPeriod: {
    findFirst(args: {
      where: { period: { in: string[] }; branchCode: { in: string[] }; status: string };
      select: { period: true; branchCode: true };
    }): Promise<{ period: string; branchCode: string } | null>;
  };
};

/** Một kỳ + cửa hàng cần đụng tới. Khai bằng `date` hoặc `period`, cái nào có sẵn thì dùng. */
export type PeriodTarget = { period?: string | null; date?: Date | null; branchCode?: string | null };

function targetPeriod(target: PeriodTarget) {
  if (target.period) return normalizePeriod(target.period);
  return target.date ? periodFromDate(target.date) : "";
}

/**
 * Kỳ đã khoá sổ trong số các kỳ mà thao tác sắp đụng tới, hoặc null nếu mở hết.
 *
 * Kỳ khoá ở chính cửa hàng, hoặc khoá toàn hệ thống (branchCode "ALL"), đều tính là khoá —
 * giống hệt luật cũ. Nhận nhiều mục một lượt để thao tác chạm vào hai cửa hàng (điều chuyển
 * kho, quyết toán ví) hay hai kỳ (đổi ngày chứng từ sang tháng khác) chỉ mất một câu truy vấn.
 */
export async function findClosedPeriod(
  targets: PeriodTarget | PeriodTarget[],
  client: PeriodLockClient = prisma,
) {
  const list = Array.isArray(targets) ? targets : [targets];
  const periods = new Set<string>();
  const branches = new Set<string>(["ALL"]);
  for (const target of list) {
    const period = targetPeriod(target);
    const branchCode = cleanText(target.branchCode);
    // Thiếu kỳ hoặc thiếu cửa hàng thì không có gì để đối chiếu — bỏ qua thay vì chặn oan.
    if (!period || !branchCode) continue;
    periods.add(period);
    branches.add(branchCode);
  }
  if (periods.size === 0) return null;
  return client.accountingPeriod.findFirst({
    where: { period: { in: [...periods] }, branchCode: { in: [...branches] }, status: "CLOSED" },
    select: { period: true, branchCode: true },
  });
}

/**
 * Chặn thao tác khi kỳ kế toán liên quan đã khoá sổ.
 *
 * Đây là CỬA DUY NHẤT của luật "khoá sổ là không sửa được nữa". Mọi thao tác ghi đè lên số
 * liệu có ngày tháng — sửa, xoá, duyệt, mở lại — đều phải đi qua đây, kể cả nhánh mở lại: mở
 * lại một kỳ đã chốt sổ thì đúng bằng sửa số của kỳ đó.
 *
 * `what` là động từ người dùng vừa bấm ("xoá phiếu", "mở lại khấu hao") để câu báo lỗi nói
 * đúng việc họ đang làm chứ không phải một câu chung chung.
 */
export async function assertPeriodOpen(
  targets: PeriodTarget | PeriodTarget[],
  what: string,
  client: PeriodLockClient = prisma,
) {
  const closed = await findClosedPeriod(targets, client);
  if (closed) businessError(closedPeriodMessage(closed, what));
}

/**
 * Câu báo lỗi khoá sổ, dùng chung cho cả nhánh ném lỗi lẫn các màn tự trả JSON.
 *
 * Một câu duy nhất cho toàn hệ thống: người dùng gặp đúng chữ đó ở Phiếu chi, Tiền cọc hay
 * Thùng rác thì biết ngay là cùng một nguyên nhân và cùng một cách gỡ.
 */
export function closedPeriodMessage(closed: { period: string; branchCode: string }, what: string) {
  const scope = closed.branchCode === "ALL" ? "toàn hệ thống" : `cửa hàng ${closed.branchCode}`;
  return `Kỳ ${closed.period} của ${scope} đã khoá sổ nên không ${what} được. Mở lại kỳ ở màn Sổ cái Kế toán rồi thao tác lại.`;
}

/** Dạng true/false cho nơi chỉ cần rẽ nhánh chứ không muốn ném lỗi. */
export async function isPeriodLocked(date: Date, branchCode: string) {
  return Boolean(await findClosedPeriod({ date, branchCode }));
}

export function apiError(error: unknown, fallback = "Internal Server Error") {
  console.error(error);
  const message = error instanceof Error && error.message.startsWith("BUSINESS:")
    ? error.message.slice("BUSINESS:".length)
    : fallback;
  return { message, status: message === fallback ? 500 : 400 };
}

export function businessError(message: string): never {
  throw new Error(`BUSINESS:${message}`);
}
