import { NextResponse } from "next/server";
import { resolvableCategoryCodes, type ResolvableCategoryCodes } from "@/lib/cashflow-categories";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { dateKey, suggestRevenueDateFromDescription, vietnamBusinessDayBounds } from "@/lib/revenue-date";
import {
  remainingWalletGross,
  selectWalletDeclaredRevenue,
  walletRevenueBucket,
} from "@/lib/wallet-revenue-reconciliation";
import {
  allocateWalletSettlementGroup,
  WALLET_CARD_FEE_CATEGORY_CODE,
  WALLET_GRAB_EXPENSE_CATEGORY_CODE,
} from "@/lib/wallet-settlement-allocation";
import { generateFormattedVoucherCode, nextSeqFromCodes, voucherCodePrefix } from "@/lib/voucher-code-generator";
import { planRevenueDateSplit, RevenueSplitError } from "@/lib/bank-statement-revenue-split";
import { BANK_STATEMENT_SPLIT_SOURCE_SCOPE } from "@/lib/voucher-rules";
import { buildAuditLogData } from "@/lib/audit-log";
import { closedPeriodMessage, findClosedPeriod } from "@/lib/phase3";
import { softDeleteRecord, SoftDeleteError } from "@/lib/soft-delete";
import type { DemoSession } from "@/lib/auth-demo";

function cleanText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function toAmount(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function sameDay(a: Date, b: Date) {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function scoreCandidate(
  amount: number,
  referenceDates: Date[],
  candidate: { date: Date; amount: number; partnerCode?: string | null },
  partnerHint: string | null,
) {
  let score = 0;
  if (Math.abs(amount - candidate.amount) < 1) score += 70;
  if (referenceDates.some((date) => sameDay(date, candidate.date))) score += 20;
  if (partnerHint && candidate.partnerCode && partnerHint === candidate.partnerCode) score += 10;
  return score;
}

type SettlementCandidate = {
  id: string;
  code: string;
  transferDate: Date;
  sourceReportDate: Date | null;
  amount: number;
  feeAmount: number;
  fromMoneySourceCode: string;
  toMoneySourceCode: string;
};

/**
 * Phiếu quyết toán ví đã có nhưng chưa nối với dòng sao kê nào: cùng cửa hàng, cùng số tiền
 * thực về. Gặp khi rollback lô sao kê rồi import lại — phiếu lập bằng tay hoặc bằng nút quyết
 * toán không thuộc lô nên còn nguyên, còn dòng sao kê mới thì đứng một mình — hoặc khi kế
 * toán lập phiếu tay trước rồi mới có file. Dòng "chưa vào sổ" nối thẳng vào phiếu này thay
 * vì lập phiếu thứ hai làm Sổ quỹ nhân đôi tiền về.
 */
async function findSettlementCandidates(
  rows: Array<{ id: string; branchCode: string | null; creditAmount: number; reconcileStatus: string; autoProcessType: string | null }>,
) {
  const result = new Map<string, SettlementCandidate[]>();
  const needing = rows.filter((row) => row.reconcileStatus === "UNMATCHED"
    && row.autoProcessType === "MANUAL_REQUIRED" && row.creditAmount > 0 && row.branchCode);
  if (needing.length === 0) return result;
  const transfers = await prisma.moneyTransfer.findMany({
    where: {
      transferPurpose: "WALLET_SETTLEMENT",
      status: "APPROVED",
      deletedAt: null,
      branchCode: { in: [...new Set(needing.map((row) => row.branchCode as string))] },
      amount: { in: [...new Set(needing.map((row) => Math.round(row.creditAmount)))] },
    },
    select: {
      id: true, code: true, branchCode: true, transferDate: true, sourceReportDate: true,
      amount: true, feeAmount: true, fromMoneySourceCode: true, toMoneySourceCode: true,
    },
    orderBy: { transferDate: "desc" },
  });
  if (transfers.length === 0) return result;
  const linked = await prisma.reconciliationMatch.findMany({
    where: { targetType: "WALLET_SETTLEMENT", targetId: { in: transfers.map((row) => row.id) }, deletedAt: null },
    select: { targetId: true },
  });
  const linkedIds = new Set(linked.map((row) => row.targetId));
  const free = transfers.filter((row) => !linkedIds.has(row.id));
  for (const row of needing) {
    result.set(row.id, free
      .filter((transfer) => transfer.branchCode === row.branchCode && Math.round(transfer.amount) === Math.round(row.creditAmount))
      .map((transfer) => ({
        id: transfer.id, code: transfer.code, transferDate: transfer.transferDate, sourceReportDate: transfer.sourceReportDate,
        amount: transfer.amount, feeAmount: transfer.feeAmount, fromMoneySourceCode: transfer.fromMoneySourceCode, toMoneySourceCode: transfer.toMoneySourceCode,
      })));
  }
  return result;
}

/** Link mở đúng phiếu điều chuyển trên màn Vận hành tài chính. */
function transferHref(transfer: { transferDate: Date; branchCode: string | null; code: string }) {
  const period = transfer.transferDate.toISOString().slice(0, 7);
  return `/finance-operations?period=${encodeURIComponent(period)}&branchCode=${encodeURIComponent(transfer.branchCode || "ALL")}&transfer=${encodeURIComponent(transfer.code)}`;
}

/**
 * "Vào sổ" cho dòng sao kê quyết toán ví mà import không tự lập được chứng từ.
 *
 * Import chặn dòng (phí vượt trần, gross không cân, phí đã khai bên POS...) và lưu lý do,
 * nhưng trước đây không có cửa nào cho người dùng đi tiếp ngoài sửa file rồi import lại —
 * mà sửa file cũng không xong khi ví trả nhiều đợt: đợt nào cũng "sai" so với doanh thu cả
 * ngày. Hai cách xử lý ở đây:
 *   - RECORD_WALLET_NET: lập phiếu QTVI đúng số tiền đã về, phí 0, y như import khi file để
 *     trống Gross. Tiền lên Sổ quỹ ngay; khi tiền của ngày đó về đủ thì nút "Chạy lại theo
 *     doanh thu hiện tại" trên phiếu tính phí cho cả nhóm. Phiếu gắn importBatchId của dòng
 *     để rollback lô dọn được cả phiếu, không để phiếu mồ côi.
 *   - LINK_WALLET_SETTLEMENT: nối vào phiếu QTVI đã có (cùng cửa hàng, cùng số tiền, chưa
 *     nối dòng nào) thay vì lập phiếu thứ hai.
 */
async function postWalletBankRow(request: Request, body: Record<string, unknown>, session: DemoSession) {
  const action = cleanText(body.action);
  const financeAuth = requireMenuAction(request, "/finance-operations", "create");
  if (!financeAuth.ok) return financeAuth.response;

  const bank = await prisma.bankStatementTransaction.findFirst({
    where: { id: cleanText(body.bankTransactionId), deletedAt: null },
    include: {
      allocations: { orderBy: { sourceRowNumber: "asc" } },
      matches: { where: { deletedAt: null }, select: { targetCode: true } },
    },
  });
  if (!bank) return NextResponse.json({ error: "Không tìm thấy dòng sao kê này." }, { status: 404 });
  if (!bank.branchCode) return NextResponse.json({ error: "Dòng sao kê chưa gán cửa hàng nên chưa vào sổ được." }, { status: 400 });
  assertBranchAccess(session, bank.branchCode);
  if (bank.reconcileStatus === "MATCHED" || bank.matches.length > 0) {
    return NextResponse.json({ error: `Dòng này đã vào sổ với ${bank.matches.map((row) => row.targetCode).join(", ") || "một chứng từ"} rồi.` }, { status: 400 });
  }
  const netAmount = Math.round(bank.creditAmount);
  if (netAmount <= 0) return NextResponse.json({ error: "Chỉ dòng tiền VỀ ngân hàng (cột Có) mới quyết toán ví được." }, { status: 400 });

  const firstCredit = bank.allocations.find((row) => row.creditAmount > 0);
  const walletCode = bank.decreaseMoneySourceCode || firstCredit?.decreaseMoneySourceCode || "";
  const bankCode = bank.increaseMoneySourceCode || firstCredit?.increaseMoneySourceCode || "";
  const [walletSource, bankSource] = await Promise.all([
    walletCode ? prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: walletCode, deletedAt: null }, select: { code: true, name: true, group: true } }) : null,
    bankCode ? prisma.masterDataItem.findFirst({ where: { type: "MONEY_SOURCE", code: bankCode, deletedAt: null }, select: { code: true, name: true, group: true } }) : null,
  ]);
  if (!walletSource || normalizeMoneySourceGroup(walletSource.group) !== "WALLET") {
    return NextResponse.json({ error: `Nguồn tiền giảm [${walletCode || "trống"}] không phải ví/cổng POS, nên dòng này không phải quyết toán ví. Sửa cột nguồn tiền trên file rồi import lại.` }, { status: 400 });
  }
  if (!bankSource || normalizeMoneySourceGroup(bankSource.group) !== "BANK") {
    return NextResponse.json({ error: `Nguồn tiền tăng [${bankCode || "trống"}] không phải tài khoản ngân hàng. Sửa cột nguồn tiền trên file rồi import lại.` }, { status: 400 });
  }
  const revenueDate = bank.allocations.find((row) => row.revenueDate)?.revenueDate || bank.revenueDate || null;
  const documentDate = bank.accountingDate || bank.transactionDate;

  if (action === "LINK_WALLET_SETTLEMENT") {
    const transfer = await prisma.moneyTransfer.findFirst({
      where: { id: cleanText(body.transferId), transferPurpose: "WALLET_SETTLEMENT", deletedAt: null },
    });
    if (!transfer) return NextResponse.json({ error: "Không tìm thấy phiếu quyết toán ví này." }, { status: 404 });
    if (transfer.status !== "APPROVED") return NextResponse.json({ error: `Phiếu ${transfer.code} chưa được duyệt nên chưa nối được.` }, { status: 400 });
    if (transfer.branchCode !== bank.branchCode) return NextResponse.json({ error: `Phiếu ${transfer.code} thuộc cửa hàng khác với dòng sao kê.` }, { status: 400 });
    if (Math.round(transfer.amount) !== netAmount) {
      return NextResponse.json({ error: `Số thực nhận trên phiếu ${transfer.code} (${Math.round(transfer.amount).toLocaleString("vi-VN")} đ) khác số tiền sao kê (${netAmount.toLocaleString("vi-VN")} đ).` }, { status: 400 });
    }
    const taken = await prisma.reconciliationMatch.findFirst({
      where: { targetType: "WALLET_SETTLEMENT", targetId: transfer.id, deletedAt: null },
      include: { bankTransaction: { select: { transactionCode: true } } },
    });
    if (taken) return NextResponse.json({ error: `Phiếu ${transfer.code} đã nối với dòng sao kê ${taken.bankTransaction.transactionCode} rồi.` }, { status: 400 });

    await prisma.$transaction(async (tx) => {
      await tx.reconciliationMatch.create({
        data: {
          bankTransactionId: bank.id,
          targetType: "WALLET_SETTLEMENT",
          targetId: transfer.id,
          targetCode: transfer.code,
          targetDate: transfer.transferDate,
          targetAmount: netAmount,
          matchedAmount: netAmount,
          status: "MATCHED",
          note: "Nối tay với phiếu quyết toán ví đã có",
          matchedBy: session.name,
        },
      });
      await tx.bankStatementTransaction.update({
        where: { id: bank.id },
        data: {
          reconcileStatus: "MATCHED",
          autoProcessType: "WALLET_SETTLEMENT",
          autoProcessNote: `Đã nối với phiếu quyết toán ${transfer.code} có sẵn (${session.name})`,
        },
      });
      await tx.moneyTransfer.update({
        where: { id: transfer.id },
        data: {
          externalRef: transfer.externalRef || bank.transactionCode,
          sourceReportDate: transfer.sourceReportDate || revenueDate,
        },
      });
      await tx.auditLog.create({
        data: buildAuditLogData({
          session,
          module: "BANK_STATEMENT",
          action: "LINK_WALLET_SETTLEMENT",
          entityType: "BankStatementTransaction",
          entityId: bank.id,
          entityCode: bank.transactionCode,
          branchCode: bank.branchCode,
          message: `Nối ${bank.transactionCode} với phiếu quyết toán ${transfer.code}`,
          metadata: { transferId: transfer.id, transferCode: transfer.code, amount: netAmount, previousNote: bank.autoProcessNote },
        }),
      });
    });
    return NextResponse.json({ transfer: { id: transfer.id, code: transfer.code }, href: transferHref(transfer), created: false }, { status: 201 });
  }

  if (action !== "RECORD_WALLET_NET") return NextResponse.json({ error: "Hành động không hợp lệ" }, { status: 400 });
  const locked = await findClosedPeriod([{ date: documentDate, branchCode: bank.branchCode }]);
  if (locked) return NextResponse.json({ error: closedPeriodMessage(locked, "lập phiếu quyết toán ví") }, { status: 400 });

  const created = await prisma.$transaction(async (tx) => {
    const prefix = voucherCodePrefix({ voucherType: "QTVI", voucherDate: documentDate, branchCode: bank.branchCode as string });
    const issued = await tx.moneyTransfer.findMany({ where: { code: { startsWith: prefix } }, select: { code: true } });
    const transfer = await tx.moneyTransfer.create({
      data: {
        importBatchId: bank.importBatchId,
        code: prefix + String(nextSeqFromCodes(issued.map((row) => row.code), prefix)).padStart(5, "0"),
        transferDate: documentDate,
        branchCode: bank.branchCode as string,
        fromMoneySourceCode: walletSource.code,
        toMoneySourceCode: bankSource.code,
        amount: netAmount,
        feeAmount: 0,
        externalRef: bank.transactionCode,
        description: `Quyết toán ví theo sao kê ${bank.transactionCode} — ghi theo số tiền thực về, phí tính sau khi doanh thu ngày này về đủ`,
        transferPurpose: "WALLET_SETTLEMENT",
        sourceReportDate: revenueDate,
        status: "APPROVED",
        createdBy: session.name,
        approvedBy: session.name,
      },
    });
    // Cùng cách import ghi khi file để trống Gross: gross của dòng phân bổ = 0 để bảng "Tiền về
    // đủ chưa" không giữ số gross sai mà file đã khai.
    await tx.bankStatementAllocation.updateMany({ where: { bankTransactionId: bank.id }, data: { grossAmount: 0 } });
    await tx.reconciliationMatch.create({
      data: {
        bankTransactionId: bank.id,
        targetType: "WALLET_SETTLEMENT",
        targetId: transfer.id,
        targetCode: transfer.code,
        targetDate: documentDate,
        targetAmount: netAmount,
        matchedAmount: netAmount,
        status: "MATCHED",
        note: "Vào sổ theo số tiền thực về từ màn Sổ sao kê",
        matchedBy: session.name,
      },
    });
    await tx.bankStatementTransaction.update({
      where: { id: bank.id },
      data: {
        reconcileStatus: "MATCHED",
        autoProcessType: "WALLET_SETTLEMENT",
        autoProcessNote: `Đã ghi nhận ${transfer.code} theo số tiền thực về (${session.name}); phí tính sau bằng nút "Chạy lại theo doanh thu hiện tại" trên phiếu`,
      },
    });
    await tx.auditLog.create({
      data: buildAuditLogData({
        session,
        module: "BANK_STATEMENT",
        action: "RECORD_WALLET_NET",
        entityType: "MoneyTransfer",
        entityId: transfer.id,
        entityCode: transfer.code,
        branchCode: bank.branchCode,
        message: `Vào sổ ${bank.transactionCode} bằng phiếu ${transfer.code} theo số thực về ${netAmount.toLocaleString("vi-VN")} đ`,
        metadata: { bankTransactionId: bank.id, transactionCode: bank.transactionCode, amount: netAmount, previousNote: bank.autoProcessNote },
      }),
    });
    return transfer;
  });
  return NextResponse.json({ transfer: { id: created.id, code: created.code }, href: transferHref(created), created: true }, { status: 201 });
}

