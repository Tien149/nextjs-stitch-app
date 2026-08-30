/**
 * Xuất bảng đang hiển thị trên màn hình ra file Excel, dùng cho các trang có dữ liệu import
 * lên để kế toán mở lại đối chiếu xem chi tiết đã đủ chưa.
 *
 * Đọc thẳng DOM của bảng thay vì nhận mảng dữ liệu riêng, nhờ vậy file xuất ra luôn khớp
 * đúng những cột và những dòng người dùng đang nhìn thấy (đã lọc, đã tìm kiếm) — không có
 * chuyện bảng một đằng file một nẻo. Cột "Thao tác" và mọi nút bấm bị loại; số tiền định
 * dạng vi-VN được trả về kiểu số để cộng lại được ngay trong Excel.
 */

/** 1.234.567 hoặc 1.234,5 — có dấu chấm ngăn nghìn kiểu vi-VN. */
const GROUPED_NUMBER = /^-?\d{1,3}(\.\d{3})+(,\d+)?$/;
/** 1234 hoặc 12,5 — không cho số 0 đứng đầu để mã chứng từ "00012" giữ nguyên dạng chữ. */
const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(,\d+)?$/;
/** Cột chỉ chứa nút bấm, xuất ra Excel không có ý nghĩa gì. */
const IGNORED_HEADER = /thao t[áa]c|h[àa]nh đ[ộo]ng|action/i;

export type ExportTableOptions = {
  /** Tên file, không kèm đuôi và ngày — hàm tự gắn "_YYYY-MM-DD.xlsx". */
  fileName: string;
  sheetName?: string;
};

/** "Tồn kho theo kho" -> "ton_kho_theo_kho", để đặt tên file từ tiêu đề bảng. */
export function toFileSlug(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return slug || "bang_du_lieu";
}

/** "1.234.567" -> 1234567. Trả null khi không phải số để giữ nguyên chuỗi gốc. */
export function parseVietnameseNumber(text: string): number | null {
  const value = text.trim().replace(/[\s ]/g, "");
  if (!value) return null;
  if (!GROUPED_NUMBER.test(value) && !PLAIN_NUMBER.test(value)) return null;
  const parsed = Number(value.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Chữ hiển thị của một ô: bỏ icon và nút, riêng input/select lấy giá trị đang nhập. */
function readCellText(cell: HTMLTableCellElement): string {
  const clone = cell.cloneNode(true) as HTMLElement;
  for (const control of Array.from(clone.querySelectorAll("input, select, textarea"))) {
    const value =
      control instanceof HTMLSelectElement
        ? control.selectedOptions[0]?.textContent || ""
        : control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio")
          ? control.checked ? "x" : ""
          : (control as HTMLInputElement | HTMLTextAreaElement).value;
    control.replaceWith(document.createTextNode(value));
  }
  for (const noise of Array.from(clone.querySelectorAll("[data-no-export], button, .material-symbols-outlined"))) {
    noise.remove();
  }
  // Ô hai dòng (<b>mã</b><small>diễn giải</small>) rất phổ biến trong các bảng ở đây; nếu chỉ lấy
  // textContent thì hai dòng dính liền thành một chuỗi vô nghĩa nên chèn dấu phân cách.
  for (const block of Array.from(clone.querySelectorAll("br, p, div, small, li, h1, h2, h3, h4, h5, h6"))) {
    block.before(document.createTextNode(" · "));
  }
  return (clone.textContent || "")
    .replace(/\s+/g, " ")
    .replace(/(\s*·\s*){2,}/g, " · ")
    .replace(/^(\s*·\s*)+|(\s*·\s*)+$/g, "")
    .trim();
}

/** Trải bảng thành lưới chữ nhật, gỡ rowspan/colspan để Excel không lệch cột. */
function tableToGrid(table: HTMLTableElement): string[][] {
  const grid: string[][] = [];
  Array.from(table.rows).forEach((row, rowIndex) => {
    if (row.dataset.noExport !== undefined) return;
    if (!grid[rowIndex]) grid[rowIndex] = [];
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      while (grid[rowIndex][column] !== undefined) column += 1;
      const text = readCellText(cell);
      for (let spanRow = 0; spanRow < (cell.rowSpan || 1); spanRow += 1) {
        for (let spanColumn = 0; spanColumn < (cell.colSpan || 1); spanColumn += 1) {
          const target = rowIndex + spanRow;
          if (!grid[target]) grid[target] = [];
          grid[target][column + spanColumn] = spanRow === 0 && spanColumn === 0 ? text : "";
        }
      }
      column += cell.colSpan || 1;
    }
  });
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return grid.map((row) => Array.from({ length: width }, (_, index) => row?.[index] ?? ""));
}

/** Bỏ cột thao tác và các cột rỗng hoàn toàn (ô chọn, icon trạng thái không có chữ). */
function dropNoiseColumns(grid: string[][]): string[][] {
  if (grid.length === 0) return grid;
  const [header] = grid;
  const keep = header.map((title, index) => {
    if (IGNORED_HEADER.test(title)) return false;
    return grid.some((row) => (row[index] || "").trim() !== "");
  });
  if (!keep.some(Boolean)) return grid;
  return grid.map((row) => row.filter((_, index) => keep[index]));
}

/** Lưới chữ đã lọc nhiễu của một bảng — tách riêng để kiểm thử được phần bóc dữ liệu. */
export function extractTableGrid(table: HTMLTableElement): string[][] {
  return dropNoiseColumns(tableToGrid(table)).filter((row) => row.some((cell) => cell !== ""));
}

export async function exportTableToExcel(table: HTMLTableElement, options: ExportTableOptions): Promise<number> {
  const grid = extractTableGrid(table);
  const dataRowCount = Math.max(grid.length - 1, 0);
  if (dataRowCount === 0) return 0;

  // xlsx chỉ nạp khi bấm xuất — tránh cộng vào bundle của mọi trang có nút này.
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet(
    grid.map((row, rowIndex) =>
      row.map((cell) => {
        if (rowIndex === 0) return cell;
        const numeric = parseVietnameseNumber(cell);
        return numeric === null ? cell : numeric;
      }),
    ),
  );
  sheet["!cols"] = (grid[0] || []).map((_, index) => ({
    wch: Math.min(46, Math.max(10, ...grid.map((row) => (row[index] || "").length + 2))),
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, (options.sheetName || "Dữ liệu").slice(0, 31));
  XLSX.writeFile(workbook, `${options.fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  return dataRowCount;
}

/**
 * Xuất một mảng dòng đã chuẩn bị sẵn (thường là gộp đủ các trang từ API) ra Excel.
 * Dùng cho những trang phân trang phía máy chủ — nếu xuất theo DOM thì chỉ được trang đang xem.
 */
export async function exportRowsToExcel(
  rows: Array<Record<string, string | number | null | undefined>>,
  options: ExportTableOptions,
): Promise<number> {
  if (rows.length === 0) return 0;
  const XLSX = await import("xlsx");
  const columns = Object.keys(rows[0]);
  const sheet = XLSX.utils.json_to_sheet(rows, { header: columns });
  sheet["!cols"] = columns.map((column) => ({
    wch: Math.min(46, Math.max(12, column.length + 2, ...rows.slice(0, 200).map((row) => String(row[column] ?? "").length + 2))),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, (options.sheetName || "Dữ liệu").slice(0, 31));
  XLSX.writeFile(workbook, `${options.fileName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  return rows.length;
}
