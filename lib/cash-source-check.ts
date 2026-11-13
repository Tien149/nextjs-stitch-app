import { Prisma } from "@prisma/custom-client";
import { prisma } from "@/lib/prisma";
import { addPeriod } from "@/lib/phase3";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { cashbookTotalsBySource, type CashbookSourceTotals } from "@/lib/cashbook-entries";

/**
 * ĐỐI CHIẾU SỔ QUỸ – NGUỒN TIỀN (khách 13/11/2026: KCF - Vietinbank sổ quỹ 0 đ mà báo cáo nguồn
 * tiền âm 31 triệu — 4 dòng sao kê 05/08 nạp hai lần bằng hai file khác nhau).
 *
 * Hai màn cố ý đọc hai nguồn khác nhau: Sổ quỹ đọc CHỨNG TỪ (phiếu thu/chi, điều chỉnh, điều
 * tiền), báo cáo Nguồn tiền đọc SỔ SAO KÊ cho tài khoản ngân hàng (chứng từ chỉ thế chỗ khi chưa
 * khớp dòng sao kê). Dữ liệu sạch thì hai bên bằng nhau; lệch là dấu hiệu phải soát: dòng sao kê
 * nạp trùng, dòng sao kê chưa có chứng từ, chứng từ gắn nhầm nguồn tiền / nhầm ngày.
 *
 * Chỉ so quỹ tiền mặt và tài khoản ngân hàng — ví/cổng thanh toán bên Nguồn tiền tính theo ngày
 * doanh thu nên lệch sổ quỹ là đương nhiên, so vào chỉ ra cảnh báo giả.
 */

/** Một dòng của bảng Biến động nguồn tiền (getCashSourceReport().sources) — đủ cột cần so. */
export type CashSourceFlowLike = {
  code: string;
  memberCodes: string[];
  name: string;
  group: string | null;
  branchCode: string;
  opening: number;
  in: number;
  out: number;
  transferIn: number;
  transferOut: number;
  closing: number;
};

export type CashSourceCheckSide = { opening: number; receipt: number; payment: number; closing: number };
export type CashSourceCheckRow = {
  key: string;
  branchCode: string;
  name: string;
  codes: string[];
  group: string;
  cashbook: CashSourceCheckSide;
  report: CashSourceCheckSide;
  openingDiff: number;
  movementDiff: number;
  closingDiff: number;
  matched: boolean;
  negativeCashbook: boolean;
  negativeReport: boolean;
};

const TOLERANCE = 1;
const round = (value: number) => Math.round(value);

export function compareCashSources(sources: CashSourceFlowLike[], cashbook: Map<string, CashbookSourceTotals>): CashSourceCheckRow[] {
  return sources
    .filter((row) => ["CASH", "BANK"].includes(normalizeMoneySourceGroup(row.group)))
    .map((row) => {
      const codes = row.memberCodes.length ? row.memberCodes : [row.code];
      const book = codes.reduce<CashSourceCheckSide>((sum, code) => {
        const totals = cashbook.get(code);
        if (!totals) return sum;
        return { opening: sum.opening + totals.opening, receipt: sum.receipt + totals.receipt, payment: sum.payment + totals.payment, closing: sum.closing + totals.closing };
      }, { opening: 0, receipt: 0, payment: 0, closing: 0 });
      const report = { opening: row.opening, receipt: row.in + row.transferIn, payment: row.out + row.transferOut, closing: row.closing };
      const openingDiff = round(report.opening - book.opening);
      const closingDiff = round(report.closing - book.closing);
      const movementDiff = closingDiff - openingDiff;
      return {
        key: `${row.branchCode}|${codes.join(",")}`,
        branchCode: row.branchCode,
        name: row.name,
        codes,
        group: normalizeMoneySourceGroup(row.group),
        cashbook: book,
        report,
        openingDiff,
        movementDiff,
        closingDiff,
        matched: Math.abs(openingDiff) <= TOLERANCE && Math.abs(closingDiff) <= TOLERANCE,
        negativeCashbook: round(book.closing) < -TOLERANCE,
        negativeReport: round(report.closing) < -TOLERANCE,
      };
    });
}

export type SuspectBankLine = {
  bankAccount: string;
  transactionCode: string;
  transactionDate: string;
  debitAmount: number;
  creditAmount: number;
  description: string;
  reconcileStatus: string;
  fileName: string | null;
  importedAt: string;
};

/**
 * Dòng sao kê NẠP TRÙNG: cùng tài khoản + ngày + số tiền + diễn giải nhưng đến từ hai lần import
 * khác nhau. Mã giao dịch khác nhau (mỗi file đánh số riêng) nên ràng buộc unique không chặn
 * được. Quét cả lịch sử tới hết kỳ vì số dư đầu kỳ lệch là do các tháng trước.
 */
