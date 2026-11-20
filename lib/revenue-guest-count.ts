/**
 * Lượt khách / số hoá đơn trên file doanh thu POS thô (khách 20/11/2026).
 *
 * File POS để mỗi món một dòng; cột Số khách thường lặp lại trên mọi dòng của cùng hoá đơn. Hệ
 * thống gộp món theo ngày × giờ × kênh × nguồn tiền × mã món rồi CỘNG các cột số, nên phải dồn
 * số khách về MỘT dòng mỗi hoá đơn trước khi gộp: dòng đầu tiên của hoá đơn mang số khách (lớn
 * nhất ghi trên các dòng của hoá đơn đó) và 1 hoá đơn, các dòng sau mang 0.
 *
 * Chỉ chạy khi file có cột Số hoá đơn. Dòng không ghi số hoá đơn giữ nguyên số khách như file.
 * File thuần (không import gì) để test bằng node.
 */

type RowLike = { values: Record<string, unknown> };

function keyPart(value: unknown) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return String(value ?? "").trim().toUpperCase();
}

function guestNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function spreadBillGuestCounts<T extends RowLike>(rows: T[]): T[] {
  const bills = new Map<string, { first: T; guests: number | null }>();
  for (const row of rows) {
    const bill = keyPart(row.values.bill_code);
    if (!bill) continue;
    // Số hoá đơn chỉ duy nhất trong một cửa hàng và một ngày.
    const key = [keyPart(row.values.sale_date), keyPart(row.values.branch_code), bill].join("|");
    const guests = guestNumber(row.values.guest_count);
    const current = bills.get(key);
    if (!current) {
      bills.set(key, { first: row, guests });
      continue;
    }
    if (guests !== null && (current.guests === null || guests > current.guests)) current.guests = guests;
  }
  const firstRows = new Map<T, number | null>([...bills.values()].map((bill) => [bill.first, bill.guests]));
  return rows.map((row) => {
    if (!keyPart(row.values.bill_code)) return row;
    const isFirst = firstRows.has(row);
    const guests = isFirst ? firstRows.get(row) ?? null : null;
    return {
      ...row,
      values: {
        ...row.values,
        guest_count: isFirst ? guests : (guestNumber(row.values.guest_count) === null ? null : 0),
        order_count: isFirst ? 1 : 0,
      },
    };
  });
}
