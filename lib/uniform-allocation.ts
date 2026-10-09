import { addPeriod, buildAllocationSchedules, businessError, periodFromDate, splitAmountByPeriods } from "@/lib/phase3";
import type { TxClient } from "@/lib/prisma";
import { UNIFORM_EXPENSE_PNL_ITEM } from "@/lib/inventory-cogs";

/**
 * PHÂN BỔ ĐỒNG PHỤC KHI XUẤT DÙNG (khách chốt 09/10/2026).
 *
 * Phiếu Xuất khác có dòng đồng phục khai "Phân bổ N tháng" thì tiền đồng phục không vào chi phí
 * ngay mà treo Nợ 242 / Có 152 lúc ghi sổ giá vốn theo kho; lịch PB-<mã phiếu> (Accrual,
 * sourceType INVENTORY_ISSUE, sourceId = id phiếu) rút dần 242 vào hạng mục đồng phục mỗi kỳ —
 * cùng đường với phiếu chi trả trước / công nợ có phân bổ (Vận hành tài chính → Phân bổ).
 *
 * Trị giá xuất có thể đổi sau khi lập phiếu (sửa phiếu, xuất âm rồi mới có giá) nên mỗi lần
 * ghi sổ giá vốn lịch được dựng lại theo số mới: kỳ đã ghi nhận giữ nguyên, phần còn lại chia
 * lại cho các kỳ chưa ghi nhận.
 */

export const ISSUE_ALLOCATION_SOURCE = "INVENTORY_ISSUE";
/** Phiếu xuất dùng cho nhân viên — huỷ / kiểm kê thiếu vẫn ghi chi phí ngay. */
export const ALLOCATABLE_ISSUE_TYPES = ["XUAT_KHAC"] as const;
/** Loại mặt hàng được treo 242 khi phiếu có lịch phân bổ. */
export const ALLOCATABLE_ITEM_TYPES = ["UNIFORM"] as const;

export const issueAllocationCode = (transactionCode: string) => `PB-${transactionCode}`;

export function isAllocatableIssueType(transactionType: string | null | undefined) {
  return (ALLOCATABLE_ISSUE_TYPES as readonly string[]).includes(String(transactionType || "").toUpperCase());
}

/** Tiền đồng phục của phiếu — phần đem phân bổ. */
export function allocatableIssueAmount(lines: Array<{ totalCost: number; itemType: string | null | undefined }>) {
  return lines
    .filter((line) => (ALLOCATABLE_ITEM_TYPES as readonly string[]).includes(String(line.itemType || "").toUpperCase()))
    .reduce((sum, line) => sum + (Number(line.totalCost) || 0), 0);
}

type ScheduleRow = { period: string; amount: number; status: string };

/**
 * Lịch mới cho tổng `total`: chưa ghi nhận kỳ nào thì dựng lại từ kỳ bắt đầu; đã ghi nhận thì
 * giữ các kỳ POSTED, phần còn lại chia cho các kỳ PLANNED đang có. Trả các dòng PLANNED mới.
 */
export function replanIssueAllocation(input: { total: number; startPeriod: string; periods: number; schedules: ScheduleRow[] }) {
  const posted = input.schedules.filter((row) => row.status === "POSTED");
  if (posted.length === 0) return buildAllocationSchedules(input.startPeriod, input.total, input.periods);
  const postedSum = posted.reduce((sum, row) => sum + row.amount, 0);
  const remaining = Math.round(input.total) - postedSum;
  const planned = input.schedules.filter((row) => row.status !== "POSTED").sort((a, b) => a.period.localeCompare(b.period));
  if (remaining < 0) {
    businessError(`Đã ghi nhận phân bổ ${postedSum.toLocaleString("vi-VN")} đ, lớn hơn trị giá đồng phục mới ${Math.round(input.total).toLocaleString("vi-VN")} đ. Bỏ ghi nhận các kỳ đã phân bổ trước.`);
  }
  if (planned.length === 0) {
    if (remaining > 0) businessError("Lịch phân bổ đã ghi nhận hết các kỳ nên không nhận thêm trị giá. Bỏ ghi nhận kỳ cuối rồi sửa lại.");
    return [];
  }
  const lastPosted = posted.map((row) => row.period).sort().at(-1) || input.startPeriod;
  return splitAmountByPeriods(remaining, planned.length).map((amount, index) => ({
    period: planned[index]?.period || addPeriod(lastPosted, index + 1),
    amount,
  }));
}

