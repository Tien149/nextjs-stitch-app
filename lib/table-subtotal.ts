import { roundVnd } from "@/lib/round-vnd";

/**
 * Dòng CỘNG cuối bảng, kiểu subtotal của Excel (khách yêu cầu 21/09/2026).
 *
 * LUẬT: làm tròn theo TỪNG DÒNG rồi mới cộng — đúng bằng những con số đang hiện trên màn hình.
 *
 * Cộng số gốc rồi mới tròn ở tổng là cách "chính xác hơn" về toán học nhưng SAI về mục đích:
 * dòng CỘNG sinh ra để kế toán lấy máy tính cộng các dòng lại mà đối chiếu. Trên dữ liệu demo
 * hai cách lệch nhau đúng 1 đồng (51.953.330 so với 51.953.329) — chỉ một đồng thôi là người
 * dùng hết tin vào cả bảng.
 */
export function sumRoundedByRow<T>(rows: readonly T[], valueOf: (row: T) => number) {
  return rows.reduce((sum, row) => sum + roundVnd(valueOf(row)), 0);
}

/** Tổng tiền của một nhóm phiếu kho: trước thuế, thuế, và sau thuế. */
export function sumStockDocuments<T extends { lines: Array<{ totalCost: number; vatAmount?: number | null }> }>(
  documents: readonly T[],
) {
  const beforeTax = sumRoundedByRow(documents, (doc) => doc.lines.reduce((sum, line) => sum + line.totalCost, 0));
  const vat = sumRoundedByRow(documents, (doc) => doc.lines.reduce((sum, line) => sum + (line.vatAmount || 0), 0));
  return { count: documents.length, beforeTax, vat, afterTax: beforeTax + vat };
}
