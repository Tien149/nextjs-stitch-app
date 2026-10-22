import { prisma } from "@/lib/prisma";
import { REVENUE_SVC_CATEGORY_CODE, REVENUE_VAT_CATEGORY_CODE } from "@/lib/revenue-pos-journal";

/**
 * Số liệu P&L THỰC TẾ của các tháng trước khi lên phần mềm (khách chốt 19/10/2026: "có 1 trường
 * chị nhập dữ liệu trước 1/8 là ok để lên dashboard nhìn cho tổng quan", tách theo nhà hàng, y như
 * Dự báo P&L, SVC để chung trong doanh thu).
 *
 * Luật:
 *  - Chỉ nhập được tháng TRƯỚC `PNL_HISTORY_CUTOFF` (tháng đầu tiên chạy phần mềm).
 *  - Tháng × nhà hàng nào có số nhập tay thì mọi báo cáo P&L lấy số nhập tay và BỎ số hệ thống
 *    của đúng tháng × nhà hàng đó (vài bút toán tài sản / đầu kỳ lẻ tẻ trước 08/2026) — không
 *    cộng trùng.
 *  - Không sinh bút toán, không đụng quỹ / công nợ / tồn kho / bảng cân đối.
 *
 * metric:
 *  - `revenue:FOOD|DRINK|SERVICE` — doanh thu Bếp / Bar / Phụ thu (đã gồm SVC);
 *  - `pnlItem:<mã>` — hạng mục P&L (giá vốn, nhân sự, CAPEX, OPEX, chi phí khác), hoặc mã NHÓM
 *    thu nhập khác chưa có hạng mục con (cây P&L cộng thẳng vào nhóm đó).
 */
export const PNL_HISTORY_CUTOFF = "2026-08";
export const PNL_HISTORY_REVENUE_PREFIX = "revenue:";
export const PNL_HISTORY_ITEM_PREFIX = "pnlItem:";
/**
 * `category`: dòng doanh thu có danh mục riêng như lúc ghi sổ file POS (SVC, thuế GTGT — khách
 * 21/10/2026 thêm hai dòng này) thay vì quy nhóm theo chữ mẫu.
 */
export const PNL_HISTORY_REVENUE_KINDS: ReadonlyArray<{ kind: string; sample: string; label: string; category?: string }> = [
  { kind: "FOOD", sample: "Đồ ăn", label: "Doanh thu Bếp" },
  { kind: "DRINK", sample: "Đồ uống", label: "Doanh thu Bar" },
  { kind: "SERVICE", sample: "Dịch vụ", label: "Doanh thu Phụ thu" },
  { kind: "SVC", sample: "Dịch vụ", label: "Phụ thu SVC", category: REVENUE_SVC_CATEGORY_CODE },
  { kind: "VAT", sample: "Dịch vụ", label: "Thuế GTGT", category: REVENUE_VAT_CATEGORY_CODE },
];

/**
 * Doanh thu theo NGUỒN (kênh bán — khách 22/10/2026): `channel:<TÊN KÊNH IN HOA>`, cùng khoá với
 * cột Kênh bán của file POS (Tại chỗ / Mang về / Grab). Chỉ là cách TÁCH phần doanh thu Bếp + Bar
 * + Phụ thu ở trên theo kênh, không cộng thêm vào doanh thu; phần chưa tách đứng dòng "chưa tách
 * nguồn". SVC và thuế GTGT không thuộc kênh nào (giống Dự báo P&L).
 */
export const PNL_HISTORY_CHANNEL_PREFIX = "channel:";
export const PNL_HISTORY_DEFAULT_CHANNELS = ["Tại chỗ", "Mang về", "Grab"];
export const pnlHistoryChannelMetric = (channel: string) => `${PNL_HISTORY_CHANNEL_PREFIX}${channel.trim().toUpperCase()}`;
export const isPnlHistoryChannelMetric = (metric: string) => metric.startsWith(PNL_HISTORY_CHANNEL_PREFIX);

/** Bộ phận của doanh thu nhập tay: Bếp → KIT, Bar → BAR (cùng mã với REVENUE_DEPARTMENT_CODES). */
export function pnlHistoryRevenueDepartment(kind: string | null) {
  return kind === "FOOD" ? "KIT" : kind === "DRINK" ? "BAR" : null;
}

export function isPnlHistoryPeriod(period: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period) && period < PNL_HISTORY_CUTOFF;
}

type HistoryEntry = { period: string; branchCode: string; metric: string; amount: number };
type CatalogItem = { code: string; name: string; group?: string | null; subGroup?: string | null };
type CatalogGroup = { code: string; name: string; group?: string | null };

/** Một dòng giả lập bút toán để các báo cáo P&L cộng số nhập tay qua đúng đường như số hệ thống. */
export type PnlHistoryLine = {
  period: string;
  branchCode: string;
  account: { accountType: string; reportGroup: string };
  pnlItemCode: string | null;
  /** Doanh thu: chữ mẫu Đồ ăn / Đồ uống / Dịch vụ — báo cáo quy ra nhóm doanh thu bằng groupOf. */
  revenueSample: string | null;
  revenueKind: string | null;
  /** Danh mục doanh thu cố định (REV_SVC / REV_VAT) — có thì báo cáo dùng thay cho groupOf(mẫu). */
  revenueCategory?: string | null;
  debit: number;
  credit: number;
};

