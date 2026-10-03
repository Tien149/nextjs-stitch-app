/**
 * Phần đọc / ghi DB của Bảng giá NCC — luật nằm ở lib/supplier-price-list.ts.
 */
import { prisma } from "@/lib/prisma";
import { businessError } from "@/lib/phase3";
import { nextSeqFromCodes } from "@/lib/voucher-code-generator";
import { vnDay } from "@/lib/recipe-validity";
import {
  activePrices,
  dayToDate,
  lastDayOfMonth,
  priceDeviation,
  priceListInMonth,
  type PriceListLike,
} from "@/lib/supplier-price-list";

const lineSelect = { itemId: true, unitCode: true, conversionRate: true, unitPrice: true, vatRate: true, note: true } as const;

/** Mọi bảng giá còn sống (kèm dòng). Ít bản ghi — một NCC một bảng / tháng. */
export async function loadPriceLists(filter: { supplierCode?: string | null } = {}) {
  return prisma.supplierPriceList.findMany({
    where: filter.supplierCode ? { supplierCode: { equals: filter.supplierCode, mode: "insensitive" } } : {},
    include: { lines: { select: lineSelect } },
    orderBy: [{ effectiveFrom: "desc" }, { supplierName: "asc" }],
  });
}

/** Giá đang hiệu lực tại một ngày cho một cửa hàng (khoá `NCC|itemId`). */
export async function loadActivePrices(options: { day: string; branchCode?: string | null; supplierCode?: string | null }) {
  const lists = await loadPriceLists({ supplierCode: options.supplierCode });
  return activePrices(lists as unknown as PriceListLike[], options);
}

/** BG-YYYYMM-0001 theo tháng bắt đầu hiệu lực; tra cả bản đã xoá để không cấp trùng mã. */
export async function nextPriceListCode(fromDay: string) {
  const head = `BG-${fromDay.slice(0, 7).replace("-", "")}-`;
  const rows = await prisma.$queryRaw<Array<{ code: string }>>`SELECT "code" FROM "SupplierPriceList" WHERE "code" LIKE ${head + "%"}`;
  return head + String(nextSeqFromCodes(rows.map((row) => row.code), head)).padStart(4, "0");
}

export type PriceListInput = {
  id?: string | null;
  supplierCode: string;
  supplierName: string;
  branchCode: string | null;
  from: string;
  to: string | null;
  note?: string | null;
  source?: string;
  lines: Array<{ itemId: string; unitCode: string; conversionRate: number; unitPrice: number; vatRate: number | null; note?: string | null }>;
};

/**
 * Tạo / sửa một bảng giá. Không có `id` mà đã có bảng cùng NCC + cửa hàng + đúng khoảng ngày
 * thì GHI ĐÈ bảng đó (import lại file tháng đã sửa không đẻ ra bảng trùng).
 */
export async function savePriceList(input: PriceListInput, createdBy: string | null) {
  if (input.lines.length === 0) businessError("Bảng giá phải có ít nhất một mặt hàng");
  if (input.to && input.to < input.from) businessError("Đến ngày phải sau Từ ngày");
  const effectiveFrom = dayToDate(input.from);
  const effectiveTo = input.to ? dayToDate(input.to) : null;
  const existing = input.id
    ? await prisma.supplierPriceList.findUnique({ where: { id: input.id } })
    : await prisma.supplierPriceList.findFirst({
        where: {
          supplierCode: { equals: input.supplierCode, mode: "insensitive" },
          branchCode: input.branchCode,
          effectiveFrom,
          effectiveTo,
        },
      });
  if (input.id && !existing) businessError("Không tìm thấy bảng giá cần sửa");
  const data = {
    supplierCode: input.supplierCode,
    supplierName: input.supplierName,
    branchCode: input.branchCode,
    effectiveFrom,
    effectiveTo,
    note: input.note || null,
  };
  const lines = input.lines.map((line) => ({
    itemId: line.itemId,
    unitCode: line.unitCode,
    conversionRate: line.conversionRate > 0 ? line.conversionRate : 1,
    unitPrice: line.unitPrice,
    vatRate: line.vatRate,
    note: line.note || null,
  }));
  if (existing) {
    return prisma.$transaction(async (tx) => {
      await tx.supplierPriceListLine.deleteMany({ where: { priceListId: existing.id } });
      return tx.supplierPriceList.update({
        where: { id: existing.id },
        data: { ...data, ...(input.source ? { source: input.source } : {}), lines: { create: lines } },
        include: { lines: { select: lineSelect } },
      });
    });
  }
  return prisma.supplierPriceList.create({
    data: { ...data, code: await nextPriceListCode(input.from), source: input.source || "MANUAL", createdBy, lines: { create: lines } },
    include: { lines: { select: lineSelect } },
  });
}

