import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import type { SourceCell } from "@/lib/import-parser";

/** Trần số dòng một lần xuất — quá thì chia nhỏ khoảng ngày. */
export const REVENUE_SOURCE_EXPORT_LIMIT = 300_000;

type Batch = { id: string; committedAt: Date | null; createdAt: Date; headers: string[] };

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Ghép tiêu đề của nhiều lô nạp: lô đầu giữ nguyên thứ tự cột; lô sau cùng tiêu đề thì chép thẳng,
 * khác tiêu đề thì đặt từng cột vào cột cùng tên (thêm cột mới ở cuối nếu chưa có).
 */
export function mergeSourceHeaders(batches: Array<{ id: string; headers: string[] }>) {
  const master: string[] = [];
  const columnMaps = new Map<string, number[]>();
  for (const batch of batches) {
    if (master.length === 0) {
      master.push(...batch.headers);
      columnMaps.set(batch.id, batch.headers.map((_, index) => index));
      continue;
    }
    if (batch.headers.length === master.length && batch.headers.every((header, index) => header === master[index])) {
      columnMaps.set(batch.id, batch.headers.map((_, index) => index));
      continue;
    }
    const used = new Set<number>();
    columnMaps.set(batch.id, batch.headers.map((header) => {
      let target = master.findIndex((name, index) => !used.has(index) && name === header && header !== "");
      if (target < 0) {
        master.push(header);
        target = master.length - 1;
      }
      used.add(target);
      return target;
    }));
  }
  return { headers: master, columnMaps };
}

function toSheetCell(cell: SourceCell | undefined): XLSX.CellObject | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "object") return { t: "n", v: cell.v, z: cell.z };
  if (typeof cell === "number") return { t: "n", v: cell };
  if (typeof cell === "boolean") return { t: "b", v: cell };
  return { t: "s", v: cell };
}

/**
 * Xuất lại file doanh thu ĐÚNG như lúc nạp (khách 25/11/2026: đẩy lên 10.000 dòng thì xuất xuống
 * cũng 10.000 dòng, không đổi vị trí hàng): mọi cột, đúng thứ tự cột và thứ tự dòng của file, theo
 * thứ tự lô nạp. Chỉ lấy dòng gốc của dòng doanh thu còn trên sổ (xoá ngày/xoá dòng thì dòng gốc
 * cũng không xuất). File nạp trước khi có dòng gốc thì đếm riêng ở `missingRows`.
 */
export async function getRevenueSourceExport(from: string, to: string, branchCode: string) {
  const start = new Date(`${from}T00:00:00+07:00`);
  const end = new Date(`${to}T24:00:00+07:00`);
  const revenueWhere = { saleDate: { gte: start, lt: end }, deletedAt: null, ...(branchCode === "ALL" ? {} : { branchCode }) };
  const [lines, missingRows] = await Promise.all([
    prisma.revenueImportSourceLine.findMany({
      where: { revenueRow: revenueWhere },
      select: { importBatchId: true, rowNumber: true, cellsJson: true },
      take: REVENUE_SOURCE_EXPORT_LIMIT + 1,
    }),
    prisma.revenueImportRow.count({ where: { ...revenueWhere, sourceLines: { none: {} } } }),
  ]);
  const truncated = lines.length > REVENUE_SOURCE_EXPORT_LIMIT;
  if (truncated) lines.length = REVENUE_SOURCE_EXPORT_LIMIT;

  const batchIds = [...new Set(lines.map((line) => line.importBatchId))];
  const batches: Batch[] = (await prisma.importBatch.findMany({
    where: { id: { in: batchIds } },
    select: { id: true, committedAt: true, createdAt: true, sourceHeadersJson: true },
  }))
    .map((batch) => ({ id: batch.id, committedAt: batch.committedAt, createdAt: batch.createdAt, headers: parseJson<string[]>(batch.sourceHeadersJson, []) }))
    .sort((left, right) => (left.committedAt || left.createdAt).getTime() - (right.committedAt || right.createdAt).getTime());
  const batchOrder = new Map(batches.map((batch, index) => [batch.id, index]));
  lines.sort((left, right) => (batchOrder.get(left.importBatchId) ?? 0) - (batchOrder.get(right.importBatchId) ?? 0) || left.rowNumber - right.rowNumber);

  const { headers, columnMaps } = mergeSourceHeaders(batches);
  const sheet: XLSX.WorkSheet = {};
  let maxColumn = Math.max(headers.length - 1, 0);
  headers.forEach((header, column) => {
    if (header) sheet[XLSX.utils.encode_cell({ r: 0, c: column })] = { t: "s", v: header };
  });
  lines.forEach((line, index) => {
    const cells = parseJson<SourceCell[]>(line.cellsJson, []);
    const map = columnMaps.get(line.importBatchId) || [];
    cells.forEach((cell, sourceColumn) => {
      const value = toSheetCell(cell);
      if (!value) return;
      const column = map[sourceColumn] ?? sourceColumn;
      maxColumn = Math.max(maxColumn, column);
      sheet[XLSX.utils.encode_cell({ r: index + 1, c: column })] = value;
    });
  });
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lines.length, c: maxColumn } });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Import doanh thu");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
  return { buffer, lineCount: lines.length, missingRows, truncated };
}