async function duplicateBankLines(codes: string[], end: Date): Promise<SuspectBankLine[][]> {
  if (codes.length === 0) return [];
  const rows = await prisma.$queryRaw<Array<SuspectBankLine & { groupKey: string }>>(Prisma.sql`
    WITH candidates AS (
      SELECT t.*
      FROM "BankStatementTransaction" t
      WHERE t."deletedAt" IS NULL AND t."transactionDate" < ${end}
        AND (t."bankAccount" IN (${Prisma.join(codes)})
          OR t."summaryMoneySourceCode" IN (${Prisma.join(codes)})
          OR t."increaseMoneySourceCode" IN (${Prisma.join(codes)})
          OR t."decreaseMoneySourceCode" IN (${Prisma.join(codes)}))
    ), groups AS (
      SELECT "bankAccount", ("transactionDate" + interval '7 hours')::date AS day, "debitAmount", "creditAmount", description
      FROM candidates
      GROUP BY 1, 2, 3, 4, 5
      HAVING count(*) > 1 AND count(DISTINCT "importBatchId") > 1
    )
    SELECT c."bankAccount", c."transactionCode", to_char(c."transactionDate" + interval '7 hours', 'YYYY-MM-DD') AS "transactionDate",
           c."debitAmount", c."creditAmount", c.description, c."reconcileStatus", b."fileName",
           to_char(b."createdAt" + interval '7 hours', 'YYYY-MM-DD HH24:MI') AS "importedAt",
           concat_ws('|', g."bankAccount", g.day, g."debitAmount", g."creditAmount", g.description) AS "groupKey"
    FROM candidates c
    JOIN groups g ON g."bankAccount" = c."bankAccount" AND g.day = (c."transactionDate" + interval '7 hours')::date
      AND g."debitAmount" = c."debitAmount" AND g."creditAmount" = c."creditAmount" AND g.description = c.description
    LEFT JOIN "ImportBatch" b ON b.id = c."importBatchId"
    ORDER BY c."transactionDate" DESC, c."bankAccount", c."debitAmount", c."creditAmount", b."createdAt"
    LIMIT 400
  `);
  const groups = new Map<string, SuspectBankLine[]>();
  for (const { groupKey, ...row } of rows) {
    groups.set(groupKey, [...(groups.get(groupKey) || []), { ...row, debitAmount: Number(row.debitAmount), creditAmount: Number(row.creditAmount) }]);
  }
  return [...groups.values()];
}

/**
 * Dòng sao kê CHƯA KHỚP chứng từ trong kỳ: báo cáo Nguồn tiền đã tính (sổ sao kê là bản ghi
 * chính) nhưng sổ quỹ chưa có phiếu tương ứng. Bỏ điều tiền nội bộ và nghiệp vụ cọc — hai loại
 * này báo cáo nguồn tiền không đọc từ sao kê.
 */
async function unmatchedBankLines(codes: string[], start: Date, end: Date): Promise<SuspectBankLine[]> {
  if (codes.length === 0) return [];
  const rows = await prisma.bankStatementTransaction.findMany({
    where: {
      deletedAt: null,
      transactionDate: { gte: start, lt: end },
      reconcileStatus: { in: ["UNMATCHED", "PENDING_REVIEW"] },
      depositCode: null,
      NOT: { operationType: { in: ["INTERNAL_TRANSFER", "DEPOSIT_RECEIPT", "DEPOSIT_REFUND"] } },
      OR: [
        { bankAccount: { in: codes } },
        { summaryMoneySourceCode: { in: codes } },
        { increaseMoneySourceCode: { in: codes } },
        { decreaseMoneySourceCode: { in: codes } },
      ],
    },
    include: { importBatch: { select: { fileName: true, createdAt: true } } },
    orderBy: { transactionDate: "desc" },
    take: 200,
  });
  const vnDay = (date: Date) => new Date(date.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return rows.map((row) => ({
    bankAccount: row.bankAccount,
    transactionCode: row.transactionCode,
    transactionDate: vnDay(row.transactionDate),
    debitAmount: row.debitAmount,
    creditAmount: row.creditAmount,
    description: row.description,
    reconcileStatus: row.reconcileStatus,
    fileName: row.importBatch?.fileName || null,
    importedAt: new Date(row.importBatch.createdAt.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " "),
  }));
}

export type CashSourceCheck = {
  period: string;
  rows: CashSourceCheckRow[];
  duplicates: SuspectBankLine[][];
  unmatched: SuspectBankLine[];
};

/**
 * `sources` = bảng Biến động nguồn tiền của ĐÚNG kỳ đang xem (đã tính sẵn ở báo cáo), để không
 * phải chạy lại báo cáo nguồn tiền (3–6 giây) chỉ để so.
 */
export async function cashSourceCheck(period: string, branchCode: string, sources: CashSourceFlowLike[]): Promise<CashSourceCheck> {
  const start = new Date(`${period}-01T00:00:00`);
  const end = new Date(`${addPeriod(period, 1)}-01T00:00:00`);
  const cashbook = await cashbookTotalsBySource(period, branchCode);
  const rows = compareCashSources(sources, cashbook);
  const mismatchedBankCodes = [...new Set(rows.filter((row) => !row.matched && row.group === "BANK").flatMap((row) => row.codes))];
  const [duplicates, unmatched] = await Promise.all([
    duplicateBankLines(mismatchedBankCodes, end),
    unmatchedBankLines(mismatchedBankCodes, start, end),
  ]);
  return { period, rows, duplicates, unmatched };
}

/** Câu cảnh báo khi khoá sổ: nguồn tiền âm cuối kỳ (bên nào âm) và nguồn lệch giữa hai màn. */
export function cashCloseWarnings(rows: CashSourceCheckRow[]) {
  const money = (value: number) => new Intl.NumberFormat("vi-VN").format(round(value));
  const warnings: string[] = [];
  for (const row of rows) {
    const label = `${row.name} (${row.codes.join(", ")})`;
    if (row.negativeCashbook || row.negativeReport) {
      const sides = [
        row.negativeCashbook ? `Sổ quỹ ${money(row.cashbook.closing)} đ` : "",
        row.negativeReport ? `Nguồn tiền ${money(row.report.closing)} đ` : "",
      ].filter(Boolean).join(", ");
      warnings.push(`${label} âm cuối kỳ: ${sides}`);
    }
    if (!row.matched) warnings.push(`${label} lệch Sổ quỹ – Nguồn tiền ${money(row.closingDiff)} đ`);
  }
  return warnings;
}
