import type { ParsedImportRow } from "@/lib/import-parser";

function text(value: unknown) {
  return String(value || "").trim();
}

function amount(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function bankStatementImportKey(row: ParsedImportRow) {
  return `${text(row.values.bank_account).toUpperCase()}|${text(row.values.transaction_code).toUpperCase()}`;
}

/**
 * Khoá "nghi trùng" của một giao dịch sao kê: tài khoản + ngày + số tiền, KHÔNG có số tham chiếu.
 *
 * Chống trùng cứng chạy theo `bankStatementImportKey` (tài khoản + số tham chiếu) vì đó là ràng
 * buộc @@unique của bảng. Nhưng file khách sửa rồi import lại hay đổi chính cột số tham chiếu
 * (bị cắt bớt, đổi định dạng), nên cùng một lần chuyển tiền của ngân hàng lọt vào sổ hai lần —
 * và dòng thừa đó cộng thêm vào "Tiền đã vô" của báo cáo Tiền về đủ chưa.
 *
 * Ngày quy về YYYY-MM-DD theo UTC (sao kê lưu UTC nửa đêm) và số tiền làm tròn về đồng, để dòng
 * trong file và dòng đã nằm trong CSDL so được với nhau.
 */
export function bankStatementSuspectKey(
  bankAccount: unknown,
  date: Date,
  debitAmount: number,
  creditAmount: number,
) {
  return [
    text(bankAccount).toUpperCase(),
    date.toISOString().slice(0, 10),
    Math.round(amount(debitAmount)),
    Math.round(amount(creditAmount)),
  ].join("|");
}

export type BankStatementImportGroup = {
  key: string;
  rows: ParsedImportRow[];
  debitTotal: number;
  creditTotal: number;
  debitAmount: number;
  creditAmount: number;
  isNetZero: boolean;
  isMultiAllocation: boolean;
};

export function groupBankStatementRows(rows: ParsedImportRow[]): BankStatementImportGroup[] {
  const grouped = new Map<string, ParsedImportRow[]>();
  for (const row of rows) {
    const key = bankStatementImportKey(row);
    const current = grouped.get(key) || [];
    current.push(row);
    grouped.set(key, current);
  }

  return [...grouped.entries()].map(([key, groupRows]) => {
    const debitTotal = groupRows.reduce((sum, row) => sum + amount(row.values.debit_amount), 0);
    const creditTotal = groupRows.reduce((sum, row) => sum + amount(row.values.credit_amount), 0);
    const net = Math.round((creditTotal - debitTotal) * 100) / 100;
    return {
      key,
      rows: groupRows,
      debitTotal,
      creditTotal,
      debitAmount: net < 0 ? Math.abs(net) : 0,
      creditAmount: net > 0 ? net : 0,
      isNetZero: Math.abs(net) < 0.01,
      isMultiAllocation: groupRows.length > 1 && (debitTotal === 0 || creditTotal === 0),
    };
  });
}

export function commonBankValue(rows: ParsedImportRow[], field: string) {
  const values = [...new Set(rows.map((row) => text(row.values[field])).filter(Boolean))];
  return values.length === 1 ? values[0] : "";
}
