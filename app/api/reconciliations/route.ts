import { NextResponse } from "next/server";
import { requireMenuAccess, requireMenuAction } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { assertBranchAccess, branchFilterForSession } from "@/lib/accounting";
import { normalizeHeader } from "@/lib/import-templates";
import { normalizeMoneySourceGroup } from "@/lib/money-sources";
import { dateKey, suggestRevenueDateFromDescription } from "@/lib/revenue-date";

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

function revenueMatchesWalletSource(
  row: { paymentMethod: string; revenueSource: string; channel: string | null },
  source: { code: string; name: string },
) {
  const sourceValues = [normalizeHeader(source.code), normalizeHeader(source.name)];
  const rowValues = [normalizeHeader(row.paymentMethod), normalizeHeader(row.revenueSource), normalizeHeader(row.channel || "")];
  if (rowValues.some((value) => value && sourceValues.includes(value))) return true;
  const keywords = ["momo", "grab", "vnpay", "shopee", "quet the"];
  return keywords.some((keyword) => sourceValues.some((value) => value.includes(keyword))
    && rowValues.some((value) => value.includes(keyword)));
}

export async function GET(request: Request) {
  try {
    const auth = requireMenuAccess(request, "/reconciliations");
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") || "UNMATCHED";
    const branchFilter = branchFilterForSession(auth.session, searchParams.get("branchCode") || "ALL");

    const [bankRows, revenueRows, deposits, vouchers, matches, moneySources] = await Promise.all([
      prisma.bankStatementTransaction.findMany({
        where: {
          ...branchFilter,
          ...(status === "ALL" ? {} : { reconcileStatus: status })
        },
        include: {
          matches: { where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 1 },
          allocations: { orderBy: { sourceRowNumber: "asc" } },
        },
        orderBy: { transactionDate: "desc" },
        take: 100,
      }),
      prisma.revenueImportRow.findMany({ where: { ...branchFilter }, orderBy: { saleDate: "desc" }, take: 300 }),
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
        const sourceMatches = !isWalletSettlement || walletSources.some((source) => revenueMatchesWalletSource(row, source));
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
      const candidates = [
        ...posCandidates,
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
        .filter((candidate) => candidate.eligible && candidate.score >= (candidate.targetType === "REVENUE_POS" && isWalletSettlement ? 30 : 70))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const { matches: bankMatches, ...bankData } = bank;
      const currentMatch = bankMatches[0] || null;
      const matchedVoucher = currentMatch?.targetType === "VOUCHER"
        ? vouchers.find((voucher) => voucher.id === currentMatch.targetId)
        : null;
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
                  : "/finance-operations",
            }
          : null,
        candidates,
      };
    });

    return NextResponse.json({ rows, matches });
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