async function buildWalletGroupPreview(bankTransactionId: string) {
  const target = await prisma.bankStatementTransaction.findUnique({
    where: { id: bankTransactionId },
    include: { allocations: { orderBy: { sourceRowNumber: "asc" } } },
  });
  if (!target || !target.branchCode) throw new Error("Không tìm thấy giao dịch Ví hoặc thiếu cửa hàng.");
  if (target.reconcileStatus !== "UNMATCHED") throw new Error("Giao dịch đã được quyết toán hoặc đối soát.");

  const revenueDates = [...new Map(target.allocations
    .filter((row) => row.revenueDate)
    .map((row) => [dateKey(row.revenueDate!), row.revenueDate!])).values()];
  if (revenueDates.length !== 1) throw new Error("Nhóm quyết toán phải có đúng một Ngày doanh thu.");
  const revenueDate = revenueDates[0];
  const { start, end } = vietnamBusinessDayBounds(revenueDate);

  const walletSources = (await prisma.masterDataItem.findMany({
    where: { type: "MONEY_SOURCE", status: "ACTIVE", deletedAt: null },
    select: { code: true, name: true, group: true },
  })).filter((source) => normalizeMoneySourceGroup(source.group) === "WALLET");
  const walletCodes = walletSources.map((source) => source.code);
  const candidates = await prisma.bankStatementTransaction.findMany({
    where: {
      branchCode: target.branchCode,
      reconcileStatus: "UNMATCHED",
      creditAmount: { gt: 0 },
      deletedAt: null,
      allocations: { some: { revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: walletCodes } } },
    },
    include: { allocations: { orderBy: { sourceRowNumber: "asc" } } },
    orderBy: [{ transactionDate: "asc" }, { transactionCode: "asc" }],
  });
  const eligible = candidates.filter((bank) => {
    const dated = bank.allocations.filter((row) => row.creditAmount > 0 && row.revenueDate);
    return dated.length > 0
      && dated.every((row) => dateKey(row.revenueDate!) === dateKey(revenueDate))
      && dated.every((row) => walletCodes.includes(row.decreaseMoneySourceCode || ""));
  });
  if (!eligible.some((bank) => bank.id === target.id)) throw new Error("Giao dịch không còn thuộc nhóm Ví có thể quyết toán.");

  const [posRows, manualRows, allocatedRows, legacySettlementMatches, grabSettlements] = await Promise.all([
    prisma.revenueImportRow.findMany({
      where: { branchCode: target.branchCode, saleDate: { gte: start, lt: end }, deletedAt: null },
      select: { paymentMethod: true, revenueSource: true, channel: true, netAmount: true },
    }),
    prisma.manualRevenueEntry.findMany({
      where: { branchCode: target.branchCode, reportDate: { gte: start, lt: end }, deletedAt: null },
      select: { cardAmount: true, grabAmount: true },
    }),
    prisma.bankStatementAllocation.findMany({
      where: {
        revenueDate: { gte: start, lt: end },
        decreaseMoneySourceCode: { in: walletCodes },
        grossAmount: { not: null },
        bankTransaction: { branchCode: target.branchCode, reconcileStatus: { in: ["PENDING_REVIEW", "MATCHED"] }, deletedAt: null },
      },
      select: { grossAmount: true },
    }),
    prisma.reconciliationMatch.findMany({
      where: {
        targetType: "WALLET_SETTLEMENT",
        deletedAt: null,
        bankTransaction: {
          branchCode: target.branchCode,
          deletedAt: null,
          allocations: {
            some: { revenueDate: { gte: start, lt: end }, decreaseMoneySourceCode: { in: walletCodes }, grossAmount: null },
          },
        },
      },
      select: { targetId: true },
    }),
    prisma.moneyTransfer.findMany({
      where: {
        branchCode: target.branchCode,
        transferPurpose: "WALLET_SETTLEMENT",
        sourceReportDate: { gte: start, lt: end },
        status: { in: ["PENDING_REVIEW", "APPROVED"] },
        deletedAt: null,
      },
      select: { grabExpenseAmount: true },
    }),
  ]);
  const legacySettlements = legacySettlementMatches.length > 0
    ? await prisma.moneyTransfer.findMany({
        where: { id: { in: legacySettlementMatches.map((row) => row.targetId) }, status: { in: ["PENDING_REVIEW", "APPROVED"] }, deletedAt: null },
        select: { amount: true, feeAmount: true },
      })
    : [];
  const cardSources = walletSources.filter((source) => walletRevenueBucket(source) === "CARD_WALLET");
  const grabSources = walletSources.filter((source) => walletRevenueBucket(source) === "GRAB");
  const cardDeclared = selectWalletDeclaredRevenue({ posRows, manualRows, bucketSources: cardSources, bucket: "CARD_WALLET" });
  const grabDeclared = selectWalletDeclaredRevenue({ posRows, manualRows, bucketSources: grabSources, bucket: "GRAB" });
  const allocatedGross = allocatedRows.reduce((sum, row) => sum + (row.grossAmount || 0), 0)
    + legacySettlements.reduce((sum, row) => sum + row.amount + row.feeAmount, 0);
  const remainingGross = remainingWalletGross(cardDeclared.amount + grabDeclared.amount, allocatedGross);
  const remainingGrab = remainingWalletGross(
    grabDeclared.amount,
    grabSettlements.reduce((sum, row) => sum + row.grabExpenseAmount, 0),
  );
  const allocations = allocateWalletSettlementGroup({
    grossAmount: remainingGross,
    grabRevenueAmount: remainingGrab,
    transactions: eligible.map((bank) => ({ id: bank.id, netAmount: bank.creditAmount })),
  });
  const allocationById = new Map(allocations.map((row) => [row.id, row]));

  return {
    branchCode: target.branchCode,
    revenueDate,
    declaredGross: remainingGross,
    declaredGrab: remainingGrab,
    transactions: eligible.map((bank) => ({
      ...allocationById.get(bank.id)!,
      transactionCode: bank.transactionCode,
      transactionDate: bank.transactionDate,
      bankAccount: bank.bankAccount,
      allocations: bank.allocations,
    })),
  };
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/reconciliations");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const walletGroupFor = cleanText(searchParams.get("walletGroupFor"));
    if (walletGroupFor) {
      const preview = await buildWalletGroupPreview(walletGroupFor);
      assertBranchAccess(auth.session, preview.branchCode);
      return NextResponse.json(preview);
    }
    const status = searchParams.get("status") || "ALL";
    const batchId = cleanText(searchParams.get("batchId"));
    const search = cleanText(searchParams.get("q")).slice(0, 100);
    const bankAccount = cleanText(searchParams.get("bankAccount"));
    // Lọc theo MÃ NGUỒN TIỀN (khớp nguồn tổng/tăng/giảm, kể cả dòng phân bổ) — cột "Tài khoản"
    // trên sao kê là số tài khoản thô từ file nên không dùng làm giá trị lọc được.
    const moneySource = cleanText(searchParams.get("moneySource")).toUpperCase();
    const category = cleanText(searchParams.get("category")).toUpperCase();
    const operationType = cleanText(searchParams.get("operationType"));
    const dateType = cleanText(searchParams.get("dateType")) || "TRANSACTION";
    const fromText = cleanText(searchParams.get("from"));
    const toText = cleanText(searchParams.get("to"));
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(fromText) ? new Date(`${fromText}T00:00:00.000Z`) : null;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(toText) ? new Date(`${toText}T00:00:00.000Z`) : null;
    if (toDate) toDate.setUTCDate(toDate.getUTCDate() + 1);
    const dateRange = fromDate || toDate ? { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lt: toDate } : {}) } : null;
    // Lọc theo Ngày nguồn tiền phải xếp kỳ y như Báo cáo nguồn tiền: dòng chưa khai Ngày
    // nguồn tiền rơi về Ngày giao dịch. Thiếu vế fallback này thì lọc theo Ngày nguồn tiền
    // là mất sạch dòng chưa khai — trong khi báo cáo vẫn đang tính chúng vào kỳ.
    const sourceDateFilter = dateRange ? {
      OR: [
        { allocations: { none: {} }, OR: [{ sourceDate: dateRange }, { sourceDate: null, transactionDate: dateRange }] },
        { allocations: { some: { sourceDate: dateRange } } },
        { allocations: { some: { sourceDate: null } }, transactionDate: dateRange },
      ],
    } : {};
    const dateFilter = dateRange
      ? dateType === "SOURCE" ? sourceDateFilter
        : dateType === "REVENUE" ? { OR: [{ revenueDate: dateRange }, { allocations: { some: { revenueDate: dateRange } } }] }
          : { transactionDate: dateRange }
      : {};
    const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = 50;
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");
    // Lọc "chưa gán Loại thu/chi": dòng "Chưa phân loại" trên Báo cáo nguồn tiền link thẳng về
    // đây. Phải hiểu y hệt báo cáo — mã trống, mã không còn trong danh mục, hoặc mã sai nhóm
    // (mã Chi trên dòng ghi Có) đều là chưa phân loại — không thì bấm link ra danh sách rỗng.
    const missingCategory = searchParams.get("missingCategory") === "1" && !category;
    const knownCategoryCodes = missingCategory ? await resolvableCategoryCodes() : null;
    const emptyCategory = { OR: [{ categoryCode: null }, { categoryCode: "" }] };
    // Phải liệt kê riêng ô trống: điều kiện NOT ... IN của Prisma bỏ luôn dòng có mã NULL,
    // mà dòng bỏ trống Loại thu/chi mới đúng là thứ cần tìm nhất.
    const unresolvedCategory = (codes: ResolvableCategoryCodes) => ({
      OR: [
        ...emptyCategory.OR,
        { creditAmount: { gt: 0 }, NOT: { categoryCode: { in: codes.RECEIPT } } },
        { creditAmount: { lte: 0 }, NOT: { categoryCode: { in: codes.PAYMENT } } },
      ],
    });
    const missingCategoryFilter = knownCategoryCodes ? [{
      OR: [
        // Giao dịch không có dòng phân bổ: đọc thẳng mã trên giao dịch.
        { allocations: { none: {} }, ...unresolvedCategory(knownCategoryCodes) },
        // Có phân bổ: mỗi dòng phân bổ mang mã riêng...
        { allocations: { some: { AND: [{ NOT: emptyCategory }, unresolvedCategory(knownCategoryCodes)] } } },
        // ...dòng phân bổ bỏ trống mã thì rơi về mã của giao dịch.
        { AND: [{ allocations: { some: emptyCategory } }, unresolvedCategory(knownCategoryCodes)] },
      ],
    }] : [];
    const bankWhere = {
      ...branchFilter,
      ...(batchId ? { importBatchId: batchId } : {}),
      ...(status === "ALL" ? {} : { reconcileStatus: status }),
      ...dateFilter,
      ...(bankAccount ? { bankAccount } : {}),
      ...(operationType ? { operationType } : {}),
      // Ba bộ lọc dưới đều cần OR riêng nên phải nằm trong một mảng AND chung — spread
      // hai object cùng key OR sẽ lặng lẽ ghi đè nhau.
      AND: [
        ...(moneySource ? [{
          OR: [
            { summaryMoneySourceCode: moneySource },
            { increaseMoneySourceCode: moneySource },
            { decreaseMoneySourceCode: moneySource },
            { allocations: { some: { OR: [
              { summaryMoneySourceCode: moneySource },
              { increaseMoneySourceCode: moneySource },
              { decreaseMoneySourceCode: moneySource },
            ] } } },
          ],
        }] : []),
        ...(category ? [{
          OR: [
            { categoryCode: category },
            { allocations: { some: { categoryCode: category } } },
          ],
        }] : []),
        ...missingCategoryFilter,
        ...(search ? [{
          OR: [
            { transactionCode: { contains: search, mode: "insensitive" as const } },
            { bankAccount: { contains: search, mode: "insensitive" as const } },
            { description: { contains: search, mode: "insensitive" as const } },
            { partnerHint: { contains: search, mode: "insensitive" as const } },
            { categoryCode: { contains: search, mode: "insensitive" as const } },
            { operationType: { contains: search, mode: "insensitive" as const } },
            { partnerCode: { contains: search, mode: "insensitive" as const } },
            { pnlItemCode: { contains: search, mode: "insensitive" as const } },
            { matches: { some: { targetCode: { contains: search, mode: "insensitive" as const }, deletedAt: null } } },
          ],
        }] : []),
      ],
    };

    if (searchParams.get("ledger") === "1") {
      const [ledgerRows, ledgerTotal] = await Promise.all([
        prisma.bankStatementTransaction.findMany({
          where: bankWhere,
          include: {
            // Tách theo Loại thu/chi làm một dòng sao kê có nhiều chứng từ (phần doanh thu giữ
            // chứng từ cũ, phần tách ra có phiếu riêng) nên không lấy mỗi cái mới nhất nữa.
            // Xếp CŨ TRƯỚC để `currentMatch` luôn là chứng từ gốc lập lúc import — màn tách gọi
            // tên nó trong câu "chứng từ X chỉ còn giữ phần đúng loại ban đầu".
            matches: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, take: 5 },
            allocations: { orderBy: { sourceRowNumber: "asc" } },
          },
          orderBy: [{ transactionDate: "desc" }, { createdAt: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.bankStatementTransaction.count({ where: bankWhere }),
      ]);
      const settlementCandidates = await findSettlementCandidates(ledgerRows);
      return NextResponse.json({
        rows: ledgerRows.map(({ matches: rowMatches, ...row }) => ({
          ...row,
          revenueDates: [...new Set((row.allocations.length ? row.allocations.map((item) => item.revenueDate) : [row.revenueDate])
            .filter((value): value is Date => Boolean(value)).map((value) => value.toISOString()))],
          settlementCandidates: settlementCandidates.get(row.id) || [],
          currentMatch: rowMatches[0]
            ? {
                ...rowMatches[0],
                targetHref: rowMatches[0].targetType === "VOUCHER" ? "/bank-vouchers" : "/finance-operations",
              }
            : null,
          otherMatches: rowMatches.slice(1).map((match) => ({
            targetCode: match.targetCode,
            targetType: match.targetType,
            targetHref: match.targetType === "VOUCHER" ? "/bank-vouchers" : "/finance-operations",
          })),
        })),
        matches: [],
        pagination: { page, pageSize, total: ledgerTotal, totalPages: Math.max(1, Math.ceil(ledgerTotal / pageSize)) },
      });
    }

    const [bankRows, total, revenueRows, manualRevenueRows, deposits, vouchers, matches, moneySources] = await Promise.all([
      prisma.bankStatementTransaction.findMany({
        where: bankWhere,
        include: {
          matches: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
          allocations: { orderBy: { sourceRowNumber: "asc" } },
        },
        orderBy: { transactionDate: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.bankStatementTransaction.count({ where: bankWhere }),
      prisma.revenueImportRow.findMany({ where: { ...branchFilter }, orderBy: { saleDate: "desc" }, take: 5000 }),
      prisma.manualRevenueEntry.findMany({
        where: { ...branchFilter, deletedAt: null },
        orderBy: { reportDate: "desc" },
        take: 2000,
      }),
      prisma.deposit.findMany({ where: { ...branchFilter }, orderBy: { receivedDate: "desc" }, take: 300 }),
      prisma.financialVoucher.findMany({
        where: { ...branchFilter, status: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED", "POSTED"] }, deletedAt: null },
        orderBy: { voucherDate: "desc" },
        take: 500,
      }),
      prisma.reconciliationMatch.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.masterDataItem.findMany({
        where: { type: "MONEY_SOURCE" },
        select: { code: true, name: true, group: true },
      }),
    ]);

    const moneySourceByCode = new Map(moneySources.map((source) => [source.code, source]));

    const rows = bankRows.map((bank) => {
      const bankAmount = bank.creditAmount || bank.debitAmount;
      const explicitRevenueDates = [...new Map(
        (bank.allocations.length > 0
          ? bank.allocations.map((allocation) => allocation.revenueDate)
          : [bank.revenueDate])
          .filter((value): value is Date => Boolean(value))
          .map((value) => [dateKey(value), value]),
      ).values()];
      const descriptions = bank.allocations.length > 0
        ? bank.allocations.map((allocation) => allocation.description)
        : [bank.description];
      const descriptionSuggestions = explicitRevenueDates.length > 0
        ? []
        : descriptions
            .map(suggestRevenueDateFromDescription)
            .filter((value): value is NonNullable<typeof value> => Boolean(value));
      const uniqueSuggestedDates = [...new Map(descriptionSuggestions.map((item) => [dateKey(item.date), item.date])).values()];
      const suggestedRevenueDate = uniqueSuggestedDates.length === 1 ? uniqueSuggestedDates[0] : null;
      const posReferenceDates = explicitRevenueDates.length > 0
        ? explicitRevenueDates
        : suggestedRevenueDate ? [suggestedRevenueDate] : [];
      const decreaseCodes = bank.allocations.length > 0
        ? bank.allocations.map((allocation) => allocation.decreaseMoneySourceCode)
        : [bank.decreaseMoneySourceCode];
      const walletSources = [...new Map(decreaseCodes.flatMap((code) => {
        const source = moneySourceByCode.get(code || "");
        return source && normalizeMoneySourceGroup(source.group) === "WALLET" ? [[source.code, source] as const] : [];
      })).values()];
      const isWalletSettlement = walletSources.length > 0;
      const hasCompleteWalletGross = bank.allocations.length > 0
        && bank.allocations.every((allocation) => allocation.grossAmount !== null);
      const walletGrossAmount = hasCompleteWalletGross
        ? bank.allocations.reduce((sum, allocation) => sum + (allocation.grossAmount || 0), 0)
        : 0;
      const expectedPosAmount = isWalletSettlement && walletGrossAmount > 0 ? walletGrossAmount : bankAmount;
      const posCandidates = revenueRows.map((row) => {
        const dateMatches = posReferenceDates.some((date) => sameDay(date, row.saleDate));
        const branchMatches = Boolean(bank.branchCode) && row.branchCode === bank.branchCode;
        const sourceMatches = !isWalletSettlement || walletSources.some((source) => {
          const declared = selectWalletDeclaredRevenue({
            posRows: [row],
            manualRows: [],
            bucketSources: [source],
            bucket: walletRevenueBucket(source),
          });
          return declared.amount > 0;
        });
        return {
          targetType: "REVENUE_POS",
          targetId: row.id,
          targetCode: row.externalRef,
          targetDate: row.saleDate,
          targetAmount: row.netAmount,
          label: `${row.branchCode} - ${row.channel || "POS"} - ${row.paymentMethod}`,
          score: scoreCandidate(expectedPosAmount, posReferenceDates, { date: row.saleDate, amount: row.netAmount }, bank.partnerHint)
            + (isWalletSettlement && sourceMatches ? 10 : 0),
          canMatch: !isWalletSettlement,
          dateSource: explicitRevenueDates.length > 0 ? "REVENUE_DATE" : suggestedRevenueDate ? "DESCRIPTION_SUGGESTION" : "MISSING",
          eligible: branchMatches && dateMatches && sourceMatches && (isWalletSettlement || Math.abs(row.netAmount - bankAmount) < 1),
        };
      });
      const manualCandidates = isWalletSettlement
        ? [...new Set(walletSources.map(walletRevenueBucket))].flatMap((bucket) => posReferenceDates.flatMap((referenceDate) => {
            const posRowsForDay = revenueRows.filter((row) => Boolean(bank.branchCode)
              && row.branchCode === bank.branchCode
              && sameDay(referenceDate, row.saleDate));
            const manualRowsForDay = manualRevenueRows.filter((row) => Boolean(bank.branchCode)
              && row.branchCode === bank.branchCode
              && sameDay(referenceDate, row.reportDate));
            const bucketSources = walletSources.filter((source) => walletRevenueBucket(source) === bucket);
            const declared = selectWalletDeclaredRevenue({
              posRows: posRowsForDay,
              manualRows: manualRowsForDay,
              bucketSources,
              bucket,
            });
            if (declared.source !== "MANUAL" || declared.amount <= 0) return [];
            return [{
              targetType: "MANUAL_REVENUE",
              targetId: manualRowsForDay.map((row) => row.id).join(","),
              targetCode: `NHAP_TAY_${dateKey(referenceDate)}_${bucket}`,
              targetDate: referenceDate,
              targetAmount: declared.amount,
              label: `${bank.branchCode} - Doanh thu nhập tay - ${bucket === "GRAB" ? "Grab" : "Quẹt thẻ/Ví"}`,
              score: 30 + (Math.abs(expectedPosAmount - declared.amount) < 1 ? 70 : 0),
              canMatch: false,
              dateSource: "MANUAL_REVENUE",
              eligible: true,
            }];
          }))
        : [];
      const candidates = [
        ...posCandidates,
        ...manualCandidates,
        ...deposits.map((row) => ({
          targetType: "DEPOSIT",
          targetId: row.id,
          targetCode: row.code,
          targetDate: row.receivedDate,
          targetAmount: row.amount,
          label: `${row.partnerName} - ${row.purpose}`,
          score: scoreCandidate(bankAmount, [bank.transactionDate], { date: row.receivedDate, amount: row.amount, partnerCode: row.partnerCode }, bank.partnerHint),
          canMatch: true,
          dateSource: "TRANSACTION_DATE",
          eligible: Math.abs(row.amount - bankAmount) < 1,
        })),
        ...vouchers.filter((row) => ["APPROVED", "POSTED"].includes(row.status)).map((row) => ({
          targetType: "VOUCHER",
          targetId: row.id,
          targetCode: row.code,
          targetDate: row.voucherDate,
          targetAmount: row.amount,
          label: `${row.partnerName} - ${row.description}`,
          score: scoreCandidate(bankAmount, [bank.transactionDate], { date: row.voucherDate, amount: row.amount, partnerCode: row.partnerCode }, bank.partnerHint),
          canMatch: true,
          dateSource: "TRANSACTION_DATE",
          eligible: Math.abs(row.amount - bankAmount) < 1,
        })),
      ]
        .filter((candidate) => candidate.eligible && candidate.score >= (["REVENUE_POS", "MANUAL_REVENUE"].includes(candidate.targetType) && isWalletSettlement ? 30 : 70))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const { matches: bankMatches, ...bankData } = bank;
      const currentMatch = bankMatches[0] || null;
      const matchedVoucher = currentMatch?.targetType === "VOUCHER"
        ? vouchers.find((voucher) => voucher.id === currentMatch.targetId)
        : null;
      const transferPeriod = bank.transactionDate.toISOString().slice(0, 7);
      const transferHref = `/finance-operations?period=${encodeURIComponent(transferPeriod)}&branchCode=${encodeURIComponent(bank.branchCode || "ALL")}&transfer=${encodeURIComponent(currentMatch?.targetCode || "")}`;
      return {
        ...bankData,
        revenueDates: explicitRevenueDates.map((value) => value.toISOString()),
        suggestedRevenueDate: suggestedRevenueDate?.toISOString() || null,
        revenueDateSource: explicitRevenueDates.length > 0 ? "COLUMN" : suggestedRevenueDate ? "DESCRIPTION" : "MISSING",
        isWalletSettlement,
        walletSourceCodes: walletSources.map((source) => source.code),
        walletGrossAmount: walletGrossAmount || null,
        currentMatch: currentMatch
          ? {
              ...currentMatch,
              targetHref: currentMatch.targetType === "VOUCHER"
                ? (matchedVoucher?.documentChannel === "BANK" ? "/bank-vouchers" : "/vouchers")
                : currentMatch.targetType === "REVENUE_POS"
                  ? "/imports?tab=revenue-pos"
                  : transferHref,
            }
          : null,
        candidates,
      };
    });

    return NextResponse.json({
      rows,
      matches,
      pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    });
  } catch (error) {
    console.error("Error fetching reconciliation data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = requireMenuAction(request, "/reconciliations", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    if (["RECORD_WALLET_NET", "LINK_WALLET_SETTLEMENT"].includes(cleanText(body.action))) {
      return await postWalletBankRow(request, body, auth.session);
    }
    if (cleanText(body.action) === "SETTLE_WALLET_GROUP") {
      const financeAuth = requireMenuAction(request, "/finance-operations", "create");
      if (!financeAuth.ok) return financeAuth.response;
      const preview = await buildWalletGroupPreview(cleanText(body.bankTransactionId));
      assertBranchAccess(auth.session, preview.branchCode);
      // Quyết toán ví sinh phiếu điều chuyển tiền có ngày tháng, nên phải theo đúng luật khoá
      // sổ như mọi chứng từ khác. Trước đây nhánh này không kiểm nên ví vẫn quyết toán được
      // vào tháng đã chốt sổ.
      const lockedSettle = await findClosedPeriod(
        preview.transactions.map((row) => ({ date: row.transactionDate, branchCode: preview.branchCode })),
      );
      if (lockedSettle) {
        return NextResponse.json({ error: closedPeriodMessage(lockedSettle, "quyết toán ví") }, { status: 400 });
      }
      const categories = await prisma.masterDataItem.findMany({
        where: {
          type: "REVENUE_EXPENSE_CATEGORY",
          code: { in: [WALLET_CARD_FEE_CATEGORY_CODE, WALLET_GRAB_EXPENSE_CATEGORY_CODE] },
          group: "PAYMENT",
          status: "ACTIVE",
          deletedAt: null,
        },
        select: { code: true },
      });
      if (preview.transactions.some((row) => row.cardFeeAmount > 0) && !categories.some((row) => row.code === WALLET_CARD_FEE_CATEGORY_CODE)) {
        return NextResponse.json({ error: `Thiếu khoản mục ${WALLET_CARD_FEE_CATEGORY_CODE}` }, { status: 400 });
      }
      if (preview.transactions.some((row) => row.grabExpenseAmount > 0) && !categories.some((row) => row.code === WALLET_GRAB_EXPENSE_CATEGORY_CODE)) {
        return NextResponse.json({ error: `Thiếu khoản mục ${WALLET_GRAB_EXPENSE_CATEGORY_CODE}` }, { status: 400 });
      }

      const created = await prisma.$transaction(async (tx) => {
        const transferCount = await tx.moneyTransfer.count();
        const results = [];
        for (const [index, row] of preview.transactions.entries()) {
          const sourceCodes = [...new Set(row.allocations
            .filter((allocation) => allocation.creditAmount > 0)
            .map((allocation) => allocation.decreaseMoneySourceCode)
            .filter((value): value is string => Boolean(value)))];
          if (sourceCodes.length !== 1) throw new Error(`${row.transactionCode}: phải có đúng một nguồn Ví.`);
          const updated = await tx.bankStatementTransaction.updateMany({
            where: { id: row.id, reconcileStatus: "UNMATCHED", deletedAt: null },
            data: { reconcileStatus: "MATCHED", autoProcessType: "WALLET_SETTLEMENT", autoProcessNote: "Đã quyết toán theo nhóm Ngày doanh thu" },
          });
          if (updated.count !== 1) throw new Error(`${row.transactionCode}: trạng thái đã thay đổi, vui lòng tải lại.`);
          const transfer = await tx.moneyTransfer.create({
            data: {
              code: generateFormattedVoucherCode({ voucherType: "QTVI", voucherDate: row.transactionDate, branchCode: preview.branchCode, seqNumber: transferCount + index + 1 }),
              transferDate: row.transactionDate,
              branchCode: preview.branchCode,
              fromMoneySourceCode: sourceCodes[0],
              toMoneySourceCode: row.bankAccount,
              amount: row.netAmount,
              feeAmount: row.feeAmount,
              feeCategoryCode: row.cardFeeAmount > 0 ? WALLET_CARD_FEE_CATEGORY_CODE : null,
              grabExpenseAmount: row.grabExpenseAmount,
              grabExpenseCategoryCode: row.grabExpenseAmount > 0 ? WALLET_GRAB_EXPENSE_CATEGORY_CODE : null,
              externalRef: row.transactionCode,
              description: `Quyết toán nhóm Ví theo sao kê ${row.transactionCode}`,
              transferPurpose: "WALLET_SETTLEMENT",
              sourceReportDate: preview.revenueDate,
              status: "APPROVED",
              createdBy: auth.session.name,
              approvedBy: auth.session.name,
            },
          });
          const positiveAllocations = row.allocations.filter((allocation) => allocation.creditAmount > 0);
          const allocationPlan = allocateWalletSettlementGroup({
            grossAmount: row.grossAmount,
            grabRevenueAmount: 0,
            transactions: positiveAllocations.map((allocation) => ({ id: allocation.id, netAmount: allocation.creditAmount })),
          });
          for (const allocation of allocationPlan) {
            await tx.bankStatementAllocation.update({ where: { id: allocation.id }, data: { grossAmount: allocation.grossAmount } });
          }
          await tx.reconciliationMatch.create({
            data: {
              bankTransactionId: row.id,
              targetType: "WALLET_SETTLEMENT",
              targetId: transfer.id,
              targetCode: transfer.code,
              targetDate: preview.revenueDate,
              targetAmount: row.netAmount,
              matchedAmount: row.netAmount,
              note: "Quyết toán nhóm Ví, tự động tách chi phí Grab và phí cà thẻ",
              matchedBy: auth.session.name,
            },
          });
          results.push(transfer);
        }
        return results;
      }, { maxWait: 10_000, timeout: 120_000 });
      return NextResponse.json({
        transfers: created,
        grossAmount: preview.declaredGross,
        netAmount: preview.transactions.reduce((sum, row) => sum + row.netAmount, 0),
        grabExpenseAmount: preview.transactions.reduce((sum, row) => sum + row.grabExpenseAmount, 0),
        cardFeeAmount: preview.transactions.reduce((sum, row) => sum + row.cardFeeAmount, 0),
      }, { status: 201 });
    }
    const bankTransactionId = cleanText(body.bankTransactionId);
    const targetType = cleanText(body.targetType);
    const targetId = cleanText(body.targetId);
    const targetCode = cleanText(body.targetCode);
    const targetAmount = toAmount(body.targetAmount);

    if (!bankTransactionId || !targetType || !targetId || !targetCode || targetAmount <= 0) {
      return NextResponse.json({ error: "Thiếu thông tin đối soát" }, { status: 400 });
    }

    const bank = await prisma.bankStatementTransaction.findUnique({ where: { id: bankTransactionId } });
    if (!bank) return NextResponse.json({ error: "Không tìm thấy giao dịch sao kê" }, { status: 404 });
    if (bank.branchCode) {
      try {
        assertBranchAccess(auth.session, bank.branchCode);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
    }
    if (bank.reconcileStatus === "MATCHED") {
      return NextResponse.json({ error: "Giao dịch này đã được đối soát" }, { status: 400 });
    }

    const matchedAmount = bank.creditAmount || bank.debitAmount;
    if (Math.abs(matchedAmount - targetAmount) >= 1) {
      return NextResponse.json({ error: "Số tiền sao kê và chứng từ không khớp" }, { status: 400 });
    }

    const match = await prisma.$transaction(async (tx) => {
      const created = await tx.reconciliationMatch.create({
        data: {
          bankTransactionId,
          targetType,
          targetId,
          targetCode,
          targetDate: body.targetDate ? new Date(String(body.targetDate)) : null,
          targetAmount,
          matchedAmount,
          note: cleanText(body.note) || null,
          matchedBy: auth.session.name,
        },
      });

      await tx.bankStatementTransaction.update({
        where: { id: bankTransactionId },
        data: { reconcileStatus: "MATCHED" },
      });

      return created;
    });

    return NextResponse.json(match, { status: 201 });
  } catch (error) {
    console.error("Error creating reconciliation match:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}


/** Cấp mã Ủy nhiệm thu theo đúng chuỗi mã của tháng + cửa hàng, cùng luật max + 1 với lúc import. */
async function nextBankVoucherCode(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  voucherDate: Date,
  branchCode: string,
) {
  const prefix = voucherCodePrefix({ voucherType: "RECEIPT", documentChannel: "BANK", voucherDate, branchCode });
  // Phải đếm cả phiếu đã xoá mềm: sửa lại lần hai xoá phiếu cũ rồi cấp mã mới, mà client mặc
  // định giấu bản ghi đã xoá nên số thứ tự tụt xuống và đâm trúng mã vừa xoá (unique constraint).
  const issued = await tx.financialVoucher.findMany({
    where: { code: { startsWith: prefix }, deletedAt: undefined },
    select: { code: true },
  });
  return prefix + String(nextSeqFromCodes(issued.map((row) => row.code), prefix)).padStart(5, "0");
}

/**
 * Soát phần tách theo Loại thu/chi và trả về những thứ cần để lập chứng từ.
 *
 * Tách loại là ghi nhận một nghiệp vụ MỚI (tiền thu hộ) chứ không chỉ đổi nhãn, nên phải chặn
 * đúng chỗ: chỉ áp dụng cho tiền về, phải có đối tác để sổ treo công nợ đúng người, và phiếu
 * gốc không được là loại đã gạch nợ/cọc — sửa số tiền của phiếu đó sẽ làm lệch sổ công nợ.
 */
async function prepareCategorySplit(input: {
  bank: { branchCode: string | null; transactionDate: Date; accountingDate: Date | null; autoProcessType: string | null; increaseMoneySourceCode: string | null; decreaseMoneySourceCode: string | null; summaryMoneySourceCode: string | null };
  plan: { direction: "CREDIT" | "DEBIT"; splitCategories: Array<{ categoryCode: string; partnerCode: string | null; amount: number }>; lines: Array<{ keepsOriginalCategory: boolean }> };
  baseVoucher: { status: string; debtAction: string | null; depositAction: string | null; partnerAllocations: Array<{ id: string }> } | null;
}): Promise<{ error: string } | {
  categoryNameByCode: Map<string, string>;
  partnerNameByCode: Map<string, string>;
  splitMoneySourceCode: string;
  documentDate: Date;
}> {
  const { bank, plan, baseVoucher } = input;
  const documentDate = bank.accountingDate || bank.transactionDate;
  // Quyết toán ví: tiền vào VÍ trước, phiếu QTVI mới đưa về ngân hàng. Ghi phiếu thu hộ thẳng
  // vào ngân hàng là cộng tiền hai lần vào tài khoản đó.
  const splitMoneySourceCode = (bank.autoProcessType === "WALLET_SETTLEMENT"
    ? bank.decreaseMoneySourceCode
    : bank.increaseMoneySourceCode || bank.summaryMoneySourceCode) || "";

  if (plan.splitCategories.length === 0) {
    return { categoryNameByCode: new Map(), partnerNameByCode: new Map(), splitMoneySourceCode, documentDate };
  }
  if (plan.direction !== "CREDIT") {
    return { error: "Tách theo Loại thu/chi hiện chỉ áp dụng cho dòng tiền về (ghi Có)." };
  }
  if (!bank.branchCode) return { error: "Dòng sao kê chưa có Cửa hàng nên không lập được chứng từ cho phần tách ra." };
  if (!splitMoneySourceCode) return { error: "Dòng sao kê chưa có Nguồn tiền nên không lập được chứng từ cho phần tách ra." };

  const missingPartner = plan.splitCategories.find((group) => !group.partnerCode);
  if (missingPartner) {
    return { error: "Dòng tách sang Loại thu/chi khác phải chọn Đối tác — tiền thu hộ là tiền phải trả lại, sổ cần biết treo công nợ của ai." };
  }
  if (baseVoucher) {
    if (baseVoucher.status === "POSTED") return { error: "Chứng từ gốc đã ghi sổ nên không tách lại được — bỏ ghi sổ trước." };
    // Đổi loại toàn bộ số tiền sẽ để lại chứng từ gốc 0 đ treo lơ lửng. Cả khoản không phải
    // tiền bán hàng là chuyện phân loại của cả giao dịch, sửa ở chỗ khác chứ không phải ở đây.
    if (!plan.lines.some((line) => line.keepsOriginalCategory)) {
      return { error: "Phải còn ít nhất một dòng giữ Loại thu/chi gốc. Nếu cả khoản này không phải tiền bán hàng thì xoá dòng sao kê, sửa Loại thu/chi trên file rồi import lại — chứng từ sẽ được lập lại theo đúng loại." };
    }
    if (baseVoucher.debtAction || baseVoucher.depositAction || baseVoucher.partnerAllocations.length > 0) {
      return { error: "Chứng từ gốc có gạch công nợ/tiền cọc nên không tách theo Loại thu/chi ở đây được — sửa thẳng trên màn Chứng từ ngân hàng." };
    }
  }

  const categoryCodes = [...new Set(plan.splitCategories.map((group) => group.categoryCode))];
  const partnerCodes = [...new Set(plan.splitCategories.map((group) => group.partnerCode).filter((code): code is string => Boolean(code)))];
  const [categories, partners] = await Promise.all([
    prisma.masterDataItem.findMany({
      where: { type: "REVENUE_EXPENSE_CATEGORY", code: { in: categoryCodes }, status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true },
    }),
    prisma.masterDataItem.findMany({
      where: { type: "PARTNER", code: { in: partnerCodes }, status: "ACTIVE", deletedAt: null },
      select: { code: true, name: true },
    }),
  ]);
  const categoryNameByCode = new Map(categories.map((row) => [row.code, row.name]));
  const partnerNameByCode = new Map(partners.map((row) => [row.code, row.name]));
  const unknownCategory = categoryCodes.find((code) => !categoryNameByCode.has(code));
  if (unknownCategory) return { error: `Loại thu/chi ${unknownCategory} không có trong danh mục đang hoạt động.` };
  const unknownPartner = partnerCodes.find((code) => !partnerNameByCode.has(code));
  if (unknownPartner) return { error: `Đối tác ${unknownPartner} không có trong danh mục đang hoạt động.` };

  return { categoryNameByCode, partnerNameByCode, splitMoneySourceCode, documentDate };
}

/**
 * Sửa Ngày doanh thu / Loại thu/chi ngay trên dòng sổ sao kê, không phải rollback lô rồi import lại.
 *
 * Người dùng hay quên tách một lần ví/ngân hàng trả gộp thành từng ngày doanh thu, làm bảng
 * "Tiền về đủ chưa" báo ngày này về dư còn ngày kia thiếu tiền. Ở đây chỉ chia lại các dòng
 * phân bổ: tổng Nợ/Có, gross ví và hai khoản phí giữ nguyên đến từng đồng nên Sổ quỹ và
 * quyết toán ví không đổi.
 *
 * Dòng còn tách được theo LOẠI THU/CHI, cho case một lần khách quẹt gồm cả tiền bán hàng lẫn
 * tiền thu hộ. Phần đổi loại không còn được "Tiền về đủ chưa" đếm là doanh thu về (bảng đó chỉ
 * nhặt loại THU_BAN_HANG), nên hết báo VỀ DƯ; đổi lại nó phải có chứng từ riêng, nếu không tiền
 * vào tài khoản mà sổ không có bút toán nào ghi nhận nghĩa vụ trả lại.
 */
export async function PATCH(request: Request) {
  try {
    const auth = requireMenuAction(request, "/reconciliations", "edit");
    if (!auth.ok) return auth.response;

    const body = await request.json();
    if (cleanText(body.action) !== "SPLIT_REVENUE_DATES") {
      return NextResponse.json({ error: "Thao tác không hợp lệ" }, { status: 400 });
    }
    const bankTransactionId = cleanText(body.bankTransactionId);
    if (!bankTransactionId) return NextResponse.json({ error: "Thiếu giao dịch sao kê cần tách" }, { status: 400 });

    const bank = await prisma.bankStatementTransaction.findFirst({
      where: { id: bankTransactionId, deletedAt: null },
      include: {
        allocations: { orderBy: { sourceRowNumber: "asc" } },
        matches: { where: { deletedAt: null } },
      },
    });
    if (!bank) return NextResponse.json({ error: "Không tìm thấy giao dịch sao kê" }, { status: 404 });
    if (bank.branchCode) {
      try {
        assertBranchAccess(auth.session, bank.branchCode);
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
    }

    // Khóa sổ theo đúng kỳ mà tiền đã ghi nhận (ngày giao dịch + ngày hạch toán), giống lúc
    // commit lô import. Ngày doanh thu chỉ là chỗ đứng trên báo cáo đối chiếu nên không khóa
    // theo nó, nếu không thì tháng trước vừa chốt là hết đường sửa nhầm lẫn phân loại.
    const locked = await findClosedPeriod(
      [bank.transactionDate, bank.accountingDate || bank.transactionDate].map((date) => ({ date, branchCode: bank.branchCode })),
    );
    if (locked) {
      return NextResponse.json({ error: closedPeriodMessage(locked, "sửa Ngày doanh thu") }, { status: 400 });
    }

    let plan;
    try {
      plan = planRevenueDateSplit({ transaction: bank, existing: bank.allocations, lines: body.lines });
    } catch (error) {
      if (error instanceof RevenueSplitError) return NextResponse.json({ error: error.message }, { status: 400 });
      throw error;
    }

    /**
     * Chứng từ đang gắn với dòng sao kê này. Phiếu do chính thao tác tách sinh ra mang
     * `sourceScope = BANK_STATEMENT_SPLIT`: mỗi lần lưu lại phải xoá hết phiếu cũ rồi lập lại
     * theo số mới, nếu không sửa hai lần là có hai bộ chứng từ cho cùng một đồng tiền.
     */
    const linkedVoucherIds = bank.matches.filter((match) => match.targetType === "VOUCHER").map((match) => match.targetId);
    const linkedVouchers = linkedVoucherIds.length > 0
      ? await prisma.financialVoucher.findMany({
          where: { id: { in: linkedVoucherIds }, deletedAt: null },
          include: { partnerAllocations: { select: { id: true } } },
        })
      : [];
    const splitVouchers = linkedVouchers.filter((row) => row.sourceScope === BANK_STATEMENT_SPLIT_SOURCE_SCOPE);
    const baseVoucher = linkedVouchers.find((row) => row.sourceScope !== BANK_STATEMENT_SPLIT_SOURCE_SCOPE) || null;

    const prepared = await prepareCategorySplit({ bank, plan, baseVoucher });
    if ("error" in prepared) return NextResponse.json({ error: prepared.error }, { status: 400 });
    const { categoryNameByCode, partnerNameByCode, splitMoneySourceCode, documentDate } = prepared;

    const keptAmount = plan.lines
      .filter((line) => line.keepsOriginalCategory)
      .reduce((sum, line) => sum + (line.creditAmount || line.debitAmount), 0);

    const previous = bank.allocations.map((row) => ({
      revenueDate: row.revenueDate, debitAmount: row.debitAmount, creditAmount: row.creditAmount, grossAmount: row.grossAmount,
      categoryCode: row.categoryCode, partnerCode: row.partnerCode,
    }));

    await prisma.$transaction(async (tx) => {
      if (plan.removedIds.length > 0) {
        await tx.bankStatementAllocation.deleteMany({ where: { id: { in: plan.removedIds }, bankTransactionId: bank.id } });
      }
      for (const line of plan.lines) {
        const data = {
          revenueDate: line.revenueDate,
          debitAmount: line.debitAmount,
          creditAmount: line.creditAmount,
          grossAmount: line.grossAmount,
          grabExpenseAmount: line.grabExpenseAmount,
          cardFeeAmount: line.cardFeeAmount,
          // Loại thu/chi của dòng là thứ mọi báo cáo đọc sổ sao kê tin theo (allocation trước,
          // giao dịch chỉ là fallback), nên phải ghi thẳng ở đây.
          categoryCode: line.categoryCode,
          partnerCode: line.partnerCode,
          // Dòng đổi loại không còn là tiền doanh thu về: để nguyên REVENUE_RECEIPT thì các
          // bảng đọc theo Loại nghiệp vụ vẫn xếp nó vào doanh thu.
          operationType: line.keepsOriginalCategory ? bank.operationType : "OTHER_RECEIPT",
        };
        if (line.id) {
          await tx.bankStatementAllocation.update({ where: { id: line.id }, data });
          continue;
        }
        // Dòng mới thừa hưởng cách phân loại của giao dịch, trừ Loại thu/chi và đối tác đã
        // nằm trong `data` — hai thứ duy nhất người dùng được đổi ở màn tách.
        await tx.bankStatementAllocation.create({
          data: {
            ...data,
            bankTransactionId: bank.id,
            sheetName: line.sheetName,
            sourceRowNumber: line.sourceRowNumber,
            description: bank.description,
            sourceDate: bank.sourceDate,
            summaryMoneySourceCode: bank.summaryMoneySourceCode,
            increaseMoneySourceCode: bank.increaseMoneySourceCode,
            decreaseMoneySourceCode: bank.decreaseMoneySourceCode,
            accountingDate: bank.accountingDate,
            pnlItemCode: bank.pnlItemCode,
            debtReference: bank.debtReference,
            depositCode: bank.depositCode,
            autoProcessType: bank.autoProcessType,
            autoProcessNote: bank.autoProcessNote,
          },
        });
      }
      // Chứng từ của lần tách trước phải chết hẳn trước khi lập lại: sửa số lần hai mà giữ
      // phiếu cũ là hai chứng từ cùng ghi nhận một đồng tiền.
      for (const voucher of splitVouchers) {
        await tx.financialVoucher.update({
          where: { id: voucher.id },
          data: { deletedAt: new Date(), deletedBy: auth.session.name },
        });
        await tx.reconciliationMatch.updateMany({
          where: { bankTransactionId: bank.id, targetType: "VOUCHER", targetId: voucher.id, deletedAt: null },
          data: { deletedAt: new Date(), deletedBy: auth.session.name },
        });
      }

      const createdVouchers: string[] = [];
      for (const group of plan.splitCategories) {
        const voucher = await tx.financialVoucher.create({
          data: {
            code: await nextBankVoucherCode(tx, documentDate, bank.branchCode || ""),
            voucherType: "RECEIPT",
            voucherDate: documentDate,
            partnerCode: group.partnerCode,
            partnerName: partnerNameByCode.get(group.partnerCode || "") || "Chưa khai đối tác",
            branchCode: bank.branchCode || "",
            sourceScope: BANK_STATEMENT_SPLIT_SOURCE_SCOPE,
            documentChannel: "BANK",
            // Khoản này CHƯA được ghi nhận ở đâu (doanh thu POS chỉ ghi phần bán hàng), nên
            // phiếu phải sinh bút toán thật — khác phiếu thu doanh thu vốn chỉ xác nhận dòng tiền.
            businessEffect: "RECOGNITION",
            // Tiền thu hộ đi cùng đường với tiền bán hàng: quyết toán ví thì nó vào VÍ trước rồi
            // mới theo phiếu QTVI về ngân hàng, còn sao kê thẳng thì vào luôn tài khoản ngân hàng.
            moneySourceCode: splitMoneySourceCode,
            categoryCode: group.categoryCode,
            externalRef: bank.transactionCode,
            amount: group.amount,
            description: `Tách từ sao kê ${bank.transactionCode}: ${categoryNameByCode.get(group.categoryCode) || group.categoryCode}`,
            status: "APPROVED",
            createdBy: auth.session.name,
            approvedBy: auth.session.name,
          },
        });
        await tx.reconciliationMatch.create({
          data: {
            bankTransactionId: bank.id,
            targetType: "VOUCHER",
            targetId: voucher.id,
            targetCode: voucher.code,
            targetDate: documentDate,
            targetAmount: group.amount,
            matchedAmount: group.amount,
            status: "MATCHED",
            note: `Tách Loại thu/chi trên dòng sao kê (${auth.session.name})`,
            matchedBy: auth.session.name,
          },
        });
        createdVouchers.push(voucher.code);
      }

      // Phiếu gốc chỉ còn giữ phần đúng loại ban đầu. Quyết toán ví (MoneyTransfer) thì không
      // đụng tới: tiền vẫn chuyển từ ví về ngân hàng đủ cả cục, chỉ bản chất từng phần là khác.
      if (baseVoucher && keptAmount !== Math.round(baseVoucher.amount)) {
        await tx.financialVoucher.update({
          where: { id: baseVoucher.id },
          data: { amount: keptAmount },
        });
        await tx.reconciliationMatch.updateMany({
          where: { bankTransactionId: bank.id, targetType: "VOUCHER", targetId: baseVoucher.id, deletedAt: null },
          data: { targetAmount: keptAmount, matchedAmount: keptAmount },
        });
      }

      await tx.bankStatementTransaction.update({
        where: { id: bank.id },
        data: {
          revenueDate: plan.transactionRevenueDate,
          autoProcessNote: `Tách lại thành ${plan.lines.length} dòng (${auth.session.name})${createdVouchers.length > 0 ? ` — lập thêm ${createdVouchers.join(", ")}` : ""}`,
        },
      });
      await tx.auditLog.create({
        data: buildAuditLogData({
          session: auth.session,
          module: "BANK_STATEMENT",
          action: "SPLIT_REVENUE_DATES",
          entityType: "BankStatementTransaction",
          entityId: bank.id,
          entityCode: bank.transactionCode,
          branchCode: bank.branchCode,
          message: `Tách ${bank.transactionCode} thành ${plan.lines.length} dòng Ngày doanh thu`
            + (plan.splitCategories.length > 0 ? `, trong đó ${plan.splitCategories.length} cụm đổi Loại thu/chi` : ""),
          metadata: {
            before: previous,
            after: plan.lines.map((line) => ({
              revenueDate: line.revenueDate, debitAmount: line.debitAmount, creditAmount: line.creditAmount, grossAmount: line.grossAmount,
              categoryCode: line.categoryCode, partnerCode: line.partnerCode,
            })),
            splitCategories: plan.splitCategories,
            removedVouchers: splitVouchers.map((row) => row.code),
          },
        }),
      });
    });

    const updated = await prisma.bankStatementTransaction.findUnique({
      where: { id: bank.id },
      include: { allocations: { orderBy: { sourceRowNumber: "asc" } } },
    });
    return NextResponse.json({
      transaction: updated,
      revenueDates: plan.lines.map((line) => line.revenueDate.toISOString()),
    });
  } catch (error) {
    console.error("Error splitting bank statement revenue dates:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}

/**
 * Xoá một dòng sao kê khỏi sổ (chuyển vào Thùng rác).
 *
 * File sao kê import lại với số tham chiếu khác sẽ sinh ra một giao dịch thứ hai cho cùng một
 * lần chuyển tiền của ngân hàng. Trước đây không có đường nào gỡ dòng thừa đó: kế toán xoá
 * chứng từ bên màn Chứng từ ngân hàng, nhưng xoá chứng từ chỉ gỡ liên kết đối soát
 * (releasePendingReconciliation) chứ không đụng tới dòng sao kê — mà "Tiền đã vô" của báo cáo
 * Tiền về đủ chưa lại đọc thẳng BankStatementAllocation. Kết quả là sổ quỹ giảm còn báo cáo
 * vẫn giữ nguyên số, lệch đúng bằng số tiền của dòng thừa.
 *
 * Dòng còn chứng từ/quyết toán sống thì không cho xoá: tiền đã vào sổ kế toán qua bút toán của
 * chứng từ đó, gỡ dòng sao kê trước là để lại bút toán mồ côi. Phải xoá chứng từ trước.
 */
export async function DELETE(request: Request) {
  try {
    const auth = requireMenuAction(request, "/reconciliations", "delete");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const id = cleanText(searchParams.get("id"));
    const reason = cleanText(searchParams.get("reason")) || null;
    if (!id) return NextResponse.json({ error: "Thiếu giao dịch sao kê cần xoá" }, { status: 400 });

    const bank = await prisma.bankStatementTransaction.findFirst({
      where: { id, deletedAt: null },
      include: { matches: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } } },
    });
    if (!bank) return NextResponse.json({ error: "Không tìm thấy giao dịch sao kê" }, { status: 404 });

    if (bank.branchCode) {
      try {
        assertBranchAccess(auth.session, bank.branchCode);
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Không có quyền chi nhánh" }, { status: 403 });
      }
    }

    if (bank.matches.length > 0) {
      const codes = [...new Set(bank.matches.map((match) => match.targetCode))].join(", ");
      return NextResponse.json({
        error: `Giao dịch ${bank.transactionCode} còn liên kết với ${codes}. Xoá chứng từ/quyết toán đó trước rồi mới xoá dòng sao kê.`,
      }, { status: 400 });
    }

    // Cùng một kỳ khoá với lúc tách Ngày doanh thu: khoá theo kỳ tiền đã ghi nhận, không theo
    // Ngày doanh thu (ngày doanh thu chỉ là chỗ đứng trên báo cáo đối chiếu).
    const locked = await findClosedPeriod(
      [bank.transactionDate, bank.accountingDate || bank.transactionDate].map((date) => ({ date, branchCode: bank.branchCode })),
    );
    if (locked) {
      return NextResponse.json({ error: closedPeriodMessage(locked, "xoá dòng sao kê") }, { status: 400 });
    }

    await softDeleteRecord({ model: "BankStatementTransaction", id: bank.id, session: auth.session, reason });
    return NextResponse.json({ ok: true, transactionCode: bank.transactionCode });
  } catch (error) {
    if (error instanceof SoftDeleteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Error deleting bank statement transaction:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Internal Server Error" }, { status: 500 });
  }
}
