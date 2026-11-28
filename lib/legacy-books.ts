import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { businessError } from "@/lib/phase3";
import { rowSearchText } from "@/lib/legacy-books-search";

/**
 * "Sổ sách kế toán trước 08/2026" (khách 28/11/2026): kho lưu file Excel sổ sách cũ để tra cứu.
 * Chỉ lưu trữ — không đụng bút toán, P&L, Bảng cân đối. File gốc lưu nguyên (tải lại đúng file),
 * mỗi dòng có chữ của mỗi sheet thành một LegacyBookRow để tìm một lần trên mọi file.
 */

/** nginx trên VPS nhận tối đa 27 MB một lần gửi. */
export const LEGACY_BOOK_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 600_000;
const MAX_CELL_CHARS = 2000;
const INSERT_CHUNK = 1000;

export type LegacySheetInfo = { index: number; name: string; rows: number; lastRow: number; columns: number };

type ParsedRow = { sheetIndex: number; sheetName: string; rowNo: number; cells: string[] };

/** Đọc mọi sheet thành các dòng chữ như Excel hiển thị (số/ngày theo định dạng ô). Bỏ dòng trống, giữ số dòng thật. */
export function parseLegacyWorkbook(buffer: Buffer) {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, cellText: true, cellHTML: false, cellFormula: false });
  } catch {
    businessError("Không đọc được file — chỉ nhận Excel (.xlsx, .xls, .xlsm) hoặc .csv.");
  }
  const sheets: LegacySheetInfo[] = [];
  const rows: ParsedRow[] = [];
  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name];
    if (!sheet || !sheet["!ref"]) {
      sheets.push({ index, name, rows: 0, lastRow: 0, columns: 0 });
      return;
    }
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
    let count = 0;
    let lastRow = 0;
    let columns = 0;
    matrix.forEach((values, offset) => {
      const cells = (values || []).map((value) => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_CELL_CHARS));
      while (cells.length > 0 && !cells[cells.length - 1]) cells.pop();
      if (cells.length === 0) return;
      const rowNo = range.s.r + offset + 1;
      // Cột đầu của vùng dữ liệu có thể không phải cột A — đệm ô trống để cột hiển thị đúng chữ cái.
      const padded = range.s.c > 0 ? [...Array(range.s.c).fill(""), ...cells] : cells;
      rows.push({ sheetIndex: index, sheetName: name, rowNo, cells: padded });
      count += 1;
      lastRow = rowNo;
      columns = Math.max(columns, padded.length);
      if (rows.length > MAX_ROWS) businessError(`File quá lớn (hơn ${MAX_ROWS.toLocaleString("vi-VN")} dòng) — tách thành nhiều file rồi tải lên.`);
    });
    sheets.push({ index, name, rows: count, lastRow, columns });
  });
  if (rows.length === 0) businessError("File không có dòng dữ liệu nào.");
  return { sheets, rows };
}

export async function saveLegacyBook(input: {
  fileName: string;
  mimeType: string | null;
  buffer: Buffer;
  branchCode: string;
  periodLabel: string;
  note: string;
  uploadedBy: string;
}) {
  if (input.buffer.length === 0) businessError("File rỗng.");
  if (input.buffer.length > LEGACY_BOOK_MAX_BYTES) businessError("File lớn hơn 25 MB — tách thành nhiều file rồi tải lên.");
  const { sheets, rows } = parseLegacyWorkbook(input.buffer);
  const file = await prisma.legacyBookFile.create({
    data: {
      fileName: input.fileName,
      mimeType: input.mimeType,
      fileSize: input.buffer.length,
      content: input.buffer,
      branchCode: input.branchCode,
      periodLabel: input.periodLabel,
      note: input.note,
      sheetsJson: sheets,
      rowCount: rows.length,
      uploadedBy: input.uploadedBy,
    },
    select: { id: true },
  });
  try {
    for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
      await prisma.legacyBookRow.createMany({
        data: rows.slice(start, start + INSERT_CHUNK).map((row) => ({
          fileId: file.id,
          sheetIndex: row.sheetIndex,
          sheetName: row.sheetName,
          rowNo: row.rowNo,
          cells: row.cells,
          searchText: rowSearchText(row.cells),
        })),
      });
    }
  } catch (error) {
    // Nạp dở thì bỏ cả file, tránh file thiếu dòng mà người dùng tưởng đã tìm đủ.
    await prisma.legacyBookFile.delete({ where: { id: file.id } }).catch(() => undefined);
    throw error;
  }
  return { id: file.id, rowCount: rows.length, sheetCount: sheets.length };
}

/** Điều kiện cửa hàng: tài khoản đủ quyền thấy mọi file; bị giới hạn thì chỉ file của cửa hàng được gán. */
export function legacyBranchScope(allowedBranches: string[] | undefined | null) {
  const allowed = (allowedBranches || []).map((code) => code.toUpperCase());
  if (allowed.length === 0 || allowed.includes("ALL")) return null;
  return allowed;
}
