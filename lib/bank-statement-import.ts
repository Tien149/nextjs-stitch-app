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