export type PriceDeviationRow = {
  transactionId: string;
  code: string;
  date: string;
  branchCode: string;
  warehouseCode: string;
  supplierCode: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  quantity: number;
  actualPrice: number;
  listPrice: number;
  diff: number;
  ratio: number | null;
  /** Tiền chênh của cả dòng (trước thuế) = (giá nhập − giá bảng) × SL. */
  amount: number;
  priceListCode: string;
  listUnitCode: string;
  listUnitPrice: number;
  vatRate: number | null;
  actualVatRate: number | null;
};

/**
 * Dòng phiếu nhập mua trong tháng có đơn giá (trước thuế, theo ĐVT tồn) lệch bảng giá đang
 * hiệu lực của đúng NCC + cửa hàng tại ngày chứng từ. Dòng không có bảng giá thì bỏ qua (đếm
 * riêng ở `uncovered` để người xem biết còn bao nhiêu dòng chưa có giá để so).
 */
export async function findPriceDeviations(options: { month: string; supplierCode?: string | null; branchCodes?: string[] | null }) {
  const from = dayToDate(`${options.month}-01`);
  const toExclusive = new Date(dayToDate(lastDayOfMonth(options.month)).getTime() + 86_400_000);
  const [documents, lists] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: {
        transactionType: "NHAP_MUA",
        partnerCode: options.supplierCode ? { equals: options.supplierCode, mode: "insensitive" } : { not: null },
        transactionDate: { gte: from, lt: toExclusive },
        ...(options.branchCodes ? { branchCode: { in: options.branchCodes } } : {}),
      },
      select: {
        id: true, code: true, transactionDate: true, branchCode: true, warehouseCode: true, partnerCode: true,
        lines: { select: { itemId: true, quantity: true, unitCost: true, vatRate: true, item: { select: { code: true, name: true, unit: true } } } },
      },
      orderBy: { transactionDate: "asc" },
    }),
    loadPriceLists({ supplierCode: options.supplierCode }),
  ]);
  const monthLists = (lists as unknown as PriceListLike[]).filter((list) => priceListInMonth(list, options.month));
  const cache = new Map<string, ReturnType<typeof activePrices>>();
  const rows: PriceDeviationRow[] = [];
  let checked = 0;
  let uncovered = 0;
  for (const doc of documents) {
    const day = vnDay(doc.transactionDate);
    const key = `${day}|${doc.branchCode}`;
    if (!cache.has(key)) cache.set(key, activePrices(monthLists, { day, branchCode: doc.branchCode }));
    const prices = cache.get(key)!;
    for (const line of doc.lines) {
      const price = prices.get(`${(doc.partnerCode || "").toUpperCase()}|${line.itemId}`);
      if (!price) { uncovered += 1; continue; }
      checked += 1;
      const deviation = priceDeviation(line.unitCost, price.stockUnitPrice);
      if (deviation.matched) continue;
      rows.push({
        transactionId: doc.id,
        code: doc.code,
        date: day,
        branchCode: doc.branchCode,
        warehouseCode: doc.warehouseCode,
        supplierCode: doc.partnerCode || "",
        itemId: line.itemId,
        itemCode: line.item.code,
        itemName: line.item.name,
        unit: line.item.unit,
        quantity: line.quantity,
        actualPrice: line.unitCost,
        listPrice: price.stockUnitPrice,
        diff: deviation.diff,
        ratio: deviation.ratio,
        amount: deviation.diff * line.quantity,
        priceListCode: price.priceListCode,
        listUnitCode: price.unitCode,
        listUnitPrice: price.unitPrice,
        vatRate: price.vatRate,
        actualVatRate: line.vatRate,
      });
    }
  }
  return { rows, checked, uncovered };
}