export type PnlHistory = {
  entries: HistoryEntry[];
  /** true khi tháng × nhà hàng này đã có số nhập tay — báo cáo bỏ số hệ thống của nó. */
  covers: (period: string, branchCode: string) => boolean;
};

const EMPTY_HISTORY: PnlHistory = { entries: [], covers: () => false };

/** Số nhập tay trong khoảng kỳ [firstPeriod, lastPeriod] của một nhà hàng (ALL = mọi nhà hàng). */
export async function loadPnlHistory(firstPeriod: string, lastPeriod: string, branchCode: string): Promise<PnlHistory> {
  if (firstPeriod >= PNL_HISTORY_CUTOFF) return EMPTY_HISTORY;
  const entries = await prisma.pnlHistoryEntry.findMany({
    where: {
      period: { gte: firstPeriod, lte: lastPeriod, lt: PNL_HISTORY_CUTOFF },
      ...(branchCode === "ALL" ? {} : { branchCode }),
    },
    select: { period: true, branchCode: true, metric: true, amount: true },
  }).catch((error: unknown) => {
    // Bảng mới: môi trường chưa chạy migration thì báo cáo vẫn phải lên, chỉ thiếu số cũ.
    console.error("Không đọc được số liệu P&L trước khi lên phần mềm (bỏ qua):", error);
    return [] as HistoryEntry[];
  });
  // Chỉ nhập tách kênh mà chưa nhập doanh thu / chi phí thì chưa tính là tháng đã nhập tay.
  const covered = new Set(entries.filter((entry) => !isPnlHistoryChannelMetric(entry.metric)).map((entry) => `${entry.period}|${entry.branchCode.toUpperCase()}`));
  return { entries, covers: (period, code) => covered.has(`${period}|${String(code || "").toUpperCase()}`) };
}

/**
 * Đổi số nhập tay thành dòng giả lập bút toán theo loại của hạng mục P&L. Mã không còn trong danh
 * mục thì bỏ qua (khách xoá hạng mục sau khi nhập).
 */
export function pnlHistoryLines(entries: HistoryEntry[], pnlItems: CatalogItem[], pnlGroups: CatalogGroup[]): PnlHistoryLine[] {
  const itemByCode = new Map(pnlItems.map((item) => [item.code, item]));
  const groupByCode = new Map(pnlGroups.map((group) => [group.code, group]));
  const lines: PnlHistoryLine[] = [];
  for (const entry of entries) {
    const amount = Number(entry.amount) || 0;
    if (Math.abs(amount) < 0.5) continue;
    const base = { period: entry.period, branchCode: entry.branchCode, revenueSample: null, revenueKind: null };
    if (entry.metric.startsWith(PNL_HISTORY_REVENUE_PREFIX)) {
      const kind = PNL_HISTORY_REVENUE_KINDS.find((option) => option.kind === entry.metric.slice(PNL_HISTORY_REVENUE_PREFIX.length));
      if (!kind) continue;
      lines.push({ ...base, account: { accountType: "REVENUE", reportGroup: "REVENUE" }, pnlItemCode: null, revenueSample: kind.sample, revenueKind: kind.kind, revenueCategory: kind.category || null, debit: 0, credit: amount });
      continue;
    }
    if (!entry.metric.startsWith(PNL_HISTORY_ITEM_PREFIX)) continue;
    const code = entry.metric.slice(PNL_HISTORY_ITEM_PREFIX.length);
    const item = itemByCode.get(code);
    const type = String((item ? (item.subGroup ? groupByCode.get(item.subGroup)?.group : null) ?? item.group : groupByCode.get(code)?.group) || "").toUpperCase();
    // Mã nhóm chỉ nhận cho Thu nhập khác (nhóm chưa có hạng mục con) — cây P&L cộng thẳng vào nhóm.
    if (!item && type !== "OTHER_INCOME") continue;
    if (type === "OTHER_INCOME") {
      lines.push({ ...base, account: { accountType: "OTHER_INCOME", reportGroup: "" }, pnlItemCode: code, debit: 0, credit: amount });
    } else if (type === "COGS") {
      lines.push({ ...base, account: { accountType: "COGS", reportGroup: "COGS" }, pnlItemCode: code, debit: amount, credit: 0 });
    } else if (type === "OTHER_EXPENSE") {
      lines.push({ ...base, account: { accountType: "OTHER_EXPENSE", reportGroup: "" }, pnlItemCode: code, debit: amount, credit: 0 });
    } else if (type === "OPEX" || type === "CAPEX") {
      // Nhân sự / CAPEX / khấu hao suy theo hạng mục (pnlLineKeyOf) như phiếu chi gắn hạng mục.
      lines.push({ ...base, account: { accountType: "OPEX", reportGroup: "" }, pnlItemCode: code, debit: amount, credit: 0 });
    }
  }
  return lines;
}