type IssueDoc = {
  id: string;
  code: string;
  transactionType: string;
  transactionDate: Date;
  branchCode: string;
  note: string | null;
  lines: Array<{ totalCost: number; item: { itemType: string } }>;
};

/**
 * Đồng bộ lịch phân bổ của MỘT phiếu xuất. `months`:
 * - undefined: giữ số tháng đang có, chỉ cập nhật trị giá / kỳ bắt đầu (phiếu không có lịch thì thôi);
 * - 0: bỏ phân bổ (chặn khi đã ghi nhận kỳ nào);
 * - > 0: bật / đổi số tháng.
 */
export async function syncIssueAllocation(tx: TxClient, doc: IssueDoc, months: number | undefined, actor: string) {
  const code = issueAllocationCode(doc.code);
  // deletedAt: undefined để thấy cả lịch đã xoá mềm (mã PB- vẫn bị giữ) — dựng lại bằng upsert.
  const existing = await tx.accrual.findFirst({
    where: { code, deletedAt: undefined },
    include: { schedules: true },
  });
  const live = existing && !existing.deletedAt && existing.sourceType === ISSUE_ALLOCATION_SOURCE && existing.sourceId === doc.id ? existing : null;
  const wanted = months === undefined ? (live ? live.numberOfPeriods : 0) : months;
  const postedCount = live ? live.schedules.filter((row) => row.status === "POSTED").length : 0;

  if (!(wanted > 0)) {
    if (!live) return null;
    if (postedCount > 0) businessError(`Lịch phân bổ ${code} đã ghi nhận ${postedCount} kỳ nên không bỏ phân bổ được. Bỏ ghi nhận ở Vận hành tài chính → Phân bổ trước.`);
    await tx.accrualSchedule.deleteMany({ where: { accrualId: live.id } });
    await tx.accrual.delete({ where: { id: live.id } });
    return null;
  }
  if (!isAllocatableIssueType(doc.transactionType)) businessError("Chỉ phiếu Xuất khác mới phân bổ chi phí đồng phục theo kỳ.");
  const total = allocatableIssueAmount(doc.lines.map((line) => ({ totalCost: line.totalCost, itemType: line.item.itemType })));
  if (months !== undefined && !doc.lines.some((line) => (ALLOCATABLE_ITEM_TYPES as readonly string[]).includes(line.item.itemType))) {
    businessError("Phiếu không có dòng đồng phục nên không phân bổ được.");
  }
  if (live && postedCount > 0 && months !== undefined && months !== live.numberOfPeriods) {
    businessError(`Lịch phân bổ ${code} đã ghi nhận ${postedCount} kỳ nên không đổi số tháng được.`);
  }
  const startPeriod = live && postedCount > 0 ? live.startPeriod : periodFromDate(doc.transactionDate);
  const schedules = live ? live.schedules : [];
  const unchanged = live
    && Math.round(live.totalAmount) === Math.round(total)
    && live.numberOfPeriods === wanted
    && live.startPeriod === startPeriod
    && live.branchCode === doc.branchCode;
  if (unchanged) return live;

  const fields = {
    name: `Đồng phục xuất dùng ${doc.code}${doc.note ? ` — ${doc.note}` : ""}`,
    branchCode: doc.branchCode,
    categoryCode: "OPEX",
    pnlItemCode: UNIFORM_EXPENSE_PNL_ITEM.code,
    totalAmount: Math.round(total),
    actualAmount: Math.round(total),
    startPeriod,
    numberOfPeriods: wanted,
    status: "ACTIVE",
    sourceType: ISSUE_ALLOCATION_SOURCE,
    sourceId: doc.id,
    deletedAt: null,
    deletedBy: null,
  };
  const planned = replanIssueAllocation({ total, startPeriod, periods: wanted, schedules });
  const accrual = await tx.accrual.upsert({
    where: { code },
    create: { code, ...fields, note: `Tạo từ phiếu xuất ${doc.code}`, createdBy: actor },
    update: fields,
  });
  await tx.accrualSchedule.deleteMany({ where: { accrualId: accrual.id, status: { not: "POSTED" } } });
  if (planned.length > 0) {
    await tx.accrualSchedule.createMany({ data: planned.map((row) => ({ ...row, accrualId: accrual.id })) });
  }
  return accrual;
}
